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
import type { BacklogAuditPorts } from "../application/release-readiness/backlog-audit.js";
import type { ReleaseNotesPorts } from "../application/release-readiness/release-notes.js";
import { loadGitAutomationPolicy } from "../application/policy-governance/git-automation-policy.js";
import { loadSecurityPolicy } from "../application/policy-governance/security-spec-policies.js";
import {
  securityVerifyResultPath,
  type SecurityVerifyPorts,
  type SecurityVerifyResult,
} from "../application/quality-gates/security-verify.js";
import type { ConvergePorts } from "../application/release-readiness/converge-check.js";
import {
  readinessAuditResultPath,
  type ReadinessAuditResult,
  type ReadinessPorts,
  type ReadinessRequirements,
} from "../application/release-readiness/readiness-audit.js";
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
import { collectChangedFiles } from "../infrastructure/git/changed-files.js";
import { gitStatus as gitStatusPlain } from "../infrastructure/git/git-client.js";
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

/** `backlog-audit`: tik katalogų skaitymas. */
export const backlogAuditPorts: BacklogAuditPorts = {
  listFiles: (absoluteDir) => nodeFsAdapter.listFiles(absoluteDir),
  readTextFileIfExists: (absolutePath) => nodeFsAdapter.readTextFileIfExists(absolutePath),
};

const policyConfigFs = {
  readTextFileIfExists: (absolutePath: string): Promise<string | undefined> =>
    nodeFsAdapter.readTextFileIfExists(absolutePath),
};

/**
 * `security-verify`: politika, pakeisti failai ir rezultato įrašas.
 *
 * `readTextFile` čia META, kai failo perskaityti negalima — ir tai sąmoninga: saugumo patikra,
 * tyliai praleidusi failą, kurio neperskaitė, būtų blogesnė nei jokia patikra.
 */
export function securityVerifyPorts(projectRoot: string, runtimeRoot: string): SecurityVerifyPorts {
  return {
    loadPolicy: () => loadSecurityPolicy(policyConfigFs, runtimeRoot),
    changedFiles: () => collectChangedFiles(projectRoot, runtimeRoot),
    readTextFile: (absolutePath) => nodeFsAdapter.readTextFile(absolutePath),
    writeResult: (result: SecurityVerifyResult) =>
      nodeFsAdapter.writeTextFile(securityVerifyResultPath(runtimeRoot), toPrettyJson(result)),
  };
}

/** `release-notes`: politika, ledger'is, dvi būsenos ir vienas rašymas. */
export function releaseNotesPorts(projectRoot: string, runtimeRoot: string): ReleaseNotesPorts {
  const readTrimmed = async (absolutePath: string): Promise<string> =>
    ((await nodeFsAdapter.readTextFileIfExists(absolutePath)) ?? "").trim();

  return {
    loadPolicy: async () => {
      const policy = await loadGitAutomationPolicy(policyConfigFs, runtimeRoot);
      return {
        release_notes_after_final_audit: policy.release_notes_after_final_audit,
        release_notes_path: policy.release_notes_path,
      };
    },
    // Ledger'io įrašo forma sutampa su release-notes laukiama — bendras `TaskLedgerEntry`.
    readTaskLedger: () => taskLedgerStore(runtimeRoot).read(),
    readReleaseCheckStatus: async () => {
      const raw = await nodeFsAdapter.readTextFileIfExists(
        path.join(runtimeRoot, "state", "release-check-result.json"),
      );
      if (raw === undefined) return "missing";
      const parsed = tryParseJson<{ status?: unknown }>(raw);
      return parsed.ok && typeof parsed.value.status === "string" ? parsed.value.status : "missing";
    },
    readProjectStatus: () => readTrimmed(path.join(runtimeRoot, "project", "status.md")),
    writeNotes: (relativePath, text) => nodeFsAdapter.writeTextFile(path.resolve(projectRoot, relativePath), text),
  };
}

/**
 * Task būsenos saugykla. Nuosavybės vartai kol kas NEPRIJUNGTI: juos suriš loop dalis, kuri turi
 * lease kontekstą. CLI kelias (`task-move`, `requeue`) yra rankinis operatoriaus veiksmas — jam
 * etalonas irgi taiko tik failų lygio serializaciją.
 */
export function taskStateStore(agRoot: string, runtimeRoot: string): ReturnType<typeof createTaskStateStore> {
  return createTaskStateStore({ agRoot, runtimeRoot });
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

/** `converge`: tik skaitymas plius mtime. */
export const convergePorts: ConvergePorts = {
  readTextFileIfExists: (absolutePath) => nodeFsAdapter.readTextFileIfExists(absolutePath),
  listSubdirectories: (absoluteDir) => nodeFsAdapter.listSubdirectories(absoluteDir),
  listFiles: (absoluteDir) => nodeFsAdapter.listFiles(absoluteDir),
  fileMtimeMs: (absolutePath) => nodeFsAdapter.fileMtimeMs(absolutePath),
};

/** `readiness-audit`: dvi skaitymo operacijos, verdiktas rašomas atskirai. */
export const readinessPorts: ReadinessPorts = {
  // `statKind` grąžina ir `other` (symlink, socket); auditui tai NE reikalavimo tenkinimas.
  statKind: async (absolutePath) => {
    const kind = await nodeFsAdapter.statKind(absolutePath);
    return kind === "file" || kind === "directory" ? kind : "absent";
  },
  readTextFileIfExists: (absolutePath) => nodeFsAdapter.readTextFileIfExists(absolutePath),
};

/**
 * VERQESTRA pasirengimo reikalavimai. Sąrašas SĄMONINGAI aprašo TIKSLINĮ produkto vaizdą, o ne
 * dabartinį migracijos pjūvį: auditas turi sakyti „dar ne", kol ko nors trūksta — priešingu
 * atveju jis tik patvirtintų tai, kas jau yra.
 *
 * Skirtumas nuo etalono yra tik keliai: sluoksniai gyvena `src/*`, konfigai — `vq/config`
 * (o ne `AG/config`), o komandų registras yra `src/composition/cli-registry.ts`.
 */
export const readinessRequirements: ReadinessRequirements = {
  folders: [
    "src/domain",
    "src/application",
    "src/infrastructure",
    "src/interfaces",
    "src/composition",
    "src/tests",
    "AG/spec",
    "AG/openspec",
    "AG/tasks/queue",
    "docs",
  ],
  configs: [
    "vq/config/context-budget.json",
    "vq/config/model-policy.json",
    "vq/config/quality-policy.json",
    "vq/config/security-policy.json",
    "vq/config/spec-policy.json",
    "vq/config/tool-budget.json",
  ],
  tests: [
    "src/tests/architecture-gates.test.ts",
    "src/tests/composition-cli.test.ts",
    "src/tests/cli-exit-contracts.test.ts",
  ],
  docs: ["README.md", "docs/getting-started.md", "docs/spec-workflow.md", "docs/context-pack.md", "docs/release.md"],
  commandSources: ["src/composition/cli-registry.ts", "src/cli.ts"],
};

/** `readiness-audit` verdikto rašymas — atominis: pusiau įrašytas verdiktas yra blogesnis nei joks. */
export function writeReadinessResult(runtimeRoot: string): (result: ReadinessAuditResult) => Promise<void> {
  return (result) => nodeFsAdapter.writeTextFileAtomic(readinessAuditResultPath(runtimeRoot), toPrettyJson(result));
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
