import type { AgentExecutionRequest } from "../application/ports/agent-execution-port.js";
import type {
  AgentProcessPort,
  AgentProcessResult,
  AgentProcessSpec,
} from "../application/ports/agent-process-port.js";
import type {
  ExecutionPlanInput,
  ExecutionPlanSettings,
} from "../application/ports/execution-plan.js";
import type {
  RunIdentityRecord,
  RunIdentityStorePort,
} from "../application/ports/run-identity-store-port.js";
import type { SampleStorePort } from "../application/ports/sample-store-port.js";
import type {
  WorkspaceFileEdit,
  WorkspaceFilePort,
} from "../application/ports/workspace-file-port.js";
import type { BenchmarkSample } from "../domain/result.js";
import type { BenchmarkScenario } from "../domain/scenario.js";
import {
  TELEMETRY_ENVELOPE_KEY,
  TELEMETRY_ENVELOPE_VERSION,
} from "../infrastructure/adapters/execution-adapter-support.js";

/**
 * Shared doubles for the execution-mode adapters.
 *
 * Every test states only the field it is about; everything else stays at a value
 * the adapters accept, so a failure names the rule under test rather than a
 * scenario field a test forgot to fill in. Nothing here starts a process or
 * touches a disk — the adapters' contract is what they do with a result, and a
 * real agent would answer that question with its own behaviour instead.
 */

export const WORKTREE_PATH = "/runs/run-0001/worktrees/docs-add-page-0001";
export const START_COMMIT = "a".repeat(40);
export const RUN_MODEL = "claude-opus-5";

export function scenario(overrides: Partial<BenchmarkScenario> = {}): BenchmarkScenario {
  return {
    id: "docs-add-page",
    title: "Add a documentation page",
    category: "docs",
    fixture: "fixtures/docs-site",
    task: "Add the missing page.",
    allowedPaths: ["docs/**"],
    forbiddenPaths: [],
    checks: [{ id: "docs", command: ["node", "--test"], expect: "pass" }],
    expectedOutcome: "accepted",
    limits: { timeoutMs: 60_000, tokenLimit: 100_000 },
    deterministic: false,
    ...overrides,
  };
}

export function executionSettings(
  overrides: Partial<ExecutionPlanSettings> = {},
): ExecutionPlanSettings {
  return {
    modelSettings: { model: RUN_MODEL },
    ceiling: { timeoutMs: 600_000, tokenLimit: 500_000 },
    ...overrides,
  };
}

export function planInput(overrides: Partial<ExecutionPlanInput> = {}): ExecutionPlanInput {
  return {
    scenario: scenario(),
    mode: "ag-loop",
    workingDirectory: WORKTREE_PATH,
    startCommit: START_COMMIT,
    allowNetworkModels: true,
    ...overrides,
  };
}

export function executionRequest(
  overrides: Partial<AgentExecutionRequest> = {},
): AgentExecutionRequest {
  return {
    scenario: scenario(),
    mode: "ag-loop",
    worktree: { id: "docs-add-page-0001", path: WORKTREE_PATH, startCommit: START_COMMIT },
    allowNetworkModels: true,
    ...overrides,
  };
}

/** A well-formed telemetry envelope line, as a benchmarked agent would print it. */
export function telemetryEnvelope(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    [TELEMETRY_ENVELOPE_KEY]: TELEMETRY_ENVELOPE_VERSION,
    model: RUN_MODEL,
    inputTokens: 1_000,
    outputTokens: 200,
    llmCalls: 3,
    attempts: 1,
    repairs: 0,
    humanReviewEvents: 0,
    claimedDone: true,
    ...overrides,
  });
}

export function processResult(overrides: Partial<AgentProcessResult> = {}): AgentProcessResult {
  return {
    exitCode: 0,
    signal: null,
    stdout: `working…\n${telemetryEnvelope()}\n`,
    stderr: "",
    timedOut: false,
    outputTruncated: false,
    ...overrides,
  };
}

/** Records every spawn it was asked for and answers with a scripted result. */
export class FakeProcessPort implements AgentProcessPort {
  readonly spawns: AgentProcessSpec[] = [];

  constructor(private readonly result: AgentProcessResult = processResult()) {}

  async run(spec: AgentProcessSpec): Promise<AgentProcessResult> {
    this.spawns.push(spec);
    return this.result;
  }
}

/** Records applied edits, or refuses when the test asked it to. */
export class FakeWorkspaceFiles implements WorkspaceFilePort {
  readonly applied: { readonly worktreePath: string; readonly edits: readonly WorkspaceFileEdit[] }[] =
    [];

  constructor(private readonly failure?: Error) {}

  async apply(
    worktreePath: string,
    edits: readonly WorkspaceFileEdit[],
  ): Promise<readonly string[]> {
    this.applied.push({ worktreePath, edits });
    if (this.failure !== undefined) throw this.failure;
    return edits.map((edit) => edit.path).sort();
  }
}

/**
 * The two stores the run pipeline writes to.
 *
 * Both append to the same `events` log when a test hands them one, which is what
 * makes "the identity was recorded before the first sample" an assertion about
 * order rather than about two independently observed counts.
 */
export class RecordingSampleStore implements SampleStorePort {
  readonly appended: BenchmarkSample[] = [];

  constructor(readonly events: string[] = []) {}

  async append(sample: BenchmarkSample): Promise<void> {
    this.events.push(`append:${sample.sampleId}`);
    this.appended.push(sample);
  }

  async readAll(): Promise<{
    readonly samples: readonly BenchmarkSample[];
    readonly corruptRecords: readonly string[];
  }> {
    return { samples: this.appended, corruptRecords: [] };
  }
}

/** Records the run's identity, or refuses to when the test asked it to. */
export class RecordingRunIdentityStore implements RunIdentityStorePort {
  readonly recorded: RunIdentityRecord[] = [];

  constructor(
    readonly events: string[] = [],
    private readonly failure?: Error,
  ) {}

  async record(record: RunIdentityRecord): Promise<void> {
    this.events.push(`record:${record.runId}`);
    if (this.failure !== undefined) throw this.failure;
    this.recorded.push(record);
  }

  async readDocument(): Promise<unknown> {
    return this.recorded[0];
  }
}

/** A clock whose first reading starts the execution and whose later ones are `elapsedMs` later. */
export function fixedMonotonic(elapsedMs: number): () => number {
  let readings = 0;
  return () => (readings++ === 0 ? 1_000 : 1_000 + elapsedMs);
}
