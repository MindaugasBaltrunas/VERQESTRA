// `Stop` hook'as (etalonas: AG_loop hooks/on-stop.ts) — vienintelė vieta, kuri automatiškai
// commit'ina sesijos darbą.
//
// INVARIANTAS: joks kelias nesibaigia be `stopBridge` įrašo. Orkestratorius iš jo sprendžia,
// ar bandymas baigėsi, tad tyliai grįžęs Stop hook'as jam atrodo kaip pakibusi sesija.
//
// `git add --all` čia NIEKADA nenaudojamas: stage'inama tik šios sesijos rašymų aibė plius
// lifecycle keliai, kad lygiagrečios sesijos svetimi produkto edit'ai negalėtų būti sušluoti į
// šio task'o commit'ą.

import path from "node:path";
import {
  commitTitleFromFiles,
  fallbackCommitBody,
  isWipCommitMessage,
} from "../../domain/policies/commit-message.js";
import { enforceCommitTitlePolicy } from "../../application/policy-governance/git-automation-policy.js";
import { honestAutoCommitFiles } from "../../application/task-execution/session-staging.js";
import { recordSessionChanges } from "./session-changes.js";
import {
  STOP_BLOCK_EXIT_CODE,
  STOP_OK_EXIT_CODE,
  resolveStagePlan,
  stopHookContext,
  type StagePlanResult,
  type StopHookContext,
  type StopHookDeps,
} from "./on-stop-context.js";
import { runStopGuards } from "./stop-guards.js";

/** TypeScript fallback kandidatai — tikrinami tik tie, kurie realiai turi `tsconfig.json`. */
const TYPESCRIPT_PROJECT_CANDIDATES = [
  ".",
  path.join("packages", "core"),
  path.join("packages", "db"),
  path.join("apps", "api"),
  path.join("apps", "web"),
  path.join("apps", "worker"),
  path.join("apps", "mobile"),
];

async function existingTypeScriptProjectDirs(context: StopHookContext): Promise<string[]> {
  const dirs: string[] = [];
  for (const candidate of TYPESCRIPT_PROJECT_CANDIDATES) {
    const dir = path.resolve(context.root, candidate);
    if (await context.deps.ports.fs.exists(path.join(dir, "tsconfig.json"))) dirs.push(dir);
  }
  return dirs;
}

function typecheckCommand(projectRoot: string, projectDir: string): string {
  return projectDir === projectRoot ? "npx tsc -b --noEmit" : "npx tsc --noEmit";
}

/** Terminalinė baigtis: žurnalo eilutė, stop-bridge įrašas ir exit kodas vienoje vietoje. */
async function finish(
  context: StopHookContext,
  input: { status: string; reason: string; taskId: string; logLine?: string; error?: string; code?: number },
): Promise<number> {
  if (input.logLine) await context.log(input.logLine);
  if (input.error) context.io.error(input.error);
  await context.deps.ports.stopBridge({ status: input.status, reason: input.reason, taskId: input.taskId });
  return input.code ?? STOP_OK_EXIT_CODE;
}

async function clearChangesLog(context: StopHookContext): Promise<void> {
  await context.deps.ports.fs.writeTextFile(context.logPath("changes.log"), "");
}

/** TypeScript atsarginė patikra. `undefined` = praėjo (arba nebuvo ko tikrinti). */
async function typescriptFallbackFailure(
  context: StopHookContext,
  changedFiles: readonly string[],
): Promise<string | undefined> {
  const ports = context.deps.ports;
  // quality-gates yra autoritetinis patikros sluoksnis; šis fallback'as bėga TIK tada, kai žalio
  // gate statuso nėra — kad Stop vis tiek pagautų akivaizdžias TS klaidas minimaliose darbo
  // erdvėse, nedubliuodamas pavykusio gate paleidimo.
  const gates = await ports.readQualityGatesStatus(context.runtimeRoot).catch(() => undefined);
  if (gates?.passed === true) return undefined;

  const tsChanged = changedFiles.filter((file) => /\.(ts|tsx)$/.test(file)).length;
  if (tsChanged === 0) return undefined;
  const projectDirs = await existingTypeScriptProjectDirs(context);
  if (projectDirs.length === 0 || !(await ports.commandExists("npx"))) return undefined;

  await context.log(`TypeScript tikrinimas (${tsChanged} .ts/.tsx failų pakeista)`);
  const typecheckLog = context.logPath("typecheck.log");
  await ports.fs.writeTextFile(typecheckLog, "");

  const results = await Promise.all(
    projectDirs.map(async (dir) => ({ dir, result: await ports.runShell(typecheckCommand(context.root, dir), dir) })),
  );

  let exitCode = 0;
  for (const { dir, result } of results) {
    if (result.code !== 0) exitCode = result.code;
    const name = path.relative(context.root, dir) || "root";
    const output = `${result.stdout}${result.stderr}`;
    if (output) {
      await ports.fs.appendTextFile(
        typecheckLog,
        output
          .split(/\r?\n/)
          .map((line) => `[${name}] ${line}`)
          .join("\n"),
      );
    }
  }
  if (exitCode === 0) {
    await context.log("TypeScript OK — jokių klaidų");
    return undefined;
  }

  const logContent = (await ports.fs.readTextFileIfExists(typecheckLog)) ?? "";
  const tsErrors = logContent.split(/\r?\n/).filter((line) => line.includes("error TS")).length;
  return tsErrors > 0 ? `${tsErrors} TypeScript klaidų` : `tsc nepraėjo (exit ${exitCode}) — tikrink vq/logs/typecheck.log`;
}

/** Commit žinutė: Claude parašyta, o jos nesant — sugeneruota iš REALIAI stage'inamų failų. */
async function resolveCommitMessage(
  context: StopHookContext,
  input: { stagePaths: readonly string[]; changedFiles: readonly string[]; taskId: string },
): Promise<string> {
  const ports = context.deps.ports;
  const policy = await ports.loadGitAutomationPolicy(context.runtimeRoot);
  const commitMsgFile = context.logPath("commit-msg.md");
  const authored = await ports.fs.readTextFileIfExists(commitMsgFile);

  let title: string;
  let body: string;
  if (authored) {
    const [first = "", ...rest] = authored.split(/\r?\n/);
    // Antraštės šaltinis: produkto pakeitimai, kai jų yra; kitaip — realiai stage'inami
    // lifecycle keliai. Lifecycle-only commit'as vis tiek privalo gauti vardą iš kažko realaus.
    const titleSource = input.changedFiles.length > 0 ? [...input.changedFiles] : honestAutoCommitFiles(input.stagePaths);
    title = enforceCommitTitlePolicy(first.replace(/\r/g, ""), titleSource, policy);
    body = rest.join("\n").replace(/\r/g, "");
    await context.log(`Naudojama Claude commit žinutė: ${title}`);
    // Žinutė čia NEVALOMA (2026-08-25, task 002 lenktynė): iki šiol ji buvo ištrinama dar
    // PRIEŠ sužinant commit'o baigtį, tad guard'o ar git'o atmestas commit'as palikdavo darbą
    // medyje, o jo aprašą — jau ištrintą. Kitas stop'as krisdavo į fallback šaką ir autorinį
    // tekstą pakeisdavo failų vardų konvencija su WIP žyme („rollback_failed=1 missing_commit"
    // simptomas). Valymas dabar gyvena `clearAuthoredCommitMessage`, kviečiamame TIK po
    // sėkmingo commit'o: žinutė ir darbas, kurį ji aprašo, išgyvena arba išsivalo KARTU.
  } else {
    // Fallback'as pasiekiamas TIK kai sesija nutrūko (timeout, stream-cut) nespėjusi parašyti
    // žinutės. Antraštė lieka failų vardų konvencija — task id keliauja į body trailer'į, nes
    // tik ten jo nenuplauna conventional-commits politika ir tik ten jis neatskiriamas nuo
    // „NE įrodymas" žymės.
    const realFiles = honestAutoCommitFiles(input.stagePaths).slice(0, 20);
    title = enforceCommitTitlePolicy(commitTitleFromFiles(realFiles), realFiles, policy);
    body = fallbackCommitBody(realFiles, input.taskId);
    const wipNote = isWipCommitMessage(body) ? ` (WIP žymė: task=${input.taskId})` : "";
    await context.log(`Automatiškai generuota commit žinutė: ${title}${wipNote}`);
  }

  return `${title}\n\n${body}\n\n[orchestrator] ${context.now().toISOString()}`;
}

/**
 * Išvalo autorinę commit žinutę — kviesti TIK kai commit'as jau repo istorijoje.
 *
 * Valymo paskirtis nepasikeitė: pasenusi žinutė negali būti prisegta prie VĖLESNIO, nesusijusio
 * darbo. Pasikeitė MOMENTAS — anksčiau ji buvo valoma dar prieš `git add`, tad nepavykęs
 * commit'as prarasdavo aprašą negrįžtamai. Nepavykus commit'ui žinutė sąmoningai paliekama:
 * darbas, kurį ji aprašo, irgi tebėra necommit'intas, tad kitas bandymas ją teisėtai perpanaudos.
 */
async function clearAuthoredCommitMessage(context: StopHookContext): Promise<void> {
  await context.deps.ports.fs.writeTextFile(context.logPath("commit-msg.md"), "");
}

async function logStagingEvidence(context: StopHookContext, plan: StagePlanResult, taskId: string): Promise<void> {
  if (plan.foreign.length > 0) {
    await context.log(
      `SVETIMOS SESIJOS RAŠYMAI — ledger'yje, bet ne šios sesijos (task=${taskId}), ` +
        `paliekami nestage'inti: ${plan.foreign.join(", ")}`,
    );
  }
  if (plan.rescued.length > 0) {
    await context.log(
      `SESSION LEDGER MISS — švarus baseline (task=${taskId}), stage'inami ledger'yje ` +
        `TRŪKSTANTYS produkto failai: ${plan.rescued.join(", ")}`,
    );
  }
  if (plan.gap.length > 0) {
    // Ne informacinė eilutė, o REGRESIJOS signalas: gap netuščias reiškia, kad įrodymų sluoksniai
    // apie realiai pakeistus produkto failus nieko nebežinojo.
    await context.log(`STAGING LEDGER GAP: +${plan.gap.length} files: ${plan.gap.join(", ")}`);
  }
  if (plan.fallback.length > 0) {
    // 020-a-02 (R1): darbas parašytas ne per Write|Edit kanalą, tad ledger'is jo nematė; į
    // commit'ą jis grįžo TIK todėl, kad visas medžio produkto purvas telpa į aktyvaus task'o
    // Leidžiama aibę. Garsi ir grep'inama — fallback'as niekada nebūna tylus.
    await context.log(`STAGING LEDGER FALLBACK: task=${taskId} +${plan.fallback.length} files: ${plan.fallback.join(", ")}`);
  }
}

/**
 * `session_id` iš Stop payload'o, arba `""`, kai porto nėra / stdin tuščias / JSON sugadintas.
 *
 * Klaida čia NIEKADA neblokuoja: tapatybė yra guard'ų TIKSLINIMO priemonė, ne prielaida. Stop
 * hook'as, kritęs dėl savo paties įvesties parse'inimo, būtų blogesnis už guard'ą be tapatybės.
 */
async function readStopSessionId(ports: StopHookDeps["ports"]): Promise<string> {
  if (!ports.readStdin) return "";
  try {
    const raw = await ports.readStdin();
    if (!raw.trim()) return "";
    const parsed = JSON.parse(raw) as unknown;
    if (parsed === null || typeof parsed !== "object") return "";
    const value = (parsed as Record<string, unknown>)["session_id"];
    return typeof value === "string" ? value.trim() : "";
  } catch {
    return "";
  }
}

export async function hookOnStop(deps: StopHookDeps): Promise<number> {
  const context = stopHookContext(deps);
  const ports = deps.ports;
  await ports.fs.makeDirectory(path.join(context.runtimeRoot, "logs"));
  await context.log("STOP įvykis");

  // Orkestratoriaus įrašas, kurį task'ą Claude vykdo dabar — įspaudžiamas į kiekvieną
  // stop-status rašymą, kad vėlesnis resume/diagnose atpažintų svetimo bandymo įrodymus.
  const taskId = ((await ports.fs.readTextFileIfExists(context.statePath("current-task-id"))) ?? "").trim();

  const changedFiles = await ports.collectChangedFiles(context.root);
  if (changedFiles.length === 0) {
    // `collectChangedFiles` filtruoja runtime prefiksus, tad užduotis, kurios VIENINTELIS
    // rezultatas yra specas ar ataskaita po jais, čia atrodo kaip „jokių pakeitimų" — nors
    // planas lifecycle kelius stage'ina visada. Besąlyginis grįžimas darė tokią užduotį tyliu
    // no-op'u: failas parašytas, vartai žali, nulis commit'ų.
    const lifecycleWork = (await ports.isGitRepository(context.root))
      ? (await resolveStagePlan(context, taskId)).stagePaths
      : [];
    if (lifecycleWork.length === 0) {
      return await finish(context, {
        status: "done",
        reason: "stop hook allowed: no changes",
        taskId,
        logLine: "STOP leidžiamas — jokių pakeitimų",
      });
    }
    await context.log(`Produkto pakeitimų nėra, bet yra commit'intinų lifecycle failų: ${lifecycleWork.join(", ")}`);
  }

  // Nuotrauka PRIEŠ bet kurį commit kelią, kuris išvalys `changes.log` — kad SessionEnd ir
  // santrauka commit'inusiai sesijai vis tiek rodytų tikrą skaičių.
  await recordSessionChanges(ports.fs, context.runtimeRoot, changedFiles);

  // Sesijos tapatybė guard'ams. Iki 2026-08-24 Stop hook'as payload'o neskaitė VISAI, tad
  // `session_id` — vienintelis dalykas, leidžiantis atskirti savo darbą nuo lygiagrečios sesijos
  // toje pačioje darbo kopijoje — guard'ų nepasiekdavo, ir `package-guard` reikalaudavo
  // pagrindimo už svetimą `package.json`. Skaitymas NEPRIVALOMAS: be porto tapatybė lieka tuščia,
  // o tai teisėta „nežinau" būsena, kurioje guard'ai elgiasi kaip anksčiau.
  const sessionId = await readStopSessionId(ports);
  const guardFailure = await runStopGuards(ports, context.root, undefined, sessionId);
  if (guardFailure) {
    return await finish(context, {
      status: "error",
      reason: guardFailure.guard.blockReason,
      taskId,
      logLine: guardFailure.guard.logMessage,
      error: `STOP BLOKUOTAS: ${guardFailure.guard.blockReason}. Detalės: vq/logs/hooks.log`,
      code: STOP_BLOCK_EXIT_CODE,
    });
  }

  const typescriptFailure = await typescriptFallbackFailure(context, changedFiles);
  if (typescriptFailure) {
    return await finish(context, {
      status: "error",
      reason: "typescript blocked stop",
      taskId,
      logLine: `STOP BLOKUOTAS — ${typescriptFailure}`,
      error: `STOP BLOKUOTAS: ${typescriptFailure}`,
      code: STOP_BLOCK_EXIT_CODE,
    });
  }

  const policy = await ports.loadGitAutomationPolicy(context.runtimeRoot);
  if (!policy.auto_commit_enabled) {
    return await finish(context, {
      status: "done",
      reason: "stop hook allowed: auto commit disabled by policy",
      taskId,
      logLine: "Auto-commit išjungtas pagal git-automation-policy",
    });
  }

  if (!(await ports.isGitRepository(context.root))) {
    await clearChangesLog(context);
    return await finish(context, {
      status: "done",
      reason: "stop hook allowed: no git repository",
      taskId,
      logLine: "Git repozitorija nerasta — commit praleidžiamas",
    });
  }
  if (!(await ports.hasGitChanges(context.root))) {
    await clearChangesLog(context);
    return await finish(context, {
      status: "done",
      reason: "stop hook allowed: no git changes",
      taskId,
      logLine: "Jokių git pakeitimų — commit praleidžiamas",
    });
  }

  const plan = await resolveStagePlan(context, taskId);
  await logStagingEvidence(context, plan, taskId);
  if (plan.stagePaths.length === 0) {
    await clearChangesLog(context);
    return await finish(context, {
      status: "done",
      reason: "stop hook allowed: no session-scoped changes to commit",
      taskId,
      logLine: "Tik svetimi (ne šios sesijos) pakeitimai — commit praleidžiamas, jie paliekami nepaliesti",
    });
  }

  const message = await resolveCommitMessage(context, { stagePaths: plan.stagePaths, changedFiles, taskId });
  await context.log(`Git add (${plan.stagePaths.length} sesijos/lifecycle kelių)...`);
  const result = await ports.commitAndPush({
    projectRoot: context.root,
    message,
    paths: plan.stagePaths,
    push: policy.auto_push_enabled,
  });

  if (!result.ok) {
    const output = `${result.result.stdout}${result.result.stderr}`;
    if (result.step === "add" || result.step === "commit") {
      await ports.fs.appendTextFile(context.logPath("hooks.log"), output);
      return await finish(context, {
        status: "error",
        reason: `git ${result.step} failed`,
        taskId,
        logLine: `Git ${result.step} nepavyko`,
      });
    }
    // Commit'as JAU įvyko: tai nebėra klaida, o rankinio užbaigimo atvejis — kitaip
    // orkestratorius perdarytų darbą, kuris repo jau yra. Žinutė išvaloma ir čia: jos darbas
    // istorijoje, tad palikta ji tegalėtų prilipti prie svetimo vėlesnio commit'o.
    await clearAuthoredCommitMessage(context);
    const reason = result.step === "branch" ? "Git branch nenustatytas" : "Push nepavyko";
    await ports.fs.appendTextFile(context.logPath("hooks.log"), output);
    return await finish(context, {
      status: "done",
      reason: `${result.step} failed after commit — commit ok, resolve manually`,
      taskId,
      logLine: `${reason} — commit išliko lokaliai`,
      error: `Commit atliktas, bet ${reason.toLowerCase()}. Žiūrėk vq/logs/hooks.log.`,
    });
  }

  await clearAuthoredCommitMessage(context);
  await clearChangesLog(context);
  return await finish(context, {
    status: "done",
    reason: policy.auto_push_enabled
      ? "stop hook allowed: commit and push completed"
      : "stop hook allowed: commit completed, push disabled by policy",
    taskId,
    logLine: `git commit${policy.auto_push_enabled ? " + push" : ""}: ${message.split("\n")[0] ?? ""}`,
  });
}
