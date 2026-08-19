// Compact worker DSL renderavimas: dedup → alias planas → dokumentas → round-trip parity
// įrodymas. Aliases must pay for themselves; as a backstop the whole document is rendered
// both ways and the shorter one wins. Behaviour etalon: AG_loop application/context-pack/
// compact-worker-dsl.ts (render pusė; WBR VQ-302 skaidymas).

import {
  isContextCompressionFeatureEnabledForTask,
} from "../../../domain/policies/compression/canary.js";
import type { ContextCompressionConfig } from "../../../domain/policies/compression/features.js";
import { WORKER_TASK_IR_VERSION, type WorkerTaskIr } from "../worker-task-ir-schema.js";
import { workerTaskIrChars } from "../worker-task-ir.js";
import {
  ALIAS_PATH_NAMESPACE,
  ALIAS_SYMBOL_NAMESPACE,
  COMPACT_WORKER_DSL_MAGIC,
  COMPACT_WORKER_DSL_VERSION,
  deduplicateIrLists,
  MARKER_ACCEPTANCE,
  MARKER_ALLOWED,
  MARKER_CHECK,
  MARKER_ELEMENT,
  MARKER_FORBIDDEN,
  MARKER_GOAL,
  MARKER_IR_VERSION,
  MARKER_OMITTED,
  MARKER_OUT_OF_SCOPE,
  MARKER_SOURCE_HASH,
  MARKER_SPEC_REF,
  MARKER_STOP,
  MARKER_TASK_ID,
  type CompactDslAlias,
  type CompactWorkerDsl,
  type DeduplicatedLists,
} from "./model.js";
import { compactWorkerDslParity } from "./parity.js";

/**
 * Renders one IR into the compact DSL.
 *
 * Pure: no clock, no randomness, no I/O, no environment reads. The same IR always yields a
 * byte-identical document.
 *
 * @throws Error when the IR was produced by a different WorkerTaskIR contract version, or when
 * the rendered document does not decode back into the IR it came from. A bumped IR version means
 * fields this renderer has never seen, and `.passthrough()` would let them vanish silently;
 * shipping a prompt that quietly lost a check command or an edit boundary is worse than failing
 * the dispatch, so both cases stop here instead of degrading.
 */
export function renderCompactWorkerDsl(ir: WorkerTaskIr): CompactWorkerDsl {
  if (ir.version !== WORKER_TASK_IR_VERSION) {
    throw new Error(
      `compact worker DSL renders WorkerTaskIR v${WORKER_TASK_IR_VERSION}, got v${ir.version} for task ${ir.task_id}; ` +
        "update the renderer for the new IR contract before using it",
    );
  }

  const lists = deduplicateIrLists(ir);
  const plan = planAliases(aliasEligibleValues(lists));

  const withAliases = renderDocument(ir, lists, plan);
  const withoutAliases = renderDocument(ir, lists, emptyAliasPlan());
  // Strictly shorter, or no aliases at all: a tie is spent on the simpler document.
  const aliased = withAliases.length < withoutAliases.length;

  const dsl: CompactWorkerDsl = {
    version: COMPACT_WORKER_DSL_VERSION,
    text: aliased ? withAliases : withoutAliases,
    aliases: aliased ? plan.aliases : [],
    removed_duplicates: lists.removed,
    stats: {
      ir_chars: workerTaskIrChars(ir),
      dsl_chars: aliased ? withAliases.length : withoutAliases.length,
      dsl_chars_without_aliases: withoutAliases.length,
      alias_count: aliased ? plan.aliases.length : 0,
      alias_saved_chars: aliased ? withoutAliases.length - withAliases.length : 0,
      duplicates_removed: lists.removed.length,
    },
  };

  const parity = compactWorkerDslParity(ir, dsl);
  if (!parity.ok) {
    throw new Error(`compact worker DSL lost content for task ${ir.task_id}: ${parity.differences.join("; ")}`);
  }
  return dsl;
}

/**
 * Renders only when the `compact_dsl` compression flag is on for THIS task.
 *
 * The flag defaults to `false`, so on every call site that goes through this function the
 * compact DSL is inert until an operator turns it on — the renderer cannot reach a production
 * prompt by accident. `"canary"` (task 0031) narrows that to the deterministic cohort the
 * IR's own `task_id` falls into.
 */
export function renderCompactWorkerDslWhenEnabled(
  config: ContextCompressionConfig,
  ir: WorkerTaskIr,
): CompactWorkerDsl | undefined {
  return isContextCompressionFeatureEnabledForTask(config, "compact_dsl", ir.task_id)
    ? renderCompactWorkerDsl(ir)
    : undefined;
}

// --- Alias planning ----------------------------------------------------------------------

type AliasPlan = {
  aliases: CompactDslAlias[];
  /** Alias-eligible value -> its rendered form (`{F1}` + remainder). */
  rendered: Map<string, string>;
};

/** A fresh empty plan per call: no shared mutable module state between renders. */
function emptyAliasPlan(): AliasPlan {
  return { aliases: [], rendered: new Map() };
}

/**
 * Which values may be replaced by an alias: whole path-valued list items only.
 *
 * Deliberately narrow. Commands (`V`), the goal, the stop condition, acceptance prose and every
 * `RAW` body are excluded, because there an alias would rewrite the inside of text a worker is
 * meant to copy or follow byte for byte. Here the alias substitutes a whole value whose exact
 * bytes are still written once, in the dictionary.
 */
function aliasEligibleValues(lists: DeduplicatedLists): string[] {
  return [...lists.allowed_paths, ...lists.forbidden_paths, ...lists.spec_refs];
}

/**
 * Chooses the alias dictionary.
 *
 * Candidates are every directory prefix (any prefix ending in `/`) and every whole value.
 * Each round scores the candidates with the exact character ledger below, adopts the single
 * best one when it is profitable, and repeats over the values that are still unaliased:
 *
 *   saved = uses * (len(target) - len("{Fn}")) - (len("{Fn}") + 1 + len(target) + 1)
 *
 * A value used once can therefore never be aliased: one usage saves less than writing the
 * definition costs. Ties are broken by the longer target, then lexicographically, so the
 * dictionary is a pure function of the values.
 */
function planAliases(values: readonly string[]): AliasPlan {
  const pending = new Map<string, number>();
  for (const value of values) {
    pending.set(value, (pending.get(value) ?? 0) + 1);
  }

  const plan = emptyAliasPlan();
  const counters = new Map<string, number>([
    [ALIAS_PATH_NAMESPACE, 0],
    [ALIAS_SYMBOL_NAMESPACE, 0],
  ]);

  for (;;) {
    const best = bestAliasCandidate(pending, counters);
    if (!best) {
      break;
    }

    const namespace = aliasNamespace(best.target);
    const next = (counters.get(namespace) ?? 0) + 1;
    counters.set(namespace, next);
    const name = `${namespace}${next}`;

    for (const value of [...pending.keys()]) {
      if (!value.startsWith(best.target)) continue;
      plan.rendered.set(value, `{${name}}${value.slice(best.target.length)}`);
      pending.delete(value);
    }

    plan.aliases.push({ name, value: best.target, uses: best.uses, saved_chars: best.saved });
  }

  return plan;
}

type AliasCandidate = { target: string; uses: number; saved: number };

function bestAliasCandidate(
  pending: ReadonlyMap<string, number>,
  counters: ReadonlyMap<string, number>,
): AliasCandidate | undefined {
  // A dictionary entry is one physical line, so a target may never contain a newline: it would
  // split the definition in two and the orphan half would be read as a marker line. Candidate
  // generation therefore stops at the first newline of a value, and a multi-line value is only
  // ever an alias USER (its remainder keeps the block form), never an alias target.
  const targets = new Set<string>();
  for (const value of pending.keys()) {
    if (!value.includes("\n")) {
      targets.add(value);
    }
    for (let index = 0; index < value.length; index += 1) {
      if (value[index] === "\n") break;
      if (value[index] === "/") {
        targets.add(value.slice(0, index + 1));
      }
    }
  }

  let best: AliasCandidate | undefined;
  for (const target of [...targets].sort(compareAliasTargets)) {
    const nameLength = `{${aliasNamespace(target)}${(counters.get(aliasNamespace(target)) ?? 0) + 1}}`.length;
    let uses = 0;
    for (const [value, count] of pending) {
      if (value.startsWith(target)) {
        uses += count;
      }
    }
    // definition line: `{Fn}` + `=` + target + newline
    const saved = uses * (target.length - nameLength) - (nameLength + 1 + target.length + 1);
    if (saved <= 0) continue;
    if (!best || saved > best.saved) {
      best = { target, uses, saved };
    }
  }
  return best;
}

/** Longest target first, then lexicographic — a total order, so ties never depend on Set order. */
function compareAliasTargets(left: string, right: string): number {
  if (left.length !== right.length) return right.length - left.length;
  return left < right ? -1 : left > right ? 1 : 0;
}

function aliasNamespace(target: string): string {
  return target.includes("/") ? ALIAS_PATH_NAMESPACE : ALIAS_SYMBOL_NAMESPACE;
}

// --- Rendering ---------------------------------------------------------------------------

function renderDocument(ir: WorkerTaskIr, lists: DeduplicatedLists, plan: AliasPlan): string {
  const lines: string[] = [COMPACT_WORKER_DSL_MAGIC];

  lines.push(`${MARKER_IR_VERSION} ${ir.version}`);
  lines.push(`${MARKER_TASK_ID} ${ir.task_id}`);
  lines.push(`${MARKER_SOURCE_HASH} ${ir.source_sha256}`);
  for (const alias of plan.aliases) {
    lines.push(`{${alias.name}}=${alias.value}`);
  }

  pushValue(lines, MARKER_GOAL, ir.goal);
  pushList(lines, MARKER_ALLOWED, lists.allowed_paths, plan);
  pushList(lines, MARKER_FORBIDDEN, lists.forbidden_paths, plan);
  pushList(lines, MARKER_ACCEPTANCE, lists.acceptance_criteria);
  pushList(lines, MARKER_CHECK, lists.checks);
  pushList(lines, MARKER_SPEC_REF, lists.spec_refs, plan);
  pushList(lines, MARKER_OUT_OF_SCOPE, lists.out_of_scope);
  pushValue(lines, MARKER_STOP, ir.stop);

  // Both halves are counted lines, so a heading is framed exactly like a body: nothing about a
  // verbatim block depends on its content staying inside one line.
  for (const element of ir.elements ?? []) {
    const heading = element.heading === "" ? [] : element.heading.split("\n");
    const body = element.body.split("\n");
    lines.push(`${MARKER_ELEMENT}#${heading.length}.${body.length} ${element.kind}`);
    lines.push(...heading, ...body);
  }

  pushList(lines, MARKER_OMITTED, lists.omitted_sections);

  return `${lines.join("\n")}\n`;
}

/** Inline when single-line, block when not. Empty values are simply absent. */
function pushValue(lines: string[], marker: string, value: string): void {
  if (!value) return;
  if (!value.includes("\n")) {
    lines.push(`${marker} ${value}`);
    return;
  }
  const body = value.split("\n");
  lines.push(`${marker}#${body.length}`);
  lines.push(...body);
}

// Aliasing happens before line shaping, not instead of it: even the (practically impossible)
// multi-line path then keeps one consistent encoding, and the decoder expands the alias the
// same way in both forms.
function pushList(lines: string[], marker: string, items: readonly string[], plan?: AliasPlan): void {
  for (const item of items) {
    pushValue(lines, marker, plan ? plan.rendered.get(item) ?? escapeAliasable(item) : item);
  }
}

/**
 * A literal value starting with `{` is written `{{…` so the decoder cannot read it as an alias
 * reference. Only alias-eligible fields need this; everywhere else `{` is just a character.
 */
function escapeAliasable(value: string): string {
  return value.startsWith("{") ? `{${value}` : value;
}
