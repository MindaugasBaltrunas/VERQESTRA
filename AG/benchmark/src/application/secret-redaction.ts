/**
 * Secret redaction (design §Saugumas).
 *
 * A benchmark records what an agent run cost and what it touched, and the values
 * it reads back — a model identifier an adapter reported, a version line a tool
 * printed, a reason an agent gave — are strings this package never authored. Any
 * of them can carry a credential, and a stored sample outlives the run: it is
 * committed with a baseline, attached to a report and read by whoever compares
 * two numbers months later. So redaction happens on the way in, at the last point
 * before a value is persisted, rather than on the way out of a report.
 *
 * Two properties are deliberate:
 *
 * - **Only recognised secret shapes are removed.** There is no entropy rule.
 *   BENCH-8 requires every baseline to carry a full Git object id, and a
 *   forty-character hexadecimal string is exactly what a generic "looks random"
 *   heuristic would delete. Redacting the field the specification requires would
 *   be a worse failure than leaving an unrecognised token in place, and an
 *   unrecognised token is a rule to add here rather than a reason to guess.
 * - **The shape of the value survives.** A key keeps its name and only its value
 *   is replaced, so a reader can still see that a credential was present without
 *   being able to read it.
 *
 * Everything here is pure so the store and the environment adapter can share one
 * definition of "must not be written down" and a test can state it directly.
 */

export const REDACTION_PLACEHOLDER = "[redacted]";

interface RedactionRule {
  /** Global by construction: every occurrence in a value is redacted, not the first. */
  readonly pattern: RegExp;
  /** Replacement, `$n` referring to the groups the rule preserves. */
  readonly replacement: string;
}

/**
 * Key names whose value is a secret regardless of what the value looks like.
 * Matched as a substring of the key so `CLAUDE_API_KEY`, `db.password` and
 * `"refreshToken"` are all covered by one entry each.
 */
const SECRET_KEY_WORDS =
  "token|secret|password|passwd|api[_-]?key|apikey|access[_-]?key|private[_-]?key|credential|authorization";

/**
 * Ordered: the block and URL rules run before the token-shape rules, so a key
 * embedded in a larger structure is removed as a whole rather than leaving the
 * surrounding syntax half-redacted.
 */
const RULES: readonly RedactionRule[] = [
  // A PEM block is multi-line and its body is the key itself.
  {
    pattern: /-----BEGIN (?:[A-Z ]+ )?PRIVATE KEY-----[\s\S]*?-----END (?:[A-Z ]+ )?PRIVATE KEY-----/g,
    replacement: REDACTION_PLACEHOLDER,
  },
  // Credentials in a URL: the host stays, because knowing which remote was used
  // is part of the evidence; the password is not.
  {
    pattern: /\b([a-z][a-z0-9+.-]*:\/\/)([^\s/:@]+):[^\s/@]*@/gi,
    replacement: `$1$2:${REDACTION_PLACEHOLDER}@`,
  },
  // Authorization headers, as they appear in a captured command line or log.
  {
    pattern: /\b(Bearer|Basic|Token)\s+[A-Za-z0-9._~+/=-]{8,}/gi,
    replacement: `$1 ${REDACTION_PLACEHOLDER}`,
  },
  // Provider token shapes. Each is anchored on a vendor prefix, which is what
  // keeps a Git object id, a checksum and a base64 diff out of scope.
  { pattern: /\bsk-ant-[A-Za-z0-9_-]{8,}/g, replacement: REDACTION_PLACEHOLDER },
  { pattern: /\bsk-[A-Za-z0-9]{16,}/g, replacement: REDACTION_PLACEHOLDER },
  { pattern: /\bgh[pousr]_[A-Za-z0-9]{20,}/g, replacement: REDACTION_PLACEHOLDER },
  { pattern: /\bgithub_pat_[A-Za-z0-9_]{20,}/g, replacement: REDACTION_PLACEHOLDER },
  { pattern: /\bxox[abprs]-[A-Za-z0-9-]{10,}/g, replacement: REDACTION_PLACEHOLDER },
  { pattern: /\bAKIA[0-9A-Z]{16}\b/g, replacement: REDACTION_PLACEHOLDER },
  { pattern: /\bAIza[A-Za-z0-9_-]{20,}/g, replacement: REDACTION_PLACEHOLDER },
  // A JSON Web Token: three base64url segments, the first spelling `{"` as `eyJ`.
  {
    pattern: /\beyJ[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}/g,
    replacement: REDACTION_PLACEHOLDER,
  },
  // `key=value`, `"key": "value"` and `key: value` where the key names a secret.
  // The value ends at the first separator, so redacting one entry of a captured
  // command line does not swallow the entries after it. A value already starting
  // with `[` is left alone, which is what makes redaction idempotent: a value
  // that has been through this once — a sample read back and re-stored, a
  // version line redacted at capture — must not grow a placeholder per pass.
  {
    pattern: new RegExp(
      `(["']?[A-Za-z0-9_.-]*(?:${SECRET_KEY_WORDS})[A-Za-z0-9_.-]*["']?\\s*[:=]\\s*)["']?[^\\s,;&"')}[\\]]+["']?`,
      "gi",
    ),
    replacement: `$1${REDACTION_PLACEHOLDER}`,
  },
];

/** Replaces every recognised credential in `text`. Text carrying none is returned unchanged. */
export function redactSecrets(text: string): string {
  let redacted = text;
  for (const rule of RULES) {
    // A fresh regex per call: the rules are module-level and global, and a shared
    // `lastIndex` would make the result depend on what was redacted before it.
    redacted = redacted.replace(new RegExp(rule.pattern.source, rule.pattern.flags), rule.replacement);
  }
  return redacted;
}

/** Whether `text` carries anything {@link redactSecrets} would remove. */
export function containsSecret(text: string): boolean {
  return redactSecrets(text) !== text;
}

/**
 * Redacts every string inside a JSON-shaped value, leaving structure, numbers,
 * booleans, `null` and array order untouched.
 *
 * Object keys are left alone on purpose: they are schema field names, and
 * rewriting one would turn a valid record into an unrecognised one. The result is
 * rebuilt with `Object.fromEntries`, which defines own properties, so a
 * `__proto__` key that survived `JSON.parse` stays an own key here instead of
 * being followed to the prototype.
 */
export function redactSecretsDeep(value: unknown): unknown {
  return redactValue(value, new WeakSet());
}

function redactValue(value: unknown, seen: WeakSet<object>): unknown {
  if (typeof value === "string") return redactSecrets(value);
  if (typeof value !== "object" || value === null) return value;
  if (seen.has(value)) {
    // Samples and captured records are JSON documents; a cycle means the caller
    // handed over something that could never have been stored anyway.
    throw new TypeError("Cannot redact a value that references itself.");
  }
  seen.add(value);
  if (Array.isArray(value)) return value.map((element) => redactValue(element, seen));
  return Object.fromEntries(
    Object.entries(value).map(([key, entry]) => [key, redactValue(entry, seen)]),
  );
}
