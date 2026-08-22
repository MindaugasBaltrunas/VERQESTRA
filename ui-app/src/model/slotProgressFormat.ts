/**
 * Grynas formatavimas srautų kortelėms. Čia NĖRA `t()`: vertimas priklauso komponentui, o šis
 * modulis grąžina tik skaičių formą (`4m`, `4–7m`, `82 %`). Taip tą pačią funkciją gali kviesti ir
 * testas, ir kelios panelės, negaudamos kalbos konteksto.
 */

const MINUTE_MS = 60_000;
const HOUR_MS = 3_600_000;

/** Kompaktiškas amžius — toks pat stilius kaip `WavesPanel`: operatoriui svarbu „prieš kiek". */
export function formatAge(ms: number | null): string {
  if (ms === null || !Number.isFinite(ms) || ms < 0) return "—";
  if (ms < MINUTE_MS) return `${Math.floor(ms / 1000)}s`;
  if (ms < HOUR_MS) return `${Math.floor(ms / MINUTE_MS)}m`;
  return `${Math.floor(ms / HOUR_MS)}h`;
}

/**
 * Vykdymo trukmė. Skiriasi nuo `formatAge`: čia rodoma ir smulkesnė dalis, nes „4m" ir „4m 55s"
 * vykdomam bandymui yra skirtinga informacija.
 */
export function formatElapsed(ms: number | null): string {
  if (ms === null || !Number.isFinite(ms) || ms < 0) return "—";
  if (ms < MINUTE_MS) return `${Math.floor(ms / 1000)}s`;
  if (ms < HOUR_MS) {
    const minutes = Math.floor(ms / MINUTE_MS);
    const seconds = Math.floor((ms % MINUTE_MS) / 1000);
    return seconds === 0 ? `${minutes}m` : `${minutes}m ${seconds}s`;
  }
  const hours = Math.floor(ms / HOUR_MS);
  const minutes = Math.floor((ms % HOUR_MS) / MINUTE_MS);
  return minutes === 0 ? `${hours}h` : `${hours}h ${minutes}m`;
}

/**
 * ETA rėžis. Vienetą diktuoja DIDESNIS galas, kad abu skaičiai būtų tame pačiame mastelyje, o
 * sutapus suapvalintiems galams rodoma viena reikšmė — „4–4m" nieko nepasako.
 */
export function formatEtaRange(lowMs: number, highMs: number): string {
  if (!Number.isFinite(lowMs) || !Number.isFinite(highMs) || lowMs < 0 || highMs < 0) return "—";
  const low = Math.min(lowMs, highMs);
  const high = Math.max(lowMs, highMs);
  const [unit, divisor] = high < MINUTE_MS ? ["s", 1000] as const : high < HOUR_MS ? ["m", MINUTE_MS] as const : ["h", HOUR_MS] as const;
  const lowValue = Math.round(low / divisor);
  const highValue = Math.round(high / divisor);
  return lowValue === highValue ? `${highValue}${unit}` : `${lowValue}–${highValue}${unit}`;
}

export function formatPercentLabel(percent: number): string {
  if (!Number.isFinite(percent)) return "—";
  return `${Math.round(percent)}%`;
}
