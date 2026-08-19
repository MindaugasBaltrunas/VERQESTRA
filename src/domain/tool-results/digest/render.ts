// Digest teksto atvaizdavimas: fiksuota sekcijų tvarka, vienas faktas eilutėje.
// Deterministic by construction: every list is already ordered by first appearance in the
// output. Behaviour etalon: AG_loop domain/tool-results/bash-output-digest.ts
// (renderBashDigest; WBR VQ-204 skaidymas).

import type { BashCommandClass } from "../bash-command-class.js";
import { BASH_DIGEST_VERSION, type BashOutputCounts, type BashOutputSignals } from "./model.js";

export function renderBashDigest(commandClass: BashCommandClass, signals: BashOutputSignals): string {
  const header = [
    `bash-digest v${BASH_DIGEST_VERSION}`,
    `class=${commandClass}`,
    `outcome=${signals.outcome}`,
    ...(signals.exitCode === undefined ? [] : [`exit=${signals.exitCode}`]),
  ].join(" ");

  const lines: string[] = [header];

  const counts = renderCounts(signals.counts);
  if (counts) lines.push(`counts: ${counts}`);

  if (signals.failedNames.length > 0) {
    lines.push("failed:", ...signals.failedNames.map((name) => `- ${name}`));
  }
  if (signals.errorCodes.length > 0) {
    lines.push(`codes: ${signals.errorCodes.join(", ")}`);
  }
  if (signals.locations.length > 0) {
    lines.push("at:", ...signals.locations.map((location) => `- ${location}`));
  }
  for (const expectation of signals.expectations) {
    lines.push(`expected: ${expectation.expected}`, `actual: ${expectation.actual}`);
  }
  if (signals.notableLines.length > 0) {
    lines.push("lines:", ...signals.notableLines.map((line) => `- ${line}`));
  }
  if (signals.tail !== undefined) {
    lines.push(`tail: ${signals.tail}`);
  }
  if (signals.truncated) {
    lines.push("truncated: diagnostic text was dropped or clipped; raw output remains authoritative");
  }

  return `${lines.join("\n")}\n`;
}

function renderCounts(counts: BashOutputCounts): string {
  return (["pass", "fail", "errors", "warnings"] as const)
    .filter((key) => counts[key] !== undefined)
    .map((key) => `${key}=${counts[key]}`)
    .join(" ");
}
