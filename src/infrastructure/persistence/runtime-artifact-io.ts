// Runtime artefaktų žemo lygio IO: revision žetonai, typed failure unijos ir
// write-once / compare-and-swap primityvai (etalono runtime-artifact-store.ts apatinė
// pusė). CAS sąžiningumas: read-hash-compare-write yra lost-update DETEKTORIUS, ne
// mutex — pakanka, nes namespace garantuoja vieną rašytoją per attempt.

import { writeFile } from "node:fs/promises";
import path from "node:path";
import type { ZodType } from "zod";
import { isAlreadyExistsError, toError } from "../../shared/errors.js";
import { sha256Hex } from "../../shared/hash.js";
import { toPrettyJson } from "../../shared/json.js";
import { validateWithSchema } from "../../shared/schema.js";
import { nodeFsAdapter } from "../fs/node-fs-adapter.js";

/** Dar neegzistuojančio artefakto revision. Paduodama pirmam CAS rašymui. */
export const ABSENT_REVISION = "absent";

/**
 * `r1:<pirmi 16 hex sha256(text)>` — ta pati forma kaip `wg1:` grafo hash'ai. Žetonas yra
 * TIKSLIŲ failo baitų hash'as, tad iš skaitymo gauta ir iš rašymo prognozuota revision
 * palyginamos be antro skaitymo.
 */
export function runtimeRevision(text: string): string {
  return `r1:${sha256Hex(text).slice(0, 16)}`;
}

export type RuntimeReadFailure =
  | "missing"
  | "invalid-json"
  | "schema"
  | "identity-mismatch"
  | "manifest-missing"
  | "invalid-path"
  | "io";

export type RuntimeReadResult<T> =
  | { ok: true; origin: "runtime"; path: string; revision: string; data: T }
  | { ok: false; reason: RuntimeReadFailure; errors: string[] };

export type RuntimeWriteFailure =
  | "invalid-path"
  | "invalid-payload"
  | "already-exists"
  | "revision-required"
  | "revision-mismatch"
  | "manifest-missing"
  | "identity-mismatch"
  | "io";

export type RuntimeWriteResult<T> =
  | { ok: true; value: T }
  | { ok: false; reason: RuntimeWriteFailure; errors: string[] };

export type RuntimeArtifactLocation = { path: string; revision: string };

export function readFailure<T>(reason: RuntimeReadFailure, errors: string[]): RuntimeReadResult<T> {
  return { ok: false, reason, errors };
}

export function writeFailure<T>(reason: RuntimeWriteFailure, errors: string[]): RuntimeWriteResult<T> {
  return { ok: false, reason, errors };
}

/**
 * Neperskaitomas manifestas reiškia neįrodomą tapatybę — kiekviena priežastis atvaizduojama
 * į būtent tai sakančią rašymo klaidą. Nieko neperimama spėjant.
 */
export function writeFailureFromRead<T>(reason: RuntimeReadFailure, errors: string[]): RuntimeWriteResult<T> {
  switch (reason) {
    case "invalid-path":
      return writeFailure("invalid-path", errors);
    case "identity-mismatch":
      return writeFailure("identity-mismatch", errors);
    case "io":
      return writeFailure("io", errors);
    default:
      return writeFailure("manifest-missing", errors);
  }
}

export async function readTextArtifactAt(target: string): Promise<RuntimeReadResult<string>> {
  let raw: string | undefined;
  try {
    raw = await nodeFsAdapter.readTextFileIfExists(target);
  } catch (error: unknown) {
    return readFailure("io", [`cannot read ${target}: ${toError(error).message}`]);
  }
  if (raw === undefined) {
    return readFailure("missing", [`no artifact at ${target}`]);
  }
  return { ok: true, origin: "runtime", path: target, revision: runtimeRevision(raw), data: raw };
}

export async function readJsonArtifactAt<T>(target: string, schema?: ZodType<T>): Promise<RuntimeReadResult<T>> {
  const raw = await readTextArtifactAt(target);
  if (!raw.ok) return raw;

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.data);
  } catch (error: unknown) {
    return readFailure("invalid-json", [`${target} is not valid JSON: ${toError(error).message}`]);
  }

  if (schema) {
    const validated = validateWithSchema(schema, parsed);
    if (!validated.ok) {
      return readFailure("schema", validated.errors.map((entry) => `${target}: ${entry}`));
    }
    return { ok: true, origin: "runtime", path: target, revision: raw.revision, data: validated.data };
  }

  // Be schemos formos teiginys priklauso kvietėjui.
  return { ok: true, origin: "runtime", path: target, revision: raw.revision, data: parsed as T };
}

/**
 * Write-once: `writeFile(..., { flag: "wx" })` yra atominis exclusive create POSIX ir
 * Windows — antras rašytojas gauna EEXIST, o esamas failas niekada neliečiamas.
 */
export async function writeOnceAt(target: string, body: string): Promise<RuntimeWriteResult<RuntimeArtifactLocation>> {
  try {
    await nodeFsAdapter.makeDirectory(path.dirname(target));
    await writeFile(target, body, { encoding: "utf8", flag: "wx" });
  } catch (error: unknown) {
    if (isAlreadyExistsError(error)) {
      return writeFailure("already-exists", [`write-once artifact already exists: ${target}`]);
    }
    return writeFailure("io", [`cannot write ${target}: ${toError(error).message}`]);
  }
  return { ok: true, value: { path: target, revision: runtimeRevision(body) } };
}

export async function currentRevisionAt(target: string): Promise<RuntimeWriteResult<string>> {
  let raw: string | undefined;
  try {
    raw = await nodeFsAdapter.readTextFileIfExists(target);
  } catch (error: unknown) {
    return writeFailure("io", [`cannot read ${target}: ${toError(error).message}`]);
  }
  return { ok: true, value: raw === undefined ? ABSENT_REVISION : runtimeRevision(raw) };
}

/**
 * Compare-and-swap. `expectedRevision` privalomas: aklo perrašymo kelio SĄMONINGAI nėra —
 * „perrašyk, kas ten yra" yra būtent elgesys, kuriam pašalinti šis store egzistuoja.
 */
export async function writeCasAt(
  target: string,
  data: unknown,
  expectedRevision: string | undefined,
): Promise<RuntimeWriteResult<RuntimeArtifactLocation>> {
  if (expectedRevision === undefined) {
    return writeFailure("revision-required", [
      `${target} is compare-and-swap; pass expectedRevision (${ABSENT_REVISION} for the first write)`,
    ]);
  }

  let body: string;
  try {
    body = toPrettyJson(data);
  } catch (error: unknown) {
    return writeFailure("invalid-payload", [`${target} payload is not serializable: ${toError(error).message}`]);
  }

  const current = await currentRevisionAt(target);
  if (!current.ok) return current;
  if (current.value !== expectedRevision) {
    return writeFailure("revision-mismatch", [
      `${target} expected revision ${expectedRevision} but found ${current.value}`,
    ]);
  }

  try {
    await nodeFsAdapter.writeTextFile(target, body);
  } catch (error: unknown) {
    return writeFailure("io", [`cannot write ${target}: ${toError(error).message}`]);
  }
  return { ok: true, value: { path: target, revision: runtimeRevision(body) } };
}
