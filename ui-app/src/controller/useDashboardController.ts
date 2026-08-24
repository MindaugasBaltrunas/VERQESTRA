import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  adaptLoopControl,
  adaptOverview,
  adaptRuntime,
  adaptWorkerControl,
  adaptWorkflowBuckets,
} from "../model/dashboardViewModel";
import * as api from "../model/api";
import { fill } from "../model/fillTemplate";
import {
  fixActionId,
  loopActionAllowed,
  loopRunStateOf,
  slotActionId,
  streamIndexOf,
  workersActionId,
  LOOP_RESTART_ACTION,
  LOOP_START_ACTION,
  LOOP_STOP_ACTION,
  type LoopRunState,
} from "../model/loopControlsViewModel";
import { runRestartLoop, type RestartLoopOptions } from "../model/restartLoop";
import type { DashboardData, LoopSlotMode, LoopWorkerId } from "../model/types";
import { useI18n } from "../i18n/I18nContext";
import { useAgentActivity } from "./useAgentActivity";
import { useOperatorActions } from "./useOperatorActions";

const REFRESH_SEC = 30;

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// Etiketės yra vartotojui matomas tekstas, tad jos rašomos ANGLIŠKAI (raktų kalba) ir verčiamos
// per `t()` Header'yje. Anksčiau čia buvo lietuviški literalai, kurie EN režime likdavo
// neišversti, nes žodyne tokių raktų nėra (2026-08-06 UI auditas).
function resumeLoopLabel(status: string, pid?: number): string {
  const label =
    status === "already-running" ? "already running" : status === "started" ? "started" : status;
  return `▶ ${label}${pid ? ` (pid ${pid})` : ""}`;
}

/**
 * Mygtukų būsena: veikia → tik „Sustabdyti"; neveikia → tik „Paleisti".
 *
 * Trečioji būsena — `unknown` — anksčiau buvo tylus pavojus: `status !== "running"` darė
 * „Paleisti" AKTYVŲ (t. y. UI siūlė paleisti ANTRĄ orkestratorių), o `status === "running"`
 * darė „Sustabdyti" IŠJUNGTĄ (veikiančio sustabdyti nebuvo galima). Būtent taip atrodė
 * 2026-08-06 gedimas, kai senas UI procesas nemokėjo perskaityti naujo PID įrašo formato.
 *
 * Nežinomoje būsenoje pasirenkamas SAUGUS veiksmas: leidžiama stabdyti (stop vėliavos įrašymas
 * nekenksmingas ir veikia net terminale paleistam loop'ui), bet neleidžiama paleisti — antras
 * orkestratorius tame pačiame repo yra reali žala.
 *
 * `label` sąlygos palieka trumpą langą po paspaudimo, kad dvigubas paspaudimas nesukurtų dviejų
 * užklausų, kol serveris dar neatnaujino būsenos. Tai VIENINTELIS dalykas, kurį ši funkcija
 * sprendžia pati — pati leidimo taisyklė gyvena `loopActionAllowed`.
 *
 * 2026-08-24 auditas: čia buvo ANTRA leidimo taisyklės kopija, ir ji jau buvo prasilenkusi su
 * pirmąja. Nežinoma būsena, atėjusi kaip `undefined`, čia virsdavo „sustojusiu" ir LEISDAVO
 * paleisti — priešingai nei sako ši pati antraštė ir nei elgiasi `#/system` valdikliai.
 * Pagrindimas „fresh project, loop never ran" nebegalioja nuo tada, kai serveris `runtime` sąrašą
 * siunčia VISADA: „įrašo nėra" nebereiškia švaraus projekto, o reiškia netvarkingą atsakymą, kur
 * paleidimo siūlyti tuo labiau negalima.
 */
export function buildLoopControls(
  loopStatus: LoopRunState,
  resumeLabel: string,
  stopLabel: string,
): { canResume: boolean; canStop: boolean } {
  const allowed = loopActionAllowed(loopStatus);
  return {
    canResume: allowed.start && resumeLabel === "▶ Start loop",
    canStop: allowed.stop && stopLabel === "⏹ Stop loop",
  };
}

/**
 * Laukimas, kurį galima nutraukti. `setTimeout` be `signal` perkrovimo apklausą laikytų gyvą iki 15
 * sekundžių net išmontavus rodinį — ir tas laukimas baigtųsi ciklo paleidimu ekranui, kurio nebėra.
 */
function waitOrAbort(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise<void>((resolve) => {
    if (signal?.aborted) {
      resolve();
      return;
    }
    let timer: ReturnType<typeof setTimeout> | null = null;
    const finish = () => {
      if (timer !== null) clearTimeout(timer);
      signal?.removeEventListener("abort", finish);
      resolve();
    };
    timer = setTimeout(finish, ms);
    signal?.addEventListener("abort", finish, { once: true });
  });
}

/** Perrašo ankstesnį timer'į ir įsimena naują, kad unmount galėtų jį atšaukti. */
function scheduleLabelReset(
  timer: { current: ReturnType<typeof setTimeout> | null },
  setLabel: (label: string) => void,
  label: string,
  delayMs: number,
): void {
  if (timer.current) clearTimeout(timer.current);
  timer.current = setTimeout(() => {
    timer.current = null;
    setLabel(label);
  }, delayMs);
}

export function useDashboardController() {
  // Pranešimo tekstas gimsta čia, o `notice` renderinamas be `t()`, tad vertimas privalo įvykti
  // prieš įrašant reikšmę. Raktas — angliškas sakinys be interpoliacijos; detalė prikabinama po jo.
  const { t } = useI18n();
  const [data, setData] = useState<DashboardData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [refreshError, setRefreshError] = useState<string | null>(null);
  /** Kada PASKUTINĮ kartą pavyko perskaityti `/api/dashboard`; `null` — dar nė karto. */
  const [loadedAt, setLoadedAt] = useState<number | null>(null);
  const [resumeLabel, setResumeLabel] = useState("▶ Start loop");
  const [stopLabel, setStopLabel] = useState("⏹ Stop loop");
  // Vienas mutuojančių veiksmų kelias (task 1235): dvigubo paspaudimo apsauga ir rezultato pranešimas.
  // `notice` lieka įkėlimo, aplanko, politikų ir mokymosi keliams — jie čia neįtraukti sąmoningai.
  const { pendingActions, run, toasts, dismissToast } = useOperatorActions();
  const hasDashboardData = useRef(false);
  const lastSnapshot = useRef<string | null>(null);
  const requestSequence = useRef(0);
  const {
    activity: agentActivity,
    slots: agentSlotActivities,
    status: agentActivityStatus,
    lastError: agentActivityError,
  } = useAgentActivity();
  // Mygtukų etikečių grąžinimo timer'iai. Anksčiau `setTimeout` buvo paleidžiami be nuorodos ir
  // be cleanup: perėjus į kitą route iškart po „Start loop", timer'is vis tiek suveikdavo ir
  // rašydavo į nebeegzistuojantį komponentą, o grįžus etiketė likdavo užšalusi.
  const resumeResetTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const stopResetTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Vykdomo perkrovimo atšaukimas. `run` neleidžia dviejų perkrovimų vienu metu, tad vienos nuorodos
  // pakanka; ji egzistuoja būtent tam, kad išmontavimas galėtų nutraukti eigą PRIEŠ paleidimą.
  const restartAbort = useRef<AbortController | null>(null);

  useEffect(() => {
    return () => {
      // Timer refs (not DOM nodes): the LATEST timer id must be cleared at unmount,
      // so reading .current here is the point — snapshotting it at mount would clear null.
      // eslint-disable-next-line react-hooks/exhaustive-deps -- timer ref must be read at cleanup time
      if (resumeResetTimer.current) clearTimeout(resumeResetTimer.current);
      // eslint-disable-next-line react-hooks/exhaustive-deps -- timer ref must be read at cleanup time
      if (stopResetTimer.current) clearTimeout(stopResetTimer.current);
      // Vykdomas perkrovimas nutraukiamas kartu su rodiniu: apklausa liaujasi, o paleidimas
      // NEĮVYKSTA — ekranui, kurio nebėra, ciklas nepaleidžiamas.
      restartAbort.current?.abort();
    };
  }, []);

  const load = useCallback(async () => {
    const requestId = ++requestSequence.current;
    try {
      const dashboard = await api.fetchDashboard();
      if (requestId !== requestSequence.current) return;
      const serialized = JSON.stringify(dashboard);
      // Sėkmingo POLLO laikas, o ne duomenų pakeitimo: „nepasikeitė" yra šviežias atsakymas,
      // o ne pasenę duomenys. Žymima PRIEŠ ankstyvą grįžimą — kitaip ramus, nieko nekeičiantis
      // ciklas ekrane atrodytų kaip nutrūkęs ryšys.
      setLoadedAt(Date.now());
      if (serialized === lastSnapshot.current) {
        // Nothing changed since the last poll — skip the state update so the
        // dashboard does not re-render (and thus does not visually jump).
        setError(null);
        setRefreshError(null);
        return;
      }
      lastSnapshot.current = serialized;
      setData(dashboard);
      hasDashboardData.current = true;
      setError(null);
      setRefreshError(null);
    } catch (loadError) {
      if (requestId !== requestSequence.current) return;
      const message = toErrorMessage(loadError);
      if (hasDashboardData.current) {
        setRefreshError(`Nepavyko atnaujinti duomenų: ${message}`);
        return;
      }
      setError(message);
    }
  }, []);

  useEffect(() => {
    queueMicrotask(() => {
      void load();
    });
    const timer = setInterval(() => {
      void load();
    }, REFRESH_SEC * 1000);

    return () => clearInterval(timer);
  }, [load]);

  const dashboard = useMemo(() => {
    if (!data) return null;

    return {
      root: data.root,
      overview: adaptOverview(data),
      buckets: adaptWorkflowBuckets(data.workflowBuckets),
      runtime: adaptRuntime(data.runtime),
      workerControl: adaptWorkerControl(data.workerControl),
      loopControl: adaptLoopControl(data.loopControl),
      /**
       * Šaltiniai, kurių serveris NEPERSKAITĖ (`/api/dashboard#degraded`).
       *
       * Iki 2026-08-24 audito serveris juos įvardydavo, o klientas lauko net neturėjo tipe: kai
       * `control_plane` sugriūdavo, `#/learning` likdavo TUŠČIAS, o `#/reviews` tyliai netekdavo
       * politikų valdiklių — be nė vieno požymio, kad kažko trūksta. Degradavimo kanalas be
       * vartotojo yra tas pats tylus gedimas, kurį jis turėjo padaryti matomą.
       */
      degraded: data.degraded ?? [],
      // Eilės srauto lentai reikia `blocked_by`/`reason`: be jų „Blokuojama" stulpelis parodytų
      // užduotį, bet nutylėtų, KAS ją blokuoja. Tuščias masyvas, o ne `undefined` — nežinomybės
      // ir „nieko nelaukia" skirtumą jau neša `controlPlane` buvimas.
      humanReview: data.controlPlane?.human_review_tasks ?? [],
      policyControls: data.controlPlane?.policy_controls,
      learning: data.controlPlane
        ? {
            summary: data.controlPlane.learning_summary,
            recommendations: data.controlPlane.learning_recommendations,
          }
        : undefined,
    };
  }, [data]);

  const resumeLoop = useCallback(async () => {
    setResumeLabel("▶ Starting...");
    try {
      const result = await api.resumeLoop();
      setResumeLabel(resumeLoopLabel(result.status, result.pid));
      setNotice(null);
      void load();
      scheduleLabelReset(resumeResetTimer, setResumeLabel, "▶ Start loop", 4000);
    } catch (resumeError) {
      const message = toErrorMessage(resumeError);
      setResumeLabel(`▶ Error: ${message}`);
      setNotice(`Could not start the loop: ${message}`);
      scheduleLabelReset(resumeResetTimer, setResumeLabel, "▶ Start loop", 6000);
    }
  }, [load]);

  /**
   * Ciklo stabdymas. Header'is toliau gyvena iš `stopLabel`, o rezultato sakinys nuo šiol keliauja į
   * pranešimų krūvelę — taip tas pats veiksmas iš Header'io ir iš ciklo valdymo juostos dalijasi
   * viena „vykdoma" būsena ir nebegali būti paleistas dukart.
   */
  const stopLoop = useCallback(async () => {
    await run(LOOP_STOP_ACTION, {
      perform: async () => {
        setStopLabel("⏹ Stopping...");
        try {
          const result = await api.stopLoop();
          if (result.status === "failed") throw new Error(result.reason ?? result.status);
          // Serveris nebemeluoja: `…-no-known-process` reiškia, kad vėliava įrašyta, bet gyvo, šiam
          // UI žinomo proceso nėra.
          setStopLabel(result.status === "stop-requested" ? `⏹ stopping (pid ${result.pid})` : "⏹ Stop loop");
          scheduleLabelReset(stopResetTimer, setStopLabel, "⏹ Stop loop", 6000);
          void load();
          return result.status === "stop-requested"
            ? fill(t("Stop requested; the loop will stop after the current task (pid {pid})."), {
                pid: result.pid ?? "—",
              })
            : t("Stop was recorded, but no running loop process is known to this UI.");
        } catch (stopError) {
          setStopLabel(`⏹ Error: ${toErrorMessage(stopError)}`);
          scheduleLabelReset(stopResetTimer, setStopLabel, "⏹ Stop loop", 6000);
          throw stopError;
        }
      },
      failureMessage: t("Could not stop the loop"),
    });
  }, [load, run, t]);


  const uploadTaskFiles = useCallback(
    async (files: File[]) => {
      try {
        await api.uploadTaskFiles(files);
        setNotice(null);
        void load();
      } catch (uploadError) {
        const message = `Nepavyko įkelti užduoties: ${toErrorMessage(uploadError)}`;
        setNotice(message);
        throw new Error(message, { cause: uploadError });
      }
    },
    [load],
  );

  const approveLearning = useCallback(
    async (id: string) => {
      try {
        await api.approveLearningRecommendation(id);
        setNotice(null);
        void load();
      } catch (decisionError) {
        setNotice(`Nepavyko patvirtinti rekomendacijos: ${toErrorMessage(decisionError)}`);
      }
    },
    [load],
  );

  const rejectLearning = useCallback(
    async (id: string) => {
      try {
        await api.rejectLearningRecommendation(id);
        setNotice(null);
        void load();
      } catch (decisionError) {
        setNotice(`Nepavyko atmesti rekomendacijos: ${toErrorMessage(decisionError)}`);
      }
    },
    [load],
  );

  const openFolder = useCallback(async (bucket: string) => {
    try {
      await api.openFolder(bucket);
      setNotice(null);
    } catch (openError) {
      setNotice(`Nepavyko atidaryti aplanko: ${toErrorMessage(openError)}`);
    }
  }, []);

  const loadWorkflowTasks = useCallback(async (bucket: string): Promise<string[]> => {
    const result = await api.fetchWorkflowTasks(bucket);
    return result.tasks;
  }, []);

  const proposePolicy = useCallback(
    async (route: string, settingId: string, requestedValue: unknown, reason: string) => {
      try {
        await api.proposePolicy(route, { setting_id: settingId, requested_value: requestedValue, reason });
        setNotice(null);
        void load();
      } catch (proposeError) {
        setNotice(`Nepavyko pateikti pasiūlymo: ${toErrorMessage(proposeError)}`);
      }
    },
    [load],
  );

  const setRequestedWorkers = useCallback(
    async (requested: number) => {
      await run(workersActionId(requested), {
        perform: async () => {
          await api.setRequestedWorkers(requested);
          // Perkraunama, nes įsigaliojusi būsena gali skirtis nuo prašymo (aplinkos kintamasis turi
          // pirmenybę), o paskutinės bangos rezultatas ateina iš to paties dashboard atsakymo.
          void load();
          return fill(t("Worker request updated to {count}."), { count: requested });
        },
        failureMessage: t("Could not change the worker count"),
      });
    },
    [load, run, t],
  );

  /**
   * Loop'o paleidimas su AIŠKIU srautų skaičiumi (task 0052). Perkraunama dėl tos pačios priežasties
   * kaip `setRequestedWorkers`: prašymas nėra leidimas, o kiek srautų realiai dirba, pasako tik
   * kitas dashboard snapshot'as.
   */
  const startLoopWithWorkers = useCallback(
    async (workers: 1 | 2) => {
      await run(LOOP_START_ACTION, {
        perform: async () => {
          const result = await api.startLoopWithWorkers(workers);
          // `failed` ateina 200 atsakyme: tyliai jį palaikyti sėkme reikštų parašyti „paleista", kai
          // niekas nepaleista.
          if (result.status === "failed") throw new Error(result.reason ?? result.status);
          void load();
          return result.status === "already-running"
            ? t("The loop was already running.")
            : fill(t("Loop started with {count} stream(s)."), { count: workers });
        },
        failureMessage: t("Could not start the loop streams"),
      });
    },
    [load, run, t],
  );

  /**
   * Ciklo perkrovimas: sustabdyti → ĮSITIKINTI, kad sustojo → paleisti. Pati eiga gyvena grynoje
   * `model/restartLoop` funkcijoje, o čia tik įleidžiamos priklausomybės. `overrides` reikalingi
   * testams: be jų neigiamas kelias trunktų realias 15 sekundžių.
   *
   * Kiekvienas perkrovimas gauna SAVO `AbortController`, kurį išmontavimas nutraukia: perėjimas į
   * `#/analytics` ar kitą route'ą uždaro šį rodinį, o nutrauktas perkrovimas nebegali nei laukti,
   * nei paleisti ciklo.
   */
  const restartLoop = useCallback(
    async (workers: 1 | 2, overrides?: Partial<RestartLoopOptions>) => {
      await run(LOOP_RESTART_ACTION, {
        perform: async () => {
          const abort = new AbortController();
          restartAbort.current = abort;
          try {
            const outcome = await runRestartLoop(
              {
                stopLoop: api.stopLoop,
                readLoopStatus: async () => loopRunStateOf(await api.fetchDashboard()),
                startLoop: api.startLoopWithWorkers,
                wait: waitOrAbort,
                signal: abort.signal,
              },
              { ...overrides, workers },
            );
            if (!outcome.ok && outcome.cancelled) {
              // Rodinio nebėra, tad nei perkrauti duomenų, nei rodyti raudonos klaidos nėra kam:
              // `useOperatorActions` pranešimą išmontavus praleidžia, o sakinys lieka vienas ir tikras.
              throw new Error(t(outcome.messageKey));
            }
            void load();
            if (!outcome.ok) {
              // `runRestartLoop` niekada nemeta — gedimas grįžta su savo sakiniu, ir būtent jis
              // (o ne bendras „nepavyko") pasako, kuriame žingsnyje sustota.
              throw new Error(outcome.detail ? `${t(outcome.messageKey)} — ${outcome.detail}` : t(outcome.messageKey));
            }
            return outcome.alreadyRunning ? t("The loop was already running.") : t("Loop restarted.");
          } finally {
            // Tik SAVO valdiklį: naujesnis perkrovimas jau būtų perrašęs nuorodą.
            if (restartAbort.current === abort) restartAbort.current = null;
          }
        },
        failureMessage: t("Could not restart the loop"),
      });
    },
    [load, run, t],
  );

  /** Vienintelis srauto norimos būsenos rašymo kelias — stop/resume/abort skiriasi tik režimu. */
  const setSlotMode = useCallback(
    async (workerId: LoopWorkerId, mode: LoopSlotMode) => {
      await run(slotActionId(workerId, mode), {
        perform: async () => {
          await api.setSlotMode(workerId, mode);
          void load();
          const stream = streamIndexOf(workerId);
          if (mode === "drain") return fill(t("Stream {stream} will stop after the current attempt."), { stream });
          if (mode === "run") return fill(t("Stream {stream} resumed."), { stream });
          return fill(t("Stream {stream} is marked as aborting; the running attempt still finishes."), { stream });
        },
        failureMessage: t("Could not change the stream state"),
      });
    },
    [load, run, t],
  );

  /**
   * Užstrigusios užduoties grąžinimas į eilę tiesiai iš srauto kortelės. Tas pats serverio maršrutas
   * kaip `#/reviews` panelėje — UI čia nieko neapsprendžia: perėjimą `human-review -> queue` leidžia
   * arba atmeta serveris.
   */
  const fixSlotTask = useCallback(
    async (taskId: string) => {
      await run(fixActionId(taskId), {
        perform: async () => {
          await api.triageTask("requeue", taskId);
          void load();
          return fill(t("Task {task} was sent back to the queue."), { task: taskId });
        },
        failureMessage: t("Could not send the task back to the queue"),
      });
    },
    [load, run, t],
  );

  // Numatytasis srauto stabdymas yra `drain`: vykdomas bandymas užbaigiamas, naujas neskiriamas.
  const stopSlot = useCallback((workerId: LoopWorkerId) => setSlotMode(workerId, "drain"), [setSlotMode]);
  const resumeSlot = useCallback((workerId: LoopWorkerId) => setSlotMode(workerId, "run"), [setSlotMode]);
  const abortSlot = useCallback((workerId: LoopWorkerId) => setSlotMode(workerId, "abort"), [setSlotMode]);

  return {
    dashboard,
    error,
    // Abu pranešimai rodomi kartu: anksčiau `notice` (pvz. nepavykęs įkėlimas) niekada pats
    // nedingdavo ir nuo tos akimirkos užstodavo VISUS „Nepavyko atnaujinti duomenų" pranešimus,
    // tad vartotojas žiūrėdavo į užšalusius duomenis manydamas, kad viskas gerai.
    notice,
    refreshError,
    loadedAt,
    resumeLabel,
    stopLabel,
    agentActivity,
    agentSlotActivities,
    agentActivityStatus,
    agentActivityError,
    // Vienintelis atsakymas į klausimą „ar ciklas veikia": `loopControl` failas, o jo nesant —
    // vykdymo procesų sąrašas. Iš jo gimsta ir mygtukų matrica, ir perkrovimo patikra.
    loopRunState: data === null ? ("unknown" as const) : loopRunStateOf(data),
    pendingActions,
    toasts,
    dismissToast,
    // TAS PATS šaltinis kaip `#/system` valdikliams (`loopRunStateOf`), o ne antras skaitymas iš
    // `runtime` sąrašo: du šaltiniai tam pačiam klausimui anksčiau ar vėliau duoda du atsakymus,
    // ir Header'is su `#/system` imtų siūlyti skirtingus veiksmus tai pačiai būsenai.
    loopControls: buildLoopControls(data === null ? "unknown" : loopRunStateOf(data), resumeLabel, stopLabel),
    actions: {
      reload: load,
      resumeLoop,
      stopLoop,
      restartLoop,
      uploadTaskFiles,
      openFolder,
      proposePolicy,
      setRequestedWorkers,
      startLoopWithWorkers,
      stopSlot,
      resumeSlot,
      abortSlot,
      fixSlotTask,
      loadWorkflowTasks,
      approveLearning,
      rejectLearning,
    },
  };
}
