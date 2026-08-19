// Command classification for the Bash output digest (task 0026).
// Behaviour etalon: AG_loop domain/tool-results/bash-command-class.ts.
//
// The digest engine only parses output formats it actually knows, and it knows them per
// command class. Classification is therefore a gate, not a hint: a command this module
// cannot place in exactly one class yields `unknown`, and the engine refuses to digest it.
//
// Deliberately token-based rather than substring-based. `dist/tests` contains "test" and
// path segments contain no class word at all; matching whole argv tokens is what keeps
// a path from being read as a command verb. Ambiguity (`npm run build && npm test`) also
// yields `unknown` — two formats in one stream is exactly where a single-format parser would
// silently drop half the diagnostics.
//
// Pure domain module: no I/O, no clock, no environment.

export type BashCommandClass = "test" | "typecheck" | "build" | "lint" | "unknown";

// One anchored pattern per class, matched against whole tokens. The `(:\S*)?` tail covers
// script-name variants (`test:ui`, `build:all`, `lint:fix`) that npm/pnpm scripts use.
const CLASS_TOKEN_PATTERNS: ReadonlyArray<readonly [Exclude<BashCommandClass, "unknown">, RegExp]> = [
  ["typecheck", /^(?:typecheck|type-check|tsc)(?::\S*)?$/],
  ["test", /^(?:--test|test|tests|vitest|jest|mocha|pytest|ava)(?::\S*)?$/],
  ["build", /^(?:build|compile)(?::\S*)?$/],
  ["lint", /^(?:lint|eslint)(?::\S*)?$/],
];

/**
 * The single class a command belongs to, or `unknown` when it belongs to none or to more
 * than one. Case-insensitive and separator-agnostic, so the POSIX (`pnpm --dir x test`) and
 * PowerShell (`pnpm --dir x test; npm run build`) spellings classify identically.
 */
export function classifyBashCommand(command: string): BashCommandClass {
  const matched = new Set<BashCommandClass>();

  for (const token of tokenizeCommand(command)) {
    for (const [commandClass, pattern] of CLASS_TOKEN_PATTERNS) {
      if (pattern.test(token)) matched.add(commandClass);
    }
  }

  const [only] = [...matched];
  return matched.size === 1 && only !== undefined ? only : "unknown";
}

/**
 * Argv-ish tokens: split on whitespace and shell separators, strip surrounding quotes,
 * parentheses and trailing punctuation, lowercase. PowerShell's call operator (`&`) and
 * chaining (`;`, `&&`, `|`) are separators here, so a chained command yields the tokens of
 * every segment — which is how ambiguity gets detected instead of hidden.
 */
function tokenizeCommand(command: string): string[] {
  return command
    .split(/[\s;|&]+/)
    .map((token) => token.replace(/^["'`(]+/, "").replace(/["'`),]+$/, "").toLowerCase())
    .filter((token) => token.length > 0);
}
