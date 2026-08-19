// The compression inputs a cached context pack's identity depends on (task 0038).
// Behaviour etalon: AG_loop application/context-pack/compression-cache-sources.ts;
// FS — per portą, keliai — VERQESTRA runtime šaknis, arrestDecision — domain (VQ-203).
//
// The authored config was already declared as a cache source (task 0023). The ARREST is the
// second half of that same statement: a pack compiled with `symbol_slices` on, then arrested,
// must not be handed back from the cache byte-for-byte.
//
// ## Why the arrest contributes a DERIVED hash rather than the file's bytes
//
// The arrest marker also carries `counters`, and those move on essentially every canary-arm
// dispatch while having no influence whatsoever on a pack's content:
// `applyContextCompressionArrest` reads only the arrested feature set and `unreadable`.
// Hashing the bytes would evict healthy cache entries through pure counter churn. The
// projection is provably sufficient because the effective config is exactly
// `f(authored, arrested set, unreadable)` — the two things `contextCompressionArrestDecision`
// encodes, alongside the authored file's own hash.

import { createHash } from "node:crypto";
import path from "node:path";
import { toPosixPath } from "../../shared/paths.js";
import { contextCompressionArrestDecision } from "../../domain/policies/compression/dependencies.js";
import type { ContextCompressionArrestView } from "../../domain/policies/compression/arrest.js";
import { CONTEXT_CACHE_ABSENT, type ContextCacheSource } from "./context-cache-model.js";
import { contextCompressionArrestStatePath, contextCompressionConfigPath } from "./effective-compression-policy.js";
import type { ContextPackFileSystemPort } from "./ports.js";

export async function contextCompressionCacheSources(input: {
  fs: ContextPackFileSystemPort;
  root: string;
  runtimeRoot: string;
  arrestView: ContextCompressionArrestView;
}): Promise<ContextCacheSource[]> {
  return [
    await contextCompressionConfigCacheSource(input.fs, input.root, input.runtimeRoot),
    contextCompressionArrestCacheSource(input.root, input.runtimeRoot, input.arrestView),
  ];
}

// Content identity of the authored compression config for the context cache, using the
// same sha256-or-`absent` convention as the policy files.
async function contextCompressionConfigCacheSource(
  fs: ContextPackFileSystemPort,
  root: string,
  runtimeRoot: string,
): Promise<ContextCacheSource> {
  const configPath = contextCompressionConfigPath(runtimeRoot);
  let hash: string;
  try {
    hash = createHash("sha256").update(await fs.readFileBytes(configPath)).digest("hex");
  } catch {
    hash = CONTEXT_CACHE_ABSENT;
  }
  return { kind: "policy", path: toPosixPath(path.relative(root, configPath)), hash };
}

/**
 * Identity of the arrest's EFFECT, filed under the marker's own path so the operator reading
 * a cache key can see which artefact it came from. No arrest at all reads as `absent`, the
 * same convention a missing policy file uses.
 */
function contextCompressionArrestCacheSource(
  root: string,
  runtimeRoot: string,
  view: ContextCompressionArrestView,
): ContextCacheSource {
  const statePath = contextCompressionArrestStatePath(runtimeRoot);
  const decision = contextCompressionArrestDecision(view);
  const hash =
    decision === undefined ? CONTEXT_CACHE_ABSENT : createHash("sha256").update(decision, "utf8").digest("hex");
  return { kind: "policy", path: toPosixPath(path.relative(root, statePath)), hash };
}
