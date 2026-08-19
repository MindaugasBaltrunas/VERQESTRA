// lint klasės parser'is: eslint stylish formatas. Behaviour etalon: AG_loop
// domain/tool-results/bash-output-digest.ts (parseLintOutput; WBR VQ-204 skaidymas).

import { emptyParse, type ClassParse } from "../model.js";
import { pushName } from "../extraction.js";

const ESLINT_PROBLEM = /^\s*(\d+):(\d+)\s+(error|warning)\s+(.*?)(?:\s{2,}([\w@/.-]+))?\s*$/;
const ESLINT_SUMMARY = /(\d+)\s+problems?\s*\((\d+)\s+errors?,\s*(\d+)\s+warnings?\)/;
const ESLINT_FILE_HEADER = /^\s*(\S+\.(?:ts|tsx|js|jsx|mjs|cjs))\s*$/;

export function parseLintOutput(lines: string[]): ClassParse {
  const parse = emptyParse();
  let currentFile = "";
  let errorProblems = 0;
  let warningProblems = 0;

  for (const line of lines) {
    const header = ESLINT_FILE_HEADER.exec(line);
    if (header?.[1]) {
      currentFile = header[1];
      continue;
    }

    const problem = ESLINT_PROBLEM.exec(line);
    if (problem) {
      parse.recognized = true;
      const [, row, column, severity, message, rule] = problem;
      if (rule) parse.errorCodes.push(rule);
      parse.locations.push(`${currentFile || "<file>"}:${row ?? "?"}:${column ?? "?"}`);
      if (severity === "error") {
        errorProblems += 1;
        parse.failureEvidence = true;
        pushName(parse.failedNames, `${currentFile || "<file>"}:${row ?? "?"} ${message ?? ""}`);
      } else {
        warningProblems += 1;
      }
      continue;
    }

    const summary = ESLINT_SUMMARY.exec(line);
    if (summary) {
      parse.recognized = true;
      parse.counts.errors = Number(summary[2]);
      parse.counts.warnings = Number(summary[3]);
      if (Number(summary[1]) === 0) parse.successEvidence = true;
      if (Number(summary[2]) > 0) parse.failureEvidence = true;
    }
  }

  if (parse.counts.errors === undefined && errorProblems > 0) parse.counts.errors = errorProblems;
  if (parse.counts.warnings === undefined && warningProblems > 0) parse.counts.warnings = warningProblems;
  return parse;
}
