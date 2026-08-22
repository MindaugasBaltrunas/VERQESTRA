import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  BenchmarkRunNotExecutedError,
  BenchmarkRunRefusedError,
  EXECUTION_MODES,
  MINIMUM_NONDETERMINISTIC_OBSERVATIONS,
  type BenchmarkApplicationApi,
  type BenchmarkBaseline,
  type BenchmarkCompareRequest,
  type BenchmarkComparison,
  type BenchmarkRunPlan,
  type BenchmarkRunRequest,
  type BenchmarkRunSummary,
  type BenchmarkSample,
  type BenchmarkScenario,
  type ExecutionMode,
  type ScenarioSuite,
  type SuiteValidationReport,
} from "../../application/benchmark-api.js";
import {
  createBaseline,
  readBaseline,
  serializeBaseline,
} from "../../application/baseline/baseline-document.js";
import { compareRuns } from "../../application/compare/compare-runs.js";
import type { AgentExecutionPort } from "../../application/ports/agent-execution-port.js";
import {
  MODE_EXECUTION_PROFILES,
  type ExecutionPlanSettings,
  type NormalizedExecutionPlan,
} from "../../application/ports/execution-plan.js";
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
  buildRunConfiguration,
  buildRunIdentity,
  buildRunIdentityRecord,
  buildRunManifest,
  summarizeSamples,
} from "../../application/run/run-identity.js";
import { computeRunPolicyHash } from "../../application/run/run-policy.js";
import type { RunEnvironmentRecord } from "../../application/run-environment.js";
import {
  FIXTURE_ROOT,
  toSuiteValidationReport,
  validateBenchmarkSuite,
  type ScenarioDocument,
} from "../../application/validate-suite.js";
import { IndependentAcceptanceVerifier } from "../../application/verify/independent-acceptance-verifier.js";
import { rederiveAcceptance } from "../../application/verify/rederive-acceptance.js";
import {
  AG_LOOP_ADAPTER_VERSION,
  createAgLoopExecutionAdapter,
} from "../../infrastructure/adapters/ag-loop-execution-adapter.js";
import {
  AGENT_SOLO_ADAPTER_VERSION,
  createAgentSoloExecutionAdapter,
} from "../../infrastructure/adapters/agent-solo-execution-adapter.js";
import {
  DETERMINISTIC_CONTROL_ADAPTER_VERSION,
  DeterministicControlAdapter,
} from "../../infrastructure/adapters/deterministic-control-adapter.js";
import type { AgentInvocation } from "../../infrastructure/adapters/execution-adapter-support.js";
import { NodeAgentProcessRunner } from "../../infrastructure/adapters/node-agent-process-runner.js";
import { NodeWorkspaceFileWriter } from "../../infrastructure/adapters/node-workspace-file-writer.js";
import {
  BENCHMARK_PACKAGE_ROOT,
  resolveInsideBenchmarkWorkspace,
} from "../../infrastructure/benchmark-workspace-paths.js";
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

const SCENARIO_DIRECTORY = "scenarios";
const SUITE_MANIFEST_FILE = "suite.manifest.json";
const SCENARIO_FILE_SUFFIX = ".scenario.json";

/** Package-relative directory sealed baseline documents are written to. */
export const BASELINE_DIRECTORY = "baselines";

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

function describeThrown(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

interface LoadedSuite {
  /** Present only when the suite validated; a refused suite yields no scenarios and no hash. */
  readonly suite: ScenarioSuite | undefined;
  readonly report: SuiteValidationReport;
}

async function readJson(file: string): Promise<unknown> {
  return JSON.parse(await readFile(file, "utf8")) as unknown;
}

function refusedSuite(problem: string): LoadedSuite {
  return { suite: undefined, report: { suiteHash: "", scenarioCount: 0, problems: [problem] } };
}

/**
 * Reads the authored suite from the package and validates it whole.
 *
 * Fail-closed: an unreadable `scenarios/` directory is reported as a problem
 * rather than as an empty suite, because an empty suite validates against
 * nothing and would let `validate` answer "no problems" for a package with no
 * scenarios in it at all.
 */
async function loadSuite(packageRoot: string): Promise<LoadedSuite> {
  const scenariosDirectory = path.join(packageRoot, SCENARIO_DIRECTORY);

  let fileNames: readonly string[];
  try {
    const entries = await readdir(scenariosDirectory, { withFileTypes: true });
    fileNames = entries
      .filter((entry) => entry.isFile() && entry.name.endsWith(SCENARIO_FILE_SUFFIX))
      .map((entry) => entry.name)
      .sort();
  } catch (error: unknown) {
    return refusedSuite(`scenarios: the suite directory could not be read: ${describeThrown(error)}`);
  }

  let manifest: unknown;
  try {
    manifest = await readJson(path.join(scenariosDirectory, SUITE_MANIFEST_FILE));
  } catch (error: unknown) {
    return refusedSuite(`scenarios: ${SUITE_MANIFEST_FILE} could not be read: ${describeThrown(error)}`);
  }

  const documents: ScenarioDocument[] = [];
  for (const name of fileNames) {
    try {
      documents.push({ source: name, value: await readJson(path.join(scenariosDirectory, name)) });
    } catch (error: unknown) {
      return refusedSuite(`scenarios/${name}: could not be read: ${describeThrown(error)}`);
    }
  }

  let availableFixtures: readonly string[];
  try {
    const entries = await readdir(path.join(packageRoot, FIXTURE_ROOT), { withFileTypes: true });
    availableFixtures = entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => `${FIXTURE_ROOT}/${entry.name}`);
  } catch (error: unknown) {
    return refusedSuite(`${FIXTURE_ROOT}: the fixture directory could not be read: ${describeThrown(error)}`);
  }

  const outcome = validateBenchmarkSuite(manifest, documents, { availableFixtures });
  return { suite: outcome.suite, report: toSuiteValidationReport(outcome) };
}

/**
 * Resolves a request against the suite: which scenarios, which modes, how many
 * repetitions, and every reason the run would be refused. Nothing is executed
 * and nothing is written, which is what makes it safe to call before a live run
 * as well as for `--dry-run`.
 */
function resolvePlan(
  suite: ScenarioSuite,
  suiteHash: string,
  request: BenchmarkRunRequest,
): BenchmarkRunPlan {
  const problems: string[] = [];
  const known = new Map(suite.scenarios.map((scenario) => [scenario.id, scenario]));

  const requested = request.scenarioIds ?? [];
  let selected: readonly BenchmarkScenario[];
  if (requested.length === 0) {
    selected = suite.scenarios;
  } else {
    const found: BenchmarkScenario[] = [];
    for (const id of requested) {
      const scenario = known.get(id);
      if (scenario === undefined) {
        problems.push(`"${id}" is not a scenario of this suite`);
        continue;
      }
      found.push(scenario);
    }
    selected = found;
  }

  if (request.modes.length === 0) {
    problems.push("no execution mode was selected, so there is nothing to compare");
  }
  for (const mode of request.modes) {
    if (MODE_EXECUTION_PROFILES[mode].reachesNetwork && !request.allowNetworkModels) {
      problems.push(
        `mode "${mode}" reaches a paid model over the network; re-run with --allow-network to permit it`,
      );
    }
  }

  if (
    request.repetitions < MINIMUM_NONDETERMINISTIC_OBSERVATIONS &&
    selected.some((scenario) => !scenario.deterministic)
  ) {
    problems.push(
      `the selection contains nondeterministic scenarios, which BENCH-9 requires to be repeated at least ${MINIMUM_NONDETERMINISTIC_OBSERVATIONS} times; --repetitions is ${request.repetitions}`,
    );
  }

  const scenarioIds = selected.map((scenario) => scenario.id).sort();
  return {
    // A refused plan names no suite: reporting the hash of a suite the run will
    // never execute invites a caller to record it as evidence of a measurement.
    suiteHash: problems.length === 0 ? suiteHash : "",
    scenarioIds,
    modes: request.modes,
    repetitions: request.repetitions,
    allowNetworkModels: request.allowNetworkModels,
    sampleCount: scenarioIds.length * request.modes.length * request.repetitions,
    problems,
  };
}

/**
 * `<date>-<suite digest prefix>`: lowercase kebab-case, which the stored
 * document requires, and readable enough that two baselines taken on one day
 * against different suites are visibly different files.
 */
function baselineIdFor(createdAt: string, suiteHash: string): string {
  const digest = suiteHash.replace("sha256:", "").slice(0, 12);
  return `${createdAt.slice(0, 10)}-${digest === "" ? "unidentified" : digest}`;
}

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

/** What a run's samples are described under, derived from the samples themselves. */
interface StoredRunShape {
  readonly modes: readonly ExecutionMode[];
  readonly repetitions: number;
  readonly allowNetworkModels: boolean;
}

/**
 * The configuration a *stored* ledger is described under.
 *
 * A ledger does not record which modes or how many repetitions produced it, so
 * the description is read from the samples: the modes that actually occur, and
 * the largest repetition index reached. Derived from the evidence rather than
 * from a default, so `baseline create` and `compare` describe the run that
 * happened rather than the one the command line would have suggested.
 */
function describeStoredRun(samples: readonly BenchmarkSample[]): StoredRunShape {
  const present = new Set(samples.map((sample) => sample.mode));
  const modes = EXECUTION_MODES.filter((mode) => present.has(mode));
  return {
    modes,
    repetitions: samples.reduce((most, sample) => Math.max(most, sample.repetition), 1),
    // A ledger's own samples state whether a networked mode ran; a control-only
    // ledger is a run that needed no permission.
    allowNetworkModels: modes.some((mode) => MODE_EXECUTION_PROFILES[mode].reachesNetwork),
  };
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

  function configurationOf(suite: ScenarioSuite, shape: StoredRunShape) {
    return buildRunConfiguration({
      suiteVersion: suite.version,
      modes: shape.modes,
      repetitions: shape.repetitions,
      allowNetworkModels: shape.allowNetworkModels,
      modeAdapterVersions: MODE_ADAPTER_VERSIONS,
    });
  }

  /**
   * The provenance the current run is recorded under.
   *
   * Every field is read or computed now, from the suite as it stands and the
   * host as it is. The ledger stores measurements; the methodology they were
   * taken under is stated by the code that is asked about them, so a comparison
   * across a suite edit fails the comparability gate instead of quietly
   * comparing two different suites (BENCH-8).
   */
  async function describeCurrentRun(
    suite: ScenarioSuite,
    suiteHash: string,
    shape: StoredRunShape,
  ): Promise<{
    readonly environment: RunEnvironmentRecord;
    readonly config: ReturnType<typeof buildRunConfiguration>;
    readonly identity: ReturnType<typeof buildRunIdentity>;
  }> {
    const environment = await environmentPort.captureRunEnvironment();
    const config = configurationOf(suite, shape);
    return {
      environment,
      config,
      identity: buildRunIdentity({
        config,
        suiteHash,
        policyHash: computeRunPolicyHash(),
        agCommit: environment.agCommit,
      }),
    };
  }

  /** The stored samples of the newest run ledger, or a refusal naming what is missing. */
  async function readCurrentSamples(action: string): Promise<readonly BenchmarkSample[]> {
    const ledger = await findLatestRunLedger(packageRoot);
    if (ledger === undefined) throw new BenchmarkRunNotExecutedError(action);
    const samples = await readAuthoritativeSamples(new JsonlSampleStore(ledger, packageRoot));
    // A ledger that exists and holds nothing is a run that measured nothing;
    // summarising it would publish zeroes that read as results.
    if (samples.length === 0) throw new BenchmarkRunNotExecutedError(action);
    return samples;
  }

  /** The summary the stored samples of the newest run add up to. */
  async function loadCurrentSummary(action: string): Promise<BenchmarkRunSummary> {
    const samples = await readCurrentSamples(action);
    const { suite, suiteHash } = await requireSuite();
    const described = await describeCurrentRun(suite, suiteHash, describeStoredRun(samples));
    return summarizeSamples(samples, described.identity, described.environment.environment);
  }

  /** The adapters this installation can actually drive, one per executable mode. */
  function createAgentAdapters(settings: ExecutionPlanSettings): readonly AgentExecutionPort[] {
    const processes = new NodeAgentProcessRunner();
    const adapters: AgentExecutionPort[] = [
      new DeterministicControlAdapter({ settings, files: new NodeWorkspaceFileWriter() }),
    ];
    const agLoop = options.agentInvocations?.["ag-loop"];
    if (agLoop !== undefined) {
      adapters.push(createAgLoopExecutionAdapter({ settings, processes, invocation: agLoop }));
    }
    const agentSolo = options.agentInvocations?.["agent-solo"];
    if (agentSolo !== undefined) {
      adapters.push(createAgentSoloExecutionAdapter({ settings, processes, invocation: agentSolo }));
    }
    return adapters;
  }

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
      const described = await describeCurrentRun(suite, suiteHash, shape);

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
              agents: createAgentAdapters({
                modelSettings: described.config.modelSettings,
                ceiling: described.config.limits,
              }),
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
        return summarizeSamples(
          outcome.samples,
          described.identity,
          described.environment.environment,
        );
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
      const { suite } = await requireSuite();
      const environment = await environmentPort.captureRunEnvironment();
      const createdAt = now().toISOString();
      const created = createBaseline({
        baselineId: baselineIdFor(createdAt, summary.identity.suiteHash),
        createdAt,
        suiteHash: summary.identity.suiteHash,
        suiteVersion: suite.version,
        policyHash: summary.identity.policyHash,
        config: configurationOf(suite, describeStoredRun(summary.samples)),
        environment,
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
      const { suite, suiteHash } = await requireSuite();
      const described = await describeCurrentRun(
        suite,
        suiteHash,
        describeStoredRun(request.current.samples),
      );
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
      const { suite, suiteHash } = await requireSuite();
      const rederived = rederiveAcceptance(samples, suite.scenarios);
      const described = await describeCurrentRun(suite, suiteHash, describeStoredRun(rederived));
      return summarizeSamples(rederived, described.identity, described.environment.environment);
    },
  };

  const ports: BenchmarkCliPorts = {
    api,

    async loadSamples(samplesPath) {
      // Without a path: the newest run ledger, and an empty list when no run has
      // been executed. Empty rather than a refusal, because this port also feeds
      // the report generator, whose job is to publish "nothing was measured" as
      // a readable finding rather than as a failure to produce a document.
      const ledger = samplesPath ?? (await findLatestRunLedger(packageRoot));
      if (ledger === undefined) return [];
      // The path is data — a CLI flag — so it is resolved against the workspace
      // root by the store rather than trusted as given.
      return readAuthoritativeSamples(new JsonlSampleStore(ledger, packageRoot));
    },

    async loadBaseline(baselinePath) {
      const absolute = resolveInsideBenchmarkWorkspace(baselinePath, packageRoot);
      const document = readBaseline(JSON.parse(await readFile(absolute, "utf8")));
      if (!document.ok) {
        throw new BenchmarkRunRefusedError([
          `"${baselinePath}" is not a readable baseline document`,
          ...document.problems.map((problem) => describeValidationProblem(problem)),
        ]);
      }
      return document.value;
    },

    loadCurrentSummary: () => loadCurrentSummary("summarize"),

    async saveBaseline(baseline, outPath) {
      const relative = outPath ?? `${BASELINE_DIRECTORY}/${baseline.manifest.baselineId}.json`;
      const absolute = resolveInsideBenchmarkWorkspace(relative, packageRoot);
      await mkdir(path.dirname(absolute), { recursive: true });
      await writeFile(absolute, serializeBaseline(baseline), "utf8");
      return relative;
    },

    async writeReport(content, outPath) {
      const absolute = resolveInsideBenchmarkWorkspace(outPath, packageRoot);
      await mkdir(path.dirname(absolute), { recursive: true });
      await writeFile(absolute, content, "utf8");
      return outPath;
    },
  };

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
