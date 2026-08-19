// build klasės parser'is: dažniausiai tsc/bundler output'as plius package-manager žymės.
// Behaviour etalon: AG_loop domain/tool-results/bash-output-digest.ts (parseBuildOutput;
// WBR VQ-204 skaidymas).

import type { ClassParse } from "../model.js";
import { isLocationSource } from "../scan.js";
import { extractLocations } from "../extraction.js";
import { parseTypecheckOutput } from "./typecheck.js";

const BUILD_FAILURE_MARKERS =
  /(?:npm ERR!|ELIFECYCLE|Command failed|error during build|build failed|BUILD FAILED|Cannot find module)/i;
const BUILD_SUCCESS_MARKERS = /(?:built in|compiled successfully|build (?:succeeded|complete[d]?)|Done in\s+\d)/i;

export function parseBuildOutput(lines: string[]): ClassParse {
  // A build usually IS a compile: reuse the tsc diagnostics parser, then add the markers a
  // package manager / bundler prints around it.
  const parse = parseTypecheckOutput(lines);

  for (const line of lines) {
    if (BUILD_FAILURE_MARKERS.test(line)) {
      parse.recognized = true;
      parse.failureEvidence = true;
    }
    if (BUILD_SUCCESS_MARKERS.test(line)) {
      parse.recognized = true;
      parse.successEvidence = true;
    }
    if (isLocationSource(line)) parse.locations.push(...extractLocations(line));
  }

  return parse;
}
