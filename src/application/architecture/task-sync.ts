// Grandis tarp „taskas done" ir „mazgas done" (etalonas: AG_loop architecture/
// architecture-wave.ts sync pusė, 2026-07-07 code_scaner lauko testas; WBR VQ-501 3/5-d).
// Iki jos niekas automatiškai neužpildydavo progress.json `implemented_files` po run-tree
// tasko, todėl verify-node neturėjo ką tikrinti, mazgai amžinai likdavo "queued", o
// operatorius tarp bangų rankiniu būdu sukdavo verify-node + run-tree. Abu keliai
// best-effort loop'o atžvilgiu: sync klaida niekada nenutraukia task užbaigimo
// (done yra done — sync tik judina architektūros ledger'į).

import path from "node:path";
import { allowedPaths } from "../../domain/tasks/allowed-paths.js";
import type { ArchitectureProgress } from "../../domain/architecture/graph.js";
import { classifyRepairableIssue, evaluateRepairPolicy } from "../../domain/architecture/repair-policy.js";
import { verifyNode } from "./node-verifier.js";
import type { ArchitectureWavePorts } from "./ports.js";
import { architectureStateDir, readGraphFile, readProgressSafe } from "./wave-reclaim.js";

export type ArchitectureTaskSyncResult =
  | { action: "not-architecture-task" }
  | { action: "sync-error"; reason: string }
  | { action: "verified-done"; nodeId: string; implementedFiles: string[] }
  | { action: "verify-failed"; nodeId: string; failures: string[]; repair: "repair" | "human-review" };

/**
 * Suranda mazgą, kurio queued_tasks įrašas atitinka `<taskId>.md` — tiksliai ARBA kaip
 * split-vaiko tėvas: task-splitter vaikus vadina `<parentTaskId>-NN-<slug>`, tad vaiko
 * užbaigimas irgi priklauso tėvo mazgui (be šito split'inti run-tree taskai niekada
 * nesinchronizuodavo ir mazgas amžinai likdavo "queued").
 */
export function nodeIdForQueuedTask(progress: ArchitectureProgress, taskId: string): string | undefined {
  for (const [nodeId, node] of Object.entries(progress.nodes)) {
    for (const rel of node.queued_tasks ?? []) {
      const baseName = rel.replace(/\\/g, "/").split("/").pop() ?? "";
      const base = baseName.replace(/\.md$/, "");
      if (base && (taskId === base || taskId.startsWith(`${base}-`))) {
        return nodeId;
      }
    }
  }
  return undefined;
}

/**
 * Vienkartinis-idempotentiškas istorijos suderinimas: mazgams, kurie tebėra
 * queued/active/repairing, bet kurių queue taskas (arba jo split-vaikai) jau guli
 * AG/tasks/done, paleidžia tą patį sync+verify kelią kaip gyvas task-workflow
 * užbaigimas. Reikalingas dviem atvejais: (1) taskai baigti su senesne AG versija,
 * dar be sync variklio (code_scaner 2026-07-07: Mode/ContextOptimization mazgai
 * užstrigo "queued" su done taskais), (2) loop nutrūko tarp task-done ir sync.
 */
export async function reconcileArchitectureProgress(
  ports: ArchitectureWavePorts,
  projectRoot: string,
): Promise<string[]> {
  const stateDir = architectureStateDir(projectRoot);
  const progress = await readProgressSafe(ports.fs, path.join(stateDir, "progress.json"));
  if (!progress) return [];

  const doneDir = path.join(projectRoot, "AG", "tasks", "done");
  const doneFiles = await ports.fs.listFiles(doneDir);
  const synced: string[] = [];

  for (const [nodeId, node] of Object.entries(progress.nodes)) {
    if (!["queued", "active", "repairing"].includes(node.status)) continue;
    for (const rel of node.queued_tasks ?? []) {
      const base = (rel.replace(/\\/g, "/").split("/").pop() ?? "").replace(/\.md$/, "");
      if (!base) continue;
      const completed = doneFiles
        .filter((file) => file === `${base}.md` || (file.startsWith(`${base}-`) && file.endsWith(".md")))
        .sort();
      for (const file of completed) {
        const result = await syncArchitectureTaskCompletion(
          ports,
          projectRoot,
          file.replace(/\.md$/, ""),
          path.join(doneDir, file),
        );
        if (result.action === "verified-done" || result.action === "verify-failed") {
          synced.push(`${nodeId}:${result.action}`);
        }
        if (result.action === "verified-done") break;
      }
    }
  }
  return synced;
}

export async function syncArchitectureTaskCompletion(
  ports: ArchitectureWavePorts,
  projectRoot: string,
  taskId: string,
  doneTaskFile: string,
): Promise<ArchitectureTaskSyncResult> {
  try {
    const stateDir = architectureStateDir(projectRoot);
    const progressPath = path.join(stateDir, "progress.json");
    const graph = await readGraphFile(ports.fs, path.join(stateDir, "graph.json"));
    const progress = await readProgressSafe(ports.fs, progressPath);
    if (!graph || !progress) return { action: "not-architecture-task" };

    const nodeId = nodeIdForQueuedTask(progress, taskId);
    if (!nodeId) return { action: "not-architecture-task" };

    const taskText = (await ports.fs.readTextFileIfExists(doneTaskFile)) ?? "";
    const declared = allowedPaths(taskText);
    const implemented: string[] = [];
    for (const rel of declared) {
      if (await ports.fs.exists(path.join(projectRoot, rel))) implemented.push(rel);
    }

    const node = progress.nodes[nodeId]!;
    const mergedFiles = Array.from(new Set([...(node.implemented_files ?? []), ...implemented]));
    const mergedDone = Array.from(new Set([...(node.done_tasks ?? []), taskId]));
    await ports.updateNodeProgress(progressPath, nodeId, {
      implemented_files: mergedFiles,
      done_tasks: mergedDone,
    });
    node.implemented_files = mergedFiles;
    node.done_tasks = mergedDone;

    // verifyNode sėkmės atveju pats persistina status "done" + verified_at.
    const result = await verifyNode(
      {
        fs: ports.fs,
        progress: { updateNodeProgress: (id, update) => ports.updateNodeProgress(progressPath, id, update) },
        ...(ports.nowIso === undefined ? {} : { nowIso: ports.nowIso }),
      },
      nodeId,
      graph,
      progress,
      projectRoot,
    );
    if (result.passed) {
      return { action: "verified-done", nodeId, implementedFiles: mergedFiles };
    }

    // Ta pati bounded repair trajektorija kaip `architecture verify-node` CLI:
    // mazgas keliauja į "repairing" (ribotas bandymų skaičius) arba "human-review".
    const issueKind = classifyRepairableIssue(result.failures);
    const repair = evaluateRepairPolicy(node, issueKind);
    await ports.updateNodeProgress(
      progressPath,
      nodeId,
      repair.action === "repair"
        ? { status: "repairing", attempts: repair.updated_attempts }
        : { status: "human-review", attempts: repair.updated_attempts, human_review_reason: repair.reason },
    );
    return {
      action: "verify-failed",
      nodeId,
      failures: result.failures,
      repair: repair.action === "repair" ? "repair" : "human-review",
    };
  } catch (error: unknown) {
    return { action: "sync-error", reason: error instanceof Error ? error.message : String(error) };
  }
}
