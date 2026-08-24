/**
 * Stateless secret/path redaction for AG Loop read projections.
 *
 * `domain/terminal-output-sanitizer.ts` deliberately solves a different problem:
 * it is a stateful streaming sanitizer that must hold a chunk back while its
 * tail could still grow into a secret, and it keeps host paths because a
 * terminal user typed them. A read projection sees each value whole, so it needs
 * no boundary state — and `spec.md` requires it to drop host paths as well,
 * because the AG Loop UI payloads are built from absolute filesystem locations.
 *
 * Over-redaction is the intended bias: a redacted `/api/tasks` in a log line
 * costs a reader nothing, while a leaked home directory or bearer token cannot
 * be taken back once it reaches the phone.
 */

const REDACTED = "[REDACTED]";
const PATH_PLACEHOLDER = "[PATH]";

/**
 * Terminal control sequences, written as source-escaped patterns so the file
 * itself stays free of the raw control bytes it removes.
 */
const STRING_CONTROL_SEQUENCE = new RegExp(
  "\\u001b[\\]P^_X][\\s\\S]*?(?:\\u0007|\\u001b\\\\|\\u009c)",
  "g",
);
const CONTROL_SEQUENCE = new RegExp("\\u001b\\[[0-9;?]*[\\u0020-\\u002f]*[\\u0040-\\u007e]", "g");
/** Everything else non-printable; tab and newline are handled by the caller's line split. */
const CONTROL_CHARACTER = new RegExp("[\\u0000-\\u0008\\u000b-\\u001f\\u007f-\\u009f]", "g");

/**
 * Names that make the value after them a credential. The name is matched with
 * its surrounding word characters rather than on a `\b`, because `_` is a word
 * character: an anchored `\bTOKEN` never sees `GITHUB_TOKEN=`,
 * `CLAUDE_CODE_OAUTH_TOKEN=` or `AWS_SECRET_ACCESS_KEY=`, which is the shape a
 * log line actually carries.
 */
const SECRET_NAME = "(?:TOKEN|SECRET|PASSWORD|PASSPHRASE|CREDENTIALS?|API[_-]?KEY|ACCESS[_-]?KEY|PRIVATE[_-]?KEY)";
/**
 * `name = value`, `name: value` and the JSON form `"name": "value"`. The value
 * stops at a quote, a separator or `[`, so an already-inserted placeholder is
 * left intact instead of being consumed and re-wrapped.
 *
 * The name's surrounding runs are length-capped rather than open `*`: an
 * unbounded run either side of the keyword makes the scan quadratic in the
 * length of a line, and an upstream line has no length contract at all. Sixty
 * four characters is far past any real environment-variable or JSON key name.
 */
const SECRET_ASSIGNMENT = new RegExp(
  `(?<![\\p{L}\\p{N}])([\\p{L}\\p{N}_.-]{0,64}${SECRET_NAME}[\\p{L}\\p{N}_.-]{0,64})["']?\\s*[:=]\\s*["']?[^\\s"',;)}\\]\\[]+`,
  "giu",
);

const SECRET_PATTERNS: ReadonlyArray<readonly [RegExp, string]> = Object.freeze([
  [/\bBearer\s+[A-Za-z0-9._~+/-]+=*/gi, `Bearer ${REDACTED}`],
  /** A PEM header makes everything after it on that value a private key. */
  [/-{3,10}BEGIN[A-Z ]{0,40}PRIVATE KEY-{3,10}[\s\S]*/g, REDACTED],
  [/\b(?:gh[pousr]_|github_pat_|sk-|npm_|hf_)[A-Za-z0-9_-]{8,}/g, REDACTED],
  [/\bxox[abprs]-[A-Za-z0-9-]{10,}/g, REDACTED],
  [/\bAIza[0-9A-Za-z_-]{20,}/g, REDACTED],
  [/\bAKIA[0-9A-Z]{16}\b/g, REDACTED],
  /** Compact JWS: the shape of this gateway's own access tokens. */
  [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, REDACTED],
  [SECRET_ASSIGNMENT, `$1=${REDACTED}`],
]);

/**
 * Absolute host locations in every form the AG Loop UI payloads carry them:
 * `file://` URLs, UNC shares, Windows drive paths, `~`- and `~user`-relative
 * home paths and POSIX absolute paths of at least two segments.
 *
 * The segment classes are Unicode-aware on purpose: an ASCII-only class stops
 * at the first accented character, and `/home/mindė/keys` would then travel as
 * `[PATH]ė[PATH]` — the account name, which is the part worth hiding.
 */
const PATH_PATTERNS: ReadonlyArray<RegExp> = Object.freeze([
  /\bfile:\/\/\S*/gi,
  /\\\\[^\s"'`]+/g,
  /\b[A-Za-z]:[\\/][^\s"'`|]*/g,
  /(?<![\p{L}\p{N}_.~-])~[\p{L}\p{N}._-]*\/[^\s"'`|]*/gu,
  /(?<![\p{L}\p{N}_.:/-])\/(?:[\p{L}\p{N}._+@-]+\/)+[\p{L}\p{N}._+@-]*/gu,
]);

/**
 * Removes terminal control sequences and non-printable characters; tab and
 * newline survive, because a caller that splits into lines has already decided
 * what a line is.
 *
 * It is exported for projections that carry repository CONTENT rather than log
 * text — a committed file may hold an ANSI or OSC sequence, and a reader that
 * renders it would be driven by the file it is reviewing — while secret and path
 * redaction stays out of their way, since a diff line is supposed to show the
 * literal bytes that changed.
 */
export function stripControlSequences(value: string): string {
  return value
    .replace(STRING_CONTROL_SEQUENCE, "")
    .replace(CONTROL_SEQUENCE, "")
    .replace(CONTROL_CHARACTER, "");
}

/**
 * Projects one untrusted upstream string onto a bounded, redacted value.
 *
 * `maxChars` is applied last so a truncation cannot cut a placeholder open and
 * expose the tail of the very value it replaced.
 */
export function redactSensitiveText(value: string, maxChars: number): string {
  let text = stripControlSequences(value);
  for (const [pattern, replacement] of SECRET_PATTERNS) {
    text = text.replace(pattern, replacement);
  }
  for (const pattern of PATH_PATTERNS) {
    text = text.replace(pattern, PATH_PLACEHOLDER);
  }
  return text.length > maxChars ? text.slice(0, maxChars) : text;
}

/**
 * Redacted projection of a value that is only a string when upstream agrees;
 * anything else becomes `null` rather than a coerced `"[object Object]"`.
 */
export function redactedStringOrNull(value: unknown, maxChars: number): string | null {
  return typeof value === "string" ? redactSensitiveText(value, maxChars) : null;
}

/** Redacted projection that falls back to the empty string for a non-string. */
export function redactedString(value: unknown, maxChars: number): string {
  return typeof value === "string" ? redactSensitiveText(value, maxChars) : "";
}
