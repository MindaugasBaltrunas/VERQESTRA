// Wave scheduler — vienas workeris, persistuojamas DAG (task 1113; spec WAVE-1/WAVE-2,
// design §10 „Wave scheduling"). Behaviour etalon: AG_loop application/scheduling/
// schedule-next-wave.ts (1:1; placeholder'ių aibė — iš domain/tasks, FQC-12).
//
// Čia gyvena VISOS bangos tvarkos taisyklės — grynos ir deterministinės: jokio IO, jokio
// laikrodžio, jokio atsitiktinumo. Tie patys įėjimai visada duoda tą patį planą, todėl
// planą galima atkurti iš snapshot'o ir palyginti su `graph_hash`. Visas FS/git/dispatch
// darbas lieka kompozicijos sluoksnyje.
//
// Sąmoningi apribojimai: `max_workers` pagal nutylėjimą 1 ir NIEKADA neviršija 2 (WRK-3);
// sprendimą „ar antras workeris apskritai leidžiamas" priima worker-pool pagal
// conflict-detector verdiktą. Grafas statomas iš to, kas TUO METU yra eilėje.
import { createHash } from "node:crypto";
import { canonicalJsonStringify } from "../../shared/json.js";
import { toPosixPath as toPosix } from "../../shared/paths.js";
import { dependencyMatches, isPlaceholderDependency, normalizeTaskReference } from "../../domain/tasks/dependencies.js";
import { RUNTIME_MAX_WORKERS } from "./worker-limits.js";
import type { ReadySetBlockedReason } from "./build-ready-set.js";

/** Planavimo TAISYKLIŲ versija. Įeina į `graph_hash`, tad pakeitus taisykles seni snapshot'ai tampa stale. */
export const WAVE_SCHEDULER_VERSION = 1;

/**
 * Numatytasis workerių skaičius. Banga vykdo VIENĄ task'ą vienu metu, nebent iškvietėjas
 * aiškiai paprašo daugiau IR conflict detector'ius įrodo nepriklausomumą (worker-pool).
 */
export const WAVE_MAX_WORKERS = 1;

/** Hard limitas (spec WRK-3, design §13) — bendras su runtime namespace ir worker pool'u. */
export const WAVE_WORKER_HARD_CAP = RUNTIME_MAX_WORKERS;

/**
 * Prašomas workerių skaičius, apkirptas iki `[1, WAVE_WORKER_HARD_CAP]`. Tai vis dar tik
 * bangos CAP — ar antras workeris realiai gauna slot'ą, sprendžia worker-pool izoliacijos
 * vartai. Numatytasis kelias (1) nesikeičia.
 */
export function clampWaveWorkers(requested: number | undefined): number {
  if (requested === undefined || !Number.isFinite(requested)) return WAVE_MAX_WORKERS;
  return Math.min(WAVE_WORKER_HARD_CAP, Math.max(1, Math.trunc(requested)));
}

export type SchedulableTask = {
  task_id: string;
  /** Repo-relative task failo kelias (POSIX skirtukai) — dispatch'o adresas. */
  file: string;
  blocked_by: readonly string[];
};

/**
 * Kanoninio grafo vartas, pašalinęs task'ą iš bangos (task 0001; žr. apply-ready-set-gates).
 * `gate:` prefiksas atskiria grafo vartą nuo bangos taisyklės, kad snapshot'o skaitytojas jų
 * nesumaišytų: bangos priežastis kyla iš eilės būsenos, varto — iš kanoninio grafo.
 */
export type WaveGateBlockedReason = `gate:${ReadySetBlockedReason}`;

export type WaveBlockedReason =
  /** Pats task'as priklauso šakai, kuri šiame run'e jau lūžo. */
  | "branch-blocked"
  /** Bent viena priklausomybė dar neįvykdyta (arba jos šaka blokuota). */
  | "unsatisfied-dependency"
  /** Task'as dalyvauja priklausomybių cikle — be žmogaus jis niekada netaps ready. */
  | "dependency-cycle"
  /**
   * Kanoninio grafo perskaityti nepavyko, tad NĖ VIENO task'o leidimo įrodyti neįmanoma
   * (žr. `apply-ready-set-gates#blockWaveWithoutGraph`). Atskiras nuo `gate:` priežasčių:
   * ten grafas pasakė „ne", o čia jis apskritai nieko nepasakė.
   */
  | "gate:graph-unavailable"
  /** Task'ą sustabdė kanoninio grafo vartas, o ne pati banga. */
  | WaveGateBlockedReason;

export type WaveReadyTask = {
  task_id: string;
  file: string;
  /** Ilgiausias kelias iki šio mazgo grafe; naudojamas deterministinei tvarkai. */
  depth: number;
  blocked_by: string[];
};

export type WaveBlockedTask = {
  task_id: string;
  file: string;
  reason: WaveBlockedReason;
  blocked_by: string[];
  /** Konkrečios priklausomybės, dėl kurių task'as dar nevykdomas. */
  waiting_for: string[];
};

export type WavePlan = {
  scheduler_version: number;
  wave_id: string;
  wave_sequence: number;
  graph_hash: string;
  max_workers: number;
  /** Vykdytini task'ai deterministine tvarka (depth, tada failo vardas). */
  ready: WaveReadyTask[];
  blocked: WaveBlockedTask[];
  /**
   * Priklausomybės, kurių atitikmens NĖRA kandidatų rinkinyje. Laikomos įvykdytomis už
   * bangos ribų (task'as, kuris jau paliko eilę), bet fiksuojamos snapshot'e, kad
   * „missing dependency" liktų matomas diagnostikai (spec DAG-1).
   */
  external_dependencies: string[];
  /** Aptikti ciklai; kiekvienas — surūšiuotas dalyvių ID rinkinys. */
  cycles: string[][];
  /**
   * Kodėl kanoninio grafo nebuvo, kai jis privalėjo būti. Užpildoma TIK fail-closed kelyje
   * (`blockWaveWithoutGraph`), tad jos buvimas pats savaime yra „banga sustabdyta be verdikto".
   */
  graph_unavailable_reason?: string;
};

export type ScheduleNextWaveInput = {
  tasks: readonly SchedulableTask[];
  /** Task'ai, kurių darbas jau priimtas (commit arba done) — jų priklausomybės tenkinamos. */
  completedTaskIds?: Iterable<string>;
  /** Šiame run'e lūžusios šakos: patys blokatoriai IR jų tranzityvūs priklausiniai. */
  blockedTaskIds?: Iterable<string>;
  /** Bangos numeris run'o viduje (1-based). Determinizmui — jokio laikrodžio. */
  waveSequence?: number;
  /** Kiek workerių banga gali užimti; apkerpama iki `[1, WAVE_WORKER_HARD_CAP]`. */
  maxWorkers?: number;
};

function matchesAny(reference: string, candidates: ReadonlySet<string>): boolean {
  for (const candidate of candidates) {
    if (dependencyMatches(reference, candidate)) return true;
  }
  return false;
}

/**
 * Kanoninė kandidatų forma: normalizuoti ID, POSIX keliai, be dublikatų, be placeholder'ių
 * ir be nuorodų į patį save (savęs nuoroda kitaip užrakintų task'ą amžiams). Rūšiuojama
 * pagal failo vardą — tokia pat tvarka, kokią grąžina eilės sąrašas, todėl be
 * priklausomybių elgsena nesiskiria nuo ligšiolinės.
 */
export function normalizeSchedulableTasks(tasks: readonly SchedulableTask[]): SchedulableTask[] {
  const byId = new Map<string, SchedulableTask>();
  const ordered = [...tasks].sort((a, b) => toPosix(a.file).localeCompare(toPosix(b.file)));

  for (const task of ordered) {
    const taskId = normalizeTaskReference(task.task_id);
    if (!taskId || byId.has(taskId)) continue;

    const dependencies = [...new Set((task.blocked_by ?? []).map((value) => normalizeTaskReference(value)))]
      .filter((value) => value && !isPlaceholderDependency(value) && !dependencyMatches(value, taskId))
      .sort();

    byId.set(taskId, { task_id: taskId, file: toPosix(task.file), blocked_by: dependencies });
  }

  return [...byId.values()].sort((a, b) => a.file.localeCompare(b.file));
}

/**
 * Grafo atspaudas: tie patys mazgai, keliai ir briaunos → tas pats hash. Snapshot'as ir
 * resume checkpoint'as jį neša kartu, todėl po restart'o galima deterministiškai atskirti
 * „tas pats planas" nuo „grafas pasikeitė, checkpoint'as stale".
 */
export function computeGraphHash(tasks: readonly SchedulableTask[]): string {
  const nodes = normalizeSchedulableTasks(tasks)
    .map((task) => ({ id: task.task_id, file: task.file, deps: [...task.blocked_by] }))
    .sort((a, b) => a.id.localeCompare(b.id));
  const digest = createHash("sha256")
    .update(canonicalJsonStringify({ rules: WAVE_SCHEDULER_VERSION, nodes }), "utf8")
    .digest("hex");
  return `wg${WAVE_SCHEDULER_VERSION}:${digest.slice(0, 16)}`;
}

/** Bangos ID: deterministinis run'o viduje (jokio laikrodžio ir jokio UUID). */
export function waveIdFor(sequence: number, graphHash: string): string {
  return `w${Math.max(1, Math.trunc(sequence))}-${graphHash.split(":").pop() ?? graphHash}`;
}

/**
 * Priklausomybės nuoroda → task ID kandidatų rinkinyje, arba `undefined`, jei tokio task'o
 * bangoje nėra (tada priklausomybė yra „external"). Dviprasmiškas prefiksas išsprendžiamas
 * deterministiškai — pirmas pagal failo tvarką.
 */
function resolveDependency(dependency: string, tasks: readonly SchedulableTask[]): string | undefined {
  const exact = tasks.find((task) => task.task_id === dependency);
  if (exact) return exact.task_id;
  return tasks.find((task) => dependencyMatches(dependency, task.task_id))?.task_id;
}

type ResolvedNode = {
  task: SchedulableTask;
  /** Priklausomybės, nurodančios į kitą TOS PAČIOS bangos task'ą. */
  internal: string[];
  /** Priklausomybės, kurių bangoje nėra. */
  external: string[];
};

function resolveNodes(tasks: readonly SchedulableTask[]): ResolvedNode[] {
  return tasks.map((task) => {
    const internal: string[] = [];
    const external: string[] = [];
    for (const dependency of task.blocked_by) {
      const resolved = resolveDependency(dependency, tasks);
      if (resolved) internal.push(resolved);
      else external.push(dependency);
    }
    return { task, internal: [...new Set(internal)].sort(), external: [...new Set(external)].sort() };
  });
}

/** Mazgai, pasiekiami iš `start` einant priklausomybių briaunomis (task → jo blokatoriai). */
function dependencyClosure(start: string, edges: ReadonlyMap<string, string[]>): Set<string> {
  const seen = new Set<string>();
  const stack = [...(edges.get(start) ?? [])];
  while (stack.length > 0) {
    const current = stack.pop() as string;
    if (seen.has(current)) continue;
    seen.add(current);
    stack.push(...(edges.get(current) ?? []));
  }
  return seen;
}

/**
 * Ciklai per vidines briaunas. Grafai čia yra eilės dydžio (dešimtys mazgų), todėl naudojama
 * paprasta „ar mazgas pasiekiamas pats iš savęs" patikra ir dalyvių grupavimas pagal abipusį
 * pasiekiamumą — kodas lieka akivaizdus, o kaina nereikšminga.
 */
function detectCycles(edges: ReadonlyMap<string, string[]>): { members: Set<string>; groups: string[][] } {
  const closures = new Map<string, Set<string>>();
  for (const node of edges.keys()) closures.set(node, dependencyClosure(node, edges));

  const members = new Set<string>();
  for (const [node, closure] of closures) {
    if (closure.has(node)) members.add(node);
  }

  const groups: string[][] = [];
  const grouped = new Set<string>();
  for (const node of [...members].sort()) {
    if (grouped.has(node)) continue;
    const group = [...members].filter(
      (other) => other === node || (closures.get(node)?.has(other) && closures.get(other)?.has(node)),
    );
    for (const member of group) grouped.add(member);
    groups.push(group.sort());
  }

  return { members, groups };
}

/** Ilgiausias kelias iki mazgo per vidines briaunas; ciklo dalyviams — 0 (jie niekada nevykdomi). */
function computeDepths(nodes: readonly ResolvedNode[], cycleMembers: ReadonlySet<string>): Map<string, number> {
  const depths = new Map<string, number>();
  const byId = new Map(nodes.map((node) => [node.task.task_id, node]));

  const depthOf = (taskId: string, seen: Set<string>): number => {
    if (depths.has(taskId)) return depths.get(taskId) as number;
    if (cycleMembers.has(taskId) || seen.has(taskId)) return 0;
    seen.add(taskId);
    const node = byId.get(taskId);
    const dependencyDepths = (node?.internal ?? []).map((dependency) => depthOf(dependency, seen) + 1);
    const depth = dependencyDepths.length > 0 ? Math.max(...dependencyDepths) : 0;
    seen.delete(taskId);
    depths.set(taskId, depth);
    return depth;
  };

  for (const node of nodes) depthOf(node.task.task_id, new Set());
  return depths;
}

/**
 * Sudaro kitą bangą iš tuo metu prieinamo ready set'o.
 *
 * Priklausomybė laikoma įvykdyta, kai ji nurodo į `completedTaskIds` įrašą, ARBA jos
 * atitikmens nėra kandidatų rinkinyje IR ji nepatenka į blokuotą šaką (eilėje nesantis
 * blokatorius beveik visada jau užbaigtas; „missing" faktas fiksuojamas
 * `external_dependencies` lauke). Blokuota šaka nustelbia viską — nei pats blokatorius,
 * nei jo priklausiniai į ready set'ą nepatenka.
 */
export function scheduleNextWave(input: ScheduleNextWaveInput): WavePlan {
  const tasks = normalizeSchedulableTasks(input.tasks);
  const completed = new Set([...(input.completedTaskIds ?? [])].map((value) => normalizeTaskReference(value)).filter(Boolean));
  const blocked = new Set([...(input.blockedTaskIds ?? [])].map((value) => normalizeTaskReference(value)).filter(Boolean));

  const nodes = resolveNodes(tasks);
  const edges = new Map(nodes.map((node) => [node.task.task_id, node.internal]));
  const { members: cycleMembers, groups: cycles } = detectCycles(edges);
  const depths = computeDepths(nodes, cycleMembers);

  const ready: WaveReadyTask[] = [];
  const blockedTasks: WaveBlockedTask[] = [];
  const externalDependencies = new Set<string>();

  for (const node of nodes) {
    const { task } = node;
    for (const dependency of node.external) externalDependencies.add(dependency);

    if (matchesAny(task.task_id, completed)) continue;

    if (matchesAny(task.task_id, blocked)) {
      blockedTasks.push({ ...blockedShape(task), reason: "branch-blocked", waiting_for: [] });
      continue;
    }

    if (cycleMembers.has(task.task_id)) {
      blockedTasks.push({ ...blockedShape(task), reason: "dependency-cycle", waiting_for: node.internal });
      continue;
    }

    const waitingFor: string[] = [];
    for (const dependency of task.blocked_by) {
      if (matchesAny(dependency, blocked)) {
        waitingFor.push(dependency);
        continue;
      }
      if (matchesAny(dependency, completed)) continue;
      const resolved = resolveDependency(dependency, tasks);
      // Vidinė (dar eilėje esanti) priklausomybė be „completed" žymos yra neįvykdyta;
      // external priklausomybė laikoma įvykdyta (žr. funkcijos dokumentaciją).
      if (resolved) waitingFor.push(dependency);
    }

    if (waitingFor.length > 0) {
      blockedTasks.push({ ...blockedShape(task), reason: "unsatisfied-dependency", waiting_for: [...new Set(waitingFor)].sort() });
      continue;
    }

    ready.push({
      task_id: task.task_id,
      file: task.file,
      depth: depths.get(task.task_id) ?? 0,
      blocked_by: [...task.blocked_by],
    });
  }

  ready.sort((a, b) => a.depth - b.depth || a.file.localeCompare(b.file));
  blockedTasks.sort((a, b) => a.file.localeCompare(b.file));

  const graphHash = computeGraphHash(tasks);
  const waveSequence = Math.max(1, Math.trunc(input.waveSequence ?? 1));

  return {
    scheduler_version: WAVE_SCHEDULER_VERSION,
    wave_id: waveIdFor(waveSequence, graphHash),
    wave_sequence: waveSequence,
    graph_hash: graphHash,
    max_workers: clampWaveWorkers(input.maxWorkers),
    ready,
    blocked: blockedTasks,
    external_dependencies: [...externalDependencies].sort(),
    cycles,
  };
}

function blockedShape(task: SchedulableTask): Omit<WaveBlockedTask, "reason" | "waiting_for"> {
  return { task_id: task.task_id, file: task.file, blocked_by: [...task.blocked_by] };
}

/**
 * Kitas vykdytinas task'as. Vienas workeris = vienas kvietimas: iškvietėjas įvykdo GRĄŽINTĄ
 * task'ą, užfiksuoja rezultatą ir tik tada perskaičiuoja planą. `startedTaskIds` yra apsauga
 * nuo dvigubo vykdymo tame pačiame run'e.
 */
export function selectNextWaveTask(
  plan: WavePlan,
  options: { startedTaskIds?: Iterable<string> } = {},
): WaveReadyTask | undefined {
  const started = new Set([...(options.startedTaskIds ?? [])].map((value) => normalizeTaskReference(value)));
  return plan.ready.find((task) => !started.has(task.task_id));
}

/**
 * Lūžusi šaka: pats task'as ir visi jo tranzityvūs priklausiniai. Iškvietėjas šį rinkinį
 * perduoda kaip `blockedTaskIds`, todėl kitos, nepriklausomos šakos toliau vykdomos, o
 * blokuoti priklausiniai lieka eilėje ir NIEKADA nepatenka į vykdomą būseną (spec WAVE-1).
 */
export function collectBlockedBranch(tasks: readonly SchedulableTask[], rootTaskId: string): string[] {
  const normalized = normalizeSchedulableTasks(tasks);
  const root = normalizeTaskReference(rootTaskId);
  const blocked = new Set<string>([root]);

  let changed = true;
  while (changed) {
    changed = false;
    for (const task of normalized) {
      if (blocked.has(task.task_id)) continue;
      if (task.blocked_by.some((dependency) => matchesAny(dependency, blocked))) {
        blocked.add(task.task_id);
        changed = true;
      }
    }
  }

  return [...blocked].sort();
}
