import { AgentProcessTreeAbandonedError } from "../ports/agent-process-port.js";
import type { BenchmarkScenario } from "../../domain/scenario.js";
import type { ExecutionMode } from "../../domain/result.js";
import type { AgentExecutionPort } from "../ports/agent-execution-port.js";
import type { IsolatedWorktree } from "../ports/worktree-port.js";
import { redactSecrets } from "../secret-redaction.js";
import {
  UNOBSERVED_WORKSPACE,
  type IsolatedCleanupOutcome,
  type IsolatedSampleRun,
  type IsolatedWorkspaceCapture,
  type IsolatedWorkspacePort,
  type SampleRunExit,
} from "./isolated-run-record.js";

/**
 * Executing one sample in isolation (BENCH-4).
 *
 * The runner owns an order, not a policy: make a checkout, run the agent in it,
 * capture what changed, dispose of the checkout, and record every one of those
 * steps including the ones that failed. It creates nothing itself — the
 * isolation, the agent and the clock all arrive as ports — so it can be driven
 * end to end by a test without a repository or a model.
 *
 * Two rules give the record its meaning:
 *
 * - **A harness failure is never an agent result.** If the worktree could not be
 *   made or the adapter threw, the run exits `harness-failed` and no telemetry
 *   is invented. BENCH-5 would rather have an unusable sample that says so than
 *   a usable-looking one that does not.
 * - **A crash keeps its evidence.** Cleanup is skipped after a harness failure,
 *   so the checkout that was being worked in is still on disk to be looked at.
 *   Deleting the only copy of what went wrong is the one cleanup outcome that
 *   cannot be undone.
 */

/** The two time readings a run needs, separated so a test can fix both. */
export interface RunClock {
  /** Monotonic milliseconds; only differences are meaningful. */
  monotonicMs(): number;
  /** Wall-clock ISO-8601 instant the run started at. */
  wallClockIso(): string;
}

/**
 * `performance.now` rather than `Date.now` for the duration: a clock the host
 * adjusts mid-run would otherwise produce a negative or inflated measurement,
 * and a benchmark's duration is one of the numbers it exists to report.
 */
export const systemRunClock: RunClock = {
  monotonicMs: () => performance.now(),
  wallClockIso: () => new Date().toISOString(),
};

export interface IsolatedSampleRequest {
  readonly scenario: BenchmarkScenario;
  readonly mode: ExecutionMode;
  /** 1-based. */
  readonly repetition: number;
  /** Paid model and network execution stay off unless the caller says otherwise. */
  readonly allowNetworkModels: boolean;
}

/**
 * The evidence of one run, handed to an inspector while the checkout still
 * exists.
 */
export interface IsolatedRunEvidence {
  readonly request: IsolatedSampleRequest;
  readonly worktree: IsolatedWorktree;
  readonly capture: IsolatedWorkspaceCapture;
  /** What the agent said about itself. Evidence, never a verdict (BENCH-6). */
  readonly agentClaimedDone: boolean;
}

/**
 * Called once a run's evidence has been captured and before the checkout is
 * disposed of.
 *
 * The independent acceptance verifier re-executes the scenario's declared checks
 * *in the checkout the agent worked in* (BENCH-6), and cleanup removes that
 * checkout. Without this seam the two would have to be ordered by whoever
 * happened to call them, and the first cleanup that ran before a verification
 * would turn every declared check into `check-not-run` — an `inconclusive`
 * indistinguishable from a genuinely unverifiable run.
 *
 * The runner does not learn what the inspector concluded and does not consult
 * it: judging a run is not the runner's job. An inspector that throws is treated
 * like a failed capture — the run becomes `harness-failed` and its checkout is
 * kept, because a sample nobody could verify is the absence of a measurement.
 */
export type IsolatedRunInspector = (evidence: IsolatedRunEvidence) => Promise<void>;

export interface IsolatedSampleRunnerOptions {
  readonly worktrees: IsolatedWorkspacePort;
  /** One adapter per mode; a mode with no adapter is a configuration error, reported as a harness failure. */
  readonly agents: readonly AgentExecutionPort[];
  readonly clock?: RunClock;
}

/** Redacted, single-line, bounded description of a thrown value. */
function describeFailure(error: unknown): string {
  const described =
    error instanceof Error
      ? `${error.name}: ${error.message}`
      : `non-error thrown: ${String(error)}`;
  return redactSecrets(described.replace(/\s+/g, " ").trim()).slice(0, 500);
}

/** Joins two failure descriptions without letting a later one hide an earlier one. */
function combineFailures(first: string, second: string): string {
  if (first === "") return second;
  if (second === "") return first;
  return `${first}; then ${second}`;
}

export class IsolatedSampleRunner {
  readonly #worktrees: IsolatedWorkspacePort;
  readonly #agents: ReadonlyMap<ExecutionMode, AgentExecutionPort>;
  readonly #clock: RunClock;

  constructor(options: IsolatedSampleRunnerOptions) {
    this.#worktrees = options.worktrees;
    const agents = new Map<ExecutionMode, AgentExecutionPort>();
    for (const agent of options.agents) {
      // Two adapters for one mode would mean the samples of that mode were
      // produced by whichever happened to be listed last — a difference in what
      // was measured, hidden in a configuration list.
      if (agents.has(agent.mode)) {
        throw new Error(`Two adapters are configured for the "${agent.mode}" mode.`);
      }
      agents.set(agent.mode, agent);
    }
    this.#agents = agents;
    this.#clock = options.clock ?? systemRunClock;
  }

  async run(
    request: IsolatedSampleRequest,
    inspect?: IsolatedRunInspector,
  ): Promise<IsolatedSampleRun> {
    const startedAt = this.#clock.wallClockIso();
    const startedAtMs = this.#clock.monotonicMs();
    const since = (): number => Math.max(0, Math.round(this.#clock.monotonicMs() - startedAtMs));

    const agent = this.#agents.get(request.mode);
    if (agent === undefined) {
      return this.#unexecuted(
        request,
        startedAt,
        since(),
        `no adapter is configured for the "${request.mode}" mode`,
      );
    }

    let worktree: IsolatedWorktree;
    try {
      worktree = await this.#worktrees.create({
        scenarioId: request.scenario.id,
        fixturePath: request.scenario.fixture,
      });
    } catch (error) {
      return this.#unexecuted(request, startedAt, since(), describeFailure(error));
    }

    let exit: SampleRunExit = "completed";
    let failure = "";
    let agentClaimedDone = false;
    let agentDurationMs = 0;
    let telemetry: IsolatedSampleRun["telemetry"];
    let usage: IsolatedSampleRun["usage"];
    let compression: IsolatedSampleRun["compression"];

    try {
      const outcome = await agent.execute({
        scenario: request.scenario,
        mode: request.mode,
        worktree,
        allowNetworkModels: request.allowNetworkModels,
      });
      telemetry = outcome.telemetry;
      usage = outcome.usage;
      compression = outcome.compression;
      agentClaimedDone = outcome.agentClaimedDone;
      agentDurationMs = outcome.durationMs;
      if (outcome.failure !== undefined && outcome.failure !== "") {
        exit = "agent-failed";
        failure = redactSecrets(outcome.failure).slice(0, 500);
      }
    } catch (error) {
      // One thrown value is not an unmeasured cell: a process tree that could not be confirmed
      // gone means a paid agent is still running on this machine. Recording that as a lost cell
      // and starting the next one puts a second agent beside the first, which is the outcome the
      // kill exists to prevent. Nothing above catches this, so the run stops.
      if (error instanceof AgentProcessTreeAbandonedError) throw error;
      // Everything else: the adapter did not report a failure — it stopped being able to report
      // at all, which says nothing about the agent's ability to do the task.
      exit = "harness-failed";
      failure = describeFailure(error);
    }

    let workspace: IsolatedWorkspaceCapture = {
      ...UNOBSERVED_WORKSPACE,
      baseCommit: worktree.startCommit,
    };
    try {
      workspace = await this.#worktrees.capture(worktree);
    } catch (error) {
      // Without a capture there is no evidence of what the run did, so even a
      // successful-looking execution becomes unmeasured rather than accepted.
      exit = "harness-failed";
      failure = combineFailures(failure, describeFailure(error));
    }

    // Before cleanup, and only when there is something to inspect: an execution
    // that already lost its evidence has nothing an inspector could read, and
    // running one anyway would produce a verdict about a checkout the run itself
    // has disowned.
    if (inspect !== undefined && exit !== "harness-failed") {
      try {
        await inspect({ request, worktree, capture: workspace, agentClaimedDone });
      } catch (error) {
        exit = "harness-failed";
        failure = combineFailures(failure, describeFailure(error));
      }
    }

    const cleanup =
      exit === "harness-failed"
        ? {
            result: "kept-for-diagnosis" as const,
            reason: `harness-failure: the worktree is left at "${worktree.path}" so the failure can be examined`,
          }
        : await this.#cleanup(worktree);

    return {
      scenarioId: request.scenario.id,
      mode: request.mode,
      repetition: request.repetition,
      worktreeId: worktree.id,
      worktreePath: worktree.path,
      startedAt,
      durationMs: since(),
      agentDurationMs,
      exit,
      failure,
      agentClaimedDone,
      telemetry,
      usage,
      compression,
      workspace,
      cleanup,
    };
  }

  /** Cleanup must not be able to fail the run it is cleaning up after. */
  async #cleanup(worktree: IsolatedWorktree): Promise<IsolatedCleanupOutcome> {
    try {
      return await this.#worktrees.cleanupIsolated(worktree);
    } catch (error) {
      return { result: "failed", reason: `cleanup-error: ${describeFailure(error)}` };
    }
  }

  /** A run that never reached a checkout: no execution happened, so nothing about the agent is recorded. */
  #unexecuted(
    request: IsolatedSampleRequest,
    startedAt: string,
    durationMs: number,
    failure: string,
  ): IsolatedSampleRun {
    return {
      scenarioId: request.scenario.id,
      mode: request.mode,
      repetition: request.repetition,
      worktreeId: "",
      worktreePath: "",
      startedAt,
      durationMs,
      agentDurationMs: 0,
      exit: "harness-failed",
      failure,
      agentClaimedDone: false,
      telemetry: undefined,
      usage: undefined,
      compression: undefined,
      workspace: UNOBSERVED_WORKSPACE,
      cleanup: {
        result: "failed",
        reason: `worktree-not-created: there was no checkout to clean up (${failure})`,
      },
    };
  }
}
