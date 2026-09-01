// Architektūros grafo ir progreso ledger'io IO (etalonai: AG_loop architecture/
// architecture-graph.ts skaitymo/rašymo pusė ir architecture/architecture-progress.ts 1:1).
// Tipai ir grynos taisyklės gyvena domain/architecture; čia — tik JSON failai. Kanoniniai
// keliai VERQESTRA layout'e: `vq/state/architecture/{graph.json,progress.json}` (kelius
// paduoda kvietėjas — saugykla jų neužkoduoja, kaip ir etalonas).

import path from "node:path";
import { z } from "zod";
import {
  computeArchitectureGraphHash,
  computeArchitectureNodeHash,
  type ArchitectureGraph,
  type ArchitectureNodeProgress,
  type ArchitectureProgress,
} from "../../domain/architecture/index.js";
import { parseWithSchema } from "../../shared/schema.js";
import { nodeFsAdapter } from "../fs/node-fs-adapter.js";
import { withStateFileLock } from "../fs/state-file-lock.js";

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
 *
 * 2026-08-23: pati mechanika iškelta į `infrastructure/fs/state-file-lock`, nes jos prireikė ir
 * retry skaitikliams. Čia liko tik kvietimas — antra to paties protokolo kopija būtų išsiskyrusi
 * tyliai, kaip jau atsitiko su grafo algoritmais.
 */
const withProgressLock = withStateFileLock;

/**
 * `vq/state/architecture/{graph,progress}.json` FORMOS schemos (zod prie modulio — ta pati
 * vieta, kur jas laiko `runtime-attempt-schema` ir `task-graph-store`; domenas visame repo
 * neturi nė vieno išorinio importo, tad zod ten būtų naujas precedentas, o ne esamo tęsinys).
 *
 * Kodėl apskritai: iki 2026-09-01 abu skaitymai buvo `JSON.parse(raw) as ArchitectureGraph` —
 * `as` čia nieko netikrina, tad svetimos formos failas keliaudavo gilyn kaip „teisingas" ir
 * lūždavo toli nuo priežasties. Blogesnis atvejis buvo tylus: `initProgress` idempotencija
 * remiasi būtent laukų forma (`prev.status === "done"`, `prev.node_hash`), tad progresas be
 * `nodes` objekto atrodydavo kaip „mazgų nėra" ir refresh'as perrašydavo ledger'į švariais
 * `planned` įrašais — kartu su visa sukaupta evidencija.
 *
 * `looseObject`, o ne `object`: abi saugyklos funkcijos yra read-modify-write per VISĄ failą,
 * tad nežinomo lauko nuvalymas parse metu jį NUTRINTŲ diske per artimiausią rašymą. Schema
 * tikrina tai, ką pažįsta, ir praleidžia tai, ko ne.
 */
const architectureNodeStatusSchema = z.enum([
  "planned",
  "ready",
  "queued",
  "active",
  "repairing",
  "done",
  "human-review",
]);

const architectureNodeSchema = z.looseObject({
  id: z.string(),
  label: z.string(),
  kind: z.enum(["component", "input", "adapter", "store", "gate", "report", "unknown"]),
  status: architectureNodeStatusSchema,
  description: z.string().optional(),
  external: z.boolean().optional(),
});

const architectureEdgeSchema = z.looseObject({
  from: z.string(),
  to: z.string(),
  label: z.string().optional(),
  type: z.enum(["depends_on", "produces", "consumes", "validates", "unknown"]),
});

const architectureGraphSchema = z.looseObject({
  source_path: z.string(),
  imported_at: z.string(),
  nodes: z.array(architectureNodeSchema),
  edges: z.array(architectureEdgeSchema),
});

const nodeInterfaceContractSchema = z.looseObject({
  inputs: z.array(z.string()),
  outputs: z.array(z.string()),
  upstream: z.array(z.string()),
  downstream: z.array(z.string()),
  public_exports: z.array(z.string()),
  checks: z.array(z.string()),
});

const architectureNodeProgressSchema = z.looseObject({
  status: architectureNodeStatusSchema,
  attempts: z.record(z.string(), z.number()),
  queued_tasks: z.array(z.string()),
  done_tasks: z.array(z.string()),
  implemented_files: z.array(z.string()),
  interface_contract: nodeInterfaceContractSchema.optional(),
  evidence_refs: z.array(z.string()),
  verified_at: z.string().optional(),
  human_review_reason: z.string().optional(),
  node_hash: z.string().optional(),
});

const architectureProgressSchema = z.looseObject({
  graph_hash: z.string(),
  nodes: z.record(z.string(), architectureNodeProgressSchema),
});

/**
 * zod `.optional()` išveda `x?: T | undefined`, o domeno tipas su `exactOptionalPropertyTypes`
 * rašo `x?: T`. Skirtumas yra tik apie EXPLICIT `undefined` reikšmę, kurios JSON'e fiziškai
 * negali būti: `JSON.parse` niekada negrąžina lauko, kurio reikšmė yra `undefined` — jo arba
 * nėra, arba jis turi tikrą reikšmę. Šis tipas tą faktą užrašo, kad JAU validuotas rezultatas
 * būtų tiesiogiai priskiriamas domeno tipui.
 *
 * Tą patį skirtumą `context-pack/assemble/tiers.ts` sprendžia iš kitos pusės — pritaikydamas
 * VARTOTOJO tipą schemos išvesčiai. Čia vartotojas yra domeno kontraktas, kurio ši užduotis
 * neliečia, tad taikosi schemos pusė.
 */
type JsonParsed<T> = T extends readonly (infer E)[]
  ? JsonParsed<E>[]
  : T extends object
    ? { [K in keyof T]: JsonParsed<Exclude<T[K], undefined>> }
    : T;

/**
 * Vienas parse'inimo kelias abiem būsenos failams: JSON sintaksė ir forma tikrinamos ATSKIRAI,
 * kad klaidos tekstas pasakytų, kuri iš dviejų sulūžo. Label'is — TIK basename: pilnas kelias
 * yra absoliutus ir priklauso nuo mašinos, o klaidai užtenka pasakyti, KURIS failas sugedęs.
 *
 * Metama, o ne grąžinama `null`, sąmoningai. `null` šioje saugykloje reiškia „failo nėra", o
 * kvietėjai tą traktuoja kaip leidimą kurti iš naujo: `initProgressLocked` po `null` parašo
 * švarų ledger'į, `bootstrap-project` ir `generate` — tęsia be architektūros. Sugadintas
 * failas, virtęs „failo nėra", būtų tyliai perrašytas, ir įrodymai dingtų be pėdsako.
 * Metimas taip pat yra ESAMO elgesio tęsinys: neparse'inamas JSON čia mesdavo ir iki šiol —
 * pasikeitė tik tai, kad „sugadintas" nebereiškia vien sintaksės.
 *
 * Grąžinamas `JsonParsed<T>`, ir būtent tai laiko schemą prirakintą prie domeno tipo: abu
 * skaitytojai deklaruoja domeno grąžinimo tipą, tad schemai praradus lauką (ar domeno tipui
 * įgijus naują privalomą) `return` nustoja kompiliuotis. Vartas, ne dokumentacija.
 */
function parseArchitectureStateFile<T>(schema: z.ZodType<T>, raw: string, statePath: string): JsonParsed<T> {
  const label = path.basename(statePath);
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`${label} is not valid JSON: ${message}`, { cause: error });
  }
  // Vienintelis `as` kelyje ir jis NĖRA validacijos pakaitalas: reikšmė ką tik praėjo schemą,
  // o čia nuimamas tik `| undefined`, kurio JSON'as pagal apibrėžimą negali turėti (JsonParsed).
  return parseWithSchema(schema, parsed, label) as JsonParsed<T>;
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
  return parseArchitectureStateFile(architectureGraphSchema, raw, statePath);
}

export async function writeGraph(statePath: string, graph: ArchitectureGraph): Promise<void> {
  await nodeFsAdapter.writeTextFile(statePath, JSON.stringify(graph, null, 2));
}

export async function readProgress(statePath: string): Promise<ArchitectureProgress | null> {
  const raw = await nodeFsAdapter.readTextFileIfExists(statePath);
  if (raw === undefined) return null;
  return parseArchitectureStateFile(architectureProgressSchema, raw, statePath);
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
