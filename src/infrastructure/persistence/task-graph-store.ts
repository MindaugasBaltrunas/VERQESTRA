// Kanoninio task grafo persistencija (etalonas: AG_loop task-graph-store.ts; task 1112,
// PDAG-1). Dvi savybės: RAŠYMAS atominis (tmp + rename — krachas palieka ankstesnį
// snapshot'ą), SKAITYMAS validuojamas prieš pasitikint (schema + graph_hash; nepraėjęs
// vartų snapshot'as raportuojamas corrupted — niekada netaisomas ir nenaudojamas dalinai).
// Taisyklės (hash, validacija) — domain; čia tik failo formatas ir failų sistema.
// VERQESTRA kelias: vq/state/task-graph.json; schema — zod prie modulio (etalono
// core/schema task-graph blokas).

import path from "node:path";
import { z } from "zod";
import {
  TASK_DEPENDENCY_ORIGINS,
  TASK_GRAPH_RULES_VERSION,
  TASK_GRAPH_SCHEMA_VERSION,
  TASK_NODE_STATUSES,
  validateTaskGraph,
  type TaskGraph,
  type TaskGraphValidation,
} from "../../domain/tasks/graph/index.js";
import { toPrettyJson } from "../../shared/json.js";
import { validateWithSchema } from "../../shared/schema.js";
import { nodeFsAdapter } from "../fs/node-fs-adapter.js";

export const TASK_GRAPH_SNAPSHOT_FILE = "task-graph.json";

const taskGraphSnapshotNodeSchema = z.looseObject({
  task_id: z.string().min(1),
  file: z.string().min(1),
  status: z.enum(TASK_NODE_STATUSES),
  checks: z.array(z.string()),
  scope: z.array(z.string()),
  requires_approval: z.boolean(),
  approved: z.boolean(),
  estimated_tokens: z.number().int().nonnegative().optional(),
});

export const taskGraphSnapshotSchema = z.looseObject({
  schema_version: z.number().int().positive(),
  rules_version: z.number().int().positive(),
  graph_hash: z.string().min(1),
  source: z.string().optional(),
  generated_at: z.string().optional(),
  nodes: z.array(taskGraphSnapshotNodeSchema),
  dependencies: z.array(
    z.looseObject({
      task_id: z.string().min(1),
      depends_on: z.string().min(1),
      origin: z.enum(TASK_DEPENDENCY_ORIGINS),
    }),
  ),
});

export type TaskGraphSnapshot = z.infer<typeof taskGraphSnapshotSchema>;

export function taskGraphStateDir(runtimeRoot: string): string {
  return path.join(runtimeRoot, "state");
}

export function taskGraphSnapshotPath(runtimeRoot: string): string {
  return path.join(taskGraphStateDir(runtimeRoot), TASK_GRAPH_SNAPSHOT_FILE);
}

export type TaskGraphSnapshotOptions = {
  /** Iš kur grafas importuotas, pvz. `markdown:queue,active,done`. Tik diagnostika. */
  source?: string;
  /** ISO laiko žyma — paduodama, o ne skaitoma iš laikrodžio. */
  generatedAt?: string;
};

export function toTaskGraphSnapshot(graph: TaskGraph, options: TaskGraphSnapshotOptions = {}): TaskGraphSnapshot {
  return taskGraphSnapshotSchema.parse({
    schema_version: graph.schema_version,
    rules_version: graph.rules_version,
    graph_hash: graph.graph_hash,
    source: options.source,
    generated_at: options.generatedAt,
    nodes: graph.nodes,
    dependencies: graph.dependencies,
  });
}

export function taskGraphFromSnapshot(snapshot: TaskGraphSnapshot): TaskGraph {
  return {
    schema_version: snapshot.schema_version,
    rules_version: snapshot.rules_version,
    graph_hash: snapshot.graph_hash,
    nodes: snapshot.nodes.map((node) => ({
      task_id: node.task_id,
      file: node.file,
      status: node.status,
      checks: [...node.checks],
      scope: [...node.scope],
      requires_approval: node.requires_approval,
      approved: node.approved,
      ...(node.estimated_tokens === undefined ? {} : { estimated_tokens: node.estimated_tokens }),
    })),
    dependencies: snapshot.dependencies.map((edge) => ({
      task_id: edge.task_id,
      depends_on: edge.depends_on,
      origin: edge.origin,
    })),
  };
}

/**
 * Rašo snapshot'ą atomiškai ir grąžina jo kelią. Grafas, kurio hash nesutampa su turiniu,
 * atmetamas ČIA, o ne persistinamas; ciklinis/nevykdomas grafas RAŠOMAS — operatorius turi
 * jį matyti, o skaitymas grąžins jį kaip nevykdomą.
 */
export async function writeTaskGraphSnapshot(
  graph: TaskGraph,
  runtimeRoot: string,
  options: TaskGraphSnapshotOptions = {},
): Promise<string> {
  const validation = validateTaskGraph(graph);
  const fatal = validation.violations.filter(
    (entry) => entry.code === "graph-hash-mismatch" || entry.code === "schema-version-mismatch",
  );
  if (fatal.length > 0) {
    throw new Error(`task graph snapshot refused: ${fatal.map((entry) => entry.message).join("; ")}`);
  }

  const snapshot = toTaskGraphSnapshot(graph, options);
  const target = taskGraphSnapshotPath(runtimeRoot);
  await nodeFsAdapter.writeTextFile(target, toPrettyJson(snapshot));
  return target;
}

/** Kodėl saugomu snapshot'u negalima pasitikėti. */
export type TaskGraphReadFailure = "missing" | "invalid-json" | "schema" | "corrupted";

export type TaskGraphReadResult =
  | { ok: true; graph: TaskGraph; snapshot: TaskGraphSnapshot; validation: TaskGraphValidation }
  | { ok: false; reason: TaskGraphReadFailure; errors: string[] };

/**
 * Skaito ir validuoja snapshot'ą. Kiekviena nesėkmė aiški ir tipizuota: kvietėjas
 * sprendžia, ar perstatyti grafą iš Markdown, ar sustoti — bet niekada negauna grafo,
 * kuris nebuvo įrodytas vientisu. `ok: true` neša ir validacijos rezultatą: snapshot'as
 * gali būti tiksli NEVYKDOMO grafo kopija — tai kita klaida su kitu vaistu.
 */
export async function readTaskGraphSnapshot(runtimeRoot: string): Promise<TaskGraphReadResult> {
  const target = taskGraphSnapshotPath(runtimeRoot);
  const raw = await nodeFsAdapter.readTextFileIfExists(target);
  if (raw === undefined || !raw.trim()) {
    return { ok: false, reason: "missing", errors: [`no task graph snapshot at ${target}`] };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    return {
      ok: false,
      reason: "invalid-json",
      errors: [`task graph snapshot is not valid JSON: ${error instanceof Error ? error.message : String(error)}`],
    };
  }

  const validated = validateWithSchema(taskGraphSnapshotSchema, parsed);
  if (!validated.ok) {
    return { ok: false, reason: "schema", errors: validated.errors };
  }

  if (validated.data.rules_version !== TASK_GRAPH_RULES_VERSION) {
    // Grafas normalizuotas ir hash'uotas pagal kitas taisykles — jo hash nepalyginamas su
    // čia skaičiuojamu. Vienintelis teisingas atsakymas — perstatyti iš šaltinio.
    return {
      ok: false,
      reason: "corrupted",
      errors: [
        `task graph snapshot rules version ${validated.data.rules_version} is not the supported ${TASK_GRAPH_RULES_VERSION}`,
      ],
    };
  }

  const graph = taskGraphFromSnapshot(validated.data);
  const validation = validateTaskGraph(graph);
  const corrupted = validation.violations.filter(
    (entry) => entry.code === "graph-hash-mismatch" || entry.code === "schema-version-mismatch",
  );
  if (corrupted.length > 0) {
    return { ok: false, reason: "corrupted", errors: corrupted.map((entry) => entry.message) };
  }

  return { ok: true, graph, snapshot: validated.data, validation };
}

/** Schema versija, kurią šis build'as skaito ir rašo. Re-eksportas — vienas importas kvietėjui. */
export { TASK_GRAPH_SCHEMA_VERSION };
