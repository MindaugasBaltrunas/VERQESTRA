import { LocalControlError } from "./local-control-errors.js";

/**
 * Žemiausias peržiūros projekcijos sluoksnis: kaip skaitomas git diff TEKSTAS.
 *
 * SKAIDYMAS (VERQESTRA ≤500 eil. vartas; etalone `session-review-projection.ts` buvo 764
 * eilutės). Trys sluoksniai, kiekvienas su viena prasme: šis failas — atsisakymo žodynas ir
 * git C-stiliaus kelių dekodavimas; `session-review-diff-parse` — unified diff parseris ir
 * nešimo ribos; `session-review-projection` — faktų tikrinimas ir DTO surinkimas.
 *
 * Kryptis akiklinė: parseris importuoja šį failą, projekcija — abu. Atvirkščiai — niekada.
 */

/** Every refusal carries a rule, never a path, a root or any other host detail. */
export function refuse(message: string): never {
  throw new LocalControlError("internal_error", message);
}

export const PARSE_FAILURE = "Session diff could not be parsed";

export const RECORD_START = "diff --git ";

/**
 * The C escapes git writes into a quoted path, as code points. They are numeric
 * so this source file holds no raw control byte of its own — the convention
 * `ag-loop-read-redaction.ts` established for the same reason.
 */
const CONTROL_ESCAPES: ReadonlyMap<string, number> = new Map([
  ["a", 0x07],
  ["b", 0x08],
  ["t", 0x09],
  ["n", 0x0a],
  ["v", 0x0b],
  ["f", 0x0c],
  ["r", 0x0d],
]);

/** U+FFFD, named numerically for the same reason. */
const REPLACEMENT_CHARACTER = String.fromCharCode(0xfffd);

/**
 * Reads one `"…"` token, honouring backslash escapes so an escaped quote does
 * not end it. Returns the raw token including its quotes and the index after it.
 */
export function readQuotedToken(value: string, start: number): Readonly<{ token: string; end: number }> {
  let index = start + 1;
  while (index < value.length) {
    const character = value[index];
    if (character === "\\") {
      index += 2;
      continue;
    }
    if (character === "\"") {
      return Object.freeze({ token: value.slice(start, index + 1), end: index + 1 });
    }
    index += 1;
  }
  return refuse(PARSE_FAILURE);
}

/**
 * Undoes git's C-style path quoting.
 *
 * The scan is character by character rather than a regular expression because
 * octal escapes are BYTES: a non-ASCII name arrives as `\303\251`, and decoding
 * each byte on its own would turn one `é` into two replacement characters. Runs
 * of octal escapes are therefore buffered and decoded as UTF-8 exactly once, at
 * the end of the run. A name that still contains U+FFFD after that is a name
 * this projection cannot display truthfully, so it is refused rather than shown.
 */
export function unquoteGitPath(token: string): string {
  if (token.length < 2 || !token.startsWith("\"") || !token.endsWith("\"")) {
    refuse(PARSE_FAILURE);
  }
  const body = token.slice(1, -1);
  const bytes: number[] = [];
  let decoded = "";
  let index = 0;

  const flush = (): void => {
    if (bytes.length > 0) {
      decoded += Buffer.from(bytes).toString("utf8");
      bytes.length = 0;
    }
  };

  while (index < body.length) {
    // `!`: ciklo sąlyga (`index < body.length`) yra pats indekso galiojimo įrodymas, o
    // `noUncheckedIndexedAccess` jos į elemento tipą neperkelia. Ta pati forma jau naudojama
    // `domain/terminal-replay-buffer.prune` — riba stovi toje pačioje išraiškoje.
    const character = body[index]!;
    if (character !== "\\") {
      flush();
      decoded += character;
      index += 1;
      continue;
    }
    const escape = body[index + 1];
    if (escape === undefined) refuse(PARSE_FAILURE);
    if (escape >= "0" && escape <= "7") {
      const octal = body.slice(index + 1, index + 4);
      if (!/^[0-7]{3}$/.test(octal)) refuse(PARSE_FAILURE);
      bytes.push(Number.parseInt(octal, 8));
      index += 4;
      continue;
    }
    flush();
    const control = CONTROL_ESCAPES.get(escape);
    if (control !== undefined) {
      decoded += String.fromCharCode(control);
    } else if (escape === "\"" || escape === "\\") {
      decoded += escape;
    } else {
      refuse(PARSE_FAILURE);
    }
    index += 2;
  }
  flush();
  if (decoded.includes(REPLACEMENT_CHARACTER)) refuse(PARSE_FAILURE);
  return decoded;
}

/** Quoted or plain, decoded first — `"a/../x"` must be caught by the path rule, not hidden by it. */
export function decodePathToken(value: string): string {
  return value.startsWith("\"") ? unquoteGitPath(value) : value;
}

export function stripDiffPrefix(value: string): string {
  return value.startsWith("a/") || value.startsWith("b/") ? value.slice(2) : value;
}

/**
 * The path of a record that names it nowhere else — a binary or mode-only change
 * with no `---`/`+++` pair and no rename.
 *
 * Both sides are compared rather than split on the first space: `diff --git`
 * separates two names with a space and quotes neither unless it must, so a name
 * containing a space is ambiguous in the general case. When the two sides
 * reconstruct the same name the ambiguity is gone; when they do not, this
 * refuses instead of guessing which half is the path.
 */
export function pathFromRecordHeader(header: string): string {
  const rest = header.slice(RECORD_START.length);
  if (rest.startsWith("\"")) {
    const source = readQuotedToken(rest, 0);
    if (rest[source.end] !== " " || rest[source.end + 1] !== "\"") refuse(PARSE_FAILURE);
    const target = readQuotedToken(rest, source.end + 1);
    if (target.end !== rest.length) refuse(PARSE_FAILURE);
    return stripDiffPrefix(unquoteGitPath(target.token));
  }
  if (rest.length < 7 || (rest.length - 5) % 2 !== 0) refuse(PARSE_FAILURE);
  const candidate = rest.slice(2, 2 + (rest.length - 5) / 2);
  if (rest !== `a/${candidate} b/${candidate}`) refuse(PARSE_FAILURE);
  return candidate;
}
