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
import { ensureUiRebuildRunning } from "../../interfaces/http/ui-rebuild.js";
import type { BundleMtimeFacts, UiRouterPorts } from "../../interfaces/http/ui-router.js";
import type { WorktreePolicyPorts } from "../../interfaces/http/ui-worktree-policy.js";
import { listWorkerLeases } from "../../application/scheduling/worker-lease-store.js";
import { loadWorktreePolicy } from "../../application/scheduling/worktree-policy.js";
import { readTailLines } from "../../infrastructure/fs/tail-lines.js";
import { worktreeRootIsIgnored } from "../../infrastructure/git/worktrees/worktree-layout.js";
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
import { processLifecyclePorts, uiRebuildProcessPorts } from "./lifecycle-adapters.js";
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
    const launched = await runIgnoredProcess(command, [absolutePath]).catch(() => false);
    // 2026-08-27: Windows `explorer.exe` grąžina exit 1 NET SĖKMINGAI atidaręs langą (žinoma
    // OS keistenybė), tad ten exit kodas nieko nepasako — kiekvienas paspaudimas dashboard'e
    // virsdavo „nepavyko atidaryti". Win32 sėkme laikome tai, ką realiai galime patikrinti:
    // katalogas egzistuoja (spawn'ą jau bandėme; explorer.exe Windows'e visada yra).
    // POSIX pusėje `open`/`xdg-open` exit kodas teisingas ir lieka autoritetas.
    if (process.platform !== "win32") return launched;
    return (await nodeFsAdapter.statPath(absolutePath)).kind === "directory";
  },
};

/**
 * Eilutė, kurią `setWorktreePolicyEnabled` prideda įjungdamas politiką. Čia ji NEBĖRA „padengta"
 * apibrėžimas — tik DIAGNOSTIKOS raktas: leidžia atskirti „eilutės faile nėra" nuo „eilutė yra,
 * bet git jos nemato" (pvz. priekinis tarpas, kurį git vertina pažodžiui).
 */
const WORKTREE_GITIGNORE_LINE = ".ag/worktrees/";

function looksLikeWorktreeGitignoreLine(content: string): boolean {
  return content.split(/\r?\n/).some((line) => line.trim() === WORKTREE_GITIGNORE_LINE);
}

/**
 * Ar worktree šaknis REALIAI ignoruojama. Tiesa viena ir ta pati visiems trims vartotojams —
 * `git check-ignore` per `worktreeRootIsIgnored`, tas pats predikatas, kuriuo remiasi
 * provisioning'as. Iki 112 čia buvo eilutės paieška su `trim()`, tad ` .ag/worktrees/` (priekinis
 * tarpas) UI'ui atrodė „padengta", o git tokio šablono netaiko ir provisioning'as krisdavo.
 *
 * Nesantis `.gitignore`, ne-git medis ar neveikiantis šablonas — visi `false` (nepadengta), ne
 * klaida. Kai git sako „ne", o eilutė faile vis dėlto yra, tai įvardijama žurnale: be to operatorius
 * matytų „nepadengta" prie akivaizdžiai teisingai atrodančio failo. `readTextFileIfExists` praleidžia
 * ENOENT/EISDIR/ENOTDIR; kitos skaitymo klaidos (pvz. teisių) MESTOS toliau — jas pagauna `readSource`
 * `ui-waves-view.ts` viduje ir degraduoja `worktree_gitignore` šaltinį, nepaliesdamas politikos.
 */
async function readWorktreeGitignoreOk(
  projectRoot: string,
  absoluteGitignoreFile: string,
  logError: (message: string) => void,
): Promise<boolean> {
  if (await worktreeRootIsIgnored(projectRoot)) return true;
  const content = await nodeFsAdapter.readTextFileIfExists(absoluteGitignoreFile);
  if (content !== undefined && looksLikeWorktreeGitignoreLine(content)) {
    logError(
      `worktree gitignore: '${WORKTREE_GITIGNORE_LINE}' eilutė yra ${absoluteGitignoreFile}, bet git jos netaiko (patikrink tarpus ir vėlesnius neigimo šablonus)`,
    );
  }
  return false;
}

/**
 * Worktree politikos PERJUNGIMO fs portai (`setWorktreePolicyEnabled`, 088-bb-03).
 *
 * Šis adapteris yra vien fs: abu keliai — konfigo ir `.gitignore` — gimsta use case'e iš
 * `runtimeRoot`/`projectRoot` ir ateina jau absoliutūs, tad čia NĖRA nė vienos kelio aritmetikos
 * eilutės ir nė vieno lauko iš request'o.
 *
 * Keturi sprendimai, kurie yra šio surišimo esmė:
 *
 *   1. `readConfigFile` — `readTextFile`, o NE `readTextFileIfExists`. Nesamas konfigas privalo
 *      kristi (maršrutas paverčia jį 500 su žurnalo eilute): tyliai grąžinus `{}`, rašymas
 *      sukurtų politiką iš nieko, o esami `root`/`branchPrefix` dingtų be pėdsako.
 *   2. `readGitignore` — priešingai, `readTextFileIfExists`. Repozitorija be `.gitignore` yra
 *      normali būsena, ir įjungimas ten teisingai sukuria failą su viena eilute (`undefined`
 *      use case'e virsta `""`), o ne 500.
 *   3. Idempotentiškumas gyvena use case'e (`ensureWorktreeRootIgnored`), ne čia: pakartotinis
 *      `enabled: true` iki `writeGitignore` net nedaeina, tad adapteris rašo tik tada, kai
 *      turinys tikrai keičiasi. Konfigo įrašymas irgi idempotentiškas — `writeTextFile` yra
 *      atominis pilnas perrašymas ta pačia serializacija.
 *   4. `rootIsIgnored` — TA PATI `worktreeRootIsIgnored` funkcija, kurią naudoja skaitymo pusė
 *      (`readWorktreeGitignoreOk` aukščiau) ir provisioning'as. Trys skirtingi „padengta"
 *      apibrėžimai buvo 112 radinys: perjungiklis grąžindavo `gitignore_ok: true` net tada, kai
 *      git šaknies neignoravo. Vienas predikatas vienoje vietoje yra visas to defekto taisymas.
 *
 * `log` eina į `logError`, nes kito kanalo `UiRouterAdapterInput` neturi. Tai sąmoninga: politikos
 * perjungimas yra retas operatoriaus veiksmas, kurio pėdsakas serverio žurnale vertingesnis už
 * kanalo grynumą.
 */
function worktreePolicyPorts(input: UiRouterAdapterInput): WorktreePolicyPorts {
  return {
    readConfigFile: (absolutePath) => nodeFsAdapter.readTextFile(absolutePath),
    writeConfigFile: (absolutePath, content) => nodeFsAdapter.writeTextFile(absolutePath, content),
    readGitignore: (absolutePath) => nodeFsAdapter.readTextFileIfExists(absolutePath),
    writeGitignore: (absolutePath, content) => nodeFsAdapter.writeTextFile(absolutePath, content),
    rootIsIgnored: (projectRoot) => worktreeRootIsIgnored(projectRoot),
    log: (message) => input.logError(message),
  };
}

/**
 * Bundle senumo faktai: `ui-app/dist/index.html` mtime prieš naujausią `ui-app/src` failo
 * mtime. Trūkstamas dist (dar nesukurtas bundle) grąžina `null`, o ne meta klaidą — `/api/dashboard`
 * tada tiesiog rodo `bundle_built_at: null` (žr. `bundleStalenessFields`), ne 500.
 */
function bundlePorts(projectRoot: string): { readFacts(): Promise<BundleMtimeFacts> } {
  return {
    readFacts: async (): Promise<BundleMtimeFacts> => {
      const bundleMtimeMs = await nodeFsAdapter.fileMtimeMs(path.join(projectRoot, "ui-app/dist/index.html"));
      if (bundleMtimeMs === undefined) return null;
      const srcMtimeMs = await nodeFsAdapter.newestMtimeInDir(path.join(projectRoot, "ui-app/src"));
      if (srcMtimeMs === undefined) return null;
      return { bundleMtimeMs, srcMtimeMs };
    },
  };
}

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
    bundle: bundlePorts(input.projectRoot),
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
          readWorktreePolicyEnabled: (absoluteConfigFile) =>
            loadWorktreePolicy(
              { readTextFileIfExists: (absolutePath) => nodeFsAdapter.readTextFileIfExists(absolutePath) },
              absoluteConfigFile,
            ).then((policy) => policy.enabled),
          readWorktreeGitignoreOk: (absoluteGitignoreFile) =>
            readWorktreeGitignoreOk(input.projectRoot, absoluteGitignoreFile, (message) => input.logError(message)),
          logError: (message) => input.logError(message),
        },
        projectRoot: input.projectRoot,
        runtimeRoot: input.runtimeRoot,
        eventLimit,
      }),

    // Surišta (ne `undefined`): be šio lauko `/api/runtime/worktree-policy` krenta į 404, ir
    // dashboard'o jungiklis neturėtų kur kreiptis. Skaitymo pusė (`readWorktreePolicyEnabled`
    // aukščiau) ir rašymo pusė remiasi TUO PAČIU `<runtimeRoot>/config/worktree-policy.json`.
    worktreePolicy: worktreePolicyPorts(input),

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
    // Komanda fiksuota `ui-rebuild.ts` (`UI_REBUILD_COMMAND`/`UI_REBUILD_ARGS`) — čia tik
    // proceso paleidimas ir tos pačios serializacijos grandinės perdavimas kaip loop startui.
    uiRebuild: {
      start: () => ensureUiRebuildRunning({ ports: uiRebuildProcessPorts(input), runtimeRoot: input.runtimeRoot }),
    },
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
