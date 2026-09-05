// Koordinatoriaus portų surišimas, II dalis: git įrodymai, vykdymo politika, diagnozės
// taisyklės, užbaigimas — ir viso `TaskRunPorts` surinkimas (manual DI, LAY-2).
//
// Bendra šio pjūvio tema: čia gyvena tai, kas SPRENDŽIA, ar task'as gali būti uždarytas.
// Vienas įrodymo šaltinis (work-evidence) tarnauja abiem vartams — clean-tree diagnozei ir
// pre-dispatch praleidimui — todėl du vartai fiziškai negali nesutarti dėl to, ar darbas
// padarytas.
//
// I dalis (žurnalai, CLI, gedimai, failai, ledger'is, būsena) — `coordinator-adapters`.

import path from "node:path";
import { integrationGatePort, integrationReviewPort, preflightFailureMemoPort } from "./coordinator-optional-adapters.js";
import { cheapFinishPort } from "../quality/cheap-finish-adapters.js";
import { assembleContextPack } from "../../application/context-pack/assemble/assemble.js";
import { loadAgentPolicy } from "../../application/policy-governance/agent-policy.js";
import { loadPreflightLimits } from "../../application/policy-governance/preflight-limits-policy.js";
import { resolveLoopDispatchAdapter } from "../../application/task-execution/adapter-routing.js";
import { archiveAutoOpenSpecChangeOnDone } from "../../application/task-execution/openspec-archive.js";
import { enqueueChildTasks } from "../../application/task-execution/enqueue-child-tasks.js";
import { routeBlockedTasksToHumanReview } from "../../application/task-execution/task-graph-import.js";
import { childTaskLedgerPath } from "../../application/task-execution/task-ledger-rules.js";
import { syncArchitectureTaskCompletion } from "../../application/architecture/task-sync.js";
import { authorizeLlmCall, enforceExecutionBudget } from "../../application/token-governance/tool-budget-gates.js";
import { loadRoutingPolicy, routeModel } from "../../application/token-governance/route-model.js";
import { measureTaskSize } from "../../application/quality-gates/preflight-fastpath.js";
import {
  modelTierOfRoutingTier,
  routingTierOfSelection,
} from "../../infrastructure/adapters/claude-model-env.js";
import { classifyDispatchWriteOutcome, extractDispatchToolUsage } from "../../infrastructure/adapters/claude-tool-schema.js";
import { loadProjectProfile } from "../agent/preflight-adapters.js";
import { buildTaskUsageLedger, parseTaskUsageEntries } from "../../domain/tokens/usage-ledger.js";
import { logHasAlreadyImplementedMarker, logHasAuditCompleteMarker } from "../../domain/diagnosis/stream-log.js";
import {
  resolveDispatchSessionNonce,
  resolveNoCommitDisposition,
  resolveNoCommitReviewReason,
  type StopEvidenceOrigin,
} from "../../domain/diagnosis/dispositions.js";
import { sessionStartStatusPath, type SessionStartBaseline } from "../../application/task-execution/session-baseline.js";
import { nonRuntimeDirtyEntriesFromStatus } from "../../domain/git/changes.js";
import {
  mergeStopBridgeSources,
  STOP_BRIDGE_WAIT_POLL_MS,
  stopBridgeWaitMs,
  waitForOwnStopBridgeDone,
  type StopBridgeProbe,
} from "../../application/task-execution/stop-bridge-wait.js";
import type {
  ChildTaskEnqueueResult,
  CliPort,
  CompletionPort,
  DiagnosisRulesPort,
  ExecutionPolicyPort,
  GitPort,
  TaskRunPorts,
} from "../../application/task-execution/run-coordinator-ports.js";
import { collectChangedFiles } from "../../infrastructure/git/changed-files.js";
import { gitHead, gitStatus, hasNewHeadSince } from "../../infrastructure/git/git-client.js";
import { checkpointStableRef, stableRefPath } from "../../infrastructure/git/stable-ref.js";
import {
  taskCommittedProductWorkSha,
  taskCommittedWorkSha,
} from "../../infrastructure/git/work-evidence.js";
import { nodeFsAdapter } from "../../infrastructure/fs/node-fs-adapter.js";
import { isGitRepository } from "../../infrastructure/git/git-client.js";
import { stopBridgePath, stopStateSchema } from "../../infrastructure/state/stop-bridge.js";
import { toPrettyJson, tryParseJson } from "../../shared/json.js";
import { assembleContextPackDeps } from "../quality/architecture-adapters.js";
import {
  blockedTaskRoutingPorts,
  openSpecReconcileFs,
  policyConfigFs,
  tokenBudgetPorts,
} from "../runtime/node-adapters.js";
import { architectureWavePorts } from "../quality/architecture-adapters.js";
import { changedProductPathsSince, readOptionalFile } from "../quality/diagnose-adapters.js";
import { appendLogLine, retryCountsStore } from "./adapters.js";
import {
  coordinatorCliPort,
  coordinatorFailurePort,
  coordinatorJournalPort,
  coordinatorLedgerPort,
  coordinatorLogPort,
  coordinatorRepairPromptPort,
  coordinatorStatePort,
  coordinatorTaskFilePort,
  type CoordinatorAdapterInput,
} from "./coordinator-adapters.js";

/**
 * Git įrodymai koordinatoriui.
 *
 * `committedWorkShaFor` ir `committedProductWorkShaFor` yra ATSKIRI sąmoningai: tvarkomieji
 * commit'ai (`chore(AG/tasks): …`) mini task'o numerį vien dėl bucket perkėlimo. Po dispatch'o
 * toks atitikmuo nekaltas, o pre-dispatch vartuose jis VIENAS uždarytų niekada nedirbtą task'ą.
 */
export function coordinatorGitPort(input: CoordinatorAdapterInput): GitPort {
  const evidence = (taskId: string): Parameters<typeof taskCommittedWorkSha>[0] => ({
    projectRoot: input.projectRoot,
    runtimeRoot: input.runtimeRoot,
    taskId,
    resolution: input.resolution,
    warn: (line) => appendLogLine(input.runtimeRoot, "orchestrator.log", line),
  });

  return {
    isRepository: () => isGitRepository(input.projectRoot),
    head: () => gitHead(input.projectRoot),
    hasNewHeadSince: (ref) => hasNewHeadSince(ref, input.projectRoot),
    changedProductPathsSince: (ref) => changedProductPathsSince(input.projectRoot, ref),
    productDirtyCount: async () => nonRuntimeDirtyEntriesFromStatus(await gitStatus(input.projectRoot)).length,
    // Ne-git projektuose `git status` nieko nepasako, o hook'ų `changes.log` — pasako.
    recordedChangeCount: async () => (await collectChangedFiles(input.projectRoot, input.runtimeRoot)).length,
    committedWorkShaFor: (taskId) => taskCommittedWorkSha(evidence(taskId)),
    committedProductWorkShaFor: (taskId) => taskCommittedProductWorkSha(evidence(taskId)),
  };
}

/** Vykdymo politika: context-pack, biudžeto vartai, adapterio leidimas ir usage ledger'is. */
export function coordinatorPolicyPort(input: CoordinatorAdapterInput): ExecutionPolicyPort {
  return {
    // META, kai context-pack nepavyksta: klasifikaciją (infrastruktūra vs task'o kaltė) daro
    // `dispatch-task`, ir tyliai grąžintas tuščias paketas atimtų iš jo tą sprendimą.
    buildContextPack: async (promptFile) => {
      const result = await assembleContextPack(
        [promptFile],
        input.projectRoot,
        assembleContextPackDeps(input.projectRoot, input.runtimeRoot, input.resolution),
      );
      return result.pack;
    },
    /**
     * 017 (2026-08-25, audito P1-1): vartams — REALIAI dispatch'insimo modelio klasė.
     * Skaičiuojama tais pačiais įėjimais kaip `resolveDispatchRoutingPlan` claude-dispatch
     * viduje: tas pats task tekstas, ta pati routing politika, tie patys retry skaitikliai ir
     * tie patys biudžeto signalai iš `authorizeLlmCall` (jo `writeBudgetStatus` čia perrašomas
     * dispatch'o vėlesnio kvietimo — snapshot'as, ne skaitiklis, tad dvigubo skaičiavimo nėra).
     * `routeModel` deterministinis, tad verdiktas sutampa su tuo, ką dispatch'as paleis.
     */
    resolveDispatchModelClass: async (request) => {
      const taskText = await readOptionalFile(request.promptFile);
      const routingPolicy = await loadRoutingPolicy(policyConfigFs, input.runtimeRoot);
      const projectProfile = await loadProjectProfile(input.runtimeRoot).catch(() => undefined);
      const metrics = measureTaskSize(taskText, projectProfile?.source_roots);
      const retryCounts = await retryCountsStore(input.runtimeRoot).read();
      const rawRetryCount = retryCounts[`task:${request.taskId}`];
      const failedAttempts =
        typeof rawRetryCount === "number" && Number.isFinite(rawRetryCount) ? rawRetryCount : 0;
      const authorization = await authorizeLlmCall(tokenBudgetPorts(input.runtimeRoot), input.runtimeRoot, {
        taskId: request.taskId,
        phase: request.phase,
      });
      const routing = routeModel({
        phase: request.phase,
        taskText,
        ...(request.selectedModel ? { selectedTier: routingTierOfSelection(request.selectedModel) } : {}),
        failedAttempts,
        size: {
          lines: metrics.lines,
          allowedPaths: metrics.allowedPaths,
          domains: metrics.domains,
          actionBullets: metrics.actionBullets,
        },
        budget: {
          reduceContext: authorization.reduce_context,
          remainingTotalLlmCalls: authorization.remaining_total_llm_calls,
          remainingTotalTokens: authorization.remaining_total_tokens,
          totalLlmCalls: authorization.total_llm_calls,
        },
        policy: routingPolicy,
      });
      return modelTierOfRoutingTier(routing.tier);
    },
    // 142-B: žyma perduodama NEPAKEISTA. Adapteris jos netikrina ir neinterpretuoja —
    // sprendimas, ką ji slopina, gyvena viename taške (`enforceExecutionBudget`).
    enforceBudget: async (request) => {
      const verdict = await enforceExecutionBudget(tokenBudgetPorts(input.runtimeRoot), input.runtimeRoot, {
        model: request.model,
        contextPack: request.contextPack,
        taskId: request.taskId,
        phase: request.phase,
        ...(request.humanReviewApproved === undefined ? {} : { humanReviewApproved: request.humanReviewApproved }),
      });
      return { ok: verdict.ok, reasons: verdict.reasons };
    },
    /**
     * Loop'as vykdo TIK per claude adapterį. Task'as, kurio `## Agentai` rolė jo neleidžia,
     * čia meta — ir tai teisinga: tylus vykdymas per neleistą adapterį apeitų rolės politiką.
     */
    assertLoopAdapterAllowed: async (promptFile) => {
      const taskText = await readOptionalFile(promptFile);
      resolveLoopDispatchAdapter(taskText, await loadAgentPolicy(policyConfigFs, input.runtimeRoot));
    },
    logTaskUsageLedger: async (taskId) => {
      try {
        const raw = await readOptionalFile(path.join(input.runtimeRoot, "logs", "token-usage.jsonl"));
        const ledger = buildTaskUsageLedger(taskId, parseTaskUsageEntries(raw));
        await appendLogLine(input.runtimeRoot, "orchestrator.log", `USAGE LEDGER ${taskId}: ${toPrettyJson(ledger)}`);
      } catch {
        // Best-effort: apskaitos eilutė negali sugriauti task'o, kurį ji tik aprašo.
      }
    },
  };
}

/** Grynos diagnozės taisyklės per portą — jokio IO. */
export const coordinatorRulesPort: DiagnosisRulesPort = {
  hasAlreadyImplementedMarker: (claudeLog) => logHasAlreadyImplementedMarker(claudeLog),
  resolveNoCommitDisposition: (inputs) => resolveNoCommitDisposition(inputs),
  readExecutorWriteActivity: (claudeLog) => classifyDispatchWriteOutcome(extractDispatchToolUsage(claudeLog)),
  resolveNoCommitReviewReason: (inputs) => resolveNoCommitReviewReason(inputs),
  hasAuditCompleteMarker: (claudeLog) => logHasAuditCompleteMarker(claudeLog),
};

/** Užbaigimas: stable-ref, architektūros sinchronizacija, kaskada, archyvavimas, vaikai. */
export function coordinatorCompletionPort(input: CoordinatorAdapterInput): CompletionPort {
  const logLine = (line: string): Promise<void> => appendLogLine(input.runtimeRoot, "orchestrator.log", line);

  return {
    markStable: async () => {
      await checkpointStableRef(input.projectRoot, stableRefPath(input.runtimeRoot));
    },
    // Trys best-effort keliai. Nė vienas negali paversti jau įrodyto `done` nesėkme: darbas
    // padarytas ir commit'intas, o šios operacijos tik atnaujina lydimąją būseną.
    syncArchitectureCompletion: async (taskId, doneTaskFile) => {
      try {
        await syncArchitectureTaskCompletion(
          architectureWavePorts(input.projectRoot),
          input.projectRoot,
          taskId,
          doneTaskFile,
        );
      } catch (error: unknown) {
        await logLine(`WARNING: architecture completion sync failed task=${taskId}: ${String(error)}`);
      }
    },
    cascadeBlockedDependents: async (taskId) => {
      try {
        await routeBlockedTasksToHumanReview(
          blockedTaskRoutingPorts(input.projectRoot, input.agRoot, input.runtimeRoot),
          taskId,
        );
      } catch (error: unknown) {
        await logLine(`WARNING: blocked-dependent cascade failed task=${taskId}: ${String(error)}`);
      }
    },
    archiveAutoOpenSpecChange: async (taskId, doneTaskFile) => {
      const outcome = await archiveAutoOpenSpecChangeOnDone(
        openSpecReconcileFs,
        input.agRoot,
        taskId,
        doneTaskFile,
      );
      if (outcome.action === "error") await logLine(`WARNING: auto-openspec archive failed task=${taskId}`);
    },
    enqueueChildTasks: async (taskId, decision): Promise<ChildTaskEnqueueResult> => {
      const ledgerPath = childTaskLedgerPath(input.runtimeRoot);
      const outcome = await enqueueChildTasks(
        {
          readLedger: async () => {
            const raw = await nodeFsAdapter.readTextFileIfExists(ledgerPath);
            if (raw === undefined) return {};
            try {
              return JSON.parse(raw) as Record<string, never>;
            } catch {
              // Sugadintas vaikų ledger'is skaitomas kaip tuščias: alternatyva būtų atsisakyti
              // skaidyti task'ą dėl apskaitos failo, o gylio vartus vis tiek gina `maxSplitDepth`.
              return {};
            }
          },
          recordLedgerEntry: async (key, entry) => {
            const raw = await nodeFsAdapter.readTextFileIfExists(ledgerPath);
            const current = raw === undefined ? {} : (JSON.parse(raw) as Record<string, unknown>);
            await nodeFsAdapter.writeTextFile(ledgerPath, toPrettyJson({ ...current, [key]: entry }));
          },
          exists: (filePath) => nodeFsAdapter.exists(filePath),
          writeUniqueTaskFile: async (preferredPath, content) => {
            // `wx` cikle: kolizija gauna sufiksą, o esamas vaikas NIEKADA neperrašomas.
            for (let suffix = 0; suffix < 100; suffix += 1) {
              const parsed = path.parse(preferredPath);
              const candidate =
                suffix === 0 ? preferredPath : path.join(parsed.dir, `${parsed.name}-${suffix + 1}${parsed.ext}`);
              if ((await nodeFsAdapter.writeFileExclusive(candidate, content)) === "created") return candidate;
            }
            throw new Error(`child task collision limit reached: ${preferredPath}`);
          },
          maxSplitDepth: async () => (await loadPreflightLimits(policyConfigFs, input.runtimeRoot)).maxSplitDepth,
          log: logLine,
          nowIso: () => new Date().toISOString(),
        },
        // AG ŠAKNIS, ne queue katalogas: `enqueueChildTasks` pati stato kelią per
        // `taskBucketDir(agRoot, "queue")`. Iki 2026-08-25 čia buvo `path.dirname(queueDir)` —
        // kelias buvo suskaičiuojamas, o paskui iš jo bandoma „atstatyti" šaknis: `dirname` nuimdavo
        // tik `queue`, o `taskBucketDir` `tasks` pridėdavo ANTRĄ kartą. Vaikai nusėsdavo į
        // `AG/tasks/tasks/queue/`, kurio planuoklis neskenuoja (užduotys dingdavo) ir kuris nepatenka
        // į runtime kelių filtrą, tad kiekvienas toks failas atrodė kaip PRODUKTO purvas ir stabdydavo
        // ciklą ties „dirty product tree".
        input.agRoot,
        taskId,
        decision,
      );
      if (outcome.ok) return { ok: true };
      return "depth_exceeded" in outcome
        ? { ok: false, depth_exceeded: outcome.depth_exceeded }
        : { ok: false, invalid: outcome.invalid ?? [] };
    },
  };
}

/**
 * Coordinator's OWN stop-bridge probe (021-d-05, C4) — tas pats šaltinių sujungimas kaip
 * dispatch kelyje (`mergeStopBridgeSources` ant attempt + global šaltinių), bet skaitomas iš
 * ŠIO (coordinator) proceso pusės: verifikacija vyksta jame, o ne dispatch'o vaike, tad
 * `claude-dispatch-outcome.ts` probe'o čia perpanaudoti negalima — jis uždaras savo faile.
 */
function ownStopBridgeProbe(input: CoordinatorAdapterInput, taskId: string, dispatchNonce: string): StopBridgeProbe {
  const globalStopBridgeFile = stopBridgePath(input.runtimeRoot);
  return async () => {
    try {
      let attemptRaw: string | undefined;
      const resolved = await input.resolution.resolveActiveAttempt(taskId);
      if (resolved.ok) {
        const read = await resolved.attempt.handle.readJson("stop-state", stopStateSchema);
        if (read.ok) attemptRaw = JSON.stringify(read.data);
      }
      return mergeStopBridgeSources(
        attemptRaw,
        (await nodeFsAdapter.readTextFileIfExists(globalStopBridgeFile)) ?? "",
        dispatchNonce,
      );
    } catch {
      return { classification: "none", source: "none" };
    }
  };
}

/**
 * Task 163 — koordinatoriaus PROCESAS niekada negauna `AG_DISPATCH_NONCE`: launcher jį rašo
 * TIK dispatch vaiko env, kuris koordinatoriui nematomas. Rezoliucija ta pačia tvarka kaip
 * `resolveDispatchSessionNonce` (F7/0049, `domain/diagnosis/dispositions.ts`): gyvas env →
 * SessionStart baseline (last-writer-wins veidrodis, tad traktuojamas kaip `legacy` stop
 * įrodymas — `task_id` turi sutapti su `current-task-id`) → tuščia.
 *
 * Baseline papildomai atmetamas (origin `none`), jei jis SENESNIS už ŠIO attempt'o pradžią
 * (`manifest.created_at`) — kitaip ankstesnio, jau baigto bandymo nonce būtų tyliai
 * paveldėtas naujo bandymo laukimui. Kai attempt'as neišsprendžiamas (`no-runtime`/`disabled`
 * ir pan. — normali būsena be runtime namespace'o), palyginti nėra su kuo, tad amžiaus vartai
 * NEVEIKIA ir sprendžia vien `task_id` sutapimas.
 */
async function resolveCoordinatorDispatchNonce(input: CoordinatorAdapterInput, taskId: string): Promise<string> {
  const envNonce = (process.env["AG_DISPATCH_NONCE"] ?? "").trim();
  if (envNonce !== "") return envNonce;

  const baselineRaw = await nodeFsAdapter.readTextFileIfExists(
    sessionStartStatusPath(path.join(input.runtimeRoot, "state")),
  );
  const parsed = baselineRaw === undefined ? undefined : tryParseJson<SessionStartBaseline>(baselineRaw);
  const baseline: SessionStartBaseline =
    parsed?.ok && parsed.value !== null && typeof parsed.value === "object" && !Array.isArray(parsed.value)
      ? parsed.value
      : {};

  const resolved = await input.resolution.resolveActiveAttempt(taskId);
  const attemptStartMs = resolved.ok ? Date.parse(resolved.attempt.manifest.created_at) : Number.NaN;
  const baselineUpdatedMs = Date.parse(baseline.updated_at ?? "");
  const notOlderThanAttempt =
    !Number.isFinite(attemptStartMs) || (Number.isFinite(baselineUpdatedMs) && baselineUpdatedMs >= attemptStartMs);
  const origin: StopEvidenceOrigin = notOlderThanAttempt ? "legacy" : "none";

  return resolveDispatchSessionNonce({
    envNonce,
    origin,
    recordNonce: baseline.dispatch_nonce ?? "",
    recordTaskId: baseline.task_id ?? "",
    taskId,
  });
}

/**
 * 021-d-05 (C4) — antras laukimo taškas: prieš `verifyTask` iškvietimą (jos pirmas veiksmas
 * yra `cli.run(["quality-gates"])`) coordinator laukia SAVO stop-bridge įrodymo ribotą langą.
 *
 * 018 incidentas: verifikacija nusprendė „nėra commit'o" 24s PRIEŠ tai, kai Stop hook'as jį
 * realiai parašė (jis rašomas PO `commitAndPush`), o esamas dispatch kelio laukimas
 * (`claude-dispatch-outcome.ts`) tos akimirkos nepadengia — jis atsidaro tik dviprasmiškam
 * usage deriniui, o 018 usage buvo netuščias. `own-done` nutraukia laukimą iškart; timeout
 * NIEKO nekeičia — tik nebeleidžia verify aplenkti hook'o (žr.
 * docs/audits/021-rollback-preserve-design-2026-08-25.md, C4).
 *
 * Vartai — rezoliucijos rezultatas netuščias: tuščias reiškia interaktyvią/be-nonce sesiją be
 * galiojančio baseline, ir elgesys lieka baitas-į-baitą nepakitęs. Skip-dispatch
 * (`skip-dispatch.ts`) kviečia TĄ PATĮ `cli.run(["quality-gates"])` PRIEŠ bet kokį dispatch'ą —
 * tas pats vartas jį irgi apsaugo, nes nonce iš to paties šaltinio ten tokiu pat būdu tuščias.
 */
function verifyStopBridgeWaitCliPort(input: CoordinatorAdapterInput, basePort: CliPort): CliPort {
  return {
    ...basePort,
    run: async (args) => {
      if (args.length === 1 && args[0] === "quality-gates") {
        const taskId = (
          (await nodeFsAdapter.readTextFileIfExists(path.join(input.runtimeRoot, "state", "current-task-id"))) ?? ""
        ).trim();
        const dispatchNonce = await resolveCoordinatorDispatchNonce(input, taskId);
        if (dispatchNonce !== "") {
          const waited = await waitForOwnStopBridgeDone({
            probe: ownStopBridgeProbe(input, taskId, dispatchNonce),
            timeoutMs: stopBridgeWaitMs(),
            pollMs: STOP_BRIDGE_WAIT_POLL_MS,
          });
          await appendLogLine(
            input.runtimeRoot,
            "orchestrator.log",
            `COORDINATOR STOP WAIT RESULT: task=${taskId} ` +
              `result=${waited.classification === "own-done" ? "own-done" : "timeout"} ` +
              `classification=${waited.classification} source=${waited.source} ` +
              `waited_ms=${waited.waitedMs} polls=${waited.polls}`,
          );
        }
      }
      return basePort.run(args);
    },
  };
}

/**
 * Visi koordinatoriaus portai vienoje vietoje.
 *
 * `integration`, `integrationGate` ir `preflightMemo` prijungti (61/N): visi trys reikalavo
 * konteksto — runtime šaknies, git revizijų ir attempt rezoliucijos — kurį kompozicija dabar turi.
 *
 * `cheapFinish` prijungtas 62/N: jo `prepareDispatch` daro retry inkrementą, attempt namespace'ą,
 * `decision.json` ir biudžeto epochą vienu ėjimu, o vienkartinį env overlay sunaudoja CLI portas.
 * Paduodamas TIK tada, kai kvietėjas atidavė overlay — be jo cheap finish liktų pusinis
 * (paruoštas bandymas be regeneruoto vykdymo konteksto), o tai blogiau nei jo nebuvimas.
 */
export function taskRunPorts(input: CoordinatorAdapterInput): TaskRunPorts {
  return {
    log: coordinatorLogPort(input.runtimeRoot),
    cli: verifyStopBridgeWaitCliPort(input, coordinatorCliPort(input)),
    failure: coordinatorFailurePort(input.runtimeRoot),
    tasks: coordinatorTaskFilePort(input),
    repairPrompt: coordinatorRepairPromptPort(input.runtimeRoot),
    ledger: coordinatorLedgerPort(input.runtimeRoot),
    journal: coordinatorJournalPort(input),
    state: coordinatorStatePort(input),
    git: coordinatorGitPort(input),
    policy: coordinatorPolicyPort(input),
    rules: coordinatorRulesPort,
    completion: coordinatorCompletionPort(input),
    integration: integrationReviewPort(input),
    integrationGate: integrationGatePort(input),
    preflightMemo: preflightFailureMemoPort(input),
    ...(input.cheapFinishOverlay === undefined
      ? {}
      : { cheapFinish: cheapFinishPort(input, input.cheapFinishOverlay) }),
  };
}
