// Kanoninio task GRAFO priežiūra bangoje (etalonas: AG_loop orchestrator/loop/loop-wave-graph.ts).
//
// Grafas NĖRA vykdymo autoritetas — planą ir toliau sudaro `scheduleNextWave`. Grafas prideda tik
// DRAUDIMUS (ready set) ir diagnostiką. Iš to plaukia svarbiausia šio modulio savybė: nė viena jo
// nesėkmė nestabdo bangos. Neimportuotas grafas reiškia „draudimų nežinome", ir tada banga eina be
// jų — sustabdyta eilė dėl neperskaityto pagalbinio failo būtų blogesnis mainas.
//
// Snapshot'o rašymas rezervuoja hash'ą PRIEŠ await'ą: du lygiagretūs perskaičiavimai to paties
// grafo neberašo dukart, o nepavykęs rašymas rezervaciją grąžina, kad kitas bandymas kartotų.

import { buildReadySet, type ReadySet, type ReadySetBudget } from "./build-ready-set.js";
import { validateTaskGraph } from "../../domain/tasks/graph/validate.js";
import type { TaskGraph, TaskNodeStatus } from "../../domain/tasks/graph/model.js";
import type { WavePoolEvent } from "./wave-pool-planning.js";

/**
 * Saugomo snapshot'o pjūvis application sluoksniui.
 *
 * Infrastruktūros `TaskGraphReadResult` čia neatkeliauja: sluoksnių riba to neleidžia, o ir
 * validacijos rezultatas nešti nereikia — jį perskaičiuoja `validateTaskGraph`, kuris yra domain.
 */
export type StoredGraphRead =
  | { ok: true; graph: TaskGraph }
  | { ok: false; reason: "missing" | "invalid-json" | "schema" | "corrupted"; errors: string[] };

export type WaveGraphDeps = {
  runId: string;
  importGraph: () => Promise<TaskGraph>;
  writeGraphSnapshot: (graph: TaskGraph) => Promise<void>;
  log: (message: string) => Promise<void>;
  recordEvent: (event: WavePoolEvent) => Promise<void>;
  approvals: () => Iterable<string>;
  readySetBudget: () => ReadySetBudget | undefined;
  statuses: () => { completed: Iterable<string>; blocked: Iterable<string>; running: Iterable<string> };
};

export type WaveGraphCoordinator = {
  refresh: (waveId: string) => Promise<TaskGraph | undefined>;
  readySet: (graph: TaskGraph | undefined) => ReadySet | undefined;
  reportSnapshot: (stored: StoredGraphRead, graph: TaskGraph | undefined, waveId: string) => Promise<void>;
};

export function createWaveGraphCoordinator(deps: WaveGraphDeps): WaveGraphCoordinator {
  const persistedGraphHashes = new Set<string>();

  const event = async (name: string, reason: string, hash: string, waveId: string): Promise<void> => {
    await deps.recordEvent({ run_id: deps.runId, wave_id: waveId, graph_hash: hash, event: name, reason });
  };

  return {
    async refresh(waveId): Promise<TaskGraph | undefined> {
      let graph: TaskGraph;
      try {
        graph = await deps.importGraph();
      } catch (error) {
        // Grafo nėra → draudimų nėra. Banga tęsiasi, bet TYLOS nelieka.
        await deps.log(`TASK GRAPH IMPORT FAILED: ${describe(error)}`);
        return undefined;
      }

      if (!persistedGraphHashes.has(graph.graph_hash)) {
        persistedGraphHashes.add(graph.graph_hash);
        try {
          await deps.writeGraphSnapshot(graph);
          await deps.log(
            `TASK GRAPH SNAPSHOT: written hash=${graph.graph_hash} nodes=${graph.nodes.length} edges=${graph.dependencies.length}`,
          );
        } catch (error) {
          // Rezervacija grąžinama: kitaip vienas nepavykęs rašymas amžinai įtikintų, kad
          // snapshot'as jau yra.
          persistedGraphHashes.delete(graph.graph_hash);
          await deps.log(`TASK GRAPH SNAPSHOT WRITE FAILED: ${describe(error)}`);
        }
      }

      const codes = graphErrorCodes(graph);
      if (codes !== "") {
        await deps.log(`TASK GRAPH UNEXECUTABLE: ${codes}`);
        await event("graph_unexecutable", codes, graph.graph_hash, waveId);
      }
      return graph;
    },

    readySet(graph): ReadySet | undefined {
      if (graph === undefined) return undefined;
      // Run'o būsena viršija grafo įrašytą: grafas yra importo momento nuotrauka, o completed/
      // blocked/running gimsta bangoje. Be perrašymo ready set siūlytų jau padarytą darbą.
      const statusOverrides = new Map<string, TaskNodeStatus>();
      const statuses = deps.statuses();
      for (const taskId of statuses.completed) statusOverrides.set(taskId, "done");
      for (const taskId of statuses.blocked) statusOverrides.set(taskId, "blocked");
      for (const taskId of statuses.running) statusOverrides.set(taskId, "running");
      const budget = deps.readySetBudget();
      return buildReadySet({
        graph,
        statusOverrides,
        approvals: deps.approvals(),
        ...(budget === undefined ? {} : { budget }),
      });
    },

    async reportSnapshot(stored, graph, waveId): Promise<void> {
      const currentHash = graph?.graph_hash ?? "none";
      if (!stored.ok) {
        if (stored.reason === "missing") {
          await deps.log("TASK GRAPH SNAPSHOT: none (first run); built from Markdown");
          return;
        }
        const reason = `${stored.reason}: ${stored.errors.join("; ")}`;
        await deps.log(`TASK GRAPH SNAPSHOT REJECTED: ${reason}; rebuilt from Markdown`);
        await event("graph_snapshot_rejected", reason, currentHash, waveId);
        return;
      }

      if (stored.graph.graph_hash !== currentHash) {
        const reason = `snapshot=${stored.graph.graph_hash} current=${currentHash}`;
        await deps.log(`TASK GRAPH SNAPSHOT: stale (${reason}); rebuilt from Markdown`);
        await event("graph_snapshot_stale", reason, currentHash, waveId);
        return;
      }

      const codes = graphErrorCodes(stored.graph);
      if (codes !== "") {
        await deps.log(`TASK GRAPH SNAPSHOT: unexecutable (${codes})`);
        await event("graph_unexecutable", codes, currentHash, waveId);
        return;
      }

      await deps.log(`TASK GRAPH SNAPSHOT: reused hash=${stored.graph.graph_hash} nodes=${stored.graph.nodes.length}`);
    },
  };
}

/** Tik GRAFO lygio klaidos: mazgo lygio pažeidimas neuždaro visos eilės. */
function graphErrorCodes(graph: TaskGraph): string {
  return validateTaskGraph(graph)
    .violations.filter((entry) => entry.severity === "error" && entry.scope === "graph")
    .map((entry) => entry.code)
    .join(",");
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
