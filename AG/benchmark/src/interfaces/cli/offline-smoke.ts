import { runBenchmarkCommand, type BenchmarkCliCompositionOptions } from "./benchmark-cli-composition.js";
import { BENCHMARK_EXIT_CODES, type BenchmarkExitCodeName } from "./benchmark-exit-codes.js";

/**
 * The deterministic offline smoke of `ag benchmark` (BENCH-12).
 *
 * BENCH-12 lets a pull request run `validate`, the unit and fixture tests, and a
 * deterministic smoke — and nothing that reaches a paid model. The unit tests
 * already cover the rules; what they cannot cover is the assembled command: the
 * parser, the composition root, the authored suite and the exit-code contract
 * behaving as one thing. That is what this smoke exercises, and it is why it runs
 * the real CLI against the real package rather than a fixture.
 *
 * Two properties make it safe to run on every pull request:
 *
 * - **No check may name a paid-model flag.** {@link PAID_MODEL_ARGUMENTS} is
 *   checked against every declared invocation before any of them runs, so a flag
 *   added to a check in a later edit fails the smoke instead of spending money on
 *   a fork's pull request.
 * - **The refusals are checks too.** Two invocations ask for a networked mode
 *   without permission and are required to be refused with `validationFailed`.
 *   A regression that made `--allow-network` optional would turn those two into
 *   failures here rather than into a bill.
 *
 * Nothing here asserts a metric or a verdict: the smoke's question is whether the
 * command works and stays offline, not what the benchmark measured.
 */

/** Arguments that permit paid, networked execution. No smoke check may carry one. */
export const PAID_MODEL_ARGUMENTS: readonly string[] = Object.freeze(["--allow-network", "--live"]);

export interface OfflineSmokeCheck {
  readonly id: string;
  /** What follows `ag benchmark`. */
  readonly argv: readonly string[];
  readonly expect: BenchmarkExitCodeName;
  /** Why this invocation is part of the gate — read by whoever has to change it. */
  readonly why: string;
}

/**
 * The invocations the smoke runs, in order.
 *
 * `run --dry-run` resolves the whole suite against the plan and executes nothing,
 * so it is a real end-to-end exercise of parsing, suite loading and plan
 * resolution at zero cost. The repetition count is left at the default, because
 * lowering it would make the plan refuse the suite's nondeterministic scenarios
 * (BENCH-9) and the smoke would then be asserting a limit rather than a plan.
 */
export const OFFLINE_SMOKE_CHECKS: readonly OfflineSmokeCheck[] = Object.freeze([
  Object.freeze({
    id: "suite-validates",
    argv: Object.freeze(["validate", "--json"]),
    expect: "ok" as const,
    why: "an invalid suite makes every number measured against it unattributable (BENCH-2, BENCH-8)",
  }),
  Object.freeze({
    id: "deterministic-plan-resolves",
    argv: Object.freeze(["run", "--dry-run", "--mode", "deterministic-control", "--json"]),
    expect: "ok" as const,
    why: "the deterministic control calls no model, so its plan must resolve without any permission",
  }),
  Object.freeze({
    id: "unknown-scenario-refused",
    argv: Object.freeze([
      "run",
      "--dry-run",
      "--mode",
      "deterministic-control",
      "--scenario",
      "no-such-scenario",
    ]),
    expect: "validationFailed" as const,
    why: "a scenario id the suite does not declare must be refused rather than silently skipped",
  }),
  Object.freeze({
    id: "network-mode-refused-in-plan",
    argv: Object.freeze(["run", "--dry-run", "--mode", "ag-loop"]),
    expect: "validationFailed" as const,
    why: "a networked mode without --allow-network must be refused while resolving the plan",
  }),
  Object.freeze({
    id: "network-run-refused-before-execution",
    argv: Object.freeze(["run", "--mode", "agent-solo"]),
    expect: "validationFailed" as const,
    why: "the same refusal must happen for a live run too, before anything is spent",
  }),
]);

export interface OfflineSmokeResult {
  readonly check: OfflineSmokeCheck;
  readonly expectedExitCode: number;
  readonly actualExitCode: number;
  readonly passed: boolean;
  /** Everything the invocation wrote, both streams, in the order it was written. */
  readonly output: readonly string[];
}

export interface OfflineSmokeReport {
  readonly passed: boolean;
  readonly results: readonly OfflineSmokeResult[];
}

/**
 * Raised when a declared check would permit paid execution.
 *
 * A thrown error rather than a failed result: a smoke that reported "one check
 * failed" would have already run the other invocations, and the point is that
 * this one never runs at all.
 */
export class PaidModelArgumentError extends Error {
  constructor(checkId: string, argument: string) {
    super(
      `The offline smoke check "${checkId}" declares "${argument}", which permits paid model execution. ` +
        "The smoke runs on every pull request and must stay offline (BENCH-12).",
    );
    this.name = "PaidModelArgumentError";
  }
}

/**
 * Refuses any check that would reach a paid model. Exported so a test can assert
 * the guard itself, rather than only the list it currently guards.
 */
export function assertOfflineArguments(checks: readonly OfflineSmokeCheck[] = OFFLINE_SMOKE_CHECKS): void {
  for (const check of checks) {
    for (const argument of check.argv) {
      // Compared on the option name so `--allow-network=true` is caught as well.
      const name = argument.split("=")[0];
      if (PAID_MODEL_ARGUMENTS.includes(name)) throw new PaidModelArgumentError(check.id, name);
    }
  }
}

export interface RunOfflineSmokeOptions extends BenchmarkCliCompositionOptions {
  /** Overridable so a test can run the smoke against a fixture package. */
  readonly checks?: readonly OfflineSmokeCheck[];
}

/**
 * Runs every check and reports what each one answered.
 *
 * Execution continues after a failure: one report that names all the broken
 * invocations is worth more to whoever has to fix them than the first one to
 * fail, and no check costs anything to run.
 */
export async function runOfflineSmoke(options: RunOfflineSmokeOptions = {}): Promise<OfflineSmokeReport> {
  const checks = options.checks ?? OFFLINE_SMOKE_CHECKS;
  assertOfflineArguments(checks);

  const compositionOptions: BenchmarkCliCompositionOptions =
    options.packageRoot === undefined ? {} : { packageRoot: options.packageRoot };

  const results: OfflineSmokeResult[] = [];
  for (const check of checks) {
    const output: string[] = [];
    const collect = (line: string): void => {
      output.push(line);
    };
    const actualExitCode = await runBenchmarkCommand(
      check.argv,
      { out: collect, err: collect },
      compositionOptions,
    );
    const expectedExitCode = BENCHMARK_EXIT_CODES[check.expect];
    results.push({
      check,
      expectedExitCode,
      actualExitCode,
      passed: actualExitCode === expectedExitCode,
      output,
    });
  }

  return { passed: results.every((result) => result.passed), results };
}

/**
 * The smoke as lines a CI log can be read from: one line per check, and the
 * output of a failed one so the log carries the diagnosis instead of only the
 * verdict.
 */
export function renderOfflineSmokeReport(report: OfflineSmokeReport): readonly string[] {
  const lines: string[] = [];
  for (const result of report.results) {
    lines.push(
      `${result.passed ? "ok  " : "FAIL"} ${result.check.id} ` +
        `(expected ${result.check.expect}=${result.expectedExitCode}, got ${result.actualExitCode})`,
    );
    if (result.passed) continue;
    lines.push(`     ${result.check.why}`);
    for (const line of result.output) lines.push(`     | ${line}`);
  }
  lines.push(
    report.passed
      ? `offline smoke: ${report.results.length} check(s) passed, no model was called`
      : `offline smoke: ${report.results.filter((result) => !result.passed).length} of ${report.results.length} check(s) failed`,
  );
  return lines;
}
