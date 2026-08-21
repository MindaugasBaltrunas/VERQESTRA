// `final-audit` portų surišimas (manual DI, LAY-2).
//
// Atskiras failas, nes ši komanda yra KOMPOZICIJA IŠ KOMPOZICIJŲ: ji suveda konvergenciją,
// pasirengimo auditą, backlog'ą, release-check, architektūros ribas, benchmark ir kompresijos
// įrodymus bei release proof į vieną verdiktą. Visos dedamosios ateina iš tų PAČIŲ adapterių,
// kuriuos naudoja atskiros komandos — antra kopija leistų `final-audit` pasakyti „viskas gerai"
// ten, kur `converge` ar `readiness-audit` sako priešingai.

import path from "node:path";
import {
  finalAuditResultPath,
  runFinalAudit,
  type FinalAuditCheck,
  type FinalAuditPorts,
  type FinalAuditResult,
  type ReleaseCheckState,
} from "../application/release-readiness/final-audit.js";
import { converge } from "../application/release-readiness/converge-check.js";
import { runReadinessAudit } from "../application/release-readiness/readiness-audit.js";
import { auditTaskStates, type BacklogAuditResult } from "../application/release-readiness/backlog-audit.js";
import { checkArchitectureBoundary } from "../application/release-readiness/architecture-boundary-check.js";
import {
  checkBenchmarkEvidence,
  describeBenchmarkEvidence,
} from "../application/release-readiness/benchmark-evidence-check.js";
import { checkCompressionQuality } from "../application/release-readiness/compression-quality-check.js";
import { describeCompressionQuality } from "../application/release-readiness/compression-quality-model.js";
import { releaseCheckResultPath, type ReleaseCheckFsPort } from "../application/release-readiness/release-check.js";
import { generateReleaseProof } from "../application/release-readiness/release-proof.js";
import { generateReleaseNotes } from "../application/release-readiness/release-notes.js";
import { countPendingProposals } from "../application/policy-governance/policy-proposals-log.js";
import { currentCommitResolver } from "../infrastructure/git/git-client.js";
import { nodeFsAdapter } from "../infrastructure/fs/node-fs-adapter.js";
import { readStateHistory, resolveHumanReviewStatus, stateHistoryPath } from "../infrastructure/state/state-history.js";
import { toPrettyJson, tryParseJson } from "../shared/json.js";
import { codeIntelligenceFs, policyConfigFs } from "./node-adapters.js";
import {
  backlogAuditPorts,
  contextPackFs,
  convergePorts,
  readinessPorts,
  readinessRequirements,
  releaseNotesPorts,
  releaseProofPorts,
} from "./readiness-adapters.js";

/**
 * Pasiūlymų žurnalo skaitymo pusė. Rašymo operacijos čia nereikalingos, bet portas jas
 * deklaruoja, tad paduodamos realios: siauresnis objektas nesutaptų su tipu, o `never`
 * stub'ai griūtų, jei skaitymo kelias kada nors pradėtų kurti katalogą.
 */
const policyProposalsFsView = {
  readTextFileIfExists: (absolutePath: string): Promise<string | undefined> =>
    nodeFsAdapter.readTextFileIfExists(absolutePath),
  appendTextFile: (absolutePath: string, text: string): Promise<void> =>
    nodeFsAdapter.appendTextFile(absolutePath, text),
  makeDirectory: (absoluteDir: string): Promise<void> => nodeFsAdapter.makeDirectory(absoluteDir),
};

/** Rekursyvus failų sąrašas absoliučiais keliais; katalogo nebuvimas — tuščias sąrašas. */
async function listFilesRecursive(absoluteDir: string): Promise<string[]> {
  const found: string[] = [];
  const queue = [absoluteDir];
  while (queue.length > 0) {
    const dir = queue.shift();
    if (dir === undefined) continue;
    for (const name of await nodeFsAdapter.listFiles(dir)) found.push(path.join(dir, name));
    for (const name of await nodeFsAdapter.listSubdirectories(dir)) queue.push(path.join(dir, name));
  }
  return found;
}

/** Release-check source-state FS portas: rekursyvus sąrašas plius trys skaitymai. */
export const releaseCheckFs: ReleaseCheckFsPort = {
  listFilesRecursive: (absoluteDir) => listFilesRecursive(absoluteDir),
  exists: (absolutePath) => nodeFsAdapter.exists(absolutePath),
  readTextFile: (absolutePath) => nodeFsAdapter.readTextFile(absolutePath),
  readTextFileIfExists: (absolutePath) => nodeFsAdapter.readTextFileIfExists(absolutePath),
};

/** Benchmark ir kompresijos vartų FS portas (statPath + skaitymai + katalogo vardai). */
const evidenceFs = {
  ...contextPackFs,
  statPath: (absolutePath: string) => nodeFsAdapter.statPath(absolutePath),
  readTextFile: (absolutePath: string) => nodeFsAdapter.readTextFile(absolutePath),
  listDirectory: (absoluteDir: string) => nodeFsAdapter.listDirectory(absoluteDir),
};

/** Readiness kategorijos suplojamos į `{area}:{item}` eilutes — tokia final-audit kalba. */
function flattenReadiness(result: Awaited<ReturnType<typeof runReadinessAudit>>): FinalAuditCheck {
  const issues: string[] = [];
  for (const [area, category] of Object.entries(result.categories)) {
    for (const item of category.missing) issues.push(`${area}:${item}`);
  }
  return { ok: result.status === "ok", issues };
}

/** Backlog radiniai gauna PREFIKSĄ: be jo trys skirtingi defektai raporte atrodytų vienodai. */
function flattenBacklog(result: BacklogAuditResult): FinalAuditCheck {
  const issues = [
    ...result.missing_categories.map((item) => `missing:${item}`),
    ...result.duplicate_numbers.map((item) => `duplicate:${item}`),
    ...result.out_of_order.map((item) => `out-of-order:${item.file}`),
  ];
  return { ok: issues.length === 0, issues };
}

export function finalAuditPorts(projectRoot: string, runtimeRoot: string, agRoot: string): FinalAuditPorts {
  const proof = releaseProofPorts(projectRoot, runtimeRoot, agRoot);

  return {
    listBucketFiles: async (bucket) => {
      const dir = path.join(agRoot, "tasks", bucket);
      const names = (await nodeFsAdapter.listMarkdownFiles(dir)).slice().sort();
      const files: { name: string; text: string }[] = [];
      for (const name of names) {
        const text = await nodeFsAdapter.readTextFileIfExists(path.join(dir, name));
        // Failas, kurio perskaityti nepavyko, PRALEIDŽIAMAS, o ne verčiamas tuščiu: tuščias
        // tekstas atrodytų kaip užduotis be turinio ir tyliai praeitų turinio vartus.
        if (text !== undefined) files.push({ name, text });
      }
      return files;
    },
    humanReviewResolved: async (taskId) =>
      resolveHumanReviewStatus(await readStateHistory(stateHistoryPath(runtimeRoot)), taskId) === "resolved",
    converge: () => converge(convergePorts, { projectRoot, runtimeRoot }),
    readiness: async () => flattenReadiness(await runReadinessAudit(readinessPorts, projectRoot, readinessRequirements)),
    backlog: async () => flattenBacklog(await auditTaskStates(backlogAuditPorts, path.join(agRoot, "tasks"))),
    readReleaseCheck: async (): Promise<ReleaseCheckState> => {
      const raw = await nodeFsAdapter.readTextFileIfExists(releaseCheckResultPath(runtimeRoot));
      if (raw === undefined) return {};
      const parsed = tryParseJson<ReleaseCheckState>(raw);
      // Sugadintas rezultatas laikomas NESAMU: tuščia būsena vartus palieka uždarytus, o
      // dalinai perskaitytas dokumentas galėtų atrodyti kaip praėjęs `status: "ok"`.
      return parsed.ok && parsed.value !== null && typeof parsed.value === "object" ? parsed.value : {};
    },
    newestMtime: (absolutePaths) => nodeFsAdapter.newestMtime(absolutePaths),
    newestMtimeInDir: (absoluteDir) => nodeFsAdapter.newestMtimeInDir(absoluteDir),
    policyFs: policyConfigFs,
    sourceFs: releaseCheckFs,
    pendingProposalCount: () => countPendingProposals(policyProposalsFsView, runtimeRoot),
    architectureBoundary: () =>
      checkArchitectureBoundary(codeIntelligenceFs(projectRoot), policyConfigFs, projectRoot, runtimeRoot),
    benchmarkEvidence: async () => {
      const result = await checkBenchmarkEvidence(evidenceFs, projectRoot, { currentAgCommit: currentCommitResolver });
      return { ok: result.ok, issues: result.issues, describe: describeBenchmarkEvidence(result) };
    },
    compressionQuality: async () => {
      const result = await checkCompressionQuality(evidenceFs, {
        projectRoot,
        runtimeRoot,
        currentAgCommit: currentCommitResolver,
      });
      return { ok: result.ok, issues: result.reasons.slice(), describe: describeCompressionQuality(result) };
    },
    releaseNotes: (now) => generateReleaseNotes(releaseNotesPorts(projectRoot, runtimeRoot), now),
    releaseProof: (options) => generateReleaseProof(proof, options),
    // Kelias imamas IS use case'o: jis pats iraso `report_path` i verdikta, tad antras,
    // adapteryje sugalvotas kelias reikstu raporta, rodanti ten, kur nieko nera.
    writeReport: (result: FinalAuditResult) =>
      nodeFsAdapter.writeTextFile(finalAuditResultPath(runtimeRoot), toPrettyJson(result)),
  };
}

export { runFinalAudit };
