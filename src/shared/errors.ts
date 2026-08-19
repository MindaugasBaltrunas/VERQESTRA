// Generic error helpers. No domain knowledge: works on any `unknown` error value.
// Behaviour etalon: AG_loop shared/errors + core/exit-codes.ts WorkflowInfrastructureError.

export function isErrnoCode(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}

export function isAlreadyExistsError(error: unknown): boolean {
  return isErrnoCode(error, "EEXIST");
}

export function isNotFoundError(error: unknown): boolean {
  return isErrnoCode(error, "ENOENT");
}

export function toError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}

/**
 * Deterministic ENVIRONMENT config error (a corrupt policy config file), distinct from
 * task-specific failures: it hits every queued task, so callers classify it as
 * infrastructure rather than one task's human-review.
 *
 * `message` is the byte-for-byte cause message; the file identity travels in `configFile`.
 */
export class PolicyConfigError extends Error {
  readonly configFile: string;

  constructor(configFile: string, cause: unknown) {
    super(cause instanceof Error ? cause.message : String(cause), { cause });
    this.name = "PolicyConfigError";
    this.configFile = configFile;
  }
}

export function isPolicyConfigError(error: unknown): error is PolicyConfigError {
  return error instanceof PolicyConfigError;
}

/**
 * Marks a policy-config read: any `load()` failure gains PolicyConfigError identity with the
 * concrete config file path. Already-marked errors are never re-wrapped, so a nested read
 * keeps the true file.
 */
export async function withPolicyConfigErrors<T>(configFile: string, load: () => Promise<T>): Promise<T> {
  try {
    return await load();
  } catch (error: unknown) {
    if (error instanceof PolicyConfigError) throw error;
    throw new PolicyConfigError(configFile, error);
  }
}

/** An infrastructure abort of the whole workflow — never one task's verdict. */
export class WorkflowInfrastructureError extends Error {
  readonly taskReturnedToQueue: boolean;
  /** The task stayed in place with its repair prompt preserved and is resumable. */
  readonly taskPreservedForResume: boolean;
  /** Child exit code that caused the abort, when one exists. */
  readonly exitCode?: number;

  constructor(
    message: string,
    options: { taskReturnedToQueue?: boolean; taskPreservedForResume?: boolean; exitCode?: number } = {},
  ) {
    super(message);
    this.name = "WorkflowInfrastructureError";
    this.taskReturnedToQueue = options.taskReturnedToQueue ?? false;
    this.taskPreservedForResume = options.taskPreservedForResume ?? false;
    if (options.exitCode !== undefined) this.exitCode = options.exitCode;
  }
}
