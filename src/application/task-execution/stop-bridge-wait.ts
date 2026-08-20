// Stop-bridge laukimo ir zero-usage klasifikacijos GRYNOS taisyklės (etalonas:
// interfaces/cli/claude-dispatch/stop-bridge-wait.ts 1:1). Application sluoksnyje: visos
// funkcijos be IO (probe/sleep/now injektuojami), o usage forma deklaruojama STRUKTŪRIŠKAI
// (DispatchUsageView) — infrastruktūros ClaudeUsage ją tenkina, importo į adapterį nėra.

/** Struktūrinis dispatch usage vaizdas (ClaudeUsage poaibis; visi laukai optional). */
export type DispatchUsageView = {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
  total_cost_usd?: number;
  num_turns?: number;
};

export function isEmptyDispatchUsage(usage: DispatchUsageView | undefined): boolean {
  if (!usage) {
    return true;
  }
  const total =
    (usage.input_tokens ?? 0) +
    (usage.output_tokens ?? 0) +
    (usage.cache_read_input_tokens ?? 0) +
    (usage.cache_creation_input_tokens ?? 0);
  return total === 0;
}

/**
 * Etalono 1055 pamoka (false positive ~60%): zero-usage heuristika negali šaudyti, kai
 * stop bridge sako "done" — sesija REALIAI baigė darbą, o usage log'e nėra todėl, kad
 * launcher watchdog'as nužudė pakibusį pipeline'ą ANKSČIAU nei result envelope nutekėjo.
 * Tikras išsemtas limitas niekada nepasiekia Stop hook'o "done".
 */
export function isZeroUsageLimitSignal(
  exitCode: number,
  usage: DispatchUsageView | undefined,
  stopBridgeDone: boolean,
): boolean {
  return exitCode === 0 && isEmptyDispatchUsage(usage) && !stopBridgeDone;
}

/**
 * Kieno „done" guli globaliame stop-bridge faile? (task 0056) Iki jo bet kurios
 * lygiagrečios sesijos „done" nuginkluodavo zero-usage limito detekciją ir loop'as
 * degindavo queue (2026-07-22 gaisras). `"foreign-done"` — atskira reikšmė, ne `"none"`:
 * co-tenancy incidentas lieka matomas, o ne virsta tyliu skirtumu.
 */
export type StopBridgeDoneClassification = "own-done" | "foreign-done" | "none";

export function classifyStopBridgeDone(rawStopStatus: string, dispatchNonce: string): StopBridgeDoneClassification {
  let parsed: { status?: unknown; dispatch_nonce?: unknown };
  try {
    parsed = JSON.parse(rawStopStatus) as { status?: unknown; dispatch_nonce?: unknown };
  } catch {
    // Nėra/korumpuotas bridge — griežtoji šaka, elgiamės kaip anksčiau.
    return "none";
  }
  if (parsed.status !== "done") return "none";
  // Tuščias mūsų nonce reikštų, kad bet koks tuščią nonce turintis (interaktyvios sesijos)
  // „done" būtų priimtas kaip savas — todėl jis irgi svetimas.
  return dispatchNonce !== "" && parsed.dispatch_nonce === dispatchNonce ? "own-done" : "foreign-done";
}

// ---------------------------------------------------------------------------
// Task 1213/1218: dispatch'as laukia SAVO stop-bridge įrodymo — langas TIK vienam
// dviprasmiškam deriniui (exit 0, nulinė usage, done dar nematytas).
// ---------------------------------------------------------------------------

/**
 * Numatytas laukimo langas. Etalono incidentas: launcher grįžo 07:27, Stop hook'as „done"
 * parašė 07:31 (~240 s, nes „done" rašomas PO commitAndPush) — todėl default'as yra
 * išmatuota spraga + marža, o ne apvalus skaičius.
 */
export const STOP_BRIDGE_WAIT_MS = 300_000;

/** Kaip dažnai lange tikrinami stop-bridge šaltiniai. */
export const STOP_BRIDGE_WAIT_POLL_MS = 2_000;

/**
 * KIETA viršutinė lango riba (task 1218) — galioja VISIEMS šaltiniams: konfigūruojama
 * reikšmė be viršutinės ribos yra ne nustatymas, o galimybė užšaldyti loop'ą.
 */
export const MAX_STOP_BRIDGE_WAIT_MS = 600_000;

/** Kanoninis lango env raktas (task 1218). */
export const STOP_BRIDGE_WAIT_ENV = "AG_DISPATCH_STOP_WAIT_MS";

/** Ankstesnis to paties knob'o vardas (task 1213) — palaikomas sąmoningai. */
export const STOP_BRIDGE_WAIT_ENV_LEGACY = "AG_STOP_BRIDGE_WAIT_MS";

/**
 * Env/override semantika: `"0"` = eksplicitinis opt-out (langas išjungtas; kitaip nei
 * dispatch timeout, kur 0 pavojingas ir ignoruojamas). Neigiama/NaN/tuščia — klaida, ne
 * pasirinkimas → default'as. `override` (opts) aukštesnio prioriteto, bet clamp'inamas
 * tais pačiais vartais.
 */
export function stopBridgeWaitMs(env: NodeJS.ProcessEnv = process.env, override?: number): number {
  if (override !== undefined) {
    if (!Number.isFinite(override) || override <= 0) return override === 0 ? 0 : STOP_BRIDGE_WAIT_MS;
    return clampStopBridgeWaitMs(override);
  }
  const raw = env[STOP_BRIDGE_WAIT_ENV] ?? env[STOP_BRIDGE_WAIT_ENV_LEGACY];
  if (raw?.trim() === "0") return 0;
  const parsed = raw ? Number.parseInt(raw, 10) : Number.NaN;
  if (!Number.isFinite(parsed) || parsed <= 0) return STOP_BRIDGE_WAIT_MS;
  return clampStopBridgeWaitMs(parsed);
}

/** Apatinis kraštas — vienas poll (parašęs trumpesnį langą operatorius laukimo NORĖJO). */
function clampStopBridgeWaitMs(value: number): number {
  return Math.min(Math.max(value, STOP_BRIDGE_WAIT_POLL_MS), MAX_STOP_BRIDGE_WAIT_MS);
}

export type StopBridgeProbeResult = {
  classification: StopBridgeDoneClassification;
  /** Iš kurio šaltinio verdiktas — co-tenancy incidentas lieka matomas log'e. */
  source: "attempt" | "global" | "none";
};

export type StopBridgeProbe = () => Promise<StopBridgeProbeResult>;

/**
 * Dviejų stop-bridge šaltinių sujungimas — GRYNA prioritetų taisyklė. Nė vienas šaltinis
 * neveto'ina kito (nė vieno padengimas nepilnas: globalų failą rašo ir nonce nerašantis
 * on-stop-bridge kelias, o attempt namespace'o gali nebūti) — savas „done" iš BET KURIO
 * šaltinio laimi, svetimas tik pranešamas. `attemptRaw === undefined` = šaltinio nėra.
 */
export function mergeStopBridgeSources(
  attemptRaw: string | undefined,
  globalRaw: string,
  dispatchNonce: string,
): StopBridgeProbeResult {
  const attemptClass = attemptRaw === undefined ? "none" : classifyStopBridgeDone(attemptRaw, dispatchNonce);
  if (attemptClass === "own-done") return { classification: "own-done", source: "attempt" };
  const globalClass = classifyStopBridgeDone(globalRaw, dispatchNonce);
  if (globalClass === "own-done") return { classification: "own-done", source: "global" };
  if (attemptClass === "foreign-done") return { classification: "foreign-done", source: "attempt" };
  if (globalClass === "foreign-done") return { classification: "foreign-done", source: "global" };
  return { classification: "none", source: "none" };
}

export type StopBridgeWaitOutcome = StopBridgeProbeResult & { waitedMs: number; polls: number };

/**
 * Laukimo kilpa be IO ir be realaus laikrodžio (probe/sleep/now injektuojami).
 * `foreign-done` lipnus — vėlesnis `none` jo nenutrina. Task 1218: `timeoutMs`/`pollMs`
 * sanitarizuojami (NaN timeout darė kilpą begalinę), timeout clamp'inamas į kietą lubą,
 * o poll'ų skaičius turi atskirą stabdį — suveikia net kai `now()` nejuda.
 */
export async function waitForOwnStopBridgeDone(input: {
  probe: StopBridgeProbe;
  timeoutMs?: number;
  pollMs?: number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}): Promise<StopBridgeWaitOutcome> {
  const requestedTimeoutMs = input.timeoutMs ?? STOP_BRIDGE_WAIT_MS;
  const timeoutMs = Number.isFinite(requestedTimeoutMs)
    ? Math.min(Math.max(requestedTimeoutMs, 0), MAX_STOP_BRIDGE_WAIT_MS)
    : STOP_BRIDGE_WAIT_MS;
  const requestedPollMs = input.pollMs ?? STOP_BRIDGE_WAIT_POLL_MS;
  const pollMs = Number.isFinite(requestedPollMs) && requestedPollMs > 0 ? requestedPollMs : STOP_BRIDGE_WAIT_POLL_MS;
  // Vienas probe visada įvyksta (net išjungtame lange), tad „+1".
  const maxPolls = Math.ceil(timeoutMs / pollMs) + 1;
  const now = input.now ?? Date.now;
  const sleep = input.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));

  const started = now();
  let polls = 0;
  let last: StopBridgeProbeResult = { classification: "none", source: "none" };

  for (;;) {
    let observed: StopBridgeProbeResult;
    try {
      observed = await input.probe();
    } catch {
      // Probe gedimas negali nutraukti lango: „šįkart įrodymo nematau" ≠ „įrodymo nebus".
      observed = { classification: "none", source: "none" };
    }
    polls += 1;
    if (observed.classification === "own-done") {
      return { ...observed, waitedMs: now() - started, polls };
    }
    if (!(observed.classification === "none" && last.classification === "foreign-done")) {
      last = observed;
    }
    const elapsed = now() - started;
    // Dar vienas miegas peržengtų langą; `timeoutMs === 0` duoda lygiai vieną probe.
    if (elapsed + pollMs > timeoutMs || polls >= maxPolls) {
      return { ...last, waitedMs: elapsed, polls };
    }
    await sleep(pollMs);
  }
}

/**
 * Ar verta laukti? Sąlyga NEDUBLIUOJAMA: laukiama lygiai tada, kai galioja
 * `isZeroUsageLimitSignal`; usage-limit envelope arba jau matytas savas „done" langą
 * atmeta iškart. `foreign-done` laukti VERTA — svetimas įrodymas nieko nesako apie mus.
 */
export function shouldWaitForOwnStopBridge(input: {
  exitCode: number;
  usage: DispatchUsageView | undefined;
  usageLimitHit: boolean;
  observed: StopBridgeDoneClassification;
}): boolean {
  if (input.usageLimitHit) return false;
  if (input.observed === "own-done") return false;
  return isZeroUsageLimitSignal(input.exitCode, input.usage, false);
}
