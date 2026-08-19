// Context pack ir execution context zod schemos — gyvena PRIE klasterio (WBR E3: core/schema
// nemigruoja kaip failas). Behaviour etalon: AG_loop core/schema.ts context-pack +
// execution-context blokai (1:1).

import { z } from "zod";

const nonEmptyString = z.string().trim().min(1);
const stringList = z.array(nonEmptyString);

export const contextPackBudgetSchema = z
  .object({
    max_context_chars: z.number().int().positive().optional(),
    max_llm_calls: z.number().int().positive().optional(),
    browser: z.boolean().optional(),
    scraper: z.boolean().optional(),
    mcp: z.boolean().optional(),
  })
  .passthrough();

// Detail tier of one selected symbol (task 0023, cheapest first): `REF` = symbol/file/range
// reference only, `SIG` = the compact declaration head, `SRC` = the exact hash-verified
// source slice. Present only when the `symbol_slices` compression feature was on at assembly
// time — packs built without it stay byte-identical to the pre-0023 form.
export const contextPackSymbolTierSchema = z.enum(["REF", "SIG", "SRC"]);
export type ContextPackSymbolTier = z.infer<typeof contextPackSymbolTierSchema>;

// The exact source of one declaration, cut from the working tree and proven against the
// code index (source-slice.ts): `hash` is the full sha256 of the file the slice was verified
// against, so a consumer can re-check it never went stale.
export const contextPackSymbolSourceSchema = z
  .object({
    text: z.string(),
    hash: z.string().regex(/^[0-9a-f]{64}$/, "source hash must be a full lowercase sha256"),
    line: z.number().int().positive(),
    endLine: z.number().int().positive(),
  })
  .passthrough();

export const contextPackSymbolSchema = z
  .object({
    id: nonEmptyString,
    file: nonEmptyString,
    name: nonEmptyString,
    line: z.number().int().positive().optional(),
    endLine: z.number().int().positive().optional(),
    // Compact declaration head from the code index (code-index 2.1.0), when the AST
    // indexer captured one. This is what the SIG tier renders.
    signature: nonEmptyString.optional(),
    exported: z.boolean().default(false),
    reason: z.enum(["exported", "public", "used", "tested", "declared"]),
    // Relation to the task's edit targets (task 0023): `target` = declared in a file the
    // task edits, `contract` = a declaration those files reference. Optional so packs
    // assembled before 0023 stay schema-valid.
    role: z.enum(["target", "contract"]).optional(),
    tier: contextPackSymbolTierSchema.optional(),
    source: contextPackSymbolSourceSchema.optional(),
  })
  .passthrough();

// Code-graph slice of a context pack. Assembled by assemble.ts and consumed by the
// execution-context renderer. Still `.passthrough()`: packs carrying extra keys stay valid.
export const contextPackCodeContextSchema = z
  .object({
    enabled: z.boolean().default(false),
    related_files: stringList.default([]),
    impacted_tests: stringList.default([]),
    architecture_nodes: stringList.default([]),
    priority_order: stringList.default([]),
    summary: stringList.default([]),
    notes: stringList.default([]),
    // Symbol-level selection: the declarations the task actually edits, ranked by priority.
    symbol_fragments: z.array(contextPackSymbolSchema).default([]),
  })
  .passthrough();

export const contextPackSchema = z
  .object({
    task_id: nonEmptyString,
    phase: nonEmptyString,
    goal: nonEmptyString,
    allowed_paths: stringList,
    agents: stringList.default([]),
    spec_fragments: stringList.default([]),
    spec_fragment_warnings: stringList.default([]),
    // Acceptance criteria come from the task's `## Veiksmas` bullets, `stop_condition`
    // from `## Stop`. Both are carried in the pack so the execution context can state
    // "done" deterministically instead of re-parsing the task markdown downstream.
    acceptance_criteria: stringList.default([]),
    stop_condition: nonEmptyString.optional(),
    architecture_rules: stringList.default([]),
    checks: stringList.default([]),
    out_of_scope: stringList.default([]),
    code_context: contextPackCodeContextSchema.optional(),
    budget: contextPackBudgetSchema.optional(),
  })
  .passthrough();
export type ContextPack = z.infer<typeof contextPackSchema>;

// ---------------------------------------------------------------------------
// Execution context (spec ag-loop-optimization-v1, CTX-1..CTX-3)
//
// `context-pack.json` stays the machine artifact; `execution-context.md` is the short,
// prioritized document handed to the coding worker. This schema is the contract for the
// machine-readable side of that render.
// ---------------------------------------------------------------------------

// Bump only on a breaking change to the rendered layout or the element contract.
export const EXECUTION_CONTEXT_VERSION = 1;

// Ordered from most to least important. `critical` elements are never dropped: they are
// the task's goal, its definition of done, the hard edit boundary and the verification
// commands. Everything else is droppable, lowest priority first, to honour the char limit.
export const executionContextPrioritySchema = z.enum(["critical", "high", "medium", "low"]);
export type ExecutionContextPriority = z.infer<typeof executionContextPrioritySchema>;

export const executionContextSectionSchema = z.enum([
  "goal",
  "acceptance-criteria",
  "allowed-paths",
  "checks",
  "spec",
  "symbols",
  "contracts",
  "impacted-tests",
  "architecture",
  "out-of-scope",
]);
export type ExecutionContextSection = z.infer<typeof executionContextSectionSchema>;

export const executionContextElementSchema = z
  .object({
    id: nonEmptyString,
    section: executionContextSectionSchema,
    title: nonEmptyString,
    priority: executionContextPrioritySchema,
    // Why this element is in the worker's context at all (CTX-3).
    reason: nonEmptyString,
    // First 12 hex chars of sha256 over the element body: identifies the source content
    // independently of where it was rendered.
    source_hash: z.string().regex(/^[0-9a-f]{12}$/, "source_hash must be 12 lowercase hex characters"),
    // Size of the element body in characters (not of the rendered block, which also
    // carries the heading and the metadata line).
    estimated_chars: z.number().int().nonnegative(),
    body: z.string(),
  })
  .passthrough();
export type ExecutionContextElement = z.infer<typeof executionContextElementSchema>;

export const executionContextDroppedElementSchema = z
  .object({
    id: nonEmptyString,
    section: executionContextSectionSchema,
    priority: executionContextPrioritySchema,
    reason: nonEmptyString,
    estimated_chars: z.number().int().nonnegative(),
  })
  .passthrough();

export const executionContextSchema = z
  .object({
    version: z.number().int().positive(),
    task_id: nonEmptyString,
    phase: nonEmptyString,
    goal: nonEmptyString,
    // First 16 hex chars of sha256 over the kept elements' identity (id, section,
    // priority, source hash, size) plus task/phase/version/limit. Same pack + same limit
    // => same fingerprint => same rendered markdown.
    fingerprint: z.string().regex(/^[0-9a-f]{16}$/, "fingerprint must be 16 lowercase hex characters"),
    max_chars: z.number().int().positive(),
    rendered_chars: z.number().int().nonnegative(),
    elements: z.array(executionContextElementSchema).default([]),
    dropped: z.array(executionContextDroppedElementSchema).default([]),
  })
  .passthrough();
export type ExecutionContext = z.infer<typeof executionContextSchema>;
