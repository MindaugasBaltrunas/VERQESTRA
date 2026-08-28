// UI modelis: vieno slot'o (worker lease) būsena bangoje — gryna projekcija, be jokių importų.
//
// Modulis sąmoningai neturi NĖ VIENO importo (nei `node:*`, nei application, nei domain): slot'o
// būsena išvedama tik iš to, kas jau perskaityta (lease'ai, bangos įvykių uodega, orkestratoriaus
// log'o nesėkmių eilutės) ir iš `now`. Laisvo teksto valymas ATEINA per `sanitize` parametrą, tad
// redakcijos taisyklių savininkas lieka HTTP sluoksnis, o šis failas nuo jo nepriklauso.
//
// Ką modulis SPRENDŽIA: kaip trys nepriklausomi šaltiniai suklijuojami į vieną eilutę operatoriui.
// Ko NESPRENDŽIA: ar slot'as turėjo būti išduotas ir ar lease'as galioja vykdymui — tai
// `application/scheduling` reikalas, o čia guli tik jo rezultatų atvaizdas.
//
// Apribojimas: nesėkmės eilutė log'e yra VIENA fizinė eilutė. Jei `error=` tekstas buvo
// daugiaeilis, projekcijoje matoma tik pirmoji jo eilutė — likusios log'e atsiduria kaip atskiros
// eilutės be prefikso ir čia praleidžiamos.

export type UiWaveSlotState = "provisioned" | "running" | "failed" | "released";

/**
 * Smulkesnis vykdymo etapas TO PATIES `state` viduje — operatoriui, kuris grep'ina, kiek toli
 * nuėjo antras slot'as, be `running` neužtenka.
 *
 * `bootstrap` — lease paimtas, jokio vykdymo įrodymo dar nėra (atitinka `state: "provisioned"`).
 * `delegated` — vykdymo įrodymas yra (`task_started`/`worker_slot_refilled`), bet integracijos
 * įrodymo (`task_integration_ready`) dar nėra. Etapas PREFLIGHT čia sąmoningai NEIŠSKIRIAMAS iš
 * `delegated`: preflight verdiktas gyvena run-coordinator'iaus resume checkpoint'e, kuris nėra
 * šio modulio leidžiamas šaltinis (tik lease'ai + wave-events) — jo įtraukimas reikštų naują
 * skaitymo kelią, o ne esamų šaltinių projekciją.
 * `integracija` — `task_integration_ready` įrodymas yra.
 * `failed` / `released` — tas pats kaip `state`.
 */
export type UiWaveSlotPhase = "bootstrap" | "delegated" | "integracija" | "failed" | "released";

export type UiWaveSlotFailure = {
  /** Log eilutės laikas, normalizuotas į ISO Z. */
  ts: string;
  task_id: string;
  /** `error=` reikšmė PO sanitize, apkarpyta iki {@link SLOT_FAILURE_REASON_MAX_CHARS}. */
  reason: string;
};

export type UiWaveSlotFailureEntry = UiWaveSlotFailure & { worker_id: string };

export type UiWaveSlot = {
  worker_id: string;
  task_id: string;
  state: UiWaveSlotState;
  /** Smulkesnis etapas — žr. {@link UiWaveSlotPhase}. */
  phase: UiWaveSlotPhase;
  lease_status: string;
  acquired_at: string;
  heartbeat_at: string;
  expires_at: string;
  lease_age_ms: number | null;
  heartbeat_age_ms: number | null;
  /** Lease'as vis dar `held`, bet galiojimas jau pasibaigęs (arba `expires_at` neperskaitomas). */
  stale: boolean;
  has_worktree: boolean;
  /**
   * Projekto-reliatyvus worktree kelias arba `null` (be worktree, arba kelias veda už projekto
   * ribų — absoliutus kelias į naršyklę niekada neišeina, žr. `WaveSlotLease.worktree_path`).
   */
  worktree_path: string | null;
  last_failure: UiWaveSlotFailure | null;
  /** Paskutinis ŠIOS lease'o kartos wave-events įrašas šiam task'ui — „kuo baigėsi" be grep'o. */
  last_event: WaveSlotEvent | null;
};

/** Lease'o projekcija, iš kurios statomas slot'as. Turtingesnė už wire `leases` įrašą. */
export type WaveSlotLease = {
  worker_id: string;
  task_id: string;
  status: string;
  acquired_at: string;
  heartbeat_at: string;
  expires_at: string;
  has_worktree: boolean;
  /** Jau normalizuotas projekto-reliatyviu keliu (arba `null`) PRIEŠ patenkant į šį modelį. */
  worktree_path: string | null;
};

/** Tiek bangos įvykio, kiek reikia vykdymo įrodymui. */
export type WaveSlotEvent = { ts: string; event: string; task_id?: string | undefined };

export type BuildWaveSlotsInput = {
  leases: readonly WaveSlotLease[];
  events: readonly WaveSlotEvent[];
  failures: readonly UiWaveSlotFailureEntry[];
  /** `false`, kai įvykių šaltinis neperskaitytas: „įrodymų nėra" tada nereiškia „nieko nevyko". */
  events_available: boolean;
  now: Date;
};

export const SLOT_FAILURE_PREFIX = "WAVE SLOT FAILED:";
export const SLOT_FAILURE_REASON_MAX_CHARS = 300;

/** Įvykiai, kurie ĮRODO, kad slot'as jau realiai vykdo (ne tik turi lease'ą). */
export const SLOT_EXECUTION_EVENTS: readonly string[] = [
  "task_started",
  "worker_slot_refilled",
  "task_integration_ready",
];

/** Log eilutė: `[YYYY-MM-DD HH:MM:SS] WAVE SLOT FAILED: slot=<w> task=<t> error=<laisvas tekstas>`. */
const failureLinePattern = /^\[([^\]]+)\]\s*WAVE SLOT FAILED: slot=(\S+) task=(\S+) error=([\s\S]*)$/;

/** Identifikatorių vartai: į UI patenka tik tai, kas atrodo kaip worker/task ID, ne laisvas tekstas. */
const identifierPattern = /^[A-Za-z0-9._-]{1,80}$/;

/**
 * Log antspaudas yra UTC BE `Z`, o `Date.parse("2026-08-13 10:00:00")` tokį tekstą traktuoja kaip
 * LOKALŲ laiką — todėl laikas perrenkamas į `YYYY-MM-DDTHH:MM:SSZ`, o ne paduodamas tiesiai.
 */
function parseLogStamp(stamp: string): Date | undefined {
  const match = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2}(?:\.\d+)?)Z?$/.exec(stamp.trim());
  if (!match) return undefined;
  const parsed = new Date(`${match[1]}T${match[2]}Z`);
  return Number.isNaN(parsed.getTime()) ? undefined : parsed;
}

/**
 * Viena log eilutė → slot'o nesėkmė. Netinkanti eilutė grąžina `undefined`, o ne meta: log'as yra
 * laisvo formato srautas, ir viena keista eilutė neturi nuversti vaizdo.
 */
export function parseSlotFailureLine(
  line: string,
  sanitize: (text: string) => string,
): UiWaveSlotFailureEntry | undefined {
  if (!line.includes(SLOT_FAILURE_PREFIX)) return undefined;

  const match = failureLinePattern.exec(line);
  if (!match) return undefined;

  const [, stamp, workerId, taskId, rawError] = match;
  const at = stamp === undefined ? undefined : parseLogStamp(stamp);
  if (!at || workerId === undefined || taskId === undefined) return undefined;
  if (!identifierPattern.test(workerId) || !identifierPattern.test(taskId)) return undefined;

  return {
    worker_id: workerId,
    task_id: taskId,
    ts: at.toISOString(),
    // Tuščias `reason` po valymo VIS TIEK yra nesėkmė — nutylėti ją būtų blogiau nei parodyti be
    // teksto.
    reason: sanitize(rawError ?? "")
      .trim()
      .slice(0, SLOT_FAILURE_REASON_MAX_CHARS),
  };
}

/**
 * Log antspaudas yra sekundės tikslumo, o `acquired_at` — milisekundžių. Be šio nuapvalinimo
 * nesėkmė, įvykusi TĄ PAČIĄ sekundę kaip lease'o paėmimas, atrodytų senesnė už jį ir dingtų.
 */
function floorSecond(iso: string): number {
  const parsed = Date.parse(iso);
  return Number.isNaN(parsed) ? Number.NaN : Math.floor(parsed / 1000) * 1000;
}

function ageMs(iso: string, now: Date): number | null {
  const parsed = Date.parse(iso);
  return Number.isNaN(parsed) ? null : Math.max(0, now.getTime() - parsed);
}

/**
 * Vienas slot'as vienam lease'ui, įvesties tvarka: `slots[i].worker_id === leases[i].worker_id`.
 * Jokio filtravimo ir jokio rikiavimo — rodymo tvarka yra vaizdo, o ne modelio reikalas.
 */
export function buildWaveSlots(input: BuildWaveSlotsInput): UiWaveSlot[] {
  const nowMs = input.now.getTime();

  return input.leases.map((lease) => {
    const since = floorSecond(lease.acquired_at);
    // Neperskaitomas laikas (nei įvykio, nei lease'o) niekada nėra įrodymas: `NaN >= x` yra `false`.
    const withinGeneration = (ts: string): boolean => Date.parse(ts) >= since;

    // Paskutinė ŠIOS lease'o kartos nesėkmė log tvarka: senesnės kartos įrašai lieka log'e dienomis.
    let lastFailure: UiWaveSlotFailure | null = null;
    for (const failure of input.failures) {
      if (failure.worker_id !== lease.worker_id) continue;
      if (failure.task_id !== lease.task_id) continue;
      if (!withinGeneration(failure.ts)) continue;
      lastFailure = { ts: failure.ts, task_id: failure.task_id, reason: failure.reason };
    }

    const hasExecutionEvidence = input.events.some(
      (event) =>
        SLOT_EXECUTION_EVENTS.includes(event.event) &&
        event.task_id === lease.task_id &&
        withinGeneration(event.ts),
    );

    const hasIntegrationEvidence = input.events.some(
      (event) => event.event === "task_integration_ready" && event.task_id === lease.task_id && withinGeneration(event.ts),
    );

    // Paskutinis ŠIOS lease'o kartos wave-events įrašas šiam task'ui, log tvarka.
    let lastEvent: WaveSlotEvent | null = null;
    for (const event of input.events) {
      if (event.task_id !== lease.task_id) continue;
      if (!withinGeneration(event.ts)) continue;
      lastEvent = event;
    }

    // Precedencija: nesėkmė nugali `released` (slot'as, kuris krito ir buvo atlaisvintas, VIS TIEK
    // yra kritęs), o neperskaitomas įvykių šaltinis neturi versti `provisioned` melo.
    const state: UiWaveSlotState = lastFailure
      ? "failed"
      : lease.status !== "held"
        ? "released"
        : hasExecutionEvidence || !input.events_available
          ? "running"
          : "provisioned";

    const phase: UiWaveSlotPhase = lastFailure
      ? "failed"
      : lease.status !== "held"
        ? "released"
        : hasIntegrationEvidence
          ? "integracija"
          : hasExecutionEvidence || !input.events_available
            ? "delegated"
            : "bootstrap";

    const expiresAt = Date.parse(lease.expires_at);
    const stale = lease.status === "held" && (Number.isNaN(expiresAt) || nowMs >= expiresAt);

    return {
      worker_id: lease.worker_id,
      task_id: lease.task_id,
      state,
      phase,
      lease_status: lease.status,
      acquired_at: lease.acquired_at,
      heartbeat_at: lease.heartbeat_at,
      expires_at: lease.expires_at,
      lease_age_ms: ageMs(lease.acquired_at, input.now),
      heartbeat_age_ms: ageMs(lease.heartbeat_at, input.now),
      stale,
      has_worktree: lease.has_worktree,
      worktree_path: lease.worktree_path,
      last_failure: lastFailure,
      last_event: lastEvent,
    };
  });
}
