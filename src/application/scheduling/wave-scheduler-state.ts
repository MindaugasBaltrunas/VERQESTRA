// Bangos planuoklio RUN'O BŪSENA (etalonas: AG_loop orchestrator/loop/loop-wave-scheduler.ts
// vidinės būsenos dalis).
//
// Būsena iškelta iš planuoklio sąmoningai: planuoklyje lieka SPRENDIMAI, čia — apskaita, kurią tie
// sprendimai keičia. Kiekvienas rinkinys atsako į savo klausimą, ir jų sulieti negalima:
//
//   - `settled`        — viso RUN'O įrašas (į snapshot'ą patenka ir jau eilę palikę task'ai);
//   - `runningTaskIds` — kas realiai užima slot'ą DABAR;
//   - `started`        — kas šiame run'e jau buvo paleistas (idempotencija po restart'o);
//   - `liveSlots`      — vienintelis realaus laiko užimtumo autoritetas: papildytas slot'as
//                        jokiam bangos planui nepriklauso, tad `poolPlan.slots` apie jį nieko
//                        nesako;
//   - `finishedSlots`  — baigę attempt'ą, bet dar laukiantys integracijos; įrašas gimsta baigties
//                        metu, nes po `liveSlots.delete` sesijos šakos nebūtų kaip rasti;
//   - `unjudgedSlots`  — slot'ai BE bandymo (fantomai ir atšaukti): jie negali nei laukti tylos,
//                        nei būti užverčiami kaip žlugę.

import type { LiveSlot, SlotRefillDecision } from "./slot-refill.js";
import type { FinishedWorkerSlot } from "./worker-integration.js";
import type { SchedulableTask, WavePlan } from "./schedule-next-wave.js";
import type { WorkerCandidate, WorkerSlot } from "./worker-pool-admission.js";
import type { WorkerOutcome, WorkerPoolPlan } from "./worker-pool-plan.js";
import type { WaveTaskState, WaveTaskStateOverride } from "./wave-snapshot.js";
import type { RefillDecisionLog } from "./wave-snapshot-persist.js";
import type { TaskGraph } from "../../domain/tasks/graph/model.js";

/** Kiek papildymo epizodų telpa snapshot'e. Visa istorija gyvena įvykių žurnale. */
const REFILL_LOG_LIMIT = 8;

export type WaveSchedulerState = ReturnType<typeof createWaveSchedulerState>;

export function createWaveSchedulerState(now: () => string) {
  const completed = new Set<string>();
  const blockedBranch = new Set<string>();
  const started = new Set<string>();
  const settled = new Map<string, WaveTaskStateOverride>();
  const runningTaskIds = new Set<string>();
  const liveSlots = new Map<string, LiveSlot>();
  const finishedSlots = new Map<string, FinishedWorkerSlot>();
  const releasedLeaseIds = new Set<string>();
  const admittedCandidates = new Map<string, WorkerCandidate>();
  const duplicateAtDispatch = new Set<string>();
  const withdrawnTasks = new Set<string>();
  const workerOutcomes = new Map<string, WorkerOutcome>();
  const refillLog: RefillDecisionLog[] = [];

  let outcomesPlanHash: string | undefined;
  let unjudgedSlotWorkers = new Set<string>();
  let refillEpisode = 0;
  let tasks: SchedulableTask[] = [];
  let plan: WavePlan | undefined;
  let poolPlan: WorkerPoolPlan | undefined;
  let poolPlanWaveId: string | undefined;
  let waveSequence = 0;
  let waveCreatedAt = now();
  let graphHash = "";
  let canonicalGraph: TaskGraph | undefined;
  let requestedWorkers = 1;

  return {
    completed,
    blockedBranch,
    started,
    settled,
    runningTaskIds,
    liveSlots,
    finishedSlots,
    releasedLeaseIds,
    admittedCandidates,
    duplicateAtDispatch,
    withdrawnTasks,
    refillLog,

    get tasks(): SchedulableTask[] {
      return tasks;
    },
    set tasks(value: SchedulableTask[]) {
      tasks = value;
    },
    get plan(): WavePlan | undefined {
      return plan;
    },
    set plan(value: WavePlan | undefined) {
      plan = value;
    },
    get poolPlan(): WorkerPoolPlan | undefined {
      return poolPlan;
    },
    get poolPlanWaveId(): string | undefined {
      return poolPlanWaveId;
    },
    get waveSequence(): number {
      return waveSequence;
    },
    set waveSequence(value: number) {
      waveSequence = value;
    },
    get waveCreatedAt(): string {
      return waveCreatedAt;
    },
    get graphHash(): string {
      return graphHash;
    },
    get canonicalGraph(): TaskGraph | undefined {
      return canonicalGraph;
    },
    set canonicalGraph(value: TaskGraph | undefined) {
      canonicalGraph = value;
    },
    get requestedWorkers(): number {
      return requestedWorkers;
    },
    set requestedWorkers(value: number) {
      requestedWorkers = value;
    },
    get refillEpisode(): number {
      return refillEpisode;
    },
    get waveId(): string {
      return plan?.wave_id ?? "none";
    },

    /** Naujas grafo hash'as = nauja banga: numeracija ir laikas atsinaujina kartu. */
    startWaveIfGraphChanged(nextGraphHash: string): void {
      if (nextGraphHash === graphHash) return;
      graphHash = nextGraphHash;
      waveSequence += 1;
      waveCreatedAt = now();
    },

    rememberPoolPlan(pool: WorkerPoolPlan, waveId: string, phantomWorkerIds: readonly string[]): void {
      poolPlan = pool;
      poolPlanWaveId = waveId;
      // Fantomų sąrašas perrašomas KIEKVIENAME plane: naujas planas turi savus slot'us, tad
      // senos išimtys jam negalioja.
      unjudgedSlotWorkers = new Set(phantomWorkerIds);
    },

    markUnjudged(workerId: string): void {
      unjudgedSlotWorkers.add(workerId);
    },

    /**
     * Slot'ų rezultatai, PRIRIŠTI prie konkretaus pool'o plano.
     *
     * Banga užsidaro tik tada, kai visi jos slot'ai pasiekė terminalinę būseną TAME PAČIAME plane:
     * pasikeitus `plan_hash` seni įrašai aprašo kitus worker id'us, tad jų perkėlimas suklastotų
     * integracijos verdiktą.
     */
    outcomesFor(planHash: string): Map<string, WorkerOutcome> {
      if (outcomesPlanHash !== planHash) {
        workerOutcomes.clear();
        outcomesPlanHash = planHash;
      }
      return workerOutcomes;
    },

    /**
     * Plano slot'ai, už kuriuos banga realiai atsako.
     *
     * `poolPlan` NEkeičiamas — planas yra istorinis faktas, ir jo perrašymas kartu su `plan_hash`
     * reikštų, kad telemetrija meluoja apie tai, ką pool'as išdavė. Keičiasi tik APSKAITA.
     */
    judgedSlots(pool: WorkerPoolPlan): WorkerSlot[] {
      return unjudgedSlotWorkers.size === 0 ? pool.slots : pool.slots.filter((slot) => !unjudgedSlotWorkers.has(slot.worker_id));
    },

    judgedPlan(pool: WorkerPoolPlan): WorkerPoolPlan {
      const slots = this.judgedSlots(pool);
      return slots.length === pool.slots.length ? pool : { ...pool, slots };
    },

    settle(taskId: string, state: WaveTaskState, reason?: string, file?: string): void {
      const previous = settled.get(taskId);
      settled.set(taskId, {
        state,
        ...(reason === undefined ? {} : { reason }),
        // `blocked` bandymo nepridėjo: blokavimas nėra vykdymas.
        attempts: (previous?.attempts ?? 0) + (state === "blocked" ? 0 : 1),
        ...(() => {
          const resolved = file ?? previous?.file ?? tasks.find((task) => task.task_id === taskId)?.file;
          return resolved === undefined ? {} : { file: resolved };
        })(),
      });
    },

    /** Snapshot'o override'ai: užfiksuota būsena + realiu laiku vykdomi task'ai. */
    overrides(): ReadonlyMap<string, WaveTaskStateOverride> {
      const map = new Map<string, WaveTaskStateOverride>(settled);
      for (const taskId of runningTaskIds) {
        const file = settled.get(taskId)?.file;
        map.set(taskId, { state: "running", attempts: 1, ...(file === undefined ? {} : { file }) });
      }
      return map;
    },

    nextRefillEpisode(): number {
      refillEpisode += 1;
      return refillEpisode;
    },

    appendRefillDecision(decision: SlotRefillDecision): void {
      refillLog.push({ decision, decided_at: now() });
      if (refillLog.length > REFILL_LOG_LIMIT) refillLog.splice(0, refillLog.length - REFILL_LOG_LIMIT);
    },
  };
}
