// Compact worker DSL (task 0024) — gramatika, tipai ir bendros dedup taisyklės.
// Behaviour etalon: AG_loop application/context-pack/compact-worker-dsl.ts (WBR VQ-302
// skaidymas į model/parse/parity/render — etalonas 830 eilučių viršija 500 ribą).
//
// The IR already decided WHAT a worker must be told; the DSL only decides how few
// characters that takes. Rules: NO SUMMARIZATION / NO SILENT LOSS / FAIL CLOSED
// (inherited from the IR), plus byte-exact structural deduplication and aliases that
// must pay for themselves. Protocol is ASCII; content keeps its exact bytes.
//
//   WTD1                         magic + grammar version
//   IRV <n>                      the WorkerTaskIR contract version this document was made from
//   T <task_id>                  identity
//   H <sha256>                   the raw task bytes this IR was compiled from
//   {F1}=<text>                  alias dictionary (only profitable aliases, in adoption order)
//   G <goal> | G#<n> + n lines   goal
//   E <allowed path>             hard edit boundary, one line per path
//   X <forbidden path>
//   A <acceptance criterion>
//   V <check command>            byte-exact, never aliased
//   R <spec reference>
//   N <non-goal>
//   S <stop> | S#<n> + n lines
//   RAW#<h>.<n> <kind>           verbatim element: h heading lines (0 when none), n body lines
//   O <omitted heading>          orchestrator-owned sections the IR deliberately left out
//
// Inline values never contain a newline (a multi-line value uses the `#<n>` block form);
// in the three alias-eligible fields a literal leading `{` is doubled.

import type { WorkerTaskIr, WorkerTaskIrElementKind } from "../worker-task-ir-schema.js";

/** Bump only on a breaking change to the DSL grammar; it is encoded in the magic line. */
export const COMPACT_WORKER_DSL_VERSION = 1;

/** First line of every document: `WTD1`. A decoder that does not know the version refuses. */
export const COMPACT_WORKER_DSL_MAGIC = `WTD${COMPACT_WORKER_DSL_VERSION}`;

export const MARKER_IR_VERSION = "IRV";
export const MARKER_TASK_ID = "T";
export const MARKER_SOURCE_HASH = "H";
export const MARKER_GOAL = "G";
export const MARKER_ALLOWED = "E";
export const MARKER_FORBIDDEN = "X";
export const MARKER_ACCEPTANCE = "A";
export const MARKER_CHECK = "V";
export const MARKER_SPEC_REF = "R";
export const MARKER_OUT_OF_SCOPE = "N";
export const MARKER_STOP = "S";
export const MARKER_ELEMENT = "RAW";
export const MARKER_OMITTED = "O";

/** Alias namespaces: `F` for path-shaped targets, `S` for everything else (symbols, ids). */
export const ALIAS_PATH_NAMESPACE = "F";
export const ALIAS_SYMBOL_NAMESPACE = "S";

export const ELEMENT_KINDS: ReadonlySet<string> = new Set<WorkerTaskIrElementKind>(["directive", "raw"]);

/** Markers that may appear at most once in a document. */
export const SCALAR_MARKERS: ReadonlySet<string> = new Set([
  MARKER_IR_VERSION,
  MARKER_TASK_ID,
  MARKER_SOURCE_HASH,
  MARKER_GOAL,
  MARKER_STOP,
]);

export type CompactDslAlias = {
  /** Dictionary name without braces, e.g. `F1`. */
  name: string;
  /** The exact text the alias stands for; expanding `{F1}` yields these bytes back. */
  value: string;
  /** How many still-unaliased values this alias claimed when it was adopted. */
  uses: number;
  /** Characters this alias was predicted to save, definition line already subtracted. */
  saved_chars: number;
};

export type CompactDslRemovedDuplicate = {
  /** IR field the duplicate was removed from, e.g. `allowed_paths`. */
  field: string;
  /** The removed item, verbatim. */
  value: string;
  /** The earlier item it duplicates, verbatim. */
  duplicate_of: string;
};

export type CompactWorkerDslStats = {
  /** JSON size of the IR this document was rendered from. */
  ir_chars: number;
  /** Size of the rendered document. */
  dsl_chars: number;
  /** Size of the same document rendered with no alias dictionary at all. */
  dsl_chars_without_aliases: number;
  alias_count: number;
  /** Measured `dsl_chars_without_aliases - dsl_chars`; zero when aliasing did not pay. */
  alias_saved_chars: number;
  duplicates_removed: number;
};

export type CompactWorkerDsl = {
  version: number;
  /** The rendered document. Deterministic: the same IR always produces these exact bytes. */
  text: string;
  aliases: readonly CompactDslAlias[];
  removed_duplicates: readonly CompactDslRemovedDuplicate[];
  stats: CompactWorkerDslStats;
};

/** The IR fields recovered from a document, after alias expansion. */
export type DecodedCompactWorkerDsl = {
  /** Grammar version of the document. */
  version: number;
  /** WorkerTaskIR contract version the document was rendered from. */
  ir_version: number;
  task_id: string;
  source_sha256: string;
  goal: string;
  allowed_paths: string[];
  forbidden_paths: string[];
  acceptance_criteria: string[];
  checks: string[];
  spec_refs: string[];
  out_of_scope: string[];
  stop: string;
  elements: Array<{ heading: string; kind: WorkerTaskIrElementKind; body: string }>;
  omitted_sections: string[];
};

export type CompactWorkerDslParseErrorCode =
  | "bad_magic"
  | "unknown_marker"
  | "malformed_line"
  | "truncated_block"
  | "unknown_alias"
  | "duplicate_alias"
  | "duplicate_field"
  | "missing_field";

export type CompactWorkerDslParseError = {
  code: CompactWorkerDslParseErrorCode;
  message: string;
  /** 1-based line number the decoder refused at, or 0 when the document as a whole is wrong. */
  line: number;
};

// --- Deduplication (shared by render and parity) -------------------------------------------

export type DeduplicatedLists = {
  allowed_paths: string[];
  forbidden_paths: string[];
  acceptance_criteria: string[];
  checks: string[];
  spec_refs: string[];
  out_of_scope: string[];
  omitted_sections: string[];
  removed: CompactDslRemovedDuplicate[];
};

export const LIST_FIELDS: ReadonlyArray<keyof Omit<DeduplicatedLists, "removed">> = [
  "allowed_paths",
  "forbidden_paths",
  "acceptance_criteria",
  "checks",
  "spec_refs",
  "out_of_scope",
  "omitted_sections",
];

/**
 * Collapses structurally identical items within each list field, keeping the FIRST spelling
 * verbatim and recording what was removed. Order is otherwise untouched, and no comparison
 * ever crosses a field boundary.
 */
export function deduplicateIrLists(ir: WorkerTaskIr): DeduplicatedLists {
  const lists: DeduplicatedLists = {
    allowed_paths: [],
    forbidden_paths: [],
    acceptance_criteria: [],
    checks: [],
    spec_refs: [],
    out_of_scope: [],
    omitted_sections: [],
    removed: [],
  };

  for (const field of LIST_FIELDS) {
    const seen = new Map<string, string>();
    for (const item of ir[field] ?? []) {
      const key = duplicateKey(item);
      const kept = seen.get(key);
      if (kept !== undefined) {
        lists.removed.push({ field, value: item, duplicate_of: kept });
        continue;
      }
      seen.set(key, item);
      lists[field].push(item);
    }
  }

  return lists;
}

/**
 * The single duplicate-key rule for every list field: byte equality after trimming
 * surrounding whitespace. No internal whitespace is collapsed — two strings that differ only
 * inside (a code literal, a regex, a re-wrapped sentence) are different strings, not the same
 * fact restated, so they never collapse into one item.
 */
export function duplicateKey(value: string): string {
  return value.trim();
}
