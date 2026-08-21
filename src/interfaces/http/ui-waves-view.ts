// READ-ONLY bangų vaizdas dashboard'ui (etalonas: AG_loop interfaces/http/ui-waves-view.ts).
//
// Keturi šaltiniai, kurių neskaito nė vienas kitas endpoint'as, todėl atsakymas „kodėl banga vėl
// nuosekli" kitaip gyvena tik logų faile:
//
//   `vq/logs/wave-events.jsonl`      — bangų perėjimų istorija (uodega);
//   worker lease'ai                  — kas ŠIUO METU laiko vykdymo nuosavybę;
//   `vq/state/wave-snapshot.json`    — kodėl kandidatai į antrą slot'ą buvo atmesti ir ką
//                                      nusprendė kiekvienas papildymo (refill) epizodas;
//   `vq/logs/orchestrator.log`       — `WAVE SLOT FAILED` eilutės: tik jose gyvena atsakymas
//                                      „kodėl slot'as nutilo".
//
// Trys taisyklės, kurios yra šio modulio kontraktas:
//
//   1. TIK PROJEKCIJA. Jokios bangų, lease'ų ar izoliacijos TAISYKLĖS čia nevertinamos —
//      sprendimus priima application/scheduling, o čia guli tik jų rezultatų atvaizdas.
//   2. NIEKO, KAS NETURI IŠEITI už loopback ribų. Laisvas tekstas eina per `sanitizeFreeText`,
//      lease'o worktree kelias virsta `has_worktree` vėliava, o savininko id (jame yra PID) į
//      projekciją nepatenka iš viso.
//   3. VIENO ŠALTINIO LŪŽIS NENUVERČIA VAIZDO, BET IR NENUTYLA. Diagnostikos vaizdas, mirštantis
//      dėl sugadinto telemetrijos failo, yra bevertis būtent tada, kai labiausiai reikalingas —
//      tad kiekvienas šaltinis gniūžta atskirai, o jo vardas atsiduria `degraded` sąraše.

import path from "node:path";
import {
  SLOT_FAILURE_PREFIX,
  buildWaveSlots,
  parseSlotFailureLine,
  type UiWaveSlot,
  type UiWaveSlotFailureEntry,
  type WaveSlotLease,
} from "../ui-model/wave-slot-model.js";
import { sanitizeFreeText } from "./free-text-redaction.js";

export type UiWaveEvent = {
  ts: string;
  event: string;
  task_id?: string | undefined;
  reason?: string | undefined;
};

export type UiWaveLease = {
  worker_id: string;
  task_id: string;
  status: string;
  expires_at: string;
  /** Ar lease valdo izoliuotą darbo kopiją. Pats kelias sąmoningai neatskleidžiamas. */
  has_worktree: boolean;
};

export type UiWaveRejection = {
  task_id: string;
  reason: string;
  detail: string;
};

export type UiWaveRefillDecision = {
  episode: number;
  worker_id: string;
  task_id: string;
  granted: boolean;
  reason: string;
  hard_capped: boolean;
  decided_at: string;
  rejected: UiWaveRejection[];
};

export type UiWavesView = {
  events: UiWaveEvent[];
  leases: UiWaveLease[];
  slots: UiWaveSlot[];
  last_rejections: UiWaveRejection[];
  refill_decisions: UiWaveRefillDecision[];
  /** Šaltiniai, kurių nepavyko perskaityti. Tuščias sąrašas reiškia „viskas perskaityta". */
  degraded: string[];
};

export type { UiWaveSlot, UiWaveSlotFailure, UiWaveSlotState } from "../ui-model/wave-slot-model.js";

export const DEFAULT_WAVE_EVENT_LIMIT = 50;
export const MAX_WAVE_EVENT_LIMIT = 500;

const REJECTION_LIMIT = 20;
const REFILL_DECISION_LIMIT = 20;
const EVENT_TAIL_BYTES = 256 * 1024;
const ORCHESTRATOR_LOG_TAIL_BYTES = 128 * 1024;

/** Šaltinis diske yra, bet jo turinys netinkamas. Skiriasi nuo „šaltinio nėra". */
export class UnusableSourceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnusableSourceError";
  }
}

/** Tiek lease'o, kiek reikia vaizdui; savininko id ir worktree kelias čia nepatenka. */
export type WavesViewLease = {
  worker_id: string;
  task_id: string;
  status: string;
  acquired_at: string;
  heartbeat_at: string;
  expires_at: string;
  worktree_path?: string | undefined;
};

/** Bangos snapshot'o pjūvis, kurio reikia vaizdui — struktūrinis, be loop sluoksnio importo. */
export type WavesViewSnapshot = {
  worker_pool?: { rejected?: readonly UiWaveRejection[] | undefined } | undefined;
  refill?:
    | {
        decisions?:
          | readonly {
              episode: number;
              worker_id: string;
              task_id: string;
              granted: boolean;
              reason: string;
              hard_capped: boolean;
              decided_at: string;
              rejected: readonly UiWaveRejection[];
            }[]
          | undefined;
      }
    | undefined;
};

export type WavesViewPorts = {
  /**
   * Failo uodega eilutėmis: paskutiniai `maxBytes`, pirmoji (galimai nukirsta) eilutė atmesta.
   * Nesamas failas — tuščias sąrašas; netinkamas šaltinis (pvz. katalogas) — MESTA klaida, kad
   * „nėra duomenų" ir „neperskaitoma" nesusilietų.
   */
  readTailLines(absoluteFile: string, maxBytes: number): Promise<string[]>;
  listWorkerLeases(projectRoot: string): Promise<readonly WavesViewLease[]>;
  /** Snapshot'as arba `undefined`; sugadintas failas irgi `undefined` (loop'ui tai „plano nėra"). */
  readWaveSnapshot(stateDir: string): Promise<WavesViewSnapshot | undefined>;
  /** Ar snapshot failas egzistuoja — skiria „atmetimų nėra" nuo „snapshot'as neperskaitomas". */
  waveSnapshotExists(stateDir: string): Promise<boolean>;
  /** Naudotojo namų katalogas — viena iš redaguojamų šaknų. */
  homeDir(): string;
  now?: () => Date;
  /** Degradavusio šaltinio pranešimas; be jo gedimas lieka tik `degraded` sąraše. */
  logError?(message: string): void;
};

export type BuildWavesViewInput = {
  ports: WavesViewPorts;
  /** Repozitorijos šaknis. */
  projectRoot: string;
  /** vq runtime šaknis (`<root>/vq`). */
  runtimeRoot?: string;
  eventLimit?: number;
};

/** `?limit=` reikšmė. Netinkama arba nenurodyta krenta į numatytąją; ribas taiko vaizdas. */
export function normalizeEventLimit(raw: string | null): number {
  const parsed = Number.parseInt(raw ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_WAVE_EVENT_LIMIT;
}

/** Viena įvykių eilutė → projekcija. Sugadinta eilutė praleidžiama, o ne meta. */
export function projectWaveEvent(line: string, sanitize: (text: string) => string): UiWaveEvent | undefined {
  let payload: unknown;
  try {
    payload = JSON.parse(line);
  } catch {
    return undefined;
  }
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) return undefined;

  const record = payload as Record<string, unknown>;
  const event = typeof record["event"] === "string" ? record["event"] : "";
  if (!event) return undefined;
  const taskId = record["task_id"];
  const reason = record["reason"];

  return {
    ts: typeof record["ts"] === "string" ? record["ts"] : "",
    event,
    ...(typeof taskId === "string" && taskId ? { task_id: taskId } : {}),
    ...(typeof reason === "string" && reason ? { reason: sanitize(reason) } : {}),
  };
}

/** Wire `leases` įrašas: penki raktai. Worktree kelias čia nepatenka niekada. */
function toWireLease(lease: WaveSlotLease): UiWaveLease {
  return {
    worker_id: lease.worker_id,
    task_id: lease.task_id,
    status: lease.status,
    expires_at: lease.expires_at,
    has_worktree: lease.has_worktree,
  };
}

function projectRejection(entry: UiWaveRejection, sanitize: (text: string) => string): UiWaveRejection {
  return {
    task_id: entry.task_id,
    reason: sanitize(entry.reason),
    detail: sanitize(entry.detail),
  };
}

type SnapshotProjection = { last_rejections: UiWaveRejection[]; refill_decisions: UiWaveRefillDecision[] };

/**
 * Snapshot'o projekcija: atmetimų sąrašas IR papildymo sprendimai iš TO PATIES vieno skaitymo —
 * antras skaitymas duotų dvi skirtingas to paties failo versijas ir vaizdą, kuriame sąrašai
 * nesutampa.
 *
 * Duplikacija sąmoninga: sulietas `last_rejections` atsako „kas buvo atmesta", o `refill_decisions`
 * — „ką nusprendė kiekvienas epizodas", įskaitant tuos, kurie nieko neatmetė. Sulieti juos į vieną
 * lauką reikštų pasirinkti vieną iš dviejų klausimų.
 */
async function readSnapshot(
  ports: WavesViewPorts,
  stateDir: string,
  sanitize: (text: string) => string,
): Promise<SnapshotProjection> {
  const snapshot = await ports.readWaveSnapshot(stateDir);
  if (!snapshot) {
    // Skaitytojas sugadintą snapshot'ą paverčia `undefined`, tad failo buvimas tikrinamas
    // atskirai — kitaip „atmetimų nėra" ir „neperskaitomas" atrodytų vienodai.
    if (await ports.waveSnapshotExists(stateDir)) {
      throw new UnusableSourceError("wave snapshot is unreadable");
    }
    return { last_rejections: [], refill_decisions: [] };
  }

  const decisions = snapshot.refill?.decisions ?? [];
  const refillDecisions: UiWaveRefillDecision[] = decisions
    .map((decision) => ({
      episode: decision.episode,
      worker_id: decision.worker_id,
      task_id: decision.task_id,
      granted: decision.granted,
      reason: sanitize(decision.reason),
      hard_capped: decision.hard_capped,
      decided_at: decision.decided_at,
      rejected: decision.rejected.map((entry) => projectRejection(entry, sanitize)),
    }))
    .slice(-REFILL_DECISION_LIMIT);

  const collected: UiWaveRejection[] = [
    ...(snapshot.worker_pool?.rejected ?? []).map((entry) => projectRejection(entry, sanitize)),
    ...decisions.flatMap((decision) => decision.rejected.map((entry) => projectRejection(entry, sanitize))),
  ];

  const seen = new Set<string>();
  const unique = collected.filter((entry) => {
    const key = `${entry.task_id} ${entry.reason} ${entry.detail}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  return { last_rejections: unique.slice(-REJECTION_LIMIT), refill_decisions: refillDecisions };
}

/** Vieno šaltinio skaitymas: nesėkmė virsta fallback reikšme ir įrašu `degraded` sąraše. */
async function readSource<T>(
  ports: WavesViewPorts,
  name: string,
  fallback: T,
  read: () => Promise<T>,
  degraded: string[],
): Promise<T> {
  try {
    return await read();
  } catch (error: unknown) {
    ports.logError?.(`[ui] waves view source '${name}' failed: ${error instanceof Error ? error.message : String(error)}`);
    degraded.push(name);
    return fallback;
  }
}

export async function buildWavesView(input: BuildWavesViewInput): Promise<UiWavesView> {
  const ports = input.ports;
  const limit = Math.min(Math.max(input.eventLimit ?? DEFAULT_WAVE_EVENT_LIMIT, 1), MAX_WAVE_EVENT_LIMIT);
  const root = path.resolve(input.projectRoot);
  const runtimeRoot = input.runtimeRoot ?? path.join(root, "vq");
  const stateDir = path.join(runtimeRoot, "state");
  const logsDir = path.join(runtimeRoot, "logs");
  const roots = [root, ports.homeDir()];
  const sanitize = (text: string): string => sanitizeFreeText(text, roots);
  const now = ports.now?.() ?? new Date();
  const degraded: string[] = [];

  const [eventTail, leases, snapshot, failures] = await Promise.all([
    readSource(ports, "events", [] as UiWaveEvent[], () => readWaveEventTail(ports, logsDir, sanitize), degraded),
    readSource(ports, "leases", [] as WaveSlotLease[], () => readLeases(ports, root), degraded),
    // Šaltinio vardas lieka `rejections`: jis jau yra `degraded` kontrakte, o skaitomas failas tas
    // pats. Naujas vardas tik perrašytų reikšmę jau paleistiems vartotojams.
    readSource(
      ports,
      "rejections",
      { last_rejections: [], refill_decisions: [] },
      () => readSnapshot(ports, stateDir, sanitize),
      degraded,
    ),
    readSource(
      ports,
      "slot_failures",
      [] as UiWaveSlotFailureEntry[],
      () => readSlotFailures(ports, logsDir, sanitize),
      degraded,
    ),
  ]);

  const slots = buildWaveSlots({
    leases,
    events: eventTail,
    failures,
    // Neperskaityti įvykiai NĖRA „vykdymo nebuvo": tada slot'as rodomas kaip `running`.
    events_available: !degraded.includes("events"),
    now,
  });

  return {
    events: eventTail.slice(-limit),
    leases: leases.map(toWireLease),
    slots,
    last_rejections: snapshot.last_rejections,
    refill_decisions: snapshot.refill_decisions,
    degraded,
  };
}

/**
 * VISA įvykių uodega, ne `?limit` pjūvis: slot'o būsena negali priklausyti nuo to, kiek eilučių
 * paprašė naršyklė. Vaizdo `events` sąrašas apkarpomas vėliau, iš to paties vieno skaitymo.
 */
async function readWaveEventTail(
  ports: WavesViewPorts,
  logsDir: string,
  sanitize: (text: string) => string,
): Promise<UiWaveEvent[]> {
  const lines = await ports.readTailLines(path.join(logsDir, "wave-events.jsonl"), EVENT_TAIL_BYTES);
  const events: UiWaveEvent[] = [];
  for (const line of lines) {
    const event = projectWaveEvent(line, sanitize);
    if (event) events.push(event);
  }
  return events;
}

async function readLeases(ports: WavesViewPorts, projectRoot: string): Promise<WaveSlotLease[]> {
  const leases = await ports.listWorkerLeases(projectRoot);
  return leases.map((lease) => ({
    worker_id: lease.worker_id,
    task_id: lease.task_id,
    status: lease.status,
    acquired_at: lease.acquired_at,
    heartbeat_at: lease.heartbeat_at,
    expires_at: lease.expires_at,
    has_worktree: Boolean(lease.worktree_path),
  }));
}

/**
 * `WAVE SLOT FAILED` eilutės — vienintelė vieta, kur užrašoma slot'o žūties priežastis. Netinkamos
 * eilutės praleidžiamos (log'as yra laisvo formato srautas), o log tvarka išsaugoma: paskutinę
 * kartos nesėkmę renkasi `buildWaveSlots`.
 */
async function readSlotFailures(
  ports: WavesViewPorts,
  logsDir: string,
  sanitize: (text: string) => string,
): Promise<UiWaveSlotFailureEntry[]> {
  const lines = await ports.readTailLines(path.join(logsDir, "orchestrator.log"), ORCHESTRATOR_LOG_TAIL_BYTES);
  const failures: UiWaveSlotFailureEntry[] = [];
  for (const line of lines) {
    if (!line.includes(SLOT_FAILURE_PREFIX)) continue;
    const failure = parseSlotFailureLine(line, sanitize);
    if (failure) failures.push(failure);
  }
  return failures;
}
