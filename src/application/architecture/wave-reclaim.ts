// Wave variklio reclaim pusė (etalonas: AG_loop architecture/architecture-wave.ts
// reclaim blokai, WBR VQ-501 3/5-d): external/input mazgų normalizacija (895) ir
// evidence-less sintezuotų taskų atstatymas (2026-07-19 run-tree incidentai). Bendri
// helper'iai (state dir, saugus task vardas, šalinimas per visus lifecycle bucket'us,
// tolerantiškas progress skaitymas) gyvena čia — juos vartoja ir task-sync, ir wave.

import path from "node:path";
import type { ArchitectureGraph, ArchitectureProgress } from "../../domain/architecture/graph.js";
import {
  classifyInputSourceNodes,
  inputSourceClassificationChanged,
} from "../../domain/architecture/input-source-classification.js";
import type { ArchitectureWaveFsPort, ArchitectureWavePorts } from "./ports.js";

export function architectureStateDir(projectRoot: string): string {
  return path.join(projectRoot, "vq", "state", "architecture");
}

/** Tolerantiškas progress skaitymas: nesamas ARBA sugadintas failas → null (etalono catch). */
export async function readProgressSafe(
  fs: ArchitectureWaveFsPort,
  progressPath: string,
): Promise<ArchitectureProgress | null> {
  try {
    const raw = await fs.readTextFileIfExists(progressPath);
    if (raw === undefined) return null;
    return JSON.parse(raw) as ArchitectureProgress;
  } catch {
    return null;
  }
}

/** Grafo skaitymas: nesamas failas → null; sugadintas JSON — klaida (etalono readGraph). */
export async function readGraphFile(
  fs: ArchitectureWaveFsPort,
  graphPath: string,
): Promise<ArchitectureGraph | null> {
  const raw = await fs.readTextFileIfExists(graphPath);
  if (raw === undefined) return null;
  return JSON.parse(raw) as ArchitectureGraph;
}

// Lifecycle bucket'ai, kuriuose gali gulėti jau-dispatch'intas sintezuotas taskas.
// `done` sąmoningai neįtrauktas — tai užbaigtų taskų istorija, jos reclaim neliečia.
export const LIFECYCLE_TASK_BUCKETS = ["queue", "delegated", "active", "human-review", "error"] as const;

/** Saugus task failo vardas: be kelio separatorių, tik `<id>.md` forma. */
export function safeTaskBaseName(rel: string): string | null {
  const baseName = rel.replace(/\\/g, "/").split("/").pop() ?? "";
  return /^[A-Za-z0-9._-]+\.md$/.test(baseName) ? baseName : null;
}

/**
 * Pašalina sintezuotą task failą iš visų lifecycle bucket'ų (queue/delegated/active/
 * human-review/error). Reikalinga, nes progress.json fiksuoja tik pradinį
 * `AG/tasks/queue/...` kelią, o loop'as failą kilnoja tarp bucket'ų nekeisdamas vardo —
 * ankstesnis reclaim matė tik queue ir jau dispatch'intas malformed taskas likdavo
 * gulėti human-review/delegated amžinai (2026-07-19 run-tree-X incidentas).
 */
export async function removeSynthesizedTaskAcrossBuckets(
  fs: ArchitectureWaveFsPort,
  projectRoot: string,
  baseName: string,
): Promise<string[]> {
  const removed: string[] = [];
  for (const bucket of LIFECYCLE_TASK_BUCKETS) {
    const absPath = path.join(projectRoot, "AG", "tasks", bucket, baseName);
    if (await fs.exists(absPath)) {
      await fs.removeFile(absPath);
      removed.push(`AG/tasks/${bucket}/${baseName}`);
    }
  }
  return removed;
}

export type ExternalInputReclaimResult = {
  /** External mazgai, kurių pasenusi progreso būsena (queued/human-review/…) buvo normalizuota. */
  nodes: string[];
  /** Pašalinti pasenę task failai (bet kuriame lifecycle bucket'e), sukurti external mazgams dar prieš klasifikaciją. */
  removedQueueTasks: string[];
};

/**
 * Task 895: deterministinė gryno input/external mazgo klasifikacija jau importuotam grafui.
 * Persistina `external`/`kind` vėliavas į graph.json (vienkartinė, idempotentiška migracija
 * pre-klasifikacijos grafams), pašalina tokiems mazgams dar-fabrikuotus queue taskus
 * (pvz. `run-tree-A-*.md` su išgalvotu `src/a.ts` scope) ir normalizuoja jų progreso
 * būseną atgal į "planned", kad wave juos skaičiuotų kaip satisfied, o ne human-review.
 * Kviečiama loop starte ir kiekvienos bangos pradžioje; be grafo — švarus no-op.
 */
export async function reclaimExternalInputNodes(
  ports: ArchitectureWavePorts,
  projectRoot: string,
): Promise<ExternalInputReclaimResult> {
  const result: ExternalInputReclaimResult = { nodes: [], removedQueueTasks: [] };
  const stateDir = architectureStateDir(projectRoot);
  const graphPath = path.join(stateDir, "graph.json");
  const progressPath = path.join(stateDir, "progress.json");

  const rawGraph = await readGraphFile(ports.fs, graphPath);
  if (!rawGraph) return result;
  const graph = classifyInputSourceNodes(rawGraph);
  if (inputSourceClassificationChanged(rawGraph, graph)) {
    await ports.fs.writeTextFile(graphPath, JSON.stringify(graph, null, 2));
  }

  const progress = await readProgressSafe(ports.fs, progressPath);
  if (!progress) return result;

  for (const node of graph.nodes) {
    if (node.external !== true) continue;
    const nodeProgress = progress.nodes[node.id];
    if (!nodeProgress) continue;
    // "planned" ir "done" paliekami; visos kitos būsenos external mazgui yra
    // pre-klasifikacijos artefaktas (queued/ready/repairing/human-review/active).
    const staleStatus = !["planned", "done"].includes(nodeProgress.status);
    const staleTaskNames = (nodeProgress.queued_tasks ?? [])
      .map(safeTaskBaseName)
      .filter((baseName): baseName is string => baseName !== null);
    if (!staleStatus && staleTaskNames.length === 0) continue;

    // Failas galėjo būti perkeltas iš queue į delegated/human-review dar prieš
    // klasifikaciją — šalinama iš visų lifecycle bucket'ų, ne tik queue.
    for (const baseName of staleTaskNames) {
      result.removedQueueTasks.push(...(await removeSynthesizedTaskAcrossBuckets(ports.fs, projectRoot, baseName)));
    }

    await ports.updateNodeProgress(
      progressPath,
      node.id,
      { ...(staleStatus ? { status: "planned" } : {}), queued_tasks: [] },
      staleStatus ? ["human_review_reason"] : [],
    );
    result.nodes.push(node.id);
  }

  return result;
}

export type EvidencelessReclaimResult = {
  /** Mazgai, kurių evidence-less sintezuoti taskai pašalinti, o būsena grąžinta į "planned". */
  nodes: string[];
  /** Faktiškai pašalinti task failai (repo-relative, su bucket'u, kuriame gulėjo). */
  removedTasks: string[];
};

/**
 * True, kai runId taskas buvo susintezuotas be jokio evidence įrašo. Pirminis šaltinis —
 * sintezės įrašas `vq/state/architecture/task-synthesis/<runId>.json` (`evidence_count`);
 * jam dingus sprendžiama iš paties task failo markerio, kurį renderina
 * task-synthesizer renderEvidenceBlock tuščiam evidence sąrašui.
 */
async function synthesizedWithoutEvidence(
  fs: ArchitectureWaveFsPort,
  projectRoot: string,
  runId: string,
  baseName: string,
): Promise<boolean> {
  const synthPath = path.join(architectureStateDir(projectRoot), "task-synthesis", `${runId}.json`);
  try {
    const raw = await fs.readTextFileIfExists(synthPath);
    if (raw !== undefined) {
      const record = JSON.parse(raw) as { evidence_count?: unknown };
      if (typeof record.evidence_count === "number") return record.evidence_count === 0;
    }
  } catch {
    // Sintezės įrašas sugadintas — krentama į task failo markerio patikrą žemiau.
  }
  for (const bucket of LIFECYCLE_TASK_BUCKETS) {
    const text = await fs.readTextFileIfExists(path.join(projectRoot, "AG", "tasks", bucket, baseName));
    if (text !== undefined) return text.includes("No evidence entries found");
  }
  return false;
}

/**
 * Evidence disciplinos atstatymas jau IŠLEISTIEMS taskams: wave gate (895) neleidžia
 * sintezuoti naujo tasko be evidence, bet iki jo suveikimo susintezuoti evidence-less
 * taskai (2026-07-19 run-tree-B/A1..A5 banga) lieka lifecycle bucket'uose — dispatch'as
 * juos dalina Claude sesijoms, o po blokavimo jie amžinai guli human-review. Šis
 * reclaim'as tokį taską pašalina iš bet kurio bucket'o ir mazgą grąžina į "planned":
 * stateless — evidence atsiradus kita banga mazgą susintezuoja normaliai, o be evidence
 * jis lieka matomas per wave `no_evidence` blokavimą su aiškia priežastimi.
 */
export async function reclaimEvidencelessSynthesizedTasks(
  ports: ArchitectureWavePorts,
  projectRoot: string,
): Promise<EvidencelessReclaimResult> {
  const result: EvidencelessReclaimResult = { nodes: [], removedTasks: [] };
  const progressPath = path.join(architectureStateDir(projectRoot), "progress.json");
  const progress = await readProgressSafe(ports.fs, progressPath);
  if (!progress) return result;

  for (const [nodeId, node] of Object.entries(progress.nodes)) {
    // "done" ir "planned" neliečiami: done — istorija, planned — nebeturi ko valyti.
    if (!["queued", "active", "repairing", "human-review"].includes(node.status)) continue;

    const staleRels: string[] = [];
    for (const rel of node.queued_tasks ?? []) {
      const baseName = safeTaskBaseName(rel);
      if (!baseName) continue;
      const runId = baseName.replace(/\.md$/, "");
      if (!(await synthesizedWithoutEvidence(ports.fs, projectRoot, runId, baseName))) continue;
      staleRels.push(rel);
      result.removedTasks.push(...(await removeSynthesizedTaskAcrossBuckets(ports.fs, projectRoot, baseName)));
    }
    if (staleRels.length === 0) continue;

    const remaining = (node.queued_tasks ?? []).filter((rel) => !staleRels.includes(rel));
    await ports.updateNodeProgress(
      progressPath,
      nodeId,
      { ...(remaining.length === 0 ? { status: "planned" } : {}), queued_tasks: remaining },
      remaining.length === 0 ? ["human_review_reason"] : [],
    );
    result.nodes.push(nodeId);
  }

  return result;
}
