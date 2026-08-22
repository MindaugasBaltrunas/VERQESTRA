import type { LoopRunState } from "./loopControlsViewModel";
import type { LoopResult, LoopStopResult } from "./types";

/**
 * Perkrovimo fazė. Rodoma ne dėl grožio: „stabdoma" ir „laukiama, kol sustos" yra du skirtingi
 * laukimai, ir tik antrasis paaiškina, kodėl niekas nevyksta 15 sekundžių.
 */
export type RestartPhase = "idle" | "stopping" | "waiting" | "starting" | "done" | "error";

/**
 * Priklausomybės įleidžiamos iš išorės (kontroleris paduoda `model/api` funkcijas), tad pati eiga
 * lieka gryna: be React, be savo laikrodžio ir be tinklo. Testas paduoda `wait = async () => {}` ir
 * patikrina VISAS šakas be nė vienos realios sekundės.
 */
export type RestartLoopDeps = {
  stopLoop: () => Promise<LoopStopResult>;
  readLoopStatus: () => Promise<LoopRunState>;
  startLoop: (workers: 1 | 2) => Promise<LoopResult>;
  /**
   * Laukimas gauna `signal`, kad atšaukimas nutrauktų JĮ PATĮ: be to perkrovimas dar iki 15 sekundžių
   * laikytų gyvą laikmatį rodiniui, kurio nebėra.
   */
  wait: (ms: number, signal?: AbortSignal) => Promise<void>;
  /**
   * Atšaukimas. Rodinys išmontuojamas paprasčiausiai perėjus į kitą skirtuką (`#/analytics` ir kt.),
   * o perkrovimo eiga tada privalo sustoti PRIEŠ paleidimą: kitaip uždarytas ekranas paleistų ciklą
   * ir nė vienas pranešimas apie tai nebepasiektų operatoriaus.
   */
  signal?: AbortSignal;
  onPhase?: (phase: RestartPhase) => void;
};

export type RestartLoopOptions = {
  workers: 1 | 2;
  pollAttempts?: number;
  pollIntervalMs?: number;
};

export type RestartLoopOutcome =
  | { ok: true; polls: number; startedPid?: number; alreadyRunning: boolean }
  | {
      ok: false;
      phase: "stopping" | "waiting" | "starting";
      messageKey: string;
      detail?: string;
      /**
       * Atšaukimas NĖRA gedimas: niekas nesugedo, tik nebėra kam rodyti rezultato. Kviečiantis
       * kontroleris pagal šią vėliavą atskiria „nepavyko" nuo „nebeaktualu".
       */
      cancelled?: true;
    };

/** Atšaukimo sakinys gyvena čia, kad kontroleris ir testai vartotų TĄ PATĮ raktą, o ne jo kopiją. */
export const RESTART_CANCELLED_MESSAGE_KEY =
  "Restart cancelled: the view was closed before the loop was restarted.";

const DEFAULT_POLL_ATTEMPTS = 10;
const DEFAULT_POLL_INTERVAL_MS = 1_500;

function toMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Perkrovimas = sustabdyti → ĮSITIKINTI, kad sustojo → paleisti. Vidurinis žingsnis yra visa esmė:
 * be jo perkrovimas būtų „paleisk dar vieną orkestratorių tame pačiame repo" su patogesniu vardu.
 *
 * Funkcija NIEKADA nemeta — kiekvienas gedimas grįžta kaip `ok: false` su savo sakiniu, nes
 * kviečiantis mygtukas turi parodyti, KURIAME žingsnyje sustota, o ne bendrą „nepavyko".
 *
 * Riba yra baigtinė: `pollAttempts × pollIntervalMs` (numatytai 10 × 1500 ms = 15 s). Jos nesulaukus
 * paleidimas NEVYKDOMAS.
 *
 * Atšaukimas tikrinamas po kiekvieno laukimo ir dar kartą PRIEŠ paleidimą: nuo šios ribos priklauso,
 * ar uždarytas rodinys gali paleisti ciklą (negali).
 */
export async function runRestartLoop(
  deps: RestartLoopDeps,
  options: RestartLoopOptions,
): Promise<RestartLoopOutcome> {
  const pollAttempts = options.pollAttempts ?? DEFAULT_POLL_ATTEMPTS;
  const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;

  const fail = (
    phase: "stopping" | "waiting" | "starting",
    messageKey: string,
    detail?: string,
  ): RestartLoopOutcome => {
    deps.onPhase?.("error");
    return detail ? { ok: false, phase, messageKey, detail } : { ok: false, phase, messageKey };
  };

  // Atšaukimas nekelia `error` fazės: nieko nesugedo, tad ir raudonos būsenos nėra ko rodyti.
  const cancelled = (): RestartLoopOutcome => ({
    ok: false,
    phase: "waiting",
    messageKey: RESTART_CANCELLED_MESSAGE_KEY,
    cancelled: true,
  });

  // 1. Stabdymas.
  deps.onPhase?.("stopping");
  let stopResult: LoopStopResult;
  try {
    stopResult = await deps.stopLoop();
  } catch (stopError) {
    return fail("stopping", "Restart failed: the loop did not accept the stop request.", toMessage(stopError));
  }
  if (stopResult.status === "failed") {
    return fail(
      "stopping",
      "Restart failed: the loop did not accept the stop request.",
      stopResult.reason ?? "failed",
    );
  }
  // `stop-requested-no-known-process` NĖRA trumpesnis kelias: „šis UI nežino gyvo proceso" nėra
  // įrodymas, kad ciklas sustojo (jis gali suktis terminale). Todėl laukiama vienodai abiem atvejais.

  // 2. Laukimas, kol būsena PATVIRTINA sustojimą.
  deps.onPhase?.("waiting");
  let polls = 0;
  let stopped = false;
  let lastStatus: LoopRunState = "unknown";
  let lastError: string | undefined;

  for (let attempt = 1; attempt <= pollAttempts; attempt += 1) {
    // Laukiama PRIEŠ pirmą skaitymą: stop vėliava įsigalioja tarp užduočių, tad tuoj pat perskaityta
    // būsena vis dar rodytų `running` ir mes ją palaikytume atsakymu.
    await deps.wait(pollIntervalMs, deps.signal);
    // Atšaukta laukimo metu: tolesnis skaitymas būtų užklausa niekam.
    if (deps.signal?.aborted) return cancelled();
    try {
      lastStatus = await deps.readLoopStatus();
      lastError = undefined;
    } catch (readError) {
      // Vienas nepavykęs skaitymas nėra verdiktas — tinklo trūktelėjimas ne tas pats, kas veikiantis
      // ciklas. Priežastis įsimenama, kad ji pasiektų ekraną, jei nepavyktų nė vienas bandymas.
      lastStatus = "unknown";
      lastError = toMessage(readError);
      continue;
    }
    if (lastStatus === "stopped") {
      polls = attempt;
      stopped = true;
      break;
    }
  }

  if (!stopped) {
    return fail(
      "waiting",
      lastStatus === "running"
        ? "Restart cancelled: the loop is still running after the stop request, so it was not restarted."
        : "Restart cancelled: the loop state could not be confirmed, so it was not restarted.",
      lastError,
    );
  }

  // 3. Paleidimas. Paskutinis atšaukimo patikrinimas yra ČIA, prieš vienintelį negrįžtamą žingsnį:
  // patvirtintas sustojimas nėra leidimas paleisti ciklą ekranui, kurio nebėra.
  if (deps.signal?.aborted) return cancelled();
  deps.onPhase?.("starting");
  let startResult: LoopResult;
  try {
    startResult = await deps.startLoop(options.workers);
  } catch (startError) {
    return fail("starting", "Restart failed: the loop stopped but did not start again.", toMessage(startError));
  }
  if (startResult.status === "failed") {
    return fail(
      "starting",
      "Restart failed: the loop stopped but did not start again.",
      startResult.reason ?? "failed",
    );
  }
  if (startResult.status === "already-running") {
    // Kažkas paleido ciklą tarp mūsų patikros ir paleidimo. Tai NĖRA klaida, bet ir nutylėti negalima:
    // vartotojas turi žinoti, kad veikia ne jo paleistas procesas.
    deps.onPhase?.("done");
    return { ok: true, polls, alreadyRunning: true };
  }

  deps.onPhase?.("done");
  return startResult.pid === undefined
    ? { ok: true, polls, alreadyRunning: false }
    : { ok: true, polls, startedPid: startResult.pid, alreadyRunning: false };
}
