// Deterministic execution-context renderer (spec ag-loop-optimization-v1, CTX-1..CTX-3).
// Behaviour etalon: AG_loop application/context-pack/render-execution-context.ts (1:1;
// schemos — context-pack-schema.ts prie klasterio, parseWithSchema — shared/schema).
//
// `context-pack.json` stays the machine artifact. This module turns one schema-valid pack
// into the short, prioritized `execution-context.md` handed to the coding worker. Pure: no
// clock, no randomness, no I/O — the same pack and the same char limit always produce a
// byte-identical document and the same fingerprint.

import { createHash } from "node:crypto";
import { parseWithSchema } from "../../shared/schema.js";
import {
  EXECUTION_CONTEXT_VERSION,
  executionContextSchema,
  type ContextPack,
  type ExecutionContext,
  type ExecutionContextElement,
  type ExecutionContextPriority,
  type ExecutionContextSection,
} from "./context-pack-schema.js";

export type RenderExecutionContextOptions = {
  // Hard upper bound for the rendered markdown, in characters. Defaults to the pack's
  // own `budget.max_context_chars`, falling back to DEFAULT_EXECUTION_CONTEXT_MAX_CHARS.
  maxChars?: number;
};

export type RenderedExecutionContext = {
  markdown: string;
  // Machine-readable side of the same render: kept elements with their metadata plus the
  // elements that had to be dropped to honour the char limit.
  context: ExecutionContext;
};

export const DEFAULT_EXECUTION_CONTEXT_MAX_CHARS = 12000;

// Placeholder of exactly the same width as a real fingerprint. The drop loop renders with
// it so that the measured length never depends on the fingerprint value — only on the set
// of kept elements — which keeps "fingerprint of the kept set" free of circularity.
const FINGERPRINT_PLACEHOLDER = "0".repeat(16);

// Droppable priorities, in the order they are given up. `critical` is absent on purpose:
// goal, acceptance criteria, allowed paths and checks are never dropped.
const DROP_ORDER: readonly ExecutionContextPriority[] = ["low", "medium", "high"];

type Candidate = {
  id: string;
  section: ExecutionContextSection;
  title: string;
  priority: ExecutionContextPriority;
  reason: string;
  body: string;
};

/**
 * Render one context pack into the worker-facing execution context.
 *
 * Element order is canonical (see `buildCandidates`) and independent of the pack's key
 * order. If the document exceeds the limit, droppable elements are removed lowest priority
 * first and, within one priority, from the end of the canonical order. Dropping is reported
 * both in the document header and, with per-element reasons, in `context.dropped`.
 *
 * @throws Error when the limit cannot be met even with every droppable element removed.
 * Failing loudly is deliberate: silently truncating the goal, the allowed-path edit
 * boundary or the checks would hand the worker an unsafe context.
 */
export function renderExecutionContext(
  pack: ContextPack,
  options: RenderExecutionContextOptions = {},
): RenderedExecutionContext {
  const maxChars = resolveMaxChars(pack, options);
  const candidates = buildCandidates(pack);

  const kept = [...candidates];
  const dropped: Candidate[] = [];
  for (const priority of DROP_ORDER) {
    if (renderDocument(pack, kept, dropped.length, maxChars, FINGERPRINT_PLACEHOLDER).length <= maxChars) {
      break;
    }
    for (let index = lastIndexOfPriority(kept, priority); index >= 0; index = lastIndexOfPriority(kept, priority)) {
      dropped.push(...kept.splice(index, 1));
      if (renderDocument(pack, kept, dropped.length, maxChars, FINGERPRINT_PLACEHOLDER).length <= maxChars) {
        break;
      }
    }
  }

  const elements = kept.map(toElement);
  const fingerprint = computeFingerprint(pack, elements, maxChars);
  const markdown = renderDocument(pack, kept, dropped.length, maxChars, fingerprint);
  if (markdown.length > maxChars) {
    throw new Error(
      `execution context exceeds max_chars ${markdown.length} > ${maxChars} with only non-droppable elements left ` +
        `(goal, acceptance criteria, allowed paths, checks); raise the context budget for task ${pack.task_id}`,
    );
  }

  const context = parseWithSchema(
    executionContextSchema,
    {
      version: EXECUTION_CONTEXT_VERSION,
      task_id: pack.task_id,
      phase: pack.phase,
      goal: pack.goal,
      fingerprint,
      max_chars: maxChars,
      rendered_chars: markdown.length,
      elements,
      dropped: dropped.map((candidate) => ({
        id: candidate.id,
        section: candidate.section,
        priority: candidate.priority,
        reason: candidate.reason,
        estimated_chars: candidate.body.length,
      })),
    },
    "execution-context",
  );

  return { markdown, context };
}

function resolveMaxChars(pack: ContextPack, options: RenderExecutionContextOptions): number {
  const requested = options.maxChars ?? pack.budget?.max_context_chars ?? DEFAULT_EXECUTION_CONTEXT_MAX_CHARS;
  if (!Number.isInteger(requested) || requested <= 0) {
    throw new Error(`execution context max_chars must be a positive integer, received ${String(requested)}`);
  }
  return requested;
}

// Canonical element order. Every section is derived from exactly one pack field, so two
// packs with the same content always produce the same element list in the same order.
function buildCandidates(pack: ContextPack): Candidate[] {
  const candidates: Candidate[] = [];

  candidates.push({
    id: "goal",
    section: "goal",
    title: "Goal",
    priority: "critical",
    reason: "the single outcome this dispatch must achieve",
    body: pack.goal,
  });

  const acceptance = [
    ...pack.acceptance_criteria.map((criterion) => `- ${criterion}`),
    ...(pack.stop_condition ? [`- Stop condition: ${collapseWhitespace(pack.stop_condition)}`] : []),
  ];
  pushIfPresent(candidates, {
    id: "acceptance-criteria",
    section: "acceptance-criteria",
    title: "Acceptance criteria",
    priority: "critical",
    reason: "the task's own definition of done; the work is not complete until every item holds",
    body: acceptance.join("\n"),
  });

  pushIfPresent(candidates, {
    id: "allowed-paths",
    section: "allowed-paths",
    title: "Allowed paths",
    priority: "critical",
    reason: "hard edit boundary: no file outside this list may be created, changed or deleted",
    body: pack.allowed_paths.map((entry) => `- \`${entry}\``).join("\n"),
  });

  pushIfPresent(candidates, {
    id: "checks",
    section: "checks",
    title: "Checks",
    priority: "critical",
    reason: "deterministic verification commands that must pass before the task is reported done",
    body: pack.checks.map((check) => `- \`${check}\``).join("\n"),
  });

  pack.spec_fragments.forEach((fragment, index) => {
    const { ref, text } = splitSpecFragment(fragment);
    pushIfPresent(candidates, {
      id: `spec-${index + 1}`,
      section: "spec",
      title: `Spec fragment: ${ref}`,
      priority: "high",
      reason: `retrieved from \`## Spec source\` reference ${index + 1} of ${pack.spec_fragments.length}`,
      body: text,
    });
  });

  pushIfPresent(candidates, {
    id: "spec-warnings",
    section: "spec",
    title: "Spec retrieval warnings",
    priority: "medium",
    reason: "a spec reference did not resolve exactly; the fragment above may be broader than requested",
    body: pack.spec_fragment_warnings.map((warning) => `- ${warning}`).join("\n"),
  });

  const codeContext = pack.code_context;
  pushIfPresent(candidates, {
    id: "symbols",
    section: "symbols",
    title: "Symbols",
    priority: "high",
    reason: "declarations and exported symbols of the files this task edits, from the code index",
    body: (codeContext?.summary ?? []).join("\n"),
  });

  pushIfPresent(candidates, {
    id: "contracts",
    section: "contracts",
    title: "Contracts and direct dependencies",
    priority: "high",
    reason: "files directly importing or imported by the allowed paths; their public contracts must keep working",
    body: (codeContext?.related_files ?? []).map((file) => `- \`${file}\``).join("\n"),
  });

  // REF/SIG/SRC tiers (task 0023). Symbols carry a tier only when the pack was assembled
  // with the `symbol_slices` compression feature on; a pack without tiers renders exactly
  // the pre-0023 document, byte for byte. REF needs no candidate of its own — the summary
  // above already names every kept symbol with its file and line range.
  //
  // Placement inside the `high` band is deliberate: droppables leave from the END of the
  // canonical order within one priority, so when the budget tightens the SRC blocks go
  // first, then the SIG lines — never the spec fragments or the symbol map before them.
  const tieredSymbols = (codeContext?.symbol_fragments ?? []).filter((symbol) => symbol.tier !== undefined);

  pushIfPresent(candidates, {
    id: "signatures",
    section: "symbols",
    title: "Symbol signatures",
    priority: "high",
    reason: "declaration heads (tier SIG): enough to call these symbols correctly without reading their bodies",
    body: tieredSymbols
      .filter((symbol) => symbol.tier === "SIG" && symbol.signature !== undefined)
      .map((symbol) => `- \`${symbolRef(symbol)}\` — \`${symbol.signature}\``)
      .join("\n"),
  });

  tieredSymbols
    .filter((symbol) => symbol.tier === "SRC" && symbol.source !== undefined)
    .forEach((symbol, index) => {
      const source = symbol.source;
      if (!source) {
        return;
      }
      pushIfPresent(candidates, {
        id: `src-${index + 1}`,
        section: "symbols",
        title: `Target source: ${symbol.file}#${symbol.name}`,
        priority: "high",
        reason: "exact, hash-verified source of a declaration this task edits (tier SRC); edit this, do not re-read the file",
        body: [
          `\`${symbol.file}:${source.line}-${source.endLine}\` (sha256:${source.hash.slice(0, 12)})`,
          "",
          "```",
          source.text,
          "```",
        ].join("\n"),
      });
    });

  pushIfPresent(candidates, {
    id: "impacted-tests",
    section: "impacted-tests",
    title: "Impacted tests",
    priority: "medium",
    reason: "existing tests that cover the allowed paths and must stay green",
    body: (codeContext?.impacted_tests ?? []).map((file) => `- \`${file}\``).join("\n"),
  });

  pushIfPresent(candidates, {
    id: "architecture-nodes",
    section: "architecture",
    title: "Architecture nodes",
    priority: "medium",
    reason: "architecture-graph nodes owning the allowed paths; the change must stay inside them",
    body: (codeContext?.architecture_nodes ?? []).map((node) => `- ${node}`).join("\n"),
  });

  pushIfPresent(candidates, {
    id: "architecture-rules",
    section: "architecture",
    title: "Architecture boundaries",
    priority: "medium",
    reason: "boundary rules that constrain this change",
    body: pack.architecture_rules.map((rule) => `- ${rule}`).join("\n"),
  });

  pushIfPresent(candidates, {
    id: "out-of-scope",
    section: "out-of-scope",
    title: "Out of scope",
    priority: "low",
    reason: "explicit non-goals declared by the task",
    body: pack.out_of_scope.map((entry) => `- ${entry}`).join("\n"),
  });

  return candidates;
}

function pushIfPresent(candidates: Candidate[], candidate: Candidate): void {
  if (candidate.body.trim().length > 0) {
    candidates.push(candidate);
  }
}

// Spec fragments are stored in the pack as `${ref}\n${text}` (see assemble.ts). A fragment
// without a body still yields a usable ref-only element.
function splitSpecFragment(fragment: string): { ref: string; text: string } {
  const newline = fragment.indexOf("\n");
  if (newline === -1) {
    return { ref: fragment.trim(), text: fragment.trim() };
  }
  return { ref: fragment.slice(0, newline).trim(), text: fragment.slice(newline + 1).trim() };
}

function collapseWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

// `file#name:line-endLine` — the compact symbol reference used by the SIG tier. The range
// is omitted when the index carries no line information for that symbol.
function symbolRef(symbol: {
  file: string;
  name: string;
  line?: number | undefined;
  endLine?: number | undefined;
}): string {
  const range = symbol.line === undefined ? "" : `:${symbol.line}-${symbol.endLine ?? symbol.line}`;
  return `${symbol.file}#${symbol.name}${range}`;
}

function lastIndexOfPriority(candidates: Candidate[], priority: ExecutionContextPriority): number {
  for (let index = candidates.length - 1; index >= 0; index -= 1) {
    if (candidates[index]?.priority === priority) {
      return index;
    }
  }
  return -1;
}

function toElement(candidate: Candidate): ExecutionContextElement {
  return {
    id: candidate.id,
    section: candidate.section,
    title: candidate.title,
    priority: candidate.priority,
    reason: candidate.reason,
    source_hash: sourceHash(candidate),
    estimated_chars: candidate.body.length,
    body: candidate.body,
  };
}

function sourceHash(candidate: Candidate): string {
  return sha256Hex(candidate.body).slice(0, 12);
}

// The fingerprint covers element identity and size, not the rendered layout, so it stays
// stable across cosmetic changes to the markdown while still changing whenever the
// contents, the order, the priorities or the applied limit change.
function computeFingerprint(pack: ContextPack, elements: ExecutionContextElement[], maxChars: number): string {
  const identity = JSON.stringify({
    version: EXECUTION_CONTEXT_VERSION,
    task_id: pack.task_id,
    phase: pack.phase,
    max_chars: maxChars,
    elements: elements.map((element) => [
      element.id,
      element.section,
      element.priority,
      element.source_hash,
      element.estimated_chars,
    ]),
  });
  return sha256Hex(identity).slice(0, 16);
}

function sha256Hex(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

// Header fields are all derived from the kept/dropped sets or from inputs — never from the
// document's own length — so rendering converges: every drop strictly shrinks the result.
function renderDocument(
  pack: ContextPack,
  kept: Candidate[],
  droppedCount: number,
  maxChars: number,
  fingerprint: string,
): string {
  const header = [
    "# Execution context",
    "",
    `- task: ${pack.task_id}`,
    `- phase: ${pack.phase}`,
    `- context_version: ${EXECUTION_CONTEXT_VERSION}`,
    `- fingerprint: \`${fingerprint}\``,
    `- char_limit: ${maxChars}`,
    `- elements: ${kept.length} kept, ${droppedCount} dropped (lowest priority first)`,
  ].join("\n");

  return [header, ...kept.map(renderBlock)].join("\n\n") + "\n";
}

function renderBlock(candidate: Candidate): string {
  const meta = [
    `priority: ${candidate.priority}`,
    `reason: ${candidate.reason}`,
    `source: sha256:${sourceHash(candidate)}`,
    `chars: ${candidate.body.length}`,
  ].join(" | ");
  return `## ${candidate.title}\n\n> ${meta}\n\n${candidate.body}`;
}
