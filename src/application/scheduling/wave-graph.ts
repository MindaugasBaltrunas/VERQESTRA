// Kanoninio task GRAFO priežiūra bangoje (etalonas: AG_loop orchestrator/loop/loop-wave-graph.ts).
//
// Grafas YRA vykdymo autoritetas: `scheduleNextWave` iš jo ima bangos pjūvį ir priklausomybių
// rezoliuciją, o `applyReadySetGates` leidžia tik tai, ką jis vardija kaip `ready`. Iš to plaukia
// svarbiausia šio modulio savybė: importo nesėkmė SUSTABDO bangą (`planWaveWithoutGraph`), nes be
// autoriteto nė vieno task'o leidimo įrodyti neįmanoma.
//
// PASTABA (2026-08-23): iki tos dienos ši antraštė skelbė priešingai — „grafas NĖRA vykdymo
// autoritetas… nė viena jo nesėkmė nestabdo bangos". Tai buvo tiesa iki trijų tos dienos taisymų,
// bet liko neatnaujinta po jų, ir failas prieštaravo pats sau: `WaveGraphRefresh` doc'as žemiau jau
// aprašė naują taisyklę. Pasenusi antraštė pavojingesnė už jokios — ji tiksliai apibūdina spragą,
// kurios nebėra, ir kviečia ją atkurti.
//
// PERSISTUOTAS GRAFAS YRA PROVENIENCIJA, NE ATSARGINĖ KOPIJA. `reportStoredGraph` jį tik LYGINA su
// ką tik importuotu ir raportuoja skirtumą; jis niekada netampa `state.canonicalGraph` ir NĖRA
// fallback'as, kai Markdown importas lūžta. Taip sąmoningai:
//
//   importas pavyko  → snapshot'as arba sutampa (nieko neprideda), arba yra stale (naudoti draudžia);
//   importas lūžo    → task failai neperskaitomi, tad NEGALIME žinoti, ar kešuotas grafas dar
//                      apibūdina tikrovę — task'as galėjo persikelti tarp bucket'ų, būti
//                      suredaguotas ar pridėtas.
//
// Vykdymas pagal neverifikuojamą kešą yra tiksliai ta „įrodymo nebuvimas = leidimas" forma, kurią
// uždarė `planWaveWithoutGraph`. Todėl fallback'o čia NĖRA ir neturi atsirasti; tai prikalta testu.
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
  statuses: () => { completed: Iterable<string>; blocked: Iterable<string>; running: Iterable<string> };
};

/**
 * Grafo perskaitymo baigtis. `unavailable` NĖRA „grafo neprireikė": tai gedimas, dėl kurio
 * kvietėjas nebegali įrodyti nė vieno task'o leidimo (žr. `blockWaveWithoutGraph`). Anksčiau abi
 * baigtys buvo sulietos į `undefined`, ir būtent dėl to importo klaida tyliai atidarydavo bangą.
 */
export type WaveGraphRefresh =
  | { kind: "graph"; graph: TaskGraph }
  | { kind: "unavailable"; reason: string };

export type WaveGraphCoordinator = {
  refresh: (waveId: string) => Promise<WaveGraphRefresh>;
  /**
   * Biudžetas paduodamas, o ne skaitomas viduje: jo šaltinis yra failas, o šis metodas
   * sinchroninis ir kviečiamas planavimo viduryje. Skaitymas gyvena bangos perskaičiavime, kur
   * async jau yra, ir įvyksta VIENĄ kartą per bangą — ne kartą per plano variantą.
   */
  readySet: (graph: TaskGraph | undefined, budget: ReadySetBudget | undefined) => ReadySet | undefined;
  /**
   * Palygina ankstesnio proceso įrašytą grafą su ką tik importuotu ir RAPORTUOJA skirtumą.
   *
   * Vardas sąmoningai sako „report", o ne „restore": grąžinamos reikšmės nėra, ir iškvietėjas iš
   * čia negauna nieko, ką galėtų vykdyti. Pavadinimas `reportSnapshot` klaidino — jis skambėjo kaip
   * snapshot'o panaudojimas, nors tai tik proveniencijos eilutė žurnale.
   */
  reportStoredGraph: (stored: StoredGraphRead, graph: TaskGraph | undefined, waveId: string) => Promise<void>;
};

export function createWaveGraphCoordinator(deps: WaveGraphDeps): WaveGraphCoordinator {
  const persistedGraphHashes = new Set<string>();

  const event = async (name: string, reason: string, hash: string, waveId: string): Promise<void> => {
    await deps.recordEvent({ run_id: deps.runId, wave_id: waveId, graph_hash: hash, event: name, reason });
  };

  return {
    async refresh(waveId): Promise<WaveGraphRefresh> {
      let graph: TaskGraph;
      try {
        graph = await deps.importGraph();
      } catch (error) {
        // Grafo nėra → NEĮMANOMA įrodyti, kad task'ą leidžiama vykdyti. Iki 2026-08-23 audito ši
        // šaka reiškė „draudimų nežinome, tad banga eina be jų"; dabar ji reiškia sustabdytą bangą
        // su įvardyta priežastimi (kvietėjas — `blockWaveWithoutGraph`).
        const reason = describe(error);
        await deps.log(`TASK GRAPH IMPORT FAILED: ${reason}`);
        await event("graph_unavailable", reason, "none", waveId);
        return { kind: "unavailable", reason };
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
      return { kind: "graph", graph };
    },

    readySet(graph, budget): ReadySet | undefined {
      if (graph === undefined) return undefined;
      // Run'o būsena viršija grafo įrašytą: grafas yra importo momento nuotrauka, o completed/
      // blocked/running gimsta bangoje. Be perrašymo ready set siūlytų jau padarytą darbą.
      const statusOverrides = new Map<string, TaskNodeStatus>();
      const statuses = deps.statuses();
      for (const taskId of statuses.completed) statusOverrides.set(taskId, "done");
      for (const taskId of statuses.blocked) statusOverrides.set(taskId, "blocked");
      for (const taskId of statuses.running) statusOverrides.set(taskId, "running");
      return buildReadySet({
        graph,
        statusOverrides,
        approvals: deps.approvals(),
        ...(budget === undefined ? {} : { budget }),
      });
    },

    async reportStoredGraph(stored, graph, waveId): Promise<void> {
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
