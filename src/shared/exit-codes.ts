// Canonical process exit-code table and classification. Behaviour etalon: AG_loop
// core/exit-codes.ts, pinned by the cli-exit-contracts characterization fixture.
// The VALUES are a cross-process contract (orchestrator <-> dispatch children <-> CI):
// changing any of them is a breaking change to every stored log and classifier.

/** The one canonical dispatch-timeout exit code (both timeout layers report it). */
export const DISPATCH_TIMEOUT_EXIT_CODE = 124;

/** Model usage limit (429): wait-and-resume, unlike a timeout. 75 = EX_TEMPFAIL. */
export const USAGE_LIMIT_EXIT_CODE = 75;

/** Stale generated dist is an environment problem, never a task outcome. 78 = EX_CONFIG. */
export const DIST_STALE_EXIT_CODE = 78;

/** Deterministic policy-config failure hits every task — environment scope. Project-internal 79. */
export const POLICY_CONFIG_INVALID_EXIT_CODE = 79;

/** Local filesystem failure (locked/missing file) is environment scope. 74 = EX_IOERR. */
export const INFRASTRUCTURE_IO_EXIT_CODE = 74;

/** The executor CLI itself is missing — the session never started. 69 = EX_UNAVAILABLE. */
export const EXECUTOR_UNAVAILABLE_EXIT_CODE = 69;

/** Mid-dispatch token budget abort — resuming would burn the same budget again. Project-internal 80. */
export const BUDGET_EXCEEDED_EXIT_CODE = 80;

/** Usage/state errors (bad arguments, missing task file): the environment is fine. */
export const USAGE_ERROR_EXIT_CODE = 2;

const infrastructureExitCodes = new Set([
  DISPATCH_TIMEOUT_EXIT_CODE,
  USAGE_LIMIT_EXIT_CODE,
  DIST_STALE_EXIT_CODE,
  POLICY_CONFIG_INVALID_EXIT_CODE,
  INFRASTRUCTURE_IO_EXIT_CODE,
  EXECUTOR_UNAVAILABLE_EXIT_CODE,
  BUDGET_EXCEEDED_EXIT_CODE,
  126,
  127,
  3221225786,
  3221225794,
]);

export type ExitCodeCategory = "success" | "usage_error" | "timeout" | "infrastructure" | "task_failure";

export function classifyExitCode(code: number): ExitCodeCategory {
  if (code === 0) return "success";
  if (code === DISPATCH_TIMEOUT_EXIT_CODE) return "timeout";
  if (infrastructureExitCodes.has(code)) return "infrastructure";
  if (code === USAGE_ERROR_EXIT_CODE) return "usage_error";
  return "task_failure";
}

export function isInfrastructureExitCode(code: number): boolean {
  const category = classifyExitCode(code);
  return category === "infrastructure" || category === "timeout";
}

export function isUsageErrorExitCode(code: number): boolean {
  return classifyExitCode(code) === "usage_error";
}

// Node ErrnoException codes meaning ENVIRONMENT, not a bad argument.
const infrastructureErrnoCodes = new Set(["EBUSY", "EPERM", "EACCES", "ENOENT"]);

/**
 * Whether an error is an OS/filesystem failure rather than program logic or usage.
 * `code` alone is not enough (domain errors carry string codes too), so `errno`/`syscall`
 * is also required — only Node's fs/child_process layer sets those.
 */
export function isInfrastructureErrno(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const candidate = error as { code?: unknown; errno?: unknown; syscall?: unknown };
  if (typeof candidate.code !== "string" || !infrastructureErrnoCodes.has(candidate.code)) return false;
  return typeof candidate.errno === "number" || typeof candidate.syscall === "string";
}

/** Infrastructure exit code for a caught error, or undefined ("not infrastructure"). */
export function infrastructureExitCodeForError(error: unknown): number | undefined {
  return isInfrastructureErrno(error) ? INFRASTRUCTURE_IO_EXIT_CODE : undefined;
}
