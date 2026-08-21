// Resume checkpoint'ų rašymas ir skaitymas (etalonas: orchestrator/loop/resume-checkpoint.ts
// rašymo/skaitymo pusė). VERQESTRA keliai: `vq/state/<actor>-resume.json`, `vq/logs/resume.log`.
//
// Checkpoint'as skaitomas PO PROCESO KRITIMO — tai apibrėžia visą modulio laikyseną:
//   - rašymas ATOMINIS (tmp + rename): pusiau įrašytas failas būtų blogesnis nei jokio, nes
//     atrodytų kaip galiojanti, bet melaginga būsena;
//   - rašymo klaida NEKYLA į kvietėją: checkpoint'as yra pagalbinė buhalterija, ir dėl jos
//     negali kristi pats darbas, kurį jis aprašo;
//   - neperskaitomas checkpoint'as grąžina `undefined`, o ne dalinius laukus: „nežinau, kas
//     vyko" turi vesti į naują planą, o ne į išvestį iš pusiau perskaitytos būsenos.
//
// Wave/run/graph tapatybės praturtinimas iš loop scheduler'io (`run_id`, `wave_id`,
// `graph_hash`) atkeliaus kartu su loop kompozicija; čia įrašomi TIK tie laukai, kuriuos
// kviečiantysis realiai žino, plius attempt manifesto tapatybė, kai attempt'as išsprendžiamas.

import path from "node:path";
import { z } from "zod";
import { toError } from "../../shared/errors.js";
import { toPrettyJson } from "../../shared/json.js";
import { validateWithSchema } from "../../shared/schema.js";
import { nodeFsAdapter } from "../fs/node-fs-adapter.js";
import { gitHead } from "../git/git-client.js";
import type { AttemptResolutionPort } from "./attempt-resolution.js";

export type ResumeActor = "supervisor" | "claude";

/** Kviečiančiojo paduodami laukai (CLI `ResumeCheckpointEntry` juos tenkina struktūriškai). */
export type ResumeCheckpointInput = {
  actor: string;
  phase: string;
  status: "started" | "finished" | "failed" | "waiting" | "moved";
  task_id?: string;
  task_file?: string;
  log_file?: string;
  exit_code?: number;
  next_action?: string;
};

// `looseObject`: seni checkpoint'ai su papildomais laukais lieka galiojantys, o nauji laukai
// nereikalauja nei schemos keitimo, nei versijos kėlimo (etalono `.passthrough()` 1:1).
export const resumeCheckpointSchema = z.looseObject({
  actor: z.enum(["supervisor", "claude"]),
  phase: z.string().min(1),
  status: z.enum(["started", "finished", "failed", "waiting", "moved"]),
  task_id: z.string().optional(),
  task_file: z.string().optional(),
  log_file: z.string().optional(),
  log_bytes: z.number().int().nonnegative().default(0),
  log_lines: z.number().int().nonnegative().default(0),
  git_head: z.string().optional(),
  next_action: z.string().optional(),
  exit_code: z.number().int().optional(),
  run_id: z.string().optional(),
  wave_id: z.string().optional(),
  graph_hash: z.string().optional(),
  attempt_id: z.string().optional(),
  updated_at: z.string().min(1),
});
export type ResumeCheckpoint = z.infer<typeof resumeCheckpointSchema>;

export function resumeCheckpointFile(runtimeRoot: string, actor: string): string {
  return path.join(runtimeRoot, "state", `${actor}-resume.json`);
}

/**
 * Žurnalo dydis ir eilučių skaičius. Nesamas ar neperskaitomas žurnalas duoda nulius, o ne
 * klaidą: checkpoint'as turi atsirasti net tada, kai log'o dar nėra (pvz. `started` įrašas
 * rašomas prieš pirmą baitą).
 */
async function logStats(logFile?: string): Promise<{ log_bytes: number; log_lines: number }> {
  if (logFile === undefined || logFile.trim() === "") return { log_bytes: 0, log_lines: 0 };
  const [size, content] = await Promise.all([
    nodeFsAdapter.fileSizeBytes(logFile),
    nodeFsAdapter.readTextFileIfExists(logFile),
  ]);
  return {
    log_bytes: size ?? 0,
    log_lines: content === undefined ? 0 : content.split(/\r?\n/).filter((line) => line.length > 0).length,
  };
}

/** Kelias projekto atžvilgiu; už šaknies ribų esantis kelias lieka absoliutus. */
function relativeToRoot(projectRoot: string, filePath?: string): string | undefined {
  if (filePath === undefined || filePath.trim() === "") return undefined;
  const relative = path.relative(projectRoot, filePath);
  return relative.startsWith("..") ? filePath : relative.split(path.sep).join("/");
}

function timestamp(): string {
  return new Date().toISOString().replace("T", " ").replace(/\.\d{3}Z$/, "");
}

export type RecordResumeCheckpointInput = {
  projectRoot: string;
  runtimeRoot: string;
  checkpoint: ResumeCheckpointInput;
  /** Attempt tapatybė; be jos checkpoint'as lieka be `run_id`/`attempt_id` (teisėta būsena). */
  resolution?: AttemptResolutionPort;
  now?: () => string;
};

/**
 * Įrašo checkpoint'ą: globalus `<actor>-resume.json`, `resume.log` eilutė ir — kai attempt'as
 * išsprendžiamas — append-only kopija attempt'o `resume` kanale.
 *
 * Globalus failas LIEKA (jį skaito crash recovery), bet jis yra last-writer-wins; attempt'o
 * kopija yra ta pati informacija su tapatybe, kurios globalus failas neturi.
 */
export async function recordResumeCheckpoint(input: RecordResumeCheckpointInput): Promise<void> {
  const { checkpoint, projectRoot, runtimeRoot } = input;
  const stats = await logStats(checkpoint.log_file);
  const attempt =
    checkpoint.task_id !== undefined && checkpoint.task_id.trim() !== ""
      ? await input.resolution?.resolveActiveAttempt(checkpoint.task_id)
      : undefined;
  const manifest = attempt?.ok === true ? attempt.attempt.manifest : undefined;

  const taskFile = relativeToRoot(projectRoot, checkpoint.task_file);
  const logFile = relativeToRoot(projectRoot, checkpoint.log_file);
  const head = await gitHead(projectRoot);

  const full: ResumeCheckpoint = {
    ...checkpoint,
    ...(taskFile === undefined ? {} : { task_file: taskFile }),
    ...(logFile === undefined ? {} : { log_file: logFile }),
    ...stats,
    ...(head === undefined ? {} : { git_head: head }),
    ...(manifest === undefined
      ? {}
      : { run_id: manifest.run_id, wave_id: manifest.wave_id, graph_hash: manifest.graph_hash, attempt_id: manifest.attempt_id }),
    updated_at: (input.now ?? (() => new Date().toISOString()))(),
  } as ResumeCheckpoint;

  try {
    await nodeFsAdapter.writeTextFileAtomic(resumeCheckpointFile(runtimeRoot, checkpoint.actor), toPrettyJson(full));
  } catch (error: unknown) {
    // Checkpoint'as yra buhalterija: dėl jos negali kristi darbas, kurį ji aprašo.
    process.stderr.write(`[resume-checkpoint] Failed to write checkpoint: ${toError(error).message}\n`);
  }

  const line = [
    `[${timestamp()}]`,
    checkpoint.actor,
    checkpoint.status,
    `phase=${checkpoint.phase}`,
    `task=${checkpoint.task_id ?? "none"}`,
    `log=${logFile ?? "none"}`,
    `bytes=${stats.log_bytes}`,
    `lines=${stats.log_lines}`,
    `next=${checkpoint.next_action ?? ""}`,
  ].join(" ");
  try {
    await nodeFsAdapter.appendTextFile(path.join(runtimeRoot, "logs", "resume.log"), `${line}\n`);
  } catch {
    // Žurnalo eilutė yra best-effort: jos praradimas nekeičia nei būsenos, nei sprendimo.
  }

  if (attempt?.ok === true) {
    await attempt.attempt.handle.appendLog("resume", JSON.stringify(full));
  }
}

/**
 * Perskaito checkpoint'ą crash recovery metu. Trūkstamas, tuščias, sugadintas arba svetimos
 * formos failas grąžina `undefined` — tai NĖRA klaida.
 */
export async function readResumeCheckpoint(
  runtimeRoot: string,
  actor: string,
): Promise<ResumeCheckpoint | undefined> {
  const raw = await nodeFsAdapter.readTextFileIfExists(resumeCheckpointFile(runtimeRoot, actor));
  if (raw === undefined || raw.trim() === "") return undefined;

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  const result = validateWithSchema(resumeCheckpointSchema, parsed);
  return result.ok ? result.data : undefined;
}
