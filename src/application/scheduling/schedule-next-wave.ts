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
import { detectCyclesOverEdges, longestDependencyDepths } from "../../domain/tasks/graph/adjacency.js";
import { dependenciesOf, internalEdges, resolveTaskNode } from "../../domain/tasks/graph/traverse.js";
import { satisfiesDependency, type TaskGraph, type TaskNodeStatus } from "../../domain/tasks/graph/model.js";
import { computeWaveDecisionHash } from "./wave-decision-hash.js";
import { RUNTIME_MAX_WORKERS } from "./worker-limits.js";
import type { ReadySetBlockedReason } from "./build-ready-set.js";

/**
 * Planavimo TAISYKLIŲ versija. Įeina į `graph_hash`, tad pakeitus taisykles seni snapshot'ai
 * tampa stale.
 *
 * 2 (2026-08-23): planavimas remiasi KANONINIU grafu. Dingusi priklausomybė nebelaikoma
 * įvykdyta, savęs nuoroda lieka ciklu, dviprasmiškas prefiksas atmetamas. Sprendimai pasikeitė,
 * tad seni snapshot'ai ir resume checkpoint'ai privalo tapti stale — būtent tam ši versija
 * įeina į hash'ą. Vienkartinis ir pats užgyjantis efektas.
 */
export const WAVE_SCHEDULER_VERSION = 2;

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
  /**
   * Task'as yra bangoje, bet kanoninis grafas jo nevardija NEI kaip leidžiamo, NEI kaip
   * sustabdyto: eilės ir grafo būsenos išsiskyrė (task'as ne grafe, arba jame jau `done`,
   * arba persikėlė tarp dviejų atskirų FS skaitymų). Atskiras nuo `gate:` priežasčių — ten
   * grafas priėmė sprendimą, o čia sprendimo apskritai nėra, tad leidimo įrodyti negalime.
   */
  | "gate:graph-state-mismatch"
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
  /**
   * Ar tai TAS PATS sprendimas (2026-08-23, operatoriaus radinys). `graph_hash` atsako tik
   * „kurie task'ai svarstomi", tad patvirtinimai, statusai, biudžetas ir vartų politika jame
   * nesimato — keturi skirtingi planai gaudavo vieną tapatybę, o `recoverFromCrash` pagal ją
   * tęsdavo bangą. Atspaudą stampuoja tas sluoksnis, kuris turi VISUS įėjimus: plano statymo
   * metu jis „be vartų", o `applyReadySetGates` jį perstampuoja verdiktais.
   */
  decision_hash: string;
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
  /**
   * Kanoninis grafas — PRIVALOMAS (2026-08-23 suvienodinimas, 3/3 žingsnis). Iš jo imamas bangos
   * pjūvis (`queued` mazgai) ir priklausomybių rezoliucija. Antro, atlaidaus variklio nebėra:
   * jis egzistavo kaip lygiagreti tiesa ir keturiose vietose prieštaravo kanoninei.
   *
   * `tasks` reikalingas ir su grafu: iš jo skaičiuojama BANGOS tapatybė (`graph_hash`), kuri
   * sąmoningai lieka atskira nuo kanoninio `tg` hash'o, ir tikrinama, ar eilė nuo grafo
   * neišsiskyrė (`gate:graph-state-mismatch`).
   */
  graph: TaskGraph;
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

type ResolvedNode = {
  task: SchedulableTask;
  /** Neįvykdytos priklausomybės — žalios nuorodos, kaip jas parašė autorius. */
  internal: string[];
  /** Nuorodos, kurių grafe išspręsti nepavyko (nėra arba dviprasmiška). */
  external: string[];
};

/**
 * Kandidatai iš KANONINIO grafo (2026-08-23 suvienodinimas).
 *
 * Bangos pjūvis — mazgai, kurių efektyvus statusas yra `queued`; run'o būsena
 * (`completedTaskIds`/`blockedTaskIds`) viršija grafo įrašytą, lygiai kaip `wave-graph.readySet`
 * statusOverrides. Rezoliucija — kanoninė: dviprasmiškas prefiksas ATMETAMAS, o neišsprendžiama
 * nuoroda NEBĖRA laikoma įvykdyta „už bangos ribų"; ji patenka į `external` (t. y. į
 * `external_dependencies`) IR blokuoja task'ą.
 *
 * Priklausomybė tenkinama tik tada, kai blokatoriaus efektyvus statusas yra priimtas darbas —
 * tą patį klausimą ir tuo pačiu predikatu sprendžia `buildReadySet`.
 */
/**
 * Bangos pjūvis iš KANONINIO grafo: mazgai, kurių įrašytas statusas yra `queued`.
 *
 * Eksportuojama, nes tą patį pjūvį turi matyti ir planuoklis (kandidatai + bangos tapatybė), ir
 * `wave-scheduler` būsena (`state.tasks`, kuria remiasi šakos ir baigties logika). Dvi vietos,
 * skaičiuojančios „kas eilėje" savarankiškai, jau kartą išsiskyrė.
 */
export function queueSliceFromGraph(graph: TaskGraph): SchedulableTask[] {
  return graph.nodes
    .filter((node) => node.status === "queued")
    .map((node) => ({ task_id: node.task_id, file: toPosix(node.file), blocked_by: dependenciesOf(graph, node.task_id) }))
    .sort((left, right) => left.file.localeCompare(right.file));
}

function resolveNodesFromGraph(
  graph: TaskGraph,
  statusOf: (taskId: string) => TaskNodeStatus | undefined,
): ResolvedNode[] {
  const nodes: ResolvedNode[] = [];
  for (const node of graph.nodes) {
    // Kandidatūra remiasi GRAFO įrašytu statusu, o ne perrašytu: šiame run'e lūžusi šaka turi
    // likti matoma kaip `branch-blocked`, o ne tyliai iškristi iš plano. Perrašymai lemia tik
    // priklausomybių tenkinimą (žemiau).
    if (node.status !== "queued") continue;

    const internal: string[] = [];
    const external: string[] = [];
    for (const reference of dependenciesOf(graph, node.task_id)) {
      const blocker = resolveTaskNode(graph, reference);
      // Neišsprendžiama arba dviprasmiška nuoroda: leidimo įrodyti negalime, tad ji laukiama.
      if (!blocker) {
        external.push(reference);
        continue;
      }
      const status = statusOf(blocker.task_id);
      if (status !== undefined && satisfiesDependency(status)) continue;
      // Laukiama ŽALIA nuoroda, ne išspręstas ID: taip rašo ir `buildReadySet`, o abu sąrašai
      // susitinka viename `blocked` sąraše per `applyReadySetGates`. Skirtingos formos tam pačiam
      // faktui verstų snapshot'o skaitytoją spėti, kuris sluoksnis įrašą sukūrė.
      internal.push(reference);
    }

    nodes.push({
      task: { task_id: node.task_id, file: toPosix(node.file), blocked_by: dependenciesOf(graph, node.task_id) },
      internal: [...new Set(internal)].sort(),
      external: [...new Set(external)].sort(),
    });
  }
  return nodes.sort((a, b) => a.task.file.localeCompare(b.task.file));
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
  // `input.tasks` yra EILĖS SKAITYMAS iš FS — kryžminė patikra, o ne kandidatų šaltinis. Kandidatai
  // ir bangos tapatybė imami iš grafo (žemiau): jis skaitomas vėliau, tad yra šviežesnis, ir jis
  // yra autoritetas.
  const observedQueue = normalizeSchedulableTasks(input.tasks);
  const completed = new Set([...(input.completedTaskIds ?? [])].map((value) => normalizeTaskReference(value)).filter(Boolean));
  const blocked = new Set([...(input.blockedTaskIds ?? [])].map((value) => normalizeTaskReference(value)).filter(Boolean));

  const graph = input.graph;
  /**
   * Efektyvus statusas priklausomybių tenkinimui. Run'o būsena viršija grafo įrašytą — TIKSLIAI
   * ta pati taisyklė ir ta pati tvarka kaip `wave-graph.readySet` statusOverrides, kad du
   * skaitytojai to paties klausimo neatsakytų skirtingai. Sutapimas čia yra ne stiliaus dalykas:
   * juo remiasi `applyReadySetGates` sankirta.
   */
  const effectiveStatus = (taskId: string): TaskNodeStatus | undefined => {
    if (completed.has(taskId)) return "done";
    if (blocked.has(taskId)) return "blocked";
    return graph.nodes.find((node) => node.task_id === taskId)?.status;
  };

  const nodes = resolveNodesFromGraph(graph, effectiveStatus);
  // Bangos tapatybė skaičiuojama iš GRAFO pjūvio, ne iš eilės skaitymo (2026-08-23, operatoriaus
  // radinys). Kandidatai jau imami iš grafo, tad tapatybė iš `input.tasks` galėjo aprašyti visai
  // kitą aibę: `tasks=[]` su `graph=[a queued]` duodavo tuščios eilės hash'ą planui, kuriame `a`
  // vykdomas. Du FS pjūviai skirtingu metu tai daro reguliariai pasiekiamu, o ne teoriniu.
  const tasks = nodes.map((node) => node.task);
  // Ciklai ir gyliai — per VISĄ grafą, ne tik per eilės pjūvį: taip gylis nepasikeičia
  // blokatoriui persikėlus į `done`, o ciklas lieka ciklu net kai dalis jo jau ne eilėje.
  // Algoritmas bendras su kanoniniu skaitytoju (`domain/tasks/graph/adjacency`).
  const edges = internalEdges(graph);
  const { members: cycleMembers, groups: cycles } = detectCyclesOverEdges(edges);
  const depths = longestDependencyDepths(edges, cycleMembers);

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

    // Sprendimas jau priimtas `resolveNodesFromGraph`: `internal` — neįvykdyti blokatoriai,
    // `external` — neišsprendžiamos arba dviprasmiškos nuorodos. Abi grupės LAUKIAMOS;
    // taisyklės „nėra eilėje = atlikta" nebėra.
    const waitingFor: string[] = [...node.internal, ...node.external];

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

  // Eilėje gulintis task'as, kurio kanoninis grafas nevardija kaip `queued` (jo ten nėra arba
  // jis jau kitos būsenos), NEDINGSTA tyliai: planas jį įvardija. Priešingu atveju perėjimas prie
  // grafo pjūvio būtų pakeitęs vieną fail-open kelią kitu — nematomu.
  for (const task of observedQueue) {
    if (completed.has(task.task_id)) continue;
    const node = graph.nodes.find((entry) => entry.task_id === task.task_id);
    if (node?.status === "queued") continue;
    blockedTasks.push({ ...blockedShape(task), reason: "gate:graph-state-mismatch", waiting_for: [] });
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
    // Planas dar be vartų verdiktų: `applyReadySetGates` perstampuos. Reikšmė vis tiek tikra —
    // ji apibūdina TĄ sprendimą, kurį šis objektas neša dabar, įskaitant `gate:graph-state-mismatch`
    // įrašus, kurie gimsta ČIA (iš `observedQueue` palyginimo) ir jokiame ready-set'e nefigūruoja.
    decision_hash: computeWaveDecisionHash({ waveGraphHash: graphHash, ready, blocked: blockedTasks }),
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
