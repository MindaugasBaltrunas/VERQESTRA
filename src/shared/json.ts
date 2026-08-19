// Generic JSON helpers built on shared/result. No domain knowledge, no I/O.
// canonicalJsonStringify behaviour etalon: AG_loop domain/metrics/accepted-change.ts,
// pinned by the shared-primitives characterization fixture — it feeds every stored
// `<prefix>:<sha256:16>` fingerprint, so its bytes are frozen.

import { type Result, ok, err } from "./result.js";

export function tryParseJson<T = unknown>(raw: string): Result<T, Error> {
  try {
    return ok(JSON.parse(raw) as T);
  } catch (error) {
    return err(error instanceof Error ? error : new Error(String(error)));
  }
}

/** Pretty-printed JSON with a trailing newline — the on-disk JSON style (byte contract). */
export function toPrettyJson(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

/**
 * Deterministic JSON with recursively sorted object keys — the input to frozen hashes.
 * Array order is meaningful and preserved; `undefined` object properties are dropped and
 * `null` is kept, exactly like `JSON.stringify`. Values that cannot round-trip
 * (non-finite numbers, functions, symbols, bigints) throw instead of silently becoming null.
 */
export function canonicalJsonStringify(value: unknown): string {
  const rendered = canonicalJsonValue(value);
  if (rendered === undefined) {
    throw new Error("canonical JSON: unsupported value undefined at the document root");
  }
  return rendered;
}

function canonicalJsonValue(value: unknown): string | undefined {
  if (value === null) return "null";

  const kind = typeof value;
  if (kind === "undefined") return undefined;
  if (kind === "boolean" || kind === "string") return JSON.stringify(value);
  if (kind === "number") {
    const numberValue = value as number;
    if (!Number.isFinite(numberValue)) {
      throw new Error(`canonical JSON: unsupported value ${String(numberValue)}`);
    }
    return JSON.stringify(numberValue);
  }
  if (kind === "function" || kind === "symbol" || kind === "bigint") {
    throw new Error(`canonical JSON: unsupported value of type ${kind}`);
  }

  if (Array.isArray(value)) {
    return `[${value.map((entry) => canonicalJsonValue(entry) ?? "null").join(",")}]`;
  }

  const record = value as Record<string, unknown>;
  const entries: string[] = [];
  for (const key of Object.keys(record).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))) {
    const rendered = canonicalJsonValue(record[key]);
    if (rendered === undefined) continue;
    entries.push(`${JSON.stringify(key)}:${rendered}`);
  }
  return `{${entries.join(",")}}`;
}
