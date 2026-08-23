// Bangos planuoklio KONTRAKTAS (etalonas: AG_loop
// orchestrator/loop/loop-wave-scheduler-contract.ts).
//
// NUKRYPIMAS nuo etalono (griežtinantis): nė vienas portas neturi numatytosios reikšmės. Etalone
// `WaveSchedulerDeps` visi laukai buvo opcionalūs, o realizacijos gimdavo `??` grandinėse pačiame
// planuoklyje — tai reiškė, kad testas, pamiršęs paduoti portą, tyliai gaudavo produkcinį IO, o
// planuoklio failas žinojo apie git, FS ir procesus. Čia portai PRIVALOMI, o jų suvedimas gyvena
// kompozicijoje.

import type { ReadySetBudget } from "./build-ready-set.js";
import type { ReadySetGatePolicy } from "./apply-ready-set-gates.js";
import type { ResumeDecision, ResumeTaskLocation } from "./resume-run.js";
import type { SlotRefillDecision, SlotRefillHold } from "./slot-refill.js";
import type { SchedulableTask, WavePlan, WaveReadyTask } from "./schedule-next-wave.js";
import type { WorkerPoolPlan } from "./worker-pool-plan.js";
import type { PhantomWaveSlot } from "./wave-phantom-slots.js";
import type { StoredGraphRead } from "./wave-graph.js";
import type { WaveSnapshot } from "./wave-snapshot.js";
import type { WaveDispatchSlot } from "./wave-dispatch-model.js";
import type { WavePoolEvent } from "./wave-pool-planning.js";
import type { WaveOutcomeCheckpoint } from "./wave-outcome.js";
import type { TaskGraph } from "../../domain/tasks/graph/model.js";

export type WaveSelection =
  | {
      kind: "task";
      task: WaveReadyTask;
      absoluteFile: string;
      plan: WavePlan;
      pool: WorkerPoolPlan;
      refill?: SlotRefillDecision;
      /** Plano slot'ai, kurie NEBUVO dispatch'inti — dispatch'as privalo juos praleisti. */
      phantom?: readonly PhantomWaveSlot[];
    }
  | { kind: "empty" }
  | { kind: "exhausted"; plan: WavePlan; reason: "all-blocked" | "already-started"; detail?: string };

export type WaveRefill = {
  selection: Extract<WaveSelection, { kind: "task" }>;
  slot: WaveDispatchSlot;
  decision: SlotRefillDecision;
};

/** Checkpoint'o pjūvis, kurio pakanka `decideResume` sprendimui. */
export type SchedulerCheckpoint = {
  status: "started" | "finished" | "failed" | "waiting" | "moved";
  task_id?: string;
  graph_hash?: string;
  attempt_id?: string;
  updated_at?: string;
};

/** Ką planuoklis rašo į checkpoint'ą pradėdamas task'ą. */
export type WaveStartCheckpoint = {
  actor: "claude";
  phase: string;
  status: "started";
  task_id: string;
  task_file: string;
  run_id: string;
  wave_id: string;
  graph_hash: string;
  attempt_id: string;
  next_action: string;
};

export type WaveSchedulerPorts = {
  projectRoot: string;
  runId: string;
  now: () => string;
  log: (message: string) => Promise<void>;
  /** Absoliutus task failo kelias; kelio aritmetika lieka kompozicijoje. */
  absolutePath: (relativeFile: string) => string;

  readTasks: () => Promise<SchedulableTask[]>;
  locateTask: (taskId: string) => Promise<ResumeTaskLocation>;
  hasAcceptedWork: (taskId: string) => Promise<boolean>;
  readCheckpoint: () => Promise<SchedulerCheckpoint | undefined>;
  readSnapshot: () => Promise<WaveSnapshot | undefined>;
  writeSnapshot: (snapshot: WaveSnapshot) => Promise<void>;
  recordEvent: (event: WavePoolEvent) => Promise<void>;
  recordCheckpoint: (checkpoint: WaveStartCheckpoint | WaveOutcomeCheckpoint) => Promise<void>;

  /** VIENINTELIS kanoninio grafo šaltinis. Nepavykus importui, banga sustoja. */
  importGraph: () => Promise<TaskGraph>;
  /** Įrašo importuotą grafą PROVENIENCIJAI: kitas procesas iš jo mato, kas pasikeitė. */
  writeGraphSnapshot: (graph: TaskGraph) => Promise<void>;
  /**
   * Skaito ankstesnio proceso įrašytą grafą — TIK palyginimui ir raportavimui.
   *
   * Tai NĖRA atsarginė kopija ir NĖRA fallback'as `importGraph` nesėkmei: importui lūžus task
   * failai neperskaitomi, tad kešo patikrinti nebeįmanoma, o vykdymas pagal neverifikuojamą kešą
   * yra ta pati „įrodymo nebuvimas = leidimas" forma, kurią uždarė `planWaveWithoutGraph`.
   * Žr. `wave-graph` antraštę ir testą „saugomas grafas NĖRA fallback'as".
   */
  readGraphSnapshot: () => Promise<StoredGraphRead>;
  readySetPolicy?: ReadySetGatePolicy | undefined;
  readySetBudget: () => Promise<ReadySetBudget | undefined>;
  approvals: () => Iterable<string>;

  /** Efektyvus slot'ų skaičius šiai bangai (jau suvestas prašymas + valdikliai). */
  requestedWorkers: () => Promise<number>;
  /**
   * Ar task'as ledger'yje jau matytas TUO PAČIU turiniu. Klausiama PRIEŠ dispatch'ą: po jo
   * eilės failo, iš kurio skaičiuojamas fingerprint'as, gali nebelikti.
   */
  ledgerDuplicate: (taskId: string, absoluteTaskFile: string) => Promise<boolean>;
};

export type WaveScheduler = {
  runId: string;
  recoverFromCrash: () => Promise<ResumeDecision>;
  nextTask: () => Promise<WaveSelection>;
  beginTask: (selection: Extract<WaveSelection, { kind: "task" }>) => Promise<void>;
  recordOutcome: (taskId: string, succeeded: boolean) => Promise<void>;
  refillSlot: (freedWorkerId: string, hold: SlotRefillHold) => Promise<WaveRefill | undefined>;
  isSlotWithdrawn: (taskId: string) => boolean;
  blockUnrunnableTask: (taskId: string, reason: string) => Promise<void>;
};
