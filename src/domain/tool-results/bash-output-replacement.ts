// Replacement decision for a PostToolUse Bash/PowerShell tool result (task 0027).
// Behaviour etalon: AG_loop domain/tool-results/bash-output-replacement.ts.
// WBR VQ-204: PostToolUseHookOutput + buildPostToolUseHookOutput čia NEmigruoja — hook
// envelope forma yra protokolas ir keliasi į E5 interfaces/hooks.
//
// Task 0026 answered "how many characters WOULD a digest have saved". This module answers the
// harder question that must be settled before any of those characters are actually removed:
// "may this specific payload be rewritten, and with exactly which bytes".
//
// The engine in digest/bash-output-digest.ts already refuses to mark a failed, interrupted,
// truncated or contradictory run safe. This module does NOT re-derive that verdict; it adds
// the gates that only matter once a rewrite is on the table, and every one of them is a reason
// to keep the original:
//
//  1. PAYLOAD IDENTITY. The replacement is the original object with the digest written into
//     the stream keys that already existed — never a payload rebuilt from a template. A field
//     this module does not recognize means the installed executor build carries meaning
//     this module cannot reproduce, so the whole payload is left alone and the field NAMES are
//     recorded. Those records are the deliverable: the rollout task widens the allowlist
//     against observed evidence instead of a guess.
//  2. PROVEN SUCCESS, NOT INFERRED. Only an explicit `exit == 0` may be shortened. A bare
//     string payload carries no exit status at all, so the digest engine has to infer the
//     outcome from the output text — good enough to measure, never good enough to delete the
//     text the inference was made from.
//  3. WORTH THE RISK. Rewriting a tool result carries a fixed shape risk and a benefit that
//     scales with the characters saved. Below BASH_REPLACEMENT_MIN_SAVED_CHARS the raw output
//     is simply the better evidence, so the original stays.
//
// Pure domain module: no I/O, no clock, no environment. The hook layer supplies the already
// parsed payload and does nothing but forward this module's answer.

import { classifyBashCommand, type BashCommandClass } from "./bash-command-class.js";
import { digestBashOutput } from "./digest/bash-output-digest.js";
import type { BashOutputDigest } from "./digest/model.js";
import { BASH_EXIT_CODE_FIELDS, readBashToolResponse } from "./bash-tool-response.js";

/** Replacement-path format version; bumped when the emitted envelope stops being comparable. */
export const BASH_REPLACEMENT_VERSION = 1;

/**
 * Minimum characters a replacement must remove to be worth making. The shape risk of
 * rewriting a tool result is fixed; the payoff is not. A digest that saves a few dozen
 * characters buys nothing and costs the worker the raw text.
 *
 * PROVISIONAL: chosen by argument, not by measurement. The rollout task must recheck it
 * against the observed `saved_chars` distribution in the shadow log.
 */
export const BASH_REPLACEMENT_MIN_SAVED_CHARS = 500;

/**
 * Tools whose result this module knows how to read and rebuild. `PowerShell` is included
 * because the harness routes it through the same Bash policy and it returns the same result
 * shape; any other tool name keeps its output untouched, which is the defence in depth against
 * a mis-scoped hook matcher in settings.
 */
export const REPLACEABLE_BASH_TOOL_NAMES = ["Bash", "PowerShell"] as const;

/**
 * Every `tool_response` field this implementation can both READ and faithfully echo back.
 * Deliberately the exact union encoded in {@link readBashToolResponse} — one exported const so
 * the reader and the rebuilder cannot drift apart.
 */
export const KNOWN_BASH_TOOL_RESPONSE_FIELDS = [
  "stdout",
  "stderr",
  "interrupted",
  "isImage",
  "is_image",
  // Composed from the reader's own list rather than copied, so a spelling added there cannot
  // silently become an "unknown" field here — or, worse, the other way round.
  ...BASH_EXIT_CODE_FIELDS,
] as const;

const KNOWN_FIELD_SET: ReadonlySet<string> = new Set<string>(KNOWN_BASH_TOOL_RESPONSE_FIELDS);
const REPLACEABLE_TOOL_SET: ReadonlySet<string> = new Set<string>(REPLACEABLE_BASH_TOOL_NAMES);

/** Which payload form the decision was made against; `unreadable` covers everything rejected. */
export type BashReplacementPayloadShape = "object" | "text" | "unreadable";

/**
 * Why the original output was kept. Every value is a fixed identifier — nothing derived from
 * the command or its output — so a decision can be logged without leaking either.
 */
export type BashReplacementKeepReason =
  | "tool_not_replaceable"
  | "unreadable_hook_input"
  | "unreadable_payload"
  | "payload_shape_text"
  | "unknown_payload_fields"
  | "command_is_chained"
  | "output_interrupted"
  | "exit_status_absent"
  | "exit_status_nonzero"
  | "digest_unsupported"
  | "digest_unsafe"
  | "saving_below_threshold";

export type BashOutputReplacement = {
  /** The rebuilt `tool_response`, ready to be handed back as `updatedToolOutput`. */
  updatedToolOutput: Record<string, unknown>;
  /** The digest text written into the payload's stream field(s). */
  digestText: string;
  originalChars: number;
  replacementChars: number;
  savedChars: number;
};

type DecisionBase = {
  commandClass: BashCommandClass;
  payloadShape: BashReplacementPayloadShape;
  /** `stdout.length + stderr.length` of the ORIGINAL payload; 0 when it could not be read. */
  originalChars: number;
  digest?: BashOutputDigest;
};

export type BashOutputReplacementDecision =
  | (DecisionBase & { action: "replace"; replacement: BashOutputReplacement; digest: BashOutputDigest })
  | (DecisionBase & {
      action: "keep";
      keepReason: BashReplacementKeepReason;
      /** Fixed-vocabulary explanation. Never carries command text or command output. */
      detail: string;
      /** Field names the payload carried that this module does not know. */
      unknownFields?: string[];
    });

export type DecideBashOutputReplacementInput = {
  /** `tool_name` from the PostToolUse payload; an empty/unknown name keeps the output. */
  toolName: string;
  command: string;
  /** The raw `tool_response` value, exactly as the hook payload carried it. */
  toolResponse: unknown;
};

/**
 * Decides whether one Bash/PowerShell tool result may be replaced by its digest.
 *
 * Structural gates run before the digest engine: they are cheaper, and a payload this module
 * cannot rebuild is not worth digesting at all. `keep` is the normal answer.
 */
export function decideBashOutputReplacement(input: DecideBashOutputReplacementInput): BashOutputReplacementDecision {
  const commandClass = classifyBashCommand(input.command);

  if (!REPLACEABLE_TOOL_SET.has(input.toolName)) {
    return keep(commandClass, "unreadable", 0, "tool_not_replaceable", "tool_name is not a replaceable shell tool");
  }

  const reading = readBashToolResponse(input.toolResponse);
  if (!reading.ok) {
    return keep(commandClass, "unreadable", 0, "unreadable_payload", reading.reason);
  }

  const response = reading.value;
  const originalChars = response.stdout.length + response.stderr.length;

  if (response.shape === "text") {
    // A bare string carries no exit status, so success could only be inferred from the very
    // text a replacement would delete. Measuring that is fine (task 0026); deleting it is not.
    return keep(commandClass, "text", originalChars, "payload_shape_text", "bare-string payload carries no exit status");
  }

  const unknownFields = unknownFieldsOf(input.toolResponse);
  if (unknownFields.length > 0) {
    return {
      ...keep(
        commandClass,
        "object",
        originalChars,
        "unknown_payload_fields",
        `payload carries ${unknownFields.length} field(s) this implementation cannot reproduce`,
      ),
      unknownFields,
    };
  }

  if (isChainedCommand(input.command)) {
    // `pnpm test && node scripts/report.js` classifies as `test` (only one class token appears),
    // the TAP markers make the digest recognized, and the report's output — which no parser here
    // has ever seen — would be deleted along with the test names. The classifier tolerates this
    // because 0026 only measured; a path that actually removes characters cannot.
    return keep(commandClass, "object", originalChars, "command_is_chained", "command chains more than one program");
  }

  if (response.interrupted) {
    return keep(commandClass, "object", originalChars, "output_interrupted", "interrupted output is never shortened");
  }

  // Absence and failure are separated on purpose: a non-zero exit is the expected, common case,
  // while a payload with NO exit status is a shape gap the rollout task has to know the rate of.
  // Neither may be shortened — without a proven `exit == 0` a failure digest could pass for a
  // clean run, and the diagnostics that would have shown otherwise would already be gone.
  //
  // Read across ALL exit-status spellings, not just the first one the reader happened to pick:
  // every spelling is in the known-field allowlist, so `{exit_code: 0, returnCode: 1}` would
  // otherwise pass the unknown-field gate and get a FAILED run shortened.
  const exitStatuses = exitStatusesOf(input.toolResponse);
  if (exitStatuses.length === 0) {
    return keep(commandClass, "object", originalChars, "exit_status_absent", "payload carries no exit status");
  }
  if (exitStatuses.some((status) => status !== 0)) {
    return keep(
      commandClass,
      "object",
      originalChars,
      "exit_status_nonzero",
      exitStatuses.length > 1 ? "exit status spellings disagree or report a failure" : "exit status is not 0",
    );
  }

  const digest = digestBashOutput({ command: input.command, response });
  if (digest.status === "unsupported") {
    return { ...keep(commandClass, "object", originalChars, "digest_unsupported", digest.reason), digest };
  }
  if (!digest.safeToReplace) {
    return {
      ...keep(
        commandClass,
        "object",
        originalChars,
        "digest_unsafe",
        digest.unsafeReason ?? "digest is not safe to replace",
      ),
      digest,
    };
  }

  // Savings are measured against the ORIGINAL payload streams, not against the digest engine's
  // `rawChars`. The engine joins the two streams and normalizes CRLF away, so on Windows its
  // count is smaller than what the worker actually pays for — measuring there would let dropped
  // `\r` bytes manufacture a saving that the real payload never had.
  const replacementChars = digest.text.length;
  const savedChars = originalChars - replacementChars;
  if (savedChars < BASH_REPLACEMENT_MIN_SAVED_CHARS) {
    return {
      ...keep(
        commandClass,
        "object",
        originalChars,
        "saving_below_threshold",
        `saved ${savedChars} chars, below the ${BASH_REPLACEMENT_MIN_SAVED_CHARS} char threshold`,
      ),
      digest,
    };
  }

  return {
    action: "replace",
    commandClass,
    payloadShape: "object",
    originalChars,
    digest,
    replacement: {
      updatedToolOutput: buildReplacementPayload(input.toolResponse, digest.text),
      digestText: digest.text,
      originalChars,
      replacementChars,
      savedChars,
    },
  };
}

/** The hook-input failures this module can be told about, as fixed identifiers. */
export type UnreadableHookInputKind = "empty" | "unparseable" | "not_object";

const UNREADABLE_HOOK_INPUT_DETAIL: Record<UnreadableHookInputKind, string> = {
  empty: "hook stdin was empty",
  unparseable: "hook stdin is not valid JSON",
  not_object: "hook stdin JSON is not an object",
};

/**
 * The decision for a hook payload that could not be read at all. Keeps the coverage denominator
 * honest: an input this layer never understood is recorded as a kept original, not dropped.
 *
 * Takes a KIND, never a message. A `JSON.parse` failure message embeds an excerpt of the input
 * it choked on — here, the PostToolUse payload, i.e. the command line and its output — and this
 * decision is written to a log whose whole contract is that it holds neither. Making the
 * parameter an enum is what stops that leak at the type level rather than by review.
 */
export function keepForUnreadableHookInput(kind: UnreadableHookInputKind): BashOutputReplacementDecision {
  return keep("unknown", "unreadable", 0, "unreadable_hook_input", UNREADABLE_HOOK_INPUT_DETAIL[kind]);
}

function keep(
  commandClass: BashCommandClass,
  payloadShape: BashReplacementPayloadShape,
  originalChars: number,
  keepReason: BashReplacementKeepReason,
  detail: string,
): BashOutputReplacementDecision & { action: "keep" } {
  return { action: "keep", commandClass, payloadShape, originalChars, keepReason, detail };
}

/** The payload as a plain record, or `undefined` for anything that is not one. */
function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}

function unknownFieldsOf(toolResponse: unknown): string[] {
  const record = asRecord(toolResponse);
  if (record === undefined) return [];
  return Object.keys(record).filter((field) => !KNOWN_FIELD_SET.has(field));
}

/**
 * Every exit status the payload spells out, in allowlist order. A field that is present but not
 * an integer yields a non-zero sentinel, so "present and unreadable" can never read as success.
 */
function exitStatusesOf(toolResponse: unknown): number[] {
  const record = asRecord(toolResponse);
  if (record === undefined) return [];

  const statuses: number[] = [];
  for (const field of BASH_EXIT_CODE_FIELDS) {
    const raw = record[field];
    if (raw === undefined || raw === null) continue;
    statuses.push(typeof raw === "number" && Number.isInteger(raw) ? raw : Number.NaN);
  }
  // NaN !== 0, so an unreadable spelling lands on the `exit_status_nonzero` branch.
  return statuses;
}

/**
 * Whether the command runs more than one program. The classifier tokenizes ACROSS separators
 * and only reports `unknown` when two different class words appear, so a chain whose second
 * segment has no class word at all (`pnpm test && node scripts/report.js`) still classifies as
 * a single class — and its second program's output would be digested by a parser that has
 * never seen that format.
 */
function isChainedCommand(command: string): boolean {
  return /[;|&]/.test(command);
}

/**
 * Rebuilds the payload by COPYING it and overwriting only the stream fields it already had.
 *
 * No key is added, none is removed, and the exit-status spelling the build chose (`returnCode`
 * vs `exit_code`) is echoed back untouched. The digest goes into whichever stream actually
 * carried the output, so the payload never ends up claiming that the stream the text came from
 * was empty. Blanking the other stream is sound only because `safeToReplace` already proved the
 * digest captured every notable line from BOTH of them (the engine digests them joined).
 */
function buildReplacementPayload(original: unknown, digestText: string): Record<string, unknown> {
  const source = asRecord(original) ?? {};
  const rebuilt: Record<string, unknown> = { ...source };

  const stdout = source["stdout"];
  const stderr = source["stderr"];
  const stdoutChars = typeof stdout === "string" ? stdout.length : -1;
  const stderrChars = typeof stderr === "string" ? stderr.length : -1;

  // `readBashToolResponse` rejects a payload with neither stream, so one of these is >= 0.
  if (stdoutChars >= stderrChars) {
    rebuilt["stdout"] = digestText;
    if (stderrChars >= 0) rebuilt["stderr"] = "";
  } else {
    // PowerShell-shaped payloads routinely put everything on stderr.
    rebuilt["stderr"] = digestText;
    if (stdoutChars >= 0) rebuilt["stdout"] = "";
  }

  return rebuilt;
}
