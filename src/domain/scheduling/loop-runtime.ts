// Loop proceso tapatybės įrašo GRYNOSIOS taisyklės (etalonas: AG_loop ui/process-state.ts).
//
// VERQESTRA nukrypimas nuo etalono: etalone šis žinojimas gyveno `ui/` sluoksnyje, o jį
// importavo `hooks/`. VERQESTRA ui sluoksnio neturi, ir atkurti tą briauną reikštų pastatyti
// naują priklausomybės kryptį vien dėl formato. Taisyklės (parsinimas, gyvumas, klasifikacija)
// yra domain; IO (failai, `process.kill`) — adapteryje, ir gyvumo patikra ateina parametru.
//
// 2026-08-06 incidentas, dėl kurio šis modelis egzistuoja: PID failas laikė TIK skaičių, o
// gyvumas buvo tikrinamas `process.kill(pid, 0)`. OS pernaudoja PID'us — nustojus veikti
// loop'ui, tą patį numerį po kelių valandų gavo visai kitas procesas, „ar gyvas" atsakė `true`,
// ir UI amžinai rodė „already-running". Todėl vien PID nebėra gyvumo įrodymas: įrodymas yra
// PID + ŠVIEŽIAS heartbeat, kurį gyvas procesas atnaujina, o pernaudotas svetimas PID — ne.

/** Self-restart watchdog būsena vienam loop proceso gyvavimo ciklui. */
export type LoopSupervisorState = {
  restarts_used: number;
  last_reason?: string;
  arrested: boolean;
};

export type LoopRuntimeRecord = {
  pid: number;
  /** ISO laikas, kada procesas užsiregistravo. */
  started_at: string;
  /** ISO laikas, kada procesas paskutinį kartą patvirtino, kad gyvas. */
  heartbeat_at: string;
  /** Nėra, kai supervizija išjungta arba loop'as dar nepatyrė nė vieno stop'o. */
  supervisor?: LoopSupervisorState;
};

/**
 * Kiek laiko heartbeat laikomas šviežiu. Dosnu sąmoningai: loop'as gali kelias dešimtis minučių
 * stovėti viename dispatch'e arba cooldown'e, o heartbeat atnaujina taimeris, ne ciklas.
 */
export const LOOP_HEARTBEAT_TTL_MS = 5 * 60 * 1000;

export function parseLoopSupervisorState(value: unknown): LoopSupervisorState | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const candidate = value as Partial<LoopSupervisorState>;
  if (typeof candidate.restarts_used !== "number" || typeof candidate.arrested !== "boolean") return undefined;
  return {
    restarts_used: candidate.restarts_used,
    arrested: candidate.arrested,
    ...(typeof candidate.last_reason === "string" ? { last_reason: candidate.last_reason } : {}),
  };
}

/** Pilnas įrašas iš JSON teksto; bet kokia neatitiktis — `undefined` (spėti draudžiama). */
export function parseLoopRuntimeRecord(raw: string): LoopRuntimeRecord | undefined {
  let parsed: Partial<LoopRuntimeRecord>;
  try {
    parsed = JSON.parse(raw) as Partial<LoopRuntimeRecord>;
  } catch {
    return undefined;
  }
  if (typeof parsed.pid !== "number" || !Number.isSafeInteger(parsed.pid) || parsed.pid <= 0) return undefined;
  if (typeof parsed.heartbeat_at !== "string" || typeof parsed.started_at !== "string") return undefined;
  const supervisor = parseLoopSupervisorState(parsed.supervisor);
  return {
    pid: parsed.pid,
    started_at: parsed.started_at,
    heartbeat_at: parsed.heartbeat_at,
    ...(supervisor ? { supervisor } : {}),
  };
}

/**
 * Legacy formatas: failas su vienu skaičiumi. Heartbeat'u tampa paties failo mtime, kurį
 * paduoda kvietėjas — domain sluoksnis failų neliečia.
 */
export function parseLegacyLoopRuntimeRecord(raw: string, mtimeIso: string): LoopRuntimeRecord | undefined {
  const trimmed = raw.trim();
  if (!/^\d+$/u.test(trimmed)) return undefined;
  const pid = Number.parseInt(trimmed, 10);
  if (!Number.isSafeInteger(pid) || pid <= 0) return undefined;
  return { pid, started_at: mtimeIso, heartbeat_at: mtimeIso };
}

/**
 * Detali įrašo būsena, skirianti DVI skirtingas „įrašo nėra" priežastis.
 *
 * Etalono 2026-08-06 incidentas: abi buvo verčiamos į `unknown`, o prie `unknown` UI saugiai
 * užrakina „Paleisti". Bet ŠVARIAI sustojęs loop'as pats ištrina savo įrašą — po kiekvieno
 * normalaus sustojimo failo nebūdavo, ir mygtukas likdavo užrakintas amžinai. „Failo nėra" savo
 * įrašą valdančiam procesui yra ĮRODYMAS, kad jis neveikia; pavojinga tik `corrupt`.
 */
export type LoopRuntimeInspection =
  | { state: "absent" }
  | { state: "corrupt" }
  | { state: "ok"; record: LoopRuntimeRecord };

export type LoopRuntimeStatus = "running" | "stopped" | "unknown";

/** Ar PID apskritai gali būti nuoroda į konkretų procesą (0 ir neigiami POSIX'e — grupė). */
export function isAddressablePid(pid: number): boolean {
  return Number.isSafeInteger(pid) && pid > 0;
}

export type LoopRuntimeLivenessInput = {
  record: LoopRuntimeRecord | undefined;
  /** Ar procesas su tokiu PID egzistuoja. IO — kvietėjo pusėje. */
  processIsAlive: (pid: number) => boolean;
  now?: Date;
  ttlMs?: number;
};

/**
 * Ar įrašas ĮRODO, kad loop'as gyvas: procesas egzistuoja IR heartbeat šviežias. Pernaudotas
 * svetimas PID praeina pirmą sąlygą, bet ne antrą.
 */
export function loopRuntimeIsAlive(input: LoopRuntimeLivenessInput): boolean {
  const record = input.record;
  if (!record || !isAddressablePid(record.pid) || !input.processIsAlive(record.pid)) return false;
  const heartbeat = Date.parse(record.heartbeat_at);
  if (!Number.isFinite(heartbeat)) return false;
  const ttlMs = input.ttlMs ?? LOOP_HEARTBEAT_TTL_MS;
  return (input.now ?? new Date()).getTime() - heartbeat <= ttlMs;
}

export type ClassifyLoopRuntimeInput = {
  inspection: LoopRuntimeInspection;
  processIsAlive: (pid: number) => boolean;
  /**
   * `true` — procesas PATS registruoja ir valo savo įrašą (loop'as): gyvumo įrodymas yra
   * PID + šviežias heartbeat, o įrašo NEBUVIMAS reiškia „sustojęs". `false` — pasyvus
   * indikatorius be rašytojo gyvavimo ciklo (vartotojo Claude terminalas): nebuvimas nieko
   * neįrodo, tad lieka `unknown`, o gyvumui pakanka egzistuojančio PID.
   */
  selfRegistering?: boolean;
  now?: Date;
  ttlMs?: number;
};

/** `corrupt` VISADA yra `unknown`: failas yra, bet perskaityti jo negalima — spėti draudžiama. */
export function classifyLoopRuntime(input: ClassifyLoopRuntimeInput): LoopRuntimeStatus {
  const inspection = input.inspection;
  if (inspection.state === "corrupt") return "unknown";
  if (inspection.state === "absent") return input.selfRegistering ? "stopped" : "unknown";

  const alive = input.selfRegistering
    ? loopRuntimeIsAlive({
        record: inspection.record,
        processIsAlive: input.processIsAlive,
        ...(input.now === undefined ? {} : { now: input.now }),
        ...(input.ttlMs === undefined ? {} : { ttlMs: input.ttlMs }),
      })
    : isAddressablePid(inspection.record.pid) && input.processIsAlive(inspection.record.pid);
  return alive ? "running" : "stopped";
}

export type BuildLoopRuntimeRecordInput = {
  pid: number;
  now: Date;
  startedAt?: string;
  supervisor?: LoopSupervisorState;
};

export function buildLoopRuntimeRecord(input: BuildLoopRuntimeRecordInput): LoopRuntimeRecord {
  return {
    pid: input.pid,
    started_at: input.startedAt ?? input.now.toISOString(),
    heartbeat_at: input.now.toISOString(),
    ...(input.supervisor ? { supervisor: input.supervisor } : {}),
  };
}

/**
 * Kieno PID registruojame: NE hook'o proceso, o PAČIOS sesijos — hook'as gyvena kelias
 * sekundes, tad jo PID po akimirkos būtų miręs (arba OS jį perpanaudotų), ir statusas meluotų
 * abiem kryptimis. Sesijos procesas yra hook'o TĖVAS. `> 1`: 1 (init) niekada nėra sesija, o
 * 0 ir neigiami POSIX'e reiškia procesų grupę.
 */
export function resolveSessionOwnerPid(parentPid: number, processIsAlive: (pid: number) => boolean): number | undefined {
  if (!Number.isSafeInteger(parentPid) || parentPid <= 1) return undefined;
  return processIsAlive(parentPid) ? parentPid : undefined;
}
