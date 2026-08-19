// The three frozen hash semantics of the system — unified from AG_loop's scattered
// copies (VQ-002 finding: 20+ inline createHash sites, 3 distinct meanings), pinned by
// the shared-primitives characterization fixture.

import { createHash } from "node:crypto";
import { canonicalJsonStringify } from "./json.js";

/** Raw sha256 hex of the exact bytes/text — no normalization. */
export function sha256Hex(input: string | Uint8Array): string {
  return createHash("sha256").update(input).digest("hex");
}

/**
 * sha256 of NORMALIZED text: CRLF -> LF and trailing whitespace stripped, so a
 * Windows/Linux checkout or an editor's final newline never invalidates a fingerprint.
 * Etalon: AG_loop contextArtifactSha256.
 */
export function normalizedSha256(text: string): string {
  return sha256Hex(text.replace(/\r\n/g, "\n").replace(/\s+$/, ""));
}

/**
 * Shared decision-fingerprint space: `<prefix>:<first 16 hex of sha256(canonical JSON)>`.
 * The prefix names WHICH rules produced the digest, so two decision spaces never mix in
 * one field. Etalon: AG_loop computeSchedulingHash (and its 8 inline twins).
 */
export function shortDigest(prefix: string, payload: unknown): string {
  return `${prefix}:${sha256Hex(canonicalJsonStringify(payload)).slice(0, 16)}`;
}
