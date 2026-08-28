// UI ir loop procesų gyvavimo ciklo adapteriai (manual DI, LAY-2).
//
// Šis failas paleidžia ATSKIRUS, ILGAI GYVENANČIUS procesus — loop'ą ir UI serverį. Iš to
// plaukia dvi savybės, kurios yra kontraktas:
//   1. vaikas ATSIEJAMAS (`detached` + `unref`): UI mygtukas „paleisti loop'ą" negali reikšti,
//      kad loop'as miršta kartu su naršyklės sesiją aptarnavusiu procesu;
//   2. gyvybė tikrinama per PROCESO HANDLE (`isRunning`), o ne per PID sąrašą: PID'ai
//      perpanaudojami, ir svetimas procesas tuo pačiu numeriu atrodytų kaip mūsų loop'as.

import { spawn, type SpawnOptions } from "node:child_process";
import type {
  ProcessLifecycleFsPort,
  ProcessLifecyclePorts,
  SpawnedProcess,
} from "../../interfaces/http/process-lifecycle-ports.js";
import { UI_AUTOSTART_ENV } from "../../interfaces/http/ui-lifecycle.js";
import {
  UI_REBUILD_ARGS,
  UI_REBUILD_COMMAND,
  UI_REBUILD_OUTPUT_TAIL_MAX_CHARS,
  type UiRebuildExit,
  type UiRebuildProcess,
  type UiRebuildProcessPorts,
} from "../../interfaces/http/ui-rebuild.js";
import type { HookIo } from "../../interfaces/hooks/protocol.js";
import type { LoopRuntimePorts } from "../../interfaces/hooks/loop-runtime-store.js";
import { nodeFsAdapter } from "../../infrastructure/fs/node-fs-adapter.js";
import { isProcessAlive } from "../../infrastructure/process/process-tree.js";
import { packageManagerExecutable } from "../../infrastructure/process/run-process.js";
import { cliEntryPath } from "../runtime/context.js";

/** Gyvavimo ciklo FS pjūvis: skaitymai, du rašymai ir šalinimas, kuris SAKO, ar failas buvo. */
export const processLifecycleFs: ProcessLifecycleFsPort = {
  readTextFileIfExists: (absolutePath) => nodeFsAdapter.readTextFileIfExists(absolutePath),
  writeTextFile: (absolutePath, content) => nodeFsAdapter.writeTextFile(absolutePath, content),
  writeTextFileAtomic: (absolutePath, content) => nodeFsAdapter.writeTextFileAtomic(absolutePath, content),
  makeDirectory: (absoluteDir) => nodeFsAdapter.makeDirectory(absoluteDir),
  /**
   * `true` reiškia „failas BUVO ir jį pašalinome".
   *
   * Skirtumas nuo „nesamo failo" yra esminis: `loop-stop.requested` yra VĖLIAVA, kurią loop'as
   * suvartoja. Jei šalinimas grąžintų `true` ir tada, kai failo nebuvo, du loop'o ratai
   * suvartotų tą patį sustabdymo prašymą dukart.
   */
  removeFileIfExists: async (absolutePath) => {
    if (!(await nodeFsAdapter.exists(absolutePath))) return false;
    await nodeFsAdapter.removeIfExists(absolutePath);
    return true;
  },
};

/** Loop runtime įrašo portai (PID + šviežias heartbeat). */
export const loopRuntimePorts: LoopRuntimePorts = {
  fs: {
    exists: (absolutePath) => nodeFsAdapter.exists(absolutePath),
    readTextFileIfExists: (absolutePath) => nodeFsAdapter.readTextFileIfExists(absolutePath),
    writeTextFile: (absolutePath, content) => nodeFsAdapter.writeTextFile(absolutePath, content),
    makeDirectory: (absoluteDir) => nodeFsAdapter.makeDirectory(absoluteDir),
    fileMtimeMs: (absolutePath) => nodeFsAdapter.fileMtimeMs(absolutePath),
    removeIfExists: (absolutePath) => nodeFsAdapter.removeIfExists(absolutePath),
  },
  processIsAlive: (pid) => isProcessAlive(pid),
};

/**
 * Paleidžia atsietą vaiką su TUO PAČIU node ir TUO PAČIU CLI įėjimu.
 *
 * `stdio: "ignore"`: vaiko srautai neprijungiami prie tėvo — kitaip UI procesas laikytų atvirus
 * deskriptorius ir jo užbaigimas užstrigtų laukdamas loop'o, kuris gyvuoja valandas.
 */
function spawnDetachedCli(projectRoot: string, args: string[], env?: NodeJS.ProcessEnv): SpawnedProcess {
  const child = spawn(process.execPath, [cliEntryPath(), ...args], {
    cwd: projectRoot,
    detached: true,
    stdio: "ignore",
    windowsHide: true,
    ...(env === undefined ? {} : { env: { ...process.env, ...env } }),
  });

  let exited = false;
  child.on("exit", () => (exited = true));
  child.on("error", () => (exited = true));

  return {
    pid: child.pid,
    // Handle'as, ne PID: PID'ai perpanaudojami, ir svetimas procesas tuo pačiu numeriu
    // atrodytų kaip mūsų vaikas.
    isRunning: () => !exited && child.exitCode === null && child.signalCode === null,
    detach: () => child.unref(),
  };
}

export type UiLifecycleAdapterInput = {
  projectRoot: string;
  runtimeRoot: string;
  /** Loop įėjimo komanda; nenurodžius — `loop`. */
  loopCommand?: string;
  /**
   * Kur keliauja paleidimo pranešimai. Be jo `ensureUiRunning` krenta į `consoleHookIo`, tad
   * `verqestra loop` eilutė apie UI aplenktų komandos savo kanalą.
   */
  io?: HookIo;
};

/**
 * Loop ir UI procesų portai vienu pjūviu.
 *
 * Abu vaikai gauna `AG_UI_AUTOSTART=0` (etalonas: `ui/{loop,ui}-service.ts`). Tai ne atsargumas:
 * `verqestra loop` nuo 2026-08-24 pats pakelia dashboard'ą, tad be šios vėliavos UI paleistas
 * loop'as bandytų pakelti DAR VIENĄ UI, o kiekvienas naujas vaikas kartotų tą patį. Vėliava
 * paveldima toliau, tad ji uždaro visą grandinę, ne vieną pakopą.
 */
export function processLifecyclePorts(input: UiLifecycleAdapterInput): ProcessLifecyclePorts {
  return {
    fs: processLifecycleFs,
    runtime: loopRuntimePorts,
    spawnLoop: () =>
      Promise.resolve(
        spawnDetachedCli(input.projectRoot, [input.loopCommand ?? "loop"], { [UI_AUTOSTART_ENV]: "0" }),
      ),
    // Prievadas perduodamas ENV, o ne argumentu: taip UI įėjimas lieka toks pat kaip rankinis,
    // ir operatoriaus paleista komanda nesiskiria nuo UI paleistos.
    spawnUi: (port) =>
      Promise.resolve(
        spawnDetachedCli(input.projectRoot, ["ui"], { AG_UI_PORT: String(port), [UI_AUTOSTART_ENV]: "0" }),
      ),
    processIsAlive: (pid) => isProcessAlive(pid),
    env: (name) => process.env[name],
    ...(input.io === undefined ? {} : { io: input.io }),
  };
}

/** Minimalus pjūvis, kurio reikia rebuild vaikui: leidžia testams stub'inti `spawn` be viso `ChildProcess`. */
export type UiRebuildOutputStream = { on(event: "data", listener: (chunk: Buffer) => void): unknown } | null;
export type UiRebuildSpawnedChild = {
  pid?: number | undefined;
  stdout: UiRebuildOutputStream;
  stderr: UiRebuildOutputStream;
  on(event: "exit", listener: (code: number | null) => void): unknown;
  on(event: "error", listener: (error: Error) => void): unknown;
  unref(): unknown;
};
export type UiRebuildSpawnFn = (
  command: string,
  args: readonly string[],
  options: SpawnOptions,
) => UiRebuildSpawnedChild;

/**
 * Paleidžia `UI_REBUILD_COMMAND`/`UI_REBUILD_ARGS` (etalonas: `run-process.ts#runProcess`
 * Windows .cmd/.bat pastaba — Node ≥18.20/20.12/22 atsisako spawn'inti `.cmd` tiesiogiai
 * (CVE-2024-27980), o `shell: true` savo ruožtu neescape'ina argumentų (DEP0190). Saugu — per
 * `cmd.exe /d /s /c`, kur args lieka atskiri argv elementai.
 *
 * Skirtingai nuo `spawnDetachedCli`, čia reikia IŠVESTIES: `failed` baigtis operatoriui neturėtų
 * ką parodyti be jos. Buferis apkarpomas iki `UI_REBUILD_OUTPUT_TAIL_MAX_CHARS` — tiek pat, kiek
 * `ui-rebuild.ts` vis tiek nukirstų prieš rašydamas įrašą, tad platesnis buferis nieko neduotų.
 *
 * `spawnFn` INJEKUOJAMAS (numatyta — tikras `spawn`): produkcijoje visada tikras procesas, o
 * testas paduoda stub'ą, kad `pnpm --dir ui-app build` niekada realiai nepasileistų.
 */
export function spawnUiRebuildProcess(projectRoot: string, spawnFn: UiRebuildSpawnFn = spawn): UiRebuildProcess {
  const resolvedCommand = packageManagerExecutable(UI_REBUILD_COMMAND);
  const isWindowsBatch = process.platform === "win32" && /\.(cmd|bat)$/i.test(resolvedCommand);
  const spawnCommand = isWindowsBatch ? "cmd.exe" : resolvedCommand;
  const spawnArgs = isWindowsBatch ? ["/d", "/s", "/c", resolvedCommand, ...UI_REBUILD_ARGS] : [...UI_REBUILD_ARGS];

  const child = spawnFn(spawnCommand, spawnArgs, {
    cwd: projectRoot,
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });

  let exited = false;
  let output = "";
  const appendOutput = (chunk: Buffer): void => {
    output += chunk.toString("utf8");
    if (output.length > UI_REBUILD_OUTPUT_TAIL_MAX_CHARS) {
      output = output.slice(-UI_REBUILD_OUTPUT_TAIL_MAX_CHARS);
    }
  };
  child.stdout?.on("data", appendOutput);
  child.stderr?.on("data", appendOutput);

  const exitCallbacks: Array<(exit: UiRebuildExit) => void | Promise<void>> = [];
  const finish = (code: number | null): void => {
    if (exited) return;
    exited = true;
    const exit: UiRebuildExit = { code, tail: output };
    for (const callback of exitCallbacks) void callback(exit);
  };
  child.on("exit", (code) => finish(code));
  child.on("error", () => finish(null));

  return {
    pid: child.pid,
    isRunning: () => !exited,
    detach: () => child.unref(),
    onExit: (callback) => exitCallbacks.push(callback),
  };
}

/**
 * UI bundle rebuild portai (task 058-4): komanda fiksuota `ui-rebuild.ts`, čia — tik jos
 * paleidimas. `spawnFn` antras argumentas egzistuoja TIK testams — produkcinis kvietėjas
 * (`router-adapters.ts`) jo niekada nepaduoda, tad gauna tikrą `spawn`.
 */
export function uiRebuildProcessPorts(
  input: UiLifecycleAdapterInput,
  spawnFn?: UiRebuildSpawnFn,
): UiRebuildProcessPorts {
  return {
    fs: processLifecycleFs,
    spawnUiRebuild: () =>
      Promise.resolve(
        spawnFn === undefined
          ? spawnUiRebuildProcess(input.projectRoot)
          : spawnUiRebuildProcess(input.projectRoot, spawnFn),
      ),
    processIsAlive: (pid) => isProcessAlive(pid),
  };
}

// `lifecycleStateDir` ištrintas 2026-08-24: be kvietėjo, o `path.join(runtimeRoot, "state")` ir
// taip įrašytas ~20 vietų. Pagundos „tegul lieka, kada nors prijungsim" čia nėra — helper'is
// gyveno `composition/ui`, tad `interfaces` ir `infrastructure` sluoksniai jo apskritai negali
// importuoti. Bendras `vq/state` kelio helper'is yra atskiras darbas, ir jo namai — ne čia.
