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
import { assembleContextPack } from "../application/context-pack/assemble/assemble.js";
import { loadAgentPolicy } from "../application/policy-governance/agent-policy.js";
import { loadPreflightLimits } from "../application/policy-governance/preflight-limits-policy.js";
import { resolveLoopDispatchAdapter } from "../application/task-execution/adapter-routing.js";
import { archiveAutoOpenSpecChangeOnDone } from "../application/task-execution/openspec-archive.js";
import { enqueueChildTasks } from "../application/task-execution/enqueue-child-tasks.js";
import { routeBlockedTasksToHumanReview } from "../application/task-execution/task-graph-import.js";
import { syncArchitectureTaskCompletion } from "../application/architecture/task-sync.js";
import { enforceExecutionBudget } from "../application/token-governance/tool-budget-gates.js";
import { buildTaskUsageLedger, parseTaskUsageEntries } from "../domain/tokens/usage-ledger.js";
import { logHasAlreadyImplementedMarker } from "../domain/diagnosis/stream-log.js";
import { resolveNoCommitDisposition } from "../domain/diagnosis/dispositions.js";
import { nonRuntimeDirtyEntriesFromStatus } from "../domain/git/changes.js";
import type {
  ChildTaskEnqueueResult,
  CompletionPort,
  DiagnosisRulesPort,
  ExecutionPolicyPort,
  GitPort,
  TaskRunPorts,
} from "../application/task-execution/run-coordinator-ports.js";
import { collectChangedFiles } from "../infrastructure/git/changed-files.js";
import { gitHead, gitStatus, hasNewHeadSince } from "../infrastructure/git/git-client.js";
import { checkpointStableRef, stableRefPath } from "../infrastructure/git/stable-ref.js";
import {
  taskCommittedProductWorkSha,
  taskCommittedWorkSha,
} from "../infrastructure/git/work-evidence.js";
import { nodeFsAdapter } from "../infrastructure/fs/node-fs-adapter.js";
import { isGitRepository } from "../infrastructure/git/git-client.js";
import { toPrettyJson } from "../shared/json.js";
import { assembleContextPackDeps } from "./architecture-adapters.js";
import { blockedTaskRoutingPorts, policyConfigFs, tokenBudgetPorts } from "./node-adapters.js";
import { architectureWavePorts } from "./architecture-adapters.js";
import { changedProductPathsSince, readOptionalFile } from "./diagnose-adapters.js";
import { appendLogLine } from "./loop-adapters.js";
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
    enforceBudget: async (request) => {
      const verdict = await enforceExecutionBudget(tokenBudgetPorts(input.runtimeRoot), input.runtimeRoot, {
        model: request.model,
        contextPack: request.contextPack,
        taskId: request.taskId,
        phase: request.phase,
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
        {
          exists: (absolutePath) => nodeFsAdapter.exists(absolutePath),
          readTextFileIfExists: (absolutePath) => nodeFsAdapter.readTextFileIfExists(absolutePath),
          writeTextFileAtomic: (absolutePath, content) => nodeFsAdapter.writeTextFileAtomic(absolutePath, content),
          makeDirectory: (absoluteDir) => nodeFsAdapter.makeDirectory(absoluteDir),
          rename: (fromPath, toPath) => nodeFsAdapter.renamePath(fromPath, toPath),
        },
        input.agRoot,
        taskId,
        doneTaskFile,
      );
      if (outcome.action === "error") await logLine(`WARNING: auto-openspec archive failed task=${taskId}`);
    },
    enqueueChildTasks: async (taskId, decision): Promise<ChildTaskEnqueueResult> => {
      const queueDir = path.join(input.agRoot, "tasks", "queue");
      const ledgerPath = path.join(input.runtimeRoot, "state", "child-tasks.json");
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
        path.dirname(queueDir),
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
 * Visi koordinatoriaus portai vienoje vietoje.
 *
 * `integration`, `integrationGate` ir `preflightMemo` prijungti (61/N): visi trys reikalavo
 * konteksto — runtime šaknies, git revizijų ir attempt rezoliucijos — kurį kompozicija dabar turi.
 *
 * `cheapFinish` LIEKA neprijungtas ir tai ĮVARDINTA, ne nutylėta: jo `prepareDispatch` daro retry
 * inkrementą, attempt namespace'ą, `decision.json` ir biudžeto epochą vienu ėjimu, tad jam reikia
 * atskiro adapterio, o ne perrišimo. Be jo kiekvienas kelias lieka baitas į baitą toks pat.
 */
export function taskRunPorts(input: CoordinatorAdapterInput): TaskRunPorts {
  return {
    log: coordinatorLogPort(input.runtimeRoot),
    cli: coordinatorCliPort(input),
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
  };
}
