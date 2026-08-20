// Kanoniniai task-scoped runtime keliai (etalonas: AG_loop application/runtime/
// runtime-paths.ts, task 1117; ISO-1/ISO-2 „Isolated worker runtime"). VERQESTRA
// skirtumai: šaknis — `vq/runtime` (ne AG/runtime); attempt tapatybės primityvai
// (AttemptRef, formatWorkerId/formatAttemptId/formatAttemptRef, RUNTIME_SEGMENT_MAX_LENGTH)
// NEdubliuojami — importuojami iš application/scheduling/worker-limits (FQC-12), nes juos
// vartoja E3 scheduling. Modulis grynas (tik node:path), bet gyvena infrastructure pagal
// E4 WBR / ledger sprendimą: tai runtime AGREGATO layout'as, kurį realizuoja store'ai (VQ-403).
//
// Kiekvienas mutuojamas vykdymo artefaktas etalone buvo globalus singleton'as, dėl kurio
// retry perrašydavo taisomo bandymo evidenciją. Šis modulis apibrėžia namespace, kuris tą
// dviprasmybę pašalina: po katalogą kiekvienam run / worker / task / attempt ir po
// kanoninį failo vardą kiekvienai artefakto rūšiai.
//
// Dvi savybės priklauso ČIA ir niekur kitur:
//   1. Kvietėjo id niekada netampa keliu, jei nepraeina {@link validateRuntimeSegment} —
//      charset'as sąmoningai siauresnis nei bet kurios OS, kad tas pats id reikštų tą patį
//      katalogą Windows/macOS/Linux.
//   2. Kiekvienas sukomponuotas kelias resolve-then-verify tikrinamas prieš runtime šaknį.
//
// Liekamoji rizika (dokumentuota, ne taisoma): grynas modulis negali aptikti symlink
// escape; store niekada neseka kvietėjo keliu — kuria tik pats sukomponuotus katalogus.

import path from "node:path";
import {
  RUNTIME_SEGMENT_MAX_LENGTH,
  type AttemptRef,
} from "../application/scheduling/worker-limits.js";

export const RUNTIME_DIR_NAME = "runtime";
export const RUNTIME_RUNS_DIR_NAME = "runs";
export const RUNTIME_WORKERS_DIR_NAME = "workers";
export const RUNTIME_TASKS_DIR_NAME = "tasks";
export const RUNTIME_ATTEMPTS_DIR_NAME = "attempts";
export const RUNTIME_LOGS_DIR_NAME = "logs";

export type RuntimeSegmentKind = "run" | "worker" | "task" | "attempt" | "log-channel";

export type RuntimePathFailure =
  | "empty"
  | "too-long"
  | "charset"
  | "uppercase"
  | "trailing-dot"
  | "reserved-device-name"
  | "escapes-root";

export type RuntimePathResult<T> =
  | { ok: true; value: T }
  | { ok: false; reason: RuntimePathFailure; errors: string[] };

export type RuntimeArtifactKind =
  | "manifest"
  | "task"
  | "decision"
  | "context-pack"
  | "execution-context"
  | "execution-result"
  | "quality-result"
  | "stop-state"
  | "task-start-status"
  | "usage"
  | "log";

export type RuntimeWritePolicy = "write-once" | "compare-and-swap" | "append-only";

export type RuntimeArtifactDescriptor = {
  readonly kind: RuntimeArtifactKind;
  /** Failo vardas `dir` atžvilgiu. `log` atveju — kanalo priklausomas `<channel>.log`. */
  readonly file: string;
  readonly dir: "attempt" | "logs";
  readonly format: "json" | "jsonl" | "text";
  readonly policy: RuntimeWritePolicy;
};

/** Placeholder'is {@link RUNTIME_ARTIFACTS} kanalo priklausomam log failo vardui. */
export const RUNTIME_LOG_FILE_TEMPLATE = "<channel>.log";

/**
 * Vienintelis artefaktų failo vardų ir rašymo politikų šaltinis.
 *
 * Politikų skirtis tyčinė: `manifest`, `task`, `context-pack` ir `execution-context` yra
 * ĮVESTYS, apibrėžiančios, kas yra bandymas — jų retroaktyvus perrašymas keistų, ką reiškia
 * „šis bandymas vykdė"; re-run'ui reikia naujo attempt id, ne naujos įvesčių kopijos.
 * Baigties įrašus tas pats bandymas rašo pakartotinai skirtingose fazėse — jiems CAS.
 */
export const RUNTIME_ARTIFACTS: Readonly<Record<RuntimeArtifactKind, RuntimeArtifactDescriptor>> = {
  manifest: { kind: "manifest", file: "manifest.json", dir: "attempt", format: "json", policy: "write-once" },
  task: { kind: "task", file: "task.md", dir: "attempt", format: "text", policy: "write-once" },
  decision: { kind: "decision", file: "decision.json", dir: "attempt", format: "json", policy: "compare-and-swap" },
  "context-pack": { kind: "context-pack", file: "context-pack.json", dir: "attempt", format: "json", policy: "write-once" },
  "execution-context": {
    kind: "execution-context",
    file: "execution-context.md",
    dir: "attempt",
    format: "text",
    policy: "write-once",
  },
  "execution-result": {
    kind: "execution-result",
    file: "execution-result.json",
    dir: "attempt",
    format: "json",
    policy: "compare-and-swap",
  },
  "quality-result": {
    kind: "quality-result",
    file: "quality-result.json",
    dir: "attempt",
    format: "json",
    policy: "compare-and-swap",
  },
  "stop-state": { kind: "stop-state", file: "stop-state.json", dir: "attempt", format: "json", policy: "compare-and-swap" },
  "task-start-status": {
    kind: "task-start-status",
    file: "task-start-status.json",
    dir: "attempt",
    format: "json",
    policy: "compare-and-swap",
  },
  // JSONL, ne JSON: kanoninis ledger formatas — po vieną `TaskUsageEntry` eilutę
  // (domain/tokens/usage-ledger parseTaskUsageEntries), append-only pagal kontraktą.
  usage: { kind: "usage", file: "token-usage.jsonl", dir: "attempt", format: "jsonl", policy: "append-only" },
  log: { kind: "log", file: RUNTIME_LOG_FILE_TEMPLATE, dir: "logs", format: "text", policy: "append-only" },
};

// Ši viena išraiška atmeta tuščias eilutes, `/`, `\`, `:` (disko raidės, kompozitinis
// `<wave>:<task>` attempt id), NUL ir kitus kontrolinius, tarpus, vedantį `.`/`-`, `.`,
// `..` ir bet kurį absoliutų kelią.
const SEGMENT_PATTERN = /^[a-z0-9][a-z0-9._-]*$/;

// Windows įrenginių vardai su plėtiniu ar be. Case-insensitive kaip gynyba gilyn, nors
// uppercase atmetamas jau anksčiau.
const WINDOWS_RESERVED_DEVICE_PATTERN = /^(con|prn|aux|nul|(com|lpt)[0-9])(\.|$)/i;

function pathFailure<T>(reason: RuntimePathFailure, message: string): RuntimePathResult<T> {
  return { ok: false, reason, errors: [message] };
}

/**
 * Validuoja vieną kvietėjo path komponentą; keletą taisyklių laužanti reikšmė raportuojama
 * prieš pirmą. Uppercase atmetamas, o ne tyliai mažinamas: case-only skirtumas yra TAS PATS
 * katalogas Windows/macOS ir DU skirtingi Linux'e.
 */
export function validateRuntimeSegment(value: string, kind: RuntimeSegmentKind): RuntimePathResult<string> {
  if (value.length === 0) {
    return pathFailure("empty", `${kind} segment is empty`);
  }
  if (value.length > RUNTIME_SEGMENT_MAX_LENGTH) {
    return pathFailure(
      "too-long",
      `${kind} segment is ${value.length} characters, limit is ${RUNTIME_SEGMENT_MAX_LENGTH}`,
    );
  }
  if (!SEGMENT_PATTERN.test(value)) {
    const lowered = value.toLowerCase();
    if (lowered !== value && SEGMENT_PATTERN.test(lowered)) {
      return pathFailure("uppercase", `${kind} segment ${JSON.stringify(value)} must be lowercase`);
    }
    return pathFailure(
      "charset",
      `${kind} segment ${JSON.stringify(value)} must match ${SEGMENT_PATTERN.source}`,
    );
  }
  if (value.endsWith(".")) {
    // Windows tyliai nukerpa gale esantį tašką — `x.` ir `x` taptų vienu katalogu.
    return pathFailure("trailing-dot", `${kind} segment ${JSON.stringify(value)} must not end with "."`);
  }
  if (WINDOWS_RESERVED_DEVICE_PATTERN.test(value)) {
    return pathFailure(
      "reserved-device-name",
      `${kind} segment ${JSON.stringify(value)} is a reserved Windows device name`,
    );
  }
  return { ok: true, value };
}

/** Validuoja visus keturis tapatybės segmentus; laimi pirmas atmetimas. */
export function validateAttemptRef(ref: AttemptRef): RuntimePathResult<AttemptRef> {
  const checks: readonly [string, RuntimeSegmentKind][] = [
    [ref.runId, "run"],
    [ref.workerId, "worker"],
    [ref.taskId, "task"],
    [ref.attemptId, "attempt"],
  ];
  for (const [value, kind] of checks) {
    const result = validateRuntimeSegment(value, kind);
    if (!result.ok) {
      return result;
    }
  }
  return { ok: true, value: ref };
}

/** `<runtimeRoot>/runtime` — VERQESTRA runtime agregato šaknis (vq/runtime). */
export function runtimeAggregateRootDir(runtimeRoot: string): string {
  return path.join(runtimeRoot, RUNTIME_DIR_NAME);
}

export function runsDir(runtimeRoot: string): string {
  return path.join(runtimeAggregateRootDir(runtimeRoot), RUNTIME_RUNS_DIR_NAME);
}

/** Resolve-then-verify: galioja net jei charset'as kada nors būtų atlaisvintas. */
function containedPath(runtimeRoot: string, segments: readonly string[]): RuntimePathResult<string> {
  const root = path.resolve(runtimeAggregateRootDir(runtimeRoot));
  const resolved = path.resolve(root, ...segments);
  const relative = path.relative(root, resolved);
  if (relative === "" || relative.startsWith("..") || path.isAbsolute(relative)) {
    return pathFailure("escapes-root", `path ${JSON.stringify(resolved)} escapes runtime root ${JSON.stringify(root)}`);
  }
  return { ok: true, value: resolved };
}

export function runDir(runtimeRoot: string, runId: string): RuntimePathResult<string> {
  const validated = validateRuntimeSegment(runId, "run");
  if (!validated.ok) return validated;
  return containedPath(runtimeRoot, [RUNTIME_RUNS_DIR_NAME, runId]);
}

export function workerDir(runtimeRoot: string, runId: string, workerId: string): RuntimePathResult<string> {
  const validatedRun = validateRuntimeSegment(runId, "run");
  if (!validatedRun.ok) return validatedRun;
  const validatedWorker = validateRuntimeSegment(workerId, "worker");
  if (!validatedWorker.ok) return validatedWorker;
  return containedPath(runtimeRoot, [RUNTIME_RUNS_DIR_NAME, runId, RUNTIME_WORKERS_DIR_NAME, workerId]);
}

export function taskDir(
  runtimeRoot: string,
  runId: string,
  workerId: string,
  taskId: string,
): RuntimePathResult<string> {
  const worker = workerDir(runtimeRoot, runId, workerId);
  if (!worker.ok) return worker;
  const validatedTask = validateRuntimeSegment(taskId, "task");
  if (!validatedTask.ok) return validatedTask;
  return containedPath(runtimeRoot, [
    RUNTIME_RUNS_DIR_NAME,
    runId,
    RUNTIME_WORKERS_DIR_NAME,
    workerId,
    RUNTIME_TASKS_DIR_NAME,
    taskId,
  ]);
}

export function attemptDir(runtimeRoot: string, ref: AttemptRef): RuntimePathResult<string> {
  const validated = validateAttemptRef(ref);
  if (!validated.ok) return validated;
  return containedPath(runtimeRoot, [
    RUNTIME_RUNS_DIR_NAME,
    ref.runId,
    RUNTIME_WORKERS_DIR_NAME,
    ref.workerId,
    RUNTIME_TASKS_DIR_NAME,
    ref.taskId,
    RUNTIME_ATTEMPTS_DIR_NAME,
    ref.attemptId,
  ]);
}

/** `<attemptDir>/logs`. */
export function attemptLogsDir(runtimeRoot: string, ref: AttemptRef): RuntimePathResult<string> {
  const dir = attemptDir(runtimeRoot, ref);
  if (!dir.ok) return dir;
  return { ok: true, value: path.join(dir.value, RUNTIME_LOGS_DIR_NAME) };
}

export function attemptArtifactPath(
  runtimeRoot: string,
  ref: AttemptRef,
  kind: Exclude<RuntimeArtifactKind, "log">,
): RuntimePathResult<string> {
  const dir = attemptDir(runtimeRoot, ref);
  if (!dir.ok) return dir;
  return { ok: true, value: path.join(dir.value, RUNTIME_ARTIFACTS[kind].file) };
}

export function attemptLogPath(runtimeRoot: string, ref: AttemptRef, channel: string): RuntimePathResult<string> {
  const validatedChannel = validateRuntimeSegment(channel, "log-channel");
  if (!validatedChannel.ok) return validatedChannel;
  const dir = attemptLogsDir(runtimeRoot, ref);
  if (!dir.ok) return dir;
  return { ok: true, value: path.join(dir.value, `${channel}.log`) };
}

/** True tik keliui GRIEŽTAI runtime šaknies viduje; pati šaknis nėra „viduje". */
export function isInsideRuntimeRoot(runtimeRoot: string, candidate: string): boolean {
  const root = path.resolve(runtimeAggregateRootDir(runtimeRoot));
  const resolved = path.resolve(root, candidate);
  const relative = path.relative(root, resolved);
  return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
}
