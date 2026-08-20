// Mid-dispatch token biudžeto watchdog'as (etalonas: interfaces/cli/claude-dispatch/
// mid-dispatch-budget.ts 1:1; task 1203/1215/1222). Infrastructure: gyvas stream-json
// skaitiklis (claude-usage meter) + Windows šakos log failo tailinimas per node:fs.
// GRYNA sprendimo dalis (createMidDispatchBudgetWatchdog) — tekstas → verdiktas; žudymą
// abiem platformoms daro kvietėjo abort signalas.

import { open, stat, type FileHandle } from "node:fs/promises";
import { StringDecoder } from "node:string_decoder";
import { taskUsageTotalsFromEntry } from "../../domain/tokens/usage-ledger.js";
import type { MidDispatchLimitSource } from "../../application/token-governance/token-budget-config.js";
import { createStreamJsonUsageMeter, usageFromStreamTotals, type StreamUsageTotals } from "./claude-usage.js";

export const MID_DISPATCH_USAGE_POLL_MS = 5_000;

/** Priežastis, kurią nutrauktas procesas palieka `stderr` — kaip timeout'o žinutė. */
export const MID_DISPATCH_BUDGET_ABORT_REASON = "mid-dispatch token budget exceeded";

export type MidDispatchBudgetVerdict = {
  reason: "budget-exceeded-mid-dispatch";
  /** Riba peržengusi bazė (task 1215): input + output + cache_creation, BE cache_read. */
  billableTokens: number;
  /** Ta pati akimirka raw baze (su cache_read) — cache apyvartos diagnostikai. */
  rawTokens: number;
  limit: number;
  limitSource: MidDispatchLimitSource;
};

export type MidDispatchBudgetWatchdog = {
  /** Srauto tekstas iš bet kurios šakos. Verdiktą grąžina TIK pirmą kartą peržengus ribą. */
  observe(text: string): MidDispatchBudgetVerdict | undefined;
  hit(): MidDispatchBudgetVerdict | undefined;
  totals(): StreamUsageTotals;
  /**
   * Ar per VISĄ sesiją bent kartą matyta billable suma > 0 (task 1222). Ne tas pats, kas
   * `billable > 0` iš galutinio snapshot'o: `totals()` renkasi didžiausią RAW matavimą,
   * tad vėlyvas cache-sunkus `result` envelope gali billable nuleisti atgal į nulį.
   */
  billableSeen(): boolean;
};

/**
 * Billable suma iš srauto snapshot'o (task 1215). Formulė NEKOPIJUOJAMA:
 * `usageFromStreamTotals` → ClaudeUsage, o `taskUsageTotalsFromEntry` (domain/tokens) yra
 * vienintelė `input + output + cache_creation` vieta. `messages === 0` → undefined →
 * billable 0 ir NIEKO nenutraukia („nėra duomenų ≠ nulis").
 */
export function billableTokensOfStream(totals: StreamUsageTotals): number {
  const usage = usageFromStreamTotals(totals);
  return usage === undefined ? 0 : taskUsageTotalsFromEntry(usage).billable_tokens;
}

export function createMidDispatchBudgetWatchdog(input: {
  limit: number;
  limitSource: MidDispatchLimitSource;
  /** Paprastai `() => controller.abort()`. Kviečiama LYGIAI vieną kartą. */
  onExceeded: () => void;
}): MidDispatchBudgetWatchdog {
  const meter = createStreamJsonUsageMeter();
  let verdict: MidDispatchBudgetVerdict | undefined;
  let billableSeen = false;

  return {
    observe(text: string): MidDispatchBudgetVerdict | undefined {
      // Skaitiklis maitinamas ir po verdikto: nutraukimas nėra momentinis, o `totals()`
      // yra vienintelis sudegintų tokenų įrodymas ledger'iui.
      meter.push(text);
      if (verdict !== undefined) return undefined;
      // VIENAS snapshot'as abiem skaičiams; billable tarp snapshot'ų NĖRA monotoniškas,
      // bet verdikto latch'as tai daro nekenksminga — sprendimas priimamas vieną kartą.
      const snapshot = meter.totals();
      const billable = billableTokensOfStream(snapshot);
      if (billable > 0) billableSeen = true;
      if (billable <= input.limit) return undefined;
      verdict = {
        reason: "budget-exceeded-mid-dispatch",
        billableTokens: billable,
        rawTokens: snapshot.total_tokens,
        limit: input.limit,
        limitSource: input.limitSource,
      };
      input.onExceeded();
      return verdict;
    },
    hit: () => verdict,
    totals: () => meter.totals(),
    billableSeen: () => billableSeen,
  };
}

/**
 * Task 1222: diagnostinė eilutė sesijai, kurioje mid-dispatch stabdiklis buvo AKLAS —
 * skaitiklis per visą sesiją negavo nė vieno billable tokeno, nors sesija realiai dirbo
 * (proxy: praėjo daugiau nei PUSĖ leisto lango). Gryna; baigtis nuo šito NIEKADA
 * nepriklauso — tik diagnostika. `undefined` = loginti nėra ko.
 */
export function billableMeterBlindNotice(input: {
  taskId: string;
  billableSeen: boolean;
  elapsedMs: number;
  timeoutMs: number;
  totals: StreamUsageTotals;
}): string | undefined {
  if (input.billableSeen) return undefined;
  // `> timeoutMs / 2` be dalybos: sveikų skaičių aritmetika.
  if (!(input.elapsedMs * 2 > input.timeoutMs)) return undefined;
  return (
    `DISPATCH BILLABLE METER BLIND: task=${input.taskId} elapsed_ms=${input.elapsedMs} ` +
    `timeout_ms=${input.timeoutMs} raw=${input.totals.total_tokens} messages=${input.totals.messages} ` +
    `result_seen=${input.totals.result_seen} — ` +
    `meter negavo billable usage, mid-dispatch stabdiklis šioje sesijoje buvo aklas`
  );
}

export type StreamLogTailer = { stop(): Promise<void> };

/**
 * Gyvo log failo tailinimas: kas `intervalMs` nuskaitoma TIK nauja dalis. `setTimeout`
 * rekursija (lėtas skaitymas nepersikloja), timer'is `unref`'inamas, dekodavimas per
 * `StringDecoder` (baitų riba gali perkirsti daugiabaitį simbolį). ENOENT/trumpas lock —
 * praleidžiamas tikas, ne gedimas: stebėtojas niekada nenutraukia dispatch'o.
 */
export function startStreamLogTail(input: {
  path: string;
  intervalMs: number;
  onText: (text: string) => void;
}): StreamLogTailer {
  const decoder = new StringDecoder("utf8");
  let offset = 0;
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let inFlight: Promise<void> = Promise.resolve();

  const readDelta = async (): Promise<void> => {
    let size: number;
    try {
      size = (await stat(input.path)).size;
    } catch {
      return;
    }
    // Launcher'io truncate: failas sutrumpėjo, tad senas offset'as nebegalioja.
    if (size < offset) offset = 0;
    if (size <= offset) return;

    let handle: FileHandle | undefined;
    try {
      handle = await open(input.path, "r");
      const length = size - offset;
      const buffer = Buffer.allocUnsafe(length);
      const { bytesRead } = await handle.read(buffer, 0, length, offset);
      // Skaitymai serializuoti: `schedule` planuoja kitą `readDelta` tik po ankstesnio
      // pabaigos, o `stop()` prieš paskutinį skaitymą laukia `inFlight`.
      offset += bytesRead;
      if (bytesRead > 0) input.onText(decoder.write(buffer.subarray(0, bytesRead)));
    } catch {
      // kitas tikas pabandys iš naujo nuo to paties offset'o
    } finally {
      try {
        await handle?.close();
      } catch {
        // ignore close errors
      }
    }
  };

  const schedule = (): void => {
    if (stopped) return;
    timer = setTimeout(() => {
      inFlight = readDelta().then(schedule, schedule);
    }, input.intervalMs);
    timer.unref?.();
  };
  schedule();

  return {
    async stop(): Promise<void> {
      stopped = true;
      clearTimeout(timer);
      await inFlight;
      // Paskutinis skaitymas: sesijos pabaigoje įrašytos eilutės kitaip liktų nematytos.
      await readDelta();
    },
  };
}
