// Worker lease — vieno vykdymo NUOSAVYBĖS grynos taisyklės. Lease atsako į vienintelį
// klausimą: „ar TAS procesas, kuris dabar bando mutuoti projektą, vis dar yra tas, kuriam
// šis task'as buvo patikėtas?". Trys kietos taisyklės: (1) fencing token monotoniškas ir
// įrašas niekada netrinamas; (2) fail-closed su pateiktu claim'u; (3) be lease runtime —
// `unmanaged` (backward-compatible). Persistencija, worktree ir proceso gyvumo IO — E3/E4.
// Behaviour etalon: AG_loop application/scheduling/worker-lease.ts grynoji pusė, pinned by
// scheduling-verdicts.json (VQ-003d): visi verdiktų reason tekstai yra BAITINIS kontraktas.

import { normalizeTaskReference } from "../tasks/dependencies.js";
import { normalizeScopeValue, scopeCovers } from "./scope-lock-rules.js";

export const WORKER_LEASE_SCHEMA_VERSION = 1;

/** Lease galiojimo trukmė. Trumpesnė nei tipinis dispatch, todėl heartbeat privalomas. */
export const DEFAULT_LEASE_TTL_MS = 15 * 60 * 1000;

/** Kiek laiko lease'o įrašas laikomas po atlaisvinimo (fencing skaitiklio atmintis). */
export const RELEASED_LEASE_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

export type WorkerLeaseStatus = "held" | "released";

/** Kam lease priklauso. `owner_id` yra PROCESO tapatybė — po restart'o ji visada nauja. */
export type WorkerLeaseIdentity = {
  owner_id: string;
  run_id: string;
  worker_id: string;
  task_id: string;
  attempt: number;
};

export type WorkerLease = WorkerLeaseIdentity & {
  schema_version: number;
  lease_id: string;
  status: WorkerLeaseStatus;
  /** Monotoniškai augantis skaitiklis šio worker_id vardu. Niekada nemažėja. */
  fencing_token: number;
  /** Izoliuota darbo kopija, kurią šis lease valdo (jei worktree runtime įjungtas). */
  worktree_path?: string;
  acquired_at: string;
  heartbeat_at: string;
  expires_at: string;
  released_at?: string;
  /** Perimto (stale) lease ID — audito pėdsakas, kad perėmimas nebūtų tylus. */
  superseded_lease_id?: string;
};

/**
 * Ką mutuojantis procesas PATEIKIA. Sąmoningai siauresnis už WorkerLease: procesas negali
 * įrodyti nuosavybės vien perpasakodamas lease turinį.
 */
export type WorkerLeaseClaim = {
  lease_id: string;
  owner_id: string;
  fencing_token: number;
  task_id?: string;
  attempt?: number;
};

export type RuntimeAuthorityStatus =
  | "unmanaged"
  | "authorized"
  | "lease-missing"
  | "lease-released"
  | "lease-expired"
  | "foreign-lease"
  | "stale-fencing-token"
  | "task-mismatch"
  | "attempt-mismatch";

export type RuntimeAuthority = {
  status: RuntimeAuthorityStatus;
  ok: boolean;
  reason: string;
  lease?: WorkerLease;
};

function toTime(value: string | undefined): number {
  if (!value) return Number.NaN;
  return new Date(value).getTime();
}

/** Pasibaigęs lease. Neperskaitoma `expires_at` reikšmė laikoma pasibaigusia (fail-closed). */
export function isLeaseExpired(lease: WorkerLease, now: Date): boolean {
  const expiresAt = toTime(lease.expires_at);
  if (Number.isNaN(expiresAt)) return true;
  return now.getTime() >= expiresAt;
}

/** Lease, kuris DABAR laiko nuosavybę: paimtas ir dar nepasibaigęs. */
export function isLeaseActive(lease: WorkerLease, now: Date): boolean {
  return lease.status === "held" && !isLeaseExpired(lease, now);
}

/** Lease → claim'as, kurį jo savininkas turi pateikti kiekvienai mutacijai. */
export function leaseClaimOf(lease: WorkerLease): WorkerLeaseClaim {
  return {
    lease_id: lease.lease_id,
    owner_id: lease.owner_id,
    fencing_token: lease.fencing_token,
    task_id: lease.task_id,
    attempt: lease.attempt,
  };
}

function sameTask(left: string | undefined, right: string | undefined): boolean {
  if (!left || !right) return true;
  return normalizeTaskReference(left) === normalizeTaskReference(right);
}

function authority(status: RuntimeAuthorityStatus, reason: string, lease?: WorkerLease): RuntimeAuthority {
  const ok = status === "authorized" || status === "unmanaged";
  return lease ? { status, ok, reason, lease } : { status, ok, reason };
}

/**
 * `loop-<pid>` savininko formos pid'as; kitokia forma gyvumo klausimo neatsako ir lieka
 * TTL kelyje (fail-closed).
 */
export function leaseOwnerLoopPid(ownerId: string): number | undefined {
  const match = /^loop-(\d+)$/.exec(ownerId);
  const captured = match?.[1];
  if (captured === undefined) return undefined;
  const pid = Number(captured);
  return Number.isInteger(pid) && pid > 0 ? pid : undefined;
}

/**
 * Vienintelis šaltinis tiesai „ar šio lease savininkas dar gyvas". GRYNA tik su paduotu
 * `isAlive` predikatu — domain sluoksnyje default'o NĖRA (proceso IO gyvena E4 adapteryje).
 * Neatpažinta owner forma grąžina false: nežinojimas apie savininką niekada nesuteikia
 * teisės ignoruoti jo lease'ą.
 */
export function isLeaseOwnerProcessDead(
  lease: Pick<WorkerLease, "owner_id">,
  isAlive: (pid: number) => boolean,
): boolean {
  const pid = leaseOwnerLoopPid(lease.owner_id);
  return pid !== undefined && !isAlive(pid);
}

/**
 * Ką konkrečiai gina vienas gyvas lease: jo izoliuota darbo kopija ir jo task'o
 * deklaruotas scope. `allowedPaths: undefined` = aprėptis NEIŠSPRĘSTA — lease gina visą
 * produkto medį (nežinojimas apie svetimą aprėptį nesuteikia teisės į ją rašyti).
 */
export type WorkerLeaseScope = {
  lease: WorkerLease;
  /** `worktree_path`, suvestas į repo-relative formą (kai jis yra šio medžio viduje). */
  worktreePath?: string;
  allowedPaths?: string[];
};

/**
 * Ar konkretus repo-relative kelias patenka į šio lease'o aprėptį. Glob semantika imama iš
 * scope-lock `scopeCovers` — TO PATIES šaltinio, kuriuo naudojasi lock'ai ir integracijos
 * ribų patikra. KIEKVIENA neaiškumo šaka grąžina true (fail-closed).
 */
export function leaseScopeCoversPath(scope: WorkerLeaseScope, repoRelativePath: string): boolean {
  let target: string;
  try {
    target = normalizeScopeValue(repoRelativePath);
  } catch {
    return true;
  }

  if (scope.worktreePath !== undefined && covers("directory", scope.worktreePath, target)) return true;
  if (!scope.allowedPaths || scope.allowedPaths.length === 0) return true;
  return scope.allowedPaths.some((allowed) => covers("glob", allowed, target));
}

/** Vieno scope tokeno patikra; neparsinamas tokenas (absoliutus, `..`, tuščias) gina viską. */
function covers(kind: "directory" | "glob", scopeValue: string, target: string): boolean {
  try {
    return scopeCovers({ kind, scope: normalizeScopeValue(scopeValue) }, target);
  } catch {
    return true;
  }
}

/**
 * Vienintelis vartas, per kurį eina KIEKVIENAS write, commit ir task-state perėjimas.
 * Su claim'u verdiktas remiasi tik store būsena (fail-closed). Be claim'o — `unmanaged`
 * tik kai NĖRA nė vieno aktyvaus lease'o, kuris galėtų būti pažeistas. `isOwnerProcessDead`
 * ir `isLeaseRelevant` yra grynumą išsaugančios injekcijos, veikiančios TIK claim'o
 * neturinčioje šakoje — claim'o fencing garantijos lieka baitas į baitą.
 */
export function authorizeRuntimeMutation(input: {
  leases: readonly WorkerLease[];
  claim?: WorkerLeaseClaim;
  taskId?: string;
  attempt?: number;
  now: Date;
  isOwnerProcessDead?: (lease: WorkerLease) => boolean;
  isLeaseRelevant?: (lease: WorkerLease) => boolean;
}): RuntimeAuthority {
  const { leases, claim, taskId, now } = input;
  const isOwnerProcessDead = input.isOwnerProcessDead ?? (() => false);
  const isLeaseRelevant = input.isLeaseRelevant ?? (() => true);

  if (claim) {
    const lease = leases.find((entry) => entry.lease_id === claim.lease_id);
    if (!lease) {
      return authority("lease-missing", `lease ${claim.lease_id} nebeegzistuoja worker lease store`);
    }
    if (lease.owner_id !== claim.owner_id) {
      return authority("foreign-lease", `lease ${lease.lease_id} priklauso ${lease.owner_id}, ne ${claim.owner_id}`, lease);
    }
    if (lease.fencing_token !== claim.fencing_token) {
      return authority(
        "stale-fencing-token",
        `pateiktas fencing token ${claim.fencing_token}, galiojantis yra ${lease.fencing_token}`,
        lease,
      );
    }
    if (lease.status === "released") {
      return authority("lease-released", `lease ${lease.lease_id} jau atlaisvintas`, lease);
    }
    if (isLeaseExpired(lease, now)) {
      return authority("lease-expired", `lease ${lease.lease_id} pasibaigė ${lease.expires_at}`, lease);
    }
    if (!sameTask(lease.task_id, taskId)) {
      return authority("task-mismatch", `lease ${lease.lease_id} yra task'ui ${lease.task_id}, ne ${taskId}`, lease);
    }
    if (input.attempt !== undefined && lease.attempt !== input.attempt) {
      return authority("attempt-mismatch", `lease ${lease.lease_id} yra attempt ${lease.attempt}, ne ${input.attempt}`, lease);
    }
    return authority("authorized", `lease ${lease.lease_id} galioja`, lease);
  }

  const active = leases.filter((lease) => isLeaseActive(lease, now) && sameTask(lease.task_id, taskId));

  // Gyvas svetimas lease gina savo APRĖPTĮ, ne visą medį: kelio negynantys lease'ai
  // iškrenta iš kandidatų dar prieš gyvumo klausimą.
  const contenders = active.filter(isLeaseRelevant);

  // Miręs savininkas veto teisės neturi; gyvo savininko lease elgesys nepakitęs.
  const blocking = contenders.find((lease) => !isOwnerProcessDead(lease));
  if (blocking) {
    return authority(
      "foreign-lease",
      `aktyvų lease ${blocking.lease_id} (task ${blocking.task_id}) laiko ${blocking.owner_id}; šis procesas claim'o nepateikė`,
      blocking,
    );
  }

  if (contenders.length > 0) {
    return authority(
      "unmanaged",
      `aktyvūs lease'ai (${contenders.length}) priklauso nebegyviems savininkams ` +
        `(${contenders.map((lease) => lease.owner_id).join(", ")}) — nuosavybė nebeginama`,
    );
  }

  // Aktyvių lease'ų yra, bet nė vienas negina šio kelio — priežastis įvardijama atskirai,
  // kad „aprėptis netaikoma" nebūtų neatskiriama nuo „lease runtime neįjungtas"; pirmas
  // aktyvus lease pridedamas kaip SIGNALAS, jog likę sluoksniai (scope lock) vis tiek
  // turi būti paklausti.
  const [firstActive] = active;
  if (firstActive) {
    return authority(
      "unmanaged",
      `aktyvūs lease'ai (${active.length}) gina kitą aprėptį ` +
        `(${active.map((lease) => `${lease.worker_id}:${lease.task_id}`).join(", ")}) — šis kelias į ją nepatenka`,
      firstActive,
    );
  }

  return authority("unmanaged", "aktyvių worker lease'ų nėra — lease runtime neįjungtas");
}

/** Kitas fencing token šiam worker'iui. Įrašo nebuvimas = pirmas token'as. */
export function nextFencingToken(previous: WorkerLease | undefined): number {
  const current = previous?.fencing_token;
  return Number.isInteger(current) && (current as number) > 0 ? (current as number) + 1 : 1;
}

/**
 * Heartbeat: pratęsia galiojimą NEKEIČIANT nei lease ID, nei fencing token'o. Pratęsti
 * galima tik dar galiojantį lease — pasibaigusio prikėlimas panaikintų perėmimo garantiją.
 */
export function renewWorkerLease(lease: WorkerLease, options: { now: Date; ttlMs?: number }): WorkerLease {
  if (lease.status !== "held") throw new Error(`Cannot renew a ${lease.status} worker lease`);
  if (isLeaseExpired(lease, options.now)) throw new Error(`Cannot renew expired worker lease ${lease.lease_id}`);
  const ttlMs = options.ttlMs ?? DEFAULT_LEASE_TTL_MS;
  return {
    ...lease,
    heartbeat_at: options.now.toISOString(),
    expires_at: new Date(options.now.getTime() + ttlMs).toISOString(),
  };
}

/** Atlaisvinimas: statusas keičiasi, ĮRAŠAS LIEKA — kitaip fencing skaitiklis prarastų atmintį. */
export function releasedWorkerLease(lease: WorkerLease, now: Date): WorkerLease {
  return { ...lease, status: "released", released_at: now.toISOString() };
}
