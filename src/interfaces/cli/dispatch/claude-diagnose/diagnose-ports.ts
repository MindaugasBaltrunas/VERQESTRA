// `claude-diagnose` komandos portų kontraktas (etalonas: interfaces/cli/claude-diagnose/
// index.ts IO paviršius). Kaip preflight'e: interfaces infrastructure neimportuoja — visi
// efektai per šį deps objektą (VQ-504 kompozicija), o grynos dispozicijos/digest taisyklės
// importuojamos per sankcionuotus application tiltus.

import type { LlmCallAuthorization } from "../../../../application/token-governance/tool-budget-gates.js";
import type { TurnLimits } from "../../../../application/token-governance/turn-budget.js";
import type { QualityGatesStatus } from "../../../../application/quality-gates/quality-gates-status.js";
import type { SessionWriteOwners } from "../../../../application/task-execution/session-write-owners.js";
import type { StopEvidenceOrigin } from "../../../../application/task-execution/index.js";
import type { PreflightLlmResult, ResumeCheckpointEntry } from "../claude-preflight/preflight-ports.js";

/** Diagnozės sprendimo forma — struktūrinė etalono `RetryDecision` diagnozės pusė. */
export type DiagnosisDecision = {
  verdict?: string;
  task_id?: string;
  error_signature?: string;
  retry_key?: string;
  selected_model?: string;
  target_agent?: string;
  risk_level?: string;
  reason?: string;
  claude_repair_task?: string;
};

/**
 * Stop įrodymo vaizdas (etalono `readStopEvidence` rezultatas): kilmė + statusas + task id
 * + žalias tekstas prompt'ui + korupcijos žyma + telemetrijos įspėjimai + pilnas įrašas
 * (dispatch_nonce atgavimui per resolveDispatchSessionNonce).
 */
export type StopEvidenceView = {
  origin: StopEvidenceOrigin;
  status?: string;
  taskId?: string;
  corrupted: boolean;
  raw: string;
  warnings: string[];
  record: Record<string, unknown>;
};

export type ClaudeDiagnosePorts = {
  projectRoot: string;
  /** VERQESTRA runtime šaknis (`<root>/vq`). */
  runtimeRoot: string;

  ensureDirs(): Promise<void>;
  resolveExistingTaskFile(taskFileArg: string): Promise<string>;
  /** RAW turinys arba "" kai failo nėra. */
  readOptionalFile(absolutePath: string): Promise<string>;

  git: {
    status(): Promise<string>;
    head(): Promise<string | undefined>;
    /** `git log base..HEAD --oneline` forma; tuščia kai base nežinomas/klaida. */
    logSince(baseHead: string | undefined): Promise<string>;
    /** Produkto keliai, pakeisti base..HEAD lange. */
    changedProductPathsSince(baseHead: string): Promise<string[]>;
  };
  /** 2026-08-14 false-done: lango commit'as su bent vienu PRODUKTO keliu, arba undefined. */
  windowProductWorkSha(taskId: string): Promise<string | undefined>;

  /** Attempt-only task-start-status (1210b): bet kuri ne-ok baigtis = `{}` (fail-closed). */
  readTaskStartStatus(): Promise<{ task_id?: string; base_head?: string }>;
  /** Stop įrodymas iš attempt stop-state.json su legacy fallback'u (task 0042). */
  readStopEvidence(): Promise<StopEvidenceView>;
  /** Vykdytojo sesijos log'as (attempt kanalas su legacy fallback'u). */
  readClaudeSessionLog(): Promise<{ origin: string; text: string }>;
  readGatesStatus(): Promise<QualityGatesStatus | undefined>;
  /** `vq/state/retry-counts.json`: parsintas žemėlapis + žalias JSON prompt'ui. */
  readRetryCounts(): Promise<Record<string, number>>;
  readRetryCountsRaw(): Promise<string>;
  readErrorSignatures(): Promise<Record<string, string>>;
  readLegacyErrorSignature(): Promise<string>;
  /** session-writes ledger'is + ownership sidecar'as; present=false kai ledger'io nėra. */
  readSessionWrites(): Promise<{ present: boolean; writes: string[]; owners: SessionWriteOwners }>;
  readCurrentTaskId(): Promise<string>;
  /** Gyvas AG_DISPATCH_NONCE iš env ("" kai nėra — sibling procese jis jau ištrintas). */
  envDispatchNonce(): string;

  authorizeLlmCall(taskId: string): Promise<LlmCallAuthorization>;
  /** haiku bazė + eskalacija pagal retry skaičių → realus modelio ID (claude-model-env pusė). */
  resolveDiagnosisModel(failedAttempts: number): Promise<string>;
  modelSelectionRules: string;
  runHeadless(
    prompt: string,
    model: string,
    options: { maxTurns: number; disallowWriteTools: true },
  ): Promise<PreflightLlmResult>;
  parseDecision(stdout: string): DiagnosisDecision;
  isUsageLimitOutput(stdout: string): boolean;
  logTokenUsage(phase: string, model: string, stdout?: string): Promise<void>;
  /** Preflight limits (turnLimits/llmMaxTurns) — policy konfigo skaitymas kompozicijoje. */
  loadDiagnoseLimits(): Promise<{ turnLimits?: TurnLimits; llmMaxTurns: number }>;

  attempt: {
    /** CAS decision artefaktas (kaip preflight; klaidos best-effort į žurnalą). */
    writeDecision(decision: DiagnosisDecision): Promise<void>;
    /** Append-only repair prompt istorija (rašoma tik netuščiam prompt'ui). */
    appendRepairPrompt(text: string): Promise<void>;
    appendDiagnosisInput(text: string): Promise<void>;
  };
  files: {
    /** `vq/supervisor/decision.json` veidrodis (pretty JSON + newline). */
    writeDecision(json: string): Promise<void>;
    /** Task-scoped `vq/state/repair/<id>.md` (jį skaito repair ciklas). */
    writeRepairPrompt(scoped: string): Promise<void>;
    /** Backward-compatible operatoriaus `vq/supervisor/repair-task.md` (workflow jo neskaito). */
    writeGlobalRepair(scoped: string): Promise<void>;
    writeDiagnosisInput(text: string): Promise<void>;
    writeSupervisorLog(text: string): Promise<void>;
  };
  recordResumeCheckpoint(entry: ResumeCheckpointEntry): Promise<void>;
  agLog(line: string): Promise<void>;
  stderr(line: string): void;
};
