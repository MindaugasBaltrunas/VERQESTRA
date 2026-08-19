// Parser dispatcher'is: viena žinoma komandų klasė → jos parser'is. Behaviour etalon:
// AG_loop domain/tool-results/bash-output-digest.ts (parseClassOutput; WBR VQ-204 skaidymas).

import type { BashCommandClass } from "../../bash-command-class.js";
import type { ClassParse } from "../model.js";
import { parseTestOutput } from "./test.js";
import { parseTypecheckOutput } from "./typecheck.js";
import { parseBuildOutput } from "./build.js";
import { parseLintOutput } from "./lint.js";

export function parseClassOutput(commandClass: Exclude<BashCommandClass, "unknown">, lines: string[]): ClassParse {
  switch (commandClass) {
    case "test":
      return parseTestOutput(lines);
    case "typecheck":
      return parseTypecheckOutput(lines);
    case "build":
      return parseBuildOutput(lines);
    case "lint":
      return parseLintOutput(lines);
  }
}
