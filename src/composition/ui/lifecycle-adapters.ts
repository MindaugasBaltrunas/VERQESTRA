// UI ir loop procesų gyvavimo ciklo adapteriai (manual DI, LAY-2).
//
// Šis failas paleidžia ATSKIRUS, ILGAI GYVENANČIUS procesus — loop'ą ir UI serverį. Iš to
// plaukia dvi savybės, kurios yra kontraktas:
//   1. vaikas ATSIEJAMAS (`detached` + `unref`): UI mygtukas „paleisti loop'ą" negali reikšti,
//      kad loop'as miršta kartu su naršyklės sesiją aptarnavusiu procesu;
//   2. gyvybė tikrinama per PROCESO HANDLE (`isRunning`), o ne per PID sąrašą: PID'ai
//      perpanaudojami, ir svetimas procesas tuo pačiu numeriu atrodytų kaip mūsų loop'as.

import { spawn } from "node:child_process";
import type {
  ProcessLifecycleFsPort,
  ProcessLifecyclePorts,
  SpawnedProcess,
} from "../../interfaces/http/process-lifecycle-ports.js";
import { UI_AUTOSTART_ENV } from "../../interfaces/http/ui-lifecycle.js";
import type { HookIo } from "../../interfaces/hooks/protocol.js";
import type { LoopRuntimePorts } from "../../interfaces/hooks/loop-runtime-store.js";
import { nodeFsAdapter } from "../../infrastructure/fs/node-fs-adapter.js";
import { isProcessAlive } from "../../infrastructure/process/process-tree.js";
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

// `lifecycleStateDir` ištrintas 2026-08-24: be kvietėjo, o `path.join(runtimeRoot, "state")` ir
// taip įrašytas ~20 vietų. Pagundos „tegul lieka, kada nors prijungsim" čia nėra — helper'is
// gyveno `composition/ui`, tad `interfaces` ir `infrastructure` sluoksniai jo apskritai negali
// importuoti. Bendras `vq/state` kelio helper'is yra atskiras darbas, ir jo namai — ne čia.
