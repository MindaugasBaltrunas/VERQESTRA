// Deterministic Bash/PowerShell output digest engine — orkestruojantis modulis (task 0026).
// Invariantai — žr. model.ts antraštę (NEVER GUESS / NEVER LOSE A DIAGNOSTIC / SUCCESS ONLY).
// Pure domain module: no I/O, no clock, no environment. The same output always digests to
// the same bytes, which is what makes the shadow telemetry comparable across runs.
// Behaviour etalon: AG_loop domain/tool-results/bash-output-digest.ts (WBR VQ-204 skaidymas
// į model/scan/extraction/parsers/render/safety + šis orkestratorius).

import { classifyBashCommand, type BashCommandClass } from "../bash-command-class.js";
import { bashOutputRawText, type BashToolResponse } from "../bash-tool-response.js";
import { BASH_DIGEST_CAPS, type BashOutputDigest, type BashOutputSignals } from "./model.js";
import { capList, collectNotableLines, dedupe, fillCounts, splitLines, tailOf } from "./scan.js";
import { parseClassOutput } from "./parsers/class-parse.js";
import { renderBashDigest } from "./render.js";
import { decideSafeToReplace, resolveOutcome } from "./safety.js";

export type DigestBashOutputInput = {
  command: string;
  response: BashToolResponse;
};

/**
 * Digests one Bash/PowerShell tool result, or explains why it cannot.
 */
export function digestBashOutput(input: DigestBashOutputInput): BashOutputDigest {
  const commandClass = classifyBashCommand(input.command);
  const rawText = bashOutputRawText(input.response);
  const rawChars = rawText.length;

  if (commandClass === "unknown") {
    return unsupported(commandClass, "command class not recognized", rawChars);
  }

  const lines = splitLines(rawText);
  const parse = parseClassOutput(commandClass, lines);
  const notable = collectNotableLines(lines);

  // A silent command that exited 0 is recognized even without a format marker: there is
  // nothing to misread, and nothing to lose. Without a known exit status, silence proves
  // nothing and the payload stays unsupported.
  const silentSuccess = input.response.exitCode === 0 && notable.lines.length === 0;
  if (!parse.recognized && !silentSuccess) {
    return unsupported(commandClass, `output does not match a known ${commandClass} format`, rawChars);
  }

  const outcome = resolveOutcome(input.response, parse);
  if (outcome === undefined) {
    return unsupported(commandClass, "exit status not determinable from the payload", rawChars);
  }

  const failedNames = capList(dedupe(parse.failedNames), BASH_DIGEST_CAPS.failedNames);
  const errorCodes = capList(dedupe(parse.errorCodes), BASH_DIGEST_CAPS.errorCodes);
  const locations = capList(dedupe(parse.locations), BASH_DIGEST_CAPS.locations);
  const expectations = capList(parse.expectations, BASH_DIGEST_CAPS.expectations);
  const notableLines = capList(notable.lines, BASH_DIGEST_CAPS.notableLines);
  // A clipped tail counts as dropped diagnostic text like every other clip: task 0027 replaces
  // the raw output with this digest, so a summary line cut mid-sentence is information lost.
  const tail = outcome === "success" ? tailOf(lines) : { signal: {}, clipped: false };

  const signals: BashOutputSignals = {
    outcome,
    ...(input.response.exitCode === undefined ? {} : { exitCode: input.response.exitCode }),
    failedNames: failedNames.items,
    errorCodes: errorCodes.items,
    locations: locations.items,
    expectations: expectations.items,
    counts: fillCounts(parse.counts, notable),
    notableLines: notableLines.items,
    ...(outcome === "success" ? tail.signal : {}),
    truncated:
      tail.clipped ||
      notable.clipped ||
      failedNames.truncated ||
      errorCodes.truncated ||
      locations.truncated ||
      expectations.truncated ||
      notableLines.truncated,
  };

  const text = renderBashDigest(commandClass, signals);
  const digestChars = text.length;
  const safety = decideSafeToReplace(signals, rawChars, digestChars);

  return {
    status: "digested",
    commandClass,
    rawChars,
    digestChars,
    text,
    signals,
    safeToReplace: safety.safe,
    ...(safety.reason === undefined ? {} : { unsafeReason: safety.reason }),
  };
}

/**
 * The `unsupported` digest for a payload that never reached the engine — an unreadable
 * `tool_response`. Keeps the shadow telemetry's coverage denominator honest: a payload this
 * layer could not read is recorded, not dropped.
 */
export function unsupportedBashOutputDigest(command: string, reason: string): BashOutputDigest {
  return unsupported(classifyBashCommand(command), reason, 0);
}

function unsupported(commandClass: BashCommandClass, reason: string, rawChars: number): BashOutputDigest {
  return { status: "unsupported", commandClass, reason, rawChars };
}
