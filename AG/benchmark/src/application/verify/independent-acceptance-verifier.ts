import {
  decideAcceptance,
  type AcceptanceVerificationResult,
  type ExecutedCheck,
} from "../../domain/verification/acceptance.js";
import type { CheckStatus } from "../../domain/result.js";
import type { BenchmarkScenario, ScenarioCheck } from "../../domain/scenario.js";
import type {
  AcceptanceVerificationRequest,
  AcceptanceVerifierPort,
} from "../ports/acceptance-verifier-port.js";
import { redactSecrets } from "../secret-redaction.js";
import type { CheckExecutionPort, CheckExecutionResult } from "./check-execution-port.js";

/**
 * The independent acceptance verifier (BENCH-6).
 *
 * "Independent" is a description of the inputs, not a claim about the code. The
 * verifier is handed the scenario, the checkout and the file list the harness
 * captured from Git, and it re-executes the scenario's declared checks itself.
 * The agent's report reaches it through exactly one field — `agentClaimedDone` —
 * which is carried into the record so the distance between claimed and verified
 * success can be measured, and which no gate consults.
 *
 * Everything the verifier decides is decided in
 * {@link decideAcceptance}; this class only obtains the evidence that function
 * needs. The split is what makes the rule "a false `done` over an empty change
 * is rejected" a statement a test makes about a value rather than about a
 * process.
 *
 * ## Fail-closed
 *
 * Every path that ends without evidence ends without an acceptance:
 *
 * - a run with no usable checkout is verified against nothing, so no check is
 *   executed and the decision is `inconclusive`;
 * - a check the port could not run at all, or that was killed before reporting,
 *   is `errored` rather than assumed;
 * - a check that timed out is `errored` too — a killed process produced no
 *   verdict, and treating a hang as a failure would let it satisfy a scenario
 *   whose check is expected to fail.
 */

/**
 * The longest a single declared check may run, whatever the scenario's own
 * timeout is. The scenario timeout bounds the *agent*, which may legitimately
 * work for the better part of an hour; a check is a command over a small fixture
 * and a slow one is a stuck one. Taking the smaller of the two keeps a hung
 * check from outliving the sample it was supposed to judge.
 */
export const CHECK_TIMEOUT_MS_CEILING = 600_000;

/** Bound on any recorded problem string, matching what the run record stores. */
const MAX_PROBLEM_LENGTH = 500;

export interface IndependentAcceptanceVerifierOptions {
  readonly checks: CheckExecutionPort;
  /** Monotonic milliseconds; only differences are read. */
  readonly monotonicMs?: () => number;
}

function problemText(value: string): string {
  return redactSecrets(value.replace(/\s+/g, " ").trim()).slice(0, MAX_PROBLEM_LENGTH);
}

function describeThrown(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}

/** The timeout one check gets: the scenario's own bound, never above the ceiling. */
export function checkTimeoutMs(scenario: BenchmarkScenario): number {
  return Math.min(scenario.limits.timeoutMs, CHECK_TIMEOUT_MS_CEILING);
}

/**
 * What a finished process says about the check it ran.
 *
 * A killed process — by timeout or by any other signal — reports `errored`: it
 * was stopped rather than finished, so it stated neither that the change is good
 * nor that it is broken. An exit status is the only thing read as a verdict.
 */
function statusOf(result: CheckExecutionResult): { status: CheckStatus; problem: string } {
  if (result.timedOut) {
    return { status: "errored", problem: "the check was killed after its timeout" };
  }
  if (result.signal !== null) {
    return { status: "errored", problem: `the check was killed by ${result.signal}` };
  }
  if (result.exitCode === null) {
    return { status: "errored", problem: "the check ended without an exit status" };
  }
  if (result.exitCode === 0) return { status: "passed", problem: "" };
  return {
    status: "failed",
    problem: `exited ${result.exitCode}${result.output === "" ? "" : `: ${result.output}`}`,
  };
}

export class IndependentAcceptanceVerifier implements AcceptanceVerifierPort {
  readonly #checks: CheckExecutionPort;
  readonly #monotonicMs: () => number;

  constructor(options: IndependentAcceptanceVerifierOptions) {
    this.#checks = options.checks;
    this.#monotonicMs = options.monotonicMs ?? (() => performance.now());
  }

  async verify(request: AcceptanceVerificationRequest): Promise<AcceptanceVerificationResult> {
    const startedMs = this.#monotonicMs();
    const evidenceProblem = this.#evidenceProblem(request);

    const executedChecks =
      evidenceProblem === ""
        ? await this.#runChecks(request)
        : request.scenario.checks.map(
            (check): ExecutedCheck => ({
              checkId: check.id,
              status: "skipped",
              durationMs: 0,
              problem: "the run left no checkout to verify in",
            }),
          );

    return decideAcceptance({
      scenario: request.scenario,
      changedFiles: request.changedFiles,
      executedChecks,
      agentClaimedDone: request.agentClaimedDone,
      evidenceProblem,
      gateDurationMs: Math.max(0, Math.round(this.#monotonicMs() - startedMs)),
    });
  }

  /** Why this run cannot be verified at all, or an empty string when it can. */
  #evidenceProblem(request: AcceptanceVerificationRequest): string {
    if (request.worktree.path.trim() === "") {
      return "the run reported no worktree path, so there is no checkout to verify";
    }
    if (request.worktree.startCommit.trim() === "") {
      return "the run reported no starting commit, so what it changed cannot be established";
    }
    return "";
  }

  /**
   * Runs the declared checks one after another. Sequentially because they share
   * one checkout: two commands writing a fixture's build output at the same time
   * would make each other's result depend on scheduling, and a benchmark whose
   * numbers move with the scheduler is not measuring the agent.
   */
  async #runChecks(request: AcceptanceVerificationRequest): Promise<readonly ExecutedCheck[]> {
    const executed: ExecutedCheck[] = [];
    for (const check of request.scenario.checks) {
      executed.push(await this.#runCheck(check, request));
    }
    return executed;
  }

  async #runCheck(
    check: ScenarioCheck,
    request: AcceptanceVerificationRequest,
  ): Promise<ExecutedCheck> {
    const [command, ...args] = check.command;
    const startedMs = this.#monotonicMs();
    const elapsed = (): number => Math.max(0, Math.round(this.#monotonicMs() - startedMs));

    if (command === undefined) {
      return {
        checkId: check.id,
        status: "errored",
        durationMs: elapsed(),
        problem: "the check declares an empty command",
      };
    }

    try {
      const result = await this.#checks.run({
        command,
        args,
        cwd: request.worktree.path,
        timeoutMs: checkTimeoutMs(request.scenario),
      });
      const { status, problem } = statusOf(result);
      return { checkId: check.id, status, durationMs: elapsed(), problem: problemText(problem) };
    } catch (error) {
      // The check did not fail — the verifier failed to run it, which says
      // nothing about the change and must not be counted as if it did.
      return {
        checkId: check.id,
        status: "errored",
        durationMs: elapsed(),
        problem: problemText(`the check could not be run: ${describeThrown(error)}`),
      };
    }
  }
}
