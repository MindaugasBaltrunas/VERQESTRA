// `architecture` CLI adapteris (etalonas: interfaces/cli/architecture/index.ts 1:1 seka).
// Visa logika — application/architecture (governance/wave/sync/verify/synthesizer) ir
// application/code-intelligence (code-map); čia lieka argumentų parsinimas, etalono
// console eilutės ir exit kodai. Grafo importo IO (writeGraph/initProgress) — per
// deps.graphStore portą (infrastructure architecture-graph-store suriša VQ-504).

import path from "node:path";
import type { ArchitectureGraph, ArchitectureProgress } from "../../../domain/architecture/graph.js";
import { fromGraphSource } from "../../../domain/architecture/graph-import.js";
import { computeReadiness } from "../../../domain/architecture/readiness.js";
import { inferInterfaceContract } from "../../../domain/architecture/interface-inference.js";
import {
  classifyRepairableIssue,
  evaluateRepairPolicy,
  type RepairDecision,
} from "../../../domain/architecture/repair-policy.js";
import {
  checkArchitectureGovernance,
  initArchitectureGovernance,
} from "../../../application/architecture/governance.js";
import { readEvidenceLedger } from "../../../application/architecture/evidence-ledger.js";
import { synthesizeTask, writeSynthesisOutput } from "../../../application/architecture/task-synthesizer.js";
import { verifyNode } from "../../../application/architecture/node-verifier.js";
import { synthesizeReadyArchitectureWave } from "../../../application/architecture/wave.js";
import {
  architectureStateDir,
  readGraphFile,
  readProgressSafe,
} from "../../../application/architecture/wave-reclaim.js";
import type { ArchitectureWavePorts } from "../../../application/architecture/ports.js";
import { parseMermaidFlowchart } from "../../../application/code-intelligence/graph-source/mermaid-parser.js";
import { scanAstSymbols } from "../../../application/code-intelligence/code-map/ast-symbol-scanner.js";
import {
  GENERATED_CODE_MAP_RELATIVE_PATH,
  generateCodeMapMermaid,
  writeGeneratedCodeMap,
} from "../../../application/code-intelligence/code-map/generator.js";
import {
  computeCodeMapCoverage,
  writeCodeMapCoverage,
} from "../../../application/code-intelligence/code-map/coverage.js";
import type { CodeIntelligenceFileSystemPort } from "../../../application/code-intelligence/ports.js";
import { consoleCliIo, type CliIo } from "../registry.js";

export type ArchitectureCommandDeps = {
  wave: ArchitectureWavePorts;
  codeFs: CodeIntelligenceFileSystemPort;
  graphStore: {
    writeGraph(statePath: string, graph: ArchitectureGraph): Promise<void>;
    initProgress(graph: ArchitectureGraph, statePath: string): Promise<ArchitectureProgress>;
  };
  projectRoot: string;
  io?: CliIo;
};

// AOD-01 lifecycle point (2): statuses that mean a queue task already exists for
// a node (or the node is terminal). Once a node reaches any of these it has left
// "ready" and must not be re-synthesized — this is the idempotency guard that
// stops run-tree/synthesize-node from writing duplicate tasks for the same node.
const NON_SYNTHESIZABLE_STATUSES: ReadonlySet<string> = new Set([
  "queued",
  "active",
  "repairing",
  "done",
  "human-review",
]);

function statePaths(projectRoot: string): { graphPath: string; progressPath: string; evidencePath: string } {
  const stateDir = architectureStateDir(projectRoot);
  return {
    graphPath: path.join(stateDir, "graph.json"),
    progressPath: path.join(stateDir, "progress.json"),
    evidencePath: path.join(stateDir, "evidence.jsonl"),
  };
}

async function readGraphAndProgress(
  deps: ArchitectureCommandDeps,
): Promise<{ graph: ArchitectureGraph; progress: ArchitectureProgress }> {
  const { graphPath, progressPath } = statePaths(deps.projectRoot);
  const graph = await readGraphFile(deps.wave.fs, graphPath);
  if (!graph) throw new Error(`architecture graph not found: ${graphPath}`);
  const progress = await readProgressSafe(deps.wave.fs, progressPath);
  if (!progress) throw new Error(`architecture progress not found: ${progressPath}`);
  return { graph, progress };
}

export async function architectureCommand(deps: ArchitectureCommandDeps, args: string[]): Promise<number> {
  const io = deps.io ?? consoleCliIo;
  const projectRoot = deps.projectRoot;
  try {
    const subcommand = args[0] ?? "check";
    const asJson = args.includes("--json");
    if (subcommand === "init") {
      const result = await initArchitectureGovernance(deps.wave.fs, projectRoot);
      if (asJson) {
        io.out(JSON.stringify(result, null, 2));
        return 0;
      }
      io.out("architecture governance initialized");
      io.out(`config: ${path.relative(projectRoot, result.configPath).replace(/\\/g, "/")}`);
      io.out(`created: ${result.created.length}`);
      for (const item of result.created) io.out(`created: ${item}`);
      io.out(`skipped: ${result.skipped.length}`);
      for (const item of result.skipped) io.out(`skipped: ${item}`);
      return 0;
    }

    if (subcommand === "import-mmd") {
      const filePath = args[1];
      if (!filePath) {
        io.error("Usage: verqestra architecture import-mmd <file>");
        return 2;
      }
      // Containment: importuojamas .mmd turi būti projekto kataloge — neleidžiam
      // skaityti savavališko FS kelio per CLI argumentą.
      const projectRootAbs = path.resolve(projectRoot);
      const resolvedMmd = path.resolve(projectRoot, filePath);
      if (resolvedMmd !== projectRootAbs && !resolvedMmd.startsWith(projectRootAbs + path.sep)) {
        io.error("import-mmd: failas turi būti projekto kataloge");
        return 2;
      }
      const content = await deps.wave.fs.readTextFileIfExists(resolvedMmd);
      if (content === undefined) throw new Error(`import-mmd: failas nerastas: ${resolvedMmd}`);
      const mermaidGraph = parseMermaidFlowchart(content);
      const nowIso = deps.wave.nowIso ?? (() => new Date().toISOString());
      const graph = fromGraphSource(
        mermaidGraph,
        path.relative(projectRootAbs, resolvedMmd).replace(/\\/g, "/"),
        nowIso(),
      );
      const { graphPath, progressPath } = statePaths(projectRoot);
      await deps.graphStore.writeGraph(graphPath, graph);
      await deps.graphStore.initProgress(graph, progressPath);
      if (asJson) {
        io.out(JSON.stringify({ nodes: graph.nodes.length, edges: graph.edges.length }, null, 2));
        return 0;
      }
      io.out(`nodes: ${graph.nodes.length}`);
      io.out(`edges: ${graph.edges.length}`);
      return 0;
    }

    if (subcommand === "next-node") {
      const { graph, progress } = await readGraphAndProgress(deps);
      const updated = computeReadiness(graph, progress);
      const readyId = Object.entries(updated.nodes).find(([, n]) => n.status === "ready")?.[0];
      if (!readyId) {
        io.out("no ready node");
        return 0;
      }
      const node = graph.nodes.find((n) => n.id === readyId)!;
      if (asJson) {
        io.out(JSON.stringify(node, null, 2));
        return 0;
      }
      io.out(`id: ${node.id}`);
      io.out(`label: ${node.label}`);
      return 0;
    }

    if (subcommand === "synthesize-node") {
      const nodeId = args[1];
      if (!nodeId || nodeId.startsWith("--")) {
        io.error("Usage: verqestra architecture synthesize-node <node-id> [--write]");
        return 2;
      }
      const doWrite = args.includes("--write");
      const { progressPath, evidencePath } = statePaths(projectRoot);
      const { graph, progress } = await readGraphAndProgress(deps);
      const evidence = await readEvidenceLedger(deps.wave.fs, evidencePath);
      const nodeExists = graph.nodes.some((n) => n.id === nodeId);
      if (!nodeExists) {
        io.error(`node not found: ${nodeId}`);
        return 2;
      }
      // Ta pati evidence disciplina kaip wave (895): mazgas be jokio evidence įrašo
      // NEgauna tasko su išgalvotais keliais — sintezė atsisakoma su aiškia priežastimi.
      const nodeEvidence = evidence.filter((e) => e.node_id === nodeId);
      if (nodeEvidence.length === 0) {
        io.error(
          `node ${nodeId}: no evidence entries in vq/state/architecture/evidence.jsonl — refusing to synthesize a fabricated task (evidence repair required)`,
        );
        return 2;
      }
      const contract = inferInterfaceContract(nodeId, graph, progress, evidence);
      const nowMs = deps.wave.nowMs ?? (() => Date.now());
      const runId = `synthesize-${nodeId}-${nowMs()}`;
      const result = synthesizeTask({ nodeId, graph, progress, evidence: nodeEvidence, contract, runId });
      if (doWrite) {
        // AOD-01 lifecycle point (2): idempotency guard — if a task has already
        // been synthesized for this node it is past "ready", so skip instead of
        // writing a second duplicate queue task.
        const effective = computeReadiness(graph, progress);
        const currentStatus = effective.nodes[nodeId]?.status ?? "planned";
        if (NON_SYNTHESIZABLE_STATUSES.has(currentStatus)) {
          if (asJson) {
            io.out(JSON.stringify({ node_id: nodeId, status: currentStatus, skipped: true }, null, 2));
          } else {
            io.out(`skipped: ${nodeId} (${currentStatus})`);
          }
          return 0;
        }
        const queuePath = path.join(projectRoot, "AG", "tasks", "queue", `${runId}.md`);
        await deps.wave.fs.writeTextFile(queuePath, result.markdown);
        const statePath = path.join(architectureStateDir(projectRoot), "task-synthesis");
        await writeSynthesisOutput(deps.wave.fs, statePath, result);
        const relQueuePath = path.relative(projectRoot, queuePath).replace(/\\/g, "/");
        // Mazgas pereina iš "ready" į "queued" su queue tasko keliu — kitas
        // run-tree/synthesize-node matys "queued" ir dublikato nesintezuos.
        await deps.wave.updateNodeProgress(progressPath, nodeId, {
          status: "queued",
          queued_tasks: [...(effective.nodes[nodeId]?.queued_tasks ?? []), relQueuePath],
        });
        if (asJson) {
          io.out(JSON.stringify({ run_id: result.run_id, node_id: result.node_id, task: queuePath }, null, 2));
          return 0;
        }
        io.out(`run_id: ${result.run_id}`);
        io.out(`task: ${relQueuePath}`);
      } else {
        io.out(result.markdown);
      }
      return 0;
    }

    if (subcommand === "verify-node") {
      const nodeId = args[1];
      if (!nodeId || nodeId.startsWith("--")) {
        io.error("Usage: verqestra architecture verify-node <node-id>");
        return 2;
      }
      const { progressPath } = statePaths(projectRoot);
      const { graph, progress } = await readGraphAndProgress(deps);
      const result = await verifyNode(
        {
          fs: deps.wave.fs,
          progress: {
            updateNodeProgress: (id, update) => deps.wave.updateNodeProgress(progressPath, id, update),
          },
          ...(deps.wave.nowIso === undefined ? {} : { nowIso: deps.wave.nowIso }),
        },
        nodeId,
        graph,
        progress,
        projectRoot,
      );
      let repair: RepairDecision | undefined;
      if (!result.passed) {
        // AOD-01 lifecycle point (3): a failing verification is routed through the
        // repair policy so the node moves to "repairing" (bounded retry) or
        // "human-review" — instead of silently exiting with the node stuck.
        const nodeProgress = progress.nodes[nodeId];
        if (nodeProgress) {
          const issueKind = classifyRepairableIssue(result.failures);
          repair = evaluateRepairPolicy(nodeProgress, issueKind);
          if (repair.action === "repair") {
            await deps.wave.updateNodeProgress(progressPath, nodeId, {
              status: "repairing",
              attempts: repair.updated_attempts,
            });
          } else {
            await deps.wave.updateNodeProgress(progressPath, nodeId, {
              status: "human-review",
              attempts: repair.updated_attempts,
              human_review_reason: repair.reason,
            });
          }
        }
      }
      if (asJson) {
        // Etalono elgesys 1:1: --json kelias baigiasi PRIEŠ exit kodo priskyrimą —
        // mašininis skaitytojas verdiktą ima iš JSON, ne iš exit kodo.
        io.out(JSON.stringify({ ...result, repair }, null, 2));
        return 0;
      }
      io.out(`passed: ${result.passed}`);
      for (const failure of result.failures) io.out(`failure: ${failure}`);
      if (repair) io.out(`repair: ${repair.action} (${repair.reason})`);
      return result.passed ? 0 : 2;
    }

    if (subcommand === "run-tree") {
      // Sintezės branduolys gyvena application/architecture/wave.ts, kad tą pačią
      // bangos logiką naudotų ir loop'o empty-queue tęsimas — šis adapteris lieka
      // tik render/exit sluoksnis.
      const wave = await synthesizeReadyArchitectureWave(deps.wave, projectRoot);
      if (wave.status === "no-graph") {
        io.error("architecture graph/progress not found — run `verqestra architecture import-mmd` (or bootstrap) first");
        return 2;
      }

      const allDone = wave.status === "all-done";
      const noReadyAndNotAllDone = wave.synthesized === 0 && !allDone;

      if (asJson) {
        io.out(
          JSON.stringify(
            {
              synthesized: wave.synthesized,
              blocked: wave.blocked,
              done: wave.done,
              already_implemented: wave.already_implemented,
              nodes: wave.nodeResults,
            },
            null,
            2,
          ),
        );
      } else {
        for (const nr of wave.nodeResults) {
          if (nr.action === "synthesized") {
            io.out(`synthesized: ${nr.nodeId}`);
          } else if (nr.action === "already-implemented") {
            io.out(`already-implemented: ${nr.nodeId}`);
          } else {
            io.out(`skipped: ${nr.nodeId} (${nr.status})`);
          }
        }
        io.out(`synthesized: ${wave.synthesized}`);
        io.out(`blocked: ${wave.blocked}`);
        io.out(`done: ${wave.done}`);
        io.out(`already-implemented: ${wave.already_implemented}`);
      }

      return noReadyAndNotAllDone ? 1 : 0;
    }

    if (subcommand === "code-map") {
      const doWrite = args.includes("--write");
      const doCheck = args.includes("--check");
      if (!doWrite && !doCheck) {
        io.error("Usage: verqestra architecture code-map --write|--check [--json]");
        return 2;
      }

      const { symbols, imports, files: scannedFiles } = await scanAstSymbols(deps.codeFs, projectRoot);
      let mermaidContent: string;
      if (doWrite) {
        await writeGeneratedCodeMap(deps.codeFs, projectRoot, symbols, imports, scannedFiles);
        mermaidContent = generateCodeMapMermaid(symbols, imports, scannedFiles);
      } else {
        const codeMapPath = path.join(projectRoot, ...GENERATED_CODE_MAP_RELATIVE_PATH.split("/"));
        const existing = await deps.codeFs.readTextFile(codeMapPath).catch(() => undefined);
        if (existing === undefined) throw new Error(`code map not found: ${codeMapPath}`);
        mermaidContent = existing;
      }

      const coverage = computeCodeMapCoverage(
        symbols,
        mermaidContent,
        scannedFiles.map((file) => file.filePath),
      );
      const coveragePath = await writeCodeMapCoverage(deps.codeFs, projectRoot, coverage);

      if (asJson) {
        io.out(JSON.stringify(coverage, null, 2));
      } else {
        io.out(`code-map: ${doWrite ? "write" : "check"}`);
        io.out(`source_files_total: ${coverage.source_files_total}`);
        io.out(`source_files_indexed: ${coverage.source_files_indexed}`);
        io.out(`symbols_total: ${coverage.symbols_total}`);
        io.out(`symbols_rendered_in_mmd: ${coverage.symbols_rendered_in_mmd}`);
        io.out(`coverage_percent: ${coverage.coverage_percent}`);
        for (const missing of coverage.missing_symbols) io.out(`missing: ${missing}`);
        io.out(`coverage_file: ${path.relative(projectRoot, coveragePath).replace(/\\/g, "/")}`);
      }

      return coverage.coverage_percent < 100 ? 1 : 0;
    }

    if (subcommand !== "check") {
      throw new Error(
        "Usage: verqestra architecture [init|check|import-mmd <file>|next-node|synthesize-node <node-id>|verify-node <node-id>|run-tree|code-map --write|--check] [--write] [--json]",
      );
    }

    const result = await checkArchitectureGovernance(deps.wave.fs, projectRoot);
    if (asJson) {
      // Etalono elgesys 1:1: check --json grąžina 0 nepriklausomai nuo ok.
      io.out(JSON.stringify(result, null, 2));
      return 0;
    }

    io.out(`architecture governance: ${result.ok ? "ok" : "missing"}`);
    io.out(`config: ${path.relative(projectRoot, result.configPath).replace(/\\/g, "/")}`);
    for (const missing of result.missing) io.out(`missing: ${missing}`);
    return result.ok ? 0 : 1;
  } catch (error: unknown) {
    io.error(error instanceof Error ? error.message : String(error));
    return 2;
  }
}
