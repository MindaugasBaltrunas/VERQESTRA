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
//   3. IR PALYGINIMAS YRA SHADOW. `raw_task_chars` vs `compiled_task_chars` matuojami net kai
//      `worker_task_ir` išjungtas (`persist.ts` shadow kelias) — būtent todėl šis puslapis gali
//      atsakyti „ar verta įjungti" PRIEŠ įjungiant.

import {
  CONTEXT_COMPRESSION_CANARY_UNSUPPORTED,
  CONTEXT_COMPRESSION_FEATURES,
  type ContextCompressionConfig,
  type ContextCompressionFeature,
  type ContextCompressionFeatureValue,
} from "../../domain/policies/compression/features.js";

/** Vienos vėliavos eilutė UI'ui: dabartinė reikšmė ir tai, ką jai apskritai leidžiama pasirinkti. */
export type UiCompressionFeature = {
  key: ContextCompressionFeature;
  value: ContextCompressionFeatureValue;
  /**
   * `false` — dropdown'e canary rodyti NEGALIMA. `bash_output_digest` sprendimo taškas neturi
   * task konteksto, tad canary ten tyliai reikštų „išjungta"; serveris tokią reikšmę atmeta.
   */
  canary_supported: boolean;
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
  exceeded?: unknown;
  cache_status?: unknown;
};

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
};

export type UiCompressionView = {
  version: number;
  canary: { percent: number; salt: string };
  features: UiCompressionFeature[];
  telemetry: UiCompressionTelemetry;
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

export function summarizeContextSizeSamples(samples: ContextSizeSample[]): UiCompressionTelemetry {
  const budgetPercents: number[] = [];
  const irDeltas: number[] = [];
  let exceededCount = 0;
  let irCompared = 0;
  let irSmaller = 0;
  let latestTs: string | undefined;

  for (const sample of samples) {
    if (typeof sample.ts === "string") latestTs = sample.ts;
    if (sample.exceeded === true) exceededCount += 1;

    const contextChars = finiteNumber(sample.context_chars);
    const maxChars = finiteNumber(sample.max_context_chars);
    if (contextChars !== undefined && maxChars !== undefined) {
      const share = percent(contextChars, maxChars);
      if (share !== undefined) budgetPercents.push(share);
    }

    const rawChars = finiteNumber(sample.raw_task_chars);
    const compiledChars = finiteNumber(sample.compiled_task_chars);
    if (rawChars !== undefined && compiledChars !== undefined && rawChars > 0) {
      irCompared += 1;
      if (compiledChars < rawChars) irSmaller += 1;
      // Neigiama delta = IR mažesnis (nauda). Teigiama = IR didesnis (žala).
      irDeltas.push(Math.round(((compiledChars - rawChars) / rawChars) * 1000) / 10);
    }
  }

  const avgBudget = average(budgetPercents);
  const maxBudget = budgetPercents.length === 0 ? undefined : Math.max(...budgetPercents);
  const avgIrDelta = average(irDeltas);

  return {
    sample_count: samples.length,
    ...(latestTs === undefined ? {} : { latest_ts: latestTs }),
    ...(avgBudget === undefined ? {} : { avg_budget_percent: avgBudget }),
    ...(maxBudget === undefined ? {} : { max_budget_percent: maxBudget }),
    exceeded_count: exceededCount,
    ir_compared_count: irCompared,
    ir_smaller_count: irSmaller,
    ...(avgIrDelta === undefined ? {} : { avg_ir_delta_percent: avgIrDelta }),
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
    features: CONTEXT_COMPRESSION_FEATURES.map((key) => ({
      key,
      value: config.features[key],
      canary_supported: !CONTEXT_COMPRESSION_CANARY_UNSUPPORTED.includes(key),
    })),
    telemetry,
    degraded,
  };
}
