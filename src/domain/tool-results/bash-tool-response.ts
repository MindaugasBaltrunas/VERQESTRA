// PostToolUse Bash/PowerShell `tool_response` normalization (task 0026).
// Behaviour etalon: AG_loop domain/tool-results/bash-tool-response.ts.
//
// A PostToolUse payload is untrusted input from another program: its shape is set by the
// executor build that happens to be installed, not by this repository. Every reader here
// therefore answers exactly one of two things — "this is a Bash result I can read, and here
// are its fields" or "I cannot read this, and here is why". There is no third answer in
// which a missing field is silently treated as an empty stream or a zero exit code, because
// the digest engine downstream must never mistake an unread payload for a clean run.
//
// Pure domain module: no I/O, no clock, no environment. The hook layer hands it the already
// parsed `tool_response` value.

/**
 * Which documented payload form was recognized.
 *
 * `object` — the structured Bash result (`{stdout, stderr, interrupted, ...}`).
 * `text`   — a bare string result: unambiguous output text, but with no exit status at all.
 */
export type BashToolResponseShape = "object" | "text";

export type BashToolResponse = {
  stdout: string;
  stderr: string;
  interrupted: boolean;
  /** Absent when the payload carries no exit status — an absence, never a defaulted `0`. */
  exitCode?: number;
  shape: BashToolResponseShape;
};

export type BashToolResponseReading = { ok: true; value: BashToolResponse } | { ok: false; reason: string };

// Exit-status field names seen across executor builds and MCP shells. Reading several
// known spellings is not guessing — each is an explicit integer exit status; anything that
// is present but not an integer is rejected rather than coerced.
export const BASH_EXIT_CODE_FIELDS = ["exit_code", "exitCode", "returnCode", "return_code"] as const;

/**
 * Reads a PostToolUse `tool_response` value into the normalized Bash result shape.
 *
 * Rejects (never guesses) on: a non-object/non-string value, a `stdout`/`stderr` that is
 * present but not a string, a payload with neither stream, a non-boolean `interrupted`, a
 * non-integer exit status, and image payloads (not text this engine can reason about).
 */
export function readBashToolResponse(value: unknown): BashToolResponseReading {
  if (typeof value === "string") {
    // A bare string is unambiguous output text, but it carries no exit status; the digest
    // engine has to establish the outcome from the output itself or refuse.
    return { ok: true, value: { stdout: value, stderr: "", interrupted: false, shape: "text" } };
  }

  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return { ok: false, reason: "tool_response is neither an object nor a string" };
  }

  const record = value as Record<string, unknown>;

  const stdout = record["stdout"];
  if (stdout !== undefined && typeof stdout !== "string") {
    return { ok: false, reason: "tool_response.stdout is not a string" };
  }
  const stderr = record["stderr"];
  if (stderr !== undefined && typeof stderr !== "string") {
    return { ok: false, reason: "tool_response.stderr is not a string" };
  }
  if (stdout === undefined && stderr === undefined) {
    return { ok: false, reason: "tool_response carries neither stdout nor stderr" };
  }

  const interrupted = record["interrupted"];
  if (interrupted !== undefined && typeof interrupted !== "boolean") {
    return { ok: false, reason: "tool_response.interrupted is not a boolean" };
  }

  if (record["isImage"] === true || record["is_image"] === true) {
    return { ok: false, reason: "tool_response carries an image payload" };
  }

  const exitCode = readExitCode(record);
  if (exitCode === "invalid") {
    return { ok: false, reason: "tool_response exit status is not an integer" };
  }

  return {
    ok: true,
    value: {
      stdout: stdout ?? "",
      stderr: stderr ?? "",
      interrupted: interrupted ?? false,
      ...(exitCode === undefined ? {} : { exitCode }),
      shape: "object",
    },
  };
}

/** The two streams as one text, in the order a reader would see them. */
export function bashOutputRawText(response: BashToolResponse): string {
  return [response.stdout, response.stderr].filter((stream) => stream.length > 0).join("\n");
}

function readExitCode(record: Record<string, unknown>): number | undefined | "invalid" {
  for (const field of BASH_EXIT_CODE_FIELDS) {
    const raw = record[field];
    if (raw === undefined || raw === null) continue;
    if (typeof raw !== "number" || !Number.isInteger(raw)) return "invalid";
    return raw;
  }
  return undefined;
}
