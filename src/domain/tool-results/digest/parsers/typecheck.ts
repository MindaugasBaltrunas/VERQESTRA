// typecheck klasės parser'is: tsc diagnostika. Behaviour etalon: AG_loop
// domain/tool-results/bash-output-digest.ts (parseTypecheckOutput; WBR VQ-204 skaidymas).

import { emptyParse, type ClassParse } from "../model.js";

const TSC_DIAGNOSTIC_PAREN = /^(.+?)\((\d+),(\d+)\):\s*(error|warning)\s+(TS\d+):/;
const TSC_DIAGNOSTIC_COLON = /^(.+?):(\d+):(\d+)\s*-\s*(error|warning)\s+(TS\d+):/;
const TSC_FOUND_ERRORS = /^\s*Found\s+(\d+)\s+errors?\b/;

export function parseTypecheckOutput(lines: string[]): ClassParse {
  const parse = emptyParse();
  let errorDiagnostics = 0;
  let warningDiagnostics = 0;

  for (const line of lines) {
    const diagnostic = TSC_DIAGNOSTIC_PAREN.exec(line) ?? TSC_DIAGNOSTIC_COLON.exec(line);
    if (diagnostic) {
      parse.recognized = true;
      const [, file, row, column, severity, code] = diagnostic;
      if (code) parse.errorCodes.push(code);
      if (file && row) parse.locations.push(`${file.trim()}:${row}${column ? `:${column}` : ""}`);
      if (severity === "error") {
        errorDiagnostics += 1;
        parse.failureEvidence = true;
      } else {
        warningDiagnostics += 1;
      }
      continue;
    }

    const found = TSC_FOUND_ERRORS.exec(line);
    if (found?.[1] !== undefined) {
      parse.recognized = true;
      const count = Number(found[1]);
      parse.counts.errors = count;
      if (count > 0) parse.failureEvidence = true;
      else parse.successEvidence = true;
    }
  }

  if (parse.counts.errors === undefined && errorDiagnostics > 0) parse.counts.errors = errorDiagnostics;
  if (warningDiagnostics > 0) parse.counts.warnings = warningDiagnostics;
  return parse;
}
