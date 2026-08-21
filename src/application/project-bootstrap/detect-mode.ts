// Projekto režimo įrodymų rinkimas (etalonas: AG_loop orchestrator/runtime/project-mode.ts
// skeno pusė). Sprendimą priima GRYNAS domain `classifyProjectMode` — čia tik signalai.
//
// PASTABA (etalono elgesys, atkartotas): ši klasifikacija yra PATARIAMOJI. Nė vienas
// produkcinis kelias jos neskaito — ją mato tik rankinė `verqestra project-mode` komanda.
// Ypač `repair_project` NĖRA task lygio repair pipeline'as (tas gyvena diagnose/repair
// grandinėje su vq/supervisor/repair-task.md); čia tai tik signalas apie nutrauktus bucket'us.
//
// VERQESTRA skirtumai nuo etalono: visas IO — per portus; marker/source skenas ateina iš TŲ
// PAČIŲ `ProfileDetectionPorts`, kuriuos naudoja `detectProjectProfile` (FQC-12 — antra
// skeno kopija reikštų du atsakymus, kas yra „produkto įrodymas"); task bucket'ai ir openspec
// lieka `<root>/AG`, o būsena ir supervisor promptai — vq runtime šaknyje.

import path from "node:path";
import {
  classifyProjectMode,
  type ProjectModeDetection,
  type ProjectModeSignals,
} from "../../domain/project/index.js";
import type { ProfileDetectionPorts } from "./detect-profile.js";

// Re-eksportas application vardu, kad `interfaces/**` priklausytų nuo šio kontrakto, o ne
// siektų pro jį tiesiai į domain/project (ta pati taisyklė kaip DetectedProjectProfile).
export type { ProjectModeDetection, ProjectModeSignals };

export type ProjectModeDetectionPorts = ProfileDetectionPorts & {
  /** `.md` failų kiekis kataloge; nesamas katalogas — 0, ne klaida. */
  countMarkdownFiles(absoluteDir: string): Promise<number>;
  /** Poaplankių vardai (openspec change'ai); nesamas katalogas — []. */
  listSubdirectories(absoluteDir: string): Promise<string[]>;
  /** Failų vardai (repair promptai); nesamas katalogas — []. */
  listFiles(absoluteDir: string): Promise<string[]>;
  /** Failo tekstas arba `undefined`, kai failo nėra. */
  readTextFileIfExists(absolutePath: string): Promise<string | undefined>;
};

export type DetectProjectModeOptions = {
  projectRoot?: string;
  /** VERQESTRA runtime šaknis (vq/…). Default: `<projectRoot>/vq`. */
  runtimeRoot?: string;
};

/** Kiek source failų užtenka klasifikacijai — etalono riba (skenas ribotas sąmoningai). */
const SOURCE_FILE_SCAN_LIMIT = 20;

const INTERRUPTED_BUCKETS = ["active", "delegated", "error"] as const;

export async function detectProjectMode(
  ports: ProjectModeDetectionPorts,
  options: DetectProjectModeOptions = {},
): Promise<ProjectModeDetection> {
  const root = path.resolve(options.projectRoot ?? process.cwd());
  const agRoot = path.join(root, "AG");
  const runtimeRoot = options.runtimeRoot ?? path.join(root, "vq");

  const signals: ProjectModeSignals = {
    hasAgWorkspace: await ports.exists(agRoot),
    productMarkers: await ports.findProductMarkers(root),
    sourceFiles: await ports.findSourceFiles(root, SOURCE_FILE_SCAN_LIMIT),
    openSpecChanges: await findOpenSpecChanges(ports, agRoot),
    queuedTasks: await ports.countMarkdownFiles(path.join(agRoot, "tasks", "queue")),
    interruptedTasks: await countInterruptedTasks(ports, agRoot),
    humanReviewTasks: await ports.countMarkdownFiles(path.join(agRoot, "tasks", "human-review")),
    repairPrompts: await countRepairPrompts(ports, runtimeRoot),
  };

  return classifyProjectMode(signals);
}

/** Change'as skaitomas tik tada, kai turi bent vieną iš trijų dokumentų — tuščias katalogas nesiskaito. */
async function findOpenSpecChanges(ports: ProjectModeDetectionPorts, agRoot: string): Promise<string[]> {
  const changesRoot = path.join(agRoot, "openspec", "changes");
  const changes: string[] = [];
  for (const name of await ports.listSubdirectories(changesRoot)) {
    if (name === "archive") continue;
    const changeDir = path.join(changesRoot, name);
    const documents = await Promise.all([
      ports.exists(path.join(changeDir, "proposal.md")),
      ports.exists(path.join(changeDir, "spec.md")),
      ports.exists(path.join(changeDir, "tasks.md")),
    ]);
    if (documents.some(Boolean)) changes.push(`openspec/changes/${name}`);
  }
  return changes.sort();
}

async function countInterruptedTasks(ports: ProjectModeDetectionPorts, agRoot: string): Promise<number> {
  let count = 0;
  for (const bucket of INTERRUPTED_BUCKETS) {
    count += await ports.countMarkdownFiles(path.join(agRoot, "tasks", bucket));
  }
  return count;
}

async function countRepairPrompts(ports: ProjectModeDetectionPorts, runtimeRoot: string): Promise<number> {
  const prompts = await ports.listFiles(path.join(runtimeRoot, "state", "repair-prompts"));
  let count = prompts.length;
  // Legacy vieno prompto forma: skaičiuojama tik jei ji turi turinį — tuščias failas lieka
  // nuo ankstesnio ciklo ir neturi paversti projekto „remontuojamu".
  const legacy = await ports.readTextFileIfExists(path.join(runtimeRoot, "supervisor", "repair-task.md"));
  if ((legacy ?? "").trim().length > 0) count += 1;
  return count;
}
