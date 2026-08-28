// UI bundle rebuild paleidimas (`pnpm --dir ui-app build`) — etalonas: `/api/runtime/loop/start`
// gyvavimo ciklo šablonas (žr. `loop-lifecycle.ts`).
//
// Komanda FIKSUOTA kode: maršrutas jokių parametrų iš request'o nepriima (task 058-3), tad
// paleidimo pusėje jų irgi nėra — vienintelis kintamasis yra „ar rebuild'as jau vyksta". Realų
// procesą riša composition (sekanti užduotis); čia — tik sprendimas ir persistuota būsena
// (`ui-port-store.ts`).

import path from "node:path";
import {
  UI_REBUILD_RECORD_SCHEMA_VERSION,
  readUiRebuildRecord,
  writeUiRebuildRecord,
  type UiPortFsPort,
} from "./ui-port-store.js";

/** Fiksuota komanda: joks kliento laukas jos pakeisti negali. */
export const UI_REBUILD_COMMAND = "pnpm";
export const UI_REBUILD_ARGS: readonly string[] = ["--dir", "ui-app", "build"];

/** Kad diske nesikauptų neriboto dydžio išvestis, uodega apkarpoma iki paskutinių N simbolių. */
export const UI_REBUILD_OUTPUT_TAIL_MAX_CHARS = 4000;

export type UiRebuildExit = { code: number | null; tail: string };

/**
 * Paleistas rebuild vaikas. Skirtingai nuo `SpawnedProcess` (`process-lifecycle-ports.ts`), jam
 * reikia išėjimo pranešimo SU išvestimi — be jos `failed` baigtis neturėtų ką parodyti operatoriui.
 */
export type UiRebuildProcess = {
  pid?: number | undefined;
  isRunning(): boolean;
  /** Leidžia tėvui baigtis nepriklausomai nuo vaiko. */
  detach(): void;
  /**
   * Kviečiama LYGIAI VIENĄ kartą, kai vaikas baigia darbą (bet kokia baigtimi). Registruotas
   * callback GRĄŽINA `Promise`, kai jo darbas (būsenos įrašo perrašymas) asinchroninis — kvietėjas
   * (composition adapteris arba testas) gali ją nusilaukti, kad nebūtų lenktynių su sekančiu
   * skaitymu.
   */
  onExit(callback: (exit: UiRebuildExit) => void | Promise<void>): void;
};

export type UiRebuildProcessPorts = {
  fs: UiPortFsPort;
  spawnUiRebuild(): Promise<UiRebuildProcess>;
  processIsAlive(pid: number): boolean;
  now?: () => Date;
};

export type UiRebuildDeps = {
  ports: UiRebuildProcessPorts;
  /** vq runtime šaknis (`<root>/vq`). */
  runtimeRoot: string;
};

export type UiRebuildStartResult =
  | { status: "already-running"; pid: number }
  | { status: "started"; pid: number }
  | { status: "failed"; reason: string };

export type UiRebuildStatusResult =
  | { status: "running"; pid: number }
  | { status: "ok" }
  | { status: "failed"; tail: string };

function stateDirOf(deps: UiRebuildDeps): string {
  return path.join(deps.runtimeRoot, "state");
}

/**
 * Serializuoja paleidimo kvietimus (tas pats šablonas kaip loop/UI pusėje, žr. `loop-lifecycle.ts`).
 * Be šito du beveik vienalaikiai paspaudimai abu pamatytų „nevyksta" ir abu paleistų `pnpm build` —
 * du vienalaikiai build'ai į TĄ PATĮ `ui-app/dist` viena kitą perrašo.
 */
let startChain: Promise<unknown> = Promise.resolve();

export function ensureUiRebuildRunning(deps: UiRebuildDeps): Promise<UiRebuildStartResult> {
  const next = startChain.then(
    () => startUiRebuild(deps),
    () => startUiRebuild(deps),
  );
  startChain = next.catch(() => undefined);
  return next;
}

async function startUiRebuild(deps: UiRebuildDeps): Promise<UiRebuildStartResult> {
  const ports = deps.ports;
  const stateDir = stateDirOf(deps);

  const existing = await readUiRebuildRecord(ports.fs, stateDir);
  if (existing?.status === "running" && ports.processIsAlive(existing.pid)) {
    return { status: "already-running", pid: existing.pid };
  }

  let child: UiRebuildProcess;
  try {
    child = await ports.spawnUiRebuild();
  } catch (error) {
    return { status: "failed", reason: error instanceof Error ? error.message : String(error) };
  }
  if (!child.pid) {
    return { status: "failed", reason: "ui rebuild process started without a PID" };
  }

  const pid = child.pid;
  const startedAt = (ports.now?.() ?? new Date()).toISOString();
  await writeUiRebuildRecord(ports.fs, stateDir, {
    schema_version: UI_REBUILD_RECORD_SCHEMA_VERSION,
    pid,
    status: "running",
    started_at: startedAt,
  });

  child.onExit(({ code, tail }) => {
    const finishedAt = (ports.now?.() ?? new Date()).toISOString();
    const status: "ok" | "failed" = code === 0 ? "ok" : "failed";
    const truncatedTail =
      tail.length > UI_REBUILD_OUTPUT_TAIL_MAX_CHARS ? tail.slice(-UI_REBUILD_OUTPUT_TAIL_MAX_CHARS) : tail;
    return writeUiRebuildRecord(ports.fs, stateDir, {
      schema_version: UI_REBUILD_RECORD_SCHEMA_VERSION,
      pid,
      status,
      started_at: startedAt,
      finished_at: finishedAt,
      ...(status === "failed" ? { output_tail: truncatedTail } : {}),
    }).catch(() => undefined);
  });

  child.detach();
  return { status: "started", pid };
}

/**
 * Būsenos užklausa. Įrašo NĖRA reiškia „rebuild dar niekada nebuvo paleistas" — tai laikoma `ok`,
 * ne klaida: dashboard'as neturi rodyti raudono ženklo prieš pirmą paspaudimą.
 */
export async function uiRebuildStatus(deps: UiRebuildDeps): Promise<UiRebuildStatusResult> {
  const record = await readUiRebuildRecord(deps.ports.fs, stateDirOf(deps));
  if (!record) return { status: "ok" };

  if (record.status === "running") {
    if (deps.ports.processIsAlive(record.pid)) return { status: "running", pid: record.pid };
    // Įrašas sako „running", bet proceso nebėra: vaikas mirė nepranešęs išėjimo (pvz. nužudytas).
    // Tylus „ok" čia meluotų apie sėkmę, kurios niekas nepatvirtino.
    return { status: "failed", tail: record.output_tail ?? "" };
  }

  if (record.status === "failed") return { status: "failed", tail: record.output_tail ?? "" };
  return { status: "ok" };
}

/** Testams: modulio lygio starto grandinė atstatoma tarp scenarijų. */
export function resetUiRebuildStateForTests(): void {
  startChain = Promise.resolve();
}
