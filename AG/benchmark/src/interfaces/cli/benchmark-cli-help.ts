import {
  BENCHMARK_CLI_COMMANDS,
  BENCHMARK_CLI_OPTIONS,
  type BenchmarkCliCommand,
} from "./benchmark-cli-arguments.js";
import { BENCHMARK_EXIT_CODES, BENCHMARK_EXIT_CODE_MEANINGS, type BenchmarkExitCodeName } from "./benchmark-exit-codes.js";

/**
 * `ag benchmark --help`, rendered from the same tables the parser reads.
 *
 * Help is generated rather than written out because a hand-maintained usage
 * block drifts: it keeps advertising an option that was removed, or stays silent
 * about one that was added, and the caller who trusted it gets exit 2 from a
 * command the documentation said was valid. The exit-code table is printed for
 * the same reason — a script author has to know that 1 means "regressed" and 5
 * means "nothing was measured" before they write the `if`.
 */

const COMMAND_SUMMARIES: Readonly<Record<BenchmarkCliCommand, string>> = Object.freeze({
  "benchmark validate": "validate the frozen scenario suite and print its hash",
  "benchmark run": "execute the suite in the selected modes and store the samples",
  "benchmark baseline create": "seal the current run as a comparable baseline",
  "benchmark compare": "compare a stored baseline with the current samples",
  "benchmark report": "render the authoritative report as markdown or JSON on stdout",
  "benchmark verify": "re-derive acceptance for stored samples without running an agent",
});

/** Longest command name, so the two columns line up without a table library. */
const NAME_COLUMN = Math.max(
  ...BENCHMARK_CLI_COMMANDS.map((command) => command.replace(/^benchmark /, "").length),
);

function pad(text: string, width: number): string {
  return text.length >= width ? text : `${text}${" ".repeat(width - text.length)}`;
}

function commandLines(): readonly string[] {
  return BENCHMARK_CLI_COMMANDS.map(
    (command) =>
      `  ${pad(command.replace(/^benchmark /, ""), NAME_COLUMN)}  ${COMMAND_SUMMARIES[command]}`,
  );
}

function optionLines(): readonly string[] {
  const lines: string[] = [];
  for (const command of BENCHMARK_CLI_COMMANDS) {
    const options = BENCHMARK_CLI_OPTIONS[command];
    const names = Object.keys(options).sort();
    if (names.length === 0) continue;
    lines.push(`  ${command.replace(/^benchmark /, "")}`);
    const width = Math.max(...names.map((name) => name.length));
    for (const name of names) {
      const spec = options[name];
      if (spec === undefined) continue;
      const rendered = spec.kind === "value" ? `${name} <value>` : name;
      lines.push(`    ${pad(rendered, width + 8)}${spec.summary}`);
    }
  }
  return lines;
}

function exitCodeLines(): readonly string[] {
  const names = Object.keys(BENCHMARK_EXIT_CODES) as BenchmarkExitCodeName[];
  const width = Math.max(...names.map((name) => name.length));
  return names.map(
    (name) => `  ${BENCHMARK_EXIT_CODES[name]}  ${pad(name, width)}  ${BENCHMARK_EXIT_CODE_MEANINGS[name]}`,
  );
}

/** Deterministic: identical text for identical tables, so it can be asserted on. */
export function renderBenchmarkCliHelp(): string {
  return [
    "ag benchmark — measure what AG Loop costs and delivers (BENCH-10)",
    "",
    "Usage:",
    "  ag benchmark <command> [options]",
    "",
    "Commands:",
    ...commandLines(),
    "",
    "Options:",
    ...optionLines(),
    "",
    "Exit codes:",
    ...exitCodeLines(),
    "",
    "Network and paid model execution is off unless --allow-network (or --live) is given.",
    "--dry-run resolves the plan against the frozen suite and executes nothing.",
  ].join("\n");
}
