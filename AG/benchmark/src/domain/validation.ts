/**
 * Fail-closed validation kit (BENCH-5).
 *
 * Benchmark inputs arrive as authored files and as records written by an earlier
 * process, so every schema in this package starts from `unknown` and admits a
 * value only after each field has been recognised. The default is rejection: a
 * field this version does not know, a number outside its declared range or a
 * path that could leave the workspace is reported, never repaired and never
 * ignored. A metric computed from a record nobody checked is indistinguishable
 * from a measured one, which is exactly the failure BENCH-5 forbids.
 *
 * The kit collects every problem instead of throwing on the first: an operator
 * fixing a suite file needs the whole list, and a partially reported file
 * invites fixing it one round-trip at a time.
 */

export const VALIDATION_PROBLEM_CODES = [
  "wrong-type",
  "missing",
  "unknown-field",
  "empty",
  "not-an-integer",
  "out-of-range",
  "unknown-enum-value",
  "malformed",
  "unsafe-path",
  "duplicate",
  "inconsistent",
  "unsupported-schema-version",
] as const;

export type ValidationProblemCode = (typeof VALIDATION_PROBLEM_CODES)[number];

export interface ValidationProblem {
  /** Dotted/indexed location inside the validated document, e.g. `scenarios[3].limits.timeoutMs`. Empty for the document itself. */
  readonly path: string;
  readonly code: ValidationProblemCode;
  readonly message: string;
}

/**
 * A validated value or the reasons it was refused. The union carries no partial
 * value on failure: half a scenario is not a scenario, and offering one invites
 * a caller to run it.
 */
export type ValidationResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly problems: readonly ValidationProblem[] };

/** Accumulator threaded through a validation pass. */
export class ValidationProblems {
  readonly #problems: ValidationProblem[] = [];

  add(path: string, code: ValidationProblemCode, message: string): void {
    this.#problems.push({ path, code, message });
  }

  get list(): readonly ValidationProblem[] {
    return this.#problems;
  }

  get isEmpty(): boolean {
    return this.#problems.length === 0;
  }
}

/**
 * Lowercase kebab-case. Ids key stored samples and report rows, so case and
 * spacing cannot be free. Declared in the kit rather than beside one validator
 * because the same shape is required of ids that are *built* — a compression
 * variant id, for instance — and two copies of this pattern would eventually
 * accept two different sets of identifiers.
 */
export const IDENTIFIER_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export function joinPath(at: string, key: string | number): string {
  if (typeof key === "number") return `${at}[${key}]`;
  return at === "" ? key : `${at}.${key}`;
}

/**
 * Seals a pass. A value is returned only when it was fully read *and* nothing
 * was reported — a document with an unknown field parses into a complete value
 * yet is still refused, because the field it did not understand may be the one
 * that mattered. The empty-problem branch is unreachable by construction and
 * exists so a failure can never be reported without a reason.
 */
export function toValidationResult<T>(
  value: T | undefined,
  problems: ValidationProblems,
): ValidationResult<T> {
  if (value !== undefined && problems.isEmpty) return { ok: true, value };
  return {
    ok: false,
    problems: problems.isEmpty
      ? [{ path: "", code: "malformed", message: "the value could not be validated" }]
      : problems.list,
  };
}

const WINDOWS_DRIVE_PREFIX = /^[A-Za-z]:/;

/**
 * Control characters and backslashes. Declared paths are POSIX-style and
 * workspace-relative in every mode, so a backslash is either a Windows absolute
 * path, a UNC share or an escape — none of which this schema accepts. Written as
 * a scan rather than a regular expression so the rejected code points are
 * readable at the point of decision.
 */
function hasUnsafePathCharacter(value: string): boolean {
  for (const character of value) {
    if (character === "\\") return true;
    const code = character.codePointAt(0) ?? 0;
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

/**
 * Whether a declared path stays inside the workspace by its own text.
 *
 * This is the schema-level guard: it judges the literal a scenario or record
 * declares, before any root is known, and rejects the forms that could resolve
 * elsewhere — absolute POSIX paths, Windows drives and UNC shares, `..`
 * segments, and the `.`/empty segments that hide them from a naive prefix check.
 * The infrastructure guard that resolves a path against the real workspace root
 * is the second, independent check; neither replaces the other, since a literal
 * can be safe and still resolve outside a root that is itself wrong.
 *
 * Glob wildcards are accepted: `allowedPaths` are scope patterns, and `*` cannot
 * widen scope past a boundary traversal is already refused at.
 */
export function isSafeRelativePath(value: string): boolean {
  if (value === "") return false;
  if (hasUnsafePathCharacter(value)) return false;
  if (value.startsWith("/")) return false;
  if (WINDOWS_DRIVE_PREFIX.test(value)) return false;
  return value
    .split("/")
    .every(
      (segment) =>
        segment !== "" && segment !== "." && segment !== ".." && segment.trim() === segment,
    );
}

/** Values occurring more than once, in first-seen order. */
export function findDuplicates(values: readonly string[]): readonly string[] {
  const seen = new Set<string>();
  const duplicated = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) duplicated.add(value);
    seen.add(value);
  }
  return [...duplicated];
}

function describe(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "an array";
  return typeof value;
}

/**
 * Reads a plain object and reports any key the schema does not define. Own keys
 * only, so a `__proto__` entry surviving `JSON.parse` is reported as the unknown
 * field it is rather than being followed to the prototype.
 */
export function readRecord(
  value: unknown,
  at: string,
  allowedKeys: readonly string[],
  problems: ValidationProblems,
): Record<string, unknown> | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    problems.add(at, "wrong-type", `expected an object, received ${describe(value)}`);
    return undefined;
  }
  const record = value as Record<string, unknown>;
  const allowed = new Set(allowedKeys);
  for (const key of Object.keys(record)) {
    if (!allowed.has(key)) {
      problems.add(
        joinPath(at, key),
        "unknown-field",
        `unknown field; this schema version defines ${allowedKeys.join(", ")}`,
      );
    }
  }
  return record;
}

function present(
  source: Record<string, unknown>,
  key: string,
  at: string,
  problems: ValidationProblems,
): unknown {
  if (!Object.hasOwn(source, key)) {
    problems.add(joinPath(at, key), "missing", "required field is missing");
    return undefined;
  }
  return source[key];
}

/**
 * A non-empty string carrying no surrounding whitespace — a padded identifier is
 * a different identifier, and accepting both would make two records with the
 * same meaning hash differently.
 */
export function readString(
  source: Record<string, unknown>,
  key: string,
  at: string,
  problems: ValidationProblems,
): string | undefined {
  const raw = present(source, key, at, problems);
  if (raw === undefined) return undefined;
  const path = joinPath(at, key);
  if (typeof raw !== "string") {
    problems.add(path, "wrong-type", `expected a string, received ${describe(raw)}`);
    return undefined;
  }
  if (raw.trim() === "") {
    problems.add(path, "empty", "expected a non-empty string");
    return undefined;
  }
  if (raw.trim() !== raw) {
    problems.add(path, "malformed", "expected no leading or trailing whitespace");
    return undefined;
  }
  return raw;
}

export function readMatching(
  source: Record<string, unknown>,
  key: string,
  at: string,
  problems: ValidationProblems,
  pattern: RegExp,
  expectation: string,
): string | undefined {
  const value = readString(source, key, at, problems);
  if (value === undefined) return undefined;
  if (!pattern.test(value)) {
    problems.add(joinPath(at, key), "malformed", `expected ${expectation}, received "${value}"`);
    return undefined;
  }
  return value;
}

export function readSafePath(
  source: Record<string, unknown>,
  key: string,
  at: string,
  problems: ValidationProblems,
): string | undefined {
  const value = readString(source, key, at, problems);
  if (value === undefined) return undefined;
  if (!isSafeRelativePath(value)) {
    problems.add(
      joinPath(at, key),
      "unsafe-path",
      `expected a workspace-relative POSIX path without "." or ".." segments, received "${value}"`,
    );
    return undefined;
  }
  return value;
}

export function readBoolean(
  source: Record<string, unknown>,
  key: string,
  at: string,
  problems: ValidationProblems,
): boolean | undefined {
  const raw = present(source, key, at, problems);
  if (raw === undefined) return undefined;
  if (typeof raw !== "boolean") {
    problems.add(joinPath(at, key), "wrong-type", `expected a boolean, received ${describe(raw)}`);
    return undefined;
  }
  return raw;
}

/** A safe integer inside `[min, max]`. Floats, `NaN` and `Infinity` are refused rather than rounded. */
export function readInteger(
  source: Record<string, unknown>,
  key: string,
  at: string,
  problems: ValidationProblems,
  bounds: { readonly min: number; readonly max: number },
): number | undefined {
  const raw = present(source, key, at, problems);
  if (raw === undefined) return undefined;
  const path = joinPath(at, key);
  if (typeof raw !== "number") {
    problems.add(path, "wrong-type", `expected a number, received ${describe(raw)}`);
    return undefined;
  }
  if (!Number.isSafeInteger(raw)) {
    problems.add(path, "not-an-integer", `expected a safe integer, received ${raw}`);
    return undefined;
  }
  if (raw < bounds.min || raw > bounds.max) {
    problems.add(path, "out-of-range", `expected ${bounds.min}..${bounds.max}, received ${raw}`);
    return undefined;
  }
  return raw;
}

/** A finite number inside `[min, max]`, for the few fields that are genuinely fractional. */
export function readNumber(
  source: Record<string, unknown>,
  key: string,
  at: string,
  problems: ValidationProblems,
  bounds: { readonly min: number; readonly max: number },
): number | undefined {
  const raw = present(source, key, at, problems);
  if (raw === undefined) return undefined;
  const path = joinPath(at, key);
  if (typeof raw !== "number") {
    problems.add(path, "wrong-type", `expected a number, received ${describe(raw)}`);
    return undefined;
  }
  if (!Number.isFinite(raw)) {
    problems.add(path, "malformed", `expected a finite number, received ${raw}`);
    return undefined;
  }
  if (raw < bounds.min || raw > bounds.max) {
    problems.add(path, "out-of-range", `expected ${bounds.min}..${bounds.max}, received ${raw}`);
    return undefined;
  }
  return raw;
}

/**
 * One of the declared values and nothing else. An unrecognised value is refused
 * rather than mapped to a default: a verdict this version cannot interpret must
 * not silently become `rejected` or `stable`.
 */
export function readEnum<T extends string>(
  source: Record<string, unknown>,
  key: string,
  at: string,
  problems: ValidationProblems,
  allowed: readonly T[],
): T | undefined {
  const raw = present(source, key, at, problems);
  if (raw === undefined) return undefined;
  const path = joinPath(at, key);
  if (typeof raw !== "string") {
    problems.add(path, "wrong-type", `expected a string, received ${describe(raw)}`);
    return undefined;
  }
  if (!(allowed as readonly string[]).includes(raw)) {
    problems.add(path, "unknown-enum-value", `"${raw}" is not one of ${allowed.join(" | ")}`);
    return undefined;
  }
  return raw as T;
}

export function readArray(
  source: Record<string, unknown>,
  key: string,
  at: string,
  problems: ValidationProblems,
  minLength: number,
): readonly unknown[] | undefined {
  const raw = present(source, key, at, problems);
  if (raw === undefined) return undefined;
  const path = joinPath(at, key);
  if (!Array.isArray(raw)) {
    problems.add(path, "wrong-type", `expected an array, received ${describe(raw)}`);
    return undefined;
  }
  if (raw.length < minLength) {
    problems.add(path, "empty", `expected at least ${minLength} item(s), received ${raw.length}`);
    return undefined;
  }
  return raw;
}

/**
 * Reads every element with `readElement` and returns the list only when all of
 * them were read. Each element is visited even after one fails, so a file with
 * several bad entries is reported once.
 */
export function readList<T>(
  source: Record<string, unknown>,
  key: string,
  at: string,
  problems: ValidationProblems,
  minLength: number,
  readElement: (value: unknown, elementPath: string) => T | undefined,
): readonly T[] | undefined {
  const raw = readArray(source, key, at, problems, minLength);
  if (raw === undefined) return undefined;
  const path = joinPath(at, key);
  const read = raw.map((element, index) => readElement(element, joinPath(path, index)));
  return read.every((element): element is T => element !== undefined) ? read : undefined;
}

/** A list of non-empty strings, e.g. an argument vector or a set of reason codes. */
export function readStringList(
  source: Record<string, unknown>,
  key: string,
  at: string,
  problems: ValidationProblems,
  minLength: number,
  pattern?: { readonly test: RegExp; readonly expectation: string },
): readonly string[] | undefined {
  return readList(source, key, at, problems, minLength, (element, elementPath) => {
    if (typeof element !== "string") {
      problems.add(elementPath, "wrong-type", `expected a string, received ${describe(element)}`);
      return undefined;
    }
    if (element.trim() === "") {
      problems.add(elementPath, "empty", "expected a non-empty string");
      return undefined;
    }
    if (pattern && !pattern.test.test(element)) {
      problems.add(
        elementPath,
        "malformed",
        `expected ${pattern.expectation}, received "${element}"`,
      );
      return undefined;
    }
    return element;
  });
}

/** A list of workspace-relative paths, each judged by {@link isSafeRelativePath}. */
export function readSafePathList(
  source: Record<string, unknown>,
  key: string,
  at: string,
  problems: ValidationProblems,
  minLength: number,
): readonly string[] | undefined {
  return readList(source, key, at, problems, minLength, (element, elementPath) => {
    if (typeof element !== "string") {
      problems.add(elementPath, "wrong-type", `expected a string, received ${describe(element)}`);
      return undefined;
    }
    if (!isSafeRelativePath(element)) {
      problems.add(
        elementPath,
        "unsafe-path",
        `expected a workspace-relative POSIX path without "." or ".." segments, received "${element}"`,
      );
      return undefined;
    }
    return element;
  });
}

/**
 * Rejects a document written under any version but the one this build knows.
 * Forward compatibility is not attempted: an unknown version may add a field
 * that changes what the known fields mean.
 */
export function readSchemaVersion(
  source: Record<string, unknown>,
  at: string,
  problems: ValidationProblems,
  supported: number,
): number | undefined {
  const raw = present(source, "schemaVersion", at, problems);
  if (raw === undefined) return undefined;
  if (raw !== supported) {
    problems.add(
      joinPath(at, "schemaVersion"),
      "unsupported-schema-version",
      `expected schema version ${supported}, received ${JSON.stringify(raw)}`,
    );
    return undefined;
  }
  return supported;
}

/**
 * The same rule for a document whose older versions are still readable.
 *
 * A record appended one line at a time across months cannot be rewritten when
 * the schema moves, so its reader has to accept every version it genuinely
 * understands — and only those. The version is returned rather than normalised:
 * a caller needs to know which version it read to apply the cross-field rules
 * that version implies, such as refusing a field that did not exist yet.
 *
 * Kept separate from {@link readSchemaVersion} instead of widening it, because
 * the documents that have exactly one supported version — the scenario suite and
 * the run configuration — must keep refusing every other one.
 */
export function readSchemaVersionIn(
  source: Record<string, unknown>,
  at: string,
  problems: ValidationProblems,
  supported: readonly number[],
): number | undefined {
  const raw = present(source, "schemaVersion", at, problems);
  if (raw === undefined) return undefined;
  if (typeof raw !== "number" || !supported.includes(raw)) {
    problems.add(
      joinPath(at, "schemaVersion"),
      "unsupported-schema-version",
      `expected schema version ${supported.join(" or ")}, received ${JSON.stringify(raw)}`,
    );
    return undefined;
  }
  return raw;
}
