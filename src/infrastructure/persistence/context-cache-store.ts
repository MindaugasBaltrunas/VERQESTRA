// Deterministinio context-pack cache saugykla (etalonas: AG_loop
// orchestrator/runtime/context-cache.ts; RAG-2). Grynoji rakto pusė —
// application/context-pack/context-cache-key; schemos — context-cache-model. Čia lieka
// IO: šaltinių surinkimas su hash'ais, lookup su lazy code-index patikra, save su talpos
// ribojimu ir tikslinis invalidavimas. VERQESTRA keliai: vq/state/context-cache,
// vq/state/architecture/graph.json, vq/architecture/architecture-style.json, vq/config/*.

import { readFile, readdir, rm, stat } from "node:fs/promises";
import path from "node:path";
import {
  CODE_INDEX_STALE,
  CODE_INDEX_UNUSED,
  CONTEXT_CACHE_ABSENT,
  CONTEXT_CACHE_VERSION,
  contextCacheEntrySchema,
  type ContextCacheEntry,
  type ContextCacheSource,
} from "../../application/context-pack/context-cache-model.js";
import {
  computeContextCacheKey,
  hashText,
  normalizeRelative,
  sortSources,
  type ContextCacheKey,
  type ContextCacheLookup,
} from "../../application/context-pack/context-cache-key.js";
import type { ContextCachePort } from "../../application/context-pack/ports.js";
import { sha256Hex } from "../../shared/hash.js";
import { toPrettyJson } from "../../shared/json.js";
import { validateWithSchema } from "../../shared/schema.js";
import { nodeFsAdapter } from "../fs/node-fs-adapter.js";

/** Saugomų įrašų lubos. Seniausi metami pirmi; cache yra išvestinis artefaktas. */
export const DEFAULT_MAX_CONTEXT_CACHE_ENTRIES = 64;

/** vq/config failai, keičiantys, ką context pack'as turi savyje. */
export const CONTEXT_CACHE_POLICY_FILES = [
  "context-budget.json",
  "context-selection-policy.json",
  "tool-budget.json",
  "agents.json",
  "task-classification-policy.json",
  "rag-policy.json",
] as const;

export function contextCacheDir(runtimeRoot: string): string {
  return path.join(runtimeRoot, "state", "context-cache");
}

export function contextCacheEntryPath(runtimeRoot: string, fingerprint: string): string {
  return path.join(contextCacheDir(runtimeRoot), `${fingerprint}.json`);
}

export type CollectContextCacheSourcesInput = {
  taskPath: string;
  taskText: string;
  targets: string[];
  specSources: string[];
};

/**
 * Surenka kiekvieną įrodymų šaltinį su turinio hash'u. Skaitymai best-effort pagal dizainą:
 * neperskaitomas/nesamas šaltinis fiksuojamas `absent` sentineliu, o ne metimu — sentinelis
 * dalyvauja fingerprint'e, tad šaltinio atsiradimas vėliau yra reali invalidacija.
 */
export async function collectContextCacheSources(
  projectRoot: string,
  runtimeRoot: string,
  input: CollectContextCacheSourcesInput,
): Promise<ContextCacheSource[]> {
  const root = path.resolve(projectRoot);
  const sources: ContextCacheSource[] = [
    { kind: "task", path: relativePath(root, input.taskPath), hash: hashText(input.taskText) },
  ];

  for (const target of unique(input.targets)) {
    sources.push({ kind: "source", path: normalizeRelative(target), hash: await hashFile(path.resolve(root, target)) });
  }

  for (const ref of unique(input.specSources.map(specFilePart).filter(Boolean))) {
    sources.push({ kind: "spec", path: normalizeRelative(ref), hash: await hashFile(path.resolve(root, ref)) });
  }

  for (const architecturePath of [
    path.join(runtimeRoot, "state", "architecture", "graph.json"),
    path.join(runtimeRoot, "architecture", "architecture-style.json"),
  ]) {
    sources.push({ kind: "architecture", path: relativePath(root, architecturePath), hash: await hashFile(architecturePath) });
  }

  for (const policyFile of CONTEXT_CACHE_POLICY_FILES) {
    const policyPath = path.join(runtimeRoot, "config", policyFile);
    sources.push({ kind: "policy", path: relativePath(root, policyPath), hash: await hashFile(policyPath) });
  }

  return sources;
}

/**
 * Lookup. `verifyCodeIndex` kviečiamas LAZY — tik kai įrašas šiam fingerprint'ui yra IR jis
 * realiai naudojo code index; miss niekada nemoka už project skeną du kartus. Įrašas,
 * nebeatitinkantis savo paties užfiksuotų šaltinių, evict'inamas ir grąžinamas kaip miss.
 */
export async function lookupContextCache(
  runtimeRoot: string,
  key: ContextCacheKey,
  verifyCodeIndex: () => Promise<string> = () => Promise.resolve(CODE_INDEX_UNUSED),
): Promise<ContextCacheLookup> {
  const entryPath = contextCacheEntryPath(runtimeRoot, key.fingerprint);
  const raw = await readOptional(entryPath);
  if (raw === undefined) {
    return { status: "miss", reason: "no_entry" };
  }

  const entry = parseEntry(raw);
  if (!entry) {
    await evict(entryPath);
    return { status: "miss", reason: "invalid_entry" };
  }
  if (entry.version !== CONTEXT_CACHE_VERSION) {
    await evict(entryPath);
    return { status: "miss", reason: "version_mismatch" };
  }
  if (!sameSources(entry.sources, key.sources) || entry.fingerprint !== key.fingerprint) {
    await evict(entryPath);
    return { status: "miss", reason: "source_drift" };
  }

  if (entry.code_index !== CODE_INDEX_UNUSED) {
    const current = await verifyCodeIndex();
    if (current !== entry.code_index) {
      await evict(entryPath);
      return { status: "miss", reason: "code_index_drift" };
    }
  }

  return { status: "hit", entry };
}

export type SaveContextCacheEntryInput = {
  key: ContextCacheKey;
  taskId: string;
  contextPackJson: string;
  codeIndexDescriptor: string;
  selectedChars: number;
  selectedTokenEstimate: number;
  droppedItemCount: number;
  maxEntries?: number;
};

/**
 * Persistina vieną assembly po jo fingerprint'u. Assembly su STALE code index sąmoningai
 * NESAUGOMAS: `stale` nėra turinio tapatybė — du skirtingi repo galėtų ja dalintis.
 */
export async function saveContextCacheEntry(
  runtimeRoot: string,
  input: SaveContextCacheEntryInput,
): Promise<{ stored: boolean; reason?: "code_index_stale" }> {
  if (input.codeIndexDescriptor === CODE_INDEX_STALE) {
    return { stored: false, reason: "code_index_stale" };
  }

  const entry: ContextCacheEntry = {
    version: CONTEXT_CACHE_VERSION,
    task_id: input.taskId,
    fingerprint: input.key.fingerprint,
    components: input.key.components,
    sources: input.key.sources,
    code_index: input.codeIndexDescriptor,
    context_pack_json: input.contextPackJson,
    selected_chars: input.selectedChars,
    selected_token_estimate: input.selectedTokenEstimate,
    dropped_item_count: input.droppedItemCount,
  };

  const entryPath = contextCacheEntryPath(runtimeRoot, input.key.fingerprint);
  // Kanoninis atominis rašymas (unikalus tmp + win32 retry) — etalono task 0064 pamoka:
  // fiksuotas tmp vardas dviem lygiagretiems rašytojams palikdavo apkirptą JSON.
  await nodeFsAdapter.writeTextFile(entryPath, toPrettyJson(entry));

  await enforceContextCacheCapacity(runtimeRoot, input.maxEntries ?? DEFAULT_MAX_CONTEXT_CACHE_ENTRIES);
  return { stored: true };
}

export type ContextCacheInvalidation = {
  removed: string[];
  kept: string[];
};

/** Invaliduoja BŪTENT nuo pakeistų kelių priklausančius įrašus; kiti paliekami. */
export async function invalidateContextCacheForSources(
  runtimeRoot: string,
  changedPaths: string[],
): Promise<ContextCacheInvalidation> {
  const changed = new Set(changedPaths.map((entry) => normalizeRelative(entry)));
  const removed: string[] = [];
  const kept: string[] = [];

  for (const { file, entry } of await readContextCacheEntries(runtimeRoot)) {
    if (entry.sources.some((source) => changed.has(normalizeRelative(source.path)))) {
      await evict(file);
      removed.push(entry.fingerprint);
    } else {
      kept.push(entry.fingerprint);
    }
  }

  return { removed: removed.sort(), kept: kept.sort() };
}

/** Numeta įrašus, kurių užfiksuota evidencija nebeatitinka disko (vietos atgavimas + matomumas). */
export async function pruneStaleContextCacheEntries(
  projectRoot: string,
  runtimeRoot: string,
): Promise<ContextCacheInvalidation> {
  const root = path.resolve(projectRoot);
  const removed: string[] = [];
  const kept: string[] = [];

  for (const { file, entry } of await readContextCacheEntries(runtimeRoot)) {
    let stale = entry.version !== CONTEXT_CACHE_VERSION;
    for (const source of entry.sources) {
      if (stale) break;
      stale = (await hashFile(path.resolve(root, source.path))) !== source.hash;
    }
    if (stale) {
      await evict(file);
      removed.push(entry.fingerprint);
    } else {
      kept.push(entry.fingerprint);
    }
  }

  return { removed: removed.sort(), kept: kept.sort() };
}

export async function readContextCacheEntries(
  runtimeRoot: string,
): Promise<{ file: string; entry: ContextCacheEntry }[]> {
  const dir = contextCacheDir(runtimeRoot);
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return [];
  }

  const entries: { file: string; entry: ContextCacheEntry }[] = [];
  for (const name of names.filter((value) => value.endsWith(".json")).sort()) {
    const file = path.join(dir, name);
    const raw = await readOptional(file);
    const entry = raw === undefined ? undefined : parseEntry(raw);
    if (entry) {
      entries.push({ file, entry });
    }
  }
  return entries;
}

/** ContextCachePort (RAG-2) reali implementacija — vienas adapteris assembly keliui. */
export function createContextCacheAdapter(
  projectRoot: string,
  runtimeRoot: string,
  maxEntries: number = DEFAULT_MAX_CONTEXT_CACHE_ENTRIES,
): ContextCachePort {
  return {
    async collectSources(input) {
      const sources = await collectContextCacheSources(projectRoot, runtimeRoot, input);
      return computeContextCacheKey(sources).sources;
    },
    async lookup(key, verifyCodeIndex) {
      return await lookupContextCache(runtimeRoot, key, verifyCodeIndex);
    },
    async save(input) {
      return await saveContextCacheEntry(runtimeRoot, { ...input, maxEntries });
    },
  };
}

async function enforceContextCacheCapacity(runtimeRoot: string, maxEntries: number): Promise<void> {
  if (maxEntries <= 0) {
    return;
  }
  const dir = contextCacheDir(runtimeRoot);
  let names: string[];
  try {
    names = (await readdir(dir)).filter((name) => name.endsWith(".json"));
  } catch {
    return;
  }
  if (names.length <= maxEntries) {
    return;
  }

  const stamped: { file: string; modified: number }[] = [];
  for (const name of names.sort()) {
    const file = path.join(dir, name);
    const modified = await stat(file).then((value) => value.mtimeMs, () => 0);
    stamped.push({ file, modified });
  }
  stamped.sort((a, b) => a.modified - b.modified || a.file.localeCompare(b.file));
  for (const { file } of stamped.slice(0, stamped.length - maxEntries)) {
    await evict(file);
  }
}

function parseEntry(raw: string): ContextCacheEntry | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  const validation = validateWithSchema(contextCacheEntrySchema, parsed);
  return validation.ok ? validation.data : undefined;
}

function sameSources(left: ContextCacheSource[], right: ContextCacheSource[]): boolean {
  if (left.length !== right.length) {
    return false;
  }
  const ordered = sortSources(right);
  return sortSources(left).every((source, index) => {
    const other = ordered[index];
    return other !== undefined && source.kind === other.kind && source.path === other.path && source.hash === other.hash;
  });
}

async function hashFile(filePath: string): Promise<string> {
  try {
    return sha256Hex(await readFile(filePath));
  } catch {
    return CONTEXT_CACHE_ABSENT;
  }
}

async function readOptional(filePath: string): Promise<string | undefined> {
  try {
    return await readFile(filePath, "utf8");
  } catch {
    return undefined;
  }
}

async function evict(filePath: string): Promise<void> {
  await rm(filePath, { force: true }).catch(() => undefined);
}

function specFilePart(ref: string): string {
  const hashIndex = ref.indexOf("#");
  return (hashIndex === -1 ? ref : ref.slice(0, hashIndex)).trim();
}

function relativePath(root: string, target: string): string {
  const absolute = path.isAbsolute(target) ? target : path.resolve(root, target);
  return normalizeRelative(path.relative(root, absolute));
}

function unique(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}
