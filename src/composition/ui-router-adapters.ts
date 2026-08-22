// UI maršrutizatoriaus portų surišimas (manual DI, LAY-2).
//
// Maršrutizatorius yra grynas: jis niekada neliečia disko ir neturi savo būsenos. Visi 18 jo
// portų sueina čia, ir tai yra vienintelė vieta, kur dashboard'as virsta failų skaitymu.
//
// Bendra šio failo laikysena: dashboard'as yra DIAGNOSTIKOS paviršius, į kurį operatorius
// kreipiasi būtent tada, kai kažkas sulūžę. Todėl nė vienas ataskaitinis šaltinis negali
// nuversti viso puslapio — sugadintas artefaktas virsta įvardytu degradavusiu bloku, o ne 500.
// Išimtis yra MUTACIJOS (`uploadQueueFiles`, `applyTaskTriage`, loop valdymas): jos privalo
// kristi garsiai, nes tylus „nepavyko" ten reikštų operatoriaus paspaustą mygtuką be pasekmės.

import path from "node:path";
import { buildReliabilityAnalytics } from "../application/learning/reliability-report.js";
import { decideLearningRecommendation } from "../application/learning/learning-memory.js";
import {
  parseTokenUsageSummaryLines,
  summarizeTokenUsage,
  summarizeTokenUsageByModel,
} from "../application/analytics/token-usage-summary.js";
import { readBenchmarkReportView } from "../application/benchmark/suite-report-view.js";
import { setSlotMode } from "../application/scheduling/loop-control-store.js";
import { setRequestedWorkers } from "../application/scheduling/worker-request-store.js";
import { tokenAnalyticsSnapshotPath } from "../application/learning/token-analytics-snapshot.js";
import {
  appendPolicyProposal,
  readPolicyProposals,
  type PolicyProposalsFsPort,
} from "../application/policy-governance/policy-proposals-log.js";
import { loadUiControlPlaneData } from "../interfaces/ui-model/control-plane-model.js";
import { buildWavesView, normalizeEventLimit } from "../interfaces/http/ui-waves-view.js";
import { loadWorkflowBuckets, openTaskBucketFolder } from "../interfaces/http/workflow-buckets.js";
import { applyTaskTriage } from "../interfaces/http/ui-task-actions.js";
import { uploadQueueMarkdownFiles } from "../interfaces/http/task-upload.js";
import { ensureLoopRunning, requestLoopStop } from "../interfaces/http/loop-lifecycle.js";
import type { UiRouterPorts } from "../interfaces/http/ui-router.js";
import { currentCommitResolver, gitLogNumstat, gitStatusPorcelain } from "../infrastructure/git/git-client.js";
import { listWorkerLeases } from "../application/scheduling/worker-lease-store.js";
import { readSessionFileKinds, readSessionWrites } from "../infrastructure/state/session-activity.js";
import { readTailLines } from "../infrastructure/fs/tail-lines.js";
import { readWaveSnapshot, waveSnapshotExists } from "../infrastructure/state/wave-snapshot-store.js";
import { nodeFsAdapter } from "../infrastructure/fs/node-fs-adapter.js";
import { runIgnoredProcess } from "../infrastructure/process/process-tree.js";
import { tryParseJson } from "../shared/json.js";
import { clearTaskLedgerEntry } from "../application/task-execution/task-ledger-service.js";
import { authorizeWorkerRuntimeMutation } from "../application/scheduling/worker-lease-runtime.js";
import { recordLlmCallReset } from "../application/token-governance/tool-budget-gates.js";
import { learningFs, taskLedgerStore, taskStateStore, tokenBudgetPorts } from "./node-adapters.js";
import { contextPackFs } from "./readiness-adapters.js";
import { schedulingFs } from "./loop-adapters.js";
import { processLifecyclePorts } from "./ui-lifecycle-adapters.js";
import { homedir } from "node:os";

export type UiRouterAdapterInput = {
  projectRoot: string;
  runtimeRoot: string;
  agRoot: string;
  /** React dist katalogas; `undefined`, kai statinių failų nėra. */
  staticDir?: string;
  logError(message: string): void;
};

/** Pasiūlymų žurnalo portas: skaitymas plius append su katalogo sukūrimu. */
const policyProposalsFs: PolicyProposalsFsPort = {
  readTextFileIfExists: (absolutePath) => nodeFsAdapter.readTextFileIfExists(absolutePath),
  appendTextFile: (absolutePath, text) => nodeFsAdapter.appendTextFile(absolutePath, text),
  makeDirectory: (absoluteDir) => nodeFsAdapter.makeDirectory(absoluteDir),
};

/** Control-plane FS pjūvis: architektūros būsena, learning atmintis, politikos ir katalogai. */
const controlPlaneFs = {
  ...learningFs,
  exists: (absolutePath: string): Promise<boolean> => nodeFsAdapter.exists(absolutePath),
  listFiles: (absoluteDir: string): Promise<string[]> => nodeFsAdapter.listFiles(absoluteDir),
};

/** Bucket'ų portai: sąrašas plius katalogo atidarymas operatoriaus aplinkoje. */
const workflowBucketPorts = {
  listTaskFiles: (absoluteDir: string): Promise<string[]> => nodeFsAdapter.listMarkdownFiles(absoluteDir),
  /**
   * Katalogo atidarymas. Komanda parenkama pagal platformą, o kelias eina ARGUMENTU — laisvos
   * formos vardas niekada netampa komandos dalimi. Nesėkmė yra `false`, ne išimtis: operatoriaus
   * darbalaukio trūkumas neturi virsti 500 dashboard'e.
   */
  openFolder: async (absolutePath: string): Promise<boolean> => {
    const command =
      process.platform === "win32" ? "explorer.exe" : process.platform === "darwin" ? "open" : "xdg-open";
    // `runIgnoredProcess` LAUKIAMAS: be `await` nepavykęs paleidimas taptų pakibusiu Promise'u,
    // o dashboard'as parodytų „atidaryta" tada, kai nieko neatsidarė.
    return await runIgnoredProcess(command, [absolutePath]).catch(() => false);
  },
};

export function uiRouterPorts(input: UiRouterAdapterInput): UiRouterPorts {
  const stateDir = path.join(input.runtimeRoot, "state");
  const lifecycle = { ports: processLifecyclePorts(input), runtimeRoot: input.runtimeRoot };

  return {
    dashboardData: () =>
      loadUiControlPlaneData(
        { fs: controlPlaneFs },
        { projectRoot: input.projectRoot, runtimeRoot: input.runtimeRoot },
      ),
    listPolicyProposals: () => readPolicyProposals(policyProposalsFs, input.runtimeRoot),
    // Pasiūlymas ir sprendimas rašomi TUO PAČIU append-only keliu: registras yra ŽURNALAS, o ne
    // būsena, tad „patvirtinta" yra dar vienas įrašas, ne ankstesnio perrašymas.
    proposePolicyChange: (body) => appendPolicyProposal(policyProposalsFs, input.runtimeRoot, body as never),
    decidePolicyProposal: (verb, body) =>
      appendPolicyProposal(policyProposalsFs, input.runtimeRoot, { ...(body as object), verb } as never),

    tokenUsage: async (query) => {
      const raw = await nodeFsAdapter.readTextFileIfExists(path.join(input.runtimeRoot, "logs", "token-usage.jsonl"));
      const lines = parseTokenUsageSummaryLines(raw);
      // `?by=model` yra ATSKIRA suvestinė, o ne filtras: fazės ir modelio pjūviai sumuoja tuos
      // pačius įrašus skirtingais raktais, ir jų maišymas duotų dvigubai suskaičiuotus tokenus.
      return query.get("by") === "model" ? summarizeTokenUsageByModel(lines) : summarizeTokenUsage(lines);
    },
    tokenAnalytics: async () => {
      const raw = await nodeFsAdapter.readTextFileIfExists(tokenAnalyticsSnapshotPath(input.runtimeRoot));
      if (raw === undefined) return null;
      const parsed = tryParseJson<unknown>(raw);
      // Sugadintas snapshot'as → `null`, ne 500: analitika yra papildoma dashboard'o eilutė.
      return parsed.ok ? parsed.value : null;
    },
    reliabilityAnalytics: () =>
      buildReliabilityAnalytics(
        {
          fs: learningFs,
          gitLog: (sinceDays) => gitLogNumstat(input.projectRoot, sinceDays),
          gitStatusPorcelain: () => gitStatusPorcelain(input.projectRoot),
          sessionWrites: () => readSessionWrites(input.runtimeRoot),
          sessionFileKinds: () => readSessionFileKinds(input.runtimeRoot),
        },
        { runtimeRoot: input.runtimeRoot },
      ),
    benchmarkReport: () =>
      readBenchmarkReportView(
        {
          statPath: (absolutePath) => nodeFsAdapter.statPath(absolutePath),
          readTextFile: (absolutePath) => nodeFsAdapter.readTextFile(absolutePath),
          listDirectory: (absoluteDir) => nodeFsAdapter.listDirectory(absoluteDir),
        },
        { projectRoot: input.projectRoot, currentAgCommit: currentCommitResolver },
      ),

    workflowBuckets: () => loadWorkflowBuckets(workflowBucketPorts, input.agRoot),
    wavesView: (eventLimit) =>
      buildWavesView({
        ports: {
          readTailLines: (absoluteFile, maxBytes) => readTailLines(absoluteFile, maxBytes),
          listWorkerLeases: (projectRoot) => listWorkerLeases(schedulingFs, projectRoot),
          readWaveSnapshot: (dir) => readWaveSnapshot(dir),
          waveSnapshotExists: (dir) => waveSnapshotExists(dir),
          homeDir: () => homedir(),
          logError: (message) => input.logError(message),
        },
        projectRoot: input.projectRoot,
        runtimeRoot: input.runtimeRoot,
        eventLimit,
      }),

    decideLearningRecommendation: (id, decision) =>
      decideLearningRecommendation(learningFs, input.runtimeRoot, id, decision, []),

    // Bucket'o vardas ateina iš URL, tad kelio sudėjimas VISAS deleguojamas use case'ui
    // (`resolveTaskBucketDir` viduje) — čia jokios savos kelio aritmetikos.
    openTaskBucketFolder: (bucket) => openTaskBucketFolder(workflowBucketPorts, input.agRoot, bucket),
    uploadQueueFiles: (rawBody) =>
      uploadQueueMarkdownFiles(
        {
          writeFileExclusive: (absolutePath, content) => nodeFsAdapter.writeFileExclusive(absolutePath, content),
          makeDirectory: (absoluteDir) => nodeFsAdapter.makeDirectory(absoluteDir),
        },
        input.agRoot,
        rawBody,
      ),

    ensureLoopRunning: () => ensureLoopRunning(lifecycle),
    requestLoopStop: () => requestLoopStop(lifecycle),
    setRequestedWorkers: (body) => setRequestedWorkers({ fs: schedulingFs }, stateDir, body),
    setSlotMode: (workerId, body) => setSlotMode({ fs: schedulingFs }, stateDir, workerId, body),

    applyTaskTriage: (action, reference) =>
      applyTaskTriage(
        {
          ports: {
            /**
             * VARDAI, ne keliai: `resolveBucketEntry` lygina su `<task>.md`, tad absoliutus kelias
             * niekada nesutaptų ir UI triage nerastų NĖ VIENO task'o.
             */
            listTaskFiles: async (absoluteDir) =>
              (await nodeFsAdapter.listMarkdownFiles(absoluteDir)).map((file) => path.basename(file)),
            taskIdFromFile: (absoluteFile) => path.basename(absoluteFile).replace(/\.md$/i, ""),
            /**
             * Nuosavybės vartai PRIEŠ bet kokį rašymą — TA PATI taisyklė, kurią hook'ai taiko
             * task būsenos perėjimams (`authorizeWorkerRuntimeMutation`).
             *
             * `guardedPath` NEPADUODAMAS sąmoningai: triage juda task'o failą tarp bucket'ų, tad
             * jis liečia visą medį, ir gyvas svetimas lease privalo blokuoti nepriklausomai nuo
             * aprėpties. Bet kokia klaida (sugadintas lease, neperskaitomas store) virsta
             * DRAUDIMU — UI negali pajudinti task'o, kurio nuosavybės neįrodė.
             */
            authorizeMutation: async (taskId) => {
              const authority = await authorizeWorkerRuntimeMutation({
                deps: { fs: schedulingFs },
                projectRoot: input.projectRoot,
                taskId,
              });
              return authority.ok ? { ok: true } : { ok: false, reason: authority.reason };
            },
            clearLedgerEntry: (taskId) => clearTaskLedgerEntry(taskLedgerStore(input.runtimeRoot), taskId),
            recordLlmCallReset: (taskId) => recordLlmCallReset(tokenBudgetPorts(input.runtimeRoot), taskId),
            store: taskStateStore(input.agRoot, input.runtimeRoot),
          },
          agRoot: input.agRoot,
        },
        action,
        reference,
      ),

    hasStaticAssets: () => input.staticDir !== undefined,
    logError: (message) => input.logError(message),
  };
}

export { normalizeEventLimit, contextPackFs };
