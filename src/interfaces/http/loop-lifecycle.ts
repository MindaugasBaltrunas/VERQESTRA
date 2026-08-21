// Loop proceso paleidimas ir stabdymas iš UI (etalonas: AG_loop ui/loop-service.ts).
//
// VIENINTELIS gyvumo šaltinis yra runtime įrašas: PID + ŠVIEŽIAS heartbeat. Etalone čia kadaise
// stovėjo ir in-memory patikra, kuri grąžindavo „already-running" NEPASIEKUSI heartbeat'o —
// `killed` yra `true` tik kai signalą siuntėme MES, tad natūraliai pasibaigęs vaikas su OS
// pernaudotu PID amžinai atsakinėdavo „jau veikia". Vienas šaltinis vietoj dviejų pašalina visą
// klaidų klasę.

import path from "node:path";
import {
  readLoopRuntimeRecord,
  removeStaleRuntimeRecord,
  writeLoopRuntimeRecord,
} from "../hooks/loop-runtime-store.js";
import { loopRuntimeIsAlive } from "../../domain/scheduling/loop-runtime.js";
import { resetLoopControl, type LoopControlDeps } from "../../application/scheduling/loop-control-store.js";
import type { ProcessLifecyclePorts } from "./process-lifecycle-ports.js";

export type LoopStartResult =
  | { status: "already-running"; pid: number }
  | { status: "started"; pid: number }
  | { status: "failed"; reason: string };

export type LoopStopResult =
  | { status: "stop-requested"; pid: number }
  /** Vėliava įrašyta, bet gyvo, šiam UI žinomo loop proceso nėra (pvz. paleistas terminale). */
  | { status: "stop-requested-no-known-process" }
  | { status: "failed"; reason: string };

export type LoopLifecycleDeps = {
  ports: ProcessLifecyclePorts;
  /** vq runtime šaknis (`<root>/vq`). */
  runtimeRoot: string;
};

export function loopStopFile(stateDir: string): string {
  return path.join(stateDir, "loop-stop.requested");
}

export function loopPidFile(stateDir: string): string {
  return path.join(stateDir, "ui-loop.pid");
}

function stateDirOf(deps: LoopLifecycleDeps): string {
  return path.join(deps.runtimeRoot, "state");
}

function loopControlDeps(deps: LoopLifecycleDeps): LoopControlDeps {
  return {
    fs: {
      readTextFileIfExists: (p) => deps.ports.fs.readTextFileIfExists(p),
      listDirectoryIfExists: () => Promise.resolve(undefined),
      writeTextFileAtomic: (p, content) => deps.ports.fs.writeTextFileAtomic(p, content),
      makeDirectory: (dir) => deps.ports.fs.makeDirectory(dir),
      exists: async (p) => (await deps.ports.fs.readTextFileIfExists(p)) !== undefined,
      createLockDirectory: () => Promise.resolve("created" as const),
      removeDirectory: () => Promise.resolve(),
      directoryModifiedAtMs: () => Promise.resolve(undefined),
    },
    ...(deps.ports.now === undefined ? {} : { now: deps.ports.now }),
  };
}

/**
 * Serializuoja paleidimo kvietimus.
 *
 * Be šito tarp „ar jau veikia" patikros ir paleidimo lieka DU `await` (įrašo skaitymas ir pasenusio
 * įrašo šalinimas), pro kuriuos prasprūsta antras kvietimas: du naršyklės tab'ai, dvigubas
 * paspaudimas arba `resume` kartu su įkėlimu abu praeidavo patikras ir abu paleisdavo
 * orkestratorių. Antrasis įrašas perrašydavo PID, tad PIRMASIS loop'as likdavo nesekamas ir
 * nebesustabdomas — du loop'ai judina tą pačią eilę ir commit'ina į tą patį repo.
 */
let startChain: Promise<unknown> = Promise.resolve();

export function ensureLoopRunning(deps: LoopLifecycleDeps): Promise<LoopStartResult> {
  const next = startChain.then(
    () => startLoop(deps),
    () => startLoop(deps),
  );
  startChain = next.catch(() => undefined);
  return next;
}

async function startLoop(deps: LoopLifecycleDeps): Promise<LoopStartResult> {
  const ports = deps.ports;
  const stateDir = stateDirOf(deps);
  const pidFile = loopPidFile(stateDir);

  const existing = await readLoopRuntimeRecord(ports.runtime, pidFile);
  const alive = loopRuntimeIsAlive({
    record: existing,
    processIsAlive: (pid: number) => ports.processIsAlive(pid),
    ...(ports.now === undefined ? {} : { now: ports.now() }),
  });
  if (existing && alive) {
    // Vartotojas, paspaudęs „Start" po „Stop", tikisi, kad loop'as liks veikti. Neišvalius
    // vėliavos loop'as vis tiek sustotų, o UI rodytų „jau veikia" — melas apie būseną.
    await clearStaleLoopStopState(deps);
    return { status: "already-running", pid: existing.pid };
  }

  await removeStaleRuntimeRecord(ports.runtime, pidFile);

  let child;
  try {
    child = await ports.spawnLoop();
  } catch (error) {
    return { status: "failed", reason: error instanceof Error ? error.message : String(error) };
  }
  if (!child.pid) {
    return { status: "failed", reason: "loop process started without a PID" };
  }

  // Pradinis įrašas su heartbeat'u; toliau jį atnaujina PATS loop'as, tad negyvas procesas
  // nebeatrodo gyvas vien dėl to, kad jo PID kažkam atiteko.
  await writeLoopRuntimeRecord(ports.runtime, pidFile, child.pid);
  child.detach();
  return { status: "started", pid: child.pid };
}

/**
 * Prašo švelnaus sustojimo įrašydamas vėliavą, kurią loop'as tikrina TARP užduočių. Veikia
 * nepriklausomai nuo to, ar loop'as paleistas iš UI, ar iš terminalo — vykdoma Claude užduotis
 * NIEKADA nenutraukiama.
 */
export async function requestLoopStop(deps: LoopLifecycleDeps): Promise<LoopStopResult> {
  const ports = deps.ports;
  const stateDir = stateDirOf(deps);

  try {
    await ports.fs.makeDirectory(stateDir);
    await ports.fs.writeTextFile(loopStopFile(stateDir), `${(ports.now?.() ?? new Date()).toISOString()}\n`);
  } catch (error) {
    return { status: "failed", reason: error instanceof Error ? error.message : String(error) };
  }

  // Gyvumas tikrinamas TUO PAČIU heartbeat kriterijumi kaip starte — kitaip „stop" praneštų apie
  // svetimą procesą, kuriam OS atidavė pernaudotą PID.
  const record = await readLoopRuntimeRecord(ports.runtime, loopPidFile(stateDir));
  const alive = loopRuntimeIsAlive({
    record,
    processIsAlive: (pid: number) => ports.processIsAlive(pid),
    ...(ports.now === undefined ? {} : { now: ports.now() }),
  });
  if (!record || !alive) {
    // Vėliava įrašoma bet kuriuo atveju (loop'as gali būti paleistas kitoje sesijoje), bet sėkmės
    // skelbti negalima: UI rodytų „stabdoma po užduoties", nors nė vieno gyvo proceso nėra.
    return { status: "stop-requested-no-known-process" };
  }
  return { status: "stop-requested", pid: record.pid };
}

/** `true`, kai stabdymas buvo prašytas; vėliava suvartojama. */
export async function consumeLoopStopRequest(deps: LoopLifecycleDeps): Promise<boolean> {
  return await deps.ports.fs.removeFileIfExists(loopStopFile(stateDirOf(deps)));
}

export async function clearLoopStopRequest(deps: LoopLifecycleDeps): Promise<void> {
  await deps.ports.fs.removeFileIfExists(loopStopFile(stateDirOf(deps)));
}

/**
 * VIENINTELIS „loop'as pradedamas" taškas pasenusioms stabdymo būsenoms išvalyti.
 *
 * Dvi stabdymo būsenos, vienas gyvavimo ciklas: `loop-stop.requested` vėliava ir slot'ų valdiklio
 * `drain`/`abort`. Vėliava išsivalo pati suvartojama, o valdiklis yra LIPNUS — jis lieka diske, kol
 * kas nors jį atstato. Kol atstatymas gyveno tik viename maršrute, kiekvienas kitas starto kelias
 * paleisdavo loop'ą, kuris prieš pirmą dispatch'ą pamatydavo `drain` ir iškart baigdavosi —
 * operatoriui tai atrodė kaip „paleista, bet nieko nevyksta". Operacija idempotentinė.
 */
export async function clearStaleLoopStopState(deps: LoopLifecycleDeps): Promise<void> {
  const stateDir = stateDirOf(deps);
  await clearLoopStopRequest(deps);
  await resetLoopControl(loopControlDeps(deps), stateDir);
}
