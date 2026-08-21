// `PreToolUse` vartai (etalonas: AG_loop hooks/pre-hooks.ts). Vienintelė vieta visame hook'ų
// rinkinyje, kuri gali BLOKUOTI įrankio kvietimą (exit 2).
//
// Vartų SEKA yra kontraktas, ne stilius:
//   Bash:  input → bash politika → git mutacijos nuosavybė → jautrumo žyma → leidžiama
//   Write: input → tuščias kelias → rašymo politika → readme įrodymų vientisumas →
//          readme guard → nuosavybė → leidžiama
// Nuosavybė tikrinama PASKUTINĖ, nes ji brangiausia (lease store + realpath + scope lock), o
// pigios, deterministinės taisyklės turi atmesti kuo anksčiau.
//
// FAIL-CLOSED kryptys: neperskaitomas hook input, tuščias kelio laukas ir sugadinti readme
// skaitymo įrodymai blokuoja. Be validaus input'o komanda ar kelias NEGALI būti patikrinti, o
// tylus praleidimas būtų būtent ta spraga, dėl kurios vartai egzistuoja.

import path from "node:path";
import {
  evaluateBashCommandPolicy,
  evaluateReadmeGuardPolicy,
  evaluateWritePolicy,
  isGitMutationCommand,
  resolveReadmeGuardRequirements,
  DEFAULT_ARCHITECTURE_DOC,
  EMPTY_CHECK_COMMAND_CONTEXT,
  type CheckCommandContext,
  type ReadmeGuardRequirements,
} from "../../domain/policies/index.js";
import {
  consoleHookIo,
  getHookPathField,
  getToolInputField,
  parseHookInputStrict,
  type HookFsPort,
  type HookIo,
  type HookStdinPort,
} from "./protocol.js";
import { evaluateRuntimeOwnership, type RuntimeOwnershipPorts } from "./runtime-ownership.js";

/** Exit kodas, kuriuo `PreToolUse` hook'as blokuoja įrankio kvietimą. */
export const PRE_TOOL_BLOCK_EXIT_CODE = 2;

/** Profilio vaizdas README-guard reikalavimams; pilnas profilis nereikalingas. */
export type PreHookProfileView = {
  source_roots?: string[] | undefined;
  architecture_doc?: string | undefined;
};

export type PreHookPorts = RuntimeOwnershipPorts & {
  fs: HookFsPort;
  stdin: HookStdinPort;
  /** Projekto profilis arba `undefined`, kai jo nėra/neperskaitomas. */
  loadProjectProfile(projectRoot: string): Promise<PreHookProfileView | undefined>;
  /** Komandų politikos kontekstas; klaida PRIVALO virsti tuščiu kontekstu, ne blokada. */
  checkCommandContext(projectRoot: string): Promise<CheckCommandContext>;
  now?: () => Date;
};

export type PreHookDeps = {
  ports: PreHookPorts;
  projectRoot: string;
  /** vq runtime šaknis (`<root>/vq`). */
  runtimeRoot?: string;
  io?: HookIo;
};

type PreHookContext = {
  deps: PreHookDeps;
  io: HookIo;
  root: string;
  runtimeRoot: string;
  hooksLog: string;
  log(line: string): Promise<void>;
};

function contextOf(deps: PreHookDeps): PreHookContext {
  const io = deps.io ?? consoleHookIo;
  const root = path.resolve(deps.projectRoot);
  const runtimeRoot = deps.runtimeRoot ?? path.join(root, "vq");
  const hooksLog = path.join(runtimeRoot, "logs", "hooks.log");
  return {
    deps,
    io,
    root,
    runtimeRoot,
    hooksLog,
    log: async (line: string): Promise<void> => {
      const stamp = (deps.ports.now?.() ?? new Date()).toISOString();
      await deps.ports.fs.appendTextFile(hooksLog, `[${stamp}] ${line}\n`);
    },
  };
}

/**
 * README-guard reikalavimai iš profilio. Trūkstamas ar sugadintas profilis → saugūs
 * numatytieji, o architektūros dokumento egzistavimas VISADA tikrinamas diske, ne per profilį:
 * taip guard'as niekada nesusilpninamas dėl profilio būsenos (task 885).
 */
async function readmeGuardRequirements(context: PreHookContext): Promise<ReadmeGuardRequirements> {
  let sourceRoots: string[] | undefined;
  let architectureDoc = DEFAULT_ARCHITECTURE_DOC;

  const profile = await context.deps.ports.loadProjectProfile(context.root).catch(() => undefined);
  if (profile?.source_roots && profile.source_roots.length > 0) sourceRoots = profile.source_roots;
  if (profile?.architecture_doc && profile.architecture_doc.trim()) {
    architectureDoc = profile.architecture_doc.trim();
  }

  const architectureDocExists = await context.deps.ports.fs.exists(path.join(context.root, architectureDoc));
  return resolveReadmeGuardRequirements({
    ...(sourceRoots === undefined ? {} : { sourceRoots }),
    architectureDoc,
    architectureDocExists,
  });
}

export async function hookPreBash(deps: PreHookDeps): Promise<number> {
  const context = contextOf(deps);

  const parsed = parseHookInputStrict(await deps.ports.stdin.readStdin());
  if (!parsed.ok) {
    await context.log(`BLOCKED bash: neperskaitomas hook input (${parsed.error})`);
    context.io.error(`BLOCKED: PreToolUse Bash hook negavo validaus JSON input'o: ${parsed.error}`);
    context.io.error("   Be validaus input'o komanda negali būti patikrinta — blokuojama fail-closed.");
    return PRE_TOOL_BLOCK_EXIT_CODE;
  }

  const command = getToolInputField(parsed.value, "command");
  // Fail-safe: neperskaitoma politika ar profilis krenta į tuščią kontekstą, tad įgimtas
  // allow/deny sąrašas veikia lygiai kaip anksčiau. Ši šaka gali tik SUSIAURINTI leidimus,
  // niekada jų neišplėsti.
  const commandContext = await deps.ports
    .checkCommandContext(context.root)
    .catch(() => EMPTY_CHECK_COMMAND_CONTEXT);
  const policy = evaluateBashCommandPolicy(command, commandContext);

  if (policy.blockedPattern) {
    await context.log(`BLOCKED bash: ${command} (atitiko: ${policy.blockedPattern})`);
    context.io.error(`BLOCKED: Komanda atitinka draudziama sablona '${policy.blockedPattern}'`);
    context.io.error(`   Komanda: ${command}`);
    context.io.error("   Perziurek .claude/rules/constraints.md");
    return PRE_TOOL_BLOCK_EXIT_CODE;
  }

  if (isGitMutationCommand(command)) {
    // Be `filePath`: git mutacija liečia visą medį, tad vartai lieka viso medžio pločio.
    const ownership = await evaluateRuntimeOwnership(deps.ports, context.root, {
      subject: `git komanda '${command}'`,
    });
    if (ownership) {
      await context.log(`BLOCKED bash: ${command} (${ownership.reason})`);
      context.io.error(ownership.stderr);
      return PRE_TOOL_BLOCK_EXIT_CODE;
    }
  }

  // Jautri komanda NEBLOKUOJAMA — ji tik pažymima, kad auditas turėtų pėdsaką.
  if (policy.sensitive) await context.log(`JAUTRI leidžiama: ${command}`);

  await context.log(`bash: ${command}`);
  return 0;
}

export async function hookPreWrite(deps: PreHookDeps): Promise<number> {
  const context = contextOf(deps);

  const parsed = parseHookInputStrict(await deps.ports.stdin.readStdin());
  if (!parsed.ok) {
    await context.log(`BLOCKED rašymas: neperskaitomas hook input (${parsed.error})`);
    context.io.error(`BLOCKED: PreToolUse Write/Edit hook negavo validaus JSON input'o: ${parsed.error}`);
    context.io.error("   Be validaus input'o rašymo kelias negali būti patikrintas — blokuojama fail-closed.");
    return PRE_TOOL_BLOCK_EXIT_CODE;
  }

  const filePath = getHookPathField(parsed.value).replace(/\\/g, "/");
  // `getHookPathField` nežinomam laukui grąžina "" — be šito varto tai būtų fail-OPEN būtent
  // tam payload'ui, dėl kurio guard'as egzistuoja.
  if (filePath.trim() === "") {
    await context.log("BLOCKED rašymas: hook input be kelio lauko");
    context.io.error("BLOCKED: PreToolUse Write/Edit hook negavo rašymo kelio (path/file_path/notebook_path).");
    context.io.error("   Be kelio rašymas negali būti patikrintas — blokuojama fail-closed.");
    return PRE_TOOL_BLOCK_EXIT_CODE;
  }

  const block = evaluateWritePolicy(filePath, { projectRoot: context.root });
  if (block) {
    await context.log(`BLOCKED rašymas: ${filePath} (${block.reason})`);
    context.io.error(block.stderr);
    return PRE_TOOL_BLOCK_EXIT_CODE;
  }

  // Skaitymo įrodymų failas yra vartų pagrindas, tad jo VIENTISUMAS irgi yra vartai: sugadintas
  // arba suklastotas (ne masyvas) failas blokuoja, o ne tyliai virsta „nėra įrodymų".
  const readEventsPath = path.join(context.runtimeRoot, "state", "readme-read-events.json");
  let readEvents: string[];
  try {
    const raw = await deps.ports.fs.readTextFileIfExists(readEventsPath);
    const parsedEvents: unknown = raw === undefined || raw.trim() === "" ? [] : JSON.parse(raw);
    if (!Array.isArray(parsedEvents)) throw new TypeError("readme-read-events.json is not an array");
    readEvents = parsedEvents.filter((entry): entry is string => typeof entry === "string");
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    await context.log(`BLOCKED rašymas: ${filePath} (korumpuotas readme-read-events)`);
    context.io.error(`BLOCKED: readme-read-events.json yra sugadintas arba suklastotas: ${message}`);
    return PRE_TOOL_BLOCK_EXIT_CODE;
  }

  const guardBlock = evaluateReadmeGuardPolicy(filePath, readEvents, await readmeGuardRequirements(context));
  if (guardBlock) {
    await context.log(`BLOCKED rašymas: ${filePath} (${guardBlock.reason})`);
    context.io.error(guardBlock.stderr);
    return PRE_TOOL_BLOCK_EXIT_CODE;
  }

  const ownership = await evaluateRuntimeOwnership(deps.ports, context.root, {
    filePath,
    subject: `rašymas į '${filePath}'`,
  });
  if (ownership) {
    await context.log(`BLOCKED rašymas: ${filePath} (${ownership.reason})`);
    context.io.error(ownership.stderr);
    return PRE_TOOL_BLOCK_EXIT_CODE;
  }

  await context.log(`rašymas leidžiamas: ${filePath}`);
  return 0;
}
