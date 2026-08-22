import type {
  AgentExecutionOutcome,
  AgentExecutionPort,
  AgentExecutionRequest,
} from "../../application/ports/agent-execution-port.js";
import {
  CONTROL_MODEL_ID,
  normalizeExecutionPlan,
  type ExecutionPlanSettings,
  type NormalizedExecutionPlan,
} from "../../application/ports/execution-plan.js";
import type {
  WorkspaceFileEdit,
  WorkspaceFilePort,
} from "../../application/ports/workspace-file-port.js";
import type { SampleTelemetry } from "../../domain/result.js";
import {
  describeThrown,
  executionFailure,
  EXECUTION_FAILURE_CODES,
} from "./execution-adapter-support.js";

/**
 * The `deterministic-control` mode: the same scenarios, the same isolation, the
 * same verifier, and no model at all (BENCH-3).
 *
 * The control is what makes the other two numbers mean something. It answers two
 * questions no amount of comparing `ag-loop` against `agent-solo` can:
 *
 * - **What does the harness itself cost?** Its duration is setup, capture,
 *   checks and cleanup with the agent removed, so any per-sample overhead is
 *   attributed to the harness rather than to whichever mode ran first.
 * - **Which scenarios does doing nothing already pass?** For the violation and
 *   impossible-task scenarios the expected outcome is `rejected`, and a control
 *   that changes nothing meets it. A mode scoring no better than the control on
 *   those has demonstrated no ability to refuse — only an inability to act.
 *
 * It is offline by construction rather than by policy: the adapter is handed a
 * file writer and no process runner, so there is nothing here that could reach a
 * network whatever a caller passes for `allowNetworkModels`.
 */

/**
 * Left at `/1` while the other two moved to `/2` (task 0029): this mode reads no
 * telemetry envelope, reports no usage and runs under no compression variant, so
 * nothing about what it measures changed.
 */
export const DETERMINISTIC_CONTROL_ADAPTER_VERSION = "deterministic-control/1";

/**
 * The fixed edit a scenario's control performs. A scenario with no script is not
 * a gap: it is the control asserting that doing nothing is the honest floor for
 * that scenario, which is the right answer for every scenario whose expected
 * outcome is a refusal.
 */
export interface DeterministicControlScript {
  readonly scenarioId: string;
  readonly edits: readonly WorkspaceFileEdit[];
  /**
   * What the control reports about itself, recorded as evidence exactly like an
   * agent's claim. A control that claimed success would be measuring the
   * verifier — which is the point when a scripted change is meant to be accepted.
   */
  readonly claimsDone: boolean;
}

export interface DeterministicControlAdapterOptions {
  readonly settings: ExecutionPlanSettings;
  readonly files: WorkspaceFilePort;
  /** Scripts by scenario; a scenario named twice is a configuration error. */
  readonly scripts?: readonly DeterministicControlScript[];
  readonly monotonicMs?: () => number;
}

/**
 * Zero cost, one attempt. The attempt is real — the control did execute — while
 * every model-shaped counter is zero because no model was involved. BENCH-7 reads
 * these zeros as a denominator, so they have to be the floor rather than a
 * placeholder for "not measured".
 */
function controlTelemetry(): SampleTelemetry {
  return {
    model: CONTROL_MODEL_ID,
    inputTokens: 0,
    outputTokens: 0,
    llmCalls: 0,
    attempts: 1,
    repairs: 0,
    humanReviewEvents: 0,
  };
}

export class DeterministicControlAdapter implements AgentExecutionPort {
  readonly mode = "deterministic-control" as const;
  readonly adapterVersion = DETERMINISTIC_CONTROL_ADAPTER_VERSION;
  readonly #settings: ExecutionPlanSettings;
  readonly #files: WorkspaceFilePort;
  readonly #scripts: ReadonlyMap<string, DeterministicControlScript>;
  readonly #monotonicMs: () => number;

  constructor(options: DeterministicControlAdapterOptions) {
    this.#settings = options.settings;
    this.#files = options.files;
    const scripts = new Map<string, DeterministicControlScript>();
    for (const script of options.scripts ?? []) {
      // Two scripts for one scenario would make the control's change depend on
      // list order — a control whose behaviour is not fixed is not a control.
      if (scripts.has(script.scenarioId)) {
        throw new Error(
          `Two deterministic control scripts are configured for the "${script.scenarioId}" scenario.`,
        );
      }
      scripts.set(script.scenarioId, script);
    }
    this.#scripts = scripts;
    this.#monotonicMs = options.monotonicMs ?? (() => performance.now());
  }

  async execute(request: AgentExecutionRequest): Promise<AgentExecutionOutcome> {
    const startedMs = this.#monotonicMs();
    const elapsed = (): number => Math.max(0, Math.round(this.#monotonicMs() - startedMs));

    if (request.mode !== this.mode) {
      return {
        durationMs: elapsed(),
        agentClaimedDone: false,
        failure: executionFailure(
          EXECUTION_FAILURE_CODES.modeMismatch,
          `the "${this.mode}" adapter was asked to execute the "${request.mode}" mode`,
        ),
      };
    }

    let plan: NormalizedExecutionPlan;
    try {
      plan = normalizeExecutionPlan(
        {
          scenario: request.scenario,
          mode: request.mode,
          workingDirectory: request.worktree.path,
          startCommit: request.worktree.startCommit,
          // Passed through unchanged so the plan records the run's setting, not a
          // rewritten one. The mode's profile is what keeps `networkPermitted`
          // false here regardless of what the caller allowed.
          allowNetworkModels: request.allowNetworkModels,
        },
        this.#settings,
      );
    } catch (error) {
      return {
        durationMs: elapsed(),
        agentClaimedDone: false,
        failure: executionFailure(EXECUTION_FAILURE_CODES.planRejected, describeThrown(error)),
      };
    }

    const script = this.#scripts.get(plan.scenarioId);
    if (script === undefined || script.edits.length === 0) {
      // Nothing to apply, and nothing went wrong: an empty change is this mode's
      // result for this scenario, and the verifier judges it like any other.
      return {
        durationMs: elapsed(),
        agentClaimedDone: false,
        telemetry: controlTelemetry(),
        plan,
      };
    }

    try {
      await this.#files.apply(plan.workingDirectory, script.edits);
    } catch (error) {
      // A control that could not write its own script produced no measurement.
      // Reporting it as a completed empty change would make a harness fault look
      // like the control's honest floor for this scenario.
      return {
        durationMs: elapsed(),
        agentClaimedDone: false,
        plan,
        failure: executionFailure(
          EXECUTION_FAILURE_CODES.controlEditFailed,
          describeThrown(error),
        ),
      };
    }

    return {
      durationMs: elapsed(),
      agentClaimedDone: script.claimsDone,
      telemetry: controlTelemetry(),
      plan,
    };
  }
}
