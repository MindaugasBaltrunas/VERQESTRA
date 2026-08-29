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

import {
  collectBlockedBranch,
  computeGraphHash,
  queueSliceFromGraph,
  scheduleNextWave,
  selectNextWaveTask,
  type SchedulableTask,
} from "./schedule-next-wave.js";
import { applyReadySetGates, formatWaveBlockedReason, planWaveWithoutGraph } from "./apply-ready-set-gates.js";
import { decideResume, describeStrandedStaleResume, type ResumeDecision } from "./resume-run.js";
import { createLiveSlotRegistry, candidateWriteSet } from "./wave-live-slots.js";
import { createWaveGraphCoordinator } from "./wave-graph.js";
import type { ReadySetBudget } from "./build-ready-set.js";
import { createWaveIntegrationCoordinator } from "./wave-integration-coordinator.js";
import { createWaveOutcomeRecorder } from "./wave-outcome.js";
import { createWaveRefillCoordinator, workerIndexOf } from "./wave-refill.js";
import { createWaveSchedulerState } from "./wave-scheduler-state.js";
import { createSafeTelemetry } from "./safe-telemetry.js";
import { persistWaveSnapshot } from "./wave-snapshot-persist.js";
import { planWavePool } from "./wave-pool-planning.js";
import { PRIMARY_SLOT_CLAIM_SUPPORTED, type WaveProvisioningCoordinator } from "./wave-provisioning.js";
import type { WavePlan } from "./schedule-next-wave.js";
import type { TaskGraph } from "../../domain/tasks/graph/model.js";
import type { WorkerPoolPlan } from "./worker-pool-plan.js";
import type { PhantomWaveSlot } from "./wave-phantom-slots.js";
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

  // Vienas adapteris visiems diagnostiniams rašymams (2026-08-23, operatoriaus radinys). Iki tol
  // šie wrapper'iai gyveno čia, bet į sub-koordinatorius keliavo NEAPSAUGOTI `deps.log` ir
  // `deps.recordEvent` — trečia šio failo taisyklė galiojo tik ten, kur ją prisiminė kviečiantysis.
  // Nuo šiol `deps.log`/`deps.recordEvent` šiame faile nebeminimi NIEKUR kitur, ir tai prikalta
  // testu: pamiršti nebėra kur.
  const { safeLog, safeEvent } = createSafeTelemetry(deps);

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
        finishedSlots: [...state.finishedSlots.values()],
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
    log: safeLog,
    recordEvent: safeEvent,
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
  // task'o leidimo įrodyti neįmanoma (žr. `planWaveWithoutGraph`).
  let graphUnavailableReason: string | undefined;
  /**
   * Planavimo įėjimas — VIENA vieta, kad įprastas ir resume keliai negalėtų išsiskirti. Grafas
   * paduodamas visada, kai jis yra: nuo 2/3 žingsnio kanoninė rezoliucija yra produkcinis
   * numatytasis kelias, o ne pasirenkamas režimas.
   */
  const planInput = (tasks: readonly SchedulableTask[]) => ({
    tasks,
    completedTaskIds: state.completed,
    blockedTaskIds: state.blockedBranch,
    waveSequence: state.waveSequence,
    maxWorkers: state.requestedWorkers,
  });
  /**
   * Vienintelė vieta, kur gimsta bangos planas. Be grafo planas net nesudaromas: nuo 3/3 žingsnio
   * `scheduleNextWave` be jo neegzistuoja, tad „banga be autoriteto" yra atskiras konstruktorius,
   * o ne apkarpytas planas.
   *
   * `observedQueue` — FS eilės skaitymas. Jis paduodamas kaip KRYŽMINĖ PATIKRA (`scheduleNextWave`
   * iš jo daro `gate:graph-state-mismatch` įrašus), o kandidatus ir tapatybę ima grafas. Resume
   * kelyje šviežio skaitymo nėra, tad ten paduodama bangos būsena — ji jau grafo kilmės.
   */
  const currentPlan = (observedQueue: readonly SchedulableTask[] = state.tasks): WavePlan => {
    const graph = state.canonicalGraph;
    if (graph === undefined || graphUnavailableReason !== undefined) {
      return planWaveWithoutGraph(planInput(state.tasks), graphUnavailableReason ?? "kanoninis grafas neprieinamas");
    }
    const base = scheduleNextWave({ ...planInput(observedQueue), graph });
    return applyReadySetGates(base, graphCoordinator.readySet(graph, waveBudget), deps.readySetPolicy);
  };

  const replan = async (): Promise<WavePlan> => {
    state.tasks = await deps.readTasks();
    waveBudget = await deps.readySetBudget();
    // VIENINTELIS prašymo skaitymas šiam perskaičiavimui — bangos cap'as, pool'o planas ir resume
    // kelias remiasi būtent šia reikšme.
    state.requestedWorkers = await deps.requestedWorkers();
    // Eilės skaitymas laikomas atskirai: jis lieka KRYŽMINE PATIKRA planuoklyje, o bangos būsena
    // (`state.tasks`) po importo perimama iš grafo — kitaip vykdoma užduotis galėtų nebūti tame
    // sąraše, kuriuo remiasi šakos ir baigties logika (2026-08-23, operatoriaus radinys).
    const observedQueue = state.tasks;

    // DVI FAZĖS (2026-08-23, operatoriaus radinys). FAZĖ 1 — importas: `refresh()` grafo įvykių
    // NERAŠO, tik grąžina juos laukiančius. Anksčiau jis gaudavo provizorinį `waveId`, sudėtą iš
    // TUOMETINĖS sekos, o `startWaveIfGraphChanged` numerį pakelia tik po importo — tad naujos
    // bangos `graph_unavailable` patekdavo į istoriją su ankstesniu numeriu
    // (`graph_unavailable@w1-…` ir `wave_blocked@w2-…` toje pačioje bangoje).
    //
    // Grafas atnaujinamas PRIEŠ planavimą (2026-08-23 suvienodinimas, 2/3): nuo šiol jis yra
    // planavimo ĮĖJIMAS, o ne vėliau uždedamas vartas.
    const refreshed = await graphCoordinator.refresh();
    state.canonicalGraph = refreshed.kind === "graph" ? refreshed.graph : undefined;
    graphUnavailableReason = refreshed.kind === "graph" ? undefined : refreshed.reason;

    // Bangos būsena perimama iš grafo, kai jis yra: jis šviežesnis ir jis autoritetas. Be grafo
    // lieka eilės skaitymas — tada banga vis tiek sustabdoma (`planWaveWithoutGraph`), bet sąrašas
    // turi būti tikras, kad operatorius matytų, KĄ sustabdėme.
    state.tasks = state.canonicalGraph === undefined ? observedQueue : queueSliceFromGraph(state.canonicalGraph);
    state.startWaveIfGraphChanged(computeGraphHash(state.tasks));

    state.plan = currentPlan(observedQueue);

    // FAZĖ 2 — įvykiai. Žymuo imamas iš PATIES plano, o ne perskaičiuojamas: dvi tapatybės,
    // skaičiuojamos atskirai, anksčiau ar vėliau išsiskiria, o čia sutapimas ir yra visa prasmė.
    await graphCoordinator.recordEvents(refreshed.events, state.plan.wave_id);
    return state.plan;
  };

  const planPool = async (current: WavePlan): Promise<WorkerPoolPlan> => {
    const result = await planWavePool({
      runId: deps.runId,
      current,
      requestedWorkers: state.requestedWorkers,
      primaryClaimSupported: PRIMARY_SLOT_CLAIM_SUPPORTED,
      now: deps.now,
      log: safeLog,
      recordEvent: safeEvent,
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
    log: safeLog,
    recordEvent: safeEvent,
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
      provisioning.releaseWaveProvisionLease({ task_id: taskId, worker_index: workerIndexOf(workerId) }),
    rememberCandidate: (candidate) => state.admittedCandidates.set(candidate.task_id, candidate),
    candidateWriteSet: (taskId, graph) => candidateWriteSet(taskId, graph),
  });

  const recordOutcome = createWaveOutcomeRecorder({
    runId: deps.runId,
    tasks: () => state.tasks,
    graph: () => state.canonicalGraph,
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
    log: safeLog,
    recordEvent: safeEvent,
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
      for (const blocked of collectBlockedBranch(state.tasks, taskId, state.canonicalGraph)) {
        state.blockedBranch.add(blocked);
      }
      state.settle(taskId, "blocked", reason);
      for (const blocked of state.blockedBranch) {
        if (blocked !== taskId) state.settle(blocked, "blocked", "branch-blocked");
      }
      await persist();
      await safeLog(`WAVE SLOT UNRUNNABLE: task=${taskId} reason=${reason} — task'as lieka eilėje, eilė tęsiama be jo`);
      await safeEvent({
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
      // Ankstesnio proceso grafas skaitomas PRIEŠ `replan()` sąmoningai: `replan()` grafą
      // perimportuoja ir pasikeitusį iškart perrašo, tad po jo matytume tik savo pačių ką tik
      // įrašytą failą ir niekada nepastebėtume pasenusios ar sugadintos ankstesnio proceso kopijos.
      //
      // Jis PALYGINAMAS ir raportuojamas, bet niekada netampa autoritetu ir nėra fallback'as, kai
      // Markdown importas lūžta — žr. `wave-graph` antraštę. Atkūrimas čia reikštų vykdymą pagal
      // kešą, kurio patikrinti nebeįmanoma.
      const storedGraph = await deps.readGraphSnapshot();
      const current = await replan();
      await graphCoordinator.reportStoredGraph(storedGraph, state.canonicalGraph, current.wave_id);

      const snapshot = await deps.readSnapshot();
      // Atkuriama NEPRIKLAUSOMAI nuo `decision_hash` sutapimo žemiau — audito P1, 2026-08-29.
      state.restoreFinishedSlots(snapshot?.finished_slots ?? []);
      // Lyginamas SPRENDIMO, o ne grafo atspaudas (2026-08-23, operatoriaus radinys).
      // `graph_hash` mato tik eilės pjūvį, tad patvirtinimo atšaukimas, biudžeto išsekimas ar
      // statuso pasikeitimas jo nejudino — ir po kritimo atkurta banga galėjo remtis leidimu,
      // kurio nebėra. `decision_hash` apima `graph_hash`, tad tai griežtinimas, ne mainai.
      if (snapshot !== undefined && snapshot.decision_hash === current.decision_hash && snapshot.wave_sequence >= state.waveSequence) {
        // Tas pats sprendimas kaip prieš kritimą — numeracija tęsiama, kad įvykiai ir snapshot'ai
        // liktų vienoje istorijoje. Vartai taikomi ir čia: abu keliai duoda tą patį planą.
        state.waveSequence = snapshot.wave_sequence;
        state.plan = currentPlan();
      }

      const taskId = checkpoint?.task_id ?? "";
      const checkpointLocation = taskId === "" ? ("absent" as const) : await deps.locateTask(taskId);
      const decision = decideResume(checkpoint, {
        currentGraphHash: current.graph_hash,
        location: checkpointLocation,
        acceptedCommit: taskId === "" ? false : await deps.hasAcceptedWork(taskId),
        completedTaskIds: state.completed });

      if (decision.action === "skip-completed" && decision.task_id !== undefined) {
        // Idempotentiškumas: priimtas arba užverstas darbas NIEKADA nekartojamas.
        state.started.add(decision.task_id);
        const closure = await integration.closeSkipCompletedTaskFile(decision.task_id, decision.reason);
        if (closure.state === "done") {
          state.completed.add(decision.task_id);
          state.settle(decision.task_id, "done", decision.reason);
          await safeLog(
            `WAVE RESUME TASK CLOSED: task=${decision.task_id} task_file=${closure.relocation} via=skip-completed (${decision.reason})`,
          );
          await safeEvent({
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
          await safeLog(`WAVE RESUME TASK ESCALATED: task=${decision.task_id} via=skip-completed (${decision.reason})`);
        }
      }

      if (decision.action !== "no-checkpoint") {
        await safeLog(`WAVE RESUME: ${decision.action} task=${decision.task_id ?? "none"} (${decision.reason})${describeStrandedStaleResume(decision, checkpointLocation)}`);
        await safeEvent({
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

      // Atkurtas finished slot'as blokuoja dispatch'ą TA PAČIA priemone kaip `started`, kol
      // koordinatorius jo neišima iš `finishedSlots` (audito P1, 2026-08-29).
      const selected = selectNextWaveTask(current, {
        startedTaskIds: new Set([...state.started, ...state.finishedSlots.keys()]),
      });
      if (selected === undefined) {
        const reason = current.blocked.length > 0 ? "all-blocked" : "already-started";
        // Konkrečios priežastys — vienoje deterministinėje eilutėje, ta pačia forma žurnale,
        // įvykyje ir operatoriaus išvestyje.
        const detail = formatWaveBlockedReason(reason, current.blocked);
        await safeLog(
          `WAVE ${reason === "all-blocked" ? "BLOCKED" : "EXHAUSTED"}: wave=${current.wave_id} ready=${current.ready.length} blocked=${current.blocked.length} reasons=${detail}`,
        );
        await safeEvent({
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
      await safeEvent({
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
