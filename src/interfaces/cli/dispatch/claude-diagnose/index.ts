// `claude-diagnose` CLI adapteris (etalonas: interfaces/cli/claude-diagnose/index.ts,
// 710 eil. — suskaidyta: diagnose-ports/diagnose-evidence/diagnose-prompt). Sprendimų SEKA
// 1:1: deterministinis done greitkelis → lokali diagnozė (done short-circuit 2026-08-06;
// repair/human-review su repeated-error eskalacija F9) → TOK-2 biudžeto vartai → vienintelis
// LLM kvietimas su TOK-3 turn riba → verdikto artefaktai. Visi efektai per
// ClaudeDiagnosePorts; handler'is grąžina exit kodą.

import path from "node:path";
import { USAGE_ERROR_EXIT_CODE, USAGE_LIMIT_EXIT_CODE } from "../../../../shared/exit-codes.js";
import {
  evaluateDeterministicDone,
  evaluateLocalDiagnosis,
  logHasAlreadyImplementedMarker,
  nonRuntimeDirtyEntriesFromStatus,
  resolveEffectiveStopStatus,
} from "../../../../application/task-execution/index.js";
import { carryTaskScopeIntoRepairPrompt } from "../../../../application/task-execution/repair-prompt.js";
import { evaluateRepeatedErrorEscalation } from "../../../../application/task-execution/retry-repair.js";
import { allowedPaths, taskLedgerKey } from "../../../../application/quality-gates/preflight-fastpath.js";
import { resolveMaxTurns } from "../../../../application/token-governance/turn-budget.js";
import {
  collectSessionAttribution,
  stripStreamJsonTranscriptLines,
  tailLines,
} from "./diagnose-evidence.js";
import { buildDiagnosisPrompt, renderStopBlock } from "./diagnose-prompt.js";
import type { ClaudeDiagnosePorts, DiagnosisDecision } from "./diagnose-ports.js";

export async function claudeDiagnose(args: string[], ports: ClaudeDiagnosePorts): Promise<number> {
  await ports.ensureDirs();

  const taskFileArg = args[0];
  if (!taskFileArg) {
    ports.stderr("Usage: ag claude-diagnose <task-file>");
    return USAGE_ERROR_EXIT_CODE;
  }

  let taskFile: string;
  try {
    taskFile = await ports.resolveExistingTaskFile(taskFileArg);
  } catch (error) {
    ports.stderr(error instanceof Error ? error.message : String(error));
    return USAGE_ERROR_EXIT_CODE;
  }
  const taskId = taskLedgerKey(taskFile);
  const taskText = await ports.readOptionalFile(taskFile);

  // Diagnostikos modelis pagal sprendimo sudėtingumą: kuo daugiau nesėkmių, tuo sunkesnė
  // diagnozė — haiku bazė, eskalacija pagal retry-guard užfiksuotą bandymų skaičių.
  const retryCounts = await ports.readRetryCounts();
  const rawRetryCount = retryCounts[`task:${taskId}`];
  const failedAttempts = typeof rawRetryCount === "number" && Number.isFinite(rawRetryCount) ? rawRetryCount : 0;
  const model = await ports.resolveDiagnosisModel(failedAttempts);

  const out = path.join(ports.runtimeRoot, "supervisor", "decision.json");
  const inputPath = path.join(ports.runtimeRoot, "supervisor", "diagnosis-input.md");
  const supervisorLogPath = path.join(ports.runtimeRoot, "logs", "supervisor-last.log");

  /** Kanoninis attempt įrašas pirmas, globalus decision.json veidrodis antras. */
  const writeDecision = async (decision: DiagnosisDecision): Promise<void> => {
    await ports.attempt.writeDecision(decision);
    await ports.files.writeDecision(`${JSON.stringify(decision, null, 2)}\n`);
  };

  const writeRepairArtifacts = async (content: string): Promise<void> => {
    // Repair prompt'as tampa dispatch task failu; be originalo `## Failai`/`## Patikra`
    // sekcijų repair darbas parkinamas „allowed paths missing" (task 1045) — jos perkeliamos
    // čia, viename funnel'yje visoms repair šakoms.
    const scoped = content.trim() ? carryTaskScopeIntoRepairPrompt(content, taskText ?? "") : content;
    if (scoped.trim()) {
      await ports.attempt.appendRepairPrompt(scoped);
    }
    await ports.files.writeRepairPrompt(scoped);
    await ports.files.writeGlobalRepair(scoped);
  };

  // `usagePhase` undefined = be usage įrašo (etalono budget šaka jo nerašo — modelis nekviestas
  // ir fast-path telemetrijos eilutė čia neatsiranda).
  const finishLocal = async (
    decision: DiagnosisDecision,
    repairContent: string,
    usagePhase: string | undefined,
    nextAction: string,
    logLine: string,
  ): Promise<number> => {
    await writeDecision(decision);
    await writeRepairArtifacts(repairContent);
    await ports.recordResumeCheckpoint({
      actor: "supervisor",
      phase: "diagnosis",
      status: "finished",
      task_id: taskId,
      task_file: taskFile,
      log_file: out,
      next_action: nextAction,
    });
    if (usagePhase !== undefined) {
      await ports.logTokenUsage(usagePhase, "none");
    }
    await ports.agLog(logLine);
    return 0;
  };

  // base_head iš attempt task-start-status: lango commit'ai įrodo Stop hook'o užcommitintą
  // darbą net kai git status švarus; be attempt artefakto commitsSinceStart lieka tuščias.
  const taskStartStatus = await ports.readTaskStartStatus();
  const commitsSinceStart = taskStartStatus.task_id === taskId ? await ports.git.logSince(taskStartStatus.base_head) : "";
  // 2026-08-14 false-done epidemija: „naujas commit" reikalauja lange commit'o su bent vienu
  // PRODUKTO keliu; lifecycle-only langas krenta į pilną diagnozę.
  const productWorkSha = commitsSinceStart.trim().length > 0 ? await ports.windowProductWorkSha(taskId) : undefined;

  const claudeExitRaw = (await ports.readOptionalFile(path.join(ports.runtimeRoot, "state", "claude-last-exit-code"))).trim();
  const parsedExit = Number.parseInt(claudeExitRaw, 10);
  // Task 0042: stop įrodymas iš ŠIO bandymo stop-state.json; globalus failas — tik fallback.
  const stopEvidence = await ports.readStopEvidence();
  for (const warning of stopEvidence.warnings) {
    await ports.agLog(`WARNING: ${warning}`);
  }
  // F7 vartai gyvena resolveEffectiveStopStatus: attempt kilmei netaikomi (tapatybę įrodė
  // manifestas), legacy šakoje — nepakitę.
  const effectiveStop = resolveEffectiveStopStatus(
    {
      origin: stopEvidence.origin,
      ...(stopEvidence.status === undefined ? {} : { status: stopEvidence.status }),
      ...(stopEvidence.taskId === undefined ? {} : { taskId: stopEvidence.taskId }),
    },
    taskId,
  );
  if (effectiveStop.foreign) {
    await ports.agLog(
      `WARNING: foreign claude-stop-status.json task=${taskId} status_task_id=${stopEvidence.taskId} — ignoring stale stop status`,
    );
  }
  const effectiveStopStatus = effectiveStop.status;
  const gatesStatus = await ports.readGatesStatus();
  const claudeSessionLog = await ports.readClaudeSessionLog();
  const gitStatusText = await ports.git.status();
  const dirtyEntries = nonRuntimeDirtyEntriesFromStatus(gitStatusText);

  // Deterministinis "done" greitkelis: visi sėkmės signalai galioja → done be LLM.
  // Workflow `done` handleris vis tiek viską pertikrina.
  const deterministic = evaluateDeterministicDone({
    claudeExitCode: Number.isFinite(parsedExit) ? parsedExit : 1,
    stopStatus: effectiveStopStatus,
    stopStatusCorrupted: stopEvidence.corrupted,
    qualityGates: gatesStatus ? { passed: gatesStatus.passed } : undefined,
    hasNewCommitSinceStart: productWorkSha !== undefined,
    alreadyImplementedMarker: logHasAlreadyImplementedMarker(claudeSessionLog.text),
    nonRuntimeDirtyCount: dirtyEntries.length,
  });
  if (deterministic.fastPath) {
    return await finishLocal(
      {
        verdict: "done",
        task_id: taskId,
        error_signature: "none",
        retry_key: "none",
        selected_model: "haiku",
        target_agent: "none",
        risk_level: "low",
        reason: `deterministic-done: ${deterministic.reason}`,
        claude_repair_task: "",
      },
      "",
      "diagnose-fastpath",
      "Apply diagnosis verdict done (deterministic fast-path, no LLM)",
      `CLAUDE DIAGNOSIS (deterministic): task=${taskId} verdict=done reason=${deterministic.reason}`,
    );
  }

  // F9: ankstesnio repair bandymo error signature — kartojimosi detekcijai ir LLM prompt'ui.
  const taskErrorSignatures = await ports.readErrorSignatures();
  const legacyErrorSignature = failedAttempts > 0 ? await ports.readLegacyErrorSignature() : "";
  const previousErrorSignature = taskErrorSignatures[taskId] ?? legacyErrorSignature;

  const windowBaseHead = taskStartStatus.task_id === taskId ? (taskStartStatus.base_head ?? "").trim() : "";
  const attribution = await collectSessionAttribution(ports, {
    taskId,
    stopEvidence,
    dirtyPaths: dirtyEntries.map((entry) => entry.path),
    windowBaseHead,
  });
  for (const line of attribution.logLines) {
    await ports.agLog(line);
  }

  const checksLogRaw = await ports.readOptionalFile(path.join(ports.runtimeRoot, "logs", "checks-last.log"));
  const localDiagnosis = evaluateLocalDiagnosis({
    taskId,
    ...(gatesStatus?.passed === undefined ? {} : { checksPassed: gatesStatus.passed }),
    ...(Number.isFinite(parsedExit) ? { exitCode: parsedExit } : {}),
    ...(effectiveStopStatus === undefined ? {} : { stopStatus: effectiveStopStatus }),
    changedFiles: attribution.sessionChangedFiles,
    allowedPaths: allowedPaths(taskText),
    stderr: tailLines(checksLogRaw, 300),
    stdout: stripStreamJsonTranscriptLines(claudeSessionLog.text),
  });

  // 2026-08-06 token auditas: lokalus „done" short-circuit'inamas be LLM — modelio nuomonė
  // task'o neuždaro, verify-task kiekvieną done nepriklausomai pertikrina.
  if (localDiagnosis.verdict === "done") {
    return await finishLocal(
      {
        verdict: "done",
        task_id: taskId,
        error_signature: "none",
        retry_key: "none",
        selected_model: "haiku",
        target_agent: "none",
        risk_level: "low",
        reason: `local-diagnosis: ${localDiagnosis.reason}`,
        claude_repair_task: "",
      },
      "",
      "diagnose-local",
      "Apply local diagnosis verdict done (no LLM; verify-task re-checks it)",
      `CLAUDE DIAGNOSIS (local): task=${taskId} verdict=done reason=${localDiagnosis.reason}`,
    );
  }

  if (localDiagnosis.verdict === "repair" || localDiagnosis.verdict === "human-review") {
    const escalation =
      localDiagnosis.verdict === "repair"
        ? evaluateRepeatedErrorEscalation(localDiagnosis.reason, previousErrorSignature)
        : { escalate: false, reason: "" };
    const isHumanReview = localDiagnosis.verdict === "human-review" || escalation.escalate;
    const reason = escalation.escalate ? escalation.reason : localDiagnosis.reason;

    const repairTask = !isHumanReview
      ? `# Repair Task

## Tikslas
Pataisyk aiškią lokalią implementacijos klaidą.

## Agentas
debugger

## Klaida
${reason}

## Veiksmas
Remkis vq/logs/checks-last.log ir pataisyk tik šios užduoties allowed paths apimtyje.

## Patikra
Paleisk užduotyje nurodytas patikras.

## Stop
Sustok, kai patikros praeina.

## Neįtraukta
- Model-based diagnosis.
- Rollback.
`
      : "";
    const decision: DiagnosisDecision = {
      verdict: isHumanReview ? "human_review" : "repair",
      task_id: taskId,
      error_signature: reason,
      retry_key: reason,
      selected_model: "haiku",
      target_agent: isHumanReview ? "none" : "debugger",
      risk_level: isHumanReview ? "high" : "medium",
      reason: `local-diagnosis: ${reason}`,
      claude_repair_task: repairTask,
    };
    return await finishLocal(
      decision,
      repairTask ? `${repairTask.trimEnd()}\n` : "",
      "diagnose-local",
      `Apply local diagnosis verdict ${decision.verdict}`,
      `CLAUDE DIAGNOSIS (local): task=${taskId} verdict=${decision.verdict} reason=${reason}`,
    );
  }

  // TOK-2: nuo čia — vienintelis šio kelio LLM kvietimas; hard riba NĖRA techninė klaida:
  // task'as maršrutizuojamas į human_review (exit 0 — sprendimą pritaiko workflow).
  const diagnosisBudget = await ports.authorizeLlmCall(taskId);
  if (!diagnosisBudget.allowed) {
    const reason = `token budget exhausted before diagnosis: ${diagnosisBudget.hard_reasons.join("; ")}`;
    return await finishLocal(
      {
        verdict: "human_review",
        task_id: taskId,
        error_signature: reason,
        retry_key: reason,
        selected_model: "haiku",
        target_agent: "none",
        risk_level: "high",
        reason: `budget-governance: ${reason}`,
        claude_repair_task: "",
      },
      "",
      undefined,
      "Apply diagnosis verdict human_review (token budget exhausted)",
      `CLAUDE DIAGNOSIS (budget): task=${taskId} verdict=human_review reason=${reason}`,
    );
  }
  if (diagnosisBudget.reduce_context) {
    await ports.agLog(
      `CLAUDE DIAGNOSIS: task=${taskId} budget soft limit — reduced log context: ${diagnosisBudget.soft_reasons.join("; ")}`,
    );
  }

  const prompt = buildDiagnosisPrompt({
    taskId,
    taskText,
    claudeExitRaw,
    stopOrigin: stopEvidence.origin,
    stopBlock: renderStopBlock({
      foreign: effectiveStop.foreign,
      corrupted: stopEvidence.corrupted,
      raw: stopEvidence.raw,
      stopTaskId: stopEvidence.taskId,
      taskId,
    }),
    gitStatusText,
    gitHead: (await ports.git.head()) ?? "",
    commitsSinceStart,
    checksTail: tailLines(checksLogRaw, diagnosisBudget.reduce_context ? 80 : 300),
    claudeLogOrigin: claudeSessionLog.origin,
    claudeLogText: claudeSessionLog.text,
    retryCountsRaw: await ports.readRetryCountsRaw(),
    previousErrorSignature,
    modelSelectionRules: ports.modelSelectionRules,
    reduceContext: diagnosisBudget.reduce_context,
  });

  // Kanoninis įrašas append-only; globalus diagnosis-input.md perrašomas kiekvieno task'o.
  await ports.attempt.appendDiagnosisInput(prompt);
  await ports.files.writeDiagnosisInput(prompt);
  await ports.recordResumeCheckpoint({
    actor: "supervisor",
    phase: "diagnosis",
    status: "started",
    task_id: taskId,
    task_file: taskFile,
    log_file: inputPath,
    next_action: "Run Claude diagnosis from Claude/check logs",
  });

  // TOK-3: diagnozės apimtis nepriklauso nuo originalaus task'o dydžio — tier "small";
  // llmMaxTurns lieka bendros lubos virš semantic-review lentelės.
  const diagnoseLimits = await ports.loadDiagnoseLimits();
  const result = await ports.runHeadless(prompt, model, {
    disallowWriteTools: true,
    maxTurns: resolveMaxTurns({
      phase: "semantic-review",
      tier: "small",
      ...(diagnoseLimits.turnLimits === undefined ? {} : { limits: diagnoseLimits.turnLimits }),
      ceiling: diagnoseLimits.llmMaxTurns,
    }),
  });
  await ports.files.writeSupervisorLog(`${result.stdout}${result.stderr}`);
  await ports.logTokenUsage("diagnose", model, result.stdout);

  // 429 — infrastruktūra: task'as grįžta į queue, loop'as palaukia cooldown.
  if (ports.isUsageLimitOutput(result.stdout)) {
    await ports.recordResumeCheckpoint({
      actor: "supervisor",
      phase: "diagnosis",
      status: "failed",
      task_id: taskId,
      task_file: taskFile,
      log_file: supervisorLogPath,
      exit_code: USAGE_LIMIT_EXIT_CODE,
      next_action: "Claude API limit reached — loop waits for the cooldown and resumes",
    });
    ports.stderr("Claude API limitas pasiektas (429) — task grįžta į queue, loop lauks cooldown");
    return USAGE_LIMIT_EXIT_CODE;
  }

  if (result.code !== 0) {
    await ports.recordResumeCheckpoint({
      actor: "supervisor",
      phase: "diagnosis",
      status: "failed",
      task_id: taskId,
      task_file: taskFile,
      log_file: supervisorLogPath,
      exit_code: result.code,
      next_action: "Read supervisor-last.log and send task to human review if diagnosis cannot continue",
    });
    ports.stderr(result.stderr || result.stdout);
    return result.code;
  }

  const decision = ports.parseDecision(result.stdout);
  await writeDecision(decision);

  let repairTask = decision.claude_repair_task ?? "";
  if (repairTask && !repairTask.includes("# Repair Task")) {
    repairTask = `# Repair Task

## Tikslas
Pataisyk tik vieną Claude diagnozuotą klaidą.

## Agentas
Privalomas agentas: ${decision.target_agent ?? "debugger"}

${repairTask}`;
  }

  await writeRepairArtifacts(repairTask ? `${repairTask.trimEnd()}\n` : "");
  await ports.recordResumeCheckpoint({
    actor: "supervisor",
    phase: "diagnosis",
    status: "finished",
    task_id: taskId,
    task_file: taskFile,
    log_file: supervisorLogPath,
    next_action:
      decision.verdict === "repair" ? "Delegate repair task to Claude" : `Apply diagnosis verdict ${decision.verdict ?? "unknown"}`,
  });
  await ports.agLog(
    `CLAUDE DIAGNOSIS: task=${taskId} verdict=${decision.verdict ?? ""} model=${decision.selected_model ?? ""} retry_key=${decision.retry_key ?? "none"}`,
  );
  return 0;
}
