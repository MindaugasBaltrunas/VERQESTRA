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
  startStreamCount,
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

/**
 * Header'io „Paleisti" veiksmo id (task 048). Sąmoningai ATSKIRAS nuo `LOOP_START_ACTION`: abu
 * mygtukai (Header ir ciklo valdymo juosta) turi savo `pendingActions` užraktą, kitaip dvigubas
 * paspaudimas ant Header'io mygtuko vis tiek išsiųstų dvi užklausas.
 *
 * 2026-08-27 auditas (task 049): iki šiol šis veiksmas siųsdavo `/tasks/resume`, o ciklo valdymo
 * juostos „Paleisti ciklą (N srautų)" — `/api/runtime/loop/start`, kuris PAPILDOMAI atstato srautų
 * valdiklį pagal siunčiamą `workers` skaičių. Du vizualiai skirtingi, bet abu „Paleisti" mygtukai
 * elgėsi skirtingai be jokio ženklo. Dabar Header'is siunčia TĄ PATĮ `/api/runtime/loop/start` su
 * ESAMU pasirinktu srautų skaičiumi (`startStreamCount`) — abu keliai daro identišką veiksmą, tad
 * skirtumo, kurio niekas nematė, nebelieka. `/tasks/resume` lieka `api.ts` (kitiems vartotojams),
 * bet Header jo daugiau nekviečia.
 */
export const LOOP_RESUME_ACTION = "loop-resume";
/** Rankinio „Atnaujinti"/„Tikrinti dar kartą" veiksmo id — leidžia mygtukams rodyti `aria-busy`. */
export const DASHBOARD_RELOAD_ACTION = "dashboard-reload";

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Ciklo veiksmo etiketė kaip RAKTAS + PARAMETRAI, o ne baigtas tekstas (2026-08-27 auditas,
 * task 049). Anksčiau pid'as ir klaidos tekstas buvo įrašomi TIESIAI į galutinę stygą PRIEŠ
 * `t()`, tad žodyno paieška niekada nerasdavo atitikmens ir net numatytoji LT sąsaja likdavo su
 * angliškais žodžiais („Starting...", „Error: ..."). `fill()` įstato reikšmes į JAU IŠVERSTĄ
 * šabloną, tad raktas lieka pastovus, o kintantis skaičius ar serverio tekstas juda per parametrą.
 */
type LoopLabelState = { key: string; params?: Record<string, string | number> };

function formatLoopLabel(t: (text: string) => string, state: LoopLabelState): string {
  return state.params ? fill(t(state.key), state.params) : t(state.key);
}

const IDLE_RESUME_LABEL: LoopLabelState = { key: "▶ Start loop" };
const IDLE_STOP_LABEL: LoopLabelState = { key: "⏹ Stop loop" };

/** Sėkmingo paleidimo etiketė; `pid` praleidžiamas, kai serveris jo negrąžina. */
function resumeResultLabel(status: "already-running" | "started", pid?: number): LoopLabelState {
  if (status === "already-running") return { key: "▶ Already running" };
  return pid === undefined ? { key: "▶ Started" } : { key: "▶ Started (pid {pid})", params: { pid } };
}

/** Sėkmingo stabdymo etiketė; „no-known-process" grįžta tiesiai į IDLE (etalono elgesys). */
function stopResultLabel(status: "stop-requested" | "stop-requested-no-known-process", pid?: number): LoopLabelState {
  if (status !== "stop-requested") return IDLE_STOP_LABEL;
  return pid === undefined ? { key: "⏹ Stopping" } : { key: "⏹ Stopping (pid {pid})", params: { pid } };
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
 *
 * 2026-08-27 auditas (task 048): funkcija toliau lygina TEKSTĄ (signatūra ir esami testai
 * nepakeisti), bet iškvietimo vietoje `resumeLabel`/`stopLabel` nebeperduodamas TIKRAS mygtuko
 * tekstas — jis turi savo atsileidimo laikmatį ir po klaidos likdavo neatitikęs kelias sekundes
 * ilgiau, nei veiksmas realiai vyko, tad mygtukas užsirakindavo be priežasties. Dabar įėjimas
 * kilęs iš `pendingActions`, vienintelio šaltinio, žinančio, ar veiksmas TIKRAI dar vyksta.
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
function scheduleLabelReset<T>(
  timer: { current: ReturnType<typeof setTimeout> | null },
  setLabel: (label: T) => void,
  label: T,
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
  const [resumeLabelState, setResumeLabelState] = useState<LoopLabelState>(IDLE_RESUME_LABEL);
  const [stopLabelState, setStopLabelState] = useState<LoopLabelState>(IDLE_STOP_LABEL);
  // Rodomas tekstas perskaičiuojamas KIEKVIENĄ kalbos perjungimą (ne tik veiksmo metu): busena
  // gyvena kaip raktas + parametrai, o `t()` čia yra vienintelė vieta, kur ji virsta styga.
  const resumeLabel = useMemo(() => formatLoopLabel(t, resumeLabelState), [resumeLabelState, t]);
  const stopLabel = useMemo(() => formatLoopLabel(t, stopLabelState), [stopLabelState, t]);
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

  /**
   * Grąžina rezultatą (ne tik pakeičia būseną), kad `reload` (žemiau) galėtų atskirti pavykusį
   * atnaujinimą nuo nepavykusio ir per `run()` pranešti apie tai toast'u. Fonui skirtas apklausos
   * ciklas ir kitų veiksmų `void load()` iškvietimai rezultatą ignoruoja — jiems pakanka to, ką
   * `load` jau daro pati: `error`/`refreshError` būsenos.
   */
  const load = useCallback(async (): Promise<{ ok: true } | { ok: false; message: string }> => {
    const requestId = ++requestSequence.current;
    try {
      const dashboard = await api.fetchDashboard();
      if (requestId !== requestSequence.current) return { ok: true };
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
        return { ok: true };
      }
      lastSnapshot.current = serialized;
      setData(dashboard);
      hasDashboardData.current = true;
      setError(null);
      setRefreshError(null);
      return { ok: true };
    } catch (loadError) {
      if (requestId !== requestSequence.current) return { ok: true };
      const message = toErrorMessage(loadError);
      if (hasDashboardData.current) {
        setRefreshError(`${t("Could not refresh the data")}: ${message}`);
        return { ok: false, message };
      }
      setError(message);
      return { ok: false, message };
    }
  }, [t]);

  /**
   * Vienintelis rankinio atnaujinimo kelias (task 048): tas pats `run()` užraktas ir toast'as kaip
   * kitiems mutuojantiems veiksmams, tad „Atnaujinti būseną"/„Tikrinti dar kartą" mygtukai gauna
   * `aria-busy`/`disabled` iš `pendingActions`, o nesėkmė nebelieka matoma TIK viršutinėje
   * `refreshError` juostoje. Fonui skirtas apklausos ciklas ir toliau naudoja `load` tiesiogiai —
   * kitaip serveriui laikinai nepasiekus kas 30 s spėtų toast'ą, kurio niekas neprašė.
   */
  const reload = useCallback(async () => {
    await run(DASHBOARD_RELOAD_ACTION, {
      perform: async () => {
        const result = await load();
        if (!result.ok) throw new Error(result.message);
        return t("Status refreshed.");
      },
      failureMessage: t("Could not refresh the status"),
    });
  }, [load, run, t]);

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

  /**
   * Header'io ciklo paleidimas (task 048, endpoint suvienodintas 049). Anksčiau šis kelias
   * apeidavo `run()`: nebuvo `pendingActions` užrakto (du greiti paspaudimai siųsdavo dvi
   * `/tasks/resume` užklausas) ir jokio toast'o — rezultatas matydavosi TIK trumpam pasikeitusiame
   * mygtuko tekste. Dabar veiksmas dalijasi ta pačia disciplina kaip `stopLoop`/`startLoopWithWorkers`
   * IR tuo pačiu `/api/runtime/loop/start` maršrutu su esamu pasirinktu srautų skaičiumi — žr.
   * `LOOP_RESUME_ACTION` komentarą.
   */
  const resumeLoop = useCallback(async () => {
    await run(LOOP_RESUME_ACTION, {
      perform: async () => {
        setResumeLabelState({ key: "▶ Starting..." });
        try {
          const workers = startStreamCount(dashboard?.workerControl);
          const result = await api.startLoopWithWorkers(workers);
          // `failed` ateina 200 atsakyme: tyliai jį palaikyti sėkme reikštų parašyti „paleista",
          // kai niekas nepaleista (ta pati taisyklė kaip `startLoopWithWorkers` veiksme žemiau).
          if (result.status === "failed") throw new Error(result.reason ?? result.status);
          setResumeLabelState(resumeResultLabel(result.status, result.pid));
          void load();
          scheduleLabelReset(resumeResetTimer, setResumeLabelState, IDLE_RESUME_LABEL, 4000);
          return result.status === "already-running"
            ? t("The loop was already running.")
            : fill(t("Loop started (pid {pid})."), { pid: result.pid ?? "—" });
        } catch (resumeError) {
          setResumeLabelState({ key: "▶ Error: {message}", params: { message: toErrorMessage(resumeError) } });
          scheduleLabelReset(resumeResetTimer, setResumeLabelState, IDLE_RESUME_LABEL, 6000);
          throw resumeError;
        }
      },
      failureMessage: t("Could not start the loop"),
    });
  }, [dashboard, load, run, t]);

  /**
   * Ciklo stabdymas. Header'is toliau gyvena iš `stopLabel`, o rezultato sakinys nuo šiol keliauja į
   * pranešimų krūvelę — taip tas pats veiksmas iš Header'io ir iš ciklo valdymo juostos dalijasi
   * viena „vykdoma" būsena ir nebegali būti paleistas dukart.
   */
  const stopLoop = useCallback(async () => {
    await run(LOOP_STOP_ACTION, {
      perform: async () => {
        setStopLabelState({ key: "⏹ Stopping..." });
        try {
          const result = await api.stopLoop();
          if (result.status === "failed") throw new Error(result.reason ?? result.status);
          // Serveris nebemeluoja: `…-no-known-process` reiškia, kad vėliava įrašyta, bet gyvo, šiam
          // UI žinomo proceso nėra.
          setStopLabelState(stopResultLabel(result.status, result.pid));
          scheduleLabelReset(stopResetTimer, setStopLabelState, IDLE_STOP_LABEL, 6000);
          void load();
          return result.status === "stop-requested"
            ? fill(t("Stop requested; the loop will stop after the current task (pid {pid})."), {
                pid: result.pid ?? "—",
              })
            : t("Stop was recorded, but no running loop process is known to this UI.");
        } catch (stopError) {
          setStopLabelState({ key: "⏹ Error: {message}", params: { message: toErrorMessage(stopError) } });
          scheduleLabelReset(stopResetTimer, setStopLabelState, IDLE_STOP_LABEL, 6000);
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
        const message = `${t("Could not upload the task")}: ${toErrorMessage(uploadError)}`;
        setNotice(message);
        throw new Error(message, { cause: uploadError });
      }
    },
    [load, t],
  );

  const approveLearning = useCallback(
    async (id: string) => {
      try {
        await api.approveLearningRecommendation(id);
        setNotice(null);
        void load();
      } catch (decisionError) {
        setNotice(`${t("Could not approve the recommendation")}: ${toErrorMessage(decisionError)}`);
      }
    },
    [load, t],
  );

  const rejectLearning = useCallback(
    async (id: string) => {
      try {
        await api.rejectLearningRecommendation(id);
        setNotice(null);
        void load();
      } catch (decisionError) {
        setNotice(`${t("Could not reject the recommendation")}: ${toErrorMessage(decisionError)}`);
      }
    },
    [load, t],
  );

  const openFolder = useCallback(async (bucket: string) => {
    try {
      await api.openFolder(bucket);
      setNotice(null);
    } catch (openError) {
      setNotice(`${t("Could not open the folder")}: ${toErrorMessage(openError)}`);
    }
  }, [t]);

  const loadWorkflowTasks = useCallback(async (bucket: string): Promise<string[]> => {
    const result = await api.fetchWorkflowTasks(bucket);
    return result.tasks;
  }, []);

  const proposePolicy = useCallback(
    async (route: string, settingId: string, requestedValue: unknown) => {
      try {
        await api.proposePolicy(route, { setting_id: settingId, requested_value: requestedValue });
        setNotice(null);
        void load();
      } catch (proposeError) {
        setNotice(`${t("Could not submit the proposal")}: ${toErrorMessage(proposeError)}`);
      }
    },
    [load, t],
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
    /**
     * Patikrintas atsakymas BE adaptavimo — diagnostikos paviršiui.
     *
     * `dashboard` yra vaizdo modelis: jis interpretuoja. Diagnostika priešingai — ji rodo ĮRODYMĄ
     * pažodžiui (būsenos failų antspaudus, resume taškus, log kilmę), ir adapteris čia tik
     * kopijuotų laukus, pridėdamas sluoksnį, kuriame galima suklysti. Pavadinta `raw`, kad niekas
     * jo nesupainiotų su vaizdo modeliu.
     */
    raw: data,
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
    //
    // `resumeLabel`/`stopLabel` čia NEPERDUODAMI tiesiogiai (task 048): jie yra mygtuko RODOMAS
    // tekstas su savo pačių atsileidimo laikmačiu (klaida rodo tekstą kelias sekundes ilgiau, nei
    // veiksmas realiai vyksta), tad lyginant juos pažodžiui mygtukas liktų užrakintas ir PO to, kai
    // veiksmas jau baigėsi. `buildLoopControls` toliau lygina TEKSTĄ (jos signatūra ir testai
    // nekeičiami), bet įėjimas dabar kilęs iš TIKRO `pendingActions` — vienintelio šaltinio, kuris
    // žino, ar veiksmas dar vyksta.
    loopControls: buildLoopControls(
      data === null ? "unknown" : loopRunStateOf(data),
      pendingActions.has(LOOP_RESUME_ACTION) ? "" : "▶ Start loop",
      pendingActions.has(LOOP_STOP_ACTION) ? "" : "⏹ Stop loop",
    ),
    actions: {
      reload,
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
