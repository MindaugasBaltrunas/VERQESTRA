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
import { decideLearningRecommendation } from "../../application/learning/learning-memory.js";
import { drainAllSlots, resetLoopControl, setSlotMode } from "../../application/scheduling/loop-control-store.js";
import { setRequestedWorkers } from "../../application/scheduling/worker-request-store.js";
import { buildDashboardView } from "../../interfaces/http/ui-dashboard-view.js";
import { buildWavesView, normalizeEventLimit } from "../../interfaces/http/ui-waves-view.js";
import { loadWorkflowBuckets, loadWorkflowBucketTasks, openTaskBucketFolder } from "../../interfaces/http/workflow-buckets.js";
import { applyTaskTriage } from "../../interfaces/http/ui-task-actions.js";
import { uploadQueueMarkdownFiles } from "../../interfaces/http/task-upload.js";
import { ensureLoopRunning, requestLoopStop } from "../../interfaces/http/loop-lifecycle.js";
import type { UiRouterPorts } from "../../interfaces/http/ui-router.js";
import { listWorkerLeases } from "../../application/scheduling/worker-lease-store.js";
import { readTailLines } from "../../infrastructure/fs/tail-lines.js";
import { readWaveSnapshot, waveSnapshotExists } from "../../infrastructure/state/wave-snapshot-store.js";
import { nodeFsAdapter } from "../../infrastructure/fs/node-fs-adapter.js";
import { buildCompressionView } from "../../interfaces/http/ui-compression-view.js";
import { setCompressionFeature } from "../../interfaces/http/ui-compression-mutation.js";
import {
  contextCompressionConfigPath,
  loadContextCompressionConfig,
} from "../../application/context-pack/effective-compression-policy.js";

import { runIgnoredProcess } from "../../infrastructure/process/process-tree.js";
import { clearTaskLedgerEntry } from "../../application/task-execution/task-ledger-service.js";
import { authorizeWorkerRuntimeMutation } from "../../application/scheduling/worker-lease-runtime.js";
import { recordLlmCallReset } from "../../application/token-governance/tool-budget-gates.js";
import { learningFs, taskLedgerStore, taskStateStore, tokenBudgetPorts } from "../runtime/node-adapters.js";
import { contextPackFs } from "../quality/readiness-adapters.js";
import { schedulingFs } from "../loop/adapters.js";
import { processLifecyclePorts } from "./lifecycle-adapters.js";
import { dashboardViewPorts } from "./dashboard-adapters.js";
import { benchmarkReport, reliabilityAnalytics, tokenAnalytics, tokenUsageQuery, uiLogs } from "./analytics-adapters.js";
import { decidePolicyProposal, listPolicyProposals, proposePolicyChange } from "./policy-adapters.js";
import { homedir } from "node:os";

export type UiRouterAdapterInput = {
  projectRoot: string;
  runtimeRoot: string;
  agRoot: string;
  /** React dist katalogas; `undefined`, kai statinių failų nėra. */
  staticDir?: string;
  logError(message: string): void;
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
    // PILNAS dashboard snapshot'as, o ne vienas jo blokas: iki 2026-08-23 UI paleidimo audito čia
    // buvo `loadUiControlPlaneData`, tad klientas gaudavo `UiControlPlaneData` ten, kur laukia
    // `DashboardData`, ir React medis nulūždavo prieš pirmą renderį (`stopStatus.status`).
    dashboardData: () =>
      buildDashboardView({
        ports: dashboardViewPorts({
          projectRoot: input.projectRoot,
          runtimeRoot: input.runtimeRoot,
          agRoot: input.agRoot,
          // TIE PATYS portai, kuriuos naudoja `/api/tasks`: dvi eilės skaitymo kopijos duotų du
          // skirtingus atsakymus apie tą patį bucket'ą tame pačiame ekrane.
          loadWorkflowBuckets: () => loadWorkflowBuckets(workflowBucketPorts, input.agRoot),
          logError: (message) => input.logError(message),
        }),
        projectRoot: input.projectRoot,
        runtimeRoot: input.runtimeRoot,
        agRoot: input.agRoot,
      }),
    // Politikų governance eina per TĄ PATĮ use-case sluoksnį kaip CLI: `apply` realiai įrašo
    // politikos failą, o `ProposalNotApproved`/`HumanReviewApprovalRequired` vartai yra KELYJE, o
    // ne šalia jo (žr. `policy-adapters`).
    listPolicyProposals: () => listPolicyProposals(input.runtimeRoot),
    proposePolicyChange: (group, proposal) => proposePolicyChange(input.runtimeRoot, group, proposal),
    decidePolicyProposal: (verb, decision) => decidePolicyProposal(input.runtimeRoot, verb, decision),

    tokenUsage: (query) => tokenUsageQuery(input, query),
    logs: (query) => uiLogs(input, query),
    tokenAnalytics: () => tokenAnalytics(input),
    reliabilityAnalytics: (fresh) => reliabilityAnalytics(input, fresh),
    benchmarkReport: () => benchmarkReport(input),

    // Skaitymas ir rašymas dalijasi TUO PAČIU `loadConfig`: kitaip ekranas galėtų rodyti vieną
    // šaltinį, o mutacija remtis kitu, ir perjungimas atrodytų „neišsisaugojęs". FS adapteris —
    // esamas `contextPackFs`, o ne siaura kopija: dvi realizacijos tam pačiam failui prasilenktų,
    // vos viena jų pasikeistų.
    compressionView: () =>
      buildCompressionView({
        loadConfig: () => loadContextCompressionConfig(contextPackFs, input.runtimeRoot),
        readContextSizeLog: () =>
          nodeFsAdapter.readTextFileIfExists(path.join(input.runtimeRoot, "logs", "context-size.jsonl")),
      }),
    setCompressionFeature: (feature, value) =>
      setCompressionFeature(
        {
          loadConfig: () => loadContextCompressionConfig(contextPackFs, input.runtimeRoot),
          writeConfig: (serialized) =>
            nodeFsAdapter.writeTextFile(contextCompressionConfigPath(input.runtimeRoot), serialized),
        },
        feature,
        value,
      ),

    workflowBuckets: () => loadWorkflowBuckets(workflowBucketPorts, input.agRoot),
    workflowBucketTasks: (bucket) => loadWorkflowBucketTasks(workflowBucketPorts, input.agRoot, bucket),
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
    // „Stop" ir „Start" liečia DU dalykus: proceso vėliavą ir slot'ų valdiklį. Palikus valdiklį
    // nepaliestą, po „Stop" srautai ekrane liktų `run`, o po „Start" senas `drain` priverstų ką
    // tik paleistą loop'ą atsisakyti pirmo task'o.
    drainAllSlots: () => drainAllSlots({ fs: schedulingFs }, stateDir),
    resetLoopControl: () => resetLoopControl({ fs: schedulingFs }, stateDir),
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
