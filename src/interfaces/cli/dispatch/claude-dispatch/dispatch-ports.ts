// `claude-dispatch` orkestratoriaus portų kontraktas (etalonas: interfaces/cli/
// claude-dispatch/index.ts IO paviršius). Interfaces infrastructure neimportuoja — visi
// infra gabalai (attempt store, launcher/procesai, outcome/finalize, delivery/tool
// profilis, modelio maršruto adapteris) ateina per šį deps objektą STRUKTŪRINĖMIS view
// formomis (tas pats sprendimas kaip RetryDecision/DispatchUsageView) arba nepermatomais
// handle'ais; suriša VQ-504 kompozicija.

import type { PolicyConfigFileSystemPort } from "../../../../application/policy-governance/ports.js";
import type { LlmCallAuthorization } from "../../../../application/token-governance/tool-budget-gates.js";
import type { DispatchMcpCapabilities } from "../../../../application/context-pack/mcp-capability-registry.js";
import type {
  DispatchExecutionRecord,
  DispatchExecutionRecordInput,
} from "../../../../application/task-execution/dispatch-execution-record.js";
import type { DispatchUsageView, StopBridgeProbeResult } from "../../../../application/task-execution/stop-bridge-wait.js";
import type { PublishedTierDecision } from "../../../../application/task-execution/execution-context-gate.js";
import type { ResolvedTokenBudget } from "../../../../application/token-governance/token-budget-config.js";
import type { ResumeCheckpointEntry } from "../claude-preflight/preflight-ports.js";
import type { PrepareWorkerPromptDeps } from "./worker-prompt-preparation.js";
import type { DispatchRoutingModelPorts } from "./dispatch-routing-plan.js";

/** Supervisor sprendimo forma dispatch kelyje (struktūrinė etalono DecisionState pusė). */
export type DispatchDecision = PublishedTierDecision & { selected_model?: string };

/** Tool schemų profilio view — struktūriškai identiškas infra DispatchToolSchemaProfile. */
export type DispatchToolProfileView = {
  mode: "off" | "applied" | "no-candidates" | "unsupported-transport" | "cli-fallback";
  candidates: string[];
  applied: string[];
  reason: string;
};

/** Biudžeto politikos sprendimo view (infra DispatchToolPolicyDecision forma). */
export type DispatchToolPolicyView = { browser?: boolean; scraper?: boolean; mcp?: boolean };

/** Pristatymo view įrašui/log'ams; pilną delivery neša nepermatomas handle. */
export type DispatchDeliveryView = { platform: "windows" | "posix"; transport: string };

/** Nepermatomi infra handle'ai — orkestratorius jų vidaus niekada neskaito. */
export type DispatchDeliveryHandle = { readonly __kind?: "dispatch-delivery" };
export type DispatchWatchdogHandle = { readonly __kind?: "dispatch-watchdog" };

/** Baigties view (infra DispatchOutcome forma; limitSource — string skaitymui). */
export type DispatchOutcomeView = {
  exitCode: number;
  usage?: DispatchUsageView;
  usageLimitHit: boolean;
  zeroUsageSuccess: boolean;
  stopBridgeDone: boolean;
  budgetVerdict?: {
    reason: string;
    billableTokens: number;
    rawTokens: number;
    limit: number;
    limitSource: string;
  };
};

export type DispatchLaunchResultView =
  | { status: "aborted-before-launch" }
  | { status: "finished"; claudeExit: number; budgetAborted: boolean; toolSchemaOutcome: DispatchToolProfileView };

export type ClaudeLastLogWriteView = {
  attempt: "written" | "failed" | "absent";
  global: "written" | "failed";
  errors: string[];
};

export type AttemptWriteOutcome = { ok: boolean; reason?: string; errors?: string[] };

export type AttemptStopStateReadView =
  | { ok: true; data: unknown }
  | { ok: false; reason: string; errors: string[] };

/**
 * Vieno runtime attempt'o view (kompozicijos closures virš runtime-artifact-store; 1117a).
 * `writeTaskOnce`/`promote*` — write-once: `ok:true` apima ir already-exists (kompozicija
 * normalizuoja), `ok:false` — realią klaidą su reason/errors žurnalui.
 */
export type DispatchAttemptView = {
  /** Originalus task id (manifesto taskIdOriginal ?? ref.taskId). */
  taskId: string;
  /** Attempt kanalo claude-last log kelias; undefined kai kelio išspręsti nepavyko. */
  claudeLogPath?: string;
  writeTaskOnce(rawTaskText: string): Promise<AttemptWriteOutcome>;
  readDecision(): Promise<
    | { kind: "ok"; decision: DispatchDecision }
    | { kind: "missing" }
    | { kind: "invalid"; reason: string; errors: string[] }
  >;
  /** Attempt artefakto tekstas; undefined kai artefakto nėra / kelias nepasiekiamas. */
  readArtifactText(kind: "execution-context" | "context-pack"): Promise<string | undefined>;
  promoteExecutionContext(text: string): Promise<AttemptWriteOutcome>;
  promoteContextPack(parsed: unknown): Promise<AttemptWriteOutcome>;
  /** CAS execution-result rašytojas — reviziją seka kompozicijos closure. */
  writeExecutionResult(record: DispatchExecutionRecord): Promise<AttemptWriteOutcome>;
  appendDispatchLog(line: string): Promise<void>;
  readStopState(): Promise<AttemptStopStateReadView>;
};

export type ResolveAttemptResult = { attempt?: DispatchAttemptView; warnings: string[] };

export type ClaudeDispatchPorts = {
  projectRoot: string;
  /** VERQESTRA runtime šaknis (`<root>/vq`). */
  runtimeRoot: string;

  ensureDirs(): Promise<void>;
  /** Kelio rezoliucija + egzistavimo patikra; meta Error su žinute. */
  resolveExistingTaskFile(taskFileArg: string): Promise<string>;
  /** RAW turinys arba "" kai failo nėra. */
  readOptionalFile(absolutePath: string): Promise<string>;
  /** Generiniai fs efektai prelaunch žingsniui (per portą — ne tiesioginis node:fs). */
  writeText(absolutePath: string, text: string): Promise<void>;
  removeIfExists(absolutePath: string): Promise<void>;
  readCurrentTaskId(): Promise<string>;
  readRetryCounts(): Promise<Record<string, number>>;

  /** Attempt rezoliucija su `create:true` (manifestas — kompozicijos pusėje). */
  resolveAttempt(input: {
    taskId: string;
    phase: "implementation" | "repair";
    taskFile: string;
    selectedModel?: string;
  }): Promise<ResolveAttemptResult>;

  policyFs: PolicyConfigFileSystemPort;
  /** Worker prompt paruošimo deps (context-pack fs/clock/task-events). */
  workerPromptDeps: PrepareWorkerPromptDeps;
  authorizeLlmCall(taskId: string, phase: "implementation" | "repair"): Promise<LlmCallAuthorization>;
  models: DispatchRoutingModelPorts;
  loadProjectProfile(): Promise<{ source_roots?: string[] } | undefined>;

  /** `pwsh.exe`/`powershell.exe` arba undefined (POSIX). */
  powerShellCommand(): Promise<string | undefined>;
  mcpCapabilities(enabled: boolean): Promise<DispatchMcpCapabilities>;
  loadToolPolicy(): Promise<DispatchToolPolicyView>;
  resolveToolSchemaProfile(input: {
    enabled: boolean;
    platform: "windows" | "posix";
    policy: DispatchToolPolicyView;
    mcp: DispatchMcpCapabilities;
  }): DispatchToolProfileView;
  resolveDelivery(input: {
    powerShellCommand?: string;
    promptPath: string;
    model: string;
    maxTurns?: number;
    prompt: string;
    disallowedTools?: readonly string[];
  }): { view: DispatchDeliveryView; handle: DispatchDeliveryHandle };

  createBudgetWatchdog(input: {
    limit: number;
    limitSource: string;
    onExceeded: () => void;
  }): DispatchWatchdogHandle;
  launchProcess(input: {
    delivery: DispatchDeliveryHandle;
    visibleLauncher: string;
    model: string;
    claudeExitFile: string;
    attemptClaudeLog?: string;
    claudeLog: string;
    dispatchTimeoutMs: number;
    dispatchMaxTurns?: number;
    dispatchNonce: string;
    toolSchema: DispatchToolProfileView;
    budgetWatchdog: DispatchWatchdogHandle;
    budgetAbortSignal: AbortSignal;
    taskId: string;
    logDispatch(line: string): Promise<void>;
    onWindowsInitialLog(write: ClaudeLastLogWriteView): Promise<boolean>;
  }): Promise<DispatchLaunchResultView>;
  /** Attempt-first sesijos log skaitymas po proceso. */
  readClaudeLastLog(input: { attemptPath?: string; globalPath: string }): Promise<string>;
  resolveOutcome(input: {
    taskId: string;
    initialExitCode: number;
    claudeLogText: string;
    dispatchNonce: string;
    budgetWatchdog: DispatchWatchdogHandle;
    budgetAborted: boolean;
    tokenBudget: ResolvedTokenBudget;
    sessionElapsedMs: number;
    dispatchTimeoutMs: number;
    readAttemptStopState?: () => Promise<AttemptStopStateReadView>;
    logDispatch(line: string): Promise<void>;
  }): Promise<DispatchOutcomeView>;
  finalize(input: {
    taskId: string;
    taskFile: string;
    dispatchPhase: "implementation" | "repair";
    attempt: number;
    effectiveTier: string;
    routingReasonCodes: readonly string[];
    claudeExitFile: string;
    claudeLog: string;
    attemptClaudeLog?: string;
    claudeLogText: string;
    toolSchema: DispatchToolProfileView;
    launchRecord: Omit<DispatchExecutionRecordInput, "status">;
    outcome: DispatchOutcomeView;
    recordExecutionResult(record: DispatchExecutionRecord): Promise<void>;
    logDispatch(line: string): Promise<void>;
  }): Promise<void>;

  /** Ar log rašymas paliko dispatch'ą aklą (infra claudeLastLogWriteFatal taisyklė). */
  logWriteFatal(view: ClaudeLastLogWriteView): boolean;
  recordResumeCheckpoint(entry: ResumeCheckpointEntry): Promise<void>;
  agLog(line: string): Promise<void>;
  stderr(line: string): void;
  /** Unikalus dispatch nonce ([a-z0-9]{8,64}; kompozicijoje — randomBytes hex). */
  newDispatchNonce(): string;
  nowIso(): string;
  nowMs(): number;
};

/** Stop-bridge probe rezultato re-eksportas orkestratoriaus testams. */
export type { StopBridgeProbeResult };
