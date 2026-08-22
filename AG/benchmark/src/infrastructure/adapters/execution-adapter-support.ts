import type {
  AgentExecutionOutcome,
  AgentExecutionRequest,
  AgentExecutionPort,
} from "../../application/ports/agent-execution-port.js";
import type {
  AgentProcessPort,
  AgentProcessResult,
} from "../../application/ports/agent-process-port.js";
import {
  normalizeExecutionPlan,
  type ExecutionPlanSettings,
  type ModeDifference,
  type NormalizedExecutionPlan,
} from "../../application/ports/execution-plan.js";
import { redactSecrets } from "../../application/secret-redaction.js";
import {
  validateSampleCompressionRecord,
  validateSampleUsageRecord,
} from "../../domain/schema-validation.js";
import type {
  ExecutionMode,
  SampleCompressionRecord,
  SampleTelemetry,
  SampleUsageRecord,
} from "../../domain/result.js";
import type { ValidationProblem, ValidationResult } from "../../domain/validation.js";

/**
 * What every execution adapter shares (BENCH-3, BENCH-5).
 *
 * The three modes differ in how work gets done and in almost nothing else: each
 * normalizes the same plan, each refuses to reach a network it was not given
 * permission for, each reports cost only when it actually observed cost, and
 * each labels a failure with a code that says whether an agent failed or whether
 * no measurement happened at all. Keeping that here means the three adapters are
 * three descriptions of a mode rather than three chances to get the contract
 * subtly different.
 */

/**
 * Failure codes an adapter may report. Stable strings, because the acceptance
 * verifier and the report group on them; a code invented at a call site would be
 * a category nothing downstream knows how to count.
 */
export const EXECUTION_FAILURE_CODES = {
  /** The mode reaches a paid model and the caller did not opt in. */
  networkNotPermitted: "network-not-permitted",
  /** The request was routed to an adapter for a different mode. */
  modeMismatch: "mode-mismatch",
  /** The scenario or run configuration could not produce a usable plan. */
  planRejected: "plan-rejected",
  /** The agent ran past the scenario's timeout and was killed. */
  timeout: "timeout",
  /** The agent ran and exited non-zero, or was killed by a signal. */
  processFailed: "process-failed",
  /** The agent ran but reported no telemetry envelope. */
  telemetryMissing: "telemetry-missing",
  /** The agent reported an envelope that is not a usable cost record. */
  telemetryInvalid: "telemetry-invalid",
  /** The agent ran and spent more than the scenario allowed. */
  tokenLimitExceeded: "token-limit-exceeded",
  /** The deterministic control could not apply its own script. */
  controlEditFailed: "control-edit-failed",
} as const;

export type ExecutionFailureCode =
  (typeof EXECUTION_FAILURE_CODES)[keyof typeof EXECUTION_FAILURE_CODES];

/**
 * The codes that mean *no measurement happened*, as opposed to *the agent
 * failed*.
 *
 * The distinction is the whole point of publishing this set. A run refused for
 * want of a network permission, routed to the wrong adapter or reporting an
 * unreadable cost record says nothing about whether the agent could have done
 * the task — counting it as a failed attempt would quietly lower every success
 * rate the suite reports, and would do so most on the runs an operator
 * deliberately did not pay for. A timeout, a non-zero exit or an exhausted token
 * budget are the opposite: the agent ran under the declared limits and did not
 * succeed, which is exactly what the benchmark exists to record.
 */
export const UNMEASURED_FAILURE_CODES: ReadonlySet<ExecutionFailureCode> = Object.freeze(
  new Set<ExecutionFailureCode>([
    EXECUTION_FAILURE_CODES.networkNotPermitted,
    EXECUTION_FAILURE_CODES.modeMismatch,
    EXECUTION_FAILURE_CODES.planRejected,
    EXECUTION_FAILURE_CODES.telemetryMissing,
    EXECUTION_FAILURE_CODES.telemetryInvalid,
    EXECUTION_FAILURE_CODES.controlEditFailed,
  ]),
);

/** True when `failure` names a reason the sample carries no usable agent result. */
export function isUnmeasuredFailure(failure: string): boolean {
  const code = failure.split(":", 1)[0] ?? "";
  return UNMEASURED_FAILURE_CODES.has(code as ExecutionFailureCode);
}

/**
 * The runner truncates a recorded failure at 500 characters; producing the same
 * bound here keeps the code and the beginning of the detail inside it rather
 * than letting a long tool message push the reason out of the record.
 */
const MAX_FAILURE_DETAIL = 400;

/** `<code>: <detail>`, single-line, redacted and bounded. */
export function executionFailure(code: ExecutionFailureCode, detail: string): string {
  const flattened = redactSecrets(detail.replace(/\s+/g, " ").trim()).slice(0, MAX_FAILURE_DETAIL);
  return flattened === "" ? code : `${code}: ${flattened}`;
}

/** Redacted, single-line description of a thrown value, safe to build inside a `catch`. */
export function describeThrown(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}

/**
 * The key and version identifying a telemetry envelope on standard output.
 *
 * An envelope rather than a parsed transcript: what a sample costs is the one
 * number the benchmark cannot reconstruct afterwards, and scraping it out of
 * human-facing output would make every agent's log format part of the
 * measurement. A tool that wants to be benchmarked prints one line saying what it
 * spent; one that does not is reported as having no usable cost record, which is
 * a fact about the run rather than a number invented on its behalf.
 */
export const TELEMETRY_ENVELOPE_KEY = "agBenchmarkTelemetry";

/**
 * The version this package emits and expects. Version 2 added the optional
 * `usage` and `compression` blocks (task 0029).
 */
export const TELEMETRY_ENVELOPE_VERSION = 2;

/**
 * Versions an envelope may declare. Version 1 stays readable, because an agent
 * built against the earlier contract still reports a usable cost record; what it
 * may not do is carry a version-2 block, since the presence of a field that did
 * not exist under its declared version means the version claim is false.
 */
export const SUPPORTED_TELEMETRY_ENVELOPE_VERSIONS: readonly number[] = [1, 2];

/** Blocks version 1 did not define. */
const ENVELOPE_V2_KEYS = ["usage", "compression"] as const;

/** Longer than any envelope; a line past this is output, not a cost record. */
const MAX_ENVELOPE_LINE_LENGTH = 64 * 1024;

export interface TelemetryEnvelopeReading {
  readonly telemetry?: SampleTelemetry;
  /** Present only when the envelope carried a readable v2 usage block. Absent is absent, never zero. */
  readonly usage?: SampleUsageRecord;
  readonly compression?: SampleCompressionRecord;
  readonly agentClaimedDone: boolean;
  /** Empty when a usable envelope was read; otherwise why it was not. */
  readonly problem: string;
}

/** One optional envelope block, or the reason it could not be read. */
interface EnvelopeBlockReading<T> {
  readonly value?: T;
  readonly problem: string;
}

const NO_BLOCK: EnvelopeBlockReading<never> = { problem: "" };

function describeProblems(block: string, problems: readonly ValidationProblem[]): string {
  return `the envelope's ${block} block is not a usable record: ${problems
    .map((problem) => `${problem.path} ${problem.message}`)
    .join("; ")}`;
}

/**
 * Reads an optional block through the domain's own schema.
 *
 * The store will apply these rules later; applying them here means a producer
 * learns about its contradiction while the run is happening rather than losing
 * the whole sample after the tokens are spent. A *present but malformed* block
 * is loud, an *absent* one is absent — the same stance the count fields take,
 * and the reason a missing usage record can never be read as a free run.
 */
function readEnvelopeBlock<T>(
  record: Record<string, unknown>,
  key: (typeof ENVELOPE_V2_KEYS)[number],
  version: number,
  validate: (input: unknown) => ValidationResult<T>,
): EnvelopeBlockReading<T> {
  if (!Object.hasOwn(record, key)) return NO_BLOCK;
  if (version < TELEMETRY_ENVELOPE_VERSION) {
    return {
      problem: `the envelope declares version ${version} and carries a "${key}" block, which version ${TELEMETRY_ENVELOPE_VERSION} introduced`,
    };
  }
  const result = validate(record[key]);
  return result.ok
    ? { value: result.value, problem: "" }
    : { problem: describeProblems(key, result.problems) };
}

/**
 * The usage block, with its provenance supplied by the reader.
 *
 * An envelope printed on standard output is the envelope's own record by
 * definition, so the agent does not get to name the source: a run that could
 * label its numbers `run-log` could claim a provenance nobody can check.
 */
function readEnvelopeUsage(
  record: Record<string, unknown>,
  version: number,
): EnvelopeBlockReading<SampleUsageRecord> {
  if (!Object.hasOwn(record, "usage")) return NO_BLOCK;
  const raw = record["usage"];
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return { problem: "the envelope's usage block is not an object" };
  }
  if (Object.hasOwn(raw, "source")) {
    return {
      problem:
        "the envelope's usage block names its own source; a block printed by the agent is the envelope's, and its provenance is recorded by the reader",
    };
  }
  return readEnvelopeBlock({ ...record, usage: { ...raw, source: "envelope" } }, "usage", version, (
    input,
  ) => validateSampleUsageRecord(input));
}

function countField(record: Record<string, unknown>, field: string): number {
  const value = record[field];
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    return Number.NaN;
  }
  return value;
}

/**
 * Reads the telemetry envelope from standard output, scanning backwards.
 *
 * Backwards because the envelope is the last thing a run prints, and the *first*
 * envelope found from the end is the one that is validated even if it turns out
 * malformed. Continuing the scan past a broken envelope would let a stale earlier
 * line stand in for the run that actually happened — a cost record silently
 * describing a different execution is worse than no cost record at all.
 */
export function readTelemetryEnvelope(stdout: string): TelemetryEnvelopeReading {
  const lines = stdout.split(/\r?\n/);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = (lines[index] ?? "").trim();
    if (!line.startsWith("{") || line.length > MAX_ENVELOPE_LINE_LENGTH) continue;

    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) continue;

    const record = parsed as Record<string, unknown>;
    const version = record[TELEMETRY_ENVELOPE_KEY];
    if (typeof version !== "number" || !SUPPORTED_TELEMETRY_ENVELOPE_VERSIONS.includes(version)) {
      continue;
    }

    const model = record["model"];
    if (typeof model !== "string" || model.trim() === "") {
      return {
        agentClaimedDone: false,
        problem: "the envelope names no model",
      };
    }

    const telemetry: SampleTelemetry = {
      model: redactSecrets(model.trim()).slice(0, 200),
      inputTokens: countField(record, "inputTokens"),
      outputTokens: countField(record, "outputTokens"),
      llmCalls: countField(record, "llmCalls"),
      attempts: countField(record, "attempts"),
      repairs: countField(record, "repairs"),
      humanReviewEvents: countField(record, "humanReviewEvents"),
    };
    const missing = (Object.entries(telemetry) as readonly [string, string | number][])
      .filter(([, value]) => typeof value === "number" && Number.isNaN(value))
      .map(([field]) => field);
    if (missing.length > 0) {
      return {
        agentClaimedDone: false,
        problem: `the envelope fields ${missing.join(", ")} are not non-negative integers`,
      };
    }
    if (telemetry.attempts < 1) {
      return {
        agentClaimedDone: false,
        problem: "the envelope reports fewer than one attempt, so nothing was executed",
      };
    }

    const usage = readEnvelopeUsage(record, version);
    const compression = readEnvelopeBlock(record, "compression", version, (input) =>
      validateSampleCompressionRecord(input),
    );
    const blockProblem = usage.problem === "" ? compression.problem : usage.problem;
    if (blockProblem !== "") {
      // The cost record itself parsed, but a block beside it did not. Reporting
      // the telemetry anyway would publish a sample whose variant or whose cache
      // tokens nobody could read, attributed to a variant nobody verified.
      return { agentClaimedDone: false, problem: blockProblem };
    }

    return {
      telemetry,
      ...(usage.value === undefined ? {} : { usage: usage.value }),
      ...(compression.value === undefined ? {} : { compression: compression.value }),
      agentClaimedDone: record["claimedDone"] === true,
      problem: "",
    };
  }
  return { agentClaimedDone: false, problem: "" };
}

/** Description of the process that ran and failed, used as a failure detail. */
function describeProcessExit(result: AgentProcessResult): string {
  const status =
    result.signal !== null
      ? `was killed by ${result.signal}`
      : `exited ${result.exitCode === null ? "without a status" : String(result.exitCode)}`;
  const stderr = result.stderr.trim();
  return stderr === "" ? status : `${status}: ${stderr}`;
}

/** The command line an adapter builds for one plan. */
export interface AgentInvocation {
  readonly command: string;
  readonly args: readonly string[];
  readonly stdin: string;
  /** Forwarded verbatim to the process port; credentials appear here only if the caller put them there. */
  readonly env: Readonly<Record<string, string>>;
}

export interface ProcessExecutionAdapterOptions {
  readonly mode: ExecutionMode;
  readonly adapterVersion: string;
  readonly settings: ExecutionPlanSettings;
  readonly processes: AgentProcessPort;
  /**
   * Builds the command line for a plan. Supplied by the caller rather than
   * hardcoded: which binary and which flags drive a given agent is a wiring
   * decision that changes with the tool, while everything this adapter is
   * responsible for — the plan, the permission gate, the cost contract, the mode
   * audit — does not.
   */
  readonly invocation: (plan: NormalizedExecutionPlan) => AgentInvocation;
  /**
   * A mode-specific check on the reported cost record. Returns an empty string
   * when the record is consistent with what the mode claims about itself, or the
   * contradiction otherwise.
   */
  readonly verifyTelemetry?: (telemetry: SampleTelemetry) => string;
  readonly monotonicMs?: () => number;
}

/**
 * The shared body of every mode that works by running an external agent.
 *
 * The order is fixed and the permission gate is first: nothing is spawned, and
 * no environment carrying a credential is even assembled, until the mode's
 * network requirement has been checked against the caller's explicit opt-in.
 */
export class ProcessExecutionAdapter implements AgentExecutionPort {
  readonly mode: ExecutionMode;
  readonly adapterVersion: string;
  readonly #options: ProcessExecutionAdapterOptions;
  readonly #monotonicMs: () => number;

  constructor(options: ProcessExecutionAdapterOptions) {
    this.mode = options.mode;
    this.adapterVersion = options.adapterVersion;
    this.#options = options;
    this.#monotonicMs = options.monotonicMs ?? (() => performance.now());
  }

  async execute(request: AgentExecutionRequest): Promise<AgentExecutionOutcome> {
    const startedMs = this.#monotonicMs();
    const elapsed = (): number => Math.max(0, Math.round(this.#monotonicMs() - startedMs));

    if (request.mode !== this.mode) {
      // Routing is the runner's job, so this is a wiring defect rather than a
      // result: reporting it as an agent failure would attribute a harness bug
      // to whichever mode happened to be asked for.
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
          allowNetworkModels: request.allowNetworkModels,
        },
        this.#options.settings,
      );
    } catch (error) {
      return {
        durationMs: elapsed(),
        agentClaimedDone: false,
        failure: executionFailure(EXECUTION_FAILURE_CODES.planRejected, describeThrown(error)),
      };
    }

    if (!plan.networkPermitted) {
      return {
        durationMs: elapsed(),
        agentClaimedDone: false,
        plan,
        failure: executionFailure(
          EXECUTION_FAILURE_CODES.networkNotPermitted,
          `the "${this.mode}" mode reaches a paid model, and this run was not started with network execution allowed`,
        ),
      };
    }

    const invocation = this.#options.invocation(plan);
    const result = await this.#options.processes.run({
      command: invocation.command,
      args: invocation.args,
      cwd: plan.workingDirectory,
      timeoutMs: plan.limits.timeoutMs,
      env: invocation.env,
      stdin: invocation.stdin,
    });

    const reading = readTelemetryEnvelope(result.stdout);
    const durationMs = elapsed();
    const differences = [...plan.differences, ...observedDifferences(plan, reading.telemetry)];
    const executedPlan: NormalizedExecutionPlan = { ...plan, differences };

    const failure = this.#classify(plan, result, reading);
    const outcome: AgentExecutionOutcome = {
      durationMs,
      agentClaimedDone: reading.agentClaimedDone,
      plan: executedPlan,
      ...(reading.telemetry === undefined ? {} : { telemetry: reading.telemetry }),
      ...(reading.usage === undefined ? {} : { usage: reading.usage }),
      ...(reading.compression === undefined ? {} : { compression: reading.compression }),
      ...(failure === "" ? {} : { failure }),
    };
    return outcome;
  }

  /**
   * The first thing that went wrong, in the order a reader would want it. A
   * timeout outranks a non-zero exit because a killed process exits non-zero as a
   * consequence, and reporting the consequence would hide the cause.
   */
  #classify(
    plan: NormalizedExecutionPlan,
    result: AgentProcessResult,
    reading: TelemetryEnvelopeReading,
  ): string {
    if (result.timedOut) {
      return executionFailure(
        EXECUTION_FAILURE_CODES.timeout,
        `the agent was killed after the scenario's ${plan.limits.timeoutMs} ms limit`,
      );
    }
    if (result.exitCode !== 0 || result.signal !== null) {
      return executionFailure(
        EXECUTION_FAILURE_CODES.processFailed,
        describeProcessExit(result),
      );
    }
    if (reading.problem !== "") {
      return executionFailure(EXECUTION_FAILURE_CODES.telemetryInvalid, reading.problem);
    }
    if (reading.telemetry === undefined) {
      return executionFailure(
        EXECUTION_FAILURE_CODES.telemetryMissing,
        result.outputTruncated
          ? "the agent printed no telemetry envelope, and its output was truncated at the harness ceiling"
          : "the agent printed no telemetry envelope, so what the run cost is unknown",
      );
    }

    const contradiction = this.#options.verifyTelemetry?.(reading.telemetry) ?? "";
    if (contradiction !== "") {
      return executionFailure(EXECUTION_FAILURE_CODES.telemetryInvalid, contradiction);
    }

    const spent = reading.telemetry.inputTokens + reading.telemetry.outputTokens;
    if (spent > plan.limits.tokenLimit) {
      // Still a measurement: the tokens were spent and are recorded. The limit
      // is what the scenario declared the attempt was worth, not a harness fault.
      return executionFailure(
        EXECUTION_FAILURE_CODES.tokenLimitExceeded,
        `the agent spent ${spent} tokens against a limit of ${plan.limits.tokenLimit}`,
      );
    }
    return "";
  }
}

/**
 * Differences observed while executing, as opposed to those a mode declared in
 * advance. Today there is one: the model that answered was not the model the run
 * asked for. It belongs in the audit rather than in a failure — a provider
 * substitution is a real thing that happens, and a comparison drawn across it is
 * weaker rather than void, which is the reader's call to make.
 */
function observedDifferences(
  plan: NormalizedExecutionPlan,
  telemetry: SampleTelemetry | undefined,
): readonly ModeDifference[] {
  if (telemetry === undefined || telemetry.model === plan.model) return [];
  return [
    {
      aspect: "model",
      code: "model-substituted",
      detail: `The run was configured for "${plan.model}" but the agent reported "${telemetry.model}".`,
    },
  ];
}
