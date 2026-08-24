// Worker lease store — vieno vykdymo NUOSAVYBĖS persistencija (spec WRK-2/ISO-2/PAR-1,
// design §12). Behaviour etalon: AG_loop application/scheduling/worker-lease.ts store pusė
// (SPRENDIMO taisyklės — fencing, fail-closed claim'as, `unmanaged` legacy kelias — jau
// gyvena domain/scheduling/worker-lease-rules.ts ir čia NEdubliuojamos, FQC-12).
//
// Store: `vq/state/worker-leases/<worker>.json`. Runtime vartas (claim iš env, lease
// aprėptis iš task Markdown, reaper) — `worker-lease-runtime.ts` (500 eil. gate skaidymas).
// Git ir worktree darbas yra infrastructure pusėje (E4), kuri importuoja ŠIUOS tipus.

import { randomUUID } from "node:crypto";
import path from "node:path";
import {
  authorizeRuntimeMutation,
  isLeaseActive,
  releasedWorkerLease,
  renewWorkerLease,
  nextFencingToken,
  DEFAULT_LEASE_TTL_MS,
  WORKER_LEASE_SCHEMA_VERSION,
  type RuntimeAuthority,
  type WorkerLease,
  type WorkerLeaseClaim,
  type WorkerLeaseIdentity,
} from "../../domain/scheduling/index.js";
import { toPrettyJson } from "../../shared/json.js";
import { withOwnedLock, type OwnedLockTiming } from "../../shared/owned-lock.js";
import type { SchedulingClockPort, SchedulingFileSystemPort } from "./ports.js";
import { schedulingOwnedLockIo, systemSchedulingClock } from "./ports.js";
import { releaseScopeLocksInStore } from "./scope-lock-store.js";

export type WorkerLeaseStoreDeps = {
  fs: SchedulingFileSystemPort;
  clock?: SchedulingClockPort;
};

function clockOf(deps: WorkerLeaseStoreDeps): SchedulingClockPort {
  return deps.clock ?? systemSchedulingClock;
}

/** Naujas lease iš tapatybės. `fencingToken` privalo ateiti iš `nextFencingToken`. */
export function createWorkerLease(
  identity: WorkerLeaseIdentity,
  options: { now: Date; fencingToken: number; ttlMs?: number; leaseId?: string; worktreePath?: string; supersededLeaseId?: string },
): WorkerLease {
  const ttlMs = options.ttlMs ?? DEFAULT_LEASE_TTL_MS;
  if (!Number.isFinite(ttlMs) || ttlMs <= 0) throw new Error("Worker lease TTL must be a positive number of milliseconds");
  if (!Number.isInteger(options.fencingToken) || options.fencingToken < 1) {
    throw new Error("Worker lease fencing token must be a positive integer");
  }
  const acquiredAt = options.now.toISOString();
  return {
    schema_version: WORKER_LEASE_SCHEMA_VERSION,
    lease_id: options.leaseId ?? randomUUID(),
    status: "held",
    fencing_token: options.fencingToken,
    owner_id: identity.owner_id,
    run_id: identity.run_id,
    worker_id: identity.worker_id,
    task_id: identity.task_id,
    attempt: identity.attempt,
    ...(options.worktreePath ? { worktree_path: options.worktreePath } : {}),
    acquired_at: acquiredAt,
    heartbeat_at: acquiredAt,
    expires_at: new Date(options.now.getTime() + ttlMs).toISOString(),
    ...(options.supersededLeaseId ? { superseded_lease_id: options.supersededLeaseId } : {}),
  };
}

// ---------------------------------------------------------------------------
// Store (vq/state/worker-leases/<worker>.json)
// ---------------------------------------------------------------------------

const LEASE_DIR_NAME = "worker-leases";

/** Failo vardui saugus segmentas: jokių separatorių, jokio `..`, ribotas ilgis. */
export function safeLeaseSegment(value: string, field: string): string {
  const normalized = value.trim().toLowerCase().replace(/[^a-z0-9_.-]+/g, "-").replace(/^[-.]+|[-.]+$/g, "");
  if (!normalized) throw new Error(`Worker lease ${field} must contain at least one safe character`);
  return normalized.slice(0, 80);
}

export function workerLeaseDir(projectRoot: string): string {
  return path.join(projectRoot, "vq", "state", LEASE_DIR_NAME);
}

export function workerLeaseFile(projectRoot: string, workerId: string): string {
  return path.join(workerLeaseDir(projectRoot), `${safeLeaseSegment(workerId, "worker_id")}.json`);
}

function requireString(record: Record<string, unknown>, field: string): string {
  const value = record[field];
  if (typeof value !== "string" || !value.trim()) throw new Error(`Worker lease field '${field}' must be a non-empty string`);
  return value;
}

/**
 * Griežtas parse'as. Sugadintas lease'o failas NIEKADA netraktuojamas kaip „lease'o nėra":
 * tyliai praleidus jį, perimtas workeris atgautų teisę rašyti. Klaida keliauja iškvietėjui,
 * kuris blokuoja fail-closed.
 */
export function parseWorkerLease(raw: unknown): WorkerLease {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("Worker lease must be a JSON object");
  }
  const record = raw as Record<string, unknown>;
  const status = record["status"];
  if (status !== "held" && status !== "released") {
    throw new Error("Worker lease field 'status' must be 'held' or 'released'");
  }
  const attempt = record["attempt"];
  if (!Number.isInteger(attempt) || (attempt as number) < 1) {
    throw new Error("Worker lease field 'attempt' must be a positive integer");
  }
  const fencingToken = record["fencing_token"];
  if (!Number.isInteger(fencingToken) || (fencingToken as number) < 1) {
    throw new Error("Worker lease field 'fencing_token' must be a positive integer");
  }
  const worktreePath = record["worktree_path"];
  if (worktreePath !== undefined && typeof worktreePath !== "string") {
    throw new Error("Worker lease field 'worktree_path' must be a string when present");
  }

  return {
    schema_version: typeof record["schema_version"] === "number" ? (record["schema_version"]) : WORKER_LEASE_SCHEMA_VERSION,
    lease_id: requireString(record, "lease_id"),
    status,
    fencing_token: fencingToken as number,
    owner_id: requireString(record, "owner_id"),
    run_id: requireString(record, "run_id"),
    worker_id: requireString(record, "worker_id"),
    task_id: requireString(record, "task_id"),
    attempt: attempt as number,
    ...(worktreePath ? { worktree_path: worktreePath } : {}),
    acquired_at: requireString(record, "acquired_at"),
    heartbeat_at: requireString(record, "heartbeat_at"),
    expires_at: requireString(record, "expires_at"),
    ...(typeof record["released_at"] === "string" ? { released_at: record["released_at"] } : {}),
    ...(typeof record["superseded_lease_id"] === "string" ? { superseded_lease_id: record["superseded_lease_id"] } : {}),
  };
}

/** Vienas lease'o įrašas. `undefined` = failo nėra; sugadintas turinys META klaidą. */
export async function readWorkerLease(
  fs: SchedulingFileSystemPort,
  projectRoot: string,
  workerId: string,
): Promise<WorkerLease | undefined> {
  const raw = await fs.readTextFileIfExists(workerLeaseFile(projectRoot, workerId));
  if (raw === undefined) return undefined;
  return parseWorkerLease(JSON.parse(raw) as unknown);
}

/** Visi žinomi lease'ai (įskaitant `released`) deterministine tvarka pagal `worker_id`. */
export async function listWorkerLeases(fs: SchedulingFileSystemPort, projectRoot: string): Promise<WorkerLease[]> {
  const dir = workerLeaseDir(projectRoot);
  const entries = (await fs.listDirectoryIfExists(dir))?.filter((name) => name.endsWith(".json"));
  if (!entries) return [];

  const leases: WorkerLease[] = [];
  for (const name of entries.sort()) {
    const raw = await fs.readTextFileIfExists(path.join(dir, name));
    if (raw === undefined) continue;
    leases.push(parseWorkerLease(JSON.parse(raw) as unknown));
  }
  return leases;
}

const LEASE_STORE_LOCK_TIMING: OwnedLockTiming = {
  staleMs: 60 * 1000,
  retryMs: 50,
  // Buvo 100 bandymų po 50 ms — ta pati riba, tik išreikšta laiku, kaip jos ir prašo protokolas.
  timeoutMs: 100 * 50,
};

/**
 * Read-modify-write serializacija tarp procesų.
 *
 * 2026-08-24: protokolas iškeltas į `shared/owned-lock`. Iki tol ši funkcija ir
 * `withScopeLockRegistry` buvo PAŽODINĖS viena kitos kopijos, ir abi turėjo tą pačią spragą —
 * `finally` trynė lock'ą besąlygiškai, tad senasis savininkas galėdavo ištrinti jau naujojo
 * lock'ą ir įleisti trečią rašytoją. Nuosavybės tokenas ir tikrinantis atlaisvinimas dabar
 * gyvena vienoje vietoje, kartu su `state-file-lock`.
 */
async function withLeaseStoreLock<T>(deps: WorkerLeaseStoreDeps, projectRoot: string, operation: () => Promise<T>): Promise<T> {
  const dir = workerLeaseDir(projectRoot);
  await deps.fs.makeDirectory(dir);
  return await withOwnedLock(
    schedulingOwnedLockIo(deps.fs, clockOf(deps)),
    path.join(dir, ".store.lock"),
    LEASE_STORE_LOCK_TIMING,
    operation,
    "worker-lease-store",
  );
}

export type AcquireWorkerLeaseResult =
  | { status: "acquired"; lease: WorkerLease; takeover: boolean; superseded?: WorkerLease }
  /** Tas pats owner'is jau laiko galiojantį lease — idempotentinis pakartotinis kvietimas. */
  | { status: "reused"; lease: WorkerLease }
  /** Kitas procesas laiko galiojantį lease šiam worker'iui. */
  | { status: "conflict"; holder: WorkerLease };

/**
 * Paima (arba perima) lease worker'iui.
 *
 * Perimti galima TIK atlaisvintą arba pasibaigusį lease. Gyvas svetimas lease grąžina
 * `conflict` — jo nutraukimas yra operatoriaus sprendimas, ne šio modulio. Perėmimo atveju
 * `superseded` neša ankstesnį įrašą: iš jo `worktree_path` sprendžiama, ar darbo kopija
 * saugiai perimama, ar keliauja į karantiną (E4 worktree manager).
 */
export async function acquireWorkerLease(input: {
  deps: WorkerLeaseStoreDeps;
  projectRoot: string;
  identity: WorkerLeaseIdentity;
  now?: Date;
  ttlMs?: number;
  leaseId?: string;
  worktreePath?: string;
}): Promise<AcquireWorkerLeaseResult> {
  const now = input.now ?? clockOf(input.deps).now();
  return await withLeaseStoreLock(input.deps, input.projectRoot, async () => {
    const previous = await readWorkerLease(input.deps.fs, input.projectRoot, input.identity.worker_id);

    if (previous && isLeaseActive(previous, now)) {
      if (previous.owner_id !== input.identity.owner_id) {
        return { status: "conflict", holder: previous } as const;
      }
      const renewed = renewWorkerLease(previous, { now, ...(input.ttlMs === undefined ? {} : { ttlMs: input.ttlMs }) });
      await writeWorkerLease(input.deps.fs, input.projectRoot, renewed);
      return { status: "reused", lease: renewed } as const;
    }

    const lease = createWorkerLease(input.identity, {
      now,
      fencingToken: nextFencingToken(previous),
      ...(input.ttlMs === undefined ? {} : { ttlMs: input.ttlMs }),
      ...(input.leaseId === undefined ? {} : { leaseId: input.leaseId }),
      ...(input.worktreePath === undefined ? {} : { worktreePath: input.worktreePath }),
      ...(previous?.lease_id === undefined ? {} : { supersededLeaseId: previous.lease_id }),
    });
    await writeWorkerLease(input.deps.fs, input.projectRoot, lease);

    const takeover = Boolean(previous && previous.status === "held");
    return takeover
      ? ({ status: "acquired", lease, takeover: true, superseded: previous as WorkerLease } as const)
      : ({ status: "acquired", lease, takeover: false } as const);
  });
}

export type LeaseMutationResult =
  | { status: "ok"; lease: WorkerLease }
  | { status: "denied"; authority: RuntimeAuthority };

/** Heartbeat per store. Nuosavybė tikrinama PRIEŠ pratęsimą — perimtas lease nebeprikeliamas. */
export async function heartbeatWorkerLease(input: {
  deps: WorkerLeaseStoreDeps;
  projectRoot: string;
  claim: WorkerLeaseClaim;
  workerId: string;
  now?: Date;
  ttlMs?: number;
}): Promise<LeaseMutationResult> {
  const now = input.now ?? clockOf(input.deps).now();
  return await withLeaseStoreLock(input.deps, input.projectRoot, async () => {
    const lease = await readWorkerLease(input.deps.fs, input.projectRoot, input.workerId);
    const verdict = authorizeRuntimeMutation({ leases: lease ? [lease] : [], claim: input.claim, now });
    if (!verdict.ok || !lease) return { status: "denied", authority: verdict } as const;

    const renewed = renewWorkerLease(lease, { now, ...(input.ttlMs === undefined ? {} : { ttlMs: input.ttlMs }) });
    await writeWorkerLease(input.deps.fs, input.projectRoot, renewed);
    return { status: "ok", lease: renewed } as const;
  });
}

/**
 * Atlaisvinimas per store. Tik savininkas gali atlaisvinti — svetimas claim'as gauna `denied`.
 *
 * Kartu krenta ir VISI to lease'o scope lock'ai (2026-08-24, operatoriaus radinys P2). Tai ne
 * papildomas veiksmas, o domeno taisyklė, užrašyta `scope-lock-rules.ScopeLockOwner`: „Lock'o
 * savininkas yra LEASE, ne procesas: netekus lease'o, krenta ir visi jo lock'ai."
 *
 * Kodėl ČIA, o ne kvietėjuose: atlaisvinimo kelių yra keturi (aprūpinimo nesėkmė, bangos slot'o
 * grąžinimas, reaper'is, loop komanda), ir lock'ų nuėmimas, pakartotas keturis kartus, būtų
 * pamirštas penktame. Nuosavybė krenta ten, kur krenta lease.
 *
 * Valymas yra BEST-EFFORT: jo klaida negali paversti pavykusio atlaisvinimo `denied` verdiktu —
 * pakibęs lease būtų blogiau nei pakibęs lock'as, kurį dar nuvalo TTL.
 */
export async function releaseWorkerLease(input: {
  deps: WorkerLeaseStoreDeps;
  projectRoot: string;
  claim: WorkerLeaseClaim;
  workerId: string;
  now?: Date;
}): Promise<LeaseMutationResult> {
  const now = input.now ?? clockOf(input.deps).now();
  const result = await withLeaseStoreLock(input.deps, input.projectRoot, async () => {
    const lease = await readWorkerLease(input.deps.fs, input.projectRoot, input.workerId);
    const verdict = authorizeRuntimeMutation({ leases: lease ? [lease] : [], claim: input.claim, now });
    if (!verdict.ok || !lease) return { status: "denied", authority: verdict } as const;

    const released = releasedWorkerLease(lease, now);
    await writeWorkerLease(input.deps.fs, input.projectRoot, released);
    return { status: "ok", lease: released } as const;
  });

  // UŽ lease užrakto ribų: scope registras turi SAVO užraktą, ir jų lizdavimas duotų dvi
  // skirtingas įgijimo tvarkas (lease→scope čia, scope→lease aprūpinime) — klasikinį deadlock'ą.
  if (result.status === "ok") {
    await releaseScopeLocksInStore({ fs: input.deps.fs, ...(input.deps.clock ? { clock: input.deps.clock } : {}) },
      input.projectRoot, result.lease.lease_id).catch(() => 0);
  }
  return result;
}

// Trys eksportai ištrinti 2026-08-23 orkestratoriaus audite — nė vienas neturėjo produkcinio
// kvietėjo NEI čia, NEI etalone:
//   - `workerLeaseRuntimeEnabled` — „legacy režimo" detektorius be skaitytojo;
//   - `abandonedWorkerLeases` — doc'as teigė, kad iš jo orphan'us išveda E4 worktree manager;
//     NETIESA: orphan reaper'is turi savo `findOrphanWorktrees` kelią, o mirusius lease'us
//     tvarko `reapDeadWorkerLeases` (worker-lease-runtime);
//   - `currentOwnerId` (`pid-<pid>-<uuid>`) — ne šiaip miręs, o SPĄSTAI: mirusio savininko
//     aptikimas (`leaseOwnerLoopPid`/`isLeaseOwnerProcessDead`) atpažįsta TIK `loop-<pid>`
//     formą, kurią composition ir naudoja. Prijungus „patobulintą" uuid formą, reaper'is
//     nustotų matyti savininko mirtį ir lease'ai kabotų iki TTL.

/**
 * Įrašo lease į store be nuosavybės patikros. Skirta lease'o SAVININKUI, kuris jau turi
 * verdiktą (pvz. worktree kelio prisegimui iškart po `acquireWorkerLease`) ir fixture'ams;
 * įprastas kelias — `acquireWorkerLease` / `heartbeatWorkerLease` / `releaseWorkerLease`.
 */
export async function writeWorkerLease(fs: SchedulingFileSystemPort, projectRoot: string, lease: WorkerLease): Promise<void> {
  const file = workerLeaseFile(projectRoot, lease.worker_id);
  await fs.makeDirectory(path.dirname(file));
  await fs.writeTextFileAtomic(file, toPrettyJson(lease));
}
