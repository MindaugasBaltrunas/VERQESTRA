import { EXECUTION_MODES, type ExecutionMode } from "../../application/benchmark-api.js";
import { BENCHMARK_REPORT_FORMATS, type BenchmarkReportFormat } from "../../application/benchmark-api.js";

/**
 * Argument contract for `ag benchmark` (BENCH-10).
 *
 * Everything here is pure: text in, a request or a refusal out. Parsing owns no
 * knowledge of what a suite contains, so it cannot decide that a scenario id is
 * unknown or that three repetitions are too few for a nondeterministic
 * scenario — those need the suite, and answering them here would put a second,
 * drifting copy of the suite rules in the delivery layer. The parser refuses
 * only what is wrong about the invocation itself.
 *
 * The consequence is deliberate: a usage error means nothing was measured and
 * nothing about the suite is implied, which is exactly what
 * `BENCHMARK_EXIT_CODES.usageError` promises.
 */

/** The command surface, fixed so the registry, CI and the release gate agree on it. */
export const BENCHMARK_CLI_COMMANDS = [
  "benchmark validate",
  "benchmark run",
  "benchmark baseline create",
  "benchmark compare",
  "benchmark report",
  "benchmark verify",
] as const;

export type BenchmarkCliCommand = (typeof BENCHMARK_CLI_COMMANDS)[number];

/**
 * BENCH-9 repeats a nondeterministic scenario at least three times, so three is
 * the default rather than an opt-in: a caller who does not think about
 * repetitions gets the number the specification requires, not the cheapest one.
 */
export const DEFAULT_REPETITIONS = 3;

/**
 * A ceiling on repetitions. Every repetition of a network mode is a paid model
 * call multiplied by the size of the suite, and a mistyped `--repetitions 300`
 * is indistinguishable from an intended one once the run has started.
 */
export const MAXIMUM_REPETITIONS = 25;

export interface BenchmarkValidateInvocation {
  readonly command: "benchmark validate";
  readonly json: boolean;
}

export interface BenchmarkRunInvocation {
  readonly command: "benchmark run";
  /** Empty means the whole suite; the suite decides whether a listed id exists. */
  readonly scenarioIds: readonly string[];
  readonly modes: readonly ExecutionMode[];
  readonly repetitions: number;
  /** Paid model and network execution stay off until this is stated explicitly. */
  readonly allowNetworkModels: boolean;
  /** Resolve and print the plan; execute nothing, write nothing. */
  readonly dryRun: boolean;
  readonly json: boolean;
}

export interface BenchmarkBaselineCreateInvocation {
  readonly command: "benchmark baseline create";
  readonly outPath: string | undefined;
  readonly json: boolean;
}

export interface BenchmarkCompareInvocation {
  readonly command: "benchmark compare";
  readonly baselinePath: string;
  readonly json: boolean;
}

export interface BenchmarkReportInvocation {
  readonly command: "benchmark report";
  readonly format: BenchmarkReportFormat;
  readonly baselinePath: string | undefined;
  readonly outPath: string | undefined;
}

export interface BenchmarkVerifyInvocation {
  readonly command: "benchmark verify";
  readonly samplesPath: string | undefined;
  readonly json: boolean;
}

/** `help` is a request like any other: it is asked for, answered, and exits `ok`. */
export interface BenchmarkHelpInvocation {
  readonly command: "help";
}

export type BenchmarkCliInvocation =
  | BenchmarkHelpInvocation
  | BenchmarkValidateInvocation
  | BenchmarkRunInvocation
  | BenchmarkBaselineCreateInvocation
  | BenchmarkCompareInvocation
  | BenchmarkReportInvocation
  | BenchmarkVerifyInvocation;

export type BenchmarkCliParse =
  | { readonly ok: true; readonly invocation: BenchmarkCliInvocation }
  | { readonly ok: false; readonly problem: string };

// ---------------------------------------------------------------------------
// Option declarations
// ---------------------------------------------------------------------------

/** Exported because `--help` is rendered from the option tables rather than written by hand. */
export interface OptionSpec {
  readonly kind: "boolean" | "value";
  /** A repeatable option may also be given once as a comma-separated list. */
  readonly repeatable?: boolean;
  readonly summary: string;
}

const JSON_OPTION: OptionSpec = {
  kind: "boolean",
  summary: "print the machine-readable result instead of the human summary",
};

/**
 * What each command accepts. The table is exported because `--help` is rendered
 * from it: a documented option that the parser rejects, or an accepted option
 * nobody documented, are both bugs this removes by construction.
 */
export const BENCHMARK_CLI_OPTIONS: Readonly<
  Record<BenchmarkCliCommand, Readonly<Record<string, OptionSpec>>>
> = Object.freeze({
  "benchmark validate": { "--json": JSON_OPTION },
  "benchmark run": {
    "--scenario": {
      kind: "value",
      repeatable: true,
      summary: "restrict the run to these scenario ids (repeatable, or comma-separated)",
    },
    "--mode": {
      kind: "value",
      repeatable: true,
      summary: `execution modes to run (${EXECUTION_MODES.join(", ")}); default: all`,
    },
    "--repetitions": {
      kind: "value",
      summary: `samples per scenario and mode (1-${MAXIMUM_REPETITIONS}, default ${DEFAULT_REPETITIONS})`,
    },
    "--allow-network": {
      kind: "boolean",
      summary: "permit modes that reach a paid model over the network",
    },
    "--live": { kind: "boolean", summary: "alias of --allow-network" },
    "--dry-run": { kind: "boolean", summary: "resolve and print the plan; execute nothing" },
    "--json": JSON_OPTION,
  },
  "benchmark baseline create": {
    "--out": { kind: "value", summary: "file to write the sealed baseline document to" },
    "--json": JSON_OPTION,
  },
  "benchmark compare": {
    "--baseline": { kind: "value", summary: "baseline document to compare against (required)" },
    "--json": JSON_OPTION,
  },
  "benchmark report": {
    "--format": {
      kind: "value",
      summary: `report format (${BENCHMARK_REPORT_FORMATS.join(", ")}); default: markdown`,
    },
    "--baseline": { kind: "value", summary: "include the comparison against this baseline" },
    "--out": { kind: "value", summary: "file to write the report to" },
  },
  "benchmark verify": {
    "--samples": { kind: "value", summary: "sample ledger to re-derive acceptance from" },
    "--json": JSON_OPTION,
  },
});

/**
 * The command words, longest first, so `baseline create` is matched before the
 * bare `baseline` that a two-word command would otherwise shadow.
 */
const COMMAND_WORDS: readonly { readonly words: readonly string[]; readonly command: BenchmarkCliCommand }[] =
  BENCHMARK_CLI_COMMANDS.map((command) => ({
    words: command.split(" ").slice(1),
    command,
  })).sort((left, right) => right.words.length - left.words.length);

const HELP_FLAGS = new Set(["--help", "-h", "help"]);

// ---------------------------------------------------------------------------
// Raw option scanning
// ---------------------------------------------------------------------------

interface ScannedOptions {
  readonly flags: ReadonlySet<string>;
  readonly values: ReadonlyMap<string, readonly string[]>;
}

type ScanResult = { readonly ok: true; readonly scanned: ScannedOptions } | { readonly ok: false; readonly problem: string };

function knownOptionList(specs: Readonly<Record<string, OptionSpec>>): string {
  return Object.keys(specs).sort().join(", ");
}

/**
 * Reads `--flag`, `--option value` and `--option=value` against one command's
 * declared options. An unknown option is refused rather than ignored: a
 * misspelled `--allow-netwrok` that silently parsed would run the whole suite
 * against a paid model without the permission the caller believed they gave.
 */
function scanOptions(tokens: readonly string[], command: BenchmarkCliCommand): ScanResult {
  const specs = BENCHMARK_CLI_OPTIONS[command];
  const flags = new Set<string>();
  const values = new Map<string, string[]>();

  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (!token.startsWith("-")) {
      return {
        ok: false,
        problem: `${command}: unexpected argument "${token}"; this command takes options only (${knownOptionList(specs)})`,
      };
    }

    const separator = token.indexOf("=");
    const name = separator === -1 ? token : token.slice(0, separator);
    const inlineValue = separator === -1 ? undefined : token.slice(separator + 1);
    const spec = specs[name];
    if (spec === undefined) {
      return {
        ok: false,
        problem: `${command}: unknown option "${name}"; known options are ${knownOptionList(specs)}`,
      };
    }

    if (spec.kind === "boolean") {
      if (inlineValue !== undefined) {
        return { ok: false, problem: `${command}: "${name}" is a flag and takes no value` };
      }
      flags.add(name);
      continue;
    }

    let value = inlineValue;
    if (value === undefined) {
      const next = tokens[index + 1];
      if (next === undefined || next.startsWith("-")) {
        return { ok: false, problem: `${command}: "${name}" requires a value` };
      }
      value = next;
      index += 1;
    }
    if (value.trim() === "") {
      return { ok: false, problem: `${command}: "${name}" requires a non-empty value` };
    }

    const existing = values.get(name);
    if (existing === undefined) {
      values.set(name, [value]);
      continue;
    }
    if (spec.repeatable !== true) {
      return { ok: false, problem: `${command}: "${name}" was given more than once` };
    }
    existing.push(value);
  }

  return { ok: true, scanned: { flags, values } };
}

/** Splits the comma form of a repeatable option and drops the empty segments a trailing comma leaves. */
function listValues(scanned: ScannedOptions, name: string): readonly string[] {
  const raw = scanned.values.get(name) ?? [];
  const seen = new Set<string>();
  for (const entry of raw) {
    for (const part of entry.split(",")) {
      const trimmed = part.trim();
      if (trimmed !== "") seen.add(trimmed);
    }
  }
  return [...seen];
}

function singleValue(scanned: ScannedOptions, name: string): string | undefined {
  return scanned.values.get(name)?.[0];
}

// ---------------------------------------------------------------------------
// Per-command interpretation
// ---------------------------------------------------------------------------

/**
 * Every option reader answers in the same shape. A bare union of "the value" and
 * "the problem" would be ambiguous the moment the value is itself a string, so
 * the discriminant is carried explicitly rather than inferred from the type.
 */
type Read<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly problem: string };

function parseRepetitions(raw: string | undefined, command: BenchmarkCliCommand): Read<number> {
  if (raw === undefined) return { ok: true, value: DEFAULT_REPETITIONS };
  if (!/^\d+$/.test(raw)) {
    return { ok: false, problem: `${command}: "--repetitions" expects a whole number, received "${raw}"` };
  }
  const value = Number.parseInt(raw, 10);
  if (value < 1 || value > MAXIMUM_REPETITIONS) {
    return {
      ok: false,
      problem: `${command}: "--repetitions" expects a value between 1 and ${MAXIMUM_REPETITIONS}, received ${value}`,
    };
  }
  return { ok: true, value };
}

function parseModes(raw: readonly string[], command: BenchmarkCliCommand): Read<readonly ExecutionMode[]> {
  if (raw.length === 0) return { ok: true, value: EXECUTION_MODES };
  const modes: ExecutionMode[] = [];
  for (const candidate of raw) {
    const mode = EXECUTION_MODES.find((known) => known === candidate);
    if (mode === undefined) {
      return {
        ok: false,
        problem: `${command}: "${candidate}" is not an execution mode; expected one of ${EXECUTION_MODES.join(", ")}`,
      };
    }
    modes.push(mode);
  }
  return { ok: true, value: modes };
}

function parseFormat(raw: string | undefined, command: BenchmarkCliCommand): Read<BenchmarkReportFormat> {
  if (raw === undefined) return { ok: true, value: "markdown" };
  const format = BENCHMARK_REPORT_FORMATS.find((known) => known === raw);
  if (format === undefined) {
    return {
      ok: false,
      problem: `${command}: "${raw}" is not a report format; expected one of ${BENCHMARK_REPORT_FORMATS.join(", ")}`,
    };
  }
  return { ok: true, value: format };
}

function buildInvocation(command: BenchmarkCliCommand, scanned: ScannedOptions): BenchmarkCliParse {
  const json = scanned.flags.has("--json");

  switch (command) {
    case "benchmark validate":
      return { ok: true, invocation: { command, json } };

    case "benchmark run": {
      const repetitions = parseRepetitions(singleValue(scanned, "--repetitions"), command);
      if (!repetitions.ok) return { ok: false, problem: repetitions.problem };
      const modes = parseModes(listValues(scanned, "--mode"), command);
      if (!modes.ok) return { ok: false, problem: modes.problem };
      return {
        ok: true,
        invocation: {
          command,
          scenarioIds: listValues(scanned, "--scenario"),
          modes: modes.value,
          repetitions: repetitions.value,
          allowNetworkModels: scanned.flags.has("--allow-network") || scanned.flags.has("--live"),
          dryRun: scanned.flags.has("--dry-run"),
          json,
        },
      };
    }

    case "benchmark baseline create":
      return { ok: true, invocation: { command, outPath: singleValue(scanned, "--out"), json } };

    case "benchmark compare": {
      const baselinePath = singleValue(scanned, "--baseline");
      if (baselinePath === undefined) {
        return {
          ok: false,
          problem: `${command}: "--baseline" is required; a comparison without a stated baseline compares nothing`,
        };
      }
      return { ok: true, invocation: { command, baselinePath, json } };
    }

    case "benchmark report": {
      const format = parseFormat(singleValue(scanned, "--format"), command);
      if (!format.ok) return { ok: false, problem: format.problem };
      return {
        ok: true,
        invocation: {
          command,
          format: format.value,
          baselinePath: singleValue(scanned, "--baseline"),
          outPath: singleValue(scanned, "--out"),
        },
      };
    }

    case "benchmark verify":
      return {
        ok: true,
        invocation: { command, samplesPath: singleValue(scanned, "--samples"), json },
      };

    default:
      // `command` is `never` here; the branch exists so adding a command to
      // BENCHMARK_CLI_COMMANDS without handling it fails to compile.
      return { ok: false, problem: `unhandled benchmark command: ${String(command)}` };
  }
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/**
 * `argv` is what follows `ag benchmark`. An empty invocation is help rather than
 * an error: a caller who does not yet know the surface should be shown it, not
 * scolded with exit 2.
 */
export function parseBenchmarkCliArguments(argv: readonly string[]): BenchmarkCliParse {
  const tokens = [...argv];
  if (tokens.length === 0 || tokens.some((token) => HELP_FLAGS.has(token))) {
    return { ok: true, invocation: { command: "help" } };
  }

  const match = COMMAND_WORDS.find((candidate) =>
    candidate.words.every((word, offset) => tokens[offset] === word),
  );
  if (match === undefined) {
    const known = BENCHMARK_CLI_COMMANDS.map((command) => command.replace(/^benchmark /, "")).join(", ");
    return {
      ok: false,
      problem: `benchmark: unknown command "${tokens[0]}"; known commands are ${known}`,
    };
  }

  const scan = scanOptions(tokens.slice(match.words.length), match.command);
  if (!scan.ok) return { ok: false, problem: scan.problem };
  return buildInvocation(match.command, scan.scanned);
}
