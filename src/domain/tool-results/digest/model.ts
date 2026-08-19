// Bash/PowerShell output digest — vertybiniai tipai, capai ir parse modelis (task 0026).
// Behaviour etalon: AG_loop domain/tool-results/bash-output-digest.ts (modelio pusė;
// WBR VQ-204 skaidymas). Pure: no I/O, no clock, no environment.
//
// TRYS INVARIANTAI, svarbos tvarka:
//  1. NEVER GUESS — nežinoma komandų klasė, formato žymės neturintis output'as ar
//     nenustatomas exit statusas grąžina `unsupported` (normalus atsakymas, ne klaida).
//  2. NEVER LOSE A DIAGNOSTIC — viskas, kas gali nešti klaidos priežastį, į digest'ą
//     patenka pažodžiui; cap'as ar clip'as, numetęs bet ką, žymi digest'ą nesaugiu.
//  3. SUCCESS ONLY — net tobulas FAILED run'o digest'as niekada nėra safe to replace.

import type { BashCommandClass } from "../bash-command-class.js";

/** Digest format version — bumped when the rendered text stops being comparable. */
export const BASH_DIGEST_VERSION = 1;

/**
 * How much of each signal the digest keeps verbatim. Hitting a cap does not truncate
 * silently: it flags the digest unsafe, so a capped digest can still be measured but can
 * never replace the output it truncated.
 */
export const BASH_DIGEST_CAPS = {
  failedNames: 20,
  errorCodes: 20,
  locations: 20,
  expectations: 5,
  notableLines: 40,
  /** Per-line clip for a single diagnostic line (stack dumps, JSON blobs). */
  lineChars: 300,
  /** Clip for the trailing summary line kept for long successful output. */
  tailChars: 200,
} as const;

export type BashOutputOutcome = "success" | "failure" | "interrupted";

export type BashOutputCounts = {
  pass?: number;
  fail?: number;
  errors?: number;
  warnings?: number;
};

export type BashExpectation = { expected: string; actual: string };

export type BashOutputSignals = {
  outcome: BashOutputOutcome;
  exitCode?: number;
  /** Names of the checks/tests that failed, as the runner printed them. */
  failedNames: string[];
  /** Diagnostic codes (`TS2307`, `ERR_ASSERTION`, ESLint rule ids). */
  errorCodes: string[];
  /** `file:line[:col]` positions extracted from diagnostics and stacks. */
  locations: string[];
  expectations: BashExpectation[];
  counts: BashOutputCounts;
  /** Every warning/error/failure line, verbatim (capped, see {@link BASH_DIGEST_CAPS}). */
  notableLines: string[];
  /** Last non-empty line of a successful run — the runner's own summary. */
  tail?: string;
  /** True when a cap or a line clip dropped characters that were in the raw output. */
  truncated: boolean;
};

export type BashOutputDigest =
  | {
      status: "unsupported";
      commandClass: BashCommandClass;
      reason: string;
      rawChars: number;
    }
  | {
      status: "digested";
      commandClass: BashCommandClass;
      rawChars: number;
      digestChars: number;
      /** The digest itself. Deterministic for a given command + output. */
      text: string;
      signals: BashOutputSignals;
      safeToReplace: boolean;
      /** Why the digest may not replace the raw output; absent when it may. */
      unsafeReason?: string;
    };

/** Vienos komandų klasės parser'io rezultatas — bendras visų keturių parser'ių modelis. */
export type ClassParse = {
  failedNames: string[];
  errorCodes: string[];
  locations: string[];
  expectations: BashExpectation[];
  counts: BashOutputCounts;
  /** The output showed at least one marker of this class's format. */
  recognized: boolean;
  failureEvidence: boolean;
  successEvidence: boolean;
};

export function emptyParse(): ClassParse {
  return {
    failedNames: [],
    errorCodes: [],
    locations: [],
    expectations: [],
    counts: {},
    recognized: false,
    failureEvidence: false,
    successEvidence: false,
  };
}
