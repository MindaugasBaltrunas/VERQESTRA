import { createHash } from "node:crypto";

/**
 * Canonical serialization and content hashing (BENCH-8).
 *
 * A baseline is compared against a run recorded on another machine, days or
 * months apart. Whether the two measured the same thing is decided by digests,
 * so the bytes those digests are taken over may not depend on anything except
 * the values themselves: not on the order a JavaScript engine happened to
 * enumerate keys in, not on the line endings a checkout produced, not on which
 * Unicode spelling an editor saved.
 *
 * The rules, and why each exists:
 *
 * - **Object keys are sorted.** Insertion order is an accident of how a record
 *   was built; two records with the same fields are the same record.
 * - **Text is normalised.** CRLF and lone CR become LF, because `core.autocrlf`
 *   rewrites files on Windows checkouts; NFC folds the two spellings of an
 *   accented character, which differ by editor rather than by intent.
 * - **Arrays keep their order.** An argument vector and a sample list are
 *   sequences; reordering one changes what it says. Callers that hold a *set*
 *   sort it before handing it over — that decision belongs to the value's
 *   owner, not to the serializer.
 * - **`undefined` object values are omitted.** BENCH-7 reports an unmeasured
 *   metric as `undefined`, and JSON has no such value. Omission is the one
 *   encoding that survives a write/read round trip unchanged: `null` would come
 *   back as a value that was measured.
 * - **Anything else is refused.** A non-finite number, a function, a symbol or
 *   a hole in an array is a defect in the caller, and hashing a repaired
 *   version of it would hide that defect behind a digest that looks fine.
 *
 * Note: `application/validate-suite.ts` carries its own copy of this algorithm
 * for the scenario suite hash, written before this module existed. The two are
 * deliberately identical in behaviour; converging them is a change to that file
 * and belongs to a task whose scope includes it.
 */

/** Names the digest algorithm inside the hash, so a later move to another one is a visible change. */
export const CANONICAL_DIGEST_ALGORITHM = "sha256";

/** The shape every hash in a baseline manifest has, for validation and diagnosis. */
export const CANONICAL_DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/;

function normalizeText(value: string): string {
  return value.replace(/\r\n?/g, "\n").normalize("NFC");
}

function describePath(at: string): string {
  return at === "" ? "the document root" : `"${at}"`;
}

function describe(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "an array";
  return typeof value;
}

function render(value: unknown, at: string): string {
  if (value === null) return "null";
  switch (typeof value) {
    case "string":
      return JSON.stringify(normalizeText(value));
    case "boolean":
      return value ? "true" : "false";
    case "number":
      if (!Number.isFinite(value)) {
        throw new TypeError(
          `Cannot canonicalize the non-finite number ${value} at ${describePath(at)}.`,
        );
      }
      // `-0` and `0` are the same measurement and must not hash differently.
      return Object.is(value, -0) ? "0" : JSON.stringify(value);
    case "object":
      break;
    default:
      throw new TypeError(
        `Cannot canonicalize a value of type ${describe(value)} at ${describePath(at)}.`,
      );
  }

  if (Array.isArray(value)) {
    return `[${value
      .map((element, index) => {
        const elementPath = `${at}[${index}]`;
        if (element === undefined) {
          throw new TypeError(
            `Cannot canonicalize the absent element at ${describePath(elementPath)}; ` +
              "a list has no holes.",
          );
        }
        return render(element, elementPath);
      })
      .join(",")}]`;
  }

  // Own keys only: a `__proto__` entry that survived `JSON.parse` is data, and
  // following it to the prototype would hash something the document never said.
  const record = value as Record<string, unknown>;
  const body = Object.keys(record)
    .sort()
    .filter((key) => record[key] !== undefined)
    .map(
      (key) =>
        `${JSON.stringify(normalizeText(key))}:${render(
          record[key],
          at === "" ? key : `${at}.${key}`,
        )}`,
    )
    .join(",");
  return `{${body}}`;
}

/**
 * The exact bytes a digest is taken over. Exported because a mismatch is far
 * easier to diagnose by diffing two canonical forms than two digests.
 */
export function canonicalJson(value: unknown): string {
  return render(value, "");
}

/** The canonical digest of a value, prefixed with the algorithm that produced it. */
export function canonicalDigest(value: unknown): string {
  const digest = createHash(CANONICAL_DIGEST_ALGORITHM)
    .update(canonicalJson(value), "utf8")
    .digest("hex");
  return `${CANONICAL_DIGEST_ALGORITHM}:${digest}`;
}

/**
 * Whether two values carry the same content, judged by their canonical form.
 *
 * Used to check a stored aggregate against a freshly recomputed one, where the
 * stored side came back from JSON without the keys an unmeasured metric leaves
 * `undefined`. Comparing the canonical forms makes "absent" and "undefined" the
 * one thing they have to be here: the same answer.
 */
export function canonicallyEqual(left: unknown, right: unknown): boolean {
  return canonicalJson(left) === canonicalJson(right);
}
