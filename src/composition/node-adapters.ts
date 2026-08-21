// Vienintelė vieta, kur application/interfaces portai surišami su REALIAIS Node adapteriais
// (manual DI, LAY-2). Jokios verslo logikos: tik pervadinimai ir siaurinimai.
//
// Kodėl adapteriai surišami ČIA, o ne portų deklaravimo vietoje: portas yra kvietėjo poreikis, o
// adapteris — infrastruktūros galimybė. Kai jie sutampa vardais, pervadinimo eilutės nėra; kai
// nesutampa (`rename` vs `renamePath`), skirtumas matomas vienoje eilutėje, o ne pasislepia
// adapteryje.

import path from "node:path";
import type { LearningFsPort } from "../application/learning/ports.js";
import type { JsonSchemaExportPorts } from "../application/policy-governance/json-schema-export.js";
import type { ApiContractExportPorts } from "../application/task-planning/api-contract-export.js";
import type { OpenSpecReconcileFsPort } from "../application/task-execution/openspec-reconcile.js";
import { taskLedgerPath } from "../application/task-execution/task-ledger-rules.js";
import type { TaskLedgerEntry } from "../application/task-execution/task-ledger-rules.js";
import type { TaskLedgerStorePort } from "../application/task-execution/task-ledger-service.js";
import { toPrettyJson, tryParseJson } from "../shared/json.js";
import type { BlockedTaskRoutingPorts, BucketTaskFile } from "../application/task-execution/task-graph-import.js";
import type { TaskBucket } from "../domain/tasks/buckets.js";
import type { PolicyProposalsFsPort } from "../application/policy-governance/policy-proposals-log.js";
import type { AgentCommandPorts } from "../interfaces/cli/admin/agent.js";
import type { PolicyCommandPorts } from "../interfaces/cli/admin/policy.js";
import type { PlanPorts } from "../application/task-planning/plan.js";
import type { TaskGeneratePorts } from "../application/task-planning/generate.js";
import { specDriftResultPath, type SpecDriftPorts, type SpecDriftResult } from "../application/quality-gates/spec-drift.js";
import { loadSpecPolicy } from "../application/policy-governance/security-spec-policies.js";
import { tokenAnalyticsSnapshotPath } from "../application/learning/token-analytics-snapshot.js";
import type { TokenAnalyticsSnapshot } from "../application/learning/token-analytics-snapshot.js";
import type { StatusPorts, StatusStopEvidenceView } from "../interfaces/cli/admin/status.js";
import type { CodeIntelligenceFileSystemPort } from "../application/code-intelligence/ports.js";
import { createCodeIntelligenceFsAdapter } from "../infrastructure/fs/code-intelligence-fs-adapter.js";
import { collectChangedFiles } from "../infrastructure/git/changed-files.js";
import { gitHead, gitStatus as gitStatusPlain } from "../infrastructure/git/git-client.js";
import { noRuntimeAttemptResolution } from "../infrastructure/state/attempt-resolution.js";
import { readStopEvidence } from "../infrastructure/state/stop-evidence.js";
import { ensureRuntimeDirs } from "../infrastructure/state/runtime-dirs.js";
import { createTaskStateStore } from "../infrastructure/state/task-state-store.js";
import { createTokenBudgetGatePorts } from "../infrastructure/state/token-budget-gate-ports.js";
import { nodeFsAdapter } from "../infrastructure/fs/node-fs-adapter.js";

/** `export-json-schema` portas: vienintelis rašymas, visada atominis. */
export const jsonSchemaExportPorts: JsonSchemaExportPorts = {
  writeTextFile: (absolutePath, text) => nodeFsAdapter.writeTextFile(absolutePath, text),
};

/** `openspec-reconcile` portas: archyvavimas plius katalogų enumeracija. */
export const openSpecReconcileFs: OpenSpecReconcileFsPort = {
  exists: (absolutePath) => nodeFsAdapter.exists(absolutePath),
  readTextFileIfExists: (absolutePath) => nodeFsAdapter.readTextFileIfExists(absolutePath),
  writeTextFileAtomic: (absolutePath, content) => nodeFsAdapter.writeTextFileAtomic(absolutePath, content),
  makeDirectory: (absoluteDir) => nodeFsAdapter.makeDirectory(absoluteDir),
  // Portas prašo `rename`, adapteris siūlo `renamePath` su win32 contention retry — skirtumas
  // lieka matomas čia, o ne paslėptas adapteryje.
  rename: (fromPath, toPath) => nodeFsAdapter.renamePath(fromPath, toPath),
  listSubdirectories: (absoluteDir) => nodeFsAdapter.listSubdirectories(absoluteDir),
  listFiles: (absoluteDir) => nodeFsAdapter.listFiles(absoluteDir),
};

/** Learning atmintis: skaitymas plius append/write su katalogo sukūrimu. */
export const learningFs: LearningFsPort = {
  readTextFileIfExists: (absolutePath) => nodeFsAdapter.readTextFileIfExists(absolutePath),
  appendTextFile: (absolutePath, text) => nodeFsAdapter.appendTextFile(absolutePath, text),
  writeTextFile: (absolutePath, content) => nodeFsAdapter.writeTextFile(absolutePath, content),
  makeDirectory: (absoluteDir) => nodeFsAdapter.makeDirectory(absoluteDir),
};

/** `export-api-contract`: spec šaltinio skaitymas plius vienas rašymas. */
export const apiContractExportPorts: ApiContractExportPorts = {
  fs: {
    exists: (absolutePath) => nodeFsAdapter.exists(absolutePath),
    readTextFileIfExists: (absolutePath) => nodeFsAdapter.readTextFileIfExists(absolutePath),
    listSubdirectories: (absoluteDir) => nodeFsAdapter.listSubdirectories(absoluteDir),
  },
  writeTextFile: (absolutePath, text) => nodeFsAdapter.writeTextFile(absolutePath, text),
};

/**
 * Task ledger'io saugykla. Serializacija (`toPrettyJson`) lieka ČIA, o ne adapteryje: baitinis
 * on-disk formatas yra kontraktas, kurį skaito ir kiti procesai.
 *
 * Sugadintas ledger'is grąžinamas kaip TUŠČIAS, o ne meta: `sync` komanda tokiu atveju jį
 * perrašo teisinga forma, o griuvimas paliktų operatorių be vienintelio įrankio, kuris tai taiso.
 */
export function taskLedgerStore(runtimeRoot: string): TaskLedgerStorePort {
  const file = taskLedgerPath(runtimeRoot);
  return {
    exists: () => nodeFsAdapter.exists(file),
    read: async () => {
      const raw = await nodeFsAdapter.readTextFileIfExists(file);
      if (raw === undefined) return {};
      const parsed = tryParseJson<unknown>(raw);
      if (!parsed.ok || parsed.value === null || typeof parsed.value !== "object" || Array.isArray(parsed.value)) {
        return {};
      }
      return parsed.value as Record<string, TaskLedgerEntry>;
    },
    write: (ledger) => nodeFsAdapter.writeTextFile(file, toPrettyJson(ledger)),
  };
}

/** Politikos konfigų skaitymas — bendras kelioms komandoms, tad eksportuojamas. */
export const policyConfigFs = {
  readTextFileIfExists: (absolutePath: string): Promise<string | undefined> =>
    nodeFsAdapter.readTextFileIfExists(absolutePath),
};

/**
 * Task būsenos saugykla. Nuosavybės vartai kol kas NEPRIJUNGTI: juos suriš loop dalis, kuri turi
 * lease kontekstą. CLI kelias (`task-move`, `requeue`) yra rankinis operatoriaus veiksmas — jam
 * etalonas irgi taiko tik failų lygio serializaciją.
 */
export function taskStateStore(agRoot: string, runtimeRoot: string): ReturnType<typeof createTaskStateStore> {
  return createTaskStateStore({ agRoot, runtimeRoot });
}

/** Projekto HEAD; `undefined` ne-git medyje (nebuvimas — atsakymas, ne klaida). */
export function gitHeadForProject(projectRoot: string): Promise<string | undefined> {
  return gitHead(projectRoot);
}

/** `true`, kai kelias egzistuoja IR yra failas (ne katalogas, ne symlink į katalogą). */
export function isFile(absolutePath: string): Promise<boolean> {
  return nodeFsAdapter.statKind(absolutePath).then((kind) => kind === "file");
}

/** Biudžeto vartų portai — runtime šaknis pakuojama fabrike. */
export const tokenBudgetPorts = createTokenBudgetGatePorts;

/** `plan`: spec šaltinio skaitymas plius vienas rašymas su tėviniais katalogais. */
export const planPorts: PlanPorts = {
  fs: {
    exists: (absolutePath) => nodeFsAdapter.exists(absolutePath),
    readTextFileIfExists: (absolutePath) => nodeFsAdapter.readTextFileIfExists(absolutePath),
    listSubdirectories: (absoluteDir) => nodeFsAdapter.listSubdirectories(absoluteDir),
  },
  writeTextFile: (absolutePath, text) => nodeFsAdapter.writeTextFile(absolutePath, text),
};

/**
 * `task-generate`: spec skaitymas plius `wx` rašymas.
 *
 * `writeFileExclusive` čia yra KONTRAKTAS, ne optimizacija: pakartotinis generavimas negali
 * perrašyti eilėje jau gulinčio (galbūt jau redaguoto) task'o failo.
 */
export const taskGeneratePorts: TaskGeneratePorts = {
  fs: {
    exists: (absolutePath) => nodeFsAdapter.exists(absolutePath),
    readTextFileIfExists: (absolutePath) => nodeFsAdapter.readTextFileIfExists(absolutePath),
    listSubdirectories: (absoluteDir) => nodeFsAdapter.listSubdirectories(absoluteDir),
    makeDirectory: (absoluteDir) => nodeFsAdapter.makeDirectory(absoluteDir),
    writeFileExclusive: (absolutePath, content) => nodeFsAdapter.writeFileExclusive(absolutePath, content),
    listFiles: (absoluteDir) => nodeFsAdapter.listFiles(absoluteDir),
  },
};

/**
 * `spec-drift`: politikos vartas, spec change įrašas, pakeisti failai ir rezultatas.
 *
 * Trūkstamas spec change META (o ne grąžina tuščią scope): tuščias scope reikštų „viskas už
 * ribų" ir vartai kristų su neteisinga priežastimi.
 */
export function specDriftPorts(projectRoot: string, runtimeRoot: string): SpecDriftPorts {
  return {
    assertSpecPolicy: async () => {
      await loadSpecPolicy(policyConfigFs, runtimeRoot);
    },
    readSpecChange: async (changeId: string) => {
      const file = path.join(projectRoot, "AG", "spec", "changes", changeId, "spec.json");
      const raw = await nodeFsAdapter.readTextFileIfExists(file);
      if (raw === undefined) throw new Error(`Spec change not found: ${changeId}`);
      const parsed = tryParseJson<unknown>(raw);
      // Sugadintas spec.json irgi meta: nešvarus scope duotų tylų „ok" verdiktą.
      if (!parsed.ok || parsed.value === null || typeof parsed.value !== "object") {
        throw new Error(`Spec change unreadable: ${changeId}`);
      }
      return parsed.value;
    },
    changedFiles: () => collectChangedFiles(projectRoot, runtimeRoot),
    writeResult: (result: SpecDriftResult) =>
      nodeFsAdapter.writeTextFile(specDriftResultPath(runtimeRoot), toPrettyJson(result)),
  };
}

/**
 * `status`: TIK skaitantis paviršius plius `ensureDirs`.
 *
 * Stop įrodymas imamas be attempt rezoliucijos (`noRuntimeAttemptResolution`), kol loop
 * kompozicija (E5 likutis) atneša pilną resolverį — statusas tuomet mato legacy veidrodį ir
 * SAKO tai `origin` lauke, o ne apsimeta, kad įrodymo nėra.
 */
export function statusPorts(projectRoot: string, runtimeRoot: string, agRoot: string): StatusPorts {
  return {
    ensureDirs: () => ensureRuntimeDirs(agRoot, runtimeRoot),
    countMarkdownFiles: async (absoluteDir) => (await nodeFsAdapter.listMarkdownFiles(absoluteDir)).length,
    listMarkdownFiles: (absoluteDir) => nodeFsAdapter.listMarkdownFiles(absoluteDir),
    readTextFileIfExists: (absolutePath) => nodeFsAdapter.readTextFileIfExists(absolutePath),
    readStopEvidence: async (taskId: string): Promise<StatusStopEvidenceView> => {
      const evidence = await readStopEvidence({
        runtimeRoot,
        resolution: noRuntimeAttemptResolution,
        taskId,
      });
      return {
        origin: evidence.origin,
        ...(evidence.status === undefined ? {} : { status: evidence.status }),
        ...(evidence.reason === undefined ? {} : { reason: evidence.reason }),
        corrupted: evidence.corrupted,
      };
    },
    readTokenAnalytics: async (): Promise<TokenAnalyticsSnapshot | null> => {
      const raw = await nodeFsAdapter.readTextFileIfExists(tokenAnalyticsSnapshotPath(runtimeRoot));
      if (raw === undefined) return null;
      const parsed = tryParseJson<TokenAnalyticsSnapshot>(raw);
      // Sugadintas snapshot'as statuso NEGRIAUNA: analitika yra papildoma, ne pagrindinė eilutė.
      return parsed.ok ? parsed.value : null;
    },
    gitStatus: () => gitStatusPlain(projectRoot),
  };
}

const policyProposalsFs: PolicyProposalsFsPort = {
  readTextFileIfExists: (absolutePath) => nodeFsAdapter.readTextFileIfExists(absolutePath),
  appendTextFile: (absolutePath, text) => nodeFsAdapter.appendTextFile(absolutePath, text),
  makeDirectory: (absoluteDir) => nodeFsAdapter.makeDirectory(absoluteDir),
};

/** `policy`: konfigų skaitymas plius pasiūlymų žurnalo append. */
export const policyCommandPorts: PolicyCommandPorts = {
  configFs: policyConfigFs,
  proposalsFs: policyProposalsFs,
};

/**
 * `agent`: personų failai ir agentų registras.
 *
 * `readTextFile` META, kai `--from` šaltinio nėra: tyliai praleista persona duotų registrą,
 * rodantį agentą, kurio instrukcijų nėra.
 */
export const agentCommandPorts: AgentCommandPorts = {
  policyFs: policyConfigFs,
  listPersonaFiles: (absoluteDir) => nodeFsAdapter.listFiles(absoluteDir),
  readTextFile: (absolutePath) => nodeFsAdapter.readTextFile(absolutePath),
  writeTextFile: (absolutePath, content) => nodeFsAdapter.writeTextFile(absolutePath, content),
  writeJsonFile: (absolutePath, value) => nodeFsAdapter.writeTextFileAtomic(absolutePath, toPrettyJson(value)),
  removeFile: (absolutePath) => nodeFsAdapter.removeFile(absolutePath),
  exists: (absolutePath) => nodeFsAdapter.exists(absolutePath),
};


/**
 * `task-dependencies`: bucket'ų skaitymas plius blocked maršrutizavimas.
 *
 * `moveToHumanReview` eina per TĄ PAČIĄ task būsenos saugyklą kaip ir loop'as — kitaip rankinis
 * escape hatch judintų failus be lock'o, lygiagrečiai su dispatch'u.
 */
export function blockedTaskRoutingPorts(projectRoot: string, agRoot: string, runtimeRoot: string): BlockedTaskRoutingPorts {
  const store = createTaskStateStore({ agRoot, runtimeRoot });
  const tasksDir = (bucket: string): string => path.join(agRoot, "tasks", bucket);
  const absolute = (file: string): string => (path.isAbsolute(file) ? file : path.join(projectRoot, file));

  return {
    listTasksInBucket: async (bucket: TaskBucket): Promise<BucketTaskFile[]> => {
      const dir = tasksDir(bucket);
      // Vardų tvarka yra KONTRAKTAS: nuo jos priklauso grafo hash'o determinizmas.
      const names = (await nodeFsAdapter.listMarkdownFiles(dir)).slice().sort();
      const files: BucketTaskFile[] = [];
      for (const name of names) {
        const text = await nodeFsAdapter.readTextFileIfExists(path.join(dir, name));
        if (text === undefined) continue;
        files.push({ file: `AG/tasks/${bucket}/${name}`, text });
      }
      return files;
    },
    readTaskText: (file) => nodeFsAdapter.readTextFile(absolute(file)),
    writeTaskText: (file, text) => nodeFsAdapter.writeTextFile(absolute(file), text),
    moveToHumanReview: async (file) => {
      const from = absolute(file);
      const moved = await store.moveTaskState(from, tasksDir("human-review"), path.basename(from), {
        updateCurrent: false,
      });
      return path.relative(projectRoot, moved).split(path.sep).join("/");
    },
  };
}

/**
 * Code-intelligence FS portas (indeksas, grafas, architektūros ribos).
 *
 * Delegavimas, o ne sava kopija: `createCodeIntelligenceFsAdapter` yra ŠAKNIES APIMTIES ir
 * kiekvieną kelią tikrina per `project-containment` (leksinė patikra plius `realpath`) PRIEŠ
 * skaitymą. Sava, „paprastesnė" implementacija tą symlink'o vartą tyliai pašalintų — o būtent
 * šio porto turinys eina TIESIAI į LLM promptą ir į context cache.
 */
export function codeIntelligenceFs(projectRoot: string): CodeIntelligenceFileSystemPort {
  return createCodeIntelligenceFsAdapter(projectRoot);
}
