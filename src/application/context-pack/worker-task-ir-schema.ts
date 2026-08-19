// WorkerTaskIR zod schema — gyvena PRIE savo modulio, ne bendrame schema faile (WBR E3:
// core/schema.ts nemigruoja kaip failas; schema TENKINA kompiliatoriaus gaminamą formą, R2).
// Behaviour etalon: AG_loop core/schema.ts worker IR blokas (1:1).

import { z } from "zod";

const nonEmptyString = z.string().min(1);
const stringList = z.array(z.string());

/** Bump only on a breaking change to the IR contract. */
export const WORKER_TASK_IR_VERSION = 1;

/**
 * `directive` — a recognized worker instruction block (e.g. the sandbox rules) whose body
 * is still carried verbatim. `raw` — an unrecognized or ambiguous section, preserved
 * exactly as written. Both kinds are byte-preserving; the distinction only tells a later
 * renderer how prominently to place the block.
 */
export const workerTaskIrElementKindSchema = z.enum(["directive", "raw"]);
export type WorkerTaskIrElementKind = z.infer<typeof workerTaskIrElementKindSchema>;

export const workerTaskIrElementSchema = z
  .object({
    /** Verbatim heading line ("## Sandbox taisyklės (privaloma — taupo turns)"), or "" for the preamble. */
    heading: z.string(),
    kind: workerTaskIrElementKindSchema,
    /** Verbatim body. Never normalized, re-wrapped or re-worded. */
    body: z.string(),
  })
  .passthrough();
export type WorkerTaskIrElement = z.infer<typeof workerTaskIrElementSchema>;

export const workerTaskIrSchema = z
  .object({
    version: z.number().int().positive(),
    task_id: nonEmptyString,
    /** Full `## Tikslas` body, not just its first line: a multi-line goal keeps every line. */
    goal: nonEmptyString,
    /** The hard edit boundary, from the canonical `## Failai` → `Leidžiama:` parser. */
    allowed_paths: stringList,
    forbidden_paths: stringList.default([]),
    acceptance_criteria: stringList.default([]),
    /** Exact backtick commands from `## Patikra`, byte for byte. */
    checks: stringList,
    stop: z.string().default(""),
    spec_refs: stringList.default([]),
    out_of_scope: stringList.default([]),
    /** Verbatim directive / unrecognized blocks, in document order. */
    elements: z.array(workerTaskIrElementSchema).default([]),
    /** Headings deliberately left out because the orchestrator, not the worker, decides them. */
    omitted_sections: stringList.default([]),
    /** sha256 of the raw task Markdown this IR was compiled from. */
    source_sha256: z.string().regex(/^[0-9a-f]{64}$/, "source_sha256 must be 64 lowercase hex characters"),
  })
  .passthrough();
export type WorkerTaskIr = z.infer<typeof workerTaskIrSchema>;
