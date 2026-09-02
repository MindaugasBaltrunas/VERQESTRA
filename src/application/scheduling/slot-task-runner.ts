// Slot'o VYKDYTOJAS (etalonas: AG_loop orchestrator/loop/slot-task-runner.ts sprendimų dalis).
//
// Vienintelis šio modulio sprendimas — KURIUO KELIU vykdyti bangos slot'ą:
//   - slot'as be `worktree_path` (pirminis) eina in-process keliu: baitas į baitą tas pats
//     vykdymas, koks yra be jokio paralelizmo;
//   - slot'as su `worktree_path` vykdomas VAIKO procesu, kurio darbo katalogas yra ta kopija.
//     Du medžiai viename procese neįmanomi (proceso šaknis yra konstanta), o in-process vykdymas
//     pirminiame medyje su gyvu paties slot'o lease užsirakintų `foreign-lease` klaida.
//
// NUOSAVYBĖS vartai prieš vaiko paleidimą yra keturi, ir kiekvienas jų fail-closed:
//   1. lease store perskaitomas (neperskaitytas store nėra „nėra lease");
//   2. `lease_id` sutampa su slot'o nešamu — slot'as neša tik IDENTIFIKATORIŲ, o įrodymas
//      (fencing token) VISADA imamas iš store skaitymo;
//   3. lease priklauso TAM PAČIAM task'ui ir tebėra `held`;
//   4. heartbeat'as praeina — jis vienu ėjimu ir patvirtina nuosavybę, ir atnaujina TTL, tad
//      vaiko gyvenimo langas prasideda būtent dabar ir lygiagretus reaper'is neturi ko nupjauti.
//
// PENKTAS vartas yra vaiko task failas kopijoje (`ensureTaskFileInWorktree`). Jis egzistuoja dėl
// FS↔git lenktynių: planuoklė task'ą pačiumpa nuo DISKO (`AG/tasks/queue`), o kopija gimsta iš git
// HEAD, kuriame to dar neužcommitinto failo nėra. Be varto vaikas miršta ENOENT/exit 74, ir
// `worker-integration` tokią baigtį parkuoja kaip `task-failed` — kaltė tenka task'ui, nors
// priežastis yra aprūpinimas.
//
// Kiekviena nesėkmė yra ĮVARDINTA `WAVE SLOT FAILED` eilutė ir sąžininga `ok=false` baigtis, o ne
// metimas: metimas nutrauktų visą bangą, nors kitas lane'as dirba nepriklausomai.
//
// Lease atlaisvinamas po KIEKVIENOS terminalinės baigties (`finally`): `held` lease su senu
// task'u užrakintų šį worker'į visam run'ui. Atlaisvinimo klaida NIEKADA neuždengia vaiko
// rezultato — tik žurnalo eilutė.

import { LEASE_ENV } from "./worker-lease-runtime.js";
import type { AttemptRef } from "./worker-limits.js";
import type { WorkerLease, WorkerLeaseClaim } from "../../domain/scheduling/worker-lease-rules.js";
import { leaseClaimOf } from "../../domain/scheduling/worker-lease-rules.js";

/** CLI komanda, kuria loop'as paleidžia vaiką-vykdytoją. */
export const PROCESS_QUEUED_TASK_COMMAND = "process-queued-task";

/**
 * Struktūrinis slot kontraktas. SĄMONINGAI ne `WaveDispatchSlot` importas: dispatch'as žino apie
 * vykdytoją, tad importas atgal uždarytų ciklą. `WaveDispatchSlot` šiam tipui priskiriamas
 * struktūriškai, be jokio adapterio.
 */
export type SlotTaskRunnerSlot = {
  worker_id: string;
  task_id: string;
  /** Repo-reliatyvus task failas — vaikas jį išsprendžia prieš SAVO darbo katalogą. */
  file: string;
  absoluteFile: string;
  worktree_path?: string;
  /** Pool'o išduoto lease ID. Tik identifikatorius — įrodymas imamas iš store. */
  lease_id?: string;
  /** Slot'o `run/worker/task/attempt` tapatybė; vaikui ji injektuojama, ne paveldima. */
  attempt_ref?: AttemptRef;
};

/** Nuosavybės mutacijos baigtis; `denied` visada turi priežastį. */
export type SlotLeaseMutation = { status: "ok" } | { status: "denied"; reason: string };

/**
 * Task failo vartų baigtis kopijoje. `missing` VISADA turi priežastį: vartas, kurio atsisakymas
 * neįvardintas, operatoriui atrodo kaip task'o kaltė, o būtent tai šis vartas ir uždaro.
 */
export type SlotTaskFileAvailability = { status: "ok" } | { status: "missing"; reason: string };

export type SlotTaskRunnerPorts = {
  log: (message: string) => Promise<void>;
  /** Esamas in-process kelias — slot'ai be kopijos eina TIK juo. */
  runInProcess: (absoluteFile: string) => Promise<boolean>;
  /** Vaiko paleidimas jo kopijoje; `true` = exit code 0. */
  runChild: (slot: SlotTaskRunnerSlot, worktreeAbs: string) => Promise<boolean>;
  /** Absoliutus kopijos kelias iš repo-reliatyvaus; kelio aritmetika lieka kompozicijoje. */
  resolveWorktree: (worktreePath: string) => string;
  readLease: (workerId: string) => Promise<WorkerLease | undefined>;
  /** Nuosavybės verifikacija + TTL atnaujinimas vienu ėjimu. */
  heartbeat: (claim: WorkerLeaseClaim, workerId: string) => Promise<SlotLeaseMutation>;
  release: (claim: WorkerLeaseClaim, workerId: string) => Promise<SlotLeaseMutation>;
  /** Kopijos runtime paruošimas (dist, junction'ai, konfigas, produkto deps). */
  prepareWorktree: (worktreeAbs: string) => Promise<void>;
  /**
   * Vaiko task failo vartai kopijoje. Portas yra ENSURE, ne CHECK: trūkstamas failas atkuriamas
   * DETERMINISTIŠKAI iš `slot.absoluteFile`, nes tas pats baitų turinys jau guli pirminiame medyje —
   * čia nėra ko spėti. Atidėjimas be atkūrimo būtų brangesnis sprendimas tam pačiam faktui.
   *
   * Atkurta kopija vaiko švaraus medžio vartų NEKERTA: `AG/tasks/**` yra RUNTIME kelias
   * (`isRuntimePath`), tad `nonRuntimeDirtyPaths` jos nemato nei kopijos inspekcijoje, nei
   * integracijos vartuose — untracked task failas ten nėra „neužcommitintas produkto darbas".
   *
   * Realizacija klaidas RYJA į `missing` su priežastimi; metimas čia būtų bangos nutraukimas.
   *
   * OPCIONALUS SĄMONINGAI: surišimas ateina atskiru task'u, o in-process kelias porto nekviečia
   * niekada — jis dirba pirminiame medyje, kuriame failas jau yra.
   */
  ensureTaskFileInWorktree?: (slot: SlotTaskRunnerSlot, worktreeAbs: string) => Promise<SlotTaskFileAvailability>;
};

/**
 * Loop proceso runtime konteksto raktai, kurių vaikas NIEKADA nepaveldi aklai.
 *
 * `AG_RUN_ID`/`AG_ATTEMPT_ID`/`AG_WORKER_ID` skaito attempt namespace'o išvedimas — paveldėtos
 * loop'o reikšmės perimtų vaiko namespace'ą. `AG_DISPATCH_NONCE` turi realią lenktynę: in-process
 * dispatch'as jį laikinai mutuoja per proceso env, tad aplinkos nuotrauka vaiko paleidimo momentu
 * nutekintų SVETIMĄ nonce į vaiko stop-evidence palyginimus.
 */
export const CHILD_ENV_RUNTIME_CONTEXT_KEYS = ["AG_RUN_ID", "AG_ATTEMPT_ID", "AG_WORKER_ID", "AG_DISPATCH_NONCE"] as const;

/**
 * Vaiko aplinka: bazinė BE nė vieno lease claim rakto, BE loop'o runtime konteksto raktų, su
 * projekto katalogu, rodančiu į kopiją, ir su SĄMONINGA slot'o tapatybės injekcija.
 *
 * Claim env vaikui NEPERDUODAMAS: vaiko šaknis yra kopija, kurios lease store neturi — paveldėtas
 * claim ten taptų fail-closed atmetimu visur. Dalinis claim (pvz. tik lease ID) irgi būtų klaida,
 * todėl valomi VISI raktai, ne tik pilnas rinkinys.
 *
 * Tapatybė INJEKTUOJAMA, ne paveldima: su aklai išvalytu env vaiko attempt namespace'as liktų
 * tuščias, ir vaikas kristų dar prieš darbą. Be `attempt_ref` raktai lieka tiesiog išvalyti.
 */
export function buildChildEnvironment(
  baseEnv: NodeJS.ProcessEnv,
  projectDirKey: string,
  worktreeAbs: string,
  attemptRef?: AttemptRef,
): NodeJS.ProcessEnv {
  const stripped = new Set<string>([...Object.values(LEASE_ENV), ...CHILD_ENV_RUNTIME_CONTEXT_KEYS]);
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(baseEnv)) {
    if (!stripped.has(key)) env[key] = value;
  }
  // Loop procesas šį raktą turi nusistatęs į PIRMINĮ medį — be perrašymo vaikas rašytų ten.
  env[projectDirKey] = worktreeAbs;
  if (attemptRef !== undefined) {
    env["AG_RUN_ID"] = attemptRef.runId;
    env["AG_WORKER_ID"] = attemptRef.workerId;
    env["AG_ATTEMPT_ID"] = attemptRef.attemptId;
  }
  return env;
}

export function createSlotTaskRunner(ports: SlotTaskRunnerPorts): (slot: SlotTaskRunnerSlot) => Promise<boolean> {
  const fail = async (slot: SlotTaskRunnerSlot, reason: string): Promise<false> => {
    await ports.log(`WAVE SLOT FAILED: slot=${slot.worker_id} task=${slot.task_id} error=${reason}`);
    return false;
  };

  /** Nuosavybės vartai. Grąžina claim'ą arba ĮVARDINTĄ atsisakymo priežastį. */
  const verifyOwnership = async (slot: SlotTaskRunnerSlot): Promise<WorkerLeaseClaim | string> => {
    let lease: WorkerLease | undefined;
    try {
      lease = await ports.readLease(slot.worker_id);
    } catch (error) {
      // Neperskaitytas store NĖRA „lease nėra": tai nežinia, o nežinia čia reiškia „ne".
      return `lease store neperskaitomas worker'iui ${slot.worker_id}: ${describe(error)}`;
    }
    if (lease === undefined) return `lease worker'iui ${slot.worker_id} neegzistuoja store`;
    if (slot.lease_id === undefined || lease.lease_id !== slot.lease_id) {
      return `lease_id mismatch: store=${lease.lease_id} slot=${slot.lease_id ?? "<none>"}`;
    }
    // TIKSLUS lyginimas, be normalizacijos: aprūpinimo vartas lygina tiksliai, o lease `task_id`
    // rašomas verbatim iš to paties grafo id — tolerancija čia nieko neperka, o nuosavybės vartas
    // privalo būti griežčiausias.
    if (lease.task_id !== slot.task_id) return `lease-task-mismatch: lease ${lease.lease_id} yra task'ui ${lease.task_id}`;
    if (lease.status !== "held") return `lease ${lease.lease_id} status=${lease.status}, ne 'held'`;

    const claim = leaseClaimOf(lease);
    const renewed = await ports.heartbeat(claim, slot.worker_id);
    return renewed.status === "ok" ? claim : `lease heartbeat denied: ${renewed.reason}`;
  };

  /**
   * Task failo vartai. Nepririštas portas reiškia `ok`: opcionalus portas negali paversti
   * nepakeisto surišimo nauja gedimo klase.
   */
  const ensureTaskFile = async (slot: SlotTaskRunnerSlot, worktreeAbs: string): Promise<SlotTaskFileAvailability> => {
    const ensure = ports.ensureTaskFileInWorktree;
    if (ensure === undefined) return { status: "ok" };
    try {
      return await ensure(slot, worktreeAbs);
    } catch (error) {
      // Kontraktas metimo nenumato, bet vartas lieka fail-closed: nežinia čia reiškia „ne".
      return { status: "missing", reason: `vartai krito: ${describe(error)}` };
    }
  };

  return async (slot: SlotTaskRunnerSlot): Promise<boolean> => {
    // Pirminis slot'as: jokių lease ar kopijos žingsnių — tas pats kelias kaip be paralelizmo.
    if (slot.worktree_path === undefined) return await ports.runInProcess(slot.absoluteFile);

    const verified = await verifyOwnership(slot);
    if (typeof verified === "string") return await fail(slot, verified);

    const worktreeAbs = ports.resolveWorktree(slot.worktree_path);
    try {
      // Task failo vartai eina PRIEŠ bootstrap'ą: jie kainuoja vieną FS operaciją, o bootstrap'as —
      // dist junction'us ir produkto diegimą. Pripažintos lenktynės (failas buvo tik pirminiame
      // medyje) čia baigiasi atkūrimu ir `ok`, tad vaikas paleidžiamas kaip iki šiol; `missing`
      // pasiekiamas tik tada, kai failo NĖRA IR pirminiame medyje — tai jau ne lenktynės.
      const taskFile = await ensureTaskFile(slot, worktreeAbs);
      if (taskFile.status === "missing") return await fail(slot, `task-file-missing: ${taskFile.reason}`);

      try {
        await ports.prepareWorktree(worktreeAbs);
      } catch (error) {
        return await fail(slot, `worktree runtime bootstrap nepavyko: ${describe(error)}`);
      }
      return await ports.runChild(slot, worktreeAbs);
    } finally {
      try {
        const released = await ports.release(verified, slot.worker_id);
        if (released.status !== "ok") {
          await ports.log(
            `WAVE SLOT LEASE RELEASE DENIED: worker=${slot.worker_id} lease=${verified.lease_id}: ${released.reason}`,
          );
        }
      } catch (error) {
        await ports.log(
          `WAVE SLOT LEASE RELEASE FAILED: worker=${slot.worker_id} lease=${verified.lease_id}: ${describe(error)}`,
        );
      }
    }
  };
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
