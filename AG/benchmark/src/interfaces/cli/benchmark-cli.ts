import {
  type BenchmarkApplicationApi,
  type BenchmarkRunPlan,
  type BenchmarkRunRequest,
  type BenchmarkRunSummary,
  type BenchmarkBaseline,
  type BenchmarkComparison,
  type BenchmarkSample,
  type SuiteValidationReport,
} from "../../application/benchmark-api.js";
import {
  parseBenchmarkCliArguments,
  type BenchmarkBaselineCreateInvocation,
  type BenchmarkCliInvocation,
  type BenchmarkCompareInvocation,
  type BenchmarkReportInvocation,
  type BenchmarkRunInvocation,
  type BenchmarkVerifyInvocation,
} from "./benchmark-cli-arguments.js";
import { renderBenchmarkCliHelp } from "./benchmark-cli-help.js";
import { BENCHMARK_EXIT_CODES, type BenchmarkExitCode } from "./benchmark-exit-codes.js";

/**
 * The `verqestra benchmark` adapter (BENCH-10).
 *
 * It parses, calls the application API, renders, and turns an outcome into an
 * exit code. It owns no benchmark rule: no metric is computed here, no verdict
 * is decided here, and no threshold is read here. A delivery layer that computed
 * even one of those would eventually disagree with the report and the UI about
 * the same run, and the caller has no way to tell which of the three is
 * authoritative (BENCH-11).
 *
 * Output goes through the injected io rather than `console`, so the orchestrator
 * can route it and the contract tests can assert on it without capturing global
 * state.
 */

export interface BenchmarkCliIo {
  readonly out: (line: string) => void;
  readonly err: (line: string) => void;
}

/**
 * What the CLI needs beyond the API itself: the stored artefacts a command names
 * on the command line. Resolving `--baseline <file>` into a `BenchmarkBaseline`
 * is composition work — it needs a filesystem and the baseline schema — and
 * doing it here would put document loading in the layer whose job is to print.
 */
export interface BenchmarkCliPorts {
  readonly api: BenchmarkApplicationApi;
  /** Reads and validates a stored baseline document. */
  loadBaseline(path: string): Promise<BenchmarkBaseline>;
  /**
   * Every stored sample of a ledger, or an error; never a partial set. Without a
   * path, the ledger of the most recent run — and a package with no run refuses
   * rather than answering with an empty list.
   */
  loadSamples(path: string | undefined): Promise<readonly BenchmarkSample[]>;
  /** The current run summary the stored samples add up to. */
  loadCurrentSummary(): Promise<BenchmarkRunSummary>;
  /**
   * Seals a baseline to a file and answers with the package-relative path it was
   * written to. A baseline nobody can name is a baseline `compare` cannot be
   * pointed at, so creating one and storing it are one command.
   */
  saveBaseline(baseline: BenchmarkBaseline, outPath: string | undefined): Promise<string>;
  /** Writes a rendered report to a package-relative path and answers with it. */
  writeReport(content: string, outPath: string): Promise<string>;
}

export interface BenchmarkCliDependencies extends BenchmarkCliIo {
  /**
   * Built on demand: a usage error, and `--help`, must not pay for opening a
   * repository or reading a suite, and must not fail because one is missing.
   */
  readonly createPorts: () => BenchmarkCliPorts | Promise<BenchmarkCliPorts>;
}

/**
 * Errors that describe a refused *input* rather than a broken harness.
 *
 * Matched by name rather than by class so this module stays free of the
 * infrastructure layer: `BenchmarkPathEscapeError` is thrown by the workspace
 * path resolver, and importing it here would make the printer depend on the
 * filesystem adapter it is meant to be independent of. The application errors
 * below are imported properly where they are thrown.
 */
const INPUT_REFUSAL_ERROR_NAMES: ReadonlySet<string> = new Set([
  "SampleLedgerIntegrityError",
  "BenchmarkSampleRejectedError",
  "BenchmarkPathEscapeError",
  "BenchmarkRunRefusedError",
  "BenchmarkRunNotExecutedError",
]);

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function classifyError(error: unknown): BenchmarkExitCode {
  if (error instanceof Error && INPUT_REFUSAL_ERROR_NAMES.has(error.name)) {
    return BENCHMARK_EXIT_CODES.validationFailed;
  }
  // Anything else reached the delivery layer as a thrown value rather than as a
  // refusal, which by definition is the harness failing rather than the request
  // being wrong.
  return BENCHMARK_EXIT_CODES.infrastructureError;
}

function asJson(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function renderValidation(report: SuiteValidationReport): readonly string[] {
  if (report.problems.length === 0) {
    return [`suite valid: ${report.scenarioCount} scenarios, hash ${report.suiteHash}`];
  }
  return [
    `suite invalid: ${report.problems.length} problem(s) in ${report.scenarioCount} scenario(s)`,
    ...report.problems.map((problem) => `  - ${problem}`),
  ];
}

function renderPlan(plan: BenchmarkRunPlan): readonly string[] {
  const lines = [
    `dry run: ${plan.sampleCount} sample(s) would be executed`,
    `  suite       ${plan.suiteHash === "" ? "(refused)" : plan.suiteHash}`,
    `  scenarios   ${plan.scenarioIds.length === 0 ? "(none)" : plan.scenarioIds.join(", ")}`,
    `  modes       ${plan.modes.join(", ")}`,
    `  repetitions ${plan.repetitions}`,
    `  network     ${plan.allowNetworkModels ? "allowed" : "refused (pass --allow-network to permit paid model calls)"}`,
  ];
  if (plan.problems.length > 0) {
    lines.push("problems:", ...plan.problems.map((problem) => `  - ${problem}`));
  }
  return lines;
}

function renderSummary(summary: BenchmarkRunSummary): readonly string[] {
  const perMode = new Map<string, number>();
  for (const sample of summary.samples) {
    perMode.set(sample.mode, (perMode.get(sample.mode) ?? 0) + 1);
  }
  const unmeasured = summary.unmeasured ?? [];
  return [
    `samples: ${summary.samples.length}`,
    ...[...perMode.entries()]
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .map(([mode, count]) => `  ${mode}: ${count}`),
    // Printed beside the sample count rather than below the fold: a suite that scored badly and a
    // harness that did not run produce the same sample count, and this is the line that tells a
    // reader which one they are looking at.
    ...(unmeasured.length === 0
      ? []
      : [
          `unmeasured: ${unmeasured.length} cell(s) produced no measurement`,
          ...unmeasured.map(
            (cell) => `  ${cell.scenarioId} (${cell.mode}, r${cell.repetition}): ${cell.reason}`,
          ),
        ]),
    `suite: ${summary.identity.suiteHash}`,
    `environment: ${summary.environment.platform}/${summary.environment.arch}, node ${summary.environment.nodeVersion}`,
  ];
}

function renderComparison(comparison: BenchmarkComparison): readonly string[] {
  const lines = [`verdict: ${comparison.verdict}`];
  if (comparison.reasons.length > 0) {
    lines.push("reasons:", ...comparison.reasons.map((reason) => `  - ${reason}`));
  }
  lines.push(`scenarios compared: ${comparison.scenarios.length}`);
  if (comparison.limitations.length > 0) {
    lines.push("limitations:", ...comparison.limitations.map((limitation) => `  - ${limitation}`));
  }
  return lines;
}

/**
 * A verdict is evidence, and the exit code has to keep its three distinct
 * meanings apart: better or unchanged is a pass, worse is a failed gate, and
 * "could not tell" is neither (BENCH-9).
 */
function verdictExitCode(comparison: BenchmarkComparison): BenchmarkExitCode {
  switch (comparison.verdict) {
    case "improved":
    case "stable":
      return BENCHMARK_EXIT_CODES.ok;
    case "regressed":
      return BENCHMARK_EXIT_CODES.gateNotPassed;
    case "inconclusive":
      return BENCHMARK_EXIT_CODES.inconclusive;
    default:
      return BENCHMARK_EXIT_CODES.inconclusive;
  }
}

// ---------------------------------------------------------------------------
// Command handlers
// ---------------------------------------------------------------------------

function toRunRequest(invocation: BenchmarkRunInvocation): BenchmarkRunRequest {
  const base = {
    modes: invocation.modes,
    repetitions: invocation.repetitions,
    allowNetworkModels: invocation.allowNetworkModels,
  };
  // The key is omitted rather than set to an empty list: the API reads an absent
  // `scenarioIds` as "the whole suite", and an empty array as "nothing".
  return invocation.scenarioIds.length === 0 ? base : { ...base, scenarioIds: invocation.scenarioIds };
}

async function runValidate(ports: BenchmarkCliPorts, io: BenchmarkCliIo, json: boolean): Promise<BenchmarkExitCode> {
  const report = await ports.api.validate();
  io.out(json ? asJson(report) : renderValidation(report).join("\n"));
  return report.problems.length === 0 ? BENCHMARK_EXIT_CODES.ok : BENCHMARK_EXIT_CODES.validationFailed;
}

async function runRun(
  ports: BenchmarkCliPorts,
  io: BenchmarkCliIo,
  invocation: BenchmarkRunInvocation,
): Promise<BenchmarkExitCode> {
  const request = toRunRequest(invocation);

  if (invocation.dryRun) {
    const plan = await ports.api.plan(request);
    io.out(invocation.json ? asJson(plan) : renderPlan(plan).join("\n"));
    return plan.problems.length === 0 ? BENCHMARK_EXIT_CODES.ok : BENCHMARK_EXIT_CODES.validationFailed;
  }

  // The plan is consulted first for a live run too: refusing before execution is
  // the difference between a rejected request and a half-spent one.
  const plan = await ports.api.plan(request);
  if (plan.problems.length > 0) {
    io.err(renderPlan(plan).join("\n"));
    return BENCHMARK_EXIT_CODES.validationFailed;
  }

  const summary = await ports.api.run(request);
  io.out(invocation.json ? asJson(summary) : renderSummary(summary).join("\n"));
  if (summary.samples.length === 0) {
    io.err("the run produced no sample, so it measured nothing");
    return BENCHMARK_EXIT_CODES.inconclusive;
  }
  // A run that lost cells is not a run that succeeded. `ok` means "no gate was violated", and a
  // plan half of whose cells produced nothing has no verdict to violate one with: the modes are no
  // longer sampled equally, so every per-mode number is drawn from a population the plan did not
  // choose. Reporting `ok` here is how a scripted caller — CI above all — records a partial run as
  // a finished one and compares it against a complete baseline.
  const unmeasured = summary.unmeasured ?? [];
  if (unmeasured.length > 0) {
    io.err(
      `${unmeasured.length} cell(s) of the plan produced no measurement, ` +
        `so the ${summary.samples.length} stored sample(s) are not the population the run planned`,
    );
    return BENCHMARK_EXIT_CODES.inconclusive;
  }
  return BENCHMARK_EXIT_CODES.ok;
}

async function runBaselineCreate(
  ports: BenchmarkCliPorts,
  io: BenchmarkCliIo,
  invocation: BenchmarkBaselineCreateInvocation,
): Promise<BenchmarkExitCode> {
  const baseline = await ports.api.createBaseline(await ports.loadCurrentSummary());
  // Written before it is reported: a baseline that was announced and not stored
  // is one `compare --baseline` cannot be pointed at.
  const storedAt = await ports.saveBaseline(baseline, invocation.outPath);
  io.out(
    invocation.json
      ? asJson(baseline)
      : [
          `baseline created at ${baseline.createdAt}`,
          `  suite   ${baseline.identity.suiteHash}`,
          `  config  ${baseline.identity.configHash}`,
          `  policy  ${baseline.identity.policyHash}`,
          `  samples ${baseline.samples.length}`,
          `  written ${storedAt}`,
        ].join("\n"),
  );
  return BENCHMARK_EXIT_CODES.ok;
}

async function runCompare(
  ports: BenchmarkCliPorts,
  io: BenchmarkCliIo,
  invocation: BenchmarkCompareInvocation,
): Promise<BenchmarkExitCode> {
  const baseline = await ports.loadBaseline(invocation.baselinePath);
  const current = await ports.loadCurrentSummary();
  const comparison = await ports.api.compare({ baseline, current });
  io.out(invocation.json ? asJson(comparison) : renderComparison(comparison).join("\n"));
  return verdictExitCode(comparison);
}

async function runReport(
  ports: BenchmarkCliPorts,
  io: BenchmarkCliIo,
  invocation: BenchmarkReportInvocation,
): Promise<BenchmarkExitCode> {
  const summary = await ports.loadCurrentSummary();
  const comparison =
    invocation.baselinePath === undefined
      ? undefined
      : await ports.api.compare({ baseline: await ports.loadBaseline(invocation.baselinePath), current: summary });

  const document = await ports.api.report(
    comparison === undefined
      ? { format: invocation.format, summary }
      : { format: invocation.format, summary, comparison },
  );
  if (invocation.outPath === undefined) {
    io.out(document.content);
  } else {
    io.out(`report written to ${await ports.writeReport(document.content, invocation.outPath)}`);
  }
  return comparison === undefined ? BENCHMARK_EXIT_CODES.ok : verdictExitCode(comparison);
}

async function runVerify(
  ports: BenchmarkCliPorts,
  io: BenchmarkCliIo,
  invocation: BenchmarkVerifyInvocation,
): Promise<BenchmarkExitCode> {
  const samples = await ports.loadSamples(invocation.samplesPath);
  const summary = await ports.api.verify(samples);
  const inconclusive = summary.samples.filter((sample) => sample.acceptance.verdict === "inconclusive");
  io.out(
    invocation.json
      ? asJson(summary)
      : [
          ...renderSummary(summary),
          `re-derived acceptance for ${summary.samples.length} of ${samples.length} stored sample(s)`,
        ].join("\n"),
  );
  if (inconclusive.length > 0) {
    io.err(
      `${inconclusive.length} sample(s) could not be re-derived: ${inconclusive
        .map((sample) => sample.sampleId)
        .join(", ")}`,
    );
    return BENCHMARK_EXIT_CODES.inconclusive;
  }
  return BENCHMARK_EXIT_CODES.ok;
}

async function dispatch(
  invocation: Exclude<BenchmarkCliInvocation, { command: "help" }>,
  deps: BenchmarkCliDependencies,
): Promise<BenchmarkExitCode> {
  const ports = await deps.createPorts();
  switch (invocation.command) {
    case "benchmark validate":
      return runValidate(ports, deps, invocation.json);
    case "benchmark run":
      return runRun(ports, deps, invocation);
    case "benchmark baseline create":
      return runBaselineCreate(ports, deps, invocation);
    case "benchmark compare":
      return runCompare(ports, deps, invocation);
    case "benchmark report":
      return runReport(ports, deps, invocation);
    case "benchmark verify":
      return runVerify(ports, deps, invocation);
    default:
      // Unreachable while every command is handled; the branch makes adding one
      // without a handler a compile error rather than a silent exit 0.
      return BENCHMARK_EXIT_CODES.usageError;
  }
}

/**
 * `argv` is what follows `verqestra benchmark`. Returns the exit code rather than
 * setting `process.exitCode`, so the caller decides what to do with it and the
 * tests can read it.
 */
export async function runBenchmarkCli(
  argv: readonly string[],
  deps: BenchmarkCliDependencies,
): Promise<BenchmarkExitCode> {
  const parsed = parseBenchmarkCliArguments(argv);
  if (!parsed.ok) {
    deps.err(parsed.problem);
    deps.err("run `verqestra benchmark --help` for the command and option surface");
    return BENCHMARK_EXIT_CODES.usageError;
  }
  if (parsed.invocation.command === "help") {
    deps.out(renderBenchmarkCliHelp());
    return BENCHMARK_EXIT_CODES.ok;
  }

  try {
    return await dispatch(parsed.invocation, deps);
  } catch (error: unknown) {
    deps.err(describeError(error));
    return classifyError(error);
  }
}
