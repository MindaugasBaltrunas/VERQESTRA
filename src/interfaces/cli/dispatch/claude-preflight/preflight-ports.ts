// `claude-preflight` komandos portų kontraktas (etalonas: interfaces/cli/claude-preflight/
// index.ts IO paviršius). VERQESTRA interfaces sluoksnis infrastructure neimportuoja —
// visi efektai (FS, LLM, attempt artefaktai, checkpoint'ai, žurnalai) ateina per šį deps
// objektą, kurį suriša VQ-504 kompozicija. Grynos taisyklės importuojamos tiesiai iš
// application (preflight-rules, preflight-fastpath, size, human-review gates, policy
// loaderiai per policyFs).

import type { AgentPolicy } from "../../../../domain/policies/agent-selection.js";
import type { PolicyConfigFileSystemPort } from "../../../../application/policy-governance/ports.js";
import type { OpenSpecContextPorts } from "../../../../application/task-planning/openspec-context.js";
import type { LlmCallAuthorization } from "../../../../application/token-governance/tool-budget-gates.js";
import type { TaskPhase } from "../../../../domain/tokens/usage-ledger.js";
import type { CodeIndexReadiness } from "../../../../application/code-intelligence/query/guard.js";

/**
 * Supervisor sprendimo forma — STRUKTŪRINĖ etalono `RetryDecision` kopija (tas pats
 * sprendimas kaip retry-counts SupervisorRetryDecision: interfaces neįgyja importo į
 * infrastructure claude-decision, o kompozicijos `parseDecision` rezultatas ją tenkina).
 */
export type PreflightDecision = {
  verdict?: string;
  task_id?: string;
  architecture_valid?: boolean;
  was_reformulated?: boolean;
  selected_model?: string;
  target_agent_chain?: string[];
  reason?: string;
  claude_task?: string;
  child_tasks?: Array<{ title?: string; claude_task?: string }>;
  /** Task 0941: preflight paskelbtas token biudžeto tier'as (DECISION_TOKEN_BUDGET_TIER_KEY). */
  token_budget_tier?: string;
};

export type PreflightLlmResult = { stdout: string; stderr: string; code: number };

/** Resume checkpoint įrašas (etalono recordResumeCheckpoint laukai 1:1). */
export type ResumeCheckpointEntry = {
  actor: string;
  phase: string;
  status: "started" | "finished" | "failed";
  task_id: string;
  task_file: string;
  log_file: string;
  exit_code?: number;
  next_action: string;
};

/**
 * Attempt artefaktų portas (etalono task 1117a seka). Kompozicija jį suriša su runtime
 * attempt store (tingus resolve + CAS decision + write-once task + append preflight-input);
 * kai artefaktai išjungti — no-op. Klaidos NIEKADA nekyla į preflight elgesį (best-effort,
 * kaip etalone: WARNING į žurnalą).
 */
export type PreflightAttemptPorts = {
  writeDecision(decision: PreflightDecision): Promise<void>;
  writeTask(body: string): Promise<void>;
  appendPreflightInput(prompt: string): Promise<void>;
};

/** Globalūs supervisor failai (etalono keliai: vq/supervisor + vq/logs). */
export type PreflightFilePorts = {
  /** `vq/supervisor/decision.json` — pretty JSON + galinis newline (rašo kvietėjas). */
  writeDecision(json: string): Promise<void>;
  /** `vq/supervisor/reformulated-task.md`. */
  writeReformulated(body: string): Promise<void>;
  /** `vq/supervisor/preflight-input.md` (paskutinis promptas — perrašomas). */
  writePreflightInput(text: string): Promise<void>;
  /** `vq/logs/supervisor-last.log` (paskutinio LLM kvietimo išvestis). */
  writeSupervisorLog(text: string): Promise<void>;
};

export type ClaudePreflightPorts = {
  projectRoot: string;
  /** VERQESTRA runtime šaknis (`<root>/vq`). */
  runtimeRoot: string;
  /** Spec medžio šaknis (`<root>/AG`) — openspec change'ai ir jų generavimas. */
  agRoot: string;

  ensureDirs(): Promise<void>;
  /** Kelio rezoliucija + egzistavimo patikra; meta Error su žinute (etalono semantika). */
  resolveExistingTaskFile(taskFileArg: string): Promise<string>;
  /** RAW turinys arba "" kai failo nėra (etalono readOptionalFile). */
  readOptionalFile(absolutePath: string): Promise<string>;
  /** `.claude/agents` failų vardai; `[]` kai katalogo nėra. */
  listAgentFiles(): Promise<string[]>;
  loadAgentPolicy(): Promise<AgentPolicy>;
  /** Persist'intas projekto profilis arba `undefined` (trūkstamas/sugadintas — saugu). */
  loadProjectProfile(): Promise<{ source_roots?: string[] } | undefined>;

  /** Policy konfigų skaitymas (limits/budget/classification/style/enforcement loaderiams). */
  policyFs: PolicyConfigFileSystemPort;
  /** OpenSpec konteksto portai (analyzeOpenSpecReferences/buildOpenSpecContext). */
  openSpec: OpenSpecContextPorts;

  /** TOK-2 biudžeto vartai vienam LLM kvietimui (planning/preflight fazės). */
  authorizeLlmCall(taskId: string, phase: TaskPhase): Promise<LlmCallAuthorization>;
  /** Auto-OpenSpec LLM generatorius (etalono generateOpenSpecChange per bootstrap tiekėją). */
  generateChange(taskText: string, taskId: string, agRoot: string, model: string): Promise<string | null>;
  /** Deterministinis template fallback (task 882). */
  writeTemplateChange(taskText: string, taskId: string, agRoot: string): Promise<string | null>;

  /** Tier -> realus modelio ID (models.env + saugos validacija — claude-model-env pusė). */
  resolveModel(tier: string): Promise<string>;
  /** Modelio parinkimo taisyklių prompt fragmentas (claudeModelSelectionRules tekstas). */
  modelSelectionRules: string;
  /** Headless `claude -p` kvietimas (write įrankiai išjungti — semantinė peržiūra). */
  runHeadless(
    prompt: string,
    model: string,
    options: { maxTurns: number; disallowWriteTools: true },
  ): Promise<PreflightLlmResult>;
  /** `extractDecisionJson(extractResultField(stdout))` — kompozicijos pusė. */
  parseDecision(stdout: string): PreflightDecision;
  /** 429/sesijos limito klasifikacija (isUsageLimitOutput). */
  isUsageLimitOutput(stdout: string): boolean;
  /** Usage telemetrija: phase/model + LLM stdout (usage ištraukia kompozicija); "none" — be kvietimo. */
  logTokenUsage(phase: string, model: string, stdout?: string): Promise<void>;

  /** Task 975 code-index vartai existing-code task'ams (guard per realų fs adapterį). */
  ensureFreshCodeIndex(allowedFiles: string[]): Promise<CodeIndexReadiness>;

  attempt: PreflightAttemptPorts;
  files: PreflightFilePorts;
  recordResumeCheckpoint(entry: ResumeCheckpointEntry): Promise<void>;
  agLog(line: string): Promise<void>;
  stderr(line: string): void;
};
