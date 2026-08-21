// Dispatch task Markdown parsinimas context pack'ui. Behaviour etalon: AG_loop
// application/context-pack/assemble.ts (parseTaskMarkdown pusė; WBR VQ-302 skaidymas).

import { extractSection } from "../../../shared/markdown.js";
import { allowedPaths, taskBulletItems } from "../../../domain/tasks/index.js";
import { parseBacktickChecks } from "../../quality-gates/preflight-rules.js";
import type { RetrievedFragment } from "../../code-intelligence/retrieval/spec-fragments.js";
import type { RetrievalCandidate } from "../../code-intelligence/retrieval/ranking.js";

export type ParsedContextPackTask = {
  goal: string;
  allowedPaths: string[];
  specSources: string[];
  checks: string[];
  outOfScope: string[];
  acceptanceCriteria: string[];
  stopCondition: string;
};

export function parseTaskMarkdown(taskText: string, taskPath: string): ParsedContextPackTask {
  const goal = firstNonEmptyLine(extractSection(taskText, "## Tikslas"));
  const specSources = extractSection(taskText, "## Spec source")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const checks = parseBacktickChecks(taskText);
  const outOfScope = taskBulletItems(extractSection(taskText, "## Neįtraukta"));
  // `## Veiksmas` bullets plus `## Stop` are the task's own definition of done; they are
  // carried into the pack so the execution context can state acceptance criteria without
  // re-parsing the task markdown downstream.
  const acceptanceCriteria = taskBulletItems(extractSection(taskText, "## Veiksmas"));
  const stopCondition = extractSection(taskText, "## Stop").trim();
  const allowed = allowedPaths(taskText);

  const missing: string[] = [];
  if (!goal) missing.push("## Tikslas");
  if (allowed.length === 0) missing.push("## Failai/Leidžiama");
  if (checks.length === 0) missing.push("## Patikra");
  if (missing.length > 0) {
    throw new Error(`Malformed task ${taskPath}: missing ${missing.join(", ")}`);
  }

  return { goal, allowedPaths: allowed, specSources, checks, outOfScope, acceptanceCriteria, stopCondition };
}

function firstNonEmptyLine(text: string): string {
  return text.split(/\r?\n/).map((line) => line.trim()).find(Boolean) ?? "";
}

export function explicitAllowedPaths(allowed: string[]): string[] {
  return allowed.filter((entry) => !/[{*?]/.test(entry) && /\.[A-Za-z0-9]+$/.test(entry));
}

// The BM25-like tier ranks against what the task is actually trying to achieve: its goal
// plus its own acceptance criteria. Deterministic text, no clock, no repository scan.
export function retrievalQuery(parsedTask: { goal: string; acceptanceCriteria: string[] }): string {
  return [parsedTask.goal, ...parsedTask.acceptanceCriteria].join("\n");
}

export function toRetrievalCandidate(fragment: RetrievedFragment): RetrievalCandidate {
  const hashIndex = fragment.ref.indexOf("#");
  const requestedHeading = hashIndex === -1 ? "" : fragment.ref.slice(hashIndex + 1).trim();
  return {
    ref: fragment.ref,
    text: fragment.text,
    ...(requestedHeading ? { requestedHeading, headingMatched: fragment.headingMiss === undefined } : {}),
  };
}
