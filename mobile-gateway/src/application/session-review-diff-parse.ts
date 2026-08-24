import { stripControlSequences } from "./ag-loop-read-redaction.js";
import { assertRepositoryRelativePath } from "./repository-relative-path.js";
import {
  decodePathToken,
  pathFromRecordHeader,
  PARSE_FAILURE,
  RECORD_START,
  refuse,
  stripDiffPrefix,
} from "./session-review-diff-text.js";
import {
  SESSION_REVIEW_CAPS,
  type SessionDiffFile,
  type SessionDiffFileChange,
  type SessionDiffHunk,
  type SessionDiffLine,
  type SessionDiffLineKind,
} from "./session-review-contract.js";

/**
 * Unified diff parseris ir nešimo ribos.
 *
 * Antras `session-review-projection` skaidymo sluoksnis (žr. `session-review-diff-text.ts`).
 * Čia gyvena tik tai, kas verčia git tekstą į `SessionDiffFile[]` ir tai, kas nusprendžia,
 * kiek to teksto keliauja į telefoną. Faktų tikrinimas, vartų ir audito projekcija —
 * `session-review-projection.ts`.
 *
 * `!` prie indeksuotos prieigos šiame faile visur turi tą pačią priežastį: ciklo sąlyga
 * (`index < lines.length`) yra pats galiojimo įrodymas, o `noUncheckedIndexedAccess` jos į
 * elemento tipą neperkelia. Riba stovi toje pačioje išraiškoje kaip prieiga.
 */

/**
 * A hunk header, matched in full and kept in full. The section heading git
 * writes after the second `@@` is a line copied out of the FILE, so it is
 * dropped rather than trimmed: it would otherwise smuggle repository content
 * past every line budget below, inside a field no cap looks at.
 */
const HUNK_HEADER = /^@@ -\d{1,10}(?:,\d{1,10})? \+\d{1,10}(?:,\d{1,10})? @@/;
const BINARY_FILES = /^Binary files .* differ$/;

/**
 * The extended header lines `git diff` may write inside one record and this
 * projection deliberately does not carry.
 *
 * The list is exhaustive rather than a fallback, because the alternative — skip
 * whatever is not recognised — silently drops payload: a hunk body that ends at
 * an unexpected line would have its remaining changes vanish from the snapshot
 * while nothing marked it truncated, and a review that shows FEWER changes than
 * the repository holds is the dangerous direction to be wrong in.
 */
const RECORD_METADATA =
  /^(?:index |old mode |new mode |similarity index |dissimilarity index |--- |\+\+\+ )/;

function diffLine(kind: SessionDiffLineKind, text: string): SessionDiffLine {
  // Repository content may hold ANSI or OSC sequences; a reviewer's terminal or
  // renderer would otherwise be driven by the file it is being shown.
  return Object.freeze({ kind, text: stripControlSequences(text) });
}

/**
 * The complete diff, parsed with no caps at all.
 *
 * Exported so the parse can be tested against real `git diff` output on its own
 * terms; `projectSessionReview` is what applies {@link SESSION_REVIEW_CAPS}
 * to the result. Line counters are the `+`/`-` lines actually seen rather than
 * the numbers in the `@@` header, which describe the file and not the payload —
 * and which a hand-written diff can simply get wrong.
 */
export function parseUnifiedDiff(rawDiff: string): Readonly<{
  files: readonly SessionDiffFile[];
  addedLineCount: number;
  removedLineCount: number;
}> {
  const lines = rawDiff.split(/\r?\n/);
  // Where the diff stops saying anything. Trailing blank lines are the one blank
  // a diff legitimately ends on — `normalizeDiff` in `local-integration-digests`
  // drops a run of them, so a producer may well hand over more than one, and an
  // unreadable review is a worse answer to that than a carried one.
  let lastContentLine = lines.length - 1;
  while (lastContentLine >= 0 && lines[lastContentLine]!.length === 0) {
    lastContentLine -= 1;
  }
  const files: SessionDiffFile[] = [];
  let addedLineCount = 0;
  let removedLineCount = 0;
  let index = 0;

  // Anything before the first record is preamble — but diff payload in it means
  // the text is not the diff it claims to be.
  while (index < lines.length && !lines[index]!.startsWith(RECORD_START)) {
    const line = lines[index]!;
    if (line.startsWith("@@") || line.startsWith("+") || line.startsWith("-")) {
      refuse(PARSE_FAILURE);
    }
    index += 1;
  }

  while (index < lines.length) {
    const recordHeader = lines[index]!;
    index += 1;
    const hunks: SessionDiffHunk[] = [];
    let sourcePath: string | undefined;
    let targetPath: string | undefined;
    let sourceIsDevNull = false;
    let targetIsDevNull = false;
    let renamedPath: string | undefined;
    let renamed = false;
    let copied = false;
    let newFile = false;
    let deletedFile = false;
    let binary = false;
    let added = 0;
    let removed = 0;

    while (index < lines.length && !lines[index]!.startsWith(RECORD_START)) {
      const line = lines[index]!;
      if (line === "GIT binary patch" || BINARY_FILES.test(line)) {
        binary = true;
        index += 1;
        continue;
      }
      if (line.startsWith("@@")) {
        // A binary record carries an encoded payload, never hunks.
        if (binary) {
          index += 1;
          continue;
        }
        const matched = HUNK_HEADER.exec(line);
        if (matched === null) refuse(PARSE_FAILURE);
        index += 1;
        const body: SessionDiffLine[] = [];
        while (index < lines.length) {
          const bodyLine = lines[index]!;
          // Git emits no empty line inside a hunk body: a context line is a
          // space followed by the file's own content.
          if (
            bodyLine.length === 0 ||
            bodyLine.startsWith(RECORD_START) ||
            bodyLine.startsWith("@@")
          ) {
            break;
          }
          const marker = bodyLine[0];
          if (marker === "+") {
            body.push(diffLine("added", bodyLine.slice(1)));
            added += 1;
          } else if (marker === "-") {
            body.push(diffLine("removed", bodyLine.slice(1)));
            removed += 1;
          } else if (marker === " ") {
            body.push(diffLine("context", bodyLine.slice(1)));
          } else if (marker === "\\") {
            // A note about the file rather than a change to it: never counted.
            body.push(diffLine(
              "meta",
              bodyLine.startsWith("\\ ") ? bodyLine.slice(2) : bodyLine.slice(1),
            ));
          } else {
            break;
          }
          index += 1;
        }
        hunks.push(Object.freeze({ header: matched[0], lines: Object.freeze(body) }));
        continue;
      }
      if (line.startsWith("--- ")) {
        const value = line.slice(4);
        if (value === "/dev/null") sourceIsDevNull = true;
        else sourcePath = stripDiffPrefix(decodePathToken(value));
      } else if (line.startsWith("+++ ")) {
        const value = line.slice(4);
        if (value === "/dev/null") targetIsDevNull = true;
        else targetPath = stripDiffPrefix(decodePathToken(value));
      } else if (line.startsWith("rename to ")) {
        renamed = true;
        renamedPath = decodePathToken(line.slice("rename to ".length));
      } else if (line.startsWith("rename from ")) {
        renamed = true;
      } else if (line.startsWith("copy to ")) {
        copied = true;
        renamedPath = renamedPath ?? decodePathToken(line.slice("copy to ".length));
      } else if (line.startsWith("copy from ")) {
        copied = true;
      } else if (line.startsWith("new file mode ")) {
        newFile = true;
      } else if (line.startsWith("deleted file mode ")) {
        deletedFile = true;
      } else if (
        // A binary record's payload is base85 this parser never reads, so its
        // lines are skipped wholesale rather than recognised one by one.
        !binary &&
        // A blank line past the last content is the diff's trailing newline. A
        // blank line ANYWHERE else inside a record is a hunk body this parser
        // would otherwise abandon in silence.
        !(line.length === 0 && index > lastContentLine) &&
        !RECORD_METADATA.test(line)
      ) {
        refuse(PARSE_FAILURE);
      }
      index += 1;
    }

    // A rename names its target in `rename to` even when no content changed, so
    // the recorded path is always the NEW one.
    const path = targetPath ?? sourcePath ?? renamedPath ?? pathFromRecordHeader(recordHeader);
    assertRepositoryRelativePath(path);
    const change: SessionDiffFileChange = renamed
      ? "renamed"
      : newFile || sourceIsDevNull
        ? "added"
        : deletedFile || targetIsDevNull
          ? "deleted"
          // The contract has no "copied"; a copy puts a file where none was.
          : copied ? "added" : "modified";

    if (!binary) {
      addedLineCount += added;
      removedLineCount += removed;
    }
    files.push(Object.freeze({
      path,
      change,
      binary,
      hunks: Object.freeze(binary ? [] : hunks),
      hiddenHunkCount: 0,
    }));
  }

  return Object.freeze({ files: Object.freeze(files), addedLineCount, removedLineCount });
}

export type CappedDiff = Readonly<{
  files: readonly SessionDiffFile[];
  filesDropped: boolean;
  linesClipped: boolean;
  bytesClipped: boolean;
}>;

/**
 * Applies the carrying caps to a parsed diff.
 *
 * The line budget is deliberately the same algorithm as the client's own
 * defensive clamp: shared per-file and total allowances, a hunk that gets no
 * allowance becomes `hiddenHunkCount`, and a hunk that gets part of one stays
 * visible with its tail cut. When both sides run the same rule the client's
 * clamp finds nothing left to do, so what the operator sees is the host's
 * projection rather than the client's second opinion of it.
 *
 * The character budget rides alongside it, because a line budget says nothing
 * about weight: one minified line can outweigh two thousand ordinary ones.
 */
export function capDiffFiles(parsedFiles: readonly SessionDiffFile[]): CappedDiff {
  const keptFiles = parsedFiles.slice(0, SESSION_REVIEW_CAPS.maxFiles);
  let remaining: number = SESSION_REVIEW_CAPS.maxHunkLinesTotal;
  let charBudget: number = SESSION_REVIEW_CAPS.maxCarriedDiffChars;
  let linesClipped = false;
  let bytesClipped = false;

  const files = keptFiles.map((file) => {
    if (file.binary) return file;
    let fileRemaining: number = SESSION_REVIEW_CAPS.maxHunkLinesPerFile;
    let hiddenHunkCount = file.hiddenHunkCount;
    const hunks: SessionDiffHunk[] = [];

    for (const hunk of file.hunks) {
      const allowance = Math.min(fileRemaining, remaining);
      if (allowance <= 0) {
        hiddenHunkCount += 1;
        linesClipped = true;
        continue;
      }
      const kept = Math.min(hunk.lines.length, allowance);
      if (kept < hunk.lines.length) linesClipped = true;
      fileRemaining -= kept;
      remaining -= kept;

      const carried: SessionDiffLine[] = [];
      for (const line of hunk.lines.slice(0, kept)) {
        if (charBudget <= 0) {
          bytesClipped = true;
          break;
        }
        let text = line.text;
        if (text.length > SESSION_REVIEW_CAPS.maxDiffLineChars) {
          text = text.slice(0, SESSION_REVIEW_CAPS.maxDiffLineChars);
          bytesClipped = true;
        }
        if (text.length > charBudget) {
          text = text.slice(0, charBudget);
          bytesClipped = true;
        }
        charBudget -= text.length;
        carried.push(text === line.text ? line : Object.freeze({ kind: line.kind, text }));
      }
      // A hunk whose every line was refused carriage is hidden, not empty: an
      // empty hunk would read as "nothing changed here".
      if (kept > 0 && carried.length === 0) {
        hiddenHunkCount += 1;
        bytesClipped = true;
        continue;
      }
      hunks.push(Object.freeze({ header: hunk.header, lines: Object.freeze(carried) }));
    }

    return Object.freeze({ ...file, hunks: Object.freeze(hunks), hiddenHunkCount });
  });

  return Object.freeze({
    files: Object.freeze(files),
    filesDropped: parsedFiles.length > SESSION_REVIEW_CAPS.maxFiles,
    linesClipped,
    bytesClipped,
  });
}
