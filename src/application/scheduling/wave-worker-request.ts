// Bangos worker PRAŠYMO skaitytuvas (etalonas: AG_loop
// orchestrator/loop/loop-wave-worker-request.ts).
//
// Sprendimo taisyklė gyvena `resolveWorkerRequest` (gryna). Čia lieka vienintelis dalykas, kurio
// ji turėti negali — ATMINTIS: paskutinė įrašyta eilutė, kad tas pats „WORKER REQUEST: ..." nebūtų
// kartojamas kiekvienoje bangoje. Be jos operatoriaus žurnalas prisipildytų nepakitusios būsenos.

import { resolveWorkerRequest } from "./wave-inputs.js";
import type { LoopControlState } from "./loop-control-store.js";

export type WaveWorkerRequestDeps = {
  /** Operatoriaus prašymas ir, jei buvo, netinkamos reikšmės vardas. */
  readRequest: () => Promise<{ requested: number | undefined; invalid?: string | undefined }>;
  readControl: () => Promise<LoopControlState>;
  log: (message: string) => Promise<void>;
};

/** Vienas efektyvus slot'ų skaičius bangai; žurnalo eilutė rašoma tik pasikeitusi. */
export function createWaveWorkerRequestReader(deps: WaveWorkerRequestDeps): () => Promise<number> {
  let lastLogged: string | undefined;

  return async (): Promise<number> => {
    const request = await deps.readRequest();
    const resolution = resolveWorkerRequest({
      requested: request.requested,
      control: await deps.readControl(),
      ...(request.invalid === undefined ? {} : { invalidRequest: request.invalid }),
      ...(lastLogged === undefined ? {} : { lastLogged }),
    });
    if (resolution.line !== undefined) {
      lastLogged = resolution.line;
      await deps.log(resolution.line);
    }
    return resolution.effective;
  };
}
