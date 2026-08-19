// Ready set iš kanoninio TaskGraph (task 1112; spec PDAG-1, design §9 „Persistent DAG").
// Behaviour etalon: AG_loop application/scheduling/build-ready-set.ts (1:1).
//
// `schedule-next-wave.ts` atsako į klausimą „kokia yra ŠIOS bangos tvarka"; šis modulis —
// į siauresnį, žemesnį: „kuriuos kanoninio grafo mazgus apskritai LEIDŽIAMA vykdyti dabar"
// — pagal priklausomybes, task būseną, patvirtinimą ir biudžetą. Bangų numeracija, wave_id
// ir vieno workerio limitas čia neegzistuoja; tai grynas vartų rinkinys.
//
// Modulis yra grynas: jokio IO, laikrodžio ar atsitiktinumo. Tie patys įėjimai visada duoda
// tą patį ready set'ą ta pačia tvarka, todėl po proceso restart'o iš snapshot'o atkurtas
// grafas duoda identišką rezultatą (task 1112 Stop sąlyga).
import { normalizeTaskReference } from "../../domain/tasks/dependencies.js";
import {
  dependenciesOf,
  isTerminalTaskNodeStatus,
  resolveTaskNode,
  satisfiesDependency,
  taskGraphDepths,
  validateTaskGraph,
  type TaskGraph,
  type TaskGraphViolation,
  type TaskNode,
  type TaskNodeStatus,
} from "../../domain/tasks/graph/index.js";

export type ReadySetBlockedReason =
  /** Grafas neįvykdomas (ciklas, dublikatas, hash/schema neatitikimas) — nevykdomas NIEKAS. */
  | "graph-invalid"
  /** Mazgas nėra eilėje (vykdomas, blokuotas, žlugęs arba laukia žmogaus). */
  | "not-queued"
  /** Bent viena priklausomybė dar neįvykdyta. */
  | "unsatisfied-dependency"
  /** Priklausomybė ilsisi terminalinėje būsenoje, kuri niekada jos nepatenkins. */
  | "invalid-terminal-dependency"
  /** Priklausomybės atitikmens grafe nėra — grafas nepilnas, spėti negalima. */
  | "missing-dependency"
  /** Mazgas dalyvauja cikle. */
  | "dependency-cycle"
  /** Reikalingas žmogaus patvirtinimas, kurio dar nėra. */
  | "approval-required"
  /** Biudžetas išnaudotas — negalima pradėti jokio naujo darbo. */
  | "budget-exhausted"
  /** Biudžeto likučio nepakanka šio konkretaus task'o įverčiui. */
  | "budget-insufficient";

export type ReadyTask = {
  task_id: string;
  file: string;
  /** Ilgiausias kelias iki mazgo grafe — deterministinės tvarkos pirmas raktas. */
  depth: number;
  depends_on: string[];
};

export type BlockedTask = {
  task_id: string;
  file: string;
  reason: ReadySetBlockedReason;
  depends_on: string[];
  /** Konkrečios priklausomybės, dėl kurių mazgas dar nevykdomas. */
  waiting_for: string[];
};

export type ReadySet = {
  graph_hash: string;
  /** `false`, kai grafas turi grafo lygio klaidą; tada `ready` visada tuščias. */
  executable: boolean;
  ready: ReadyTask[];
  blocked: BlockedTask[];
  /** Grafo validacijos radiniai — tie patys, kuriuos grąžina `validateTaskGraph`. */
  violations: TaskGraphViolation[];
};

/** Biudžeto būsena vartams. Be jos biudžetas neriboja nieko. */
export type ReadySetBudget = {
  /** Likę tokenai. `0` arba mažiau = išnaudota. */
  remaining_tokens?: number;
  /** Aiškus „biudžetas išnaudotas" signalas, nepriklausomas nuo likučio skaičiavimo. */
  exhausted?: boolean;
};

export type BuildReadySetInput = {
  graph: TaskGraph;
  /**
   * Runtime būsenos, perrašančios snapshot'e užfiksuotas. Loop'as jomis perduoda tai, kas
   * pasikeitė nuo snapshot'o rašymo (pvz. ką tik užbaigtą task'ą), nepersirašydamas grafo.
   */
  statusOverrides?: Iterable<readonly [string, TaskNodeStatus]>;
  /** Task'ai, kurių žmogaus patvirtinimas gautas šiame run'e. */
  approvals?: Iterable<string>;
  budget?: ReadySetBudget;
};

function normalizeOverrides(input: BuildReadySetInput): Map<string, TaskNodeStatus> {
  const overrides = new Map<string, TaskNodeStatus>();
  for (const [taskId, status] of input.statusOverrides ?? []) {
    const normalized = normalizeTaskReference(taskId);
    if (normalized) overrides.set(normalized, status);
  }
  return overrides;
}

function normalizeApprovals(input: BuildReadySetInput): Set<string> {
  const approvals = new Set<string>();
  for (const taskId of input.approvals ?? []) {
    const normalized = normalizeTaskReference(taskId);
    if (normalized) approvals.add(normalized);
  }
  return approvals;
}

function blocked(node: TaskNode, dependsOn: string[], reason: ReadySetBlockedReason, waitingFor: string[] = []): BlockedTask {
  return {
    task_id: node.task_id,
    file: node.file,
    reason,
    depends_on: dependsOn,
    waiting_for: [...new Set(waitingFor)].sort(),
  };
}

/**
 * Vienintelė vieta, kur gimsta sprendimas „šitą galima vykdyti dabar". Vartai taikomi
 * griežta tvarka, ir tvarka yra pati taisyklė:
 *
 *  0. Grafo lygio klaida — NIEKAS nevykdoma (spėti draudžia design §9).
 *  1. Mazgo būsena: `done` iškrenta visai; viskas, kas nėra `queued`, užimta arba užversta.
 *  2. Ciklo dalyvis — niekada netaps ready be žmogaus.
 *  3. Priklausomybės: neegzistuojanti, terminalinė nepatenkinama arba dar neužbaigta.
 *  4. Patvirtinimas: `requires_approval` be `approved` — sprendimas priklauso žmogui.
 *  5. Biudžetas: išnaudotas stabdo viską; įverčio netelpantis task'as — tik save.
 *
 * Tvarka lemia, kurią priežastį mato operatorius — nuo bendriausios prie konkrečiausios.
 */
export function buildReadySet(input: BuildReadySetInput): ReadySet {
  const { graph } = input;
  const validation = validateTaskGraph(graph);
  const overrides = normalizeOverrides(input);
  const approvals = normalizeApprovals(input);
  const depths = taskGraphDepths(graph);
  const cycleMembers = new Set(validation.cycles.flat());
  const budget = input.budget ?? {};
  const remaining = budget.remaining_tokens;
  const budgetExhausted = budget.exhausted === true || (remaining !== undefined && remaining <= 0);

  const statusOf = (node: TaskNode): TaskNodeStatus => overrides.get(node.task_id) ?? node.status;

  const ready: ReadyTask[] = [];
  const blockedTasks: BlockedTask[] = [];

  for (const node of graph.nodes) {
    const dependsOn = dependenciesOf(graph, node.task_id);
    const status = statusOf(node);

    if (!validation.executable) {
      blockedTasks.push(blocked(node, dependsOn, "graph-invalid"));
      continue;
    }

    if (satisfiesDependency(status)) continue;

    if (status !== "queued") {
      blockedTasks.push(blocked(node, dependsOn, "not-queued"));
      continue;
    }

    if (cycleMembers.has(node.task_id)) {
      blockedTasks.push(blocked(node, dependsOn, "dependency-cycle", dependsOn));
      continue;
    }

    const missing: string[] = [];
    const terminal: string[] = [];
    const unsatisfied: string[] = [];
    for (const reference of dependsOn) {
      const blocker = resolveTaskNode(graph, reference);
      if (!blocker) {
        missing.push(reference);
        continue;
      }
      const blockerStatus = statusOf(blocker);
      if (satisfiesDependency(blockerStatus)) continue;
      if (isTerminalTaskNodeStatus(blockerStatus)) terminal.push(reference);
      else unsatisfied.push(reference);
    }

    if (missing.length > 0) {
      blockedTasks.push(blocked(node, dependsOn, "missing-dependency", missing));
      continue;
    }
    if (terminal.length > 0) {
      blockedTasks.push(blocked(node, dependsOn, "invalid-terminal-dependency", terminal));
      continue;
    }
    if (unsatisfied.length > 0) {
      blockedTasks.push(blocked(node, dependsOn, "unsatisfied-dependency", unsatisfied));
      continue;
    }

    if (node.requires_approval && !node.approved && !approvals.has(node.task_id)) {
      blockedTasks.push(blocked(node, dependsOn, "approval-required"));
      continue;
    }

    if (budgetExhausted) {
      blockedTasks.push(blocked(node, dependsOn, "budget-exhausted"));
      continue;
    }
    if (remaining !== undefined && node.estimated_tokens !== undefined && node.estimated_tokens > remaining) {
      blockedTasks.push(blocked(node, dependsOn, "budget-insufficient"));
      continue;
    }

    ready.push({ task_id: node.task_id, file: node.file, depth: depths.get(node.task_id) ?? 0, depends_on: dependsOn });
  }

  // Deterministinė tvarka: pirma seklesni mazgai (jų atblokuoja daugiau), tada task ID. ID,
  // o ne failo vardas, nes ID nesikeičia task'ui persikėlus tarp bucket'ų — todėl po
  // restart'o tvarka atkuriama identiškai.
  ready.sort((a, b) => a.depth - b.depth || a.task_id.localeCompare(b.task_id));
  blockedTasks.sort((a, b) => a.task_id.localeCompare(b.task_id));

  return {
    graph_hash: graph.graph_hash,
    executable: validation.executable,
    ready,
    blocked: blockedTasks,
    violations: validation.violations,
  };
}
