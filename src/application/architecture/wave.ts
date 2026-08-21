// Automatinis architektūros medžio bangų variklis (etalonas: AG_loop architecture/
// architecture-wave.ts wave pusė, 2026-07-07; WBR VQ-501 3/5-d). synthesizeReadyArchitectureWave
// kviečiamas loop'o empty-queue žingsnyje (ir `architecture run-tree` CLI, kuris deleguoja
// čia): visiems "ready" mazgams susintezuoja queue taskus ir pažymi juos "queued".
// Idempotentiška: queued/active/repairing/done/human-review mazgai praleidžiami.

import path from "node:path";
import { resolveProjectPath } from "../../shared/paths.js";
import type { ArchitectureGraph, ArchitectureProgress } from "../../domain/architecture/graph.js";
import { classifyInputSourceNodes } from "../../domain/architecture/input-source-classification.js";
import { computeReadiness } from "../../domain/architecture/readiness.js";
import { inferInterfaceContract } from "../../domain/architecture/interface-inference.js";
import { readEvidenceLedger } from "./evidence-ledger.js";
import { detectNodeImplementation, readNodeImplementationMap } from "./implementation-detector.js";
import { synthesizeTask, writeSynthesisOutput } from "./task-synthesizer.js";
import { verifyNode } from "./node-verifier.js";
import type { ArchitectureWavePorts } from "./ports.js";
import { reconcileArchitectureProgress } from "./task-sync.js";
import {
  architectureStateDir,
  readGraphFile,
  readProgressSafe,
  reclaimEvidencelessSynthesizedTasks,
  reclaimExternalInputNodes,
} from "./wave-reclaim.js";

export type WaveNodeResult = {
  nodeId: string;
  action: "synthesized" | "skipped" | "already-implemented" | "external" | "no-evidence";
  status: string;
  runId?: string;
  taskPath?: string;
  /** Aiški blokavimo priežastis, kai action === "no-evidence". */
  reason?: string;
};

export type ArchitectureWaveResult = {
  status: "no-graph" | "synthesized" | "all-done" | "blocked";
  synthesized: number;
  blocked: number;
  done: number;
  total: number;
  /** Mazgai, šios bangos metu pažymėti "done" be tasko sintezės (kodas jau egzistuoja). */
  already_implemented: number;
  /** Grynų input/external mazgų (pvz. `A[Git Repository]`) skaičius — satisfied be sintezės (895). */
  external_satisfied: number;
  /** Ready mazgai be jokio evidence įrašo — taskas neblokuojamas fabrikuotu scope, o praleidžiamas su priežastimi (895). */
  no_evidence: number;
  nodeResults: WaveNodeResult[];
};

export type AlreadyImplementedMarkResult = {
  /** Atnaujinta progreso kopija (persistinta į progressPath) tolimesniam naudojimui toje pačioje bangoje. */
  progress: ArchitectureProgress;
  /** Mazgai, šio kvietimo metu pažymėti "done" be tasko sintezės (kodas jau egzistuoja). */
  markedDone: string[];
};

/**
 * Deterministinis „jau įgyvendinta" žymėjimas: kiekvienas dar nebaigtas mazgas
 * (planned/ready/queued) tikrinamas per node-map + label heuristikas
 * (implementation-detector). Aptiktas ir (ne-map šaltiniui) verifikuotas mazgas žymimas
 * "done" BE run-tree tasko — loop'as jam niekada nebekviečia vykdytojo sesijos. Jo pasenę
 * queue taskai pašalinami, kad nebūtų dispatch'inami.
 *
 * Naudojama DVIEJUOSE take-work keliuose, kad jau įgyvendinti mazgai niekada nebūtų
 * imami iš naujo: (1) wave sintezėje (synthesizeReadyArchitectureWave) ir (2) bootstrap
 * queue sintezės flow PRIEŠ generuojant taskus.
 */
export async function markAlreadyImplementedNodes(
  ports: ArchitectureWavePorts,
  projectRoot: string,
  graph: ArchitectureGraph,
  progress: ArchitectureProgress,
  progressPath: string,
): Promise<AlreadyImplementedMarkResult> {
  const implementationMap = await readNodeImplementationMap(ports.fs, projectRoot);
  const nowIso = ports.nowIso ?? (() => new Date().toISOString());
  let updated = progress;
  const markedDone: string[] = [];

  for (const node of graph.nodes) {
    // External input mazgai nėra implementuojami — jų detekcija/verifikacija beprasmė.
    if (node.external === true) continue;
    const nodeProgress = updated.nodes[node.id];
    const status = nodeProgress?.status ?? "planned";
    if (!["planned", "ready", "queued"].includes(status)) continue;
    const detection = await detectNodeImplementation(ports.fs, projectRoot, node, implementationMap);
    if (!detection) continue;

    const baseProgress =
      nodeProgress ??
      ({
        status: "planned",
        attempts: {},
        queued_tasks: [],
        done_tasks: [],
        implemented_files: [],
        evidence_refs: [],
      });
    const mergedFiles = Array.from(new Set([...baseProgress.implemented_files, ...detection.files]));
    let verified_at = nowIso();
    if (detection.source !== "map") {
      const candidateProgress: ArchitectureProgress = {
        ...updated,
        nodes: {
          ...updated.nodes,
          [node.id]: { ...baseProgress, implemented_files: mergedFiles },
        },
      };
      const verification = await verifyNode(
        {
          fs: ports.fs,
          progress: { updateNodeProgress: (id, update) => ports.updateNodeProgress(progressPath, id, update) },
          ...(ports.nowIso === undefined ? {} : { nowIso: ports.nowIso }),
        },
        node.id,
        graph,
        candidateProgress,
        projectRoot,
        undefined,
        false,
      );
      if (!verification.passed) continue;
      verified_at = verification.verified_at ?? verified_at;
    }
    await ports.updateNodeProgress(progressPath, node.id, {
      status: "done",
      implemented_files: mergedFiles,
      verified_at,
    });
    updated = {
      ...updated,
      nodes: {
        ...updated.nodes,
        [node.id]: { ...baseProgress, status: "done", implemented_files: mergedFiles, verified_at },
      },
    };

    // Pasenusių queue taskų valymas — tik AG/tasks/queue (delegated/active priklauso
    // vykdomam workflow ir liečiami nėra; jų užbaigimas mazgo nebežalos, nes jis done).
    for (const rel of baseProgress.queued_tasks) {
      const normalized = rel.replace(/\\/g, "/");
      if (!normalized.startsWith("AG/tasks/queue/")) continue;
      let queuePath: string;
      try {
        queuePath = resolveProjectPath(
          projectRoot,
          normalized,
          { allowAbsoluteInsideRoot: false, allowedPrefixes: ["AG/tasks/queue"], extension: ".md" },
          "queued architecture task",
        );
      } catch {
        continue;
      }
      await ports.fs.removeFile(queuePath);
    }

    markedDone.push(node.id);
  }

  return { progress: updated, markedDone };
}

export async function synthesizeReadyArchitectureWave(
  ports: ArchitectureWavePorts,
  projectRoot: string,
): Promise<ArchitectureWaveResult> {
  const stateDir = architectureStateDir(projectRoot);
  const progressPath = path.join(stateDir, "progress.json");
  const nowMs = ports.nowMs ?? (() => Date.now());

  // Prieš skaičiuojant parengtumą — istorijos suderinimas (žr. reconcileArchitectureProgress):
  // done taskų mazgai, kurių sync dar neįvyko, čia gauna implemented_files + verify,
  // kad šioje pat bangoje atsirakintų jų downstream.
  await reconcileArchitectureProgress(ports, projectRoot);

  // 895: klasifikuoja input/external mazgus, persistina vėliavas ir išvalo jiems
  // fabrikuotus queue taskus / pasenusią progreso būseną prieš parengtumo skaičiavimą.
  await reclaimExternalInputNodes(ports, projectRoot);

  // Evidence-less sintezuoti taskai (išleisti iki 895 gate) pašalinami iš visų
  // lifecycle bucket'ų, o jų mazgai grąžinami į "planned" — žr. funkcijos komentarą.
  await reclaimEvidencelessSynthesizedTasks(ports, projectRoot);

  const rawGraph = await readGraphFile(ports.fs, path.join(stateDir, "graph.json"));
  const progress = await readProgressSafe(ports.fs, progressPath);
  if (!rawGraph || !progress) {
    return {
      status: "no-graph",
      synthesized: 0,
      blocked: 0,
      done: 0,
      total: 0,
      already_implemented: 0,
      external_satisfied: 0,
      no_evidence: 0,
      nodeResults: [],
    };
  }
  // Idempotentiška apsauga, jei graph.json persistencija nepavyko — klasifikacija pigi.
  const graph = classifyInputSourceNodes(rawGraph);

  const evidence = await readEvidenceLedger(ports.fs, path.join(stateDir, "evidence.jsonl"));
  let updated = computeReadiness(graph, progress);

  // Skip code that the target project already implements, avoiding empty run-tree cycles
  // (žr. markAlreadyImplementedNodes — bendra su bootstrap queue sinteze). Po žymėjimo
  // parengtumas perskaičiuojamas, tad tos pačios bangos metu atsirakina ir downstream
  // mazgai — visa įgyvendinta grandinė susitvarko vienu wave kvietimu.
  const implementation = await markAlreadyImplementedNodes(ports, projectRoot, graph, updated, progressPath);
  updated = implementation.progress;
  const alreadyImplementedIds = new Set<string>(implementation.markedDone);
  const already_implemented = implementation.markedDone.length;
  if (already_implemented > 0) {
    updated = computeReadiness(graph, updated);
  }

  let synthesized = 0;
  let blocked = 0;
  let done = 0;
  let external_satisfied = 0;
  let no_evidence = 0;
  const nodeResults: WaveNodeResult[] = [];

  for (const node of graph.nodes) {
    const nodeId = node.id;
    const status = updated.nodes[nodeId]?.status ?? "planned";
    // 895: grynas input/external mazgas (pvz. `A[Git Repository]`) yra satisfied be
    // sintezės — jam niekada nekuriamas implementacijos taskas su fabrikuotu scope.
    if (node.external === true) {
      external_satisfied += 1;
      nodeResults.push({ nodeId, action: "external", status: "external" });
      continue;
    }
    if (alreadyImplementedIds.has(nodeId)) {
      done += 1;
      nodeResults.push({ nodeId, action: "already-implemented", status });
      continue;
    }
    if (status === "done") {
      done += 1;
      nodeResults.push({ nodeId, action: "skipped", status });
      continue;
    }
    if (status !== "ready") {
      blocked += 1;
      nodeResults.push({ nodeId, action: "skipped", status });
      continue;
    }

    // 895: evidence disciplina (ta pati kaip bootstrap-queue-synth): mazgas be jokio
    // evidence įrašo NEgauna tasko su išgalvotais keliais — jis paliekamas ready su
    // aiškia priežastimi, todėl evidence atsiradus kita banga jį susintezuoja normaliai.
    const nodeEvidence = evidence.filter((e) => e.node_id === nodeId);
    if (nodeEvidence.length === 0) {
      blocked += 1;
      no_evidence += 1;
      nodeResults.push({
        nodeId,
        action: "no-evidence",
        status,
        reason: "No README/.mmd/OpenSpec evidence for this node; refusing to fabricate a task.",
      });
      continue;
    }

    const runId = `run-tree-${nodeId}-${nowMs()}`;
    const contract = inferInterfaceContract(nodeId, graph, updated, evidence);
    const result = synthesizeTask({ nodeId, graph, progress: updated, evidence: nodeEvidence, contract, runId });
    const queuePath = path.join(projectRoot, "AG", "tasks", "queue", `${runId}.md`);
    await ports.fs.writeTextFile(queuePath, result.markdown);
    await writeSynthesisOutput(ports.fs, path.join(stateDir, "task-synthesis"), result);
    const relQueuePath = path.relative(projectRoot, queuePath).replace(/\\/g, "/");
    await ports.updateNodeProgress(progressPath, nodeId, {
      status: "queued",
      queued_tasks: [...(updated.nodes[nodeId]?.queued_tasks ?? []), relQueuePath],
    });
    synthesized += 1;
    nodeResults.push({ nodeId, action: "synthesized", status, runId, taskPath: relQueuePath });
  }

  const total = graph.nodes.length;
  // Medis pilnas, kai kiekvienas mazgas yra done ARBA explicitly external
  // (architecture-driven-task-synthesis „Completion").
  const status: ArchitectureWaveResult["status"] =
    synthesized > 0 ? "synthesized" : total > 0 && done + external_satisfied === total ? "all-done" : "blocked";
  return { status, synthesized, blocked, done, total, already_implemented, external_satisfied, no_evidence, nodeResults };
}
