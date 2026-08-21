// Loop/sesijos runtime įrašo IO (etalonas: AG_loop ui/process-state.ts rašymo ir skaitymo
// pusė). Taisyklės — `domain/scheduling/loop-runtime`; čia tik failai ir portai.
//
// Pilnas įrašas gyvena ATSKIRAME faile šalia legacy PID failo. Etalono 2026-08-06 pamoka:
// JSON įrašas, įdėtas TIESIAI į `.pid`, sulaužė ilgai veikiantį seną skaitytoją, kuris priima
// tik `^\d+$` — gyvas loop'as jam tapo „neužregistruotas", UI siūlė paleisti ANTRĄ
// orkestratorių ir neleido sustabdyti veikiančio. Formatas, kurio senas skaitytojas nesupranta,
// privalo turėti savo failą, o legacy failas rašomas TOLIAU.

import {
  type LoopRuntimeInspection,
  type LoopRuntimeRecord,
  type LoopSupervisorState,
  buildLoopRuntimeRecord,
  loopRuntimeIsAlive,
  parseLegacyLoopRuntimeRecord,
  parseLoopRuntimeRecord,
} from "../../domain/scheduling/loop-runtime.js";
import { toPrettyJson } from "../../shared/json.js";
import type { HookFsPort } from "./protocol.js";

export type LoopRuntimeFsPort = Pick<
  HookFsPort,
  "exists" | "readTextFileIfExists" | "writeTextFile" | "makeDirectory"
> & {
  /** Failo mtime ms; `undefined`, kai failo nėra (legacy įrašo heartbeat'as). */
  fileMtimeMs(absolutePath: string): Promise<number | undefined>;
  /** Best-effort šalinimas: nesamas failas nėra klaida. */
  removeIfExists(absolutePath: string): Promise<void>;
};

export type LoopRuntimePorts = {
  fs: LoopRuntimeFsPort;
  /** Ar procesas su tokiu PID egzistuoja (`infrastructure/process` adapteris). */
  processIsAlive(pid: number): boolean;
  now?: () => Date;
};

/** Pilno įrašo failas šalia legacy PID failo. */
export function loopRuntimeRecordPath(pidFile: string): string {
  return `${pidFile.replace(/\.pid$/i, "")}.runtime.json`;
}

export async function inspectLoopRuntimeRecord(
  ports: LoopRuntimePorts,
  pidFile: string,
): Promise<LoopRuntimeInspection> {
  // Pirmenybė pilnam įrašui (turi tikrą heartbeat); legacy PID failas — atsarginis kelias.
  const runtimeRaw = await ports.fs.readTextFileIfExists(loopRuntimeRecordPath(pidFile));
  const runtimeParsed = runtimeRaw ? parseLoopRuntimeRecord(runtimeRaw) : undefined;
  if (runtimeParsed) return { state: "ok", record: runtimeParsed };

  const raw = await ports.fs.readTextFileIfExists(pidFile);
  if (raw) {
    const legacy = parseLoopRuntimeRecord(raw) ?? parseLegacyLoopRuntimeRecord(raw, await legacyHeartbeat(ports, pidFile));
    return legacy ? { state: "ok", record: legacy } : { state: "corrupt" };
  }

  // Runtime failas BUVO, bet neperskaitomas, o legacy failo nėra — tai ne „absent".
  if (runtimeRaw) return { state: "corrupt" };
  return { state: "absent" };
}

async function legacyHeartbeat(ports: LoopRuntimePorts, pidFile: string): Promise<string> {
  const mtimeMs = await ports.fs.fileMtimeMs(pidFile);
  return new Date(mtimeMs ?? 0).toISOString();
}

export async function readLoopRuntimeRecord(
  ports: LoopRuntimePorts,
  pidFile: string,
): Promise<LoopRuntimeRecord | undefined> {
  const inspection = await inspectLoopRuntimeRecord(ports, pidFile);
  return inspection.state === "ok" ? inspection.record : undefined;
}

export type WriteLoopRuntimeOptions = {
  startedAt?: string;
  supervisor?: LoopSupervisorState;
};

/** Užregistruoja arba atnaujina šio proceso heartbeat'ą. */
export async function writeLoopRuntimeRecord(
  ports: LoopRuntimePorts,
  pidFile: string,
  pid: number,
  options: WriteLoopRuntimeOptions = {},
): Promise<LoopRuntimeRecord> {
  const record = buildLoopRuntimeRecord({
    pid,
    now: ports.now?.() ?? new Date(),
    ...(options.startedAt === undefined ? {} : { startedAt: options.startedAt }),
    ...(options.supervisor === undefined ? {} : { supervisor: options.supervisor }),
  });
  await ports.fs.writeTextFile(loopRuntimeRecordPath(pidFile), toPrettyJson(record));
  // Legacy PID failas rašomas TOLIAU: senesnis skaitytojas turi ir toliau matyti veikiantį
  // procesą, kol nebus perkrautas.
  await ports.fs.writeTextFile(pidFile, `${pid}\n`);
  return record;
}

/** Pašalina abu įrašo failus (pilną ir legacy). */
async function removeRuntimeFiles(ports: LoopRuntimePorts, pidFile: string): Promise<boolean> {
  const existed = await Promise.all(
    [loopRuntimeRecordPath(pidFile), pidFile].map((filePath) => ports.fs.exists(filePath)),
  );
  await Promise.all(
    [loopRuntimeRecordPath(pidFile), pidFile].map((filePath) => ports.fs.removeIfExists(filePath)),
  );
  return existed.some(Boolean);
}

/** Pašalina įrašą, jei jis nebeįrodo gyvo proceso. */
export async function removeStaleRuntimeRecord(ports: LoopRuntimePorts, pidFile: string): Promise<boolean> {
  const record = await readLoopRuntimeRecord(ports, pidFile);
  const alive = loopRuntimeIsAlive({
    record,
    processIsAlive: (pid) => ports.processIsAlive(pid),
    ...(ports.now === undefined ? {} : { now: ports.now() }),
  });
  if (alive) return false;
  return await removeRuntimeFiles(ports, pidFile);
}

/**
 * Atlaisvina ŠIO proceso įrašą baigiantis darbui.
 *
 * `removeStaleRuntimeRecord` tam netinka ir tyliai nieko nedarytų: kviečiant ją iš `finally`
 * procesas dar gyvas, o heartbeat šviežias, tad įrašas liktų gulėti su ŠVIEŽIU heartbeat'u ir
 * jau mirusiu PID. Jei OS tą PID perpanaudotų per TTL langą, atgytų lygiai tas „already-running"
 * melas, kurį visas modelis ir turi panaikinti.
 *
 * Trinama TIK savo įrašą (`record.pid === ownPid`): failas dalijamasis, tad svetimo įrašo
 * trynimas paslėptų dar gyvą sesiją.
 */
export async function releaseLoopRuntimeRecord(
  ports: LoopRuntimePorts,
  pidFile: string,
  ownPid: number,
): Promise<boolean> {
  const record = await readLoopRuntimeRecord(ports, pidFile);
  if (!record || record.pid !== ownPid) return false;
  return await removeRuntimeFiles(ports, pidFile);
}
