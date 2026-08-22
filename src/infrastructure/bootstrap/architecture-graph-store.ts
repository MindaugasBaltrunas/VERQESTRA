// Architektūros grafo ir progreso ledger'io IO (etalonai: AG_loop architecture/
// architecture-graph.ts skaitymo/rašymo pusė ir architecture/architecture-progress.ts 1:1).
// Tipai ir grynos taisyklės gyvena domain/architecture; čia — tik JSON failai. Kanoniniai
// keliai VERQESTRA layout'e: `vq/state/architecture/{graph.json,progress.json}` (kelius
// paduoda kvietėjas — saugykla jų neužkoduoja, kaip ir etalonas).

import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import {
  computeArchitectureGraphHash,
  computeArchitectureNodeHash,
  type ArchitectureGraph,
  type ArchitectureNodeProgress,
  type ArchitectureProgress,
} from "../../domain/architecture/index.js";
import { nodeFsAdapter } from "../fs/node-fs-adapter.js";

/**
 * Progreso ledger'io rašymo mutex'as.
 *
 * `updateNodeProgress` ir `initProgress` yra read-modify-write PER VISĄ failą: skaitomas visas
 * `progress.json`, pakeičiamas vienas mazgas, įrašoma atgal. Du workeriai, baigiantys SKIRTINGUS
 * mazgus, abu perskaito tą pačią pradinę būseną, ir vėlesnis rašymas ištrina ankstesniojo
 * rezultatą — atkurta: po lygiagrečių `A=done` ir `B=done` lieka `A=planned, B=done`.
 *
 * Pasirinktas LOCK'as, o ne CAS: CAS reikalautų `revision` lauko `ArchitectureProgress` DOMENO
 * tipe, o tai paliestų kiekvieną skaitytoją, schemą ir fikstūrą. Lock'as lieka saugyklos viduje
 * ir nekeičia nė vieno kontrakto. Primityvas — tas pats `createLockDirectory` (atominis `mkdir`
 * be `recursive`), kurį jau naudoja ledger lock protokolas.
 */
const LOCK_STALE_MS = 30_000;
const LOCK_POLL_MS = 25;
const LOCK_MAX_WAIT_MS = 5_000;

function progressLockDir(statePath: string): string {
  return `${statePath}.lock`;
}

/**
 * Laiko lock'ą per visą read-modify-write. Nepavykus jo gauti per `LOCK_MAX_WAIT_MS` — METAMA:
 * tylus tęsimas be lock'o būtų lygiai tas pats prarastas atnaujinimas, kurį šis vartas taiso.
 *
 * Užstrigęs (stale) lock'as perimamas pagal katalogo mtime — kritęs procesas neturi teisės
 * amžinai stabdyti bangos. Perėmimo lenktynės (du procesai vienu metu mato stale) baigiasi tuo,
 * kad laimi vienintelis `mkdir` — tai ir yra primityvo prasmė.
 */
async function withProgressLock<T>(statePath: string, work: () => Promise<T>): Promise<T> {
  const lockDir = progressLockDir(statePath);
  // `mkdir` be `recursive` reikalauja esamo tėvo; pirmo `initProgress` metu jo dar gali nebūti.
  await nodeFsAdapter.makeDirectory(path.dirname(statePath));

  const deadline = Date.now() + LOCK_MAX_WAIT_MS;
  for (;;) {
    if ((await nodeFsAdapter.createLockDirectory(lockDir)) === "created") {
      break;
    }
    const heldSinceMs = await nodeFsAdapter.directoryModifiedAtMs(lockDir);
    if (heldSinceMs !== undefined && Date.now() - heldSinceMs > LOCK_STALE_MS) {
      await nodeFsAdapter.removeDirectory(lockDir);
      continue;
    }
    if (Date.now() >= deadline) {
      throw new Error(`architecture progress ledger is locked by another writer: ${lockDir}`);
    }
    await delay(LOCK_POLL_MS);
  }

  try {
    return await work();
  } finally {
    // Best-effort: nepavykęs atlaisvinimas baigsis stale perėmimu, o metimas čia užgožtų
    // tikrąjį `work()` rezultatą arba klaidą.
    await nodeFsAdapter.removeDirectory(lockDir).catch(() => undefined);
  }
}

/** Kanoninis grafo kelias projektui. */
export function architectureGraphPath(projectRoot: string): string {
  return path.join(path.resolve(projectRoot), "vq", "state", "architecture", "graph.json");
}

/** Kanoninis progreso ledger'io kelias projektui. */
export function architectureProgressPath(projectRoot: string): string {
  return path.join(path.resolve(projectRoot), "vq", "state", "architecture", "progress.json");
}

export async function readGraph(statePath: string): Promise<ArchitectureGraph | null> {
  const raw = await nodeFsAdapter.readTextFileIfExists(statePath);
  if (raw === undefined) return null;
  return JSON.parse(raw) as ArchitectureGraph;
}

export async function writeGraph(statePath: string, graph: ArchitectureGraph): Promise<void> {
  await nodeFsAdapter.writeTextFile(statePath, JSON.stringify(graph, null, 2));
}

export async function readProgress(statePath: string): Promise<ArchitectureProgress | null> {
  const raw = await nodeFsAdapter.readTextFileIfExists(statePath);
  if (raw === undefined) return null;
  return JSON.parse(raw) as ArchitectureProgress;
}

export async function writeProgress(statePath: string, progress: ArchitectureProgress): Promise<void> {
  await nodeFsAdapter.writeTextFile(statePath, JSON.stringify(progress, null, 2));
}

/**
 * Inicializuoja (arba atnaujina) progreso ledger'į importuotam grafui. Idempotentiška
 * refresh'ų atžvilgiu: esamo įrašo `done` statusas ir sukaupta evidencija IŠSAUGOMI —
 * visi kiti statusai grįžta į `planned`, nes grafo šaltinis galėjo pasikeisti.
 */
export async function initProgress(graph: ArchitectureGraph, statePath: string): Promise<ArchitectureProgress> {
  // Irgi read-modify-write (saugo `done` ir evidenciją), tad tas pats mutex'as: refresh'as,
  // sutapęs su bangos rašymu, kitaip ištrintų ką tik užbaigtą mazgą.
  return await withProgressLock(statePath, () => initProgressLocked(graph, statePath));
}

async function initProgressLocked(graph: ArchitectureGraph, statePath: string): Promise<ArchitectureProgress> {
  const existing = await readProgress(statePath);

  const nodes: Record<string, ArchitectureNodeProgress> = {};
  for (const node of graph.nodes) {
    const prev = existing?.nodes[node.id];
    const nodeHash = computeArchitectureNodeHash(node, graph.edges);
    const carried = carryDoneStatus(prev, nodeHash);
    nodes[node.id] = {
      status: carried.status,
      attempts: prev?.attempts ?? {},
      queued_tasks: prev?.queued_tasks ?? [],
      done_tasks: prev?.done_tasks ?? [],
      // Evidencija IŠSAUGOMA net nuvertinus statusą: ji yra įrodymas, ką ir kada padarė
      // ankstesnis darbas, ir būtent jos operatoriui reikia sprendžiant, ar `done` galioja.
      // Trinti ją reikštų nubausti už tai, kad pastebėjome pokytį.
      implemented_files: prev?.implemented_files ?? [],
      evidence_refs: prev?.evidence_refs ?? [],
      node_hash: nodeHash,
      ...(prev?.interface_contract !== undefined ? { interface_contract: prev.interface_contract } : {}),
      ...(prev?.verified_at !== undefined ? { verified_at: prev.verified_at } : {}),
      ...(carried.reason !== undefined
        ? { human_review_reason: carried.reason }
        : prev?.human_review_reason !== undefined
          ? { human_review_reason: prev.human_review_reason }
          : {}),
    };
  }

  const progress: ArchitectureProgress = {
    // TURINIO hash'as, ne `imported_at`: laiko žyma keisdavosi kiekvieno importo metu ir
    // nesikeisdavo pasikeitus grafui, tad ji nerodė nei tapatybės, nei kaitos.
    graph_hash: computeArchitectureGraphHash(graph),
    nodes,
  };

  await writeProgress(statePath, progress);
  return progress;
}

/**
 * Ar ankstesnis `done` vis dar galioja NAUJAM mazgo apibrėžimui.
 *
 * `done` yra teiginys apie konkretų darbo vienetą. Pasikeitus etiketei, semantikai ar briaunoms,
 * tai jau kitas vienetas, o senas teiginys apie jį nieko nesako — nors ID ir sutampa. Anksčiau
 * toks mazgas likdavo `done` su senais `implemented_files` ir ATRAKINDAVO downstream.
 *
 * Nuvertinama į `human-review`, o ne į `planned`, sąmoningai: automatinis perdarymas ištrintų
 * žmogaus sprendimą, o tylus `planned` neatsakytų į vienintelį svarbų klausimą — ar ankstesnis
 * darbas vis dar tinka. `human-review` blokuoja downstream (fail-closed) ir reikalauja žvilgsnio.
 *
 * Ledger'is BE `node_hash` (iš laikų prieš šią patikrą) yra NEPATIKRINAMAS. Nežinia čia negali
 * reikšti galiojimo — tas pats principas kaip visur kitur šioje bazėje — tad toks `done` irgi
 * keliauja į peržiūrą. Tai vienkartinė migracijos kaina, matoma ir su aiškia priežastimi.
 */
function carryDoneStatus(
  prev: ArchitectureNodeProgress | undefined,
  nodeHash: string,
): { status: ArchitectureNodeProgress["status"]; reason?: string } {
  if (prev?.status !== "done") {
    return { status: "planned" };
  }
  if (prev.node_hash === nodeHash) {
    return { status: "done" };
  }
  return {
    status: "human-review",
    reason:
      prev.node_hash === undefined
        ? "node was marked done before definition fingerprints existed; re-confirm the work still applies"
        : "node definition changed after it was marked done (label, kind or edges); re-confirm the work still applies",
  };
}

export async function updateNodeProgress(
  statePath: string,
  nodeId: string,
  update: Partial<ArchitectureNodeProgress>,
  clearFields: readonly ("interface_contract" | "verified_at" | "human_review_reason")[] = [],
): Promise<void> {
  // Skaitymas IR rašymas privalo būti VIENOJE kritinėje sekcijoje: skaitymas už lock'o ribų
  // duotų pasenusią bazę, ir vėlesnis rašymas vis tiek ištrintų svetimą mazgą.
  await withProgressLock(statePath, async () => {
    const progress = await readProgress(statePath);
    if (!progress) throw new Error(`Progress ledger not found at: ${statePath}`);
    const existing = progress.nodes[nodeId];
    if (!existing) throw new Error(`Node "${nodeId}" not found in progress at: ${statePath}`);
    const merged = { ...existing, ...update };
    // Etalonas laukus išvalydavo per `laukas: undefined` (JSON.stringify juos numeta);
    // su exactOptionalPropertyTypes tas pats efektas išreiškiamas aiškiu clearFields sąrašu.
    for (const field of clearFields) delete merged[field];
    progress.nodes[nodeId] = merged;
    await writeProgress(statePath, progress);
  });
}
