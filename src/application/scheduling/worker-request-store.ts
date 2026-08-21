// KIEK workerių operatorius prašo paleisti bangoje (etalonas: AG_loop ui/worker-request-service.ts,
// task 0051).
//
// Modulis atsako TIK už prašymo skaitymą ir rašymą — sprendimą „kiek slot'ų realiai išduoti"
// priima worker pool'as su izoliacijos vartais. Prašymas ≠ leidimas.
//
// VERQESTRA nukrypimas: modulis gyvena application, ne ui sluoksnyje — prašymą skaito banga, o ne
// tik dashboard'as (ta pati priežastis kaip `loop-control-store`).
//
// Prašymas gyvena `vq/state/worker-request.json`, o ne `vq/config/`: `vq/state` yra runtime
// prefiksas, tad UI įrašas nepalieka purvino produkto medžio.
//
// Pirmenybė sąmoningai tokia: aplinkos kintamasis > failas > numatytasis. Aplinka laimi todėl, kad
// ją nustato procesą PALEIDĘS operatorius; tokiu atveju valdiklis pasako, kad reikšmė ateina iš
// aplinkos, užuot tyliai rašęs failą, kurio niekas neskaitys.

import path from "node:path";
import { z } from "zod";
import { toPrettyJson } from "../../shared/json.js";
import type { SchedulingFileSystemPort } from "./ports.js";
import { clampWaveWorkers } from "./schedule-next-wave.js";

/** Aplinkos kintamasis, kuriuo operatorius prašo antro workerio. */
export const REQUESTED_WORKERS_ENV = "AG_MAX_WORKERS";

export const workerRequestSchema = z.strictObject({
  requested: z.number().int().min(1).max(2),
});

export function workerRequestFile(stateDir: string): string {
  return path.join(stateDir, "worker-request.json");
}

/** Kodėl prašymo failas nepanaudotas. KODAS, o ne žinutė (žr. `loop-control-store`). */
export type WorkerRequestProblem = "unreadable" | "malformed" | "schema";

export type WorkerRequestState = {
  /** Jau apkirpta reikšmė — vienintelis skaičius, kurį verta rodyti. */
  requested: number;
  source: "env" | "state" | "default";
  /** `true` kai reikšmę diktuoja aplinka, tad ekrano valdiklis nieko pakeisti negali. */
  envOverride: boolean;
  /** Užpildoma TIK kai failas yra, bet nepanaudojamas. */
  invalid?: WorkerRequestProblem | undefined;
};

/** Prašymas, kurio priimti negalima (ne sveikasis skaičius arba už ribų). */
export class InvalidWorkerRequestError extends Error {}

export type WorkerRequestDeps = {
  fs: SchedulingFileSystemPort;
  env?: (name: string) => string | undefined;
};

/**
 * Einamasis prašymas. NIEKADA nemeta: kelias kviečiamas kiekvienos bangos pradžioje, tad sugadintas
 * ar dingęs failas privalo reikšti „numatytas vienas workeris", o ne nutrūkusį loop'ą.
 */
export async function readWorkerRequest(deps: WorkerRequestDeps, stateDir: string): Promise<WorkerRequestState> {
  // Override'u laikoma tik SKAITOMA aplinkos reikšmė. Šiukšlė (`AG_MAX_WORKERS=nope`) nėra
  // prašymas — ji yra rašybos klaida, ir laikyti ją override'u reikštų tyliai užrakinti valdiklį bei
  // rodyti „reikšmę valdo aplinka", nors realiai nevaldo niekas. Tokiu atveju krentame į failą,
  // t. y. į paskutinį SĄMONINGĄ operatoriaus pasirinkimą.
  const fromEnv = deps.env?.(REQUESTED_WORKERS_ENV)?.trim();
  if (fromEnv) {
    const parsed = Number(fromEnv);
    if (Number.isFinite(parsed)) {
      return { requested: clampWaveWorkers(parsed), source: "env", envOverride: true };
    }
  }

  const fallback: WorkerRequestState = {
    requested: clampWaveWorkers(undefined),
    source: "default",
    envOverride: false,
  };

  let raw: string | undefined;
  try {
    raw = await deps.fs.readTextFileIfExists(workerRequestFile(stateDir));
  } catch {
    return { ...fallback, invalid: "unreadable" };
  }
  if (!raw?.trim()) return fallback;

  let payload: unknown;
  try {
    payload = JSON.parse(raw);
  } catch {
    return { ...fallback, invalid: "malformed" };
  }

  const result = workerRequestSchema.safeParse(payload);
  if (!result.success) return { ...fallback, invalid: "schema" };
  return { requested: clampWaveWorkers(result.data.requested), source: "state", envOverride: false };
}

/**
 * Įrašo naują prašymą.
 *
 * Priimamas VISAS užklausos kūnas, o ne vien reikšmė: tik taip `.strict()` realiai gina kontraktą.
 * Netinkamas kūnas META ir failo NEKEIČIA: kvietėjas turi grąžinti 400, o ne tyliai apkirpti —
 * apkirptas „5" atrodytų kaip priimtas prašymas.
 */
export async function setRequestedWorkers(
  deps: WorkerRequestDeps,
  stateDir: string,
  body: unknown,
): Promise<WorkerRequestState> {
  const parsed = workerRequestSchema.safeParse(body);
  if (!parsed.success) {
    throw new InvalidWorkerRequestError(parsed.error.issues.map((issue) => issue.message).join("; "));
  }
  await deps.fs.makeDirectory(stateDir);
  await deps.fs.writeTextFileAtomic(workerRequestFile(stateDir), toPrettyJson(parsed.data));
  return await readWorkerRequest(deps, stateDir);
}
