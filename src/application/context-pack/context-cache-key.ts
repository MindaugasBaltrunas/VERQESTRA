// Context-cache rakto GRYNOJI pusė (spec RAG-2): šaltinių rūšiavimas ir fingerprint.
// Behaviour etalon: AG_loop orchestrator/runtime/context-cache.ts (computeContextCacheKey/
// sortSources/hashText). Pati saugykla (lookup/save/evict/capacity) — E4 per ContextCachePort;
// jos elgesio kontraktas aprašytas porto tipuose ports.ts.

import { createHash } from "node:crypto";
import type { ContextCacheEntry, ContextCacheSource, ContextCacheSourceKind } from "./context-cache-model.js";
import { CONTEXT_CACHE_VERSION } from "./context-cache-model.js";

export const CONTEXT_CACHE_SOURCE_KINDS: readonly ContextCacheSourceKind[] = [
  "task",
  "source",
  "spec",
  "architecture",
  "policy",
];

export type ContextCacheKey = {
  fingerprint: string;
  components: Record<ContextCacheSourceKind, string>;
  sources: ContextCacheSource[];
};

export type ContextCacheLookup =
  | { status: "hit"; entry: ContextCacheEntry }
  | { status: "miss"; reason: "no_entry" | "invalid_entry" | "version_mismatch" | "source_drift" | "code_index_drift" };

export function hashText(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/**
 * Fingerprint a source set. Sources are ordered by kind (canonical priority order) and
 * then by path before hashing, so the caller's collection order cannot change the key.
 * Per-kind component digests make a drift attributable to task, source, spec,
 * architecture or policy without diffing the whole list.
 */
export function computeContextCacheKey(sources: ContextCacheSource[]): ContextCacheKey {
  const ordered = sortSources(sources);
  const components = {} as Record<ContextCacheSourceKind, string>;
  for (const kind of CONTEXT_CACHE_SOURCE_KINDS) {
    const forKind = ordered.filter((source) => source.kind === kind).map((source) => `${source.path}:${source.hash}`);
    components[kind] = hashText(JSON.stringify(forKind));
  }

  const fingerprint = hashText(
    JSON.stringify({
      version: CONTEXT_CACHE_VERSION,
      components: CONTEXT_CACHE_SOURCE_KINDS.map((kind) => [kind, components[kind]]),
    }),
  );

  return { fingerprint, components, sources: ordered };
}

/** Kanoninis šaltinių rūšiavimas — jį naudoja ir raktas, ir E4 saugyklos drift patikra. */
export function sortSources(sources: ContextCacheSource[]): ContextCacheSource[] {
  return [...sources]
    .map((source) => ({ kind: source.kind, path: normalizeRelative(source.path), hash: source.hash }))
    .sort(
      (a, b) =>
        CONTEXT_CACHE_SOURCE_KINDS.indexOf(a.kind) - CONTEXT_CACHE_SOURCE_KINDS.indexOf(b.kind) ||
        a.path.localeCompare(b.path) ||
        a.hash.localeCompare(b.hash),
    );
}

export function normalizeRelative(value: string): string {
  return value.trim().replace(/\\/g, "/").replace(/^\.\//, "");
}
