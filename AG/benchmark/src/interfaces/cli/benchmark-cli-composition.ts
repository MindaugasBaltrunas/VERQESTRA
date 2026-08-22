
import {
  BenchmarkRunNotExecutedError,
  BenchmarkRunRefusedError,
  EXECUTION_MODES,
  type BenchmarkApplicationApi,
  type BenchmarkBaseline,
  type BenchmarkCompareRequest,
  type BenchmarkComparison,
  type BenchmarkRunPlan,
  type BenchmarkRunRequest,
  type BenchmarkRunSummary,
  type BenchmarkSample,
  type ExecutionMode,
  type ScenarioSuite,
  type SuiteValidationReport,
} from "../../application/benchmark-api.js";
import { createBaseline } from "../../application/baseline/baseline-document.js";
import { compareRuns } from "../../application/compare/compare-runs.js";
import type { NormalizedExecutionPlan } from "../../application/ports/execution-plan.js";
import type { RunIdentityRecord } from "../../application/ports/run-identity-store-port.js";
import { createBenchmarkReportCapability } from "../../application/report/benchmark-report.js";
import {
  describeValidationProblem,
  readAuthoritativeSamples,
} from "../../application/sample-ledger.js";
import { executeBenchmarkRun } from "../../application/run/execute-benchmark-run.js";
import { IsolatedSampleRunner } from "../../application/run/isolated-sample-runner.js";
import { readRecordedRunIdentity } from "../../application/run/recorded-run-identity.js";
import {
  buildRunIdentityRecord,
  buildRunManifest,
  summarizeSamples,
} from "../../application/run/run-identity.js";
import { IndependentAcceptanceVerifier } from "../../application/verify/independent-acceptance-verifier.js";
import { rederiveAcceptance } from "../../application/verify/rederive-acceptance.js";
import { AG_LOOP_ADAPTER_VERSION } from "../../infrastructure/adapters/ag-loop-execution-adapter.js";
import { AGENT_SOLO_ADAPTER_VERSION } from "../../infrastructure/adapters/agent-solo-execution-adapter.js";
import { DETERMINISTIC_CONTROL_ADAPTER_VERSION } from "../../infrastructure/adapters/deterministic-control-adapter.js";
import type { AgentInvocation } from "../../infrastructure/adapters/execution-adapter-support.js";
import { NodeAgentProcessRunner } from "../../infrastructure/adapters/node-agent-process-runner.js";
import { BENCHMARK_PACKAGE_ROOT } from "../../infrastructure/benchmark-workspace-paths.js";
import { ProcessCheckRunner } from "../../infrastructure/checks/process-check-runner.js";
import { NodeCompressionConfigReader } from "../../infrastructure/compression-config-reader.js";
import { HostEnvironmentAdapter } from "../../infrastructure/environment-capture.js";
import { createGitWorktreeManager } from "../../infrastructure/git/git-worktree-manager.js";
import { JsonlSampleStore } from "../../infrastructure/jsonl-sample-store.js";
import { JsonRunIdentityStore } from "../../infrastructure/run-identity-store.js";
import {
  createRunId,
  findLatestRunLedger,
  runLedgerPath,
} from "../../infrastructure/run-ledger-store.js";
import { runBenchmarkCli, type BenchmarkCliIo, type BenchmarkCliPorts } from "./benchmark-cli.js";
import {
  describeLiveRun,
  loadRecordedProvenance,
  loadRecordedRunContext,
  loadRecordedSummary,
  type RunProvenanceDeps,
  type StoredRunShape,
} from "./benchmark-run-provenance.js";
import { baselineIdFor, loadSuite, resolvePlan } from "./benchmark-suite-planning.js";
import { createFilePorts } from "./benchmark-cli-file-ports.js";
import { createAgentAdapters } from "./benchmark-agent-adapters.js";
import type { BenchmarkExitCode } from "./benchmark-exit-codes.js";

/**
 * The composition root of `verqestra benchmark`.
 *
 * This is where the CLI's dependencies are chosen and built; every other module
 * under `interfaces/cli` is pure or injected. It is also the only place in the
 * delivery layer that touches a filesystem, which is what keeps
 * `benchmark-cli.ts` testable without one.
 *
 * It decides wiring and nothing else. The run pipeline, the identity hashes, the
 * comparability gate, the metrics and the report all live in `application` and
 * `domain`, so what a report publishes cannot depend on how the command happened
 * to be assembled (BENCH-11).
 *
 * ## Executable, and still fail-closed
 *
 * Every capability is executed. What a caller can still be refused is a *state*:
 * a plan the suite rejects, a run the installation cannot drive, a command that
 * needs an executed run when the package holds none. Those refusals name what is
 * missing and which command produces it. None of them answers with an empty
 * summary — an absent measurement that reads as a real one is the failure
 * BENCH-5 exists to prevent, and it is the reason this file does not contain a
 * single value it did not read or compute.
 */

/**
 * Adapter version per mode, for every declared mode rather than only the
 * executed ones: a run that selected a subset must not hash to a different
 * configuration than the same run selecting all of them.
 */
export const MODE_ADAPTER_VERSIONS: Readonly<Record<ExecutionMode, string>> = Object.freeze({
  "ag-loop": AG_LOOP_ADAPTER_VERSION,
  "agent-solo": AGENT_SOLO_ADAPTER_VERSION,
  "deterministic-control": DETERMINISTIC_CONTROL_ADAPTER_VERSION,
});

/**
 * How a networked mode is executed.
 *
 * Which binary drives `ag-loop` or `agent-solo`, with which flags and with which
 * credentials in its environment, is a deployment decision rather than a fact
 * about the mode — and it is one this package deliberately does not guess. An
 * invented command line would spend money and then fail for a reason that has
 * nothing to do with the agent. So a caller who wants a paid run supplies the
 * invocation, and a run that asks for such a mode without one is refused while
 * the plan is resolved, before anything is spent. `deterministic-control` needs
 * none, which is what lets the whole cycle run offline.
 */
export type AgentInvocationBuilder = (plan: NormalizedExecutionPlan) => AgentInvocation;

/**
 * The command lines this repository drives its own networked modes with, on the
 * package barrel so a host CLI can supply them without a deep import.
 *
 * Re-exported rather than applied: `createComposition` still defaults to no
 * invocations at all, so every existing caller — the offline smoke above all —
 * keeps refusing the paid modes exactly as before. Wiring them in is a decision a
 * caller makes explicitly, which is what keeps a paid run something someone asked
 * for.
 */
export {
  AGENT_INVOCATION_PLACEHOLDERS,
  AGENT_SOLO_STEP_LIMIT,
  AgentInvocationConfigError,
  DEFAULT_AGENT_INVOCATION_CONFIG,
  FORWARDED_CREDENTIAL_VARIABLES,
  createAgentInvocations,
  type AgentInvocationConfig,
  type AgentInvocationFactoryOptions,
  type AgentInvocationTemplate,
} from "../../infrastructure/adapters/agent-invocation-builders.js";


export interface BenchmarkCliCompositionOptions {
  /** The benchmark package directory holding `scenarios/`, `fixtures/` and `results/`. */
  readonly packageRoot?: string;
  /**
   * The directory `vq/config/context-compression.json` is resolved against.
   * Defaults to the repository root the compression reader already defaults to —
   * deliberately *not* to `packageRoot`, which would make every real run record
   * the configuration as `absent`. It exists so a test can be hermetic.
   */
  readonly repositoryRoot?: string;
  /** Command lines for the modes that drive an external agent; see {@link AgentInvocationBuilder}. */
  readonly agentInvocations?: Partial<Record<ExecutionMode, AgentInvocationBuilder>>;
  /**
   * Wall clock, injected so a test can fix the run id and the baseline
   * timestamp. Defaults to the host clock.
   */
  readonly now?: () => Date;
}

/**
 * Everything the CLI is wired from, built once so the API and the ports answer
 * from the same suite, the same clock and the same ledger.
 */
function createComposition(options: BenchmarkCliCompositionOptions) {
  const packageRoot = options.packageRoot ?? BENCHMARK_PACKAGE_ROOT;
  const now = options.now ?? ((): Date => new Date());
  const environmentPort = new HostEnvironmentAdapter({ cwd: packageRoot });
  // The compression configuration belongs to the tree under measurement, not to
  // this package, so it is resolved against the repository root rather than
  // against `packageRoot`.
  const compressionConfigPort = new NodeCompressionConfigReader(
    options.repositoryRoot === undefined ? {} : { repositoryRoot: options.repositoryRoot },
  );

  const executable = new Set<ExecutionMode>(["deterministic-control"]);
  for (const mode of EXECUTION_MODES) {
    if (options.agentInvocations?.[mode] !== undefined) executable.add(mode);
  }

  /**
   * The suite, or a refusal carrying every reason it cannot be used. Read per
   * call rather than cached: a suite edited between two commands is a different
   * suite, and answering the second command from the first one's copy would hide
   * exactly the drift the comparability gate exists to catch.
   */
  async function requireSuite(): Promise<{ suite: ScenarioSuite; suiteHash: string }> {
    const loaded = await loadSuite(packageRoot);
    if (loaded.suite === undefined) throw new BenchmarkRunRefusedError(loaded.report.problems);
    return { suite: loaded.suite, suiteHash: loaded.report.suiteHash };
  }

  function provenanceDeps(): RunProvenanceDeps {
    return {
      findLedger: () => findLatestRunLedger(packageRoot),
      readRecord: (ledgerPath) =>
        readRecordedRunIdentity(new JsonRunIdentityStore(ledgerPath, packageRoot)),
      readSamples: (ledgerPath) =>
        readAuthoritativeSamples(new JsonlSampleStore(ledgerPath, packageRoot)),
      requireSuite,
      captureRunEnvironment: () => environmentPort.captureRunEnvironment(),
      modeAdapterVersions: MODE_ADAPTER_VERSIONS,
      warn: (message) => process.emitWarning(message),
      notExecuted: (name) => new BenchmarkRunNotExecutedError(name),
    };
  }

  function loadCurrentSummary(action: string): Promise<BenchmarkRunSummary> {
    return loadRecordedSummary(provenanceDeps(), action);
  }

  /** The adapters this installation can actually drive, one per executable mode. */
  const api: BenchmarkApplicationApi = {
    async validate(): Promise<SuiteValidationReport> {
      return (await loadSuite(packageRoot)).report;
    },

    async plan(request: BenchmarkRunRequest): Promise<BenchmarkRunPlan> {
      const loaded = await loadSuite(packageRoot);
      if (loaded.suite === undefined) {
        return {
          suiteHash: "",
          scenarioIds: [],
          modes: request.modes,
          repetitions: request.repetitions,
          allowNetworkModels: request.allowNetworkModels,
          sampleCount: 0,
          problems: loaded.report.problems,
        };
      }
      return resolvePlan(loaded.suite, loaded.report.suiteHash, request);
    },

    async run(request: BenchmarkRunRequest): Promise<BenchmarkRunSummary> {
      const { suite, suiteHash } = await requireSuite();
      const plan = resolvePlan(suite, suiteHash, request);
      // The plan is consulted first for a live run too: refusing before
      // execution is the difference between a rejected request and a half-spent
      // one. Executability is checked here rather than inside the plan, because
      // `--dry-run` answers what a run would cost, and that question is still
      // worth answering on a host that cannot drive the mode.
      const problems = [
        ...plan.problems,
        ...request.modes
          .filter((mode) => !executable.has(mode))
          .map(
            (mode) =>
              `mode "${mode}" has no configured agent invocation, so this installation cannot drive it`,
          ),
      ];
      if (problems.length > 0) throw new BenchmarkRunRefusedError(problems);

      const selected = new Set(plan.scenarioIds);
      const scenarios = suite.scenarios.filter((scenario) => selected.has(scenario.id));
      const shape: StoredRunShape = {
        modes: request.modes,
        repetitions: request.repetitions,
        allowNetworkModels: request.allowNetworkModels,
      };
      const described = await describeLiveRun(
        suite,
        suiteHash,
        shape,
        MODE_ADAPTER_VERSIONS,
        () => environmentPort.captureRunEnvironment(),
      );

      const runId = createRunId(now());
      // One path, two stores: the samples and the statement about them are bound
      // to the same ledger by construction rather than by two callers agreeing.
      const ledgerPath = runLedgerPath(runId);
      const store = new JsonlSampleStore(ledgerPath, packageRoot);
      const identity = new JsonRunIdentityStore(ledgerPath, packageRoot);
      const identityRecord = buildRunIdentityRecord({
        runId,
        recordedAt: now().toISOString(),
        identity: described.identity,
        config: described.config,
        environment: described.environment,
        compressionConfig: await compressionConfigPort.read(),
      });

      const worktrees = await createGitWorktreeManager(runId, { workspaceRoot: packageRoot });
      try {
        const outcome = await executeBenchmarkRun(
          {
            scenarios,
            modes: request.modes,
            repetitions: request.repetitions,
            allowNetworkModels: request.allowNetworkModels,
            identityRecord,
          },
          {
            runner: new IsolatedSampleRunner({
              worktrees,
              agents: createAgentAdapters(
                {
                  modelSettings: described.config.modelSettings,
                  ceiling: described.config.limits,
                },
                options.agentInvocations,
              ),
            }),
            verifier: new IndependentAcceptanceVerifier({
              checks: new ProcessCheckRunner(new NodeAgentProcessRunner()),
            }),
            store,
            identity,
          },
        );
        if (outcome.unmeasured.length > 0) {
          // Neither silent nor fatal: the measured samples are real and are
          // stored, while a cell that produced nothing has to be visible or the
          // run reads as complete (BENCH-5).
          process.emitWarning(
            `benchmark run ${runId}: ${outcome.unmeasured.length} cell(s) produced no measurement:\n` +
              outcome.unmeasured
                .map(
                  (cell) => `  ${cell.scenarioId} (${cell.mode}, r${cell.repetition}): ${cell.reason}`,
                )
                .join("\n"),
          );
        }
        // The unmeasured cells travel WITH the summary, not only in a warning. A warning is a
        // side effect on this process's stderr: `--json` never carries it, a caller reading the
        // returned object never sees it, and a partial run therefore reads as a complete one —
        // which is exactly the confusion `BenchmarkRunSummary.unmeasured` was declared to prevent
        // (BENCH-5). `summarizeSamples` cannot supply the field: it describes stored samples, and
        // a cell that produced nothing left none.
        return {
          ...summarizeSamples(outcome.samples, described.identity, described.environment.environment),
          ...(outcome.unmeasured.length === 0 ? {} : { unmeasured: outcome.unmeasured }),
        };
      } finally {
        // Reported rather than thrown: a run's numbers are not less true because
        // its scratch directory outlived it, and a crash deliberately keeps its
        // checkouts.
        const disposal = await worktrees.dispose();
        if (!disposal.removed) process.emitWarning(`benchmark run ${runId}: ${disposal.reason}`);
      }
    },

    async createBaseline(summary: BenchmarkRunSummary): Promise<BenchmarkBaseline> {
      if (summary.samples.length === 0) throw new BenchmarkRunNotExecutedError("snapshot");
      // Sealed under the methodology the run RECORDED. This used to read the suite version and the
      // configuration from the package as it stands, so a baseline created after any edit stated a
      // methodology its own samples were never taken under — and a baseline is precisely the
      // artefact that outlives the ability to check.
      const recorded = await loadRecordedRunContext(provenanceDeps(), "baseline create");
      const createdAt = now().toISOString();
      const created = createBaseline({
        baselineId: baselineIdFor(createdAt, summary.identity.suiteHash),
        createdAt,
        suiteHash: summary.identity.suiteHash,
        suiteVersion: recorded.config.suiteVersion,
        policyHash: summary.identity.policyHash,
        config: recorded.config,
        environment: recorded.environment,
        samples: summary.samples,
      });
      if (!created.ok) {
        // A baseline exists only if it can be read back. Refusing here names the
        // field now, rather than at a comparison months later when the run that
        // produced it can no longer be repeated.
        throw new BenchmarkRunRefusedError(
          created.problems.map((problem) => describeValidationProblem(problem)),
        );
      }
      return created.value;
    },

    async compare(request: BenchmarkCompareRequest): Promise<BenchmarkComparison> {
      const { suite } = await requireSuite();
      // The configuration and host the current run RECORDED, not the ones this package would
      // choose today. Taking the hashes from the summary and the configuration from the present
      // was how a comparison came to mix one run's identity with another run's methodology.
      const described = await loadRecordedRunContext(provenanceDeps(), "compare");
      return compareRuns({
        scenarios: suite.scenarios,
        baselineManifest: request.baseline.manifest,
        currentManifest: buildRunManifest({
          // Neither field decides comparability; they exist so the current run
          // has a manifest of the same shape as the stored one it is judged
          // against.
          baselineId: "current-run",
          createdAt: now().toISOString(),
          config: described.config,
          suiteHash: request.current.identity.suiteHash,
          policyHash: request.current.identity.policyHash,
          agCommit: request.current.identity.agCommit,
          environment: described.environment,
        }),
        baselineSamples: request.baseline.samples,
        currentSamples: request.current.samples,
      });
    },

    report: createBenchmarkReportCapability(),

    async verify(samples: readonly BenchmarkSample[]): Promise<BenchmarkRunSummary> {
      // Acceptance is re-derived; the PROVENANCE is not. `verify` answers "would today's verifier
      // still accept these samples", and re-labelling them with today's suite and host while it
      // does would change the second half of the question without being asked to.
      const { suite } = await requireSuite();
      const rederived = rederiveAcceptance(samples, suite.scenarios);
      const provenance = await loadRecordedProvenance(provenanceDeps(), "verify");
      return summarizeSamples(rederived, provenance.identity, provenance.environment.environment);
    },
  };

  const ports = createFilePorts(api, packageRoot, () => loadCurrentSummary("summarize"));

  return { api, ports };
}

/**
 * The application API the CLI runs against.
 *
 * Every capability is executed against the authored suite and the run ledgers of
 * this package; none of them is stubbed, and none of them invents a value it did
 * not read.
 */
export function createBenchmarkApplicationApi(
  options: BenchmarkCliCompositionOptions = {},
): BenchmarkApplicationApi {
  return createComposition(options).api;
}

/** The API plus the stored artefacts the CLI names on the command line. */
export function createBenchmarkCliPorts(
  options: BenchmarkCliCompositionOptions = {},
): BenchmarkCliPorts {
  return createComposition(options).ports;
}

/** One run ledger, read whole: its samples and the statement the run made about them. */
export interface RecordedRunLedger {
  /** Package-relative path of the ledger; `undefined` when no run exists. */
  readonly ledgerPath: string | undefined;
  readonly samples: readonly BenchmarkSample[];
  /** `undefined` when the run recorded none or no run exists; an unreadable record throws. */
  readonly record: RunIdentityRecord | undefined;
}

/**
 * The newest run, read coherently (BENCH-8, task 1205).
 *
 * The ledger is resolved once and both reads are taken from that one path. That
 * is the whole point of this function: a caller that asked for "the latest
 * samples" and "the latest identity" separately would pair one run's samples
 * with another run's identity the moment a run finished between the two calls,
 * and the resulting document would state an identity no run ever had.
 *
 * A record that exists and cannot be read propagates as
 * `RunIdentityIntegrityError`; `undefined` means the run predates the record or
 * there is no run at all.
 */
export async function readLatestRecordedRun(
  options: BenchmarkCliCompositionOptions = {},
): Promise<RecordedRunLedger> {
  const packageRoot = options.packageRoot ?? BENCHMARK_PACKAGE_ROOT;
  const ledgerPath = await findLatestRunLedger(packageRoot);
  if (ledgerPath === undefined) return { ledgerPath: undefined, samples: [], record: undefined };

  // The record first: a ledger whose provenance is damaged is refused before its
  // numbers are read, so nothing downstream ever holds samples it may not attribute.
  const record = await readRecordedRunIdentity(new JsonRunIdentityStore(ledgerPath, packageRoot));
  const samples = await readAuthoritativeSamples(new JsonlSampleStore(ledgerPath, packageRoot));
  return { ledgerPath, samples, record };
}

/**
 * The entry point a host CLI calls. `argv` is what follows `verqestra benchmark`; the
 * returned code is the contract of `BENCHMARK_EXIT_CODES`.
 */
export async function runBenchmarkCommand(
  argv: readonly string[],
  io: BenchmarkCliIo,
  options: BenchmarkCliCompositionOptions = {},
): Promise<BenchmarkExitCode> {
  return runBenchmarkCli(argv, { ...io, createPorts: () => createBenchmarkCliPorts(options) });
}
