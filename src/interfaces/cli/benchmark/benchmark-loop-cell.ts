// `benchmark-loop-cell` CLI adapteris: viena `ag-loop` režimo celė, vykdoma kaip PILNAS ciklas.
//
// Skirtumas nuo `benchmark-drive` yra visas šio režimo matavimas. `benchmark-drive` paleidžia
// VIENĄ ribotą agento kvietimą — tai `agent-solo` celė. Čia scenarijaus užduotis įrašoma į
// kopijos eilę ir per ją paleidžiamas `process-queued-task`: preflight, kontekstas, dispatch,
// kokybės vartai, diagnozė ir retry. Būtent tie sluoksniai yra tai, ką loop'as prideda prie
// plikos agento sesijos, ir būtent jų kaina yra tai, ką benchmark'as lygina.
//
// Iki 2026-08-22 abu režimus varė tas pats vienas kvietimas, tad `attempts`, `repairs` ir
// `humanReviewEvents` buvo įrašytos konstantos (1, 0, 0) — vienas draiveris, du „skirtingi"
// režimai. Todėl `ag-loop` adapterio versija pakelta į `ag-loop/3`: adapterio pakeitimas gali
// pajudinti kiekvieną ataskaitos skaičių, tad jis yra dalis konfigūracijos, prieš kurią
// lyginamas baseline.
//
// Ši komanda NEGALI importuoti benchmark paketo (BENCH-1), tad vokas čia yra antras,
// nepriklausomas TO PATIES dokumentuoto kontrakto rašytojas.

import path from "node:path";
import { USAGE_ERROR_EXIT_CODE, USAGE_LIMIT_EXIT_CODE } from "../../../shared/exit-codes.js";
import { consoleCliIo, type CliIo } from "../registry.js";
import {
  cellTaskPath,
  renderCellSpec,
  renderCellTask,
  summarizeCellTelemetry,
  type CellTaskInput,
  type CellUsageRecord,
} from "./benchmark-cell.js";

/** Telemetrijos kontraktas; dubliuojamas literalu dėl BENCH-1, kaip ir `benchmark-drive`. */
const TELEMETRY_ENVELOPE_KEY = "agBenchmarkTelemetry";
const TELEMETRY_ENVELOPE_VERSION = 2;

const REQUIRED_FLAGS = ["workdir", "model", "step-limit", "timeout-ms"] as const;
/**
 * Sąrašai perduodami VIENA reikšme, atskirti `|`.
 *
 * Ne dėl grožio: benchmark paketo invocation šablonas yra FIKSUOTAS argumentų vektorius su
 * `{{token}}` pakeitimu, tad kartojamos vėliavos jame išreikšti neįmanoma. Skirtukas parinktas
 * toks, kokio nėra nei scenarijaus kelyje, nei patikros komandoje.
 */
const LIST_SEPARATOR = "|";

const USAGE =
  "Usage: verqestra benchmark-loop-cell --workdir <d> --model <m> --step-limit <n> --timeout-ms <n>\n" +
  "  --allowed-paths <a|b>  scenarijaus leidžiami keliai, atskirti | (bent vienas)\n" +
  "  --checks <a|b>         scenarijaus patikrų komandos, atskirtos |\n" +
  "  --task-id <id>         užduoties id; be jo — darbinio katalogo vardas\n" +
  "  Promptas skaitomas iš stdin iki EOF.";

export type ParsedLoopCellArgs = {
  readonly workdir: string;
  readonly model: string;
  readonly stepLimit: number;
  readonly timeoutMs: number;
  readonly allowedPaths: readonly string[];
  readonly checks: readonly string[];
  readonly taskId: string;
};

export type LoopCellArgsResult =
  | { readonly kind: "ok"; readonly args: ParsedLoopCellArgs }
  | { readonly kind: "error"; readonly message: string };

function parsePositiveInt(raw: string, flag: string): number | string {
  const value = Number.parseInt(raw, 10);
  if (!Number.isSafeInteger(value) || value <= 0 || String(value) !== raw.trim()) {
    return `--${flag} must be a positive integer, got "${raw}"`;
  }
  return value;
}

/** Užduoties id iš katalogo vardo: benchmark kopijos vadinamos `<scenarijus>-NNNN`. */
export function taskIdFromWorkdir(workdir: string): string {
  const base = path.basename(path.resolve(workdir)).toLowerCase();
  const safe = base.replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "");
  return safe === "" ? "benchmark-cell" : safe;
}

export function parseLoopCellArgs(args: readonly string[]): LoopCellArgsResult {
  const single = new Map<string, string>();

  for (let i = 0; i < args.length; i += 1) {
    const token = args[i] ?? "";
    if (!token.startsWith("--")) {
      return { kind: "error", message: `${USAGE}\nUnexpected argument: ${token}` };
    }
    const name = token.slice(2);
    const value = args[i + 1];
    if (value === undefined || value.startsWith("--")) {
      return { kind: "error", message: `${USAGE}\nMissing value for --${name}` };
    }
    single.set(name, value);
    i += 1;
  }

  const list = (name: string): string[] =>
    (single.get(name) ?? "")
      .split(LIST_SEPARATOR)
      .map((value) => value.trim())
      .filter(Boolean);

  const missing = REQUIRED_FLAGS.filter((name) => !single.has(name));
  if (missing.length > 0) {
    return {
      kind: "error",
      message: `${USAGE}\nMissing required flag(s): ${missing.map((name) => `--${name}`).join(", ")}`,
    };
  }

  const model = (single.get("model") ?? "").trim();
  const workdir = (single.get("workdir") ?? "").trim();
  if (model === "" || workdir === "") {
    return { kind: "error", message: `${USAGE}\n--workdir and --model must not be empty` };
  }

  const stepLimit = parsePositiveInt(single.get("step-limit") ?? "", "step-limit");
  if (typeof stepLimit === "string") return { kind: "error", message: stepLimit };
  const timeoutMs = parsePositiveInt(single.get("timeout-ms") ?? "", "timeout-ms");
  if (typeof timeoutMs === "string") return { kind: "error", message: timeoutMs };

  const allowedPaths = list("allowed-paths");
  if (allowedPaths.length === 0) {
    // Tuščias sąrašas NĖRA „viskas leidžiama": loop'as be ribos matuotų kitą dalyką nei
    // scenarijus deklaravo, o ribos pažeidimas yra viena iš dviejų priimtinumo ašių.
    return { kind: "error", message: `${USAGE}\n--allowed-paths must name at least one path` };
  }

  const taskId = (single.get("task-id") ?? "").trim() || taskIdFromWorkdir(workdir);
  return {
    kind: "ok",
    args: {
      workdir,
      model,
      stepLimit,
      timeoutMs,
      allowedPaths,
      checks: list("checks"),
      taskId,
    },
  };
}

export type LoopCellRunResult = { stdout: string; stderr: string; code: number };

export type LoopCellPorts = {
  isDirectory(absolutePath: string): Promise<boolean>;
  readStdin(): Promise<string>;
  writeTextFile(absolutePath: string, content: string): Promise<void>;
  /**
   * Vienas pilnas eilės task'o ciklas kopijoje (`process-queued-task`), paleistas ATSKIRU
   * procesu: jis turi savo runtime šaknį, savo žurnalus ir savo exit kodo semantiką.
   */
  runCycle(input: {
    workdir: string;
    taskFile: string;
    model: string;
    stepLimit: number;
    timeoutMs: number;
  }): Promise<LoopCellRunResult>;
  /**
   * Loop'o veikimo aplinka kopijoje: agentų roster'is ir jį įjungianti politika.
   *
   * Grąžina, kiek agentų realiai atsidūrė kopijoje — nulis yra celės atsisakymo priežastis,
   * ne įspėjimas.
   */
  provisionLoopRuntime(workdir: string): Promise<{ agents: number }>;
  /** `<workdir>/vq/logs/token-usage.jsonl` įrašai; nesantis žurnalas — tuščias sąrašas. */
  readUsageRecords(workdir: string): Promise<readonly CellUsageRecord[]>;
  /** Kiek užduočių ciklas paliko `AG/tasks/human-review` bucket'e. */
  humanReviewCount(workdir: string): Promise<number>;
  isUsageLimitOutput(stdout: string): boolean;
};

export type LoopCellDeps = {
  ports: LoopCellPorts;
  io?: CliIo;
};

/**
 * Kokybės vartų politika celei.
 *
 * Vartai gauna BŪTENT scenarijaus patikras. Tai nėra atsakymo padavimas: nepriklausomas
 * verifikatorius priimtinumą išveda pats, iš naujo, po celės. Tai loop'o esmė — jis paleidžia
 * projekto patikras ir pagal jas sprendžia, ar kartoti. Atėmus jas, matuotume loop'ą su išjungtu
 * pagrindiniu jo sluoksniu ir vadintume tai loop'o kaina.
 */
export function cellQualityPolicy(checks: readonly string[]): string {
  const commands = checks.length > 0 ? checks : ["node --test"];
  const entries = commands.map((command) => {
    const [cmd = "node", ...rest] = command.split(/\s+/).filter(Boolean);
    return { cmd, args: rest };
  });
  const scope = { checks: entries };
  return `${JSON.stringify({ task: scope, feature: scope, milestone: scope }, null, 2)}\n`;
}

/**
 * Scenarijaus kopijos projekto profilis.
 *
 * Komandų politika leidžia `node --test` tik kai aktyvus `javascript` stack'as, o stack'ai
 * išvedami iš profilio kalbos (`vq/project/profile.json`). Be jo aibė fail-safe būdu lieka tuščia
 * ir loop'o vartai atmeta kiekvieną scenarijaus patikrą — 2026-08-22 piloto radinys.
 *
 * Kalba nėra spėjimas ir nėra atsakymo dalis: visi rinkinio fixture'ai yra JavaScript, ir tai
 * matosi iš pačių scenarijų patikrų (`node --test …`). Deklaruojame tai, ką celė ir taip žino.
 */
export function cellProjectProfile(): string {
  return `${JSON.stringify({ language: "javascript", selectedLanguage: "javascript" }, null, 2)}\n`;
}

export async function benchmarkLoopCellCommand(deps: LoopCellDeps, args: readonly string[]): Promise<number> {
  const io = deps.io ?? consoleCliIo;
  const parsed = parseLoopCellArgs(args);
  if (parsed.kind === "error") {
    io.error(parsed.message);
    return USAGE_ERROR_EXIT_CODE;
  }
  const { workdir, model, stepLimit, timeoutMs, allowedPaths, checks, taskId } = parsed.args;

  const workdirAbs = path.resolve(workdir);
  if (!(await deps.ports.isDirectory(workdirAbs))) {
    io.error(`--workdir is not an existing directory: ${workdirAbs}`);
    return USAGE_ERROR_EXIT_CODE;
  }

  const prompt = await deps.ports.readStdin();
  if (prompt.trim() === "") {
    io.error(`${USAGE}\nstdin prompt is empty`);
    return USAGE_ERROR_EXIT_CODE;
  }

  const cell: CellTaskInput = {
    prompt,
    allowedPaths,
    checks: checks.map((command) => ({ command: command.split(/\s+/).filter(Boolean) })),
    taskId,
  };

  const taskFile = cellTaskPath(workdirAbs, taskId);
  await deps.ports.writeTextFile(taskFile, renderCellTask(cell));
  // Spec change'as PRIVALO atsirasti kartu su užduotimi: be jo `claude-preflight` kodo pakeitimą
  // teisingai nukreipia į human-review, ir celė baigiasi be nė vieno modelio kvietimo. Tai ne
  // apėjimas — tai ta pati tvarka, kurios loop'as reikalauja iš kiekvieno realaus darbo.
  for (const [relative, content] of renderCellSpec(cell)) {
    await deps.ports.writeTextFile(path.join(workdirAbs, ...relative.split("/")), content);
  }
  // Loop'o veikimo aplinka — 2026-08-22 piloto radinys, ir jis buvo dvigubas.
  //
  // Kopijoje nebuvo NEI `.claude/agents/`, NEI `vq/config/`. Pirmojo trūkumas preflight promptui
  // duodavo tuščią leistinų agentų sąrašą („gali naudoti tik agentus iš šio sąrašo: .") ir čia pat
  // reikalaudavo netuščios grandinės: modelis teisingai negrąžindavo nė vieno, validacija tai
  // atmesdavo kaip `target_agent_chain is required for delegation`, ir celė baigdavosi
  // human-review po VIENO kvietimo. Antrojo trūkumas sustabdydavo ciklą jau po delegavimo
  // (`tool budget not found`). Abi piloto celės buvo identiškos — tai deterministiniai aprūpinimo
  // defektai, ne loop'o elgsena.
  //
  // Aprūpinama VISA konfigų aibė, o ne po failą: kiekvienas praleistas failas atrandamas tik
  // kitame MOKAMAME paleidime, ir kiekvienas toks atradimas kainuoja visą celių rinkinį. Tai nėra
  // atsakymo padavimas — tai loop'o mechanizmas, ne užduoties turinys, ir promptas lieka tas pats
  // (BENCH-3). Nei `.claude`, nei `vq` neįeina į matuojamą diff'ą.
  const runtime = await deps.ports.provisionLoopRuntime(workdirAbs);
  if (runtime.agents === 0) {
    // Garsiai, o ne tyliai: orkestratorius be agentų roster'io išmatuoja mūsų aprūpinimą, ne save.
    io.error(
      "verqestra benchmark-loop-cell: no agent definition reached the checkout, so preflight " +
        "could only refuse; the cell measures provisioning, not the loop.",
    );
    return USAGE_ERROR_EXIT_CODE;
  }

  // PO aprūpinimo: kokybės vartai gauna BŪTENT scenarijaus patikras, o ne projekto politiką,
  // kuri ką tik buvo nukopijuota. Įrašius anksčiau, kopija ją perrašytų.
  await deps.ports.writeTextFile(
    path.join(workdirAbs, "vq", "config", "quality-policy.json"),
    cellQualityPolicy(checks),
  );
  await deps.ports.writeTextFile(
    path.join(workdirAbs, "vq", "project", "profile.json"),
    cellProjectProfile(),
  );

  const result = await deps.ports.runCycle({ workdir: workdirAbs, taskFile, model, stepLimit, timeoutMs });

  if (deps.ports.isUsageLimitOutput(result.stdout)) {
    io.error("verqestra benchmark-loop-cell: Claude API usage limit reached — no telemetry envelope produced.");
    return USAGE_LIMIT_EXIT_CODE;
  }

  const records = await deps.ports.readUsageRecords(workdirAbs);
  const telemetry = summarizeCellTelemetry(records, taskId);
  if (telemetry.llmCalls === 0) {
    // Ciklas gali baigtis be NĖ VIENO modelio kvietimo — pvz. preflight nukreipia į
    // human-review. Tai tikra baigtis, bet ne matavimas: kaštų įrašo nėra, ir jo išgalvoti
    // negalima, tad celė lieka NEIŠMATUOTA su savo priežastimi.
    const detail = (result.stderr || result.stdout).trim().slice(0, 2000);
    io.error(
      `verqestra benchmark-loop-cell: the cycle recorded no model call for ${taskId}` +
        `${detail ? `: ${detail}` : ""}`,
    );
    return result.code === 0 ? 1 : result.code;
  }

  const humanReviewEvents = await deps.ports.humanReviewCount(workdirAbs);
  const envelope: Record<string, unknown> = {
    [TELEMETRY_ENVELOPE_KEY]: TELEMETRY_ENVELOPE_VERSION,
    model,
    inputTokens: telemetry.inputTokens,
    outputTokens: telemetry.outputTokens,
    llmCalls: telemetry.llmCalls,
    attempts: telemetry.attempts,
    repairs: telemetry.repairs,
    humanReviewEvents,
    // Ciklo baigtis, ne agento pasigyrimas: `process-queued-task` grąžina 0 tik tada, kai
    // užduotis praėjo vartus. Tai ir yra loop'o „done".
    claimedDone: result.code === 0,
    usage: {
      captured: telemetry.captured,
      cacheReadInputTokens: telemetry.cacheReadInputTokens,
      cacheCreationInputTokens: telemetry.cacheCreationInputTokens,
      numTurns: telemetry.numTurns,
      turnsSource: "recorded",
    },
  };
  io.out(JSON.stringify(envelope));
  return 0;
}
