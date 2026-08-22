import { ValidationProblems, joinPath, readRecord } from "../../domain/validation.js";

/**
 * Reading a required sub-object of a stored record, path and all.
 *
 * Shared by the readers that validate one stored run-identity document across
 * more than one file (`recorded-run-identity.ts` and
 * `recorded-compression-config.ts`). It lives here rather than in
 * `domain/validation.ts` because that kit reads *fields*, while this returns the
 * path of the object it read so problems inside it are reported at their real
 * location rather than at the record's root.
 */
export interface NestedRecord {
  readonly record: Record<string, unknown>;
  readonly path: string;
}

export function readNested(
  source: Record<string, unknown>,
  key: string,
  at: string,
  allowedKeys: readonly string[],
  problems: ValidationProblems,
): NestedRecord | undefined {
  const path = joinPath(at, key);
  if (!Object.hasOwn(source, key)) {
    problems.add(path, "missing", "required field is missing");
    return undefined;
  }
  const record = readRecord(source[key], path, allowedKeys, problems);
  return record === undefined ? undefined : { record, path };
}
