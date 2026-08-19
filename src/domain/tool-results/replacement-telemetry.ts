// Evidence record for the Bash output REPLACEMENT path (task 0027).
// Behaviour etalon: AG_loop domain/tool-results/replacement-telemetry.ts.
// WBR VQ-204: BASH_REPLACEMENT_LOG_SEGMENTS čia NEmigruoja — log'o vieta yra IO adapterio
// (E3/E4) sprendimas, ne domeno faktas.
//
// Deliberately a second log rather than more columns on the shadow log. The two answer
// different questions — the shadow log says "what WOULD a digest have saved", this one says
// "what did the replacement path actually do, and when it did nothing, why". Summing
// `saved_chars` across a file that mixed the two would double-count every payload.
//
// While the handler is unwired, the `keep` records ARE the deliverable: they enumerate the real
// payload vocabulary of the installed executor build, so the rollout task can widen
// KNOWN_BASH_TOOL_RESPONSE_FIELDS against observed evidence instead of a guess.
//
// The privacy invariant holds unchanged and is extended: sizes and hashes, never the raw
// output, never the digest text, never the command line. Unknown FIELD NAMES are payload
// metadata rather than command output, so they are kept — but capped and shape-filtered, so an
// adversarial payload cannot smuggle text into the log through a key name.
//
// Pure domain module: hashing and token estimation are injected, so it holds no I/O, no clock
// and no node builtins.

import type { BashCommandClass } from "./bash-command-class.js";
import { BASH_DIGEST_VERSION, type BashOutputOutcome } from "./digest/model.js";
import {
  BASH_REPLACEMENT_VERSION,
  type BashOutputReplacementDecision,
  type BashReplacementKeepReason,
  type BashReplacementPayloadShape,
} from "./bash-output-replacement.js";
import type { BashDigestShadowDeps } from "./shadow-telemetry.js";

/** At most this many unknown field names per record — the rest are counted, not named. */
export const BASH_REPLACEMENT_UNKNOWN_FIELD_CAP = 10;

/** A plain identifier-shaped key. Anything else is logged as `<redacted>`. */
const SAFE_FIELD_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,39}$/;

export type BashReplacementRecord = {
  ts: string;
  replacement_version: number;
  digest_version: number;
  command_class: BashCommandClass;
  payload_shape: BashReplacementPayloadShape;
  action: "replace" | "keep";
  /** True only when a replacement was actually emitted. */
  applied: boolean;
  keep_reason?: BashReplacementKeepReason;
  /** Fixed-vocabulary explanation from the decision; never command text or command output. */
  detail?: string;
  digest_status?: "digested" | "unsupported";
  outcome?: BashOutputOutcome;
  safe_to_replace: boolean;
  /** `stdout.length + stderr.length` of the original payload; 0 when it could not be read. */
  original_chars: number;
  /** Characters the emitted replacement occupies; 0 when the original was kept. */
  replacement_chars: number;
  saved_chars: number;
  saved_token_estimate: number;
  original_sha256: string;
  replacement_sha256: string;
  /** Always exact, even when the names were capped or redacted. */
  unknown_field_count?: number;
  unknown_fields?: string[];
};

export type BashReplacementRecordInput = {
  decision: BashOutputReplacementDecision;
  /** The exact raw text the decision was made against; hashed, never stored. */
  rawText: string;
  now: Date;
};

export function buildBashReplacementRecord(
  input: BashReplacementRecordInput,
  deps: BashDigestShadowDeps,
): BashReplacementRecord {
  const { decision } = input;
  const digest = decision.digest;

  const base = {
    ts: input.now.toISOString(),
    replacement_version: BASH_REPLACEMENT_VERSION,
    digest_version: BASH_DIGEST_VERSION,
    command_class: decision.commandClass,
    payload_shape: decision.payloadShape,
    original_chars: decision.originalChars,
    original_sha256: deps.hash(input.rawText),
    ...(digest === undefined ? {} : { digest_status: digest.status }),
    ...(digest?.status === "digested" ? { outcome: digest.signals.outcome } : {}),
  };

  if (decision.action === "keep") {
    return {
      ...base,
      action: "keep",
      applied: false,
      keep_reason: decision.keepReason,
      detail: decision.detail,
      safe_to_replace: false,
      replacement_chars: 0,
      saved_chars: 0,
      saved_token_estimate: 0,
      replacement_sha256: deps.hash(""),
      ...unknownFieldFields(decision.unknownFields),
    };
  }

  return {
    ...base,
    action: "replace",
    applied: true,
    safe_to_replace: true,
    replacement_chars: decision.replacement.replacementChars,
    saved_chars: decision.replacement.savedChars,
    saved_token_estimate: deps.estimateTokens(decision.replacement.savedChars),
    replacement_sha256: deps.hash(decision.replacement.digestText),
  };
}

function unknownFieldFields(
  fields: string[] | undefined,
): Pick<BashReplacementRecord, "unknown_field_count" | "unknown_fields"> {
  if (fields === undefined || fields.length === 0) return {};
  return {
    unknown_field_count: fields.length,
    unknown_fields: fields
      .slice(0, BASH_REPLACEMENT_UNKNOWN_FIELD_CAP)
      .map((field) => (SAFE_FIELD_NAME.test(field) ? field : "<redacted>")),
  };
}
