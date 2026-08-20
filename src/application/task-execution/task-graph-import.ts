// Markdown → kanoninis TaskGraph importas ir blocked-dependents maršrutizavimas (etalono
// orchestrator/tasks/task-dependencies.ts, VQ-304 3/3; spec PDAG-1, RT-07).
//
// Markdown bucket'ai lieka žmogui skirtas task'ų formatas, bet nustoja būti VIENINTELIS
// runtime priklausomybių šaltinis: čia jie deterministiškai importuojami į kanoninį
// `TaskGraph`, kuris turi versiją, hash'ą ir validaciją. Kiekvienas laukas ateina iš to
// paties kanoninio parserio, kurį naudoja likusi sistema — `## Dependencies` per
// `parseTaskDependencies`, `## Failai` per `allowedPaths`, `## Patikra` per
// `parseBacktickChecks`, o patvirtinimo poreikis per `analyzeHumanReviewGates`. Antrų kopijų
// šioms taisyklėms čia nėra ir negali atsirasti (FQC-12). FS — per portus; adapteriai E4.
import {
  allowedPaths,
  analyzeHumanReviewGates,
  dependencyMatches,
  normalizeTaskReference,
  parseTaskDependencies,
  taskBuckets,
  withBlockedNotice,
  type BlockedTaskRoute,
  type TaskBucket,
  type TaskDependencyMetadata,
} from "../../domain/tasks/index.js";
import {
  buildTaskGraph,
  taskNodeStatusFromBucket,
  type TaskGraph,
  type TaskGraphNodeInput,
} from "../../domain/tasks/graph/index.js";
import { parseBacktickChecks } from "../quality-gates/preflight-rules.js";

/** Vienas bucket'o task failas: repo-santykinis POSIX kelias + turinys. */
export type BucketTaskFile = {
  /** Pvz. `AG/tasks/queue/0042.md` — forma, kuri patenka į grafo mazgą ir žurnalus. */
  file: string;
  text: string;
};

/**
 * Bucket'ų skaitymo portas. Adapterio (E4) kontraktas: grąžinami tik `.md` failai,
 * surūšiuoti vardų tvarka (nuo tvarkos priklauso grafo hash'o determinizmas), o katalogo
 * nebuvimas yra tuščias sąrašas, ne klaida.
 */
export type TaskGraphImportPorts = {
  listTasksInBucket(bucket: TaskBucket): Promise<BucketTaskFile[]>;
};

/** Bucket'ai, iš kurių statomas pilnas grafas. Be `done` istorijos priklausomybės atrodytų dingusios. */
export const TASK_GRAPH_IMPORT_BUCKETS: readonly TaskBucket[] = taskBuckets;

/**
 * Vieno task failo turinys → grafo mazgas. Gryna funkcija (jokio FS): tas pats tekstas visada
 * duoda tą patį mazgą, todėl importo taisykles galima padengti testais be darbinio medžio.
 */
export function taskNodeFromMarkdown(taskText: string, taskFile: string, bucket: TaskBucket): TaskGraphNodeInput {
  const metadata = parseTaskDependencies(taskText, taskFile);
  const scope = allowedPaths(taskText);
  const gates = analyzeHumanReviewGates(taskText, scope);
  return {
    task_id: metadata.task_id,
    file: metadata.file,
    status: taskNodeStatusFromBucket(bucket),
    depends_on: metadata.blocked_by,
    checks: parseBacktickChecks(taskText),
    scope,
    // `approved_marker` reiškia, kad žmogus jau priėmė sprendimą; be jo rizikos vartai
    // (`requires_human_review`) yra neįvykdytas patvirtinimo reikalavimas. Tas pats task'as,
    // gulintis human-review bucket'e, taip pat laukia žmogaus.
    requires_approval: gates.requires_human_review || bucket === "human-review",
    approved: gates.approved_marker !== undefined,
  };
}

/** Bucket'ų task metaduomenys (`## Dependencies` parseris) — rūšiuota pagal failą. */
export async function readTaskDependencyMetadata(
  ports: TaskGraphImportPorts,
  buckets: readonly TaskBucket[] = ["queue"],
): Promise<TaskDependencyMetadata[]> {
  const results: TaskDependencyMetadata[] = [];
  for (const bucket of buckets) {
    for (const task of await ports.listTasksInBucket(bucket)) {
      results.push(parseTaskDependencies(task.text, task.file));
    }
  }
  return results.sort((a, b) => a.file.localeCompare(b.file));
}

/**
 * Sudaro kanoninį `TaskGraph` iš Markdown bucket'ų. Grafas NĖRA taisomas: ciklai, dublikatai ir
 * trūkstamos priklausomybės lieka tokie, kokie yra, ir juos raportuoja `validateTaskGraph` —
 * spėjimu grįstas taisymas aiškiai uždraustas.
 */
export async function importTaskGraphFromMarkdown(
  ports: TaskGraphImportPorts,
  buckets: readonly TaskBucket[] = TASK_GRAPH_IMPORT_BUCKETS,
): Promise<TaskGraph> {
  const nodes: TaskGraphNodeInput[] = [];
  for (const bucket of buckets) {
    for (const task of await ports.listTasksInBucket(bucket)) {
      nodes.push(taskNodeFromMarkdown(task.text, task.file, bucket));
    }
  }
  return buildTaskGraph({ nodes });
}

export type BlockedTaskRoutingResult = {
  blocker: string;
  scanned: number;
  routed: BlockedTaskRoute[];
};

/**
 * Blocked-task maršrutizavimo efektai. `moveToHumanReview` privalo išlaikyti etalono
 * `moveTaskState` semantiką (unikalus šaltinis, kolizijos priesaga) ir grąžinti
 * repo-santykinį POSIX kelią, kuris patenka į `BlockedTaskRoute.to`.
 */
export type BlockedTaskRoutingPorts = TaskGraphImportPorts & {
  readTaskText(file: string): Promise<string>;
  writeTaskText(file: string, text: string): Promise<void>;
  moveToHumanReview(file: string): Promise<string>;
};

/**
 * Move every queued task that declared `blocked_by: <blocker>` into human-review,
 * stamping each with a `## Human review block` notice.
 *
 * Du kvietėjai (RT-07): AUTOMATINIS — koordinatoriaus terminalinis human-review nusileidimas
 * (`CompletionPort.cascadeBlockedDependents` adapteris, E4/E5), kad dependent'as niekada
 * nebūtų dispatch'intas, kol jo blocker'is neišspręstas; RANKINIS — CLI escape hatch (E5).
 */
export async function routeBlockedTasksToHumanReview(
  ports: BlockedTaskRoutingPorts,
  blocker: string,
): Promise<BlockedTaskRoutingResult> {
  const normalizedBlocker = normalizeTaskReference(blocker);
  const metadata = await readTaskDependencyMetadata(ports, ["queue"]);
  const routed: BlockedTaskRoute[] = [];

  for (const task of metadata) {
    if (!task.blocked_by.some((dependency) => dependencyMatches(dependency, normalizedBlocker))) continue;
    const original = await ports.readTaskText(task.file).catch(() => undefined);
    if (original === undefined) continue;
    await ports.writeTaskText(task.file, withBlockedNotice(original, normalizedBlocker));
    const target = await ports.moveToHumanReview(task.file);
    routed.push({
      task_id: task.task_id,
      from: task.file,
      to: target,
      blocked_by: normalizedBlocker,
    });
  }

  return { blocker: normalizedBlocker, scanned: metadata.length, routed };
}
