// Kompresijos vėliavų vaizdas ir jų telemetrija operatoriaus UI (VQ, 2026-08-26).
//
// Kodėl atskiras endpoint'as: `vq/config/context-compression.json` valdo PENKIS jungiklius, kurie
// keičia į vykdytoją keliaujančio konteksto turinį, o sprendimas juos kelti remiasi shadow
// matavimais iš `vq/logs/context-size.jsonl`. Iki šiol abi pusės gyveno tik failuose — operatorius
// negalėjo nei pamatyti, ar kompresija apsimoka, nei jos perjungti neredaguodamas JSON ranka.
//
// Trys šio modulio taisyklės:
//
//   1. TIK PROJEKCIJA. Vėliavų prasmę, leistinas reikšmes ir canary ribas apibrėžia
//      `domain/policies/compression/features` — čia jos tik atvaizduojamos. `canary_supported`
//      ateina iš to paties registro, o ne iš čia perrašyto sąrašo: antra kopija reikštų, kad UI
//      siūlo reikšmę, kurią serveris atmes.
//   2. TELEMETRIJA GNIUŽTA ATSKIRAI. Sugadintas ar nesantis `context-size.jsonl` negali paslėpti
//      vėliavų — jos yra vienintelis dalykas, be kurio puslapis beprasmis. Telemetrijos lūžis
//      virsta `degraded` įrašu, ne 500-uku.
//   3. PALYGINIMAS YRA SHADOW, VISOMS PENKIOMS. Matuojama net kai vėliava išjungta (`persist.ts`
//      shadow kelias) — būtent todėl šis puslapis gali atsakyti „ar verta įjungti" PRIEŠ
//      įjungiant. `FEATURE_PAIR_SELECTORS` sieja kiekvieną vėliavą su jos (raw, compiled) lauku
//      poru mėginyje; `worker_task_ir` turi du galimus variantus (prompt'o lygio, task 0032, turi
//      pirmenybę prieš senesnį task'o lygio), likusios keturios — po vieną fiksuotą porą. Vėliava
//      be jokio palyginimo bet kuriame mėginyje lieka `"unmeasured"`, ne spėjimu.

import {
  CONTEXT_COMPRESSION_CANARY_UNSUPPORTED,
  CONTEXT_COMPRESSION_FEATURES,
  type ContextCompressionConfig,
  type ContextCompressionFeature,
  type ContextCompressionFeatureValue,
} from "../../domain/policies/compression/features.js";
import {
  COMPRESSION_DEPENDENCY_INACTIVE,
  COMPRESSION_FEATURE_DEPENDENCIES,
} from "../../domain/policies/compression/dependencies.js";

/** Vienos vėliavos eilutė UI'ui: dabartinė reikšmė ir tai, ką jai apskritai leidžiama pasirinkti. */
export type UiCompressionFeature = {
  key: ContextCompressionFeature;
  value: ContextCompressionFeatureValue;
  /**
   * `false` — dropdown'e canary rodyti NEGALIMA. `bash_output_digest` sprendimo taškas neturi
   * task konteksto, tad canary ten tyliai reikštų „išjungta"; serveris tokią reikšmę atmeta.
   */
  canary_supported: boolean;
  /**
   * Vėliavos, kurios privalo būti ≠ `false`, kad ši vėliava iš tiesų veiktų
   * (`domain/policies/compression/dependencies.ts`). Rakto nebuvimas = jokių priklausomybių.
   */
  requires?: ContextCompressionFeature[];
  /**
   * Užpildoma TIK kai `value` deklaruoja vėliavą aktyvia (≠ `false`), o bent viena `requires`
   * vėliava šiame pačiame konfige yra `false` — tokiu atveju `resolveCompressionFeatureDependencies`
   * ją fail-closed priverstinai išjungtų vykdymo metu, kad ir ką rodo `value`. Kitaip lauko nėra.
   */
  inactive_reason?: typeof COMPRESSION_DEPENDENCY_INACTIVE;
};

/** `context-size.jsonl` eilutė — tik tie laukai, kuriuos šis vaizdas naudoja. */
export type ContextSizeSample = {
  ts?: unknown;
  task_id?: unknown;
  context_chars?: unknown;
  max_context_chars?: unknown;
  selected_token_estimate?: unknown;
  raw_task_chars?: unknown;
  compiled_task_chars?: unknown;
  /**
   * Prompt'o lygio shadow pora (task 0032, `persist.ts`): TAS PATS worker prompt, kurį realiai
   * gautų dispatch — ne vien task'o kūnas. Kai mėginyje yra, ji turi pirmenybę prieš
   * `raw_task_chars`/`compiled_task_chars`.
   */
  raw_prompt_chars?: unknown;
  compiled_prompt_chars?: unknown;
  exceeded?: unknown;
  cache_status?: unknown;
  /** `bash_output_digest` shadow pora (`post-hooks.ts`). */
  tool_raw_chars?: unknown;
  tool_digest_chars?: unknown;
  /** `symbol_slices` shadow pora (`metrics.ts`): pilnas šaltinis vs vien signatūra. */
  symbol_source_chars?: unknown;
  symbol_signature_chars?: unknown;
  /** `dispatch_tool_schema` shadow pora (`metrics.ts`). */
  tool_schema_full_chars?: unknown;
  tool_schema_reduced_chars?: unknown;
  /** `compact_dsl` shadow pora (`metrics.ts`). */
  dsl_ir_chars?: unknown;
  dsl_compiled_chars?: unknown;
};

/** Kuri pora informavo shadow IR palyginimą: prompt'o lygio (nauja) ar task'o lygio (senoji). */
export type UiCompressionIrPair = "prompt" | "task";

export type UiCompressionTelemetry = {
  /** Kiek eilučių pateko į santrauką (imamos naujausios). */
  sample_count: number;
  latest_ts?: string;
  /** Vidutinis konteksto užpildymas procentais nuo `max_context_chars`. */
  avg_budget_percent?: number;
  max_budget_percent?: number;
  /** Kiek kartų paketas viršijo biudžetą — bet koks >0 yra signalas, ne triukšmas. */
  exceeded_count: number;
  /**
   * Shadow IR palyginimas. `ir_smaller_count` mažesnis už `ir_compared_count` reiškia, kad
   * `worker_task_ir` daliai užduočių paketą DIDINTŲ — įjungimas be šito skaičiaus yra spėjimas.
   */
  ir_compared_count: number;
  ir_smaller_count: number;
  avg_ir_delta_percent?: number;
  /**
   * Kuri pora sudarė `ir_*` skaičius. Prompt'o lygio pora turi pirmenybę kiekvienam mėginiui,
   * kai jis ją turi; task'o lygio pora naudojama tik tiems mėginiams, kur prompt'o poros nėra.
   * Nebūna, kai `ir_compared_count` yra 0 — tada nėra ko įvardyti.
   */
  ir_pair?: UiCompressionIrPair;
  /**
   * Shadow pora likusioms keturioms vėliavoms (`compact_dsl`, `symbol_slices`,
   * `bash_output_digest`, `dispatch_tool_schema`) — po vieną fiksuotą lauko porą kiekvienai,
   * be prompt/task fallback'o, kurį turi tik `worker_task_ir` (žr. `ir_*` laukus aukščiau).
   * Rakto nebuvimas reiškia „nė vienas mėginys šios poros neturėjo".
   */
  feature_pairs?: Partial<Record<ContextCompressionFeature, UiFeaturePairStats>>;
};

/** Vienos vėliavos shadow poros agregatas — analogiškas `ir_*` laukams, bet bet kuriai vėliavai. */
export type UiFeaturePairStats = {
  compared_count: number;
  smaller_count: number;
  avg_delta_percent?: number;
};

/**
 * Sprendimo verdiktas, suskaičiuotas ČIA, ne kliente.
 *
 * Kodėl: telemetrijos lentelė („56 mėginiai, vidurkis 48%, IR delta +22%") atsako į klausimą
 * „kas išmatuota", bet operatoriaus klausimas yra kitas — „ar VERTA jungti bent vieną vėliavą".
 * Puslapio taisyklė Nr. 1 draudžia jam skaičiuoti pačiam, tad verdiktą taria serveris, o UI tik
 * verčia kodus į sakinius.
 */
export type UiCompressionPressureLevel = "insufficient" | "none" | "moderate" | "high";

export type UiCompressionAction = "enable" | "optional" | "hold" | "insufficient" | "unmeasured";

export type UiCompressionRecommendation = {
  key: ContextCompressionFeature;
  action: UiCompressionAction;
  /** Stabilus priežasties kodas — UI jį verčia; laisvo teksto čia NĖRA, kad vertimas negestų. */
  reason:
    | "ir-larger-on-average"
    | "ir-smaller-under-pressure"
    | "ir-smaller-no-pressure"
    | "too-few-ir-comparisons"
    | "no-shadow-measurement"
    /** Tos pačios keturios kategorijos, bet bet kuriai vėliavai be `worker_task_ir` prompt/task konteksto. */
    | "larger-on-average"
    | "smaller-under-pressure"
    | "smaller-no-pressure"
    | "too-few-comparisons";
  /** Kuri pora buvo naudota šiam sprendimui — kad UI galėtų įvardyti KAS lyginama. */
  pair?: UiCompressionIrPair;
};

export type UiCompressionDecision = {
  pressure: { level: UiCompressionPressureLevel };
  recommendations: UiCompressionRecommendation[];
};

export type UiCompressionView = {
  version: number;
  canary: { percent: number; salt: string };
  features: UiCompressionFeature[];
  telemetry: UiCompressionTelemetry;
  decision: UiCompressionDecision;
  /** Šaltiniai, kurių perskaityti nepavyko. Tuščias sąrašas = pilnas vaizdas. */
  degraded: string[];
};

/** Kiek naujausių telemetrijos eilučių imama į santrauką. */
export const COMPRESSION_TELEMETRY_SAMPLE_LIMIT = 200;

function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function percent(part: number, whole: number): number | undefined {
  return whole > 0 ? Math.round((part / whole) * 1000) / 10 : undefined;
}

function average(values: number[]): number | undefined {
  if (values.length === 0) return undefined;
  return Math.round((values.reduce((sum, value) => sum + value, 0) / values.length) * 10) / 10;
}

/** Naujausios `limit` eilutės; neparsinamos praleidžiamos tyliai — viena sugadinta eilutė nėra lūžis. */
export function parseContextSizeSamples(raw: string, limit = COMPRESSION_TELEMETRY_SAMPLE_LIMIT): ContextSizeSample[] {
  const lines = raw.split(/\r?\n/).filter((line) => line.trim().length > 0);
  const tail = lines.slice(Math.max(0, lines.length - limit));
  const samples: ContextSizeSample[] = [];
  for (const line of tail) {
    try {
      const parsed: unknown = JSON.parse(line);
      if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
        samples.push(parsed);
      }
    } catch {
      // Nutrūkusi eilutė (rašymas vyksta lygiagrečiai) — praleidžiama.
    }
  }
  return samples;
}

/**
 * Vieno mėginio shadow pora bet kuriai vėliavai: `raw` — nesuspaustas dydis, `compiled` — po
 * kompresijos. `pair` įvardija KURI pora naudota tik tada, kai vėliava turi daugiau nei vieną
 * galimą porą (šiandien — tik `worker_task_ir`, prompt/task fallback); likusioms keturioms
 * kiekvienai yra lygiai viena fiksuota lauko pora, tad `pair` joms nereikalingas.
 */
type PairMeasurement = { raw: number; compiled: number; pair?: UiCompressionIrPair };

/**
 * `worker_task_ir` shadow pora. Prompt'o lygio pora (`raw_prompt_chars`/`compiled_prompt_chars`,
 * task 0032) turi pirmenybę, kai mėginys ją turi — tai pora, ant kurios sprendimas iš tiesų
 * daromas, nes ji apima tą patį worker prompt'ą, kurį gautų dispatch, ne vien task'o kūną.
 * Senesni mėginiai jos neturi, todėl kritimas prie `raw_task_chars`/`compiled_task_chars` yra
 * fallback, ne lūžis. REGRESIJOS RIBA: šios funkcijos rezultatas (ir tuo pačiu `worker_task_ir`
 * verdiktas `decideCompression` viduje) privalo likti bitiškai tapatus, kad ir kaip keičiasi
 * likusių keturių vėliavų logika.
 */
function selectIrPair(sample: ContextSizeSample): PairMeasurement | undefined {
  const promptRaw = finiteNumber(sample.raw_prompt_chars);
  const promptCompiled = finiteNumber(sample.compiled_prompt_chars);
  if (promptRaw !== undefined && promptCompiled !== undefined && promptRaw > 0) {
    return { raw: promptRaw, compiled: promptCompiled, pair: "prompt" };
  }

  const taskRaw = finiteNumber(sample.raw_task_chars);
  const taskCompiled = finiteNumber(sample.compiled_task_chars);
  if (taskRaw !== undefined && taskCompiled !== undefined && taskRaw > 0) {
    return { raw: taskRaw, compiled: taskCompiled, pair: "task" };
  }

  return undefined;
}

/** Fiksuota (raw, compiled) lauko pora — vėliavoms be prompt/task fallback'o. */
function fixedFieldPair(
  rawKey: keyof ContextSizeSample,
  compiledKey: keyof ContextSizeSample,
): (sample: ContextSizeSample) => PairMeasurement | undefined {
  return (sample) => {
    const raw = finiteNumber(sample[rawKey]);
    const compiled = finiteNumber(sample[compiledKey]);
    if (raw === undefined || compiled === undefined || raw <= 0) return undefined;
    return { raw, compiled };
  };
}

/**
 * Vienintelis vietoj kur susieta „kuri vėliava — kuri shadow pora mėginyje". Apima visas penkias
 * vėliavas, kad `decideCompression`/`summarizeContextSizeSamples` galėtų dirbti per lentelę, o ne
 * per vieną hardkodintą `worker_task_ir` atvejį + tylų „unmeasured" likusioms.
 */
export const FEATURE_PAIR_SELECTORS: Record<ContextCompressionFeature, (sample: ContextSizeSample) => PairMeasurement | undefined> = {
  worker_task_ir: selectIrPair,
  compact_dsl: fixedFieldPair("dsl_ir_chars", "dsl_compiled_chars"),
  symbol_slices: fixedFieldPair("symbol_source_chars", "symbol_signature_chars"),
  bash_output_digest: fixedFieldPair("tool_raw_chars", "tool_digest_chars"),
  dispatch_tool_schema: fixedFieldPair("tool_schema_full_chars", "tool_schema_reduced_chars"),
};

export function summarizeContextSizeSamples(samples: ContextSizeSample[]): UiCompressionTelemetry {
  const budgetPercents: number[] = [];
  let exceededCount = 0;
  let latestTs: string | undefined;

  const compared = new Map<ContextCompressionFeature, number>();
  const smaller = new Map<ContextCompressionFeature, number>();
  const deltas = new Map<ContextCompressionFeature, number[]>();
  let irPromptPairCount = 0;
  for (const key of CONTEXT_COMPRESSION_FEATURES) {
    compared.set(key, 0);
    smaller.set(key, 0);
    deltas.set(key, []);
  }

  for (const sample of samples) {
    if (typeof sample.ts === "string") latestTs = sample.ts;
    if (sample.exceeded === true) exceededCount += 1;

    const contextChars = finiteNumber(sample.context_chars);
    const maxChars = finiteNumber(sample.max_context_chars);
    if (contextChars !== undefined && maxChars !== undefined) {
      const share = percent(contextChars, maxChars);
      if (share !== undefined) budgetPercents.push(share);
    }

    for (const key of CONTEXT_COMPRESSION_FEATURES) {
      const measurement = FEATURE_PAIR_SELECTORS[key](sample);
      if (measurement === undefined) continue;
      compared.set(key, (compared.get(key) ?? 0) + 1);
      if (key === "worker_task_ir" && measurement.pair === "prompt") irPromptPairCount += 1;
      if (measurement.compiled < measurement.raw) smaller.set(key, (smaller.get(key) ?? 0) + 1);
      // Neigiama delta = compiled mažesnis (nauda). Teigiama = compiled didesnis (žala).
      deltas.get(key)?.push(Math.round(((measurement.compiled - measurement.raw) / measurement.raw) * 1000) / 10);
    }
  }

  const avgBudget = average(budgetPercents);
  const maxBudget = budgetPercents.length === 0 ? undefined : Math.max(...budgetPercents);
  const irCompared = compared.get("worker_task_ir") ?? 0;
  const irSmaller = smaller.get("worker_task_ir") ?? 0;
  const avgIrDelta = average(deltas.get("worker_task_ir") ?? []);

  const featurePairs: Partial<Record<ContextCompressionFeature, UiFeaturePairStats>> = {};
  for (const key of CONTEXT_COMPRESSION_FEATURES) {
    if (key === "worker_task_ir") continue;
    const comparedCount = compared.get(key) ?? 0;
    if (comparedCount === 0) continue;
    const avgDelta = average(deltas.get(key) ?? []);
    featurePairs[key] = {
      compared_count: comparedCount,
      smaller_count: smaller.get(key) ?? 0,
      ...(avgDelta === undefined ? {} : { avg_delta_percent: avgDelta }),
    };
  }

  return {
    sample_count: samples.length,
    ...(latestTs === undefined ? {} : { latest_ts: latestTs }),
    ...(avgBudget === undefined ? {} : { avg_budget_percent: avgBudget }),
    ...(maxBudget === undefined ? {} : { max_budget_percent: maxBudget }),
    exceeded_count: exceededCount,
    ir_compared_count: irCompared,
    ir_smaller_count: irSmaller,
    ...(avgIrDelta === undefined ? {} : { avg_ir_delta_percent: avgIrDelta }),
    ...(irCompared === 0 ? {} : { ir_pair: irPromptPairCount > 0 ? "prompt" : "task" }),
    ...(Object.keys(featurePairs).length === 0 ? {} : { feature_pairs: featurePairs }),
  };
}

/**
 * Sprendimo slenksčiai. Skaičiai yra POLITIKA, ne matavimas, todėl jie čia įvardyti, o ne
 * išbarstyti sąlygose: žemiau `MIN_DECISION_SAMPLES` verdiktas atsisakomas (per mažai įrodymų
 * abiem kryptim), o spaudimo lygiai kalibruoti pagal tai, kad `exceeded` yra vienintelis
 * nekvestionuojamas signalas — procentai tik įspėja anksčiau.
 */
export const MIN_DECISION_SAMPLES = 10;
export const PRESSURE_HIGH_MAX_PERCENT = 90;
export const PRESSURE_MODERATE_AVG_PERCENT = 60;
export const PRESSURE_MODERATE_MAX_PERCENT = 75;

export function decidePressure(telemetry: UiCompressionTelemetry): UiCompressionPressureLevel {
  if (telemetry.sample_count < MIN_DECISION_SAMPLES) return "insufficient";
  if (telemetry.exceeded_count > 0) return "high";
  const max = telemetry.max_budget_percent ?? 0;
  const avg = telemetry.avg_budget_percent ?? 0;
  if (max >= PRESSURE_HIGH_MAX_PERCENT) return "high";
  if (avg >= PRESSURE_MODERATE_AVG_PERCENT || max >= PRESSURE_MODERATE_MAX_PERCENT) return "moderate";
  return "none";
}

/**
 * Rekomendacija KIEKVIENAI vėliavai — įskaitant tas, kurioms matavimo nėra.
 *
 * Shadow matavimą šiandien turi tik `worker_task_ir` — telemetrijos `ir_pair` sako, kuri pora
 * jį sudarė (prompt'o lygio, kai mėginiuose yra, kitaip task'o lygio fallback), o rekomendacija
 * tą lauką perduoda toliau, kad UI galėtų įvardyti KAS lyginama. Likusioms keturioms sąžiningas
 * atsakymas yra „nematuojama", o ne tyla: eilutės nebuvimas skaitytojui atrodytų kaip „viskas
 * gerai", nors iš tiesų sprendimui duomenų nėra.
 */
/**
 * Rekomendacija VIENAI iš keturių vėliavų be prompt/task fallback'o, remiantis jos shadow poros
 * agregatu (`telemetry.feature_pairs[key]`). Tos pačios keturios kategorijos kaip `worker_task_ir`
 * aukščiau, bet be `pair` lauko (nėra ko įvardyti — vėliava turi lygiai vieną poros variantą) ir su
 * bendrais (ne `ir-` prefiksuotais) priežasties kodais.
 */
function decideFeaturePairAction(
  key: Exclude<ContextCompressionFeature, "worker_task_ir">,
  stats: UiFeaturePairStats | undefined,
  pressure: UiCompressionPressureLevel,
): UiCompressionRecommendation {
  if (stats === undefined || stats.compared_count === 0) {
    return { key, action: "unmeasured", reason: "no-shadow-measurement" };
  }
  if (stats.compared_count < MIN_DECISION_SAMPLES) {
    return { key, action: "insufficient", reason: "too-few-comparisons" };
  }
  const delta = stats.avg_delta_percent ?? 0;
  // Teigiama delta = compiled VIDUTINIŠKAI didesnis už raw — įjungimas paketą augintų, ne mažintų.
  if (delta > 0) return { key, action: "hold", reason: "larger-on-average" };
  if (pressure === "high" || pressure === "moderate") {
    return { key, action: "enable", reason: "smaller-under-pressure" };
  }
  return { key, action: "optional", reason: "smaller-no-pressure" };
}

export function decideCompression(telemetry: UiCompressionTelemetry): UiCompressionDecision {
  const pressure = decidePressure(telemetry);
  const pairField = telemetry.ir_pair === undefined ? {} : { pair: telemetry.ir_pair };

  const irAction = ((): UiCompressionRecommendation => {
    if (telemetry.ir_compared_count < MIN_DECISION_SAMPLES) {
      return { key: "worker_task_ir", action: "insufficient", reason: "too-few-ir-comparisons", ...pairField };
    }
    const delta = telemetry.avg_ir_delta_percent ?? 0;
    // Teigiama delta = IR VIDUTINIŠKAI didesnis už raw — įjungimas paketą augintų, ne mažintų.
    if (delta > 0) return { key: "worker_task_ir", action: "hold", reason: "ir-larger-on-average", ...pairField };
    if (pressure === "high" || pressure === "moderate") {
      return { key: "worker_task_ir", action: "enable", reason: "ir-smaller-under-pressure", ...pairField };
    }
    return { key: "worker_task_ir", action: "optional", reason: "ir-smaller-no-pressure", ...pairField };
  })();

  return {
    pressure: { level: pressure },
    recommendations: CONTEXT_COMPRESSION_FEATURES.map((key) =>
      key === "worker_task_ir" ? irAction : decideFeaturePairAction(key, telemetry.feature_pairs?.[key], pressure),
    ),
  };
}

export type CompressionViewPorts = {
  /** Dabartinis konfigas; klaida verčiama į numatytąjį PRIE `degraded` įrašo kvietėjo pusėje. */
  loadConfig(): Promise<ContextCompressionConfig>;
  /** `vq/logs/context-size.jsonl` turinys; `undefined` — failo nėra. */
  readContextSizeLog(): Promise<string | undefined>;
};

/**
 * Surenka pilną puslapio vaizdą.
 *
 * Konfigo lūžis yra vienintelis, kuris keliauja aukštyn kaip išimtis: be vėliavų puslapis neturi
 * ką rodyti nei keisti. Telemetrijos lūžis lieka `degraded` įraše.
 */
export async function buildCompressionView(ports: CompressionViewPorts): Promise<UiCompressionView> {
  const config = await ports.loadConfig();
  const degraded: string[] = [];

  let telemetry: UiCompressionTelemetry = summarizeContextSizeSamples([]);
  try {
    const raw = await ports.readContextSizeLog();
    if (raw === undefined) {
      degraded.push("context-size.jsonl: not found");
    } else {
      telemetry = summarizeContextSizeSamples(parseContextSizeSamples(raw));
    }
  } catch (error) {
    degraded.push(`context-size.jsonl: ${error instanceof Error ? error.message : String(error)}`);
  }

  return {
    version: config.version,
    canary: { percent: config.canary.percent, salt: config.canary.salt },
    features: CONTEXT_COMPRESSION_FEATURES.map((key) => {
      const value = config.features[key];
      const requires = COMPRESSION_FEATURE_DEPENDENCIES.filter((dependency) => dependency.feature === key).map(
        (dependency) => dependency.requires,
      );
      const unsatisfied = requires.some((required) => config.features[required] === false);
      return {
        key,
        value,
        canary_supported: !CONTEXT_COMPRESSION_CANARY_UNSUPPORTED.includes(key),
        ...(requires.length === 0 ? {} : { requires }),
        ...(value !== false && unsatisfied ? { inactive_reason: COMPRESSION_DEPENDENCY_INACTIVE } : {}),
      };
    }),
    telemetry,
    decision: decideCompression(telemetry),
    degraded,
  };
}
