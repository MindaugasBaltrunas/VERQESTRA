// `SessionStart` hook'as (etalonas: AG_loop hooks/session-start.ts).
//
// Vartų esmė: SessionStart kyla ir tikrai naujai sesijai (`startup`, `clear`), ir VIDURY
// užduoties — po auto-compact ar resume. Tik pirmoji rūšis gali valyti per-sesiją įrodymus.
// `compact` firing'as, nušluodavęs `readme-read-events.json`, uždarydavo readme-guard vartus
// grandinės viduryje: kiekvienas tolesnis Write buvo blokuojamas, o agentas vartų atidaryti
// nebegali (to failo rašymas per įrankius uždraustas), tad užduotis mirdavo skrydžio metu.
//
// Todėl reset'ą saugo TRYS nepriklausomi vartai:
//   1) payload'o šaltinis (`compact`/`resume`) — ta pati sesija;
//   2) MŪSŲ gyvas bandymas — `startup` su tuo pačiu dispatch nonce (payload'o šaltinis po CLI
//      restarto meluoja, tad sprendžia tapatybė);
//   3) SVETIMAS gyvas bandymas — interaktyvi sesija nesikiša į dirbančio dispatch'o įrodymus.

import path from "node:path";
import {
  sessionStartIsSameAttempt,
  sessionStartStatusPath,
  dispatchAttemptIsLive,
  type SessionStartBaseline,
} from "../../application/task-execution/session-baseline.js";
import { nonRuntimeDirtyEntriesFromStatus } from "../../domain/git/changes.js";
import { resolveSessionOwnerPid } from "../../domain/scheduling/loop-runtime.js";
import { toPrettyJson, tryParseJson } from "../../shared/json.js";
import { writeLoopRuntimeRecord } from "./loop-runtime-store.js";
import { rotateFileByLines } from "./log-rotation.js";
import { resetSessionChanges } from "./session-changes.js";
import {
  SESSION_HOOK_OK_EXIT_CODE,
  type SessionHookContext,
  type SessionHookDeps,
  type SessionHookPorts,
  dispatchNonceOf,
  isDispatchedClaudeSession,
  sessionHookContext,
  userClaudePidFile,
} from "./session-hook-context.js";
import { parseHookInput } from "./protocol.js";

const HOOKS_LOG_MAX_LINES = 5_000;
const HOOKS_LOG_KEEP_LINES = 2_000;

/** `compact`/`resume` reiškia TĄ PAČIĄ sesiją — per-sesiją įrodymai išlaikomi. */
export function isSessionContinuation(source: string): boolean {
  return source === "compact" || source === "resume";
}

/**
 * Užregistruoja gyvos Claude sesijos runtime įrašą. `false` = neužregistruota.
 *
 * Neišsprendus PID'o įrašas NERAŠOMAS: sąžininga „nežinoma" būsena geriau nei įrašas, kuriuo
 * negalima pasitikėti. Dispatch'inta sesija čia NIEKO nerašo — indikatorius stebi TIK vartotojo
 * terminalą, o last-writer pasisavinimas anksčiau rodydavo `running` be jokio terminalo ir jos
 * SessionEnd ištrindavo dar gyvos interaktyvios sesijos įrašą.
 */
export async function registerUserClaudeRuntime(context: SessionHookContext): Promise<boolean> {
  const ports = context.deps.ports;
  if (isDispatchedClaudeSession(ports)) return false;

  const pid = resolveSessionOwnerPid(ports.parentPid(), (candidate) => ports.processIsAlive(candidate));
  if (pid === undefined) return false;

  const pidFile = userClaudePidFile(context.runtimeRoot);
  // Atominis rašymas katalogo nekuria, o `vq/state` naujame checkout'e gali dar neegzistuoti.
  await ports.fs.makeDirectory(path.dirname(pidFile));
  await writeLoopRuntimeRecord(
    { fs: ports.fs, processIsAlive: (candidate) => ports.processIsAlive(candidate), now: () => context.now() },
    pidFile,
    pid,
  );
  return true;
}

/** Sesijos baseline iš disko; sugadintas ar nesamas failas — tuščias įrašas. */
async function readSessionBaseline(context: SessionHookContext): Promise<SessionStartBaseline> {
  const raw = await context.deps.ports.fs.readTextFileIfExists(
    sessionStartStatusPath(path.join(context.runtimeRoot, "state")),
  );
  if (raw === undefined) return {};
  const parsed = tryParseJson<SessionStartBaseline>(raw);
  return parsed.ok && parsed.value !== null && typeof parsed.value === "object" ? parsed.value : {};
}

/** Ar šis firing'as priklauso TAM PAČIAM bandymui, kurio baseline jau užrašytas. */
async function firingBelongsToLiveAttempt(context: SessionHookContext): Promise<boolean> {
  const nonce = dispatchNonceOf(context.deps.ports);
  if (!nonce) return false;
  return sessionStartIsSameAttempt(await readSessionBaseline(context), nonce);
}

/**
 * Ar ŠI (interaktyvi) sesija privalo palikti SVETIMĄ per-sesiją įrodymą ramybėje?
 *
 * Naujas vartotojo terminalas tame pačiame darbo medyje yra tikrai nauja sesija, bet jo
 * `startup` reset'as nušluodavo GYVOS dispatch sesijos readme įrodymą — vartai užsidarydavo
 * grandinės viduryje. Dispatch'inta sesija čia NIEKADA nesustoja: ji pati yra naujo bandymo
 * savininkė ir privalo startuoti nuo švarios evidencijos.
 */
async function foreignDispatchIsLive(context: SessionHookContext): Promise<boolean> {
  const ports = context.deps.ports;
  if (isDispatchedClaudeSession(ports)) return false;

  const stateDir = path.join(context.runtimeRoot, "state");
  const currentTaskId = (await ports.fs.readTextFileIfExists(path.join(stateDir, "current-task-id"))) ?? "";
  if (!currentTaskId.trim()) return false;

  const checkpoint = await ports.readDispatchCheckpoint(stateDir).catch(() => undefined);
  return dispatchAttemptIsLive(checkpoint, currentTaskId, context.now().getTime());
}

/**
 * Šios dispatch sesijos git baseline. Best-effort: nepavykęs įrašas tik grąžina Stop hook'ą
 * prie ankstesnės, task lygio taisyklės — jokio blokavimo.
 */
async function recordSessionStartBaseline(context: SessionHookContext): Promise<void> {
  const ports = context.deps.ports;
  const nonce = dispatchNonceOf(ports);
  if (!nonce) return;

  try {
    const stateDir = path.join(context.runtimeRoot, "state");
    const status = await ports.gitStatusPorcelain(context.root);
    const baselineValid = status.code === 0;
    await ports.fs.makeDirectory(stateDir);
    await ports.fs.writeTextFile(
      sessionStartStatusPath(stateDir),
      toPrettyJson({
        dispatch_nonce: nonce,
        task_id: ((await ports.fs.readTextFileIfExists(path.join(stateDir, "current-task-id"))) ?? "").trim(),
        baseline_valid: baselineValid,
        non_runtime_dirty_entries: baselineValid
          ? nonRuntimeDirtyEntriesFromStatus(status.stdout)
          : [{ status: "!!", path: "<git status failed>" }],
        updated_at: context.now().toISOString(),
      }),
    );
  } catch (error) {
    await context.log(`session baseline neužrašytas: ${String(error)}`);
  }
}

/** Payload'o šaltinis; interaktyvus paleidimas stdin NELIEČIA — skaitymas kabintų amžinai. */
async function resolveSessionSource(ports: SessionHookPorts): Promise<string> {
  if (ports.stdinIsInteractive()) return "startup";
  try {
    const source = parseHookInput(await ports.stdin.readStdin())["source"];
    return typeof source === "string" ? source : "startup";
  } catch {
    return "startup";
  }
}

/** Per-sesiją įrodymų valymas. Kviečiama TIK kai visi trys vartai praleido. */
async function resetSessionEvidence(context: SessionHookContext): Promise<void> {
  const fs = context.deps.ports.fs;
  await fs.writeTextFile(context.logPath("changes.log"), "");
  await resetSessionChanges(fs, context.runtimeRoot);
  await fs.removeIfExists(context.logPath(".context-shown"));
  await fs.removeIfExists(context.logPath(".readme-guard-ok"));
  await fs.removeIfExists(context.statePath("readme-read-events.json"));
  // `session-writes.json` ČIA NEBEVALOMAS: task'as gyvena per kelias sesijas (dispatch +
  // repair + interaktyvios), o kiekvienos naujos sesijos startas nušluodavo ankstesnės sesijos
  // produkto rašymus — finalinis Stop hook'as tada stage'indavo tik lifecycle kelius, nors
  // žinutė vardijo produkto failus. Ledger'is yra PER-TASK; jį valo task'o aktyvacija.
  await archiveOldSpecs(context);
}

/**
 * Specs archyvavimas yra TŲ PAČIŲ vartų klausimas: gyvos grandinės architect specas, nukeltas
 * į `_archive` vidury dispatch'o, dingsta iš tolesnių agentų akiračio.
 */
async function archiveOldSpecs(context: SessionHookContext): Promise<void> {
  const fs = context.deps.ports.fs;
  const specsDir = path.join(context.root, ".claude", "specs");
  if (!(await fs.exists(specsDir))) return;

  const specs = await fs.listMarkdownFiles(specsDir);
  if (specs.length === 0) return;

  const archiveDir = path.join(specsDir, "_archive");
  await fs.makeDirectory(archiveDir);
  const dateTag = context.now().toISOString().replace(/[-:]/g, "").replace(/\..*$/, "").replace("T", "_");
  for (const spec of specs) {
    await fs.renamePath(spec, path.join(archiveDir, `${dateTag}_${path.basename(spec)}`)).catch(() => undefined);
  }
  await context.deps.ports.fs.appendTextFile(
    context.logPath("history.log"),
    `[${context.now().toISOString()}] Archyvuoti ${specs.length} seni specs\n`,
  );
}

const SESSION_LOG_HEADER = `# Sesiju zurnalas

> Automatiskai palaiko orkestratorius.
> Saugomas projekto kataloge - galioja tik siam projektui.
`;

async function appendSessionJournal(context: SessionHookContext): Promise<void> {
  const fs = context.deps.ports.fs;
  const sessionLog = context.logPath("session.md");
  const historyLog = context.logPath("history.log");

  if (!(await fs.exists(sessionLog))) {
    await fs.writeTextFile(sessionLog, SESSION_LOG_HEADER);
  }

  const sessionText = (await fs.readTextFileIfExists(sessionLog)) ?? "";
  const previousSessions = (sessionText.match(/^## Sesija/gm) ?? []).length;
  const historyText = (await fs.readTextFileIfExists(historyLog)) ?? "";
  const lastChanges = historyText
    .split(/\r?\n/)
    .filter((line) => line.includes("SESSION_END"))
    .at(-1);
  const stamp = context.now().toISOString();

  await fs.appendTextFile(
    sessionLog,
    [
      "",
      "---",
      "",
      `## Sesija — ${stamp}`,
      "",
      `**Sesijos nr.:** ${previousSessions + 1}`,
      "**Statusas:** Pradeta",
      "**Pakeisti failai:** 0",
      ...(lastChanges ? [`**Paskutine sesija:** ${lastChanges}`] : []),
      "",
    ].join("\n"),
  );
  await fs.appendTextFile(historyLog, `[${stamp}] SESSION_START\n`);
  context.io.out(`Sesija pradeta - zurnalas: ${sessionLog} (sesija nr. ${previousSessions + 1})`);
}

export async function hookSessionStart(deps: SessionHookDeps): Promise<number> {
  const context = sessionHookContext(deps);
  const ports = deps.ports;
  await ports.fs.makeDirectory(path.join(context.runtimeRoot, "logs"));

  // PRIEŠ continuation return'ą: `resume`/`compact` sesija yra lygiai taip pat gyva, tad ir jos
  // buvimas turi būti matomas. Operacija idempotentiška; nesėkmė — log eilutė, ne lūžusi sesija.
  try {
    if (isDispatchedClaudeSession(ports)) {
      await context.log("user-claude runtime praleistas: dispatch sesija (AG_DISPATCH_NONCE)");
    } else if (!(await registerUserClaudeRuntime(context))) {
      // Vienintelis būdas operatoriui suprasti, kodėl panelė rodo „nežinoma", o ne „veikia".
      await context.log("user-claude runtime neregistruotas: PID neišspręstas");
    }
  } catch (error) {
    await context.log(`user-claude runtime registracija nepavyko: ${String(error)}`);
  }

  const source = await resolveSessionSource(ports);
  if (isSessionContinuation(source)) {
    await ports.fs.appendTextFile(
      context.logPath("history.log"),
      `[${context.now().toISOString()}] SESSION_CONTINUE (${source}) — sesijos būsena išsaugota\n`,
    );
    context.io.out(`Sesija testi (${source}) - readme-guard ir pakeitimu evidencija islaikyta.`);
    return SESSION_HOOK_OK_EXIT_CODE;
  }

  const sameAttempt = await firingBelongsToLiveAttempt(context);
  if (sameAttempt) {
    await context.log("SESSION RESET PRALEISTAS — tas pats dispatch bandymas (nonce): baseline ir įrodymai išlaikomi");
  } else {
    await recordSessionStartBaseline(context);
  }

  // Rotacija nėra per-sesiją įrodymas (hooks.log — bendras, append-only žurnalas), tad ji vyksta
  // ir tada, kai svetimo dispatch'o įrodymas paliekamas ramybėje.
  const rotatedLines = await rotateFileByLines(
    ports.fs,
    context.logPath("hooks.log"),
    HOOKS_LOG_MAX_LINES,
    HOOKS_LOG_KEEP_LINES,
  );
  if (rotatedLines > HOOKS_LOG_MAX_LINES) {
    await context.log(`hooks.log rotacija: ${rotatedLines} -> ${HOOKS_LOG_KEEP_LINES} eiluciu`);
  }

  const foreignLive = !sameAttempt && (await foreignDispatchIsLive(context));
  if (foreignLive) {
    await context.log("SESSION RESET PRALEISTAS — gyvas dispatch bandymas; svetimo readme/changes įrodymo netriname");
  }
  if (!sameAttempt && !foreignLive) {
    await resetSessionEvidence(context);
  }

  await appendSessionJournal(context);

  const claudeMd = (await ports.fs.readTextFileIfExists(path.join(context.root, "CLAUDE.md"))) ?? "";
  const unfilled = (claudeMd.match(/<!-- UŽPILDYK/g) ?? []).length;
  if (unfilled > 0) {
    context.io.out(`WARNING: CLAUDE.md turi ${unfilled} neuzpildytu lauku - uzbaikite Projekto konteksta.`);
    await ports.fs.appendTextFile(
      context.logPath("history.log"),
      `[${context.now().toISOString()}] WARNING: CLAUDE.md turi ${unfilled} neuzpildytu lauku\n`,
    );
  }

  return SESSION_HOOK_OK_EXIT_CODE;
}
