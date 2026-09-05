// Typed store task-scoped runtime artefaktams (etalonas: AG_loop
// infrastructure/persistence/runtime-artifact-store.ts; task 1117, ISO-1/ISO-2).
// VIENINTELIS vq/runtime/** rašytojas. Trys savybės:
//   1. TAPATYBĖ ĮRODOMA, ne prielaidaujama — kiekvienas kvietimas (be createAttempt)
//      pirmiausia skaito manifest.json ir tikrina run/worker/task/attempt prieš AttemptRef;
//      svetima evidencija yra `identity-mismatch`, niekada tyliai nepriimama.
//   2. RAŠYMAI PAKLŪSTA DEKLARUOTAI POLITIKAI — įvestys write-once per atominį exclusive
//      create (retry negali perrašyti, ko bandymas vykdė — jam reikia NAUJO attempt id);
//      baigties įrašai compare-and-swap (pavėlavęs rašytojas aptinkamas, ne perrašo).
//   3. KLAIDA YRA REIKŠMĖ — niekas nemeta; kiekvienas atmetimas — typed rezultatas.
// Sluoksnis: infrastructure; kelio taisyklės — infrastructure/runtime-paths (vq/runtime),
// attempt tapatybė — application/scheduling/worker-limits.

import { readdir } from "node:fs/promises";
import path from "node:path";
import type { ZodType } from "zod";
import { formatAttemptId, type AttemptRef } from "../../application/scheduling/worker-limits.js";
import type { TaskUsageEntry } from "../../domain/tokens/usage-ledger.js";
import { toError } from "../../shared/errors.js";
import { toPrettyJson } from "../../shared/json.js";
import { validateWithSchema } from "../../shared/schema.js";
import { nodeFsAdapter } from "../fs/node-fs-adapter.js";
import {
  attemptDir as attemptDirPath,
  attemptLogPath,
  RUNTIME_ARTIFACTS,
  RUNTIME_ATTEMPTS_DIR_NAME,
  taskDir as taskDirPath,
  type RuntimeArtifactKind,
} from "../runtime-paths.js";
import {
  currentRevisionAt,
  readFailure,
  readJsonArtifactAt,
  readTextArtifactAt,
  writeCasAt,
  writeFailure,
  writeFailureFromRead,
  writeOnceAt,
  type RuntimeArtifactLocation,
  type RuntimeReadResult,
  type RuntimeWriteResult,
} from "./runtime-artifact-io.js";
import {
  runtimeAttemptManifestSchema,
  runtimeAttemptPolicySchema,
  runtimeAttemptSourceSchema,
  type RuntimeAttemptManifest,
} from "./runtime-attempt-schema.js";

/** Artefaktų rūšys, saugomos kaip vienas JSON dokumentas. */
export type RuntimeJsonArtifactKind =
  | "manifest"
  | "decision"
  | "context-pack"
  | "execution-result"
  | "quality-result"
  | "stop-state"
  | "task-start-status";

/** Artefaktų rūšys, saugomos kaip grynas tekstas. */
export type RuntimeTextArtifactKind = "task" | "execution-context";

export type CreateAttemptInput = {
  runtimeRoot: string;
  ref: AttemptRef;
  /** `computeGraphHash` rezultatas arba `RUNTIME_GRAPH_HASH_NONE`. */
  graphHash: string;
  waveId?: string;
  attemptSequence?: number;
  /** Validuojama `runtimeAttemptPolicySchema`. */
  policy: unknown;
  /** Validuojama `runtimeAttemptSourceSchema`. */
  source: unknown;
  /** Injektuota ISO laiko žyma — saugykla laikrodžio neskaito. */
  createdAt: string;
};

/**
 * Užima attempt katalogą ir rašo jo manifestą. Id užimamas lygiai kartą per
 * `(run, worker, task)`: paskutinis segmentas kuriamas su `recursive: false`, tad esamas
 * katalogas — `already-exists` ir NIEKAS nemodifikuojama. Katalogas be manifesto (krachas
 * tarp mkdir ir rašymo) lieka inertiškas: skaitymai grąžina `manifest-missing`, o ši
 * funkcija id vis tiek atsisako — be manifesto attempt neturi įrodomos tapatybės (ISO-2).
 */
export async function createAttempt(
  input: CreateAttemptInput,
): Promise<RuntimeWriteResult<{ dir: string; manifest: RuntimeAttemptManifest; revision: string }>> {
  const dir = attemptDirPath(input.runtimeRoot, input.ref);
  if (!dir.ok) return writeFailure("invalid-path", dir.errors);

  const policy = validateWithSchema(runtimeAttemptPolicySchema, input.policy);
  if (!policy.ok) return writeFailure("invalid-payload", policy.errors.map((entry) => `policy.${entry}`));

  const source = validateWithSchema(runtimeAttemptSourceSchema, input.source);
  if (!source.ok) return writeFailure("invalid-payload", source.errors.map((entry) => `source.${entry}`));

  const manifest = validateWithSchema(runtimeAttemptManifestSchema, {
    run_id: input.ref.runId,
    worker_id: input.ref.workerId,
    task_id: input.ref.taskId,
    attempt_id: input.ref.attemptId,
    attempt_sequence: input.attemptSequence ?? 1,
    ...(input.waveId === undefined ? {} : { wave_id: input.waveId }),
    graph_hash: input.graphHash,
    policy: policy.data,
    source: source.data,
    created_at: input.createdAt,
  });
  if (!manifest.ok) return writeFailure("invalid-payload", manifest.errors);

  try {
    await nodeFsAdapter.makeDirectory(path.dirname(dir.value));
    // `recursive: false` yra pats užėmimas, ir `createDirectoryExclusive` (ne
    // `createLockDirectory`) — nes „exists" čia privalo reikšti TIK `EEXIST`. Lock'o
    // klasifikacija win32 EPERM/EACCES laikytų vardą užimtu, ir teisių klaida grįžtų kaip
    // `already-exists`; kvietėjas (`active-attempt`) tada imtų `nextAttemptId` ir gautų tą
    // pačią klaidą su tuo pačiu melagingu paaiškinimu (2026-09-05 audito F7).
    const claimed = await nodeFsAdapter.createDirectoryExclusive(dir.value);
    if (claimed === "exists") {
      return writeFailure("already-exists", [`attempt directory already exists: ${dir.value}`]);
    }
  } catch (error: unknown) {
    return writeFailure("io", [`cannot create ${dir.value}: ${toError(error).message}`]);
  }

  const target = path.join(dir.value, RUNTIME_ARTIFACTS.manifest.file);
  const written = await writeOnceAt(target, toPrettyJson(manifest.data));
  if (!written.ok) return written;

  return { ok: true, value: { dir: dir.value, manifest: manifest.data, revision: written.value.revision } };
}

function identityMismatches(manifest: RuntimeAttemptManifest, ref: AttemptRef): string[] {
  const pairs: readonly [string, string, string][] = [
    ["run_id", manifest.run_id, ref.runId],
    ["worker_id", manifest.worker_id, ref.workerId],
    ["task_id", manifest.task_id, ref.taskId],
    ["attempt_id", manifest.attempt_id, ref.attemptId],
  ];
  return pairs
    .filter(([, stored, expected]) => stored !== expected)
    .map(([field, stored, expected]) => `manifest ${field} is ${JSON.stringify(stored)}, expected ${JSON.stringify(expected)}`);
}

export async function readAttemptManifest(
  runtimeRoot: string,
  ref: AttemptRef,
): Promise<RuntimeReadResult<RuntimeAttemptManifest>> {
  const dir = attemptDirPath(runtimeRoot, ref);
  if (!dir.ok) return readFailure("invalid-path", dir.errors);

  const target = path.join(dir.value, RUNTIME_ARTIFACTS.manifest.file);
  const read = await readJsonArtifactAt(target, runtimeAttemptManifestSchema);
  if (!read.ok) {
    // „Neperskaitomas manifestas" dengia nesamą, nutrūkusį ir sugadintą vienodai: visi
    // trys reiškia, kad katalogas negali įrodyti, kieno tai bandymas.
    return read.reason === "missing" ? readFailure("manifest-missing", read.errors) : read;
  }

  const mismatches = identityMismatches(read.data, ref);
  if (mismatches.length > 0) {
    return readFailure("identity-mismatch", mismatches);
  }
  return read;
}

/**
 * Manifestas patikrinamas kartą ir grąžinami pririšti accessor'iai — pirminis API.
 * Laisvos funkcijos žemiau tikrina kiekvieną kartą (teisinga, bet brangu append cikle).
 */
export type RuntimeAttemptHandle = {
  readonly ref: AttemptRef;
  readonly dir: string;
  readonly manifest: RuntimeAttemptManifest;
  readJson<T>(kind: RuntimeJsonArtifactKind, schema?: ZodType<T>): Promise<RuntimeReadResult<T>>;
  writeJson<T>(
    kind: RuntimeJsonArtifactKind,
    data: T,
    options?: { expectedRevision?: string; schema?: ZodType<T> },
  ): Promise<RuntimeWriteResult<RuntimeArtifactLocation>>;
  readText(kind: RuntimeTextArtifactKind): Promise<RuntimeReadResult<string>>;
  writeText(kind: RuntimeTextArtifactKind, text: string): Promise<RuntimeWriteResult<RuntimeArtifactLocation>>;
  appendUsage(entry: TaskUsageEntry): Promise<RuntimeWriteResult<{ path: string }>>;
  appendLog(channel: string, line: string): Promise<RuntimeWriteResult<{ path: string }>>;
};

function artifactPathIn(dir: string, kind: Exclude<RuntimeArtifactKind, "log">): string {
  return path.join(dir, RUNTIME_ARTIFACTS[kind].file);
}

function createHandle(
  runtimeRoot: string,
  ref: AttemptRef,
  dir: string,
  manifest: RuntimeAttemptManifest,
): RuntimeAttemptHandle {
  return {
    ref,
    dir,
    manifest,

    async readJson<T>(kind: RuntimeJsonArtifactKind, schema?: ZodType<T>): Promise<RuntimeReadResult<T>> {
      return await readJsonArtifactAt(artifactPathIn(dir, kind), schema);
    },

    async writeJson<T>(
      kind: RuntimeJsonArtifactKind,
      data: T,
      options: { expectedRevision?: string; schema?: ZodType<T> } = {},
    ): Promise<RuntimeWriteResult<RuntimeArtifactLocation>> {
      const target = artifactPathIn(dir, kind);
      let payload: unknown = data;
      if (options.schema) {
        const validated = validateWithSchema(options.schema, data);
        if (!validated.ok) {
          return writeFailure("invalid-payload", validated.errors.map((entry) => `${target}: ${entry}`));
        }
        // Persistinama VALIDUOTA reikšmė — default'ai ir koercijos atsiduria ir diske.
        payload = validated.data;
      }

      const descriptor = RUNTIME_ARTIFACTS[kind];
      if (descriptor.policy === "write-once") {
        let body: string;
        try {
          body = toPrettyJson(payload);
        } catch (error: unknown) {
          return writeFailure("invalid-payload", [`${target} payload is not serializable: ${toError(error).message}`]);
        }
        return await writeOnceAt(target, body);
      }
      if (descriptor.policy === "compare-and-swap") {
        return await writeCasAt(target, payload, options.expectedRevision);
      }
      return writeFailure("invalid-payload", [`${kind} is ${descriptor.policy}; use appendUsage/appendLog`]);
    },

    async readText(kind: RuntimeTextArtifactKind): Promise<RuntimeReadResult<string>> {
      return await readTextArtifactAt(artifactPathIn(dir, kind));
    },

    async writeText(kind: RuntimeTextArtifactKind, text: string): Promise<RuntimeWriteResult<RuntimeArtifactLocation>> {
      return await writeOnceAt(artifactPathIn(dir, kind), text);
    },

    async appendUsage(entry: TaskUsageEntry): Promise<RuntimeWriteResult<{ path: string }>> {
      const target = artifactPathIn(dir, "usage");
      let line: string;
      try {
        // Po vieną įrašą eilutėje — `parseTaskUsageEntries` veikia nepakitęs.
        line = `${JSON.stringify(entry)}\n`;
      } catch (error: unknown) {
        return writeFailure("invalid-payload", [`${target} usage entry is not serializable: ${toError(error).message}`]);
      }
      try {
        await nodeFsAdapter.appendTextFile(target, line);
      } catch (error: unknown) {
        return writeFailure("io", [`cannot append ${target}: ${toError(error).message}`]);
      }
      return { ok: true, value: { path: target } };
    },

    async appendLog(channel: string, line: string): Promise<RuntimeWriteResult<{ path: string }>> {
      const target = attemptLogPath(runtimeRoot, ref, channel);
      if (!target.ok) return writeFailure("invalid-path", target.errors);
      try {
        await nodeFsAdapter.appendTextFile(target.value, line.endsWith("\n") ? line : `${line}\n`);
      } catch (error: unknown) {
        return writeFailure("io", [`cannot append ${target.value}: ${toError(error).message}`]);
      }
      return { ok: true, value: { path: target.value } };
    },
  };
}

export async function openAttempt(
  runtimeRoot: string,
  ref: AttemptRef,
): Promise<RuntimeReadResult<RuntimeAttemptHandle>> {
  const dir = attemptDirPath(runtimeRoot, ref);
  if (!dir.ok) return readFailure("invalid-path", dir.errors);

  const manifest = await readAttemptManifest(runtimeRoot, ref);
  if (!manifest.ok) return manifest;

  return {
    ok: true,
    origin: "runtime",
    path: dir.value,
    revision: manifest.revision,
    data: createHandle(runtimeRoot, ref, dir.value, manifest.data),
  };
}

/**
 * Compare-and-swap su vienu pakartojimu: nuskaito EINAMĄJĄ revision ir rašo; jei tarp
 * skaitymo ir rašymo įsiterpė kitas rašytojas (`revision-mismatch`), bandoma dar kartą.
 * Revision imamas iš failo BAITŲ hash'o, tad sugadintas ar senesnės formos dokumentas
 * neturi AMŽINAI užblokuoti rašymo.
 */
export async function writeAttemptJsonWithRetry(
  handle: RuntimeAttemptHandle,
  kind: RuntimeJsonArtifactKind,
  data: unknown,
  options: { attempts?: number } = {},
): Promise<RuntimeWriteResult<RuntimeArtifactLocation>> {
  const descriptor = RUNTIME_ARTIFACTS[kind];
  if (descriptor.policy !== "compare-and-swap") {
    return writeFailure("invalid-payload", [
      `${kind} is ${descriptor.policy}; writeAttemptJsonWithRetry is for compare-and-swap artifacts`,
    ]);
  }

  const target = artifactPathIn(handle.dir, kind);
  const rounds = Math.max(1, Math.trunc(options.attempts ?? 2));
  let last: RuntimeWriteResult<RuntimeArtifactLocation> = writeFailure("io", [`no write attempted for ${target}`]);
  for (let round = 0; round < rounds; round += 1) {
    const current = await currentRevisionAt(target);
    if (!current.ok) return current;
    last = await handle.writeJson(kind, data, { expectedRevision: current.value });
    if (last.ok || last.reason !== "revision-mismatch") return last;
  }
  return last;
}

// Laisvos funkcijos — tos pačios formos, kiekviena pati patikrina manifestą.

export async function readJsonArtifact<T>(
  runtimeRoot: string,
  ref: AttemptRef,
  kind: RuntimeJsonArtifactKind,
  schema?: ZodType<T>,
): Promise<RuntimeReadResult<T>> {
  const handle = await openAttempt(runtimeRoot, ref);
  if (!handle.ok) return handle;
  return schema === undefined ? await handle.data.readJson(kind) : await handle.data.readJson(kind, schema);
}

export async function writeJsonArtifact<T>(
  runtimeRoot: string,
  ref: AttemptRef,
  kind: RuntimeJsonArtifactKind,
  data: T,
  options: { expectedRevision?: string; schema?: ZodType<T> } = {},
): Promise<RuntimeWriteResult<RuntimeArtifactLocation>> {
  const handle = await openAttempt(runtimeRoot, ref);
  if (!handle.ok) return writeFailureFromRead(handle.reason, handle.errors);
  return await handle.data.writeJson(kind, data, options);
}

export async function readTextArtifact(
  runtimeRoot: string,
  ref: AttemptRef,
  kind: RuntimeTextArtifactKind,
): Promise<RuntimeReadResult<string>> {
  const handle = await openAttempt(runtimeRoot, ref);
  if (!handle.ok) return handle;
  return await handle.data.readText(kind);
}

export async function writeTextArtifact(
  runtimeRoot: string,
  ref: AttemptRef,
  kind: RuntimeTextArtifactKind,
  text: string,
): Promise<RuntimeWriteResult<RuntimeArtifactLocation>> {
  const handle = await openAttempt(runtimeRoot, ref);
  if (!handle.ok) return writeFailureFromRead(handle.reason, handle.errors);
  return await handle.data.writeText(kind, text);
}

export async function appendUsageEntry(
  runtimeRoot: string,
  ref: AttemptRef,
  entry: TaskUsageEntry,
): Promise<RuntimeWriteResult<{ path: string }>> {
  const handle = await openAttempt(runtimeRoot, ref);
  if (!handle.ok) return writeFailureFromRead(handle.reason, handle.errors);
  return await handle.data.appendUsage(entry);
}

export async function appendAttemptLog(
  runtimeRoot: string,
  ref: AttemptRef,
  channel: string,
  line: string,
): Promise<RuntimeWriteResult<{ path: string }>> {
  const handle = await openAttempt(runtimeRoot, ref);
  if (!handle.ok) return writeFailureFromRead(handle.reason, handle.errors);
  return await handle.data.appendLog(channel, line);
}

// Attempt'ų enumeracija.

export type AttemptScope = { runId: string; workerId: string; taskId: string };

const ATTEMPT_ID_PATTERN = /^a([0-9]+)$/;

function attemptSequenceOf(attemptId: string): number | undefined {
  const match = ATTEMPT_ID_PATTERN.exec(attemptId);
  if (!match?.[1]) return undefined;
  const sequence = Number.parseInt(match[1], 10);
  return Number.isSafeInteger(sequence) ? sequence : undefined;
}

/**
 * Attempt id po `(run, worker, task)`: kanoniniai `a<n>` pirmi skaitine tvarka, tada
 * svetimi vardai leksikografiškai. Tuščias, kai katalogo nėra — „dar nėra bandymų".
 */
export async function listAttemptIds(runtimeRoot: string, scope: AttemptScope): Promise<string[]> {
  const dir = taskDirPath(runtimeRoot, scope.runId, scope.workerId, scope.taskId);
  if (!dir.ok) return [];

  const attemptsRoot = path.join(dir.value, RUNTIME_ATTEMPTS_DIR_NAME);
  const entries = await readdir(attemptsRoot, { withFileTypes: true }).catch(() => []);

  return entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort((a, b) => {
      const left = attemptSequenceOf(a);
      const right = attemptSequenceOf(b);
      if (left !== undefined && right !== undefined) return left - right;
      if (left !== undefined) return -1;
      if (right !== undefined) return 1;
      return a.localeCompare(b);
    });
}

/**
 * Patariamasis kitas attempt id: `max(sequence) + 1`. Patariamasis, nes du kvietėjai gali
 * suskaičiuoti tą pačią reikšmę; tikras sargas — `createAttempt`.
 */
export async function nextAttemptId(
  runtimeRoot: string,
  scope: AttemptScope,
): Promise<RuntimeWriteResult<{ attemptId: string; sequence: number }>> {
  const dir = taskDirPath(runtimeRoot, scope.runId, scope.workerId, scope.taskId);
  if (!dir.ok) return writeFailure("invalid-path", dir.errors);

  const existing = await listAttemptIds(runtimeRoot, scope);
  const highest = existing.reduce((max, id) => Math.max(max, attemptSequenceOf(id) ?? 0), 0);
  const sequence = highest + 1;
  return { ok: true, value: { attemptId: formatAttemptId(sequence), sequence } };
}
