// Bendri loop ir UI paleidimo portai (etalonas: AG_loop ui/{loop-service,ui-service}.ts).
//
// VERQESTRA nukrypimas: `spawn`, failų deskriptoriai ir dist keliai NEGYVENA interfaces
// sluoksnyje — jie ateina per portą, o kompozicija juos suriša. Vaiko GYVUMAS lieka
// autoritetingas (`isRunning`), nes turint proceso handle'ą tai tikslesnis atsakymas nei PID
// patikra: po OS PID pernaudojimo `pidIsRunning` amžinai atsakinėtų „veikia" apie svetimą procesą.

import type { LoopRuntimePorts } from "../hooks/loop-runtime-store.js";
import type { HookIo } from "../hooks/protocol.js";

/** Paleistas vaikas. `isRunning` remiasi proceso handle'u, ne PID sąrašu. */
export type SpawnedProcess = {
  pid?: number | undefined;
  isRunning(): boolean;
  /** Leidžia tėvui baigtis nepriklausomai nuo vaiko. */
  detach(): void;
};

export type ProcessLifecycleFsPort = {
  readTextFileIfExists(absolutePath: string): Promise<string | undefined>;
  writeTextFile(absolutePath: string, content: string): Promise<void>;
  writeTextFileAtomic(absolutePath: string, content: string): Promise<void>;
  makeDirectory(absoluteDir: string): Promise<void>;
  /** `true`, kai failas BUVO ir buvo pašalintas. Skirtumas svarbus vėliavos suvartojimui. */
  removeFileIfExists(absolutePath: string): Promise<boolean>;
};

export type ProcessLifecyclePorts = {
  fs: ProcessLifecycleFsPort;
  /** Runtime įrašo saugykla (VQ-502 6/6-a): PID + šviežias heartbeat. */
  runtime: LoopRuntimePorts;
  /** Loop proceso paleidimas; klaida META — kvietėjas ją paverčia `failed` baigtimi. */
  spawnLoop(): Promise<SpawnedProcess>;
  /** UI serverio paleidimas nurodytu portu. */
  spawnUi(port: number): Promise<SpawnedProcess>;
  processIsAlive(pid: number): boolean;
  env(name: string): string | undefined;
  now?: () => Date;
  io?: HookIo;
};
