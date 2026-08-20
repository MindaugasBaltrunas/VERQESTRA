// `claude-dispatch` orkestratorius (etalonas: interfaces/cli/claude-dispatch/index.ts
// claudeDispatch, 638 eil. — visi infra gabalai per ClaudeDispatchPorts). SEKA 1:1:
// invocation → attempt artefaktai → worker prompt (0025) → kanoninis prompt (CTX-2 gate) →
// TOK-2 biudžetas → modelio maršrutas (1109) → context log → preview/prelaunch → turn/token
// biudžeto planas → 0028 tool schema → delivery → launch record (started) → nonce
// (2026-08-04/0056) → procesas su mid-dispatch watchdog'u (1203) → outcome → finalize.
// Handler'is grąžina exit kodą.

import {
  MAX_PROMPT_PREVIEW_CHARS,
  isSourceChangeDispatch,
  resolveCanonicalWorkerPrompt,
  resolveExecutionContextMode,
  workerPromptPreview,
} from "../../../../application/task-execution/execution-context-gate.js";
import {
  buildDispatchExecutionRecord,
  type DispatchExecutionRecord,
  type DispatchExecutionRecordInput,
} from "../../../../application/task-execution/dispatch-execution-record.js";
import { isContextCompressionFeatureEnabledForTask } from "../../../../application/context-pack/compression-arrest-observer.js";
import { INFRASTRUCTURE_IO_EXIT_CODE, USAGE_ERROR_EXIT_CODE } from "../../../../shared/exit-codes.js";
import { prepareDispatchInvocation } from "./dispatch-invocation.js";
import { prepareDispatchArtifacts } from "./dispatch-artifacts.js";
import { prepareWorkerPromptTask } from "./worker-prompt-preparation.js";
import { prepareDispatchLaunchState } from "./dispatch-prelaunch.js";
import { resolveDispatchRoutingPlan } from "./dispatch-routing-plan.js";
import { resolveDispatchBudgetPlan } from "./dispatch-budget-plan.js";
import type { ClaudeDispatchPorts, ClaudeLastLogWriteView } from "./dispatch-ports.js";

export async function claudeDispatch(args: string[], ports: ClaudeDispatchPorts): Promise<number> {
  await ports.ensureDirs();

  const invocation = await prepareDispatchInvocation(args, ports);
  if (invocation.kind === "refuse") {
    if (invocation.logLine) await ports.agLog(invocation.logLine);
    ports.stderr(invocation.message);
    return USAGE_ERROR_EXIT_CODE;
  }
  for (const warning of invocation.warnings) await ports.agLog(warning);
  const { taskFile, rawTaskText, dispatchPhase, taskId, decision, selected, active } = invocation;

  /** Vienas dispatch žurnalo įrašas dviese: globalus + attempt'o dispatch.log (append-only). */
  const logDispatch = async (line: string): Promise<void> => {
    await ports.agLog(line);
    if (active) {
      await active.appendDispatchLog(line);
    }
  };

  // Eskalacija skaito TĄ PATĮ `task:<id>` skaitiklį, kurį didina retry-guard (F8) —
  // jokios atskiros eskalacijos logikos čia nėra.
  const retryCounts = await ports.readRetryCounts();
  const rawRetryCount = retryCounts[`task:${taskId}`];
  const failedAttempts = typeof rawRetryCount === "number" && Number.isFinite(rawRetryCount) ? rawRetryCount : 0;
  // Tas pats bandymo numeris eina ir į usage ledger'į, ir į execution-result (1117a).
  const attempt = failedAttempts + 1;

  const artifacts = await prepareDispatchArtifacts({ ports, taskId, rawTaskText, ...(active ? { active } : {}) });
  const {
    dispatchLog,
    claudeLog,
    attemptClaudeLog,
    claudeExitFile,
    visiblePrompt,
    visibleLauncher,
    executionContextPath,
    executionContextRaw,
    contextPackRaw,
  } = artifacts;
  const recordExecutionResult = async (record: DispatchExecutionRecord): Promise<void> => {
    await artifacts.recordExecutionResult(record);
  };

  /** Fail-fast prieš paleidimą, jei sesijos srauto nebūtų kur įrašyti (2026-08-09 EBUSY). */
  const abortForUnwritableClaudeLog = async (write: ClaudeLastLogWriteView): Promise<boolean> => {
    if (!ports.logWriteFatal(write)) {
      if (write.errors.length > 0) {
        await logDispatch(
          `DISPATCH LOG MIRROR DEGRADED: task=${taskId} attempt=${write.attempt} global=${write.global} ` +
            `— ${write.errors.join("; ")}`,
        );
      }
      return false;
    }
    await logDispatch(
      `DISPATCH LOG UNWRITABLE (infrastructure): task=${taskId} attempt=${write.attempt} global=${write.global} ` +
        `— ${write.errors.join("; ")}`,
    );
    ports.stderr(`Cannot write the Claude session log — refusing to dispatch blind: ${write.errors.join("; ")}`);
    return true;
  };

  const executionContextMode = resolveExecutionContextMode();
  const sourceChange = isSourceChangeDispatch(rawTaskText);
  const startedAt = ports.nowIso();

  // Task 0025: kompiliavimas PRIEŠ vartus, bet vartų fingerprint'as — nuo RAW baitų.
  const workerPromptPreparation = await prepareWorkerPromptTask(
    { taskId, rawTaskText, logDispatch },
    ports.workerPromptDeps,
  );
  const compressionConfig = workerPromptPreparation.compressionConfig;
  const workerPromptRecord = workerPromptPreparation.workerPromptRecord;

  const canonicalPrompt = resolveCanonicalWorkerPrompt({
    mode: executionContextMode,
    sourceChange,
    taskId,
    taskText: rawTaskText,
    ...(workerPromptPreparation.compiledTask === undefined ? {} : { compiledTask: workerPromptPreparation.compiledTask }),
    ...(executionContextRaw ? { executionContext: executionContextRaw } : {}),
    ...(contextPackRaw ? { contextPackText: contextPackRaw } : {}),
    isRepair: dispatchPhase === "repair",
  });
  if (canonicalPrompt.kind === "refuse") {
    await logDispatch(`DISPATCH REFUSED: task=${taskId} execution_context=${canonicalPrompt.reason}`);
    await recordExecutionResult(
      buildDispatchExecutionRecord({
        status: "refused",
        phase: dispatchPhase,
        taskFile,
        sourceChange,
        selectedModel: selected,
        failedAttempts,
        attempt,
        startedAt,
        // Prompt'o dar nėra — gate atsisakė prieš jo sudarymą, tad `prompt_*` laukų nebus.
        contextGate: { kind: "refuse", reason: canonicalPrompt.reason },
        // Kompiliavimo sprendimas lieka įraše ir atsisakymo atveju — A/B analizei.
        workerPrompt: workerPromptRecord,
        reason: canonicalPrompt.reason,
        finishedAt: ports.nowIso(),
      }),
    );
    ports.stderr(`Execution context gate refused dispatch: ${canonicalPrompt.reason}`);
    return USAGE_ERROR_EXIT_CODE;
  }

  // TOK-2: joks dispatch LLM kvietimas neprasideda be biudžeto autorizacijos; vartai eina
  // PRIEŠ bet kokį state mutavimą, kad atsisakymas būtų tikras fail-fast.
  const authorization = await ports.authorizeLlmCall(taskId, dispatchPhase);
  if (!authorization.allowed) {
    const budgetReason = authorization.hard_reasons.join("; ");
    await logDispatch(`DISPATCH REFUSED: task=${taskId} budget=${budgetReason}`);
    await recordExecutionResult(
      buildDispatchExecutionRecord({
        status: "refused",
        phase: dispatchPhase,
        taskFile,
        sourceChange,
        selectedModel: selected,
        failedAttempts,
        attempt,
        startedAt,
        contextGate: canonicalPrompt.gate,
        prompt: canonicalPrompt.prompt,
        workerPrompt: workerPromptRecord,
        reason: `budget: ${budgetReason}`,
        finishedAt: ports.nowIso(),
      }),
    );
    ports.stderr(`Execution budget refused dispatch: ${budgetReason}`);
    return USAGE_ERROR_EXIT_CODE;
  }
  if (authorization.reduce_context) {
    await ports.agLog(
      `DISPATCH BUDGET SOFT LIMIT: task=${taskId} phase=${dispatchPhase} reasons=${authorization.soft_reasons.join("; ")}`,
    );
  }
  // Task 0000-0a: RAW perviršis — tik diagnostinis pėdsakas, baigties nekeičia.
  for (const notice of authorization.raw_notices) {
    await ports.agLog(`TASK RAW TOKEN NOTICE: task=${taskId} phase=${dispatchPhase} ${notice}`);
  }

  // Modelio maršrutas (1109): visi fail-fast vartai jau praėjo, joks state dar nemutuotas.
  const projectProfile = await ports.loadProjectProfile().catch(() => undefined);
  const routingPlan = await resolveDispatchRoutingPlan({
    runtimeRoot: ports.runtimeRoot,
    taskId,
    taskText: rawTaskText,
    phase: dispatchPhase,
    decision,
    selectedModel: selected,
    failedAttempts,
    authorization,
    policyFs: ports.policyFs,
    models: ports.models,
    projectProfile,
    logDispatch,
  });
  const { taskMetrics, routing, effectiveTier, claudeModel } = routingPlan;

  const contextGate = canonicalPrompt.gate;
  if (contextGate.kind === "skip") {
    await logDispatch(
      `DISPATCH CONTEXT SKIP: task=${taskId} source_change=${sourceChange} mode=${executionContextMode} reason=${contextGate.reason}`,
    );
  } else {
    await logDispatch(
      `DISPATCH CONTEXT ATTACHED: task=${taskId} chars=${contextGate.executionContext.length} source=${executionContextPath}`,
    );
  }
  const workerPrompt = canonicalPrompt.prompt;

  // F11 + CTX-2: preview trumpina TIK žmogui skirtą įrašą — realus prompt'as nekerpamas.
  const promptPreview = workerPromptPreview(workerPrompt, taskFile);
  if (promptPreview.length < workerPrompt.length) {
    await ports.agLog(
      `DISPATCH WARN: dispatch log preview truncated ${workerPrompt.length} → ${MAX_PROMPT_PREVIEW_CHARS} chars (full prompt still dispatched to Claude)`,
    );
  }

  await prepareDispatchLaunchState({
    ports,
    taskId,
    taskFile,
    dispatchLog,
    claudeExitFile,
    visiblePrompt,
    workerPrompt,
    promptPreview,
    claudeModel,
    selectedModel: selected,
    effectiveTier,
    routing: { tier: routing.tier, reason: routing.reason, policyHash: routing.policy_hash },
    failedAttempts,
    sourceChange,
    executionContextPath,
    contextGate,
    workerPromptRecord,
    logDispatch,
  });

  // TOK-3/0941: turn langas iš preflight paskelbto tier'o; mid-dispatch riba — 1203/1215.
  const budgetPlan = await resolveDispatchBudgetPlan({
    runtimeRoot: ports.runtimeRoot,
    taskId,
    decision,
    taskMetrics,
    phase: dispatchPhase,
    reduceContextReasons: authorization.reduce_context ? authorization.soft_reasons : [],
    remainingTaskTokens: authorization.remaining_total_tokens,
    policyFs: ports.policyFs,
  });
  const { tokenBudget, dispatchMaxTurns, dispatchTimeoutMs, midDispatchLimit } = budgetPlan;
  await logDispatch(budgetPlan.turnLog);
  const budgetAbort = new AbortController();
  const budgetWatchdog = ports.createBudgetWatchdog({
    limit: midDispatchLimit.limit,
    limitSource: midDispatchLimit.source,
    onExceeded: () => budgetAbort.abort(),
  });
  await logDispatch(budgetPlan.tokenLog);
  const powerShellCommand = await ports.powerShellCommand();

  // Task 0028/0041: tool schemų profilis — deterministinis, task-lokalus MCP šaltinis.
  const toolSchemaEnabled =
    compressionConfig !== undefined &&
    isContextCompressionFeatureEnabledForTask(compressionConfig, "dispatch_tool_schema", taskId);
  const mcpCapabilities = await ports.mcpCapabilities(toolSchemaEnabled);
  const toolSchema = ports.resolveToolSchemaProfile({
    enabled: toolSchemaEnabled,
    platform: powerShellCommand ? "windows" : "posix",
    policy: toolSchemaEnabled ? await ports.loadToolPolicy() : {},
    mcp: mcpCapabilities,
  });
  if (toolSchemaEnabled) {
    await logDispatch(
      `DISPATCH TOOL SCHEMA: task=${taskId} mode=${toolSchema.mode} mcp=${mcpCapabilities.source} ` +
        `candidates=${toolSchema.candidates.join(",") || "none"} applied=${toolSchema.applied.join(",") || "none"} ` +
        `reason=${toolSchema.reason}`,
    );
  }

  // CTX-2: abi šakos ima tą patį prompt stringą — platformos negali išsiskirti.
  const delivery = ports.resolveDelivery({
    ...(powerShellCommand === undefined ? {} : { powerShellCommand }),
    promptPath: visiblePrompt,
    model: claudeModel,
    ...(dispatchMaxTurns > 0 ? { maxTurns: dispatchMaxTurns } : {}),
    prompt: workerPrompt,
    disallowedTools: toolSchema.applied,
  });

  // Užklausos įrašas PRIEŠ paleidiklį: net nutrūkus procesui lieka įrodymas, KĄ šis
  // bandymas paleido; baigties įrašas gali nešti KITĄ tool schemos režimą (CLI fallback).
  const launchRecord: Omit<DispatchExecutionRecordInput, "status"> = {
    phase: dispatchPhase,
    taskFile,
    sourceChange,
    selectedModel: selected,
    failedAttempts,
    attempt,
    startedAt,
    contextGate,
    routing: {
      baseTier: routing.base_tier,
      tier: routing.tier,
      reason: routing.reason,
      policyHash: routing.policy_hash,
      model: claudeModel,
    },
    prompt: workerPrompt,
    workerPrompt: workerPromptRecord,
    maxTurns: dispatchMaxTurns,
    dispatchTimeoutMs,
    delivery: { platform: delivery.view.platform, transport: delivery.view.transport },
    toolSchema,
  };
  await recordExecutionResult(buildDispatchExecutionRecord({ ...launchRecord, status: "started" }));

  // Watchdog nonce (2026-08-04; task 0056 — vienas nonce abiem platformoms).
  const dispatchNonce = ports.newDispatchNonce();
  // Task 1222: aklumo diagnostikai reikia BŪTENT sesijos lango, ne viso dispatch'o.
  const sessionStartedMs = ports.nowMs();

  const processLaunch = await ports.launchProcess({
    delivery: delivery.handle,
    visibleLauncher,
    model: claudeModel,
    claudeExitFile,
    ...(attemptClaudeLog === undefined ? {} : { attemptClaudeLog }),
    claudeLog,
    dispatchTimeoutMs,
    ...(dispatchMaxTurns > 0 ? { dispatchMaxTurns } : {}),
    dispatchNonce,
    toolSchema,
    budgetWatchdog,
    budgetAbortSignal: budgetAbort.signal,
    taskId,
    logDispatch,
    onWindowsInitialLog: async (logWrite) => {
      if (ports.logWriteFatal(logWrite)) {
        await recordExecutionResult(
          buildDispatchExecutionRecord({
            ...launchRecord,
            status: "finished",
            exitCode: INFRASTRUCTURE_IO_EXIT_CODE,
            finishedAt: ports.nowIso(),
          }),
        );
      }
      return await abortForUnwritableClaudeLog(logWrite);
    },
  });
  if (processLaunch.status === "aborted-before-launch") return INFRASTRUCTURE_IO_EXIT_CODE;
  const sessionElapsedMs = ports.nowMs() - sessionStartedMs;
  const claudeLogText = await ports.readClaudeLastLog({
    ...(attemptClaudeLog === undefined ? {} : { attemptPath: attemptClaudeLog }),
    globalPath: claudeLog,
  });
  const outcome = await ports.resolveOutcome({
    taskId,
    initialExitCode: processLaunch.claudeExit,
    claudeLogText,
    dispatchNonce,
    budgetWatchdog,
    budgetAborted: processLaunch.budgetAborted,
    tokenBudget,
    sessionElapsedMs,
    dispatchTimeoutMs,
    ...(active ? { readAttemptStopState: async () => await active.readStopState() } : {}),
    logDispatch,
  });
  await ports.finalize({
    taskId,
    taskFile,
    dispatchPhase,
    attempt,
    effectiveTier,
    routingReasonCodes: routing.reason_codes,
    claudeExitFile,
    claudeLog,
    ...(attemptClaudeLog === undefined ? {} : { attemptClaudeLog }),
    claudeLogText,
    toolSchema: processLaunch.toolSchemaOutcome,
    launchRecord,
    outcome,
    recordExecutionResult,
    logDispatch,
  });
  return outcome.exitCode;
}
