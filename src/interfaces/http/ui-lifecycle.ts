// UI serverio paleidimas (etalonas: AG_loop ui/ui-service.ts).
//
// Numatytojo porto čia NĖRA: keli projektai vienoje mašinoje privalo gauti skirtingus portus, o
// „portas klauso" nebėra įrodymas, kad klauso MŪSŲ projekto serveris (žr. `ui-port-rules`).

import path from "node:path";
import { removeStaleRuntimeRecord } from "../hooks/loop-runtime-store.js";
import { consoleHookIo } from "../hooks/protocol.js";
import {
  projectFingerprint,
  uiUrl,
  type UiPortSource,
} from "./ui-port-rules.js";
import {
  readUiServerRecord,
  resolveUiPort,
  writeUiServerRecord,
  type UiPortPorts,
} from "./ui-port-store.js";
import type { ProcessLifecyclePorts, SpawnedProcess } from "./process-lifecycle-ports.js";

export type UiStartResult =
  | { status: "already-running"; pid?: number | undefined; port: number }
  | { status: "started"; pid: number; port: number }
  | { status: "disabled" }
  | { status: "failed"; reason: string };

export const UI_AUTOSTART_ENV = "AG_UI_AUTOSTART";

/**
 * Kiek laiko po įrašo dar tikima, kad vaikas TIK KYLA, nors kandidato porte niekas neatsako. Turi
 * būti su kaupu ilgesnis už proceso starto laiką ir gerokai trumpesnis už sesiją: pasibaigus jam
 * gyvumą vėl sprendžia tik zondas.
 */
export const UI_STARTUP_GRACE_MS = 30_000;

export type UiLifecycleDeps = {
  ports: ProcessLifecyclePorts;
  /** Porto sprendimo portai (zondas, env, įrašas). */
  portPorts: UiPortPorts;
  projectRoot: string;
  /** vq runtime šaknis (`<root>/vq`). */
  runtimeRoot: string;
};

export function uiPidFile(stateDir: string): string {
  return path.join(stateDir, "ui.pid");
}

/** Šio proceso PID įrašas — kviečia pats serveris pakilęs. */
export async function writeCurrentUiPid(deps: UiLifecycleDeps, pid: number): Promise<void> {
  const stateDir = path.join(deps.runtimeRoot, "state");
  await deps.ports.fs.makeDirectory(stateDir);
  await deps.ports.fs.writeTextFile(uiPidFile(stateDir), `${pid}\n`);
}

/**
 * Serializuoja paleidimo kvietimus (tas pats šablonas kaip loop pusėje). Nuo porto zondavimo iki
 * paleidimo yra keli `await`, pro kuriuos antras lygiagretus kvietimas prasprūstų: abu pamatytų
 * laisvą kandidatą ir abu paleistų po UI serverį, o antrasis įrašas paliktų pirmąjį procesą
 * nesekamą. TARPPROCESINĮ tos pačios lenktynės variantą gaudo {@link UI_STARTUP_GRACE_MS} vartas.
 */
let startChain: Promise<unknown> = Promise.resolve();

/** Šio proceso paleistas vaikas — vienintelis atvejis, kai in-memory būsena ką nors įrodo. */
let uiProcess: SpawnedProcess | undefined;
let uiProcessPort: number | undefined;

export function ensureUiRunning(deps: UiLifecycleDeps, port?: number): Promise<UiStartResult> {
  const next = startChain.then(
    () => startUi(deps, port),
    () => startUi(deps, port),
  );
  startChain = next.catch(() => undefined);
  return next;
}

async function startUi(deps: UiLifecycleDeps, requestedPort?: number): Promise<UiStartResult> {
  const ports = deps.ports;
  const io = ports.io ?? consoleHookIo;
  if (ports.env(UI_AUTOSTART_ENV) === "0") {
    return { status: "disabled" };
  }

  const stateDir = path.join(deps.runtimeRoot, "state");
  const fingerprint = projectFingerprint(deps.projectRoot, deps.portPorts.platform ?? process.platform);

  // In-memory šaka gali kalbėti TIK apie mūsų pačių paleistą vaiką, tad svetimo projekto serverio
  // ji savu palaikyti negali — būtent tuo ji skiriasi nuo pašalintos „portas klauso" patikros.
  if (uiProcess?.pid && uiProcessPort !== undefined && uiProcess.isRunning()) {
    return { status: "already-running", pid: uiProcess.pid, port: uiProcessPort };
  }

  // TARPPROCESINIS starto lango vartas. Nuo paleidimo iki vaiko `listen` praeina šimtai
  // milisekundžių: per juos KITAS procesas kandidato portą dar matytų laisvą ir paleistų antrą to
  // paties projekto serverį — antrasis krenta, bet jo PID jau būna įrašytas, tad diske lieka
  // melagingas įrodymas. Įrašas čia teisėtas, nes gyvena MŪSŲ būsenoje ir neša mūsų fingerprint'ą.
  const booting = await readUiServerRecord(deps.portPorts, stateDir);
  const bootingAt = booting ? Date.parse(booting.updated_at) : Number.NaN;
  if (
    booting !== undefined &&
    booting.project_fingerprint === fingerprint &&
    ports.processIsAlive(booting.pid) &&
    Number.isFinite(bootingAt) &&
    (ports.now?.() ?? new Date()).getTime() - bootingAt < UI_STARTUP_GRACE_MS
  ) {
    return { status: "already-running", pid: booting.pid, port: booting.port };
  }

  let port: number;
  let source: UiPortSource | "caller";
  if (requestedPort === undefined) {
    const resolution = await resolveUiPort({
      ports: deps.portPorts,
      projectRoot: deps.projectRoot,
      runtimeRoot: deps.runtimeRoot,
    });
    if (resolution.status === "failed") return uiStartFailed(io, resolution.reason);
    if (resolution.status === "already-running") {
      // Gyvas ŠIO projekto serveris — antro kelti nereikia. PID imamas iš įrašo tik kaip
      // informacija: gyvumą jau įrodė identifikacijos zondas, ne PID.
      const pid = (await readUiServerRecord(deps.portPorts, stateDir))?.pid;
      io.out(`UI: ${resolution.url} (already running, ${resolution.source})`);
      return { status: "already-running", ...(pid === undefined ? {} : { pid }), port: resolution.port };
    }
    port = resolution.port;
    source = resolution.source;
  } else {
    port = requestedPort;
    source = "caller";
  }

  await removeStaleRuntimeRecord(ports.runtime, uiPidFile(stateDir));

  let child: SpawnedProcess;
  try {
    child = await ports.spawnUi(port);
  } catch (error) {
    return uiStartFailed(io, error instanceof Error ? error.message : String(error));
  }
  if (!child.pid) return uiStartFailed(io, "UI process started without a PID");

  await ports.fs.makeDirectory(stateDir);
  await ports.fs.writeTextFile(uiPidFile(stateDir), `${child.pid}\n`);
  // Pasenęs įrašas perrašomas ČIA, nelaukiant vaiko: jei vaikas nepakiltų, diske negali likti
  // įrašo, rodančio į portą, kurio niekas neklauso. Pakilęs vaikas tą patį įrašą perrašo su REALIU
  // portu.
  await writeUiServerRecord(deps.portPorts, stateDir, { port, fingerprint, pid: child.pid }).catch(() => undefined);

  uiProcess = child;
  uiProcessPort = port;
  child.detach();
  io.out(`UI: ${uiUrl(port)} (started, ${source})`);
  return { status: "started", pid: child.pid, port };
}

/**
 * Nesėkmė PRANEŠAMA, o ne vien grąžinama: production kvietėjas rezultato neima, tad be šios eilutės
 * blogas porto override ar išsemtas diapazonas reikštų loop'ą, startuojantį be UI ir be nė vieno
 * žodžio, kodėl. Fail-fast, kurio niekas nemato, nėra fail-fast.
 */
function uiStartFailed(io: { error(line: string): void }, reason: string): UiStartResult {
  io.error(`UI: cannot start — ${reason}`);
  return { status: "failed", reason };
}

/** Testams: in-memory vaiko būsena yra modulio lygio, tad tarp scenarijų ji atstatoma. */
export function resetUiLifecycleStateForTests(): void {
  uiProcess = undefined;
  uiProcessPort = undefined;
  startChain = Promise.resolve();
}
