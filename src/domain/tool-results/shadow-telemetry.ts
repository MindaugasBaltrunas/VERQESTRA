// Shadow telemetry record for the Bash output digest (task 0026).
// Behaviour etalon: AG_loop domain/tool-results/shadow-telemetry.ts.
// WBR VQ-204: BASH_DIGEST_SHADOW_LOG_SEGMENTS čia NEmigruoja — log'o vieta yra IO adapterio
// (E3/E4) sprendimas, ne domeno faktas.
//
// "Shadow" is the whole point: the digest engine runs beside the real PostToolUse hook and
// changes NOTHING the worker sees. What it produces is evidence — how many characters and
// tokens a SAFE replacement would have saved — so the rollout decision is made against
// measurements instead of an estimate.
//
// WHAT THIS RECORD DELIBERATELY DOES NOT CONTAIN: the raw output, the digest text, or the
// command line. The raw output already exists in the executor's own hook/transcript evidence,
// so copying it into a second log would duplicate the very bytes this work exists to reduce —
// and would put command output (which can carry paths, tokens or secrets scanned elsewhere)
// into one more file. Sizes plus content hashes answer "how much would this have saved" and
// "was it the same output twice" without storing any of it.
//
// Pure domain module: hashing and token estimation are injected, so it holds no I/O, no
// clock and no node builtins, and a test can pin every field deterministically.

import type { BashCommandClass } from "./bash-command-class.js";
import { BASH_DIGEST_VERSION, type BashOutputDigest, type BashOutputOutcome } from "./digest/model.js";

export type BashDigestShadowRecord = {
  ts: string;
  /** Digest engine version, so a format change is visible in the log rather than silent. */
  digest_version: number;
  command_class: BashCommandClass;
  status: "digested" | "unsupported";
  /** Present when the engine refused, or when the digest may not replace the raw output. */
  reason?: string;
  outcome?: BashOutputOutcome;
  raw_chars: number;
  /** 0 for `unsupported` — nothing was rendered. */
  digest_chars: number;
  raw_sha256: string;
  digest_sha256: string;
  /** Characters a SAFE replacement would have saved; 0 whenever replacement is not safe. */
  saved_chars: number;
  saved_token_estimate: number;
  safe_to_replace: boolean;
};

export type BashDigestShadowDeps = {
  hash: (text: string) => string;
  estimateTokens: (chars: number) => number;
};

export type BashDigestShadowInput = {
  digest: BashOutputDigest;
  /** The exact raw text the digest was computed from; hashed, never stored. */
  rawText: string;
  now: Date;
};

export function buildBashDigestShadowRecord(
  input: BashDigestShadowInput,
  deps: BashDigestShadowDeps,
): BashDigestShadowRecord {
  const { digest } = input;
  const base = {
    ts: input.now.toISOString(),
    digest_version: BASH_DIGEST_VERSION,
    command_class: digest.commandClass,
    raw_chars: digest.rawChars,
    raw_sha256: deps.hash(input.rawText),
  };

  if (digest.status === "unsupported") {
    return {
      ...base,
      status: "unsupported",
      reason: digest.reason,
      digest_chars: 0,
      digest_sha256: deps.hash(""),
      saved_chars: 0,
      saved_token_estimate: 0,
      safe_to_replace: false,
    };
  }

  // Savings are only counted for a digest that may actually replace the output. Counting the
  // "potential" savings of an unsafe digest would overstate the case for the rollout.
  const savedChars = digest.safeToReplace ? Math.max(0, digest.rawChars - digest.digestChars) : 0;

  return {
    ...base,
    status: "digested",
    ...(digest.unsafeReason === undefined ? {} : { reason: digest.unsafeReason }),
    outcome: digest.signals.outcome,
    digest_chars: digest.digestChars,
    digest_sha256: deps.hash(digest.text),
    saved_chars: savedChars,
    saved_token_estimate: deps.estimateTokens(savedChars),
    safe_to_replace: digest.safeToReplace,
  };
}
