// Workerių kiekio KIETOS lubos ir worker/attempt tapatybės formatai — vienas apibrėžimas
// visai sistemai (spec WRK-3, design §13): wave scheduler'is, worker pool'as ir E4 runtime
// namespace privalo dalintis TUO PAČIU skaičiumi ir TAIS PAČIAIS id formatais, kitaip du
// „2" (arba du „w2") prasilenktų. Behaviour etalon: AG_loop application/runtime/
// runtime-paths.ts grynoji tapatybės pusė (konstanta ir formatai atkeliauja anksčiau už E4
// runtime kelius, nes juos vartoja E3 scheduling: buildWorkerSlot, slot refill).

/** Hard ceiling on worker ids. The wave scheduler runs one worker today; a second is gated. */
export const RUNTIME_MAX_WORKERS = 2;

/**
 * Runtime namespace segmento (`runs/<run>/workers/<w>/tasks/<taskId>/attempts/<a>`) ilgio
 * riba. Vartotojai: E4 runtime kelių validacija IR task-execution `childTaskId` (vaiko id
 * KARTU yra runtime kelio segmentas, tad privalo tilpti pagal konstrukciją — etalono
 * 2026-08-12 audito radinys #6: per ilgas vaiko id palikdavo bandymus be attempt namespace).
 */
export const RUNTIME_SEGMENT_MAX_LENGTH = 64;

export type AttemptRef = {
  readonly runId: string;
  readonly workerId: string;
  readonly taskId: string;
  readonly attemptId: string;
};

/** `<run>/<worker>/<task>/<attempt>` — stable identifier for logs and telemetry. */
export function formatAttemptRef(ref: AttemptRef): string {
  return [ref.runId, ref.workerId, ref.taskId, ref.attemptId].join("/");
}

/**
 * Canonical attempt id for a 1-based sequence: `a1`, `a2`, …
 *
 * The caller passes a positive integer; the attempt store's `nextAttemptId` (E4) is the
 * canonical producer.
 */
export function formatAttemptId(sequence: number): string {
  return `a${sequence}`;
}

/**
 * Canonical worker id for a 1-based index: `w1`, `w2`.
 *
 * Throws above {@link RUNTIME_MAX_WORKERS}: an out-of-range worker index is a programmer
 * error, not a runtime condition a caller could recover from.
 */
export function formatWorkerId(index: number): string {
  if (!Number.isInteger(index) || index < 1 || index > RUNTIME_MAX_WORKERS) {
    throw new Error(`worker index must be an integer in 1..${RUNTIME_MAX_WORKERS}, got ${index}`);
  }
  return `w${index}`;
}
