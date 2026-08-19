// WorkerTaskIR compiler (task 0021). Behaviour etalon: AG_loop application/context-pack/
// worker-task-ir.ts (1:1; schema — worker-task-ir-schema.ts prie modulio).
//
// One canonical task Markdown in, one deterministic {@link WorkerTaskIr} out. The point of
// the IR is to separate the two audiences a task file currently serves at once:
//
//   * the WORKER, which needs the goal, the exact edit boundary, the acceptance criteria,
//     the exact check commands, the stop condition and any task-specific directive;
//   * the ORCHESTRATOR, which owns dependencies, the agent chain and queue/retry/lifecycle
//     state — decisions a worker must not re-litigate and does not need to read.
//
// Three rules make the compilation safe to trust:
//
//   1. NO SUMMARIZATION. Every field is either copied verbatim or produced by an existing
//      canonical parser (`domain/tasks/allowed-paths.ts`, `shared/markdown`,
//      `parseBacktickChecks`). No LLM, no clock, no FS, no repository access — the same
//      input always compiles to the same output.
//   2. NO SILENT LOSS. A heading this module does not recognize becomes a verbatim `raw`
//      element. A recognized section whose structured parse did not account for every line
//      ALSO keeps its full body as a verbatim element, so prose smuggled into a bullet list
//      cannot vanish. Only the explicitly orchestrator-owned headings are dropped, and
//      their names are recorded in `omitted_sections`.
//   3. FAIL CLOSED. Missing goal / allowed paths / checks, or a duplicated mapped heading
//      (which would make "the" goal ambiguous), returns an error instead of a lossy IR.
//      Callers fall back to the raw task, which remains the source of truth on disk.

import {
  allowedPaths,
  enumerateTaskSections,
  forbiddenPaths,
  isScopeMarkerLine,
  parseAllowedPaths,
  taskBulletItems,
  type TaskSection,
} from "../../domain/tasks/index.js";
import { splitLines, stripBulletPrefix } from "../../shared/markdown.js";
import { err, ok, type Result } from "../../shared/result.js";
import {
  WORKER_TASK_IR_VERSION,
  workerTaskIrSchema,
  type WorkerTaskIr,
  type WorkerTaskIrElement,
} from "./worker-task-ir-schema.js";
import { parseBacktickChecks } from "../quality-gates/preflight-rules.js";
import { contextArtifactSha256 } from "./execution-context-fingerprint.js";

/** Normalized heading keys (see `normalizeTaskHeading`) the compiler maps to typed fields. */
const SECTION_GOAL = "tikslas";
const SECTION_FILES = "failai";
const SECTION_ACTIONS = "veiksmas";
const SECTION_CHECKS = "patikra";
const SECTION_STOP = "stop";
const SECTION_OUT_OF_SCOPE = "neitraukta";
const SECTION_SPEC_SOURCE = "spec source";

const MAPPED_SECTIONS: ReadonlySet<string> = new Set([
  SECTION_GOAL,
  SECTION_FILES,
  SECTION_ACTIONS,
  SECTION_CHECKS,
  SECTION_STOP,
  SECTION_OUT_OF_SCOPE,
  SECTION_SPEC_SOURCE,
]);

/**
 * Headings whose decision belongs to the orchestrator, not the worker: the dependency
 * graph, the agent chain, scheduling priority and queue/review lifecycle state. These are
 * the ONLY headings that may leave the IR, and they are matched exactly — a decorated
 * variant ("## Būsena — DARBAS PADARYTAS (2026-08-05)") does not match and is therefore
 * preserved, because "looks like status metadata" is a guess and guessing is how content
 * gets lost.
 */
const ORCHESTRATOR_SECTIONS: ReadonlySet<string> = new Set([
  "dependencies",
  "agentai",
  "agentas",
  "priority",
  "human review block",
  "busena",
]);

/**
 * Prefixes of headings that are worker instruction blocks. Matched by prefix because these
 * headings carry free-form suffixes ("## Sandbox taisyklės (privaloma — taupo turns)").
 * A miss here is harmless: the section still survives verbatim, just labelled `raw`.
 */
const DIRECTIVE_HEADING_PREFIXES: readonly string[] = ["zingsnis 0", "sandbox taisykles"];

export type WorkerTaskIrErrorCode =
  | "missing_task_id"
  | "missing_goal"
  | "missing_allowed_paths"
  | "missing_checks"
  | "duplicate_section";

export type WorkerTaskIrError = {
  code: WorkerTaskIrErrorCode;
  message: string;
};

export type CompileWorkerTaskIrInput = {
  /** Canonical task Markdown, exactly as stored on disk. */
  taskMarkdown: string;
  /** Task identity from the queue (file name), not re-derived from the text. */
  taskId: string;
};

/**
 * Compiles a canonical task into its worker IR, or explains why it cannot.
 *
 * Deterministic and side-effect free: safe to run in shadow mode on every dispatch.
 */
export function compileWorkerTaskIr(input: CompileWorkerTaskIrInput): Result<WorkerTaskIr, WorkerTaskIrError> {
  const taskMarkdown = input.taskMarkdown ?? "";
  const taskId = (input.taskId ?? "").trim();
  if (!taskId) {
    return err({ code: "missing_task_id", message: "worker task IR requires a task id" });
  }

  const sections = enumerateTaskSections(taskMarkdown);

  const duplicate = firstDuplicateMappedSection(sections);
  if (duplicate) {
    return err({
      code: "duplicate_section",
      message: `task declares "${duplicate}" more than once; which one binds the worker is ambiguous`,
    });
  }

  const goal = bodyOf(sections, SECTION_GOAL);
  if (!goal) {
    return err({ code: "missing_goal", message: "task has no non-empty `## Tikslas` section" });
  }

  const parsedAllowed = parseAllowedPaths(taskMarkdown);
  if (!parsedAllowed.ok) {
    return err({ code: "missing_allowed_paths", message: parsedAllowed.error.message });
  }

  const checks = parseBacktickChecks(taskMarkdown);
  if (checks.length === 0) {
    return err({
      code: "missing_checks",
      message: "task has no backtick commands in `## Patikra`; verification would be undefined",
    });
  }

  const allowed = allowedPaths(taskMarkdown);
  const forbidden = forbiddenPaths(taskMarkdown);
  const acceptanceCriteria = taskBulletItems(bodyOf(sections, SECTION_ACTIONS));
  const outOfScope = taskBulletItems(bodyOf(sections, SECTION_OUT_OF_SCOPE));
  const specRefs = nonEmptyLines(bodyOf(sections, SECTION_SPEC_SOURCE));

  // What each mapped section's structured parse actually consumed. Anything a section
  // still holds beyond this is re-attached verbatim below.
  const consumed = new Map<string, readonly string[]>([
    [SECTION_FILES, [...allowed, ...forbidden]],
    [SECTION_ACTIONS, acceptanceCriteria],
    [SECTION_CHECKS, checks],
    [SECTION_OUT_OF_SCOPE, outOfScope],
    [SECTION_SPEC_SOURCE, specRefs],
  ]);

  const elements: WorkerTaskIrElement[] = [];
  const omittedSections: string[] = [];

  for (const section of sections) {
    if (ORCHESTRATOR_SECTIONS.has(section.key)) {
      omittedSections.push(section.heading);
      continue;
    }
    if (MAPPED_SECTIONS.has(section.key)) {
      // The goal and the stop condition are carried whole, so only the list-shaped
      // sections can leave anything behind.
      const captured = consumed.get(section.key);
      if (captured && hasUnconsumedContent(section.body, captured)) {
        elements.push({ heading: section.heading, kind: "raw", body: section.body });
      }
      continue;
    }
    if (!section.body) {
      // An empty unrecognized heading carries no worker information to lose.
      continue;
    }
    elements.push({
      heading: section.heading,
      kind: isDirectiveHeading(section.key) ? "directive" : "raw",
      body: section.body,
    });
  }

  return ok(
    workerTaskIrSchema.parse({
      version: WORKER_TASK_IR_VERSION,
      task_id: taskId,
      goal,
      allowed_paths: allowed,
      forbidden_paths: forbidden,
      acceptance_criteria: acceptanceCriteria,
      checks,
      stop: bodyOf(sections, SECTION_STOP),
      spec_refs: specRefs,
      out_of_scope: outOfScope,
      elements,
      omitted_sections: omittedSections,
      source_sha256: contextArtifactSha256(taskMarkdown),
    }),
  );
}

/** Encoded size of an IR, for A/B measurement against the raw task it was compiled from. */
export function workerTaskIrChars(ir: WorkerTaskIr): number {
  return JSON.stringify(ir).length;
}

function bodyOf(sections: readonly TaskSection[], key: string): string {
  return sections.find((section) => section.key === key)?.body.trim() ?? "";
}

function nonEmptyLines(body: string): string[] {
  return splitLines(body)
    .map((line) => line.trim())
    .filter(Boolean);
}

function firstDuplicateMappedSection(sections: readonly TaskSection[]): string | undefined {
  const seen = new Set<string>();
  for (const section of sections) {
    if (!MAPPED_SECTIONS.has(section.key)) continue;
    if (seen.has(section.key)) return section.heading;
    seen.add(section.key);
  }
  return undefined;
}

/**
 * True when a section body holds a line whose residue — after stripping the canonical
 * bullet prefix, the `Leidžiama:`/`Draudžiama:` marker, and every captured item's own text
 * together with its backtick wrapper — still leaves non-blank text behind. That residue is
 * exactly what a structured parse would silently drop, so a line only counts as consumed
 * once nothing significant remains of it, never merely because some item's text turns up
 * somewhere on the line (the old `line.includes(item)` reading treated a single unrelated
 * substring match as proof the whole line was accounted for, which is fail-open).
 */
function hasUnconsumedContent(body: string, captured: readonly string[]): boolean {
  const items = captured.map((item) => item.trim()).filter(Boolean);
  return splitLines(body).some((line) => lineHasResidue(line, items));
}

/** Canonical bullet/marker/item stripping for a single line; see `hasUnconsumedContent`. */
function lineHasResidue(line: string, items: readonly string[]): boolean {
  if (!line.trim() || isScopeMarkerLine(line)) return false;
  let residual = stripBulletPrefix(line);
  for (const item of items) {
    residual = residual.split(`\`${item}\``).join("").split(item).join("");
  }
  return residual.replace(/[`,]/g, "").trim().length > 0;
}

function isDirectiveHeading(key: string): boolean {
  return DIRECTIVE_HEADING_PREFIXES.some((prefix) => key.startsWith(prefix));
}
