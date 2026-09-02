// Bangos task'o BAIGTIES apskaita (etalonas: AG_loop orchestrator/loop/loop-wave-outcome.ts).
//
// Šis modulis atsako į vieną klausimą: kas pasikeitė bangoje, kai task'as baigėsi? Atsakymas
// liečia keturis dalykus vienu metu — gyvą slot'ą, pool'o verdiktą, blokuotą šaką ir
// integracijos pasiruošimą.
//
// Kertinis skirtumas, kurį lengva prarasti: NEPAVYKĘS ir ATŠAUKTAS slot'as nėra tas pats.
// Task'as, kuris be dispatch'o buvo perkeltas iš eilės kaip dublikatas, NIEKADA nedirbo — jo
// slot'as „atšaukiamas" (`withdrawn`), o ne skaičiuojamas kaip žlugęs. Priešingu atveju bangos
// statistika rodytų nesėkmę ten, kur nebuvo nė vieno bandymo, o pool'o verdiktas gautų balsą
// už darbą, kurio nebuvo.
//
// Antras skirtumas tos pačios rūšies: NEPAVYKĘS ir INFRASTRUKTŪROS slot'as nėra tas pats.
// Usage limitas (75), timeout'as (124) ar IO gedimas (74) vaiko slot'e yra aplinkos, ne task'o
// baigtis: task'as verdikto NEGAVO. Todėl jis nei blokuoja savo šakos, nei tampa `failed` —
// snapshot'e jis grįžta į `ready` su įvardinta priežastimi, o integracijai perduodamas exit
// kodas, kad `worker-integration` jo neparkuotų kaip `task-failed` (148-b-03). Iki 148-c-04
// baigtis čia ateidavo kaip `boolean`, ir skirtumas žūdavo dar prieš šį modulį.

import { collectBlockedBranch, type SchedulableTask } from "./schedule-next-wave.js";
import { evaluateIntegrationCheckpoint, type FinishedWorkerSlot } from "./worker-integration.js";
import type { TaskGraph } from "../../domain/tasks/graph/model.js";
import type { LiveSlot } from "./slot-refill.js";
import type { SlotChildOutcome } from "./slot-task-runner.js";
import type { WorkerOutcome, WorkerPoolPlan } from "./worker-pool-plan.js";
import type { WaveTaskState } from "./wave-snapshot.js";
import type { WavePoolEvent } from "./wave-pool-planning.js";

/** Resume checkpoint'o pjūvis, kurį rašo bangos baigtis. */
export type WaveOutcomeCheckpoint = {
  actor: "claude";
  phase: string;
  status: "finished" | "failed";
  task_id: string;
  run_id: string;
  wave_id?: string | undefined;
  graph_hash: string;
  next_action: string;
};

export type WaveOutcomeDeps = {
  runId: string;
  tasks: () => readonly SchedulableTask[];
  /**
   * Kanoninis grafas — VISI mazgai, ne tik eilės pjūvis. Naudojamas tik nuorodų rezoliucijai
   * lūžusioje šakoje: sutrumpinta nuoroda, sprendžiama prieš dalinę visatą, „randa" ne tą task'ą
   * (žr. `collectBlockedBranch`), o šakos blokas yra vykdymą stabdantis sprendimas.
   */
  graph: () => TaskGraph | undefined;
  waveContext: () => { waveId?: string | undefined; graphHash: string; refillEpisode: number };
  poolPlan: () => WorkerPoolPlan | undefined;
  liveSlots: Map<string, LiveSlot>;
  finishedSlots: Map<string, FinishedWorkerSlot>;
  /** Task'ai, kurie ties dispatch'u pasirodė esą dublikatai. */
  duplicateAtDispatch: Set<string>;
  withdrawnTasks: Set<string>;
  runningTaskIds: Set<string>;
  completed: Set<string>;
  blockedBranch: Set<string>;
  /** Slot'as, kurio baigtis NEVERTINAMA — atšauktas slot'as neturi balso pool'o verdikte. */
  markUnjudged: (workerId: string) => void;
  outcomesFor: (planHash: string) => Map<string, WorkerOutcome>;
  judgedPlan: (pool: WorkerPoolPlan) => WorkerPoolPlan;
  settle: (taskId: string, state: WaveTaskState, reason?: string, file?: string) => void;
  liveSlotList: () => LiveSlot[];
  persist: () => Promise<void>;
  /** Žurnalas ir įvykiai, kurie NIEKADA nemeta — baigties apskaita negali kristi dėl telemetrijos. */
  safeLog: (message: string) => Promise<void>;
  safeEvent: (event: WavePoolEvent) => Promise<void>;
  log: (message: string) => Promise<void>;
  recordEvent: (event: WavePoolEvent) => Promise<void>;
  recordCheckpoint: (checkpoint: WaveOutcomeCheckpoint) => Promise<void>;
  integrateFinishedSlots: (checkpoint: ReturnType<typeof evaluateIntegrationCheckpoint>) => Promise<void>;
};

export function createWaveOutcomeRecorder(
  deps: WaveOutcomeDeps,
): (taskId: string, outcome: SlotChildOutcome) => Promise<void> {
  return async (taskId, outcome): Promise<void> => {
    const succeeded = outcome.status === "succeeded";
    const infrastructureExitCode = outcome.status === "infrastructure" ? outcome.code : undefined;
    const live = [...deps.liveSlots.values()].find((entry) => entry.task_id === taskId);

    /**
     * Atšaukimo sąlyga turi TRIS dalis, ir kiekviena būtina:
     *   - nesėkmė (sėkmingas darbas niekada nėra atšaukiamas);
     *   - dublikatas ties dispatch'u (task'as paliko eilę be vykdymo);
     *   - NĖRA darbo kopijos — jei kopija buvo, worker'is jau turėjo izoliuotą vietą ir jo
     *     baigtis yra tikra, nesvarbu kaip task'as atsirado.
     */
    const withdrawn = !succeeded && deps.duplicateAtDispatch.has(taskId) && live?.worktree_path === undefined;
    deps.runningTaskIds.delete(taskId);

    for (const [workerId, slot] of deps.liveSlots) {
      if (slot.task_id !== taskId) continue;
      if (!withdrawn) {
        deps.finishedSlots.set(taskId, {
          worker_id: slot.worker_id,
          worker_index: slot.worker_index,
          task_id: taskId,
          file: slot.file,
          attempt: slot.attempt,
          succeeded,
          write_set: slot.write_set,
          ...(slot.worktree_path === undefined ? {} : { worktree_path: slot.worktree_path }),
          ...(slot.lease === undefined ? {} : { lease: slot.lease }),
          // Integracijos sprendimui infra kodas yra VIENINTELIS įrodymas, kad `!succeeded` nėra
          // task'o kaltė — be jo `planWorkerIntegration` slot'ą parkuotų kaip `task-failed`.
          ...(infrastructureExitCode === undefined ? {} : { infrastructure_exit_code: infrastructureExitCode }),
        });
      }
      deps.liveSlots.delete(workerId);
    }

    const pool = deps.poolPlan();
    const slot = pool?.slots.find((entry) => entry.task_id === taskId);
    const context = deps.waveContext();

    if (withdrawn) {
      deps.withdrawnTasks.add(taskId);
      // Balsą atima ABI puses — ir gyvas slot'as, ir plano slot'as: jos gali skirtis, kai
      // papildymas jau perkėlė task'ą į kitą worker'į.
      if (live !== undefined) deps.markUnjudged(live.worker_id);
      if (slot !== undefined) deps.markUnjudged(slot.worker_id);
      await deps.safeLog(
        `WAVE SLOT WITHDRAWN: slot=${live?.worker_id ?? slot?.worker_id ?? "w1"} task=${taskId} reason=duplicate — ` +
          "task'as be dispatch'o perkeltas iš eilės (TASK DUPLICATE), tad tai nėra žlugęs bangos slot'as",
      );
      await deps.safeEvent({
        run_id: deps.runId,
        wave_id: context.waveId ?? "none",
        graph_hash: context.graphHash,
        event: "worker_slot_withdrawn",
        task_id: taskId,
        reason: "duplicate",
      });
    } else if (pool !== undefined && slot !== undefined) {
      // Pool'o verdikte infra slot'as yra `crashed`, ne `failed`: abu terminaliniai (lease
      // atlaisvinamas, banga užsidaro), bet statistika neturi rodyti task'o nesėkmės ten, kur
      // task'as verdikto negavo.
      deps.outcomesFor(pool.plan_hash).set(slot.worker_id, {
        worker_id: slot.worker_id,
        task_id: taskId,
        status: succeeded ? "succeeded" : infrastructureExitCode === undefined ? "failed" : "crashed",
        ...(infrastructureExitCode === undefined ? {} : { detail: `infrastructure exit=${infrastructureExitCode}` }),
      });
    }

    if (succeeded) {
      deps.completed.add(taskId);
      deps.settle(taskId, "done", "task_completed");
    } else if (infrastructureExitCode !== undefined) {
      // Šaka NEBLOKUOJAMA: priklausiniai laukia darbo, kuris dar bus atliktas, o ne darbo, kuris
      // žlugo. Task'as grįžta į `ready` — failas tebėra eilėje, ir tai vienintelė teisinga būsena.
      deps.settle(taskId, "ready", `infrastructure exit=${infrastructureExitCode}`);
    } else {
      // Nepavykęs task'as blokuoja VISĄ savo šaką: jo priklausiniai negali būti vykdomi ant
      // darbo, kurio nėra. Šaka renkama prieš `settle`, kad į ją patektų ir pats task'as.
      for (const blockedTaskId of collectBlockedBranch(deps.tasks(), taskId, deps.graph())) {
        deps.blockedBranch.add(blockedTaskId);
      }
      deps.settle(taskId, "failed", withdrawn ? "task_duplicate" : "task_failed");
      for (const blockedTaskId of deps.blockedBranch) {
        if (blockedTaskId !== taskId) deps.settle(blockedTaskId, "blocked", "branch-blocked");
      }
    }

    await deps.persist();
    await deps.recordEvent({
      run_id: deps.runId,
      wave_id: context.waveId ?? "none",
      graph_hash: context.graphHash,
      event: succeeded ? "task_completed" : infrastructureExitCode === undefined ? "task_failed" : "task_infrastructure",
      task_id: taskId,
      ...(succeeded
        ? {}
        : infrastructureExitCode !== undefined
          ? { reason: `exit=${infrastructureExitCode}` }
          : { reason: `${withdrawn ? "duplicate; " : ""}branch-blocked=${deps.blockedBranch.size}` }),
    });
    await deps.recordCheckpoint({
      actor: "claude",
      phase: "wave-dispatch",
      status: succeeded ? "finished" : "failed",
      task_id: taskId,
      run_id: deps.runId,
      wave_id: context.waveId,
      graph_hash: context.graphHash,
      next_action: succeeded
        ? "next-wave-task"
        : infrastructureExitCode === undefined
          ? "blocked-branch"
          : `infrastructure-abort exit=${infrastructureExitCode}`,
    });

    /**
     * Integracija svarstoma TIK tada, kai bangoje realiai buvo daugiau nei vienas vertinamas
     * slot'as, buvo papildymas arba liko darbo sesijos šakoje. Vieno slot'o banga be kopijos
     * integruoti neturi ko — ir tada kiekvienas task'as be reikalo suktų visą integracijos
     * mechaniką.
     */
    const hasSessionBranchWork = [...deps.finishedSlots.values()].some((entry) => entry.worktree_path !== undefined);
    if (pool !== undefined && (deps.judgedPlan(pool).slots.length > 1 || context.refillEpisode > 0 || hasSessionBranchWork)) {
      await deps.recordEvent({
        run_id: deps.runId,
        wave_id: context.waveId ?? "none",
        graph_hash: context.graphHash,
        event: "task_integration_ready",
        task_id: taskId,
        reason: `task=${taskId} quality-gates=${succeeded ? "ok" : infrastructureExitCode === undefined ? "failed" : "infrastructure"}`,
      });
      const checkpoint = evaluateIntegrationCheckpoint({
        live: deps.liveSlotList(),
        plan: deps.judgedPlan(pool),
        outcomes: [...deps.outcomesFor(pool.plan_hash).values()],
      });
      await deps.log(`WORKER POOL INTEGRATION: ${checkpoint.reason}`);
      await deps.recordEvent({
        run_id: deps.runId,
        wave_id: context.waveId ?? "none",
        graph_hash: context.graphHash,
        event: checkpoint.tree_quiescent ? "wave_integration_ready" : "wave_integration_waiting",
        reason: checkpoint.reason,
      });
      await deps.integrateFinishedSlots(checkpoint);
    } else if (hasSessionBranchWork) {
      await deps.integrateFinishedSlots(evaluateIntegrationCheckpoint({ live: deps.liveSlotList() }));
    }
  };
}
