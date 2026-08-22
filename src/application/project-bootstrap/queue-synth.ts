// Bootstrap eilės sintezė (etalonas: AG_loop orchestrator/bootstrap/bootstrap-queue-synth.ts):
// iš OpenSpec change'o ir architektūros grafo pagaminami maži, žingsnis-po-žingsnio eilės
// task'ai — PRIEŠ tai, kai kilpa ką nors dispatch'ina. Kiekvienas task'as neša įrodymus,
// leistinus kelius, patikras, sustojimo sąlygą ir agentų grandinę.
//
// Įrodymų disciplina: mazgas be README/.mmd/OpenSpec įrodymų NEVIRSTA task'u — jis grįžta
// kaip `weakEvidence` signalas. Išgalvoti reikalavimai būtų blogesni už matomą spragą, tad
// tuščias-bet-sėkmingas rezultatas čia neegzistuoja: arba yra bent vienas įrodymais paremtas
// task'as, arba grąžinama `insufficient-evidence`.
//
// Modulis TIK SKAITO (grafas, progresas, evidence, stack sprendimas) — jokių rašymų, tad jį
// saugu kviesti pakartotinai. Kur task'ai atsiduria, sprendžia kvietėjas (5/5-e komanda).

import path from "node:path";
import type {
  ArchitectureGraph,
  ArchitectureNode,
  ArchitectureProgress,
} from "../../domain/architecture/graph.js";
import { computeArchitectureGraphHash } from "../../domain/architecture/graph-hash.js";
import { getReadyNodes } from "../../domain/architecture/readiness.js";
import { inferInterfaceContract } from "../../domain/architecture/interface-inference.js";
import { taskBuckets } from "../../domain/tasks/buckets.js";
import { taskNumberFromFilename } from "../../domain/tasks/identity.js";
import { readEvidenceLedger } from "../architecture/evidence-ledger.js";
import { loadStackDecisionState } from "../architecture/governance.js";
import { architectureStateDir, readGraphFile, readProgressSafe } from "../architecture/wave-reclaim.js";
import type { ArchitectureWaveFsPort } from "../architecture/ports.js";
import {
  synthesizeTask,
  type SynthesisInput,
  type SynthesizedTask,
} from "../architecture/task-synthesizer.js";

/**
 * Per-mazgo sintezatoriaus parašas. Injektuojamas, kad testai galėtų tikrinti KOMPOZICIJĄ
 * nepriklausydami nuo pilno markdown renderio. Šis žingsnis niekada nekviečia LLM: sintezė iš
 * grafo ir įrodymų yra deterministinė.
 */
export type TaskSynthesizer = (input: SynthesisInput) => SynthesizedTask;

export type BootstrapQueueSynthPorts = {
  fs: ArchitectureWaveFsPort;
  synthesize?: TaskSynthesizer;
};

/** Vienas mažas eilės task'as, pagamintas iš vieno architektūros mazgo. */
export type QueueTask = {
  /** Stabilus slug'as kaip failo vardo kamienas; neša change id atsekamumui. */
  taskId: string;
  /** 1-based pozicija priklausomybėmis surikiuotame plane. */
  step: number;
  nodeId: string;
  nodeLabel: string;
  evidenceCount: number;
  allowedFiles: string[];
  markdown: string;
};

/** Mazgas, praleistas dėl įrodymų trūkumo — signalas, ne išgalvotas task'as. */
export type WeakEvidenceSignal = {
  nodeId: string;
  nodeLabel: string;
  reason: string;
};

export type BootstrapQueueSynthResult =
  | { status: "no-architecture"; reason: string }
  | { status: "insufficient-evidence"; reason: string; weakEvidence: WeakEvidenceSignal[] }
  | { status: "generated"; changeId: string; tasks: QueueTask[]; weakEvidence: WeakEvidenceSignal[] };

/**
 * Atsarginis numerių alokatorius (DUP-14): skenuoja VISUS `AG/tasks/*` bucket'us ir grąžina
 * vienetu didesnį už didžiausią rastą numerį. Be jo per-run skaitiklis, visada prasidedantis
 * nuo 1, galėtų pakartoti numerį, jau panaudotą ankstesniame bėgime — įskaitant numerį, kuris
 * guli TIK `done/` bucket'e, kur per-katalogo `wx` kolizijos patikra jo nemato.
 */
export async function nextAvailableTaskNumber(fs: ArchitectureWaveFsPort, projectRoot: string): Promise<number> {
  const root = path.resolve(projectRoot);
  let max = 0;
  for (const bucket of taskBuckets) {
    for (const name of await fs.listFiles(path.join(root, "AG", "tasks", bucket))) {
      const number = taskNumberFromFilename(name);
      if (number !== undefined && number > max) max = number;
    }
  }
  return max + 1;
}

/** Mažosiomis kebab forma — kad eilės failų vardai liktų saugūs failų sistemai. */
function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/**
 * Numatytasis progresas atmintyje (visi mazgai `planned`), kai progreso žurnalo dar nėra.
 * Atkartoja initProgress formą NERAŠANT į būseną — sintezė lieka be šalutinių efektų.
 */
function defaultProgress(graph: ArchitectureGraph): ArchitectureProgress {
  const nodes: ArchitectureProgress["nodes"] = {};
  for (const node of graph.nodes) {
    nodes[node.id] = {
      status: "planned",
      attempts: {},
      queued_tasks: [],
      done_tasks: [],
      implemented_files: [],
      evidence_refs: [],
    };
  }
  // TURINIO hash'as, kaip `initProgress`: `imported_at` yra laiko žyma, tad ji keisdavosi
  // kiekvieno importo metu ir NEsikeisdavo pasikeitus grafui. Abu keliai privalo gaminti tą
  // patį `graph_hash` tam pačiam grafui, kitaip sintezė ir ledger'is prasilenktų.
  return { graph_hash: computeArchitectureGraphHash(graph), nodes };
}

/** Mazgas laukia darbo, kai jis nėra išorinis ir dar nėra `done`. */
function isPending(node: ArchitectureNode, progress: ArchitectureProgress): boolean {
  return node.external !== true && progress.nodes[node.id]?.status !== "done";
}

/**
 * Surikiuoja laukiančius mazgus į deterministinę, priklausomybes gerbiančią seką: kartotinai
 * klausia to paties `getReadyNodes`, kurį naudoja kilpa, ir kiekvieną suplanuotą mazgą kitam
 * ratui laiko atliktu. Priklausomybių ciklo palikti mazgai pridedami grafo tvarka, kad niekas
 * tyliai nedingtų.
 */
function orderPendingNodes(graph: ArchitectureGraph, progress: ArchitectureProgress): string[] {
  const pending = graph.nodes.filter((node) => isPending(node, progress));
  const pendingIds = new Set(pending.map((node) => node.id));

  const work: ArchitectureProgress = {
    graph_hash: progress.graph_hash,
    nodes: Object.fromEntries(Object.entries(progress.nodes).map(([id, np]) => [id, { ...np }])),
  };

  const order: string[] = [];
  const scheduled = new Set<string>();

  while (scheduled.size < pending.length) {
    const ready = getReadyNodes(graph, work).filter((node) => pendingIds.has(node.id) && !scheduled.has(node.id));
    const batch = ready.length > 0 ? ready : pending.filter((node) => !scheduled.has(node.id));

    for (const node of batch) {
      order.push(node.id);
      scheduled.add(node.id);
      const nodeProgress = work.nodes[node.id];
      if (nodeProgress) nodeProgress.status = "done";
    }
  }

  return order;
}

export async function generateBootstrapQueueTasks(
  ports: BootstrapQueueSynthPorts,
  projectRoot: string,
  changeId: string,
): Promise<BootstrapQueueSynthResult> {
  const root = path.resolve(projectRoot);
  const stateDir = architectureStateDir(root);

  const graph = await readGraphFile(ports.fs, path.join(stateDir, "graph.json"));
  if (!graph || graph.nodes.length === 0) {
    return {
      status: "no-architecture",
      reason: "No architecture graph imported (vq/state/architecture/graph.json missing or empty).",
    };
  }

  const progress = (await readProgressSafe(ports.fs, path.join(stateDir, "progress.json"))) ?? defaultProgress(graph);
  const evidence = await readEvidenceLedger(ports.fs, path.join(stateDir, "evidence.jsonl"));
  // 841 runtime wiring: persistuotas projekto stack sprendimas įrašomas į kiekvieno task'o
  // `## Stack` sekciją, kad vykdantis agentas sektų jau pasirinktą stack'ą, o ne spėliotų.
  const stackDecision = await loadStackDecisionState(ports.fs, root);

  const orderedNodeIds = orderPendingNodes(graph, progress);
  if (orderedNodeIds.length === 0) {
    return {
      status: "insufficient-evidence",
      reason: "No pending architecture nodes — nothing to synthesize into queue tasks.",
      weakEvidence: [],
    };
  }

  const synthesize = ports.synthesize ?? synthesizeTask;
  const changeSlug = slugify(changeId) || "bootstrap";
  const baseStep = await nextAvailableTaskNumber(ports.fs, root);

  const tasks: QueueTask[] = [];
  const weakEvidence: WeakEvidenceSignal[] = [];

  orderedNodeIds.forEach((nodeId, index) => {
    const node = graph.nodes.find((candidate) => candidate.id === nodeId);
    const nodeLabel = node?.label ?? nodeId;
    const nodeEvidence = evidence.filter((entry) => entry.node_id === nodeId);

    if (nodeEvidence.length === 0) {
      weakEvidence.push({
        nodeId,
        nodeLabel,
        reason: "No README/.mmd/OpenSpec evidence for this node; refusing to fabricate a task.",
      });
      return;
    }

    const step = baseStep + index;
    const runId = `${changeSlug}-${String(step).padStart(3, "0")}-${slugify(nodeId)}`;
    const synthesized = synthesize({
      // Kanoninė nuoroda į originating OpenSpec change: be jos preflight kiekvieną sugeneruotą
      // source task'ą parkuotų į human-review (nėra aktyvios OpenSpec nuorodos), ir visas
      // bootstrap srautas mirtų pirmame žingsnyje.
      specSource: `openspec/changes/${changeId}`,
      nodeId,
      graph,
      progress,
      evidence: nodeEvidence,
      contract: inferInterfaceContract(nodeId, graph, progress, evidence),
      runId,
      ...(stackDecision === undefined ? {} : { stackDecision }),
    });

    tasks.push({
      taskId: runId,
      step,
      nodeId,
      nodeLabel: synthesized.node_label,
      evidenceCount: synthesized.evidence_count,
      allowedFiles: synthesized.allowed_files,
      markdown: synthesized.markdown,
    });
  });

  if (tasks.length === 0) {
    return {
      status: "insufficient-evidence",
      reason:
        "No pending architecture node has README/.mmd/OpenSpec evidence; queue synthesis would fabricate requirements.",
      weakEvidence,
    };
  }

  return { status: "generated", changeId, tasks, weakEvidence };
}
