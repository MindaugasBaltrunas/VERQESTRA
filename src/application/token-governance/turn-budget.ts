// Turn limitai pagal užduoties dydį ir fazę (TOK-3, task 1104/0941/0033) + dispatch
// wall-clock stabdiklis kaip TO PATIES turn biudžeto šešėlis. Behaviour etalon: AG_loop
// policy/token-budget-optimizer.ts (turn/timeout pusė; WBR VQ-302 skaidymas — etalonas
// 837 eil. viršija 500 ribą). Pure: no IO, no clock.

import type { TokenBudgetTier } from "./tiers.js";

/**
 * Fazė, kuriai skiriamas turn biudžetas.
 *
 * - `implementation` — dispatch sesija; limitas priklauso nuo tier'o.
 * - `repair` — retry-bounded repair dispatch; scope siauresnis nei originalo, tad ir
 *   langas mažesnis nepriklausomai nuo originalaus task'o dydžio.
 * - `semantic-review` — supervisor LLM samprotavimas be produkcinių pakeitimų: sprendimui
 *   pakanka prompt'e pateikto konteksto, todėl langas trumpiausias.
 */
export type TurnBudgetPhase = "implementation" | "repair" | "semantic-review";

export type TurnLimits = {
  small: number;
  medium: number;
  large: number;
  repair: number;
  semanticReview: number;
};

// Istorinių kalibravimų santrauka (pilna įrodymų grandinė — etalono komentaruose):
// 2026-08-06: medium 45 -> 60 (45 langas kirsdavo darbą įpusėjus; nukirsta sesija
// kainuoja brangiau nei sutaupyti turn'ai). 2026-08-07: large 80 -> 120 (opus grandinės
// kirstos paskutiniuose turn'uose, į master pateko sugadintas kodas). 2026-08-08 (0033,
// HUMAN-REVIEW-APPROVED): large 120 -> 180 (~49 % atsarga virš stebėto 121 turn'o).
// 2026-09-03 (modelių auditas, `token-usage.jsonl`, 306 dispatch'ų): medium 60 -> 90 ir
// repair 30 -> 45. Įrodymas — nesėkmes gamino lubos, ne darbas: 15 dispatch'ų baigė
// TIKSLIAI 61 turn'u ir 13 iš jų failed, o visos 4 repair nesėkmės sustojo ties savo
// lubomis (31, 31, 31, 61). Mediana 30, p75 47 — 90/45 lieka žemiau p95, bet virš tos
// p92 uodegos, kurioje sesija dar dirba. `large: 180` per 13 dienų nepasiektas nė karto,
// tad jis (kaip ir `small`/`semanticReview`) nekinta.
// KONFIGO SLUOKSNIS (0033-03): ši lentelė ir žemiau esantys PER_TURN/OVERHEAD yra
// FAIL-SAFE BAZĖ; kanoninis override — token-budget konfigas (VQ-305), importo kryptis
// viena: config -> optimizer.
export const DEFAULT_TURN_LIMITS: TurnLimits = {
  small: 20,
  medium: 90,
  large: 180,
  repair: 45,
  semanticReview: 12,
};

// 2026-08-08 (0033-02 perkalibravimas): regresija per 12 dispatch'ų su tikru `num_turns`
// davė wall = 19,2 s/turn * turns + 170 s (R²=0,54); 20 000 ms/turn yra tas RIBINIS
// nuolydis (+4,2 % marža), o visa nuo turn'ų nepriklausoma dalis gyvena OVERHEAD naryje.
export const PER_TURN_WALLCLOCK_ALLOWANCE_MS = 20_000;

/**
 * Efektyvus `--max-turns` limitas. `ceiling` yra operatoriaus bendra lubų reikšmė:
 * `undefined` — lubų nėra; `<= 0` — aiškus opt-out („0 = be ribos"), grąžinama 0;
 * teigiamas — `min(lentelė, ceiling)`. Grąžinta 0 reiškia „be flag'o".
 */
export function resolveMaxTurns(input: {
  phase: TurnBudgetPhase;
  tier: TokenBudgetTier;
  limits?: TurnLimits;
  ceiling?: number;
}): number {
  const limits = input.limits ?? DEFAULT_TURN_LIMITS;
  const base =
    input.phase === "repair"
      ? limits.repair
      : input.phase === "semantic-review"
        ? limits.semanticReview
        : limits[input.tier];
  if (input.ceiling !== undefined && !(input.ceiling > 0)) {
    return 0;
  }
  const effective = input.ceiling === undefined ? base : Math.min(base, input.ceiling);
  return Number.isInteger(effective) && effective > 0 ? effective : 0;
}

/**
 * Nuo turn'ų skaičiaus NEPRIKLAUSOMAS dispatch'o wall-clock narys (proceso paleidimas,
 * readme-guard, agentų grandinė sub-agentuose, build/test ratai — kiekvienas vienas
 * main-thread turn'as, bet dešimtys minučių). 2026-08-08 (0033-02): 4 min buvo spėjimas;
 * didžiausia stebėta liekana SĖKMINGOJE sesijoje — 31 min 18 s, tad 40 min dengia
 * `b + 3*sigma` rėžį. Kaštų kompromisas priimtas sąmoningai: plokščias langas žudė
 * SĖKMINGAS sesijas, o re-dispatch'as kainuoja daugiau nei vėliau aptiktas pakibimas.
 */
export const DISPATCH_TIMEOUT_OVERHEAD_MS = 40 * 60 * 1000;

/**
 * Apatinė riba {@link resolveDispatchTimeoutMs} išvedamam langui — TIKRAS clamp'as, kurio
 * negali pramušti jokia kvietėjo kombinacija. Lygi nuo turn'ų nepriklausomam nariui.
 * NE visuotinė dispatch lango grindis: operatoriaus env override kelias lieka atskiras ir
 * sąmoningai neclamp'inamas.
 */
export const MIN_DISPATCH_TIMEOUT_MS = DISPATCH_TIMEOUT_OVERHEAD_MS;

export type DispatchTimeoutInput = {
  tier: TokenBudgetTier;
  /** Nenurodžius — "implementation". */
  phase?: TurnBudgetPhase;
  /** Nenurodžius — {@link DEFAULT_TURN_LIMITS}. */
  limits?: TurnLimits;
  /** Nenurodžius — {@link PER_TURN_WALLCLOCK_ALLOWANCE_MS}. */
  perTurnAllowanceMs?: number;
  /** Nenurodžius — {@link DISPATCH_TIMEOUT_OVERHEAD_MS}. */
  overheadMs?: number;
};

/**
 * Dispatch wall-clock stabdiklis iš tų pačių turn lentelės įvesčių plius eksplicitaus
 * overhead nario (task 0033) — jokio atskiro magiško skaičiaus. KONTR-ĮRODYMAS, kurį ši
 * funkcija privalo gerbti: 1125-host-bootstrap (medium, 44 min 19 s, exit 0) — turn'ų
 * langas ir wall-clock langas NĖRA to paties dydžio šešėliai, vieno turn'o trukmė
 * neribota. `ceiling` sąmoningai neįtraukiamas (jis turn'us gali tik MAŽINTI, tad iš
 * neapkarpytos lentelės išvestas langas visada lieka saugi viršutinė riba); fazė —
 * įtraukiama (repair ant small = 30 turn'ų langas).
 */
export function resolveDispatchTimeoutMs(input: DispatchTimeoutInput): number {
  const limits = input.limits ?? DEFAULT_TURN_LIMITS;
  const phase = input.phase ?? "implementation";
  const perTurnAllowanceMs = input.perTurnAllowanceMs;
  const perTurn =
    perTurnAllowanceMs !== undefined && Number.isFinite(perTurnAllowanceMs) && perTurnAllowanceMs > 0
      ? perTurnAllowanceMs
      : PER_TURN_WALLCLOCK_ALLOWANCE_MS;
  // 0 pridėtinės kainos yra teisėta įvestis (grynas turn lango šešėlis), tad čia `>= 0`.
  const overheadMs = input.overheadMs;
  const overhead =
    overheadMs !== undefined && Number.isFinite(overheadMs) && overheadMs >= 0 ? overheadMs : DISPATCH_TIMEOUT_OVERHEAD_MS;

  const budget = resolveMaxTurns({ phase, tier: input.tier, limits });
  // `0 = be ribos` turn'uose NEGALI reikšti begalinio wall-clock lango: neribotai sesijai
  // duodamas plačiausias žinomas langas, o ne 0/Infinity/NaN.
  const turns =
    budget > 0 ? budget : resolveMaxTurns({ phase: "implementation", tier: "large", limits }) || DEFAULT_TURN_LIMITS.large;
  return Math.max(MIN_DISPATCH_TIMEOUT_MS, turns * perTurn + overhead);
}
