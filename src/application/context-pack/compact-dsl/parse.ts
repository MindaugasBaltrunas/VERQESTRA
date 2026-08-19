// Compact worker DSL dekodavimas — fails closed on anything it does not fully understand:
// an unknown marker, a block whose declared length runs past the end or has the wrong shape,
// an alias that was never defined, a scalar field stated twice. A decoder that guessed would
// turn a corrupted prompt into a plausible one. Behaviour etalon: AG_loop
// application/context-pack/compact-worker-dsl.ts (parse pusė; WBR VQ-302 skaidymas).

import { err, ok, type Result } from "../../../shared/result.js";
import type { WorkerTaskIrElementKind } from "../worker-task-ir-schema.js";
import {
  COMPACT_WORKER_DSL_MAGIC,
  COMPACT_WORKER_DSL_VERSION,
  ELEMENT_KINDS,
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
  SCALAR_MARKERS,
  type CompactWorkerDslParseError,
  type DecodedCompactWorkerDsl,
} from "./model.js";

/**
 * Decodes a document back into IR fields, expanding the alias dictionary.
 */
export function parseCompactWorkerDsl(text: string): Result<DecodedCompactWorkerDsl, CompactWorkerDslParseError> {
  // Split on "\n" only: a body line that genuinely ends in "\r" keeps it.
  const lines = text.split("\n");
  if (lines.at(-1) === "") {
    lines.pop();
  }
  if (lines.length === 0 || lines[0] !== COMPACT_WORKER_DSL_MAGIC) {
    return err({
      code: "bad_magic",
      message: `expected first line ${COMPACT_WORKER_DSL_MAGIC}, got ${JSON.stringify(lines[0] ?? "")}`,
      line: 1,
    });
  }

  const decoded: DecodedCompactWorkerDsl = {
    version: COMPACT_WORKER_DSL_VERSION,
    ir_version: 0,
    task_id: "",
    source_sha256: "",
    goal: "",
    allowed_paths: [],
    forbidden_paths: [],
    acceptance_criteria: [],
    checks: [],
    spec_refs: [],
    out_of_scope: [],
    stop: "",
    elements: [],
    omitted_sections: [],
  };
  const aliases = new Map<string, string>();
  // A scalar written twice would make "the" goal (or the edit boundary's source hash) ambiguous,
  // exactly like a duplicated heading does in the IR compiler. Refuse instead of last-wins.
  const seenScalars = new Set<string>();

  let index = 1;
  while (index < lines.length) {
    const raw = lines[index] ?? "";
    const lineNumber = index + 1;
    index += 1;

    if (raw.startsWith("{")) {
      const definition = /^\{([FS]\d+)\}=(.*)$/.exec(raw);
      if (!definition) {
        return err({ code: "malformed_line", message: `not an alias definition: ${raw}`, line: lineNumber });
      }
      const name = definition[1] ?? "";
      const value = definition[2] ?? "";
      if (aliases.has(name)) {
        return err({ code: "duplicate_alias", message: `alias {${name}} defined twice`, line: lineNumber });
      }
      aliases.set(name, value);
      continue;
    }

    const space = raw.indexOf(" ");
    const head = space === -1 ? raw : raw.slice(0, space);
    const rest = space === -1 ? "" : raw.slice(space + 1);
    const hash = head.indexOf("#");
    const marker = hash === -1 ? head : head.slice(0, hash);
    const countText = hash === -1 ? undefined : head.slice(hash + 1);

    // `#<n>` is one counted run of lines; `#<h>.<n>` is the two-run form only `RAW` uses.
    let blockLines: string[] | undefined;
    let counts: number[] = [];
    if (countText !== undefined) {
      const declared = /^(\d+)(?:\.(\d+))?$/.exec(countText);
      if (!declared) {
        return err({ code: "malformed_line", message: `block length is not a number: ${head}`, line: lineNumber });
      }
      counts = [Number(declared[1]), ...(declared[2] === undefined ? [] : [Number(declared[2])])];
      if (counts.length !== (marker === MARKER_ELEMENT ? 2 : 1)) {
        return err({
          code: "malformed_line",
          message: `block length ${countText} has the wrong shape for marker ${marker}`,
          line: lineNumber,
        });
      }
      const total = counts.reduce((sum, count) => sum + count, 0);
      if (index + total > lines.length) {
        return err({
          code: "truncated_block",
          message: `${marker} block declares ${total} lines but the document ends first`,
          line: lineNumber,
        });
      }
      blockLines = lines.slice(index, index + total);
      index += total;
    }
    const body = marker === MARKER_ELEMENT ? undefined : blockLines?.join("\n");

    if (SCALAR_MARKERS.has(marker)) {
      if (seenScalars.has(marker)) {
        return err({ code: "duplicate_field", message: `${marker} appears more than once`, line: lineNumber });
      }
      seenScalars.add(marker);
    }

    switch (marker) {
      case MARKER_IR_VERSION: {
        const value = body ?? rest;
        if (!/^[1-9]\d*$/.test(value)) {
          return err({
            code: "malformed_line",
            message: `${MARKER_IR_VERSION} must be a positive integer, got ${JSON.stringify(value)}`,
            line: lineNumber,
          });
        }
        decoded.ir_version = Number(value);
        break;
      }
      case MARKER_TASK_ID:
        decoded.task_id = body ?? rest;
        break;
      case MARKER_SOURCE_HASH:
        decoded.source_sha256 = body ?? rest;
        break;
      case MARKER_GOAL:
        decoded.goal = body ?? rest;
        break;
      case MARKER_STOP:
        decoded.stop = body ?? rest;
        break;
      case MARKER_ALLOWED:
      case MARKER_FORBIDDEN:
      case MARKER_SPEC_REF: {
        const expanded = expandAlias(body ?? rest, aliases);
        if (!expanded.ok) {
          return err({ ...expanded.error, line: lineNumber });
        }
        listOf(decoded, marker).push(expanded.value);
        break;
      }
      case MARKER_ACCEPTANCE:
      case MARKER_CHECK:
      case MARKER_OUT_OF_SCOPE:
      case MARKER_OMITTED:
        listOf(decoded, marker).push(body ?? rest);
        break;
      case MARKER_ELEMENT: {
        if (blockLines === undefined) {
          return err({
            code: "malformed_line",
            message: `${MARKER_ELEMENT} requires a #<heading lines>.<body lines> block length`,
            line: lineNumber,
          });
        }
        if (!ELEMENT_KINDS.has(rest)) {
          return err({ code: "malformed_line", message: `unknown element kind ${JSON.stringify(rest)}`, line: lineNumber });
        }
        const headingLines = counts[0] ?? 0;
        decoded.elements.push({
          heading: blockLines.slice(0, headingLines).join("\n"),
          kind: rest as WorkerTaskIrElementKind,
          body: blockLines.slice(headingLines).join("\n"),
        });
        break;
      }
      default:
        return err({ code: "unknown_marker", message: `unknown marker ${JSON.stringify(marker)}`, line: lineNumber });
    }
  }

  if (!decoded.ir_version || !decoded.task_id || !decoded.source_sha256 || !decoded.goal) {
    return err({
      code: "missing_field",
      message: "document is missing one of the required IRV / T / H / G fields",
      line: 0,
    });
  }

  return ok(decoded);
}

function listOf(decoded: DecodedCompactWorkerDsl, marker: string): string[] {
  switch (marker) {
    case MARKER_ALLOWED:
      return decoded.allowed_paths;
    case MARKER_FORBIDDEN:
      return decoded.forbidden_paths;
    case MARKER_ACCEPTANCE:
      return decoded.acceptance_criteria;
    case MARKER_CHECK:
      return decoded.checks;
    case MARKER_SPEC_REF:
      return decoded.spec_refs;
    case MARKER_OUT_OF_SCOPE:
      return decoded.out_of_scope;
    default:
      return decoded.omitted_sections;
  }
}

function expandAlias(
  value: string,
  aliases: ReadonlyMap<string, string>,
): Result<string, Omit<CompactWorkerDslParseError, "line">> {
  if (value.startsWith("{{")) {
    return ok(value.slice(1));
  }
  const reference = /^\{([FS]\d+)\}/.exec(value);
  if (!reference) {
    return ok(value);
  }
  const name = reference[1] ?? "";
  const target = aliases.get(name);
  if (target === undefined) {
    return err({ code: "unknown_alias", message: `alias {${name}} is used but never defined` });
  }
  return ok(`${target}${value.slice(reference[0].length)}`);
}
