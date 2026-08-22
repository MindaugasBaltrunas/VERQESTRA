import {
  BENCHMARK_SAMPLE_SCHEMA_VERSION,
  type BenchmarkSample,
  type ExecutionMode,
} from "../../domain/result.js";
import type { BenchmarkScenario } from "../../domain/scenario.js";
import type {
  AcceptanceVerification,
  AcceptanceVerifierPort,
} from "../ports/acceptance-verifier-port.js";
import type {
  RunIdentityRecord,
  RunIdentityStorePort,
} from "../ports/run-identity-store-port.js";
import type { SampleStorePort, UnmeasuredCellRecord } from "../ports/sample-store-port.js";
import type { IsolatedSampleRun } from "./isolated-run-record.js";
import type { IsolatedRunInspector, IsolatedSampleRequest } from "./isolated-sample-runner.js";

/**
 * The run pipeline (BENCH-4, BENCH-5, BENCH-6).
 *
 * One approved plan in, one ledger of stored samples out. For every
 * `scenario × mode × repetition` cell it drives the same four steps in the same
 * order — execute in isolation, verify independently while the checkout still
 * exists, assemble the record, store it — and it owns no rule of its own: the
 * isolation belongs to the runner, the verdict to the verifier, the schema to
 * the store.
 *
 * ## A cell that produced no measurement produces no sample
 *
 * A worktree that could not be created, an adapter that threw, an execution that
 * reported no cost record, a capture with no commit to name: none of those say
 * anything about whether the agent could have done the task, and a stored sample
 * would make them look like one that does. They are reported as
 * {@link UnmeasuredCell} entries instead — counted, named and carried out of the
 * run, so a caller can tell "the suite scored badly" from "the harness did not
 * run" (BENCH-5). The distinction is the reason the two lists are returned side
 * by side rather than merged into a count.
 *
 * The same applies to a record the store refuses. A sample whose own fields
 * contradict each other is evidence of a broken producer, not a slow agent, so
 * the rejection is recorded as an unmeasured cell and the run continues — one
 * bad cell must not cost the run every measurement taken after it.
 *
 * ## The run states what it is before it measures anything
 *
 * The identity record is written here, as the first thing the function does,
 * rather than by the composition root that built the stores (BENCH-8, task
 * 1205). "Before the first sample" is an ordering rule, and ordering is this
 * pipeline's responsibility; in the composition root it would be a convention
 * any later wiring edit silently breaks. A record that cannot be written stops
 * the run — no sample was appended and no cell was attempted, so it is not an
 * {@link UnmeasuredCell} but the absence of a run.
 */

/** A full Git object id; the shape a stored sample's isolation evidence must carry. */
const COMMIT_ID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

/** Reported for an execution that ended without the cost record every sample carries. */
const NO_COST_RECORD =
  "no-cost-record: the adapter reported no cost record, so what the execution spent is unknown";

/**
 * The isolated runner as this module uses it. Narrower than the class, so the
 * pipeline can be driven end to end without Git, a process or a clock.
 */
export interface IsolatedSampleRunnerPort {
  run(request: IsolatedSampleRequest, inspect?: IsolatedRunInspector): Promise<IsolatedSampleRun>;
}

/** One cell of the plan that produced no usable measurement, and why. */
export interface UnmeasuredCell {
  readonly scenarioId: string;
  readonly mode: ExecutionMode;
  readonly repetition: number;
  /** `<code>: <detail>`; the code is stable so a report can group on it. */
  readonly reason: string;
}

export interface BenchmarkRunOutcome {
  /** Every sample the ledger received, in execution order. */
  readonly samples: readonly BenchmarkSample[];
  readonly unmeasured: readonly UnmeasuredCell[];
}

export interface BenchmarkRunExecution {
  /** The scenarios to execute, in the order the suite declares them. */
  readonly scenarios: readonly BenchmarkScenario[];
  readonly modes: readonly ExecutionMode[];
  readonly repetitions: number;
  readonly allowNetworkModels: boolean;
  /** What this run states about itself; stored before the first cell executes (BENCH-8). */
  readonly identityRecord: RunIdentityRecord;
}

export interface BenchmarkRunPipelinePorts {
  readonly runner: IsolatedSampleRunnerPort;
  readonly verifier: AcceptanceVerifierPort;
  readonly store: SampleStorePort;
  /** Bound to the same run's ledger as {@link BenchmarkRunPipelinePorts.store}. */
  readonly identity: RunIdentityStorePort;
}

/**
 * The sample id one cell is stored under.
 *
 * `scenario-mode-r<repetition>`: lowercase kebab-case, which the stored-sample
 * schema requires, and unique within a run ledger by construction. The `r`
 * prefix keeps the repetition readable beside a mode that already ends in a
 * number-free word.
 */
export function benchmarkSampleId(
  scenarioId: string,
  mode: ExecutionMode,
  repetition: number,
): string {
  return `${scenarioId}-${mode}-r${repetition}`;
}

function describeThrown(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}

/**
 * Why this run cannot become a sample, or `""` when it can.
 *
 * The order is the order a reader wants: what went wrong first, not what the
 * record happens to be missing as a consequence.
 */
function unmeasuredReason(run: IsolatedSampleRun): string {
  if (run.exit === "harness-failed") {
    return `harness-failed: ${run.failure === "" ? "the run did not complete and left no usable evidence" : run.failure}`;
  }
  if (run.telemetry === undefined) {
    return `no-cost-record: ${
      run.failure === ""
        ? "the adapter reported no cost record, so what the execution spent is unknown"
        : run.failure
    }`;
  }
  if (!COMMIT_ID.test(run.workspace.baseCommit) || !COMMIT_ID.test(run.workspace.finalCommit)) {
    return (
      "no-isolation-evidence: the run named no start or end commit, " +
      "so what it changed cannot be established"
    );
  }
  return "";
}

/** `"timeout"` when `reason` embeds the adapter's `timeout:` failure code, `"unmeasured"` otherwise. */
function unmeasuredStatus(reason: string): string {
  return reason.includes("timeout:") ? "timeout" : "unmeasured";
}

/**
 * Persists one unmeasured cell beside the run's samples, so a timeout — or any
 * other cell that produced nothing — leaves a durable trace instead of only the
 * in-memory {@link UnmeasuredCell} list and the caller's own console warning
 * (task 0028: a run that dies quietly on a timeout loses the tokens it already
 * spent with no record of having spent them).
 *
 * Best-effort: `appendUnmeasured` is optional on the port, and a store that
 * throws while recording it must not turn one bad cell into a run that cannot
 * continue — the cell is already visible through {@link BenchmarkRunOutcome.unmeasured}
 * regardless of whether this durable copy succeeds.
 */
async function recordUnmeasuredCell(
  ports: BenchmarkRunPipelinePorts,
  runId: string,
  cell: { readonly scenarioId: string; readonly mode: ExecutionMode; readonly repetition: number },
  reason: string,
): Promise<void> {
  if (ports.store.appendUnmeasured === undefined) return;
  const record: UnmeasuredCellRecord = {
    runId,
    scenarioId: cell.scenarioId,
    mode: cell.mode,
    repetition: cell.repetition,
    recordedAt: new Date().toISOString(),
    reason,
    status: unmeasuredStatus(reason),
  };
  try {
    await ports.store.appendUnmeasured(record);
  } catch {
    // A durable trace is best-effort; see the function's doc comment.
  }
}

/**
 * Executes one approved plan.
 *
 * The plan is expected to have been resolved and accepted already: this function
 * runs what it is given and does not re-decide whether it should have been run.
 * Cells are executed one after another, because the sample store assumes a
 * single writer and two worktrees of one fixture built at the same time would
 * make each run's duration depend on the other's.
 *
 * The identity is recorded first and outside any `try`: a run that could not
 * state what it measured produces no measurement at all, which is the only
 * outcome that keeps every stored ledger attributable.
 */
export async function executeBenchmarkRun(
  execution: BenchmarkRunExecution,
  ports: BenchmarkRunPipelinePorts,
): Promise<BenchmarkRunOutcome> {
  await ports.identity.record(execution.identityRecord);

  const samples: BenchmarkSample[] = [];
  const unmeasured: UnmeasuredCell[] = [];

  for (const scenario of execution.scenarios) {
    for (const mode of execution.modes) {
      for (let repetition = 1; repetition <= execution.repetitions; repetition += 1) {
        const cell = { scenarioId: scenario.id, mode, repetition };
        const request: IsolatedSampleRequest = {
          scenario,
          mode,
          repetition,
          allowNetworkModels: execution.allowNetworkModels,
        };

        // Assigned by the inspector below, while the checkout still exists.
        let verification: AcceptanceVerification | undefined;
        const run = await ports.runner.run(request, async (evidence) => {
          verification = await ports.verifier.verify({
            scenario,
            worktree: evidence.worktree,
            changedFiles: evidence.capture.changedFiles,
            agentClaimedDone: evidence.agentClaimedDone,
          });
        });

        const telemetry = run.telemetry;
        const reason = unmeasuredReason(run);
        if (reason !== "" || telemetry === undefined) {
          const finalReason = reason === "" ? NO_COST_RECORD : reason;
          unmeasured.push({ ...cell, reason: finalReason });
          await recordUnmeasuredCell(ports, execution.identityRecord.runId, cell, finalReason);
          continue;
        }
        if (verification === undefined) {
          // The runner reported a usable execution and the inspector never ran,
          // which can only mean the two disagree about what happened. Trusting
          // either one would publish a verdict nobody reached.
          const notVerifiedReason =
            "not-verified: the execution completed but no acceptance verification was produced";
          unmeasured.push({ ...cell, reason: notVerifiedReason });
          await recordUnmeasuredCell(ports, execution.identityRecord.runId, cell, notVerifiedReason);
          continue;
        }

        const sample: BenchmarkSample = {
          schemaVersion: BENCHMARK_SAMPLE_SCHEMA_VERSION,
          sampleId: benchmarkSampleId(scenario.id, mode, repetition),
          scenarioId: scenario.id,
          mode,
          repetition,
          startedAt: run.startedAt,
          durationMs: run.durationMs,
          telemetry,
          checks: verification.checks,
          workspace: {
            startCommit: run.workspace.baseCommit,
            endCommit: run.workspace.finalCommit,
            changedFiles: run.workspace.changedFiles,
            outOfScopeFiles: verification.outOfScopeFiles,
            cleanup: run.cleanup.result,
          },
          acceptance: verification.decision,
          ...(run.usage === undefined ? {} : { usage: run.usage }),
          ...(run.compression === undefined ? {} : { compression: run.compression }),
        };

        try {
          await ports.store.append(sample);
        } catch (error) {
          const refusedReason = `sample-refused: ${describeThrown(error)}`;
          unmeasured.push({ ...cell, reason: refusedReason });
          await recordUnmeasuredCell(ports, execution.identityRecord.runId, cell, refusedReason);
          continue;
        }
        samples.push(sample);
      }
    }
  }

  return { samples, unmeasured };
}
