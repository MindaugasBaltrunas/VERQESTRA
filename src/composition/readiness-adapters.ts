// Release-readiness ir ataskaitų klasterio adapteriai (manual DI, LAY-2).
//
// Atskirtas nuo `node-adapters.ts` dėl DYDŽIO vartų (≤500 eilučių) ir dėl to, kad šis klasteris
// turi vieną bendrą temą: „ar produktas pasiruošęs išleidimui" — auditas, konvergencija,
// įrodymo artefaktai ir ataskaitos. Priklausomybės kryptis viena: čia importuojama iš
// `node-adapters`, atgal — niekada.

import path from "node:path";
import type { BacklogAuditPorts } from "../application/release-readiness/backlog-audit.js";
import type { ConvergePorts } from "../application/release-readiness/converge-check.js";
import type { ReleaseNotesPorts } from "../application/release-readiness/release-notes.js";
import {
  readinessAuditResultPath,
  type ReadinessAuditResult,
  type ReadinessPorts,
  type ReadinessRequirements,
} from "../application/release-readiness/readiness-audit.js";
import {
  releaseProofMarkdownPath,
  releaseProofSummaryPath,
  type ReleaseProofData,
  type ReleaseProofPorts,
} from "../application/release-readiness/release-proof.js";
import {
  securityVerifyResultPath,
  type SecurityVerifyPorts,
  type SecurityVerifyResult,
} from "../application/quality-gates/security-verify.js";
import { loadGitAutomationPolicy } from "../application/policy-governance/git-automation-policy.js";
import { loadSecurityPolicy } from "../application/policy-governance/security-spec-policies.js";
import type { ContextPackFileSystemPort } from "../application/context-pack/ports.js";
import type { TaskBucket } from "../domain/tasks/buckets.js";
import type { AdapterCapabilityView } from "../interfaces/cli/reports/report.js";
import { listAdapterCapabilityDeclarations } from "../infrastructure/adapters/adapter-capabilities.js";
import { collectChangedFiles } from "../infrastructure/git/changed-files.js";
import { gitHead } from "../infrastructure/git/git-client.js";
import { nodeFsAdapter } from "../infrastructure/fs/node-fs-adapter.js";
import { toPrettyJson, tryParseJson } from "../shared/json.js";
import { policyConfigFs, taskLedgerStore } from "./node-adapters.js";

/** `backlog-audit`: tik katalogų skaitymas. */
export const backlogAuditPorts: BacklogAuditPorts = {
  listFiles: (absoluteDir) => nodeFsAdapter.listFiles(absoluteDir),
  readTextFileIfExists: (absolutePath) => nodeFsAdapter.readTextFileIfExists(absolutePath),
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

/** Bendras `vq`/`AG` skaitymo poaibis: naudoja `project-status` ir `report`. */
const readOnlyFs = {
  readTextFileIfExists: (absolutePath: string): Promise<string | undefined> =>
    nodeFsAdapter.readTextFileIfExists(absolutePath),
  listFiles: (absoluteDir: string): Promise<string[]> => nodeFsAdapter.listFiles(absoluteDir),
  listSubdirectories: (absoluteDir: string): Promise<string[]> => nodeFsAdapter.listSubdirectories(absoluteDir),
  writeTextFile: (absolutePath: string, text: string): Promise<void> =>
    nodeFsAdapter.writeTextFile(absolutePath, text),
};

/** Context-pack FS portas — `report` skaito kompresijos telemetriją tuo pačiu paviršiumi. */
export const contextPackFs: ContextPackFileSystemPort = {
  readTextFileIfExists: (absolutePath) => nodeFsAdapter.readTextFileIfExists(absolutePath),
  readFileBytes: (absolutePath) => nodeFsAdapter.readFileBytes(absolutePath),
  exists: (absolutePath) => nodeFsAdapter.exists(absolutePath),
  appendTextFile: (absolutePath, text) => nodeFsAdapter.appendTextFile(absolutePath, text),
  writeTextFile: (absolutePath, content) => nodeFsAdapter.writeTextFile(absolutePath, content),
  makeDirectory: (absoluteDir) => nodeFsAdapter.makeDirectory(absoluteDir),
};

/**
 * Release proof: git HEAD, sunumeruotų task'ų kiekiai ir du artefaktai.
 *
 * Skaičiuojami TIK numeruoti failai (`0042.md`): pavyzdžiai ir juodraščiai nėra darbo apimtis,
 * o įrodymas, kuriame jie skaičiuojami, meluotų apie eilės dydį.
 */
export function releaseProofPorts(projectRoot: string, runtimeRoot: string, agRoot: string): ReleaseProofPorts {
  return {
    gitHead: () => gitHead(projectRoot),
    countNumberedTasks: async (bucket: TaskBucket) => {
      const files = await nodeFsAdapter.listMarkdownFiles(path.join(agRoot, "tasks", bucket));
      return files.filter((name) => /^\d+/.test(name)).length;
    },
    writeSummary: (data: ReleaseProofData) =>
      nodeFsAdapter.writeTextFile(releaseProofSummaryPath(runtimeRoot), toPrettyJson(data)),
    writeMarkdown: (text: string) => nodeFsAdapter.writeTextFile(releaseProofMarkdownPath(runtimeRoot), text),
    readSummary: async () => {
      const raw = await nodeFsAdapter.readTextFileIfExists(releaseProofSummaryPath(runtimeRoot));
      if (raw === undefined) return undefined;
      const parsed = tryParseJson<ReleaseProofData>(raw);
      return parsed.ok ? parsed.value : undefined;
    },
  };
}

/** `project-status`: skaitymas, release proof ir git HEAD. */
export function projectStatusFs(): typeof readOnlyFs {
  return readOnlyFs;
}

/** `report` adapterių deklaracijos — struktūrinis susiaurinimas iki to, ką ataskaita rodo. */
export function adapterCapabilityViews(): AdapterCapabilityView[] {
  return listAdapterCapabilityDeclarations().map((declaration) => ({
    adapter: declaration.adapter,
    summary: declaration.summary,
    implemented: declaration.implemented.map((feature) => ({ feature: feature.feature })),
    future: declaration.future.map((feature) => ({ feature: feature.feature })),
  }));
}
