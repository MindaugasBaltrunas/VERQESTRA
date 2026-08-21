// PILNAS aktyvaus attempt'o resolveris (etalonas: AG_loop orchestrator/loop/resume-checkpoint.ts
// `resolveActiveAttempt`).
//
// Klausimas vienas: kuriame `run/worker/task/attempt` namespace'e gyvena ŠIO task'o įrodymai? Trys
// atskiri procesai (preflight, dispatch, diagnose) turi rasti TĄ PATĮ katalogą be jokio bendro
// rodyklės failo, todėl kiekviena tapatybės dalis išvedama iš jau egzistuojančių šaltinių:
//
//   - `run_id` — pirmas galiojantis iš trijų: env (`AG_RUN_ID`, tiesioginis vaiko kelias), bangos
//     snapshot'as (loop'as jį perrašo prieš kiekvieną task'ą) ir resume checkpoint'ai. Negaliojantis
//     kandidatas PRALEIDŽIAMAS, o ne laikomas fataliu: svetimos formos senas įrašas negali
//     užblokuoti einamojo bandymo;
//   - `worker_id` — env arba pirminis slot'as;
//   - `attempt_id` — env arba `a<n>` iš retry skaitiklio. Skaitiklis kyla LYGIAI kartą per repair
//     verdiktą ir būtent PRIEŠ atitinkamą dispatch'ą, tad viename praėjime visi trys procesai mato
//     tą patį skaičių.
//
// Du kietieji atsisakymai: `identity-mismatch` (katalogas priklauso kitam run/worker/task arba jo
// manifestas sugadintas) NIEKADA nerašo — egzistuojantis manifestas yra autoritetas; `create:false`
// niekada nekuria namespace'o, nes telemetrija neturi teisės pradėti bandymo.

import path from "node:path";
import { z } from "zod";
import { formatAttemptId, formatWorkerId, type AttemptRef } from "../../application/scheduling/worker-limits.js";
import { validateRuntimeSegment, type RuntimeSegmentKind } from "../runtime-paths.js";
import { createAttempt, nextAttemptId, openAttempt, type RuntimeAttemptHandle } from "../persistence/runtime-artifact-store.js";
import { RUNTIME_GRAPH_HASH_NONE } from "../persistence/runtime-attempt-schema.js";
import { nodeFsAdapter } from "../fs/node-fs-adapter.js";
import { tryParseJson } from "../../shared/json.js";
import {
  runtimeArtifactsEnabled,
  type AttemptResolutionFailure,
  type AttemptResolutionPort,
  type AttemptResolutionResult,
} from "./attempt-resolution.js";

/** Iš kur atkeliavo `run_id` — įrašoma į telemetriją, kad diagnozė matytų šaltinį. */
export type AttemptRefEvidence = "env" | "wave-snapshot" | "resume-checkpoint";

const ATTEMPT_SEQUENCE_PATTERN = /^a(\d+)$/;

export type ActiveAttemptOptions = {
  taskId: string;
  projectRoot: string;
  /** `vq` runtime šaknis — joje gyvena `state/` ir attempt namespace'ai. */
  runtimeRoot: string;
  /** `true` leidžia SUKURTI namespace'ą. Telemetrija visada `false`. */
  create?: boolean;
  env?: NodeJS.ProcessEnv;
  now?: () => string;
  manifest?: { waveId?: string; graphHash?: string; policy?: Record<string, unknown>; source?: Record<string, unknown> };
};

const waveSnapshotRunSchema = z.looseObject({
  run_id: z.string().optional(),
  wave_id: z.string().optional(),
  graph_hash: z.string().optional(),
});

const resumeRunSchema = z.looseObject({
  run_id: z.string().optional(),
  task_id: z.string().optional(),
  updated_at: z.string().optional(),
});

function failure(reason: AttemptResolutionFailure, errors: string[]): AttemptResolutionResult {
  return { ok: false, reason, errors };
}

/** Segmentas mažosiomis raidėmis arba `undefined` — negaliojantis kandidatas praleidžiamas. */
function segmentCandidate(value: string | undefined, kind: RuntimeSegmentKind): string | undefined {
  const candidate = value?.trim().toLowerCase();
  if (candidate === undefined || candidate === "") return undefined;
  return validateRuntimeSegment(candidate, kind).ok ? candidate : undefined;
}

function attemptSequenceOf(attemptId: string): number | undefined {
  const match = ATTEMPT_SEQUENCE_PATTERN.exec(attemptId);
  if (match?.[1] === undefined) return undefined;
  const sequence = Number.parseInt(match[1], 10);
  return Number.isSafeInteger(sequence) && sequence > 0 ? sequence : undefined;
}

/** State failo skaitymas su schema. IO, parse ar schemos klaida = `undefined`, ne lūžis. */
async function readStateJson<T>(runtimeRoot: string, fileName: string, schema: z.ZodType<T>): Promise<T | undefined> {
  const raw = await nodeFsAdapter.readTextFileIfExists(path.join(runtimeRoot, "state", fileName));
  if (raw === undefined) return undefined;
  const parsed = tryParseJson<unknown>(raw);
  if (!parsed.ok) return undefined;
  const validated = schema.safeParse(parsed.value);
  return validated.success ? validated.data : undefined;
}

/**
 * `a<n>` iš repair skaitiklio: `repairs + 1`.
 *
 * Ta pati aritmetika kaip dispatch'e (`attempt = failedAttempts + 1`), tad trys atskiri procesai
 * suranda tą patį katalogą be jokio naujo rodyklės failo.
 */
async function attemptSequenceFromRetryCounts(runtimeRoot: string, taskId: string, taskSegment: string): Promise<number> {
  const counts = (await readStateJson(runtimeRoot, "retry-counts.json", z.looseObject({}))) as
    | Record<string, unknown>
    | undefined;
  // Raktas rašomas su ORIGINALIU task id; segmentas tikrinamas kaip atsarginis variantas.
  const raw = counts?.[`task:${taskId}`] ?? counts?.[`task:${taskSegment}`];
  const repairs = typeof raw === "number" && Number.isFinite(raw) ? Math.max(0, Math.floor(raw)) : 0;
  return repairs + 1;
}

/** Bangos snapshot'o pjūvis, kurio pakanka tapatybei. */
type WaveSnapshotRunView = z.infer<typeof waveSnapshotRunSchema>;

type RunEvidence = { runId: string; evidence: AttemptRefEvidence };

async function runIdFromResumeCheckpoints(runtimeRoot: string, taskSegment: string): Promise<string | undefined> {
  const checkpoints: { runId: string; updatedAt: string; matchesTask: boolean }[] = [];
  for (const actor of ["claude", "supervisor"] as const) {
    const checkpoint = await readStateJson(runtimeRoot, `${actor}-resume.json`, resumeRunSchema);
    const runId = segmentCandidate(checkpoint?.run_id, "run");
    if (runId === undefined) continue;
    checkpoints.push({
      runId,
      updatedAt: checkpoint?.updated_at ?? "",
      // Palyginimas SEGMENTO forma: checkpoint'as saugo originalų task id, o rūpi ta pati
      // tapatybė, ne ta pati rašyba.
      matchesTask: checkpoint?.task_id?.trim().toLowerCase() === taskSegment,
    });
  }

  const matching = checkpoints.find((entry) => entry.matchesTask);
  if (matching !== undefined) return matching.runId;
  return [...checkpoints].sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))[0]?.runId;
}

async function resolveRunEvidence(
  runtimeRoot: string,
  env: NodeJS.ProcessEnv,
  taskSegment: string,
  loadSnapshot: () => Promise<WaveSnapshotRunView | undefined>,
): Promise<RunEvidence | undefined> {
  const fromEnv = segmentCandidate(env["AG_RUN_ID"], "run");
  if (fromEnv !== undefined) return { runId: fromEnv, evidence: "env" };

  // Loop'as perrašo bangos snapshot'ą prieš kiekvieną task'ą — tai jau egzistuojanti run lygio
  // rodyklė, naujos kurti nereikia.
  const fromSnapshot = segmentCandidate((await loadSnapshot())?.run_id, "run");
  if (fromSnapshot !== undefined) return { runId: fromSnapshot, evidence: "wave-snapshot" };

  const fromCheckpoint = await runIdFromResumeCheckpoints(runtimeRoot, taskSegment);
  return fromCheckpoint === undefined ? undefined : { runId: fromCheckpoint, evidence: "resume-checkpoint" };
}

type ClaimedAttempt = { ok: true; ref: AttemptRef } | { ok: false; reason: AttemptResolutionFailure; errors: string[] };

async function claimAttempt(
  options: ActiveAttemptOptions,
  ref: AttemptRef,
  snapshot: WaveSnapshotRunView | undefined,
  taskIdOriginal: string | undefined,
  now: () => string,
): Promise<ClaimedAttempt> {
  const waveId = options.manifest?.waveId ?? snapshot?.wave_id;
  const createInputFor = (target: AttemptRef): Parameters<typeof createAttempt>[0] => ({
    runtimeRoot: options.runtimeRoot,
    ref: target,
    graphHash: options.manifest?.graphHash ?? snapshot?.graph_hash ?? RUNTIME_GRAPH_HASH_NONE,
    ...(waveId === undefined ? {} : { waveId }),
    attemptSequence: attemptSequenceOf(target.attemptId) ?? 1,
    policy: options.manifest?.policy ?? {},
    source: {
      origin: "queue-task",
      ...(options.manifest?.source ?? {}),
      // Kelio segmentas sąmoningai be didžiųjų raidžių; originalas keliauja kartu su manifestu.
      ...(taskIdOriginal === undefined ? {} : { task_id_original: taskIdOriginal }),
    },
    createdAt: now(),
  });

  const created = await createAttempt(createInputFor(ref));
  if (created.ok) return { ok: true, ref };
  if (created.reason !== "already-exists") return { ok: false, reason: "store", errors: created.errors };

  // Našlaitis katalogas be manifesto (kritimas tarp `mkdir` ir manifesto rašymo): jo NIEKADA
  // neperimame — pasiimame naują id ir bandome VIENĄ kartą.
  const next = await nextAttemptId(options.runtimeRoot, { runId: ref.runId, workerId: ref.workerId, taskId: ref.taskId });
  if (!next.ok) return { ok: false, reason: "store", errors: next.errors };

  const retryRef: AttemptRef = { ...ref, attemptId: next.value.attemptId };
  const retried = await createAttempt(createInputFor(retryRef));
  return retried.ok ? { ok: true, ref: retryRef } : { ok: false, reason: "store", errors: retried.errors };
}

export type ResolvedActiveAttempt = {
  ref: AttemptRef;
  handle: RuntimeAttemptHandle;
  evidence: AttemptRefEvidence;
  taskIdOriginal?: string;
};

export async function resolveActiveAttempt(options: ActiveAttemptOptions): Promise<AttemptResolutionResult> {
  const env = options.env ?? process.env;
  if (!runtimeArtifactsEnabled(env)) return failure("disabled", ["AG_RUNTIME_ARTIFACTS is not enabled"]);

  const taskIdRaw = options.taskId.trim();
  const taskSegment = validateRuntimeSegment(taskIdRaw.toLowerCase(), "task");
  if (!taskSegment.ok) return failure("invalid-identity", taskSegment.errors);
  const taskIdOriginal = taskIdRaw === taskSegment.value ? undefined : taskIdRaw;

  const workerId = segmentCandidate(env["AG_WORKER_ID"], "worker") ?? formatWorkerId(1);
  const now = options.now ?? ((): string => new Date().toISOString());

  let snapshotLoaded = false;
  let snapshot: WaveSnapshotRunView | undefined;
  const loadSnapshot = async (): Promise<WaveSnapshotRunView | undefined> => {
    if (!snapshotLoaded) {
      snapshotLoaded = true;
      snapshot = await readStateJson(options.runtimeRoot, "wave-snapshot.json", waveSnapshotRunSchema);
    }
    return snapshot;
  };

  const run = await resolveRunEvidence(options.runtimeRoot, env, taskSegment.value, loadSnapshot);
  if (run === undefined) {
    return failure("no-runtime", ["no run id in AG_RUN_ID, wave-snapshot.json or a resume checkpoint"]);
  }

  const attemptId =
    segmentCandidate(env["AG_ATTEMPT_ID"], "attempt") ??
    formatAttemptId(await attemptSequenceFromRetryCounts(options.runtimeRoot, taskIdRaw, taskSegment.value));

  let ref: AttemptRef = { runId: run.runId, workerId, taskId: taskSegment.value, attemptId };
  let opened = await openAttempt(options.runtimeRoot, ref);

  if (!opened.ok) {
    if (opened.reason === "identity-mismatch" || opened.reason === "schema" || opened.reason === "invalid-json") {
      // Egzistuojantis manifestas yra autoritetas: nerašome NIEKO.
      return failure("identity-mismatch", opened.errors);
    }
    if (opened.reason !== "manifest-missing") return failure("store", opened.errors);
    if (options.create !== true) return failure("not-created", opened.errors);

    const claimed = await claimAttempt(options, ref, await loadSnapshot(), taskIdOriginal, now);
    if (!claimed.ok) return failure(claimed.reason, claimed.errors);
    ref = claimed.ref;
    opened = await openAttempt(options.runtimeRoot, ref);
    if (!opened.ok) return failure("store", opened.errors);
  }

  return { ok: true, attempt: { handle: opened.data, manifest: opened.data.manifest } };
}

/**
 * `AttemptResolutionPort` realizacija su PILNU resolveriu.
 *
 * `create` lieka kvietėjo sprendimu: telemetrijos keliai gauna `false` (jie niekada nepradeda
 * bandymo), o dispatch'as — `true`.
 */
export function activeAttemptResolution(input: {
  projectRoot: string;
  runtimeRoot: string;
  create?: boolean;
}): AttemptResolutionPort {
  return {
    resolveActiveAttempt: (taskId, env) =>
      resolveActiveAttempt({
        taskId,
        projectRoot: input.projectRoot,
        runtimeRoot: input.runtimeRoot,
        create: input.create ?? false,
        ...(env === undefined ? {} : { env }),
      }),
  };
}
