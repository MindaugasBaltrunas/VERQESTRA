import type { WorkerControlView } from "./dashboardViewModel";
import type { DashboardData, LoopSlotMode, LoopWorkerId, UiHumanReviewTask } from "./types";

/**
 * Ciklo proceso būsena taip, kaip ją mato operatorius. `unknown` yra pilnavertė trečioji būsena, o
 * ne „tikriausiai sustojęs": būtent jos supainiojimas su „sustojęs" 2026-08-06 leido UI siūlyti
 * paleisti ANTRĄ orkestratorių tame pačiame repo.
 */
export type LoopRunState = "running" | "stopped" | "unknown";

/**
 * Veiksmų identifikatoriai. Vienas ketinimas = VIENAS id, nesvarbu, iš kurio ekrano taško jis
 * paleistas: „Automatika laukia" kortelė ir ciklo valdymo juosta dalijasi tuo pačiu `loop-start`,
 * todėl vykdomas paleidimas antrą kartą nepasileidžia nė iš vienos vietos.
 */
export const LOOP_START_ACTION = "loop-start";
export const LOOP_STOP_ACTION = "loop-stop";
export const LOOP_RESTART_ACTION = "loop-restart";

export const workersActionId = (requested: number): string => `workers-${requested}`;
export const slotActionId = (workerId: LoopWorkerId, mode: LoopSlotMode): string => `slot-${workerId}-${mode}`;
export const fixActionId = (taskId: string): string => `fix-${taskId}`;

export type LoopButtonView = {
  id: string;
  enabled: boolean;
  /** Vykdomas BŪTENT šis veiksmas — mygtukas rodo suktuką ir lieka su tuo pačiu pavadinimu. */
  busy: boolean;
};

export type LoopControlsView = {
  start: LoopButtonView;
  stop: LoopButtonView;
  restart: LoopButtonView;
};

/**
 * Ciklo mygtukų būsena. Taisyklė ta pati kaip senojo `buildLoopControls` (Header'is), tik apibendrinta
 * trims mygtukams ir bendram „vyksta veiksmas" žymėjimui:
 *
 *   - `running`  → stabdyti ir perkrauti galima, paleisti nėra ko;
 *   - `stopped`  → galima tik paleisti (perkrovimas savyje turi paleidimą, tad jis irgi uždarytas);
 *   - `unknown`  → paleidimas UŽDARYTAS (antras orkestratorius yra reali žala), o stabdymas lieka:
 *                  stop vėliava nekenksminga ir veikia net terminale paleistam ciklui.
 *
 * Bet kuris iš trijų vykdomų veiksmų išjungia visus tris: kol nežinome, kuo baigėsi stabdymas,
 * paleidimo mygtukas būtų pasiūlymas spėlioti.
 */
/**
 * Ar būsena LEIDŽIA veiksmą. VIENINTELĖ šios taisyklės vieta.
 *
 * Iki 2026-08-24 audito ji buvo persakyta DVIEJOSE vietose: čia (`#/system` valdikliai) ir
 * `useDashboardController#buildLoopControls` (Header'io mygtukai). Kopijos jau buvo prasilenkusios —
 * Header'is nežinomą būseną, atėjusią kaip `undefined`, laikė „sustojusiu" ir LEIDO paleisti, nors
 * ta pati failo antraštė sako priešingai: nežinomybėje paleidimas uždaromas, nes antras
 * orkestratorius tame pačiame repo yra reali žala. Dvi to paties saugos sprendimo kopijos anksčiau
 * ar vėliau ima atsakinėti skirtingai — ir viena jų atsakinės neteisingai.
 */
export function loopActionAllowed(status: LoopRunState): { start: boolean; stop: boolean; restart: boolean } {
  return {
    start: status === "stopped",
    // Stabdymas leidžiamas ir `unknown` atveju: vėliavos įrašymas nekenksmingas ir veikia net
    // terminale paleistam ciklui.
    stop: status !== "stopped",
    restart: status === "running",
  };
}

export function buildLoopControlsView(input: {
  status: LoopRunState;
  handlers: { start: boolean; stop: boolean; restart: boolean };
  pending: ReadonlySet<string>;
}): LoopControlsView {
  const anyPending =
    input.pending.has(LOOP_START_ACTION) ||
    input.pending.has(LOOP_STOP_ACTION) ||
    input.pending.has(LOOP_RESTART_ACTION);

  const button = (id: string, allowedByStatus: boolean, hasHandler: boolean): LoopButtonView => ({
    id,
    enabled: allowedByStatus && hasHandler && !anyPending,
    busy: input.pending.has(id),
  });

  const allowed = loopActionAllowed(input.status);
  return {
    start: button(LOOP_START_ACTION, allowed.start, input.handlers.start),
    stop: button(LOOP_STOP_ACTION, allowed.stop, input.handlers.stop),
    restart: button(LOOP_RESTART_ACTION, allowed.restart, input.handlers.restart),
  };
}

/**
 * Kuo tikėti klausiant „ar ciklas veikia". Pirmenybė — `loopControl`, nes tai valdymo failo tiesa;
 * jei serveris šio bloko nesiunčia (senas `dist`), lieka vykdymo procesų sąrašas. Nė vieno šaltinio
 * nebuvimas NĖRA „sustojęs": tai `unknown`, ir jis uždaro paleidimą.
 */
export function loopRunStateOf(data: DashboardData): LoopRunState {
  return (
    data.loopControl?.loop.status ??
    data.runtime.find((process) => process.name === "AG loop")?.status ??
    "unknown"
  );
}

/** Kiek srautų siūlo paleisti mygtukas: tiek, kiek jų PRAŠOMA. Nežinomybė reiškia vieną srautą. */
export function startStreamCount(workerControl?: WorkerControlView): 1 | 2 {
  return workerControl?.requested === 2 ? 2 : 1;
}

/** Srauto numeris ekrane. `w1`/`w2` yra vidiniai vardai; operatorius mato 1 ir 2. */
export function streamIndexOf(workerId: LoopWorkerId): 1 | 2 {
  return workerId === "w2" ? 2 : 1;
}

/**
 * Užduotys, kurias serveris realiai leidžia grąžinti į eilę. Triažo maršrutas priima TIK
 * `human-review -> queue`, tad kortelėje rodyti „Taisyk" bet kuriai užduočiai reikštų žadėti
 * veiksmą, kurio vienintelė galima baigtis — 409.
 */
export function fixableTaskIds(tasks: readonly UiHumanReviewTask[]): Set<string> {
  return new Set(tasks.map((task) => task.task_id));
}
