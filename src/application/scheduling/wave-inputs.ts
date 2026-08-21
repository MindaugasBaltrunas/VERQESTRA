// Bangos ĮVESTYS: kiek worker'ių prašoma ir kiek jų realiai gali dirbti (etalonas: AG_loop
// orchestrator/loop/loop-wave-inputs.ts + loop-wave-worker-request.ts).
//
// Du skirtingi skaičiai, kuriuos lengva supainioti:
//   - PRAŠOMA (`requested`) — operatoriaus norimas paralelizmas iš `worker-request` būsenos;
//   - VYKDOMA (`effective`) — kiek slot'ų realiai leidžia valdikliai.
// Efektyvus skaičius yra PREFIKSAS, ne kiekis: `w1=drain, w2=run` duoda 0, o ne 1. Kitaip
// loop'as pradėtų darbą antrame slot'e tuo metu, kai operatorius sustabdė pirmą — ir „drain"
// reikštų „gal".

import { clampWorkerCount } from "./worker-pool-plan.js";
import { LOOP_SLOT_KEYS, type LoopControlState } from "./loop-control-store.js";

/**
 * Kiek pirmųjų slot'ų yra `run` būsenoje, skaičiuojant IŠ EILĖS nuo pirmo.
 *
 * Skaičiuojamas prefiksas, o ne suma: pertrauka viduryje nutraukia skaičiavimą. Slot'ai nėra
 * lygiaverčiai — antras be pirmo neturi prasmės, nes pirminis slot'as yra tas, kuris dirba
 * pagrindiniame medyje.
 */
export function runnableSlotPrefix(control: LoopControlState): number {
  let runnable = 0;
  for (const key of LOOP_SLOT_KEYS) {
    if (control.slots[key]?.mode !== "run") break;
    runnable += 1;
  }
  return runnable;
}

export type WorkerRequestResolution = {
  requested: number;
  effective: number;
  /** Žurnalo eilutė; `undefined`, kai ji nepasikeitė nuo praeito karto. */
  line: string | undefined;
};

export type ResolveWorkerRequestInput = {
  requested: number | undefined;
  control: LoopControlState;
  /** Netinkama `worker-request` reikšmė, jei tokia buvo — patenka į žurnalo eilutę. */
  invalidRequest?: string | undefined;
  /** Paskutinė įrašyta eilutė; ta pati eilutė antrą kartą nerašoma. */
  lastLogged?: string | undefined;
};

/**
 * Suveda operatoriaus užklausą ir slot'ų valdiklius į VIENĄ efektyvų skaičių.
 *
 * `Math.max(1, runnable)`: net kai visi slot'ai sustabdyti, efektyvus skaičius nenukrenta žemiau
 * vieno. Nulis reikštų „banga be slot'ų", ir planuotojas tokį atvejį matytų kaip tuščią eilę, o
 * ne kaip sustabdytą darbą — sustabdymo semantiką turi vykdyti dispatch'o vartai, ne planavimas.
 *
 * Eilutė grąžinama, o ne rašoma: kartojimosi filtras (`lastLogged`) taip lieka gryna taisykle,
 * o ne paslėpta būsena žurnalo rašytojuje.
 */
export function resolveWorkerRequest(input: ResolveWorkerRequestInput): WorkerRequestResolution {
  const requested = clampWorkerCount(input.requested);
  const runnable = runnableSlotPrefix(input.control);
  const effective = clampWorkerCount(Math.min(requested, Math.max(1, runnable)));

  const held = LOOP_SLOT_KEYS.filter((key) => input.control.slots[key]?.mode !== "run")
    .map((key) => `${key}:${input.control.slots[key]?.mode}`)
    .join(",");

  const line =
    `WORKER REQUEST: requested=${requested}` +
    (held === "" ? "" : ` control=${held}`) +
    (effective === requested ? "" : ` effective=${effective}`) +
    (input.invalidRequest === undefined ? "" : ` invalid=${input.invalidRequest}`) +
    (input.control.invalid === undefined ? "" : ` control_invalid=${input.control.invalid}`);

  return { requested, effective, line: line === input.lastLogged ? undefined : line };
}
