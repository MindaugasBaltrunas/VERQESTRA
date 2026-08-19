// Scope lock — kas KĄ šiuo metu turi teisę keisti: įgijimo taisyklė ir JSON store pusė
// (spec WRK-3/PAR-2, design §12–13). Behaviour etalon: AG_loop application/scheduling/
// scope-lock.ts (grynosios normalizacijos/persidengimo taisyklės jau gyvena
// domain/scheduling/scope-lock-rules.ts — čia jos NEdubliuojamos, FQC-12).
//
// `acquireScopeLocks` gyvena čia, o ne domain'e, tik dėl vienos priežasties: numatytasis
// `lock_id` yra `randomUUID`, o domain sluoksniui node builtins uždrausti. Pati taisyklė
// (all-or-nothing, konfliktų sąrašas pilnas) yra 1:1 etalonas.
//
// Store: `vq/state/scope-locks.json`, serializuotas per mkdir-lock primityvą — tas pats
// receptas kaip worker lease store, todėl elgsena repozitorijoje viena.

import { randomUUID } from "node:crypto";
import path from "node:path";
import {
  activeScopeLocks,
  authorizeScopedPath,
  normalizeScopeLockRequest,
  normalizeScopeValue,
  releaseScopeLocks,
  scopesConflict,
  ScopeLockError,
  SCOPE_LOCK_SCHEMA_VERSION,
  type ScopeLock,
  type ScopeLockAuthority,
  type ScopeLockKind,
  type ScopeLockOwner,
  type ScopeLockRegistry,
  type ScopeLockRequest,
} from "../../domain/scheduling/index.js";
import { toPrettyJson } from "../../shared/json.js";
import type { SchedulingClockPort, SchedulingFileSystemPort } from "./ports.js";
import { systemSchedulingClock } from "./ports.js";

export const DEFAULT_SCOPE_LOCK_TTL_MS = 15 * 60 * 1000;

const SCOPE_LOCK_KINDS: readonly ScopeLockKind[] = [
  "file",
  "directory",
  "glob",
  "contract",
  "migration-chain",
  "generated",
];

function comparable(value: string): string {
  return value.toLowerCase();
}

// ---------------------------------------------------------------------------
// Įgijimas ir atlaisvinimas (grynos taisyklės virš domain primityvų)
// ---------------------------------------------------------------------------

export type ScopeLockConflict = {
  request: ScopeLockRequest;
  holder: ScopeLock;
};

export type AcquireScopeLocksResult =
  | { status: "acquired"; registry: ScopeLockRegistry; locks: ScopeLock[] }
  /** Nė vienas lock'as neįgyjamas: dalinis rinkinys sukurtų deadlock'ą tarp dviejų workerių. */
  | { status: "conflict"; registry: ScopeLockRegistry; conflicts: ScopeLockConflict[] };

/**
 * Įgyja VISUS prašomus lock'us arba nė vieno (all-or-nothing).
 *
 * Dalinis įgijimas yra klasikinis deadlock'o receptas: du workeriai pasiimtų po pusę vienas
 * kito scope ir abu lauktų. Konfliktų sąrašas grąžinamas pilnas, kad scheduleris matytų,
 * KAS blokuoja, o ne tik faktą „užimta".
 */
export function acquireScopeLocks(
  registry: ScopeLockRegistry,
  requests: readonly ScopeLockRequest[],
  owner: ScopeLockOwner,
  options: { now: Date; ttlMs?: number; lockIdFor?: (request: ScopeLockRequest, index: number) => string },
): AcquireScopeLocksResult {
  const ttlMs = options.ttlMs ?? DEFAULT_SCOPE_LOCK_TTL_MS;
  if (!Number.isFinite(ttlMs) || ttlMs <= 0) throw new ScopeLockError("Scope lock TTL must be a positive number of milliseconds");

  const normalized = requests.map(normalizeScopeLockRequest);
  const retained = activeScopeLocks(registry, options.now);
  const foreign = retained.filter((lock) => lock.owner.lease_id !== owner.lease_id);

  const conflicts: ScopeLockConflict[] = [];
  for (const request of normalized) {
    for (const lock of foreign) {
      if (scopesConflict(request, lock)) conflicts.push({ request, holder: lock });
    }
  }
  if (conflicts.length > 0) {
    return { status: "conflict", registry: { schema_version: SCOPE_LOCK_SCHEMA_VERSION, locks: retained }, conflicts };
  }

  const acquiredAt = options.now.toISOString();
  const expiresAt = new Date(options.now.getTime() + ttlMs).toISOString();
  const locks = normalized.map((request, index) => ({
    lock_id: options.lockIdFor?.(request, index) ?? randomUUID(),
    kind: request.kind,
    scope: request.scope,
    owner,
    acquired_at: acquiredAt,
    expires_at: expiresAt,
  }));

  // Pakartotinis to paties lease'o kvietimas atnaujina savo lock'us, o ne kaupia dublikatus.
  const ownLockKeys = new Set(locks.map((lock) => `${lock.kind}:${comparable(lock.scope)}`));
  const kept = retained.filter(
    (lock) => lock.owner.lease_id !== owner.lease_id || !ownLockKeys.has(`${lock.kind}:${comparable(lock.scope)}`),
  );

  return {
    status: "acquired",
    registry: { schema_version: SCOPE_LOCK_SCHEMA_VERSION, locks: [...kept, ...locks] },
    locks,
  };
}

// ---------------------------------------------------------------------------
// Store (vq/state/scope-locks.json)
// ---------------------------------------------------------------------------

export function scopeLockFile(projectRoot: string): string {
  return path.join(projectRoot, "vq", "state", "scope-locks.json");
}

function parseScopeLock(raw: unknown): ScopeLock {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) throw new ScopeLockError("Scope lock must be a JSON object");
  const record = raw as Record<string, unknown>;
  const kind = record["kind"];
  if (typeof kind !== "string" || !SCOPE_LOCK_KINDS.includes(kind as ScopeLockKind)) {
    throw new ScopeLockError(`Scope lock field 'kind' is invalid: ${String(kind)}`);
  }
  const owner = record["owner"];
  if (owner === null || typeof owner !== "object" || Array.isArray(owner)) {
    throw new ScopeLockError("Scope lock field 'owner' must be an object");
  }
  const ownerRecord = owner as Record<string, unknown>;
  for (const field of ["lease_id", "owner_id", "run_id", "worker_id", "task_id"]) {
    const value = ownerRecord[field];
    if (typeof value !== "string" || !value.trim()) {
      throw new ScopeLockError(`Scope lock owner field '${field}' must be a non-empty string`);
    }
  }
  if (!Number.isInteger(ownerRecord["attempt"]) || !Number.isInteger(ownerRecord["fencing_token"])) {
    throw new ScopeLockError("Scope lock owner fields 'attempt' and 'fencing_token' must be integers");
  }
  for (const field of ["lock_id", "scope", "acquired_at", "expires_at"]) {
    const value = record[field];
    if (typeof value !== "string" || !value.trim()) {
      throw new ScopeLockError(`Scope lock field '${field}' must be a non-empty string`);
    }
  }

  return {
    lock_id: record["lock_id"] as string,
    kind: kind as ScopeLockKind,
    scope: normalizeScopeValue(record["scope"] as string),
    owner: {
      lease_id: ownerRecord["lease_id"] as string,
      owner_id: ownerRecord["owner_id"] as string,
      run_id: ownerRecord["run_id"] as string,
      worker_id: ownerRecord["worker_id"] as string,
      task_id: ownerRecord["task_id"] as string,
      attempt: ownerRecord["attempt"] as number,
      fencing_token: ownerRecord["fencing_token"] as number,
    },
    acquired_at: record["acquired_at"] as string,
    expires_at: record["expires_at"] as string,
  };
}

export function parseScopeLockRegistry(raw: unknown): ScopeLockRegistry {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new ScopeLockError("Scope lock registry must be a JSON object");
  }
  const record = raw as Record<string, unknown>;
  const locks = record["locks"];
  if (!Array.isArray(locks)) throw new ScopeLockError("Scope lock registry field 'locks' must be an array");
  return {
    schema_version: typeof record["schema_version"] === "number" ? (record["schema_version"] as number) : SCOPE_LOCK_SCHEMA_VERSION,
    locks: locks.map(parseScopeLock),
  };
}

/**
 * Nuskaito registrą. Trūkstamas failas = tuščias registras; SUGADINTAS failas meta klaidą —
 * tylus grįžimas į tuščią registrą reikštų, kad visi lock'ai dingsta po vieno blogo rašymo.
 */
export async function readScopeLockRegistry(fs: SchedulingFileSystemPort, projectRoot: string): Promise<ScopeLockRegistry> {
  const raw = await fs.readTextFileIfExists(scopeLockFile(projectRoot));
  if (raw === undefined) return { schema_version: SCOPE_LOCK_SCHEMA_VERSION, locks: [] };
  return parseScopeLockRegistry(JSON.parse(raw) as unknown);
}

export async function writeScopeLockRegistry(
  fs: SchedulingFileSystemPort,
  projectRoot: string,
  registry: ScopeLockRegistry,
): Promise<void> {
  const file = scopeLockFile(projectRoot);
  await fs.makeDirectory(path.dirname(file));
  await fs.writeTextFileAtomic(file, toPrettyJson(registry));
}

const REGISTRY_LOCK_STALE_MS = 60 * 1000;

/** Serializuotas read-modify-write; tas pats mkdir primityvas kaip lease store lock'e. */
export async function withScopeLockRegistry<T>(
  deps: { fs: SchedulingFileSystemPort; clock?: SchedulingClockPort },
  projectRoot: string,
  mutate: (registry: ScopeLockRegistry) => Promise<{ registry?: ScopeLockRegistry; result: T }> | { registry?: ScopeLockRegistry; result: T },
): Promise<T> {
  const clock = deps.clock ?? systemSchedulingClock;
  const file = scopeLockFile(projectRoot);
  await deps.fs.makeDirectory(path.dirname(file));
  const lockDir = `${file}.lock`;

  for (let attempt = 1; attempt <= 100; attempt += 1) {
    const created = await deps.fs.createLockDirectory(lockDir);
    if (created === "created") {
      try {
        const outcome = await mutate(await readScopeLockRegistry(deps.fs, projectRoot));
        if (outcome.registry) await writeScopeLockRegistry(deps.fs, projectRoot, outcome.registry);
        return outcome.result;
      } finally {
        await deps.fs.removeDirectory(lockDir).catch(() => undefined);
      }
    }
    await removeStaleRegistryLock(deps.fs, lockDir, clock);
    await clock.sleep(50);
  }

  throw new ScopeLockError("Timed out waiting for the scope lock registry lock");
}

async function removeStaleRegistryLock(
  fs: SchedulingFileSystemPort,
  lockDir: string,
  clock: SchedulingClockPort,
): Promise<void> {
  try {
    const modifiedAt = await fs.directoryModifiedAtMs(lockDir);
    if (modifiedAt === undefined) return;
    if (clock.now().getTime() - modifiedAt <= REGISTRY_LOCK_STALE_MS) return;
    await fs.removeDirectory(lockDir);
  } catch {
    // Lock'as jau dingo — kitas ciklo bandymas išspręs.
  }
}

/** Įgyja lock'us store'e (serializuotai). Konflikto atveju registras nekeičiamas. */
export async function acquireScopeLocksInStore(input: {
  fs: SchedulingFileSystemPort;
  clock?: SchedulingClockPort;
  projectRoot: string;
  requests: readonly ScopeLockRequest[];
  owner: ScopeLockOwner;
  now?: Date;
  ttlMs?: number;
}): Promise<AcquireScopeLocksResult> {
  const now = input.now ?? (input.clock ?? systemSchedulingClock).now();
  return await withScopeLockRegistry<AcquireScopeLocksResult>(
    { fs: input.fs, ...(input.clock ? { clock: input.clock } : {}) },
    input.projectRoot,
    (registry) => {
      const result = acquireScopeLocks(registry, input.requests, input.owner, {
        now,
        ...(input.ttlMs === undefined ? {} : { ttlMs: input.ttlMs }),
      });
      return result.status === "acquired" ? { registry: result.registry, result } : { result };
    },
  );
}

/** Atlaisvina lease'o lock'us store'e ir grąžina, kiek jų buvo. */
export async function releaseScopeLocksInStore(
  deps: { fs: SchedulingFileSystemPort; clock?: SchedulingClockPort },
  projectRoot: string,
  leaseId: string,
): Promise<number> {
  return await withScopeLockRegistry(deps, projectRoot, (registry) => {
    const next = releaseScopeLocks(registry, leaseId);
    return { registry: next, result: registry.locks.length - next.locks.length };
  });
}

/**
 * Rašymo vartas hook'ui. Sugadintas registras virsta DRAUDIMU: be patikimo lock'ų sąrašo
 * negalima įrodyti, kad kelias nepriklauso kitam workeriui.
 */
export async function authorizeScopedWrite(input: {
  fs: SchedulingFileSystemPort;
  projectRoot: string;
  repoRelativePath: string;
  leaseId?: string;
  now?: Date;
}): Promise<ScopeLockAuthority> {
  let registry: ScopeLockRegistry;
  try {
    registry = await readScopeLockRegistry(input.fs, input.projectRoot);
  } catch (error: unknown) {
    return {
      status: "locked-by-other",
      ok: false,
      reason: `scope lock registras neperskaitomas: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  return authorizeScopedPath(registry, input.repoRelativePath, input.leaseId, input.now ?? new Date());
}
