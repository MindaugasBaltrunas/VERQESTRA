// `vq/config/preflight-limits.json` — VIENINTELIS skaitytojas (etalono
// policy/preflight-limits-policy.ts, task 0057 pamoka; WBR VQ-305).
//
// Etalone tą patį failą anksčiau skaitė DU loaderiai su priešinga semantika: vienas tyliai
// nukrisdavo į default'us (sugadintas JSON = jokio signalo), kitas fail-fast'ino. Tas pats
// sugadintas failas duodavo skirtingą verdiktą priklausomai nuo kelio — o tyliajame kelyje
// gyveno DISPATCH TURN BIUDŽETAI. Dabar failą skaito viena funkcija
// ({@link readPreflightLimitsFile}):
//   - failo nėra / tuščias   → `present: false` (produkto numatytoji būsena);
//   - blogas JSON            → `PolicyConfigError`;
//   - nežinomas raktas       → `PolicyConfigError` (tylus ignoravimas reikštų konfigą, kuris
//                              atrodo pakeistas, bet dispatch elgesio nekeičia);
//   - blogas tipas / reikšmė → `PolicyConfigError`.
// `PolicyConfigError` kvietėjo klasifikuojamas kaip infra abort (visa eilė), o ne kaip vieno
// nekalto task'o human-review.
import path from "node:path";
import { z } from "zod";
import { parseWithSchema } from "../../shared/schema.js";
import { withPolicyConfigErrors } from "../../shared/errors.js";
import { DEFAULT_TURN_LIMITS, type TurnLimits } from "../token-governance/turn-budget.js";
import type { PolicyConfigFileSystemPort } from "./ports.js";

/** `runtimeRoot`-reliatyvus kelias — vienintelė šio failo vardo vieta. */
export const PREFLIGHT_LIMITS_CONFIG_FILE = "config/preflight-limits.json";

/** Kaip konfigas vadinamas klaidų žinutėse (projekto šaknies atžvilgiu). */
export const PREFLIGHT_LIMITS_DISPLAY_PATH = `vq/${PREFLIGHT_LIMITS_CONFIG_FILE}`;

/**
 * Deterministinio preflight size gate konfigūracija. Slenksčiai derinami per
 * `vq/config/preflight-limits.json`; trūkstant failo naudojami šie saugūs numatytieji.
 * `autoOpenSpec` valdo auto-OpenSpec generavimą.
 */
export interface PreflightLimits {
  maxLines: number;
  maxAllowedPaths: number;
  maxDomains: number;
  maxActionBullets: number;
  autoOpenSpec: boolean;
  /**
   * TOK-01: deterministinis preflight fast-path. Kai task failas jau kanoninis (visos
   * sekcijos, dydis ribose, žinoma agentų grandinė, backtick scope keliai) — LLM preflight
   * praleidžiamas ir dispatch'inama tiesiogiai. Išjungiama per `"fastPath": false`.
   */
  fastPath: boolean;
  /** TOK-02: LLM preflight sesijos turn limitas. 0 = be ribos. */
  llmMaxTurns: number;
  /**
   * Dispatch (implementacijos) sesijos turn LUBOS. TOK-3: realų langą duoda `turnLimits`
   * lentelė pagal užduoties dydį/fazę, o `dispatchMaxTurns` veikia kaip bendros lubos virš
   * jos (`min(lentelė, dispatchMaxTurns)`). 0 = be ribos (aiškus operatoriaus opt-out,
   * išjungiantis ir lentelę).
   */
  dispatchMaxTurns: number;
  /**
   * TOK-3: turn limitai pagal struktūrinį užduoties dydį (small/medium/large) ir fazę
   * (repair, semantic-review). Konfige galima nurodyti dalinį objektą — trūkstami raktai
   * užpildomi iš {@link DEFAULT_TURN_LIMITS}. Optional dėl backward compatibility:
   * `loadPreflightLimits` jį visada užpildo.
   */
  turnLimits?: TurnLimits;
  /**
   * Maksimalus skaidymo gylis kartomis: root task = 0, jo vaikas = 1 ir t.t. Pasiekus ribą
   * vaikai nebekuriami, tėvas keliauja į human-review. 0 = be ribos.
   */
  maxSplitDepth: number;
}

export const DEFAULT_PREFLIGHT_LIMITS: PreflightLimits = {
  maxLines: 120,
  maxAllowedPaths: 8,
  maxDomains: 2,
  maxActionBullets: 6,
  autoOpenSpec: false,
  fastPath: true,
  llmMaxTurns: 12,
  // 180 (0033 kalibracija, HUMAN-REVIEW-APPROVED 2026-08-08): lubos NEGALI kirsti kalibruotos
  // turn lentelės `large=180` — `min(180, 120)=120` grąžindavo reikšmę, kurią 0033 auditas
  // pripažino nepakankama (opus grandinės kirstos paskutiniuose turn'uose, į master pateko
  // sugadintas kodas; nukirsta sesija pabaigoje sudegina visą kontekstą ir vis tiek virsta
  // repair/human-review ratu). Istorija: 80 → 120 (2026-08-07) → 180 (2026-08-25, optimizavimo
  // audito P1-2 — 120 lubos tyliai anuliavo 0033). Turn lentelė (small/medium/large) lieka
  // tikrasis ribotuvas: `min(lentelė, dispatchMaxTurns)`; lubos saugo tik nuo konfigo klaidos.
  dispatchMaxTurns: 180,
  maxSplitDepth: 3,
  turnLimits: { ...DEFAULT_TURN_LIMITS },
};

// Turn limitas yra TEIGIAMAS sveikas skaičius. 0 čia NELEIDŽIAMAS: `resolveMaxTurns` grąžintą
// 0 dispatch traktuoja kaip „be --max-turns flag'o", t. y. viena `"small": 0` eilutė paverstų
// dispatch'ą NERIBOTU — priešingai, nei operatorius tikėtųsi rašydamas nulį. „0 = be ribos"
// opt-out gyvena TIK `dispatchMaxTurns`/`llmMaxTurns`/`maxSplitDepth` raktuose.
const turnLimitSchema = z.number().int().positive();

const turnLimitsFileSchema = z.strictObject({
  small: turnLimitSchema.optional(),
  medium: turnLimitSchema.optional(),
  large: turnLimitSchema.optional(),
  repair: turnLimitSchema.optional(),
  semanticReview: turnLimitSchema.optional(),
});

const positiveInt = z.number().int().positive();
// „0 = be ribos" yra dokumentuotas opt-out šiems trims raktams, tad jie nonnegative.
const nonNegativeInt = z.number().int().nonnegative();

/**
 * Failo schema: VISI raktai optional (dalinis konfigas teisėtas), bet nežinomas raktas ar
 * blogas tipas = klaida. `_comment` — vienintelis leistinas ne-politikos raktas.
 */
export const preflightLimitsFileSchema = z.strictObject({
  _comment: z.string().optional(),
  maxLines: positiveInt.optional(),
  maxAllowedPaths: positiveInt.optional(),
  maxDomains: positiveInt.optional(),
  maxActionBullets: positiveInt.optional(),
  autoOpenSpec: z.boolean().optional(),
  fastPath: z.boolean().optional(),
  llmMaxTurns: nonNegativeInt.optional(),
  dispatchMaxTurns: nonNegativeInt.optional(),
  turnLimits: turnLimitsFileSchema.optional(),
  maxSplitDepth: nonNegativeInt.optional(),
});

/** Tiksliai tai, ką deklaruoja FAILAS — be default'ų. */
export type PreflightLimitsFile = z.infer<typeof preflightLimitsFileSchema>;

export function preflightLimitsPath(runtimeRoot: string): string {
  return path.join(runtimeRoot, ...PREFLIGHT_LIMITS_CONFIG_FILE.split("/"));
}

/**
 * `undefined` reikšmės neperrašo default'o (zod optional gali grąžinti raktą su `undefined`).
 * Grąžinamas tipas IŠVALO `undefined` iš reikšmių — runtime filtras tai garantuoja, o be šito
 * spread'as virš pilnų default'ų TS akimis paliktų `number | undefined`.
 */
function defined<T extends object>(source: T): { [K in keyof T]?: Exclude<T[K], undefined> } {
  return Object.fromEntries(Object.entries(source).filter(([, value]) => value !== undefined)) as {
    [K in keyof T]?: Exclude<T[K], undefined>;
  };
}

/**
 * GRYNAS merge: failo reikšmės virš kodo default'ų. `turnLimits` liejamas PER RAKTĄ —
 * `{...defaults, ...parsed}` dalinį objektą paverstų nepilnu (pvz. tik `{"small": 10}`
 * paliktų `repair` neapibrėžtą ir `resolveMaxTurns` grąžintų NaN).
 */
export function mergePreflightLimits(file: PreflightLimitsFile): PreflightLimits {
  const { turnLimits, _comment: _ignored, ...scalars } = file;
  return {
    ...DEFAULT_PREFLIGHT_LIMITS,
    ...defined(scalars),
    turnLimits: { ...DEFAULT_TURN_LIMITS, ...(turnLimits ? defined(turnLimits) : {}) },
  };
}

/**
 * Nuskaito ir VALIDUOJA failą, negrąžindamas default'ų — kvietėjui, kuriam svarbu, ką failas
 * realiai deklaruoja (pvz. dispatch, perduodantis `turnLimits` kaip legacy sluoksnį token
 * budget konfigui: default'ais užpildyta lentelė ten meluotų, kad kiekviena reikšmė atėjo iš
 * konfigo). `present: false` reiškia „failo nėra arba jis tuščias" — tai legalu.
 */
export async function readPreflightLimitsFile(
  fs: PolicyConfigFileSystemPort,
  runtimeRoot: string,
): Promise<{ present: boolean; values: PreflightLimitsFile }> {
  return await withPolicyConfigErrors(PREFLIGHT_LIMITS_DISPLAY_PATH, async () => {
    const raw = await fs.readTextFileIfExists(preflightLimitsPath(runtimeRoot));
    if (!raw?.trim()) return { present: false, values: {} };

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`${PREFLIGHT_LIMITS_DISPLAY_PATH} is not valid JSON: ${message}`, { cause: error });
    }

    return { present: true, values: parseWithSchema(preflightLimitsFileSchema, parsed, PREFLIGHT_LIMITS_DISPLAY_PATH) };
  });
}

/** Kanoninis loaderis: validuotas failas, sulietas su kodo default'ais. */
export async function loadPreflightLimits(
  fs: PolicyConfigFileSystemPort,
  runtimeRoot: string,
): Promise<PreflightLimits> {
  const { values } = await readPreflightLimitsFile(fs, runtimeRoot);
  return mergePreflightLimits(values);
}
