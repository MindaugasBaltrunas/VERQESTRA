// Bangos PLANUOKLIS — vienintelis dalykas, kuris žino, kuris task'as vykdomas dabar
// (etalonas: AG_loop orchestrator/loop/loop-wave-scheduler.ts).
//
// Planuoklis nieko nedaro pats: jis suveda planavimą (`scheduleNextWave` + ready set vartai),
// pool'ą, papildymą, baigties apskaitą ir integraciją į vieną gyvavimo ciklą. Visa būsena gyvena
// `wave-scheduler-state`, visas IO — už portų.
//
// Trys taisyklės, kurių čia negalima sulaužyti:
//   1. prašymas („kiek workerių") skaitomas VIENĄ kartą per perskaičiavimą — du skaitymai galėtų
//      pataikyti į operatoriaus pakeitimą bangos VIDURYJE, ir snapshot'e užrašytas limitas
//      prasilenktų su tuo, kurį vertino pool'as;
//   2. resume kelias ir įprastas kelias privalo duoti TĄ PATĮ planą — kitaip po restart'o
//      atsirastų task'ų, kurių įprastas kelias nebūtų paleidęs;
//   3. telemetrija bangos NIEKADA nenutraukia (`safeLog`/`safeEvent`): integracijos kelyje
//      įvykių rašymų yra iki `2N+1`, ir Windows EPERM ant JSONL append yra dokumentuota realybė —
//      prarastas įrašas pigesnis nei nutraukta banga.

import { collectBlockedBranch, computeGraphHash, scheduleNextWave, selectNextWaveTask, waveIdFor } from "./schedule-next-wave.js";
import { applyReadySetGates, formatWaveBlockedReason, planWaveWithoutGraph } from "./apply-ready-set-gates.js";
import { decideResume, type ResumeDecision } from "./resume-run.js";
import { createLiveSlotRegistry, candidateWriteSet } from "./wave-live-slots.js";
import { createWaveGraphCoordinator } from "./wave-graph.js";
import type { ReadySetBudget } from "./build-ready-set.js";
import { createWaveIntegrationCoordinator } from "./wave-integration-coordinator.js";
import { createWaveOutcomeRecorder } from "./wave-outcome.js";
import { createWaveRefillCoordinator } from "./wave-refill.js";
import { createWaveSchedulerState } from "./wave-scheduler-state.js";
import { persistWaveSnapshot } from "./wave-snapshot-persist.js";
import { planWavePool } from "./wave-pool-planning.js";
import { PRIMARY_SLOT_CLAIM_SUPPORTED, type WaveProvisioningCoordinator } from "./wave-provisioning.js";
import type { WavePlan } from "./schedule-next-wave.js";
import type { TaskGraph } from "../../domain/tasks/graph/model.js";
import type { WorkerPoolPlan } from "./worker-pool-plan.js";
import type { PhantomWaveSlot } from "./wave-phantom-slots.js";
import type { WavePoolEvent } from "./wave-pool-planning.js";
import type { WaveIntegrationPorts } from "./wave-integration-ports.js";
import type { WorkerLease } from "../../domain/scheduling/worker-lease-rules.js";
import type { WaveScheduler, WaveSchedulerPorts, WaveSelection } from "./wave-scheduler-contract.js";

/** Integracijos IO be tų laukų, kuriuos planuoklis turi pats (run id, bangos kontekstas, žurnalas). */
export type WaveIntegrationIo = Omit<WaveIntegrationPorts, "runId" | "waveContext" | "safeLog" | "safeEvent">;

/**
 * Būsena, kurios aprūpinimui reikia iš planuoklio: kanoninis grafas (write-set'ams) ir tai, kas
 * jau dirba. Ji paduodama FABRIKUI, o ne skaitoma iš išorės, nes ši būsena gyvena planuoklyje ir
 * keičiasi kiekvienoje bangoje — konstantos čia reikštų aklą aprūpinimą: be grafo write-set'as
 * būtų tuščias, o be „kas dirba" tas pats task'as gautų antrą lease'ą.
 */
export type ProvisioningStateAccess = {
  graph: () => TaskGraph | undefined;
  isRunning: (taskId: string) => boolean;
  hasStarted: (taskId: string) => boolean;
};

export type WaveSchedulerDeps = WaveSchedulerPorts & {
  integration: WaveIntegrationIo;
  /** Fabrikas, o ne gatavas koordinatorius: jam reikia planuoklio būsenos, kurios dar nėra. */
  provisioning: (access: ProvisioningStateAccess) => WaveProvisioningCoordinator;
  readWorkerLeases: () => Promise<WorkerLease[]>;
};

export function createWaveScheduler(deps: WaveSchedulerDeps): WaveScheduler {
  const state = createWaveSchedulerState(deps.now);
  let phantomSlots: PhantomWaveSlot[] = [];

  const provisioning = deps.provisioning({
    graph: () => state.canonicalGraph,
    isRunning: (taskId) => state.runningTaskIds.has(taskId),
    hasStarted: (taskId) => state.started.has(taskId),
  });

  const describe = (error: unknown): string => (error instanceof Error ? error.message : String(error));

  const safeLog = async (message: string): Promise<void> => {
    try {
      await deps.log(message);
    } catch {
      // Žurnalo rašymas yra pėdsakas, ne vartas.
    }
  };

  const safeEvent = async (event: WavePoolEvent): Promise<void> => {
    try {
      await deps.recordEvent(event);
    } catch {
      // Ta pati taisyklė kaip `safeLog`.
    }
  };

  const persist = async (): Promise<void> => {
    await persistWaveSnapshot({
      runId: deps.runId,
      now: deps.now,
      writeSnapshot: deps.writeSnapshot,
      state: {
        plan: state.plan,
        poolPlan: state.poolPlan,
        poolPlanWaveId: state.poolPlanWaveId,
        waveCreatedAt: state.waveCreatedAt,
        overrides: state.overrides(),
        liveSlots: liveSlotList(),
        refillEpisode: state.refillEpisode,
        refillLog: state.refillLog,
      },
    });
  };

  const { list: liveSlotList, register: registerLiveSlot } = createLiveSlotRegistry({
    now: deps.now,
    graph: () => state.canonicalGraph,
    readWorkerLeases: deps.readWorkerLeases,
    safeLog,
    admittedCandidates: state.admittedCandidates,
    liveSlots: state.liveSlots,
  });

  const graphCoordinator = createWaveGraphCoordinator({
    runId: deps.runId,
    importGraph: deps.importGraph,
    writeGraphSnapshot: deps.writeGraphSnapshot,
    log: deps.log,
    recordEvent: deps.recordEvent,
    approvals: deps.approvals,
    statuses: () => ({ completed: state.completed, blocked: state.blockedBranch, running: state.runningTaskIds }),
  });

  const integration = createWaveIntegrationCoordinator({
    ...deps.integration,
    runId: deps.runId,
    waveContext: () => ({ waveId: state.waveId, graphHash: state.graphHash }),
    safeLog,
    safeEvent,
    finishedSlots: state.finishedSlots,
    releasedLeaseIds: state.releasedLeaseIds,
    liveSlots: liveSlotList,
  });

  // Bangos biudžetas skaitomas kartą per perskaičiavimą ir laikomas čia: `gatedPlan` kviečiamas
  // kelis kartus vienam planui, o failo skaitymas kiekvienam variantui duotų skirtingus atsakymus
  // tam pačiam sprendimui.
  let waveBudget: ReadySetBudget | undefined;
  // Kodėl kanoninio grafo nėra. `undefined` = grafas yra; eilutė = importas lūžo, ir tada NĖ VIENO
  // task'o leidimo įrodyti neįmanoma (žr. `blockWaveWithoutGraph`).
  let graphUnavailableReason: string | undefined;
  /**
   * Planavimo įėjimas — VIENA vieta, kad įprastas ir resume keliai negalėtų išsiskirti. Grafas
   * paduodamas visada, kai jis yra: nuo 2/3 žingsnio kanoninė rezoliucija yra produkcinis
   * numatytasis kelias, o ne pasirenkamas režimas.
   */
  const planInput = () => ({
    tasks: state.tasks,
    completedTaskIds: state.completed,
    blockedTaskIds: state.blockedBranch,
    waveSequence: state.waveSequence,
    maxWorkers: state.requestedWorkers,
  });
  /**
   * Vienintelė vieta, kur gimsta bangos planas. Be grafo planas net nesudaromas: nuo 3/3 žingsnio
   * `scheduleNextWave` be jo neegzistuoja, tad „banga be autoriteto" yra atskiras konstruktorius,
   * o ne apkarpytas planas.
   */
  const currentPlan = (): WavePlan => {
    const graph = state.canonicalGraph;
    if (graph === undefined || graphUnavailableReason !== undefined) {
      return planWaveWithoutGraph(planInput(), graphUnavailableReason ?? "kanoninis grafas neprieinamas");
    }
    const base = scheduleNextWave({ ...planInput(), graph });
    return applyReadySetGates(base, graphCoordinator.readySet(graph, waveBudget), deps.readySetPolicy);
  };

  const replan = async (): Promise<WavePlan> => {
    state.tasks = await deps.readTasks();
    waveBudget = await deps.readySetBudget();
    // VIENINTELIS prašymo skaitymas šiam perskaičiavimui — bangos cap'as, pool'o planas ir resume
    // kelias remiasi būtent šia reikšme.
    state.requestedWorkers = await deps.requestedWorkers();
    const waveGraphHash = computeGraphHash(state.tasks);
    state.startWaveIfGraphChanged(waveGraphHash);

    // Grafas atnaujinamas PRIEŠ planavimą (2026-08-23 suvienodinimas, 2/3): nuo šiol jis yra
    // planavimo ĮĖJIMAS, o ne vėliau uždedamas vartas. Bangos tapatybė nuo grafo nepriklauso, tad
    // ją galima apskaičiuoti iš anksto — tas pats `waveIdFor`, kurį pasigamins `scheduleNextWave`.
    // Šalutinė nauda: eilės ir grafo skaitymus skiria mažesnis langas, tad `graph-state-mismatch`
    // lieka tik tikram išsiskyrimui, o ne skaitymų tarpui.
    const refreshed = await graphCoordinator.refresh(waveIdFor(state.waveSequence, waveGraphHash));
    state.canonicalGraph = refreshed.kind === "graph" ? refreshed.graph : undefined;
    graphUnavailableReason = refreshed.kind === "graph" ? undefined : refreshed.reason;

    state.plan = currentPlan();
    return state.plan;
  };

  const planPool = async (current: WavePlan): Promise<WorkerPoolPlan> => {
    const result = await planWavePool({
      runId: deps.runId,
      current,
      requestedWorkers: state.requestedWorkers,
      primaryClaimSupported: PRIMARY_SLOT_CLAIM_SUPPORTED,
      now: deps.now,
      log: deps.log,
      recordEvent: deps.recordEvent,
      readIsolationInputs: provisioning.readIsolationInputs,
      toWorkerCandidates: provisioning.toWorkerCandidates,
      rememberCandidate: (candidate) => state.admittedCandidates.set(candidate.task_id, candidate),
      provisionMissingSlotLeases: provisioning.provisionMissingSlotLeases,
      releaseWaveProvisionLease: provisioning.releaseWaveProvisionLease,
    });
    state.outcomesFor(result.pool.plan_hash);
    phantomSlots = result.phantomSlots;
    state.rememberPoolPlan(result.pool, current.wave_id, result.phantomSlots.map((slot) => slot.worker_id));
    return result.pool;
  };

  const refill = createWaveRefillCoordinator({
    absolutePath: deps.absolutePath,
    runId: deps.runId,
    primaryClaimSupported: PRIMARY_SLOT_CLAIM_SUPPORTED,
    now: deps.now,
    log: deps.log,
    recordEvent: deps.recordEvent,
    context: () => ({
      waveId: state.waveId,
      graphHash: state.graphHash,
      requestedWorkers: state.requestedWorkers,
      poolPlan: state.poolPlan,
      canonicalGraph: state.canonicalGraph,
    }),
    nextEpisode: () => state.nextRefillEpisode(),
    appendDecision: (decision) => state.appendRefillDecision(decision),
    persist,
    replan,
    liveSlots: liveSlotList,
    isRunning: (taskId) => state.runningTaskIds.has(taskId),
    hasStarted: (taskId) => state.started.has(taskId),
    readIsolationInputs: provisioning.readIsolationInputs,
    toWorkerCandidates: provisioning.toWorkerCandidates,
    provisionSlotLease: provisioning.provisionSlotLease,
    releaseUnusedProvision: (workerId, taskId) =>
      provisioning.releaseWaveProvisionLease({ task_id: taskId, worker_index: workerIndexOfId(workerId) }),
    rememberCandidate: (candidate) => state.admittedCandidates.set(candidate.task_id, candidate),
    candidateWriteSet: (taskId, graph) => candidateWriteSet(taskId, graph),
  });

  const recordOutcome = createWaveOutcomeRecorder({
    runId: deps.runId,
    tasks: () => state.tasks,
    waveContext: () => ({ waveId: state.plan?.wave_id, graphHash: state.graphHash, refillEpisode: state.refillEpisode }),
    poolPlan: () => state.poolPlan,
    liveSlots: state.liveSlots,
    finishedSlots: state.finishedSlots,
    duplicateAtDispatch: state.duplicateAtDispatch,
    withdrawnTasks: state.withdrawnTasks,
    runningTaskIds: state.runningTaskIds,
    completed: state.completed,
    blockedBranch: state.blockedBranch,
    markUnjudged: (workerId) => state.markUnjudged(workerId),
    outcomesFor: (planHash) => state.outcomesFor(planHash),
    judgedPlan: (pool) => state.judgedPlan(pool),
    settle: (taskId, taskState, reason, file) => state.settle(taskId, taskState, reason, file),
    liveSlotList,
    persist,
    safeLog,
    safeEvent,
    log: deps.log,
    recordEvent: deps.recordEvent,
    recordCheckpoint: deps.recordCheckpoint,
    integrateFinishedSlots: integration.integrateFinishedSlots,
  });

  /** Ledger'io klausimas, kuris negali nutraukti dispatch'o: nežinia = „ne dublikatas". */
  const duplicateProbe = async (taskId: string, absoluteFile: string): Promise<boolean> => {
    try {
      return await deps.ledgerDuplicate(taskId, absoluteFile);
    } catch (error) {
      await safeLog(`WAVE SLOT DUPLICATE PROBE FAILED: task=${taskId}: ${describe(error)}`);
      return false;
    }
  };

  return {
    runId: deps.runId,

    isSlotWithdrawn: (taskId) => state.withdrawnTasks.has(taskId),

    async blockUnrunnableTask(taskId, reason): Promise<void> {
      // Būsena čia yra „nevykdytinas", o ne „žlugęs": bandymo nebuvo, tad ledger'is, integracija ir
      // parkavimas nepaliečiami — task'o failas lieka eilėje žmogui. Blokuojama ir šaka: neatliktas
      // blokatorius negali atrakinti savo priklausinių vien todėl, kad jo niekas nepaleido.
      for (const blocked of collectBlockedBranch(state.tasks, taskId)) state.blockedBranch.add(blocked);
      state.settle(taskId, "blocked", reason);
      for (const blocked of state.blockedBranch) {
        if (blocked !== taskId) state.settle(blocked, "blocked", "branch-blocked");
      }
      await persist();
      await deps.log(`WAVE SLOT UNRUNNABLE: task=${taskId} reason=${reason} — task'as lieka eilėje, eilė tęsiama be jo`);
      await deps.recordEvent({
        run_id: deps.runId,
        wave_id: state.waveId,
        graph_hash: state.graphHash,
        event: "task_branch_blocked",
        task_id: taskId,
        reason,
      });
    },

    async recoverFromCrash(): Promise<ResumeDecision> {
      const checkpoint = await deps.readCheckpoint();
      // Grafo snapshot'as skaitomas PRIEŠ `replan()` sąmoningai: `replan()` grafą perimportuoja ir
      // pasikeitusį iškart perrašo, tad po jo matytume tik savo pačių ką tik įrašytą failą ir
      // niekada nepastebėtume pasenusios ar sugadintos ankstesnio proceso kopijos.
      const storedGraph = await deps.readGraphSnapshot();
      const current = await replan();
      await graphCoordinator.reportSnapshot(storedGraph, state.canonicalGraph, current.wave_id);

      const snapshot = await deps.readSnapshot();
      if (snapshot !== undefined && snapshot.graph_hash === current.graph_hash && snapshot.wave_sequence >= state.waveSequence) {
        // Tas pats grafas kaip prieš kritimą — numeracija tęsiama, kad įvykiai ir snapshot'ai
        // liktų vienoje istorijoje. Vartai taikomi ir čia: abu keliai duoda tą patį planą.
        state.waveSequence = snapshot.wave_sequence;
        state.plan = currentPlan();
      }

      const taskId = checkpoint?.task_id ?? "";
      const decision = decideResume(checkpoint, {
        currentGraphHash: current.graph_hash,
        location: taskId === "" ? "absent" : await deps.locateTask(taskId),
        acceptedCommit: taskId === "" ? false : await deps.hasAcceptedWork(taskId),
        completedTaskIds: state.completed,
      });

      if (decision.action === "skip-completed" && decision.task_id !== undefined) {
        // Idempotentiškumas: priimtas arba užverstas darbas NIEKADA nekartojamas.
        state.started.add(decision.task_id);
        const closure = await integration.closeSkipCompletedTaskFile(decision.task_id, decision.reason);
        if (closure.state === "done") {
          state.completed.add(decision.task_id);
          state.settle(decision.task_id, "done", decision.reason);
          await deps.log(
            `WAVE RESUME TASK CLOSED: task=${decision.task_id} task_file=${closure.relocation} via=skip-completed (${decision.reason})`,
          );
          await deps.recordEvent({
            run_id: deps.runId,
            wave_id: state.waveId,
            graph_hash: current.graph_hash,
            event: "resume_task_closed",
            task_id: decision.task_id,
            reason: `${closure.relocation}; ${decision.reason}`,
          });
        } else {
          // Ledger'is NIEKADA neteigia „done", kai failo nėra nė viename bucket'e — task'as jau
          // parkuotas žmogui `closeSkipCompletedTaskFile` viduje.
          state.settle(decision.task_id, "failed", `skip-completed-escalated: ${decision.reason}`);
          await deps.log(`WAVE RESUME TASK ESCALATED: task=${decision.task_id} via=skip-completed (${decision.reason})`);
        }
      }

      if (decision.action !== "no-checkpoint") {
        await deps.log(`WAVE RESUME: ${decision.action} task=${decision.task_id ?? "none"} (${decision.reason})`);
        await deps.recordEvent({
          run_id: deps.runId,
          wave_id: state.waveId,
          graph_hash: current.graph_hash,
          event: "resume_decision",
          ...(decision.task_id === undefined ? {} : { task_id: decision.task_id }),
          reason: decision.reason,
        });
      }

      await persist();
      return decision;
    },

    async nextTask(): Promise<WaveSelection> {
      const current = await replan();
      await persist();

      if (current.ready.length === 0 && current.blocked.length === 0) return { kind: "empty" };

      const selected = selectNextWaveTask(current, { startedTaskIds: state.started });
      if (selected === undefined) {
        const reason = current.blocked.length > 0 ? "all-blocked" : "already-started";
        // Konkrečios priežastys — vienoje deterministinėje eilutėje, ta pačia forma žurnale,
        // įvykyje ir operatoriaus išvestyje.
        const detail = formatWaveBlockedReason(reason, current.blocked);
        await deps.log(
          `WAVE ${reason === "all-blocked" ? "BLOCKED" : "EXHAUSTED"}: wave=${current.wave_id} ready=${current.ready.length} blocked=${current.blocked.length} reasons=${detail}`,
        );
        await deps.recordEvent({
          run_id: deps.runId,
          wave_id: current.wave_id,
          graph_hash: current.graph_hash,
          event: "wave_blocked",
          reason: detail,
        });
        return { kind: "exhausted", plan: current, reason, detail };
      }

      const pool = await planPool(current);
      return {
        kind: "task",
        task: selected,
        absoluteFile: deps.absolutePath(selected.file),
        plan: current,
        pool,
        ...(phantomSlots.length > 0 ? { phantom: [...phantomSlots] } : {}),
      };
    },

    async beginTask(selection): Promise<void> {
      // Slot'ų skaičius ateina IŠ leidimo sprendimo, o ne iš konstantos: papildytas task'as jokiam
      // bangos planui nepriklauso, tad jo talpą pasako būtent papildymo sprendimas.
      const grantedSlots =
        selection.refill === undefined
          ? Math.max(1, state.judgedSlots(selection.pool).length)
          : Math.max(1, selection.refill.granted_workers);
      if (!state.runningTaskIds.has(selection.task.task_id) && state.runningTaskIds.size >= grantedSlots) {
        // Programavimo klaida, ne runtime būsena: tyliai leisti dar vieną task'ą reikštų
        // neizoliuotą paralelizmą be konfliktų detektoriaus verdikto.
        const running = [...state.runningTaskIds].sort().join(", ");
        throw new Error(
          grantedSlots === 1
            ? `wave scheduler allows one worker: task ${running} is still running, refusing to start ${selection.task.task_id}`
            : `wave scheduler granted ${grantedSlots} worker slots: ${running} still running, refusing to start ${selection.task.task_id}`,
        );
      }

      // Duplikato faktas fiksuojamas PRIEŠ vykdymą — po jo jo nebeįrodysi: dublikatą pastebėjęs
      // vykdymo kelias task'o failą perkelia ir grąžina „nesėkmę", tad eilės failo, iš kurio buvo
      // skaičiuotas fingerprint'as, nebelieka. Be šio įrašo banga tokį slot'ą užverstų kaip
      // žlugusį, nors bandymo išvis nebuvo.
      if (await duplicateProbe(selection.task.task_id, selection.absoluteFile)) {
        state.duplicateAtDispatch.add(selection.task.task_id);
      }

      state.runningTaskIds.add(selection.task.task_id);
      state.started.add(selection.task.task_id);
      state.settle(selection.task.task_id, "running", undefined, selection.task.file);
      await registerLiveSlot(selection);
      await persist();
      await deps.recordEvent({
        run_id: deps.runId,
        wave_id: selection.plan.wave_id,
        graph_hash: selection.plan.graph_hash,
        event: "task_started",
        task_id: selection.task.task_id,
      });
      await deps.recordCheckpoint({
        actor: "claude",
        phase: "wave-dispatch",
        status: "started",
        task_id: selection.task.task_id,
        task_file: selection.absoluteFile,
        run_id: deps.runId,
        wave_id: selection.plan.wave_id,
        graph_hash: selection.plan.graph_hash,
        attempt_id: `${selection.plan.wave_id}:${selection.task.task_id}`,
        next_action: "dispatch",
      });
    },

    recordOutcome,

    refillSlot: refill.refillSlot,
  };
}

/** `w2` → 2; neatpažinta forma duoda pirminį slot'ą. Ta pati taisyklė kaip papildyme. */
function workerIndexOfId(workerId: string): number {
  const parsed = Number.parseInt(workerId.replace(/^w/i, ""), 10);
  return Number.isInteger(parsed) && parsed >= 1 ? parsed : 1;
}
