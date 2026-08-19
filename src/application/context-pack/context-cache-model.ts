// Context-cache įrašo schema ir sentineliai — gyvena PRIE context-pack klasterio (WBR E3:
// schema prie savo modulio). Pati cache persistencija (skaitymas/rašymas/evikcija) — E4;
// čia tik forma, kurią gamina assembly ir kurios identitetu remiasi cache raktas.
// Behaviour etalon: AG_loop core/schema.ts context-cache blokas + orchestrator/runtime/
// context-cache.ts konstantos.

import { z } from "zod";

const nonEmptyString = z.string().trim().min(1);

export const CONTEXT_CACHE_VERSION = 1;

// Hash sentinel for an evidence source that does not exist yet. Its later creation
// changes the fingerprint, so a missing spec file cannot be cached away.
export const CONTEXT_CACHE_ABSENT = "absent";

// Code index descriptors.
export const CODE_INDEX_UNUSED = "unused";
export const CODE_INDEX_STALE = "stale";

export const contextCacheSourceKindSchema = z.enum(["task", "source", "spec", "architecture", "policy"]);
export type ContextCacheSourceKind = z.infer<typeof contextCacheSourceKindSchema>;

export const contextCacheSourceSchema = z
  .object({
    kind: contextCacheSourceKindSchema,
    // Repo-relative, forward-slash path of the evidence source.
    path: nonEmptyString,
    // sha256 of the file content, or the `absent` sentinel when the source does not
    // exist yet (its later creation must invalidate the entry just like an edit).
    hash: nonEmptyString,
  })
  .passthrough();
export type ContextCacheSource = z.infer<typeof contextCacheSourceSchema>;

export const contextCacheEntrySchema = z
  .object({
    version: z.number().int().positive(),
    task_id: nonEmptyString,
    fingerprint: z.string().regex(/^[0-9a-f]{64}$/, "fingerprint must be 64 lowercase hex characters"),
    // Per-kind digests of `sources`, so a drift can be attributed to task, source, spec,
    // architecture or policy without diffing the whole list.
    components: z.record(contextCacheSourceKindSchema, nonEmptyString),
    sources: z.array(contextCacheSourceSchema).default([]),
    // Identity of the code index this pack's code_context was derived from:
    // `fresh:<source_hash>` or `unused` when the task needed no code context.
    code_index: nonEmptyString,
    // The encoded context-pack.json content, byte for byte. Deliberately NOT
    // `nonEmptyString`: that schema trims, which would drop the encoded pack's trailing
    // newline and make a cache hit differ from the assembly it replaces.
    context_pack_json: z.string().min(1),
    selected_chars: z.number().int().nonnegative(),
    selected_token_estimate: z.number().int().nonnegative(),
    // Carried so a cache hit reports the same truncation telemetry as the assembly that
    // produced it; it cannot be derived from the pack afterwards.
    dropped_item_count: z.number().int().nonnegative().default(0),
  })
  .passthrough();
export type ContextCacheEntry = z.infer<typeof contextCacheEntrySchema>;
