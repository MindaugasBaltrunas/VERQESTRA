// Claude CLI usage/limit klasifikacija ir GYVAS stream-json skaitiklis (etalonas: AG_loop
// core/claude-headless.ts usage pusė; task 1203 + 1222). FQC-12: `ClaudeUsage` tipas —
// infrastructure/state/token-usage-log; galutinio `result` envelope paieška —
// domain/diagnosis/stream-log (vienintelis stream-json parserių namas jam).

import { extractResultEnvelopeFromStreamJsonLog } from "../../domain/diagnosis/stream-log.js";
import type { ClaudeUsage } from "../state/token-usage-log.js";

/** Bendras usage/cost mapping'as iš vieno JSON envelope (json arba stream-json result). */
function usageFromEnvelope(outer: Record<string, unknown>): ClaudeUsage | undefined {
  const usage = (outer["usage"] as Record<string, unknown> | undefined) ?? undefined;
  const cost = typeof outer["total_cost_usd"] === "number" ? outer["total_cost_usd"] : undefined;
  const turns = typeof outer["num_turns"] === "number" ? outer["num_turns"] : undefined;
  if (!usage && cost === undefined && turns === undefined) {
    return undefined;
  }
  const num = (value: unknown): number | undefined => (typeof value === "number" ? value : undefined);
  const input = num(usage?.["input_tokens"]);
  const output = num(usage?.["output_tokens"]);
  const cacheRead = num(usage?.["cache_read_input_tokens"]);
  const cacheCreation = num(usage?.["cache_creation_input_tokens"]);
  return {
    ...(input === undefined ? {} : { input_tokens: input }),
    ...(output === undefined ? {} : { output_tokens: output }),
    ...(cacheRead === undefined ? {} : { cache_read_input_tokens: cacheRead }),
    ...(cacheCreation === undefined ? {} : { cache_creation_input_tokens: cacheCreation }),
    ...(cost === undefined ? {} : { total_cost_usd: cost }),
    // Laukas dedamas TIK kai jis realiai yra: `{ num_turns: undefined }` raktas keistų
    // kiekvieno usage objekto formą (ir deep-equal palyginimus) be jokios informacijos.
    ...(turns === undefined ? {} : { num_turns: turns }),
  };
}

/**
 * Token/kaštų usage iš `claude -p --output-format json` envelope. `undefined`, jei stdout
 * nėra JSON arba neturi usage/cost laukų.
 */
export function extractUsage(stdout: string): ClaudeUsage | undefined {
  try {
    return usageFromEnvelope(JSON.parse(stdout.trim()) as Record<string, unknown>);
  } catch {
    return undefined;
  }
}

/**
 * TOK-04: usage iš `--output-format stream-json` log'o — paskutinio `"type":"result"`
 * įvykio usage/cost (jis sumuoja visą dispatch sesiją).
 */
export function extractUsageFromStreamJsonLog(logText: string): ClaudeUsage | undefined {
  const envelope = extractResultEnvelopeFromStreamJsonLog(logText);
  return envelope ? usageFromEnvelope(envelope) : undefined;
}

// ---------------------------------------------------------------------------
// Task 1203: GYVAS stream-json usage skaitiklis. Mid-dispatch stabdikliui galutinio
// `result` envelope nepakanka: (a) sprendimas priimamas srauto viduryje, (b) NUTRAUKTA
// sesija `result` neturi visai — be gyvo skaitiklio sudeginti tokenai niekada nepatektų
// į ledger'į ir loop'as degintų amžinai.
// ---------------------------------------------------------------------------

/** Riba, ties kuria be nė vieno `\n` sukauptas buferis laikomas šiukšlėmis ir išmetamas. */
export const MAX_STREAM_JSON_LINE_BYTES = 4 * 1024 * 1024;

export type StreamUsageTotals = {
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens: number;
  cache_creation_input_tokens: number;
  /** input + output + cache_read + cache_creation — TA PATI bazė kaip domain taskUsageTokenTotal. */
  total_tokens: number;
  /**
   * Kiek žinučių srautas ĮRODĖ. 0 = NĖRA DUOMENŲ (ne „nulis tokenų"). Srautas, kurio
   * vienintelis usage šaltinis yra anoniminės `message_delta` deltos, skaičiuojasi viena
   * žinute (task 1222).
   */
  messages: number;
  /** Ar matytas galutinis `result` envelope. */
  result_seen: boolean;
};

export type StreamJsonUsageMeter = {
  /** Priima BET KOKĮ srauto gabalą (gali nutrūkti vidury eilutės). Grąžina naują total_tokens. */
  push(text: string): number;
  totals(): StreamUsageTotals;
};

type StreamUsageFields = { input: number; output: number; cacheRead: number; cacheCreation: number };

function streamUsageNumber(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;
}

function streamUsageFields(usage: Record<string, unknown>): StreamUsageFields {
  return {
    input: streamUsageNumber(usage["input_tokens"]),
    output: streamUsageNumber(usage["output_tokens"]),
    cacheRead: streamUsageNumber(usage["cache_read_input_tokens"]),
    cacheCreation: streamUsageNumber(usage["cache_creation_input_tokens"]),
  };
}

function streamUsageSum(fields: StreamUsageFields): number {
  return fields.input + fields.output + fields.cacheRead + fields.cacheCreation;
}

function streamUsageAdd(a: StreamUsageFields, b: StreamUsageFields): StreamUsageFields {
  return {
    input: a.input + b.input,
    output: a.output + b.output,
    cacheRead: a.cacheRead + b.cacheRead,
    cacheCreation: a.cacheCreation + b.cacheCreation,
  };
}

function streamUsageMax(a: StreamUsageFields, b: StreamUsageFields): StreamUsageFields {
  return {
    input: Math.max(a.input, b.input),
    output: Math.max(a.output, b.output),
    cacheRead: Math.max(a.cacheRead, b.cacheRead),
    cacheCreation: Math.max(a.cacheCreation, b.cacheCreation),
  };
}

/**
 * `message_delta` usage objektas, jei įvykis jį neša. Ta pati delta ateina DVIEM formomis:
 * savarankiška eilute ir SSE įvykiu `{"type":"stream_event","event":{…}}` — abi skaitomos
 * vienoje vietoje, kitaip nematoma forma padarytų mid-dispatch stabdiklį aklą (task 1222).
 */
function messageDeltaUsage(event: Record<string, unknown>): Record<string, unknown> | undefined {
  let carrier: Record<string, unknown> | undefined;
  if (event["type"] === "message_delta") {
    carrier = event;
  } else if (event["type"] === "stream_event") {
    const inner = event["event"];
    if (typeof inner === "object" && inner !== null && (inner as Record<string, unknown>)["type"] === "message_delta") {
      carrier = inner as Record<string, unknown>;
    }
  }
  if (carrier === undefined) return undefined;
  const usage = carrier["usage"];
  return typeof usage === "object" && usage !== null ? (usage as Record<string, unknown>) : undefined;
}

/**
 * Inkrementinis stream-json usage skaitiklis. Renka KELIS NEPRIKLAUSOMUS to paties dydžio
 * matavimus ir grąžina DIDŽIAUSIĄ, niekada jų nesudėdamas (kiekvienas apima visą sesiją):
 *  1. `assistant` su `message.id` — suma per unikalius id; per lauką `Math.max`, nes to
 *     paties id usage yra kumuliacinė TOS ŽINUTĖS atžvilgiu;
 *  2. `assistant` BE id (1222) — raktas yra pati eilutė: baitas į baitą ta pati eilutė yra
 *     TAS PATS įvykis, pristatytas antrą kartą (log tail po truncate skaito iš naujo);
 *     kryptis konservatyvi — dvi identiškos žinutės susilietų į vieną (įvertis iš apačios);
 *  3. `message_delta` — `Math.max` per visas deltas (kumuliacinės ir be žinutės rakto);
 *  4. `result` — visos sesijos santrauka.
 */
export function createStreamJsonUsageMeter(): StreamJsonUsageMeter {
  let partial = "";
  const perMessage = new Map<string, StreamUsageFields>();
  const idlessMessages = new Map<string, StreamUsageFields>();
  let messageDeltaFields: StreamUsageFields | undefined;
  let resultFields: StreamUsageFields | undefined;
  let resultSeen = false;

  const handleLine = (rawLine: string): void => {
    const line = rawLine.trim();
    // Launcher antraštės, `Write-Host` eilutės ir stderr nėra įvykiai.
    if (!line.startsWith("{")) return;

    let event: Record<string, unknown>;
    try {
      event = JSON.parse(line) as Record<string, unknown>;
    } catch {
      // dalinė ar persipynusi eilutė — tyliai praleidžiama
      return;
    }

    const type = event["type"];
    if (type === "assistant") {
      const message = event["message"];
      if (typeof message !== "object" || message === null) return;
      const fields = message as Record<string, unknown>;
      const id = typeof fields["id"] === "string" ? fields["id"].trim() : "";
      const usage = fields["usage"];
      if (typeof usage !== "object" || usage === null) return;
      const observed = streamUsageFields(usage as Record<string, unknown>);
      if (!id) {
        const current = idlessMessages.get(line);
        idlessMessages.set(line, current === undefined ? observed : streamUsageMax(current, observed));
        return;
      }
      const current = perMessage.get(id);
      perMessage.set(id, current === undefined ? observed : streamUsageMax(current, observed));
      return;
    }

    const deltaUsage = messageDeltaUsage(event);
    if (deltaUsage !== undefined) {
      const observed = streamUsageFields(deltaUsage);
      messageDeltaFields = messageDeltaFields === undefined ? observed : streamUsageMax(messageDeltaFields, observed);
      return;
    }

    if (type === "result") {
      resultSeen = true;
      const usage = event["usage"];
      if (typeof usage === "object" && usage !== null) {
        resultFields = streamUsageFields(usage as Record<string, unknown>);
      }
    }
  };

  const sumOf = (fields: Iterable<StreamUsageFields>): StreamUsageFields =>
    [...fields].reduce<StreamUsageFields>((acc, entry) => streamUsageAdd(acc, entry), {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheCreation: 0,
    });

  const totals = (): StreamUsageTotals => {
    // Didžiausias iš keturių nepriklausomų matavimų (žr. funkcijos komentarą).
    let candidate = sumOf(perMessage.values());
    for (const measurement of [
      idlessMessages.size > 0 ? sumOf(idlessMessages.values()) : undefined,
      messageDeltaFields,
      resultFields,
    ]) {
      if (measurement !== undefined && streamUsageSum(measurement) > streamUsageSum(candidate)) {
        candidate = measurement;
      }
    }
    const observedMessages = perMessage.size + idlessMessages.size;
    return {
      input_tokens: candidate.input,
      output_tokens: candidate.output,
      cache_read_input_tokens: candidate.cacheRead,
      cache_creation_input_tokens: candidate.cacheCreation,
      total_tokens: streamUsageSum(candidate),
      // Vienas šio skaičiaus bitas yra kontraktas: `usageFromStreamTotals` iš
      // `messages === 0` daro „NĖRA DUOMENŲ" — vien iš anoniminių deltų sudarytas srautas
      // privalo skaičiuotis bent viena žinute, kitaip stabdiklis jam liktų aklas.
      messages: observedMessages > 0 ? observedMessages : messageDeltaFields === undefined ? 0 : 1,
      result_seen: resultSeen,
    };
  };

  return {
    push(text: string): number {
      if (text) {
        partial += text;
        const lines = partial.split(/\r?\n/);
        // Paskutinis elementas yra (galimai) nebaigta eilutė — ji laukia kito gabalo.
        partial = lines.pop() ?? "";
        for (const line of lines) handleLine(line);
        // Eilutė be pabaigos, didesnė už bet kurį realų įvykį, yra sugadintas srautas.
        if (partial.length > MAX_STREAM_JSON_LINE_BYTES) partial = "";
      }
      return totals().total_tokens;
    },
    totals,
  };
}

/**
 * `ClaudeUsage` iš gyvo skaitiklio. Naudojama TIK kai `result` envelope neegzistuoja
 * (nutraukta sesija). `undefined`, kai skaitiklis nematė nė vienos žinutės.
 * `total_cost_usd` ir `num_turns` NEDEDAMI: kainos srautas neskelbia, o turn'us žino tik
 * `result` — išgalvota reikšmė sugadintų būtent tą telemetriją, dėl kurios laukai atsirado.
 */
export function usageFromStreamTotals(totals: StreamUsageTotals): ClaudeUsage | undefined {
  if (totals.messages === 0) return undefined;
  return {
    input_tokens: totals.input_tokens,
    output_tokens: totals.output_tokens,
    cache_read_input_tokens: totals.cache_read_input_tokens,
    cache_creation_input_tokens: totals.cache_creation_input_tokens,
  };
}

export function extractResultField(raw: string): string {
  const trimmed = raw.trim();
  try {
    const outer = JSON.parse(trimmed) as Record<string, unknown>;
    if (typeof outer["result"] === "string") {
      return outer["result"];
    }
  } catch {
    // ne JSON envelope; grąžinamas raw
  }
  return trimmed;
}

/**
 * Atpažįsta Claude CLI atsakymą apie pasiektą API/sesijos limitą (429). Infrastruktūros
 * sąlyga — kvietėjas privalo grąžinti infra exit kodą, kad task'as grįžtų į queue, o ne
 * degtų į human-review (etalono 2026-06-11 gaisras: 429 sudegino 26 taskus su exit 1).
 */
export function isUsageLimitOutput(stdout: string): boolean {
  const trimmed = stdout.trim();
  try {
    return isUsageLimitEnvelope(JSON.parse(trimmed) as Record<string, unknown>);
  } catch {
    return /"api_error_status"\s*:\s*429|session limit|usage limit|rate limit/i.test(trimmed);
  }
}

/**
 * Ta pati 429/limit klasifikacija jau išparsintam envelope. Dispatch kelias NEGALI
 * naudoti regex fallback'o ant viso stream log'o — task'o TURINYS gali minėti "rate
 * limit" (pvz. login rate limiting feature); čia regex taikomas tik klaidos `result` tekstui.
 */
export function isUsageLimitEnvelope(outer: Record<string, unknown>): boolean {
  if (outer["api_error_status"] === 429) return true;
  if (outer["is_error"] === false) return false;
  const result = typeof outer["result"] === "string" ? outer["result"] : "";
  return /session limit|usage limit|rate limit/i.test(result);
}
