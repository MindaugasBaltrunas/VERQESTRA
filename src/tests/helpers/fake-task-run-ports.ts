// Fake TaskRunPorts rinkinys task-execution unit testams: jokios realios FS/git (WBR E3).
// Diagnozės taisyklės čia REALIOS (domain/diagnosis) — fake'inami tik efektai.
import { resolveNoCommitDisposition, resolveNoCommitReviewReason } from "../../domain/diagnosis/dispositions.js";
import { classifyDispatchWriteOutcome, extractDispatchToolUsage } from "../../infrastructure/adapters/claude-tool-schema.js";
import type {
  DecisionReadResult,
  JsonReadResult,
  RunCheckpoint,
  StopStatusSnapshot,
  TaskRunPorts,
} from "../../application/task-execution/run-coordinator-ports.js";
import type { TaskBucket } from "../../domain/tasks/index.js";

const BUCKET_ROOT = "/ag/tasks";

export type FakeTaskRunEnv = {
  ports: TaskRunPorts;
  logs: string[];
  /** Kiekvienas `cli.run`/`cli.runCaptured` kvietimas (pirmas arg — komanda). */
  cliCalls: string[][];
  journalEvents: { task_id: string; to_state: string; reason: string; phase?: string; exit_code?: number }[];
  phaseFailures: { taskId: string; phase: string; exitCode: number }[];
  checkpoints: RunCheckpoint[];
  ledgerRecords: { taskId: string; state: string; file: string }[];
  /** 017: kiekvieno `enforceBudget` kvietimo `model` — testas tvirtina, KĄ vartai tikrino. */
  budgetModels: string[];
  /** Failų kūnai pagal absoliutų kelią — bucket perkėlimai juda šiame žemėlapyje. */
  files: Map<string, string>;
  /** Elgesio rankenėlės — testas jas perrašo pagal scenarijų. */
  behavior: {
    cli(args: string[]): number | { code: number; output: string };
    decision: DecisionReadResult;
    stopStatus: JsonReadResult<StopStatusSnapshot>;
    claudeLog: string;
    infrastructureExitCodes: number[];
    dispatchInfrastructureFailure: boolean;
    contextPack(): Record<string, unknown>;
    /** 017: routed modelio klasė vartams; funkcija gali mesti — tada dispatch-task krenta į decision modelį. */
    routedModelClass(request: { selectedModel?: string }): Promise<string>;
    budgetOk: boolean;
    budgetReasons: string[];
    adapterAssert(): void;
    git: {
      isRepository: boolean;
      head: string | undefined;
      hasNewHeadSince: boolean;
      changedProductPaths: string[];
      productDirtyCount: number;
      recordedChangeCount: number;
      committedWorkSha: string | undefined;
      committedProductWorkSha: string | undefined;
    };
    repairPrompt: string;
  };
};

export function fakeBucketPath(bucket: TaskBucket, taskName: string): string {
  return `${BUCKET_ROOT}/${bucket}/${taskName}`;
}

export function createFakeTaskRunEnv(): FakeTaskRunEnv {
  const env: FakeTaskRunEnv = {
    logs: [],
    cliCalls: [],
    journalEvents: [],
    phaseFailures: [],
    checkpoints: [],
    ledgerRecords: [],
    budgetModels: [],
    files: new Map<string, string>(),
    behavior: {
      cli: () => 0,
      decision: { status: "ok", decision: { verdict: "done" } },
      stopStatus: { status: "ok", value: {} },
      claudeLog: "",
      infrastructureExitCodes: [74, 75, 78, 124],
      dispatchInfrastructureFailure: false,
      contextPack: () => ({}),
      // Default'as atkartoja seną elgesį (decision modelis), kad esami scenarijai nepasikeistų.
      routedModelClass: async (request) => request.selectedModel ?? "sonnet",
      budgetOk: true,
      budgetReasons: [],
      adapterAssert: () => undefined,
      git: {
        isRepository: true,
        head: "base",
        hasNewHeadSince: false,
        changedProductPaths: [],
        productDirtyCount: 0,
        recordedChangeCount: 0,
        committedWorkSha: undefined,
        committedProductWorkSha: undefined,
      },
      repairPrompt: "",
    },
    ports: undefined as unknown as TaskRunPorts,
  };

  const ports: TaskRunPorts = {
    log: {
      async write(message) {
        env.logs.push(message);
      },
    },
    cli: {
      async run(args) {
        env.cliCalls.push(args);
        const result = env.behavior.cli(args);
        return typeof result === "number" ? result : result.code;
      },
      async runCaptured(args) {
        env.cliCalls.push(args);
        const result = env.behavior.cli(args);
        return typeof result === "number" ? { code: result, output: "" } : result;
      },
    },
    failure: {
      isInfrastructureExit: (code) => env.behavior.infrastructureExitCodes.includes(code),
      isDispatchInfrastructureFailure: async () => env.behavior.dispatchInfrastructureFailure,
      infrastructureError: (message, options) => Object.assign(new Error(message), options),
    },
    tasks: {
      bucketPath: (bucket, taskName) => fakeBucketPath(bucket, taskName),
      bucketOf: (filePath) => filePath.split("/").slice(-2, -1)[0] ?? "",
      taskIdOf: (filePath) => (filePath.split("/").pop() ?? "").replace(/\.md$/, ""),
      exists: async (filePath) => env.files.has(filePath),
      fingerprint: async (filePath) => `fp:${(env.files.get(filePath) ?? "").length}`,
      async move(from, to, taskName) {
        const body = env.files.get(from) ?? "";
        env.files.delete(from);
        const target = fakeBucketPath(to, taskName);
        env.files.set(target, body);
        return target;
      },
      async finish(from, to, taskName) {
        const body = env.files.get(from) ?? "";
        env.files.delete(from);
        const target = fakeBucketPath(to, taskName);
        env.files.set(target, body);
        return target;
      },
      async activateQueued(queuedFile) {
        const taskName = queuedFile.split("/").pop() ?? queuedFile;
        const body = env.files.get(queuedFile) ?? "";
        env.files.delete(queuedFile);
        const target = fakeBucketPath("active", taskName);
        env.files.set(target, body);
        return target;
      },
      async installReformulatedTask() {},
      async writeTaskBody(taskFile, content) {
        env.files.set(taskFile, content);
      },
      async readTaskBody(taskFile) {
        const body = env.files.get(taskFile);
        if (body === undefined) throw new Error(`no such file: ${taskFile}`);
        return body;
      },
    },
    repairPrompt: {
      read: async () => env.behavior.repairPrompt,
      remove: async () => {},
    },
    ledger: {
      async init() {},
      seenBefore: async () => false,
      async recordState(taskId, _taskName, state, file) {
        env.ledgerRecords.push({ taskId, state, file });
      },
      async clearEntry() {},
    },
    journal: {
      async recordEvent(event) {
        env.journalEvents.push(event);
      },
      async recordPhaseFailure(taskId, phase, exitCode) {
        env.phaseFailures.push({ taskId, phase, exitCode });
      },
      async recordCheckpoint(checkpoint) {
        env.checkpoints.push(checkpoint);
      },
    },
    state: {
      readDecision: async () => env.behavior.decision,
      readStopStatus: async () => env.behavior.stopStatus,
      readResumeState: async () => ({ status: "ok", value: {} }),
      async setCurrentTask() {},
      async recordTaskStartStatus() {},
      readClaudeLog: async () => env.behavior.claudeLog,
      logPath: (name) => `/logs/${name}`,
    },
    git: {
      isRepository: async () => env.behavior.git.isRepository,
      head: async () => env.behavior.git.head,
      hasNewHeadSince: async () => env.behavior.git.hasNewHeadSince,
      changedProductPathsSince: async () => env.behavior.git.changedProductPaths,
      productDirtyCount: async () => env.behavior.git.productDirtyCount,
      recordedChangeCount: async () => env.behavior.git.recordedChangeCount,
      committedWorkShaFor: async () => env.behavior.git.committedWorkSha,
      committedProductWorkShaFor: async () => env.behavior.git.committedProductWorkSha,
    },
    policy: {
      buildContextPack: async () => env.behavior.contextPack(),
      resolveDispatchModelClass: async (request) =>
        env.behavior.routedModelClass({
          ...(request.selectedModel === undefined ? {} : { selectedModel: request.selectedModel }),
        }),
      enforceBudget: async (request) => {
        env.budgetModels.push(request.model);
        return { ok: env.behavior.budgetOk, reasons: env.behavior.budgetReasons };
      },
      assertLoopAdapterAllowed: async () => env.behavior.adapterAssert(),
      async logTaskUsageLedger() {},
    },
    rules: {
      hasAlreadyImplementedMarker: (claudeLog) => /^ALREADY_IMPLEMENTED/m.test(claudeLog),
      resolveNoCommitDisposition: (inputs) => resolveNoCommitDisposition(inputs),
      readExecutorWriteActivity: (claudeLog) => classifyDispatchWriteOutcome(extractDispatchToolUsage(claudeLog)),
      resolveNoCommitReviewReason: (inputs) => resolveNoCommitReviewReason(inputs),
    },
    completion: {
      async markStable() {},
      async syncArchitectureCompletion() {},
      async cascadeBlockedDependents() {},
      enqueueChildTasks: async () => ({ ok: true }),
    },
  };

  env.ports = ports;
  return env;
}
