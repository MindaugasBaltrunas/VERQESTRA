// Pure domain editor for the "accept-scope" flow: turns a human-review verdict on a
// `rollback_failed` park (work is green, but one touched path was never in `## Failai`) into a
// text edit of the task Markdown — no requeue needed. No `node:` import, no IO, no clock: the
// caller supplies the already-dated note text so the result stays reproducible.

import { findSectionBounds, splitLines } from "../../shared/markdown.js";
import { err, ok, type Result } from "../../shared/result.js";

/** Why a task's `## Failai` section could not be edited. */
export type AcceptScopePathsErrorCode = "missing_failai_section";

export type AcceptScopePathsError = {
  code: AcceptScopePathsErrorCode;
  message: string;
};

const FAILAI_HEADING = "## Failai";

// Same diacritic-tolerant markers as `allowed-paths.ts` (`Leid[žz]iama`/`Draud[žz]iama`) —
// duplicated locally rather than imported because that file's markers are not exported and
// this editor only needs to locate the two marker lines, not parse path tokens out of them.
const ALLOW_MARKER = /^\s*Leid[žz]iama\b/i;
const DENY_MARKER = /^\s*Draud[žz]iama\b/i;

function noteLine(note: string): string {
  const trimmed = note.trim();
  return trimmed.startsWith(">") ? trimmed : `> ${trimmed}`;
}

function pathLine(path: string): string {
  return `- \`${path}\``;
}

function hasPathAlready(lines: readonly string[], path: string): boolean {
  return lines.some((line) =>
    Array.from(line.matchAll(/`([^`]+)`/g), (match) => (match[1] ?? "").trim()).includes(path),
  );
}

/**
 * Inserts a dated `> ` note right after the `## Failai` heading (before `Leidžiama:`, so
 * `parseAllowedPaths` never sees it) and appends any not-yet-listed `paths` to the end of the
 * `Leidžiama:` list as `` - `path` `` bullets. Idempotent: a path or note already present is
 * not duplicated. Errors when the task has no `## Failai` section at all.
 */
export function acceptScopePaths(
  markdown: string,
  paths: readonly string[],
  note: string,
): Result<string, AcceptScopePathsError> {
  const lines = splitLines(markdown ?? "");
  const bounds = findSectionBounds(lines, (line) => line.trim() === FAILAI_HEADING);
  if (bounds === undefined) {
    return err({ code: "missing_failai_section", message: "task has no `## Failai` section" });
  }

  const result = [...lines];
  let sectionEnd = bounds.end;

  const wantedNote = noteLine(note);
  const hasNote = result.some((line, idx) => idx > bounds.start && idx < sectionEnd && line.trim() === wantedNote);
  if (!hasNote) {
    result.splice(bounds.start + 1, 0, wantedNote);
    sectionEnd += 1;
  }

  const allowIdx = result.findIndex((line, idx) => idx > bounds.start && idx < sectionEnd && ALLOW_MARKER.test(line));
  const regionStart = allowIdx === -1 ? bounds.start + 1 : allowIdx + 1;
  const denyIdx = result.findIndex((line, idx) => idx >= regionStart && idx < sectionEnd && DENY_MARKER.test(line));
  let insertAt = denyIdx === -1 ? sectionEnd : denyIdx;

  const region = result.slice(regionStart, insertAt);
  for (const path of paths) {
    if (hasPathAlready(region, path)) continue;
    result.splice(insertAt, 0, pathLine(path));
    insertAt += 1;
    region.push(pathLine(path));
  }

  return ok(result.join("\n"));
}
