// Worker lease runtime vartas: claim'as iš aplinkos, lease APRĖPTIS iš task Markdown ir
// paliktų lease'ų reaper'is. Behaviour etalon: AG_loop application/scheduling/
// worker-lease.ts runtime pusė (skaidymas store + runtime pagal 500 eil. gate; vardai 1:1).
//
// Task'ų Markdown aprėpčiai skaitomas iš `AG/tasks/<bucket>/` (bucket'ų layout'as — parity
// su etalonu); lease store gyvena `worker-lease-store.ts`, o SPRENDIMO taisyklės —
// domain/scheduling/worker-lease-rules.ts (FQC-12: čia jos NEdubliuojamos).

import path from "node:path";
import {
  authorizeRuntimeMutation,
  isLeaseActive,
  isLeaseExpired,
  isLeaseOwnerProcessDead,
  leaseClaimOf,
  leaseScopeCoversPath,
  type RuntimeAuthority,
  type WorkerLease,
  type WorkerLeaseClaim,
  type WorkerLeaseScope,
} from "../../domain/scheduling/index.js";
import { allowedPaths, normalizeTaskReference, taskBuckets, type TaskBucket } from "../../domain/tasks/index.js";
import { isProjectRelativePath, normalizeProjectPath } from "../../shared/paths.js";
import type { SchedulingFileSystemPort } from "./ports.js";
import { processIsAlive, systemSchedulingClock } from "./ports.js";
import { listWorkerLeases, releaseWorkerLease, type WorkerLeaseStoreDeps } from "./worker-lease-store.js";

// ---------------------------------------------------------------------------
// Runtime claim iš aplinkos
// ---------------------------------------------------------------------------

export const LEASE_ENV = {
  leaseId: "AG_WORKER_LEASE_ID",
  ownerId: "AG_WORKER_OWNER_ID",
  fencingToken: "AG_WORKER_FENCING_TOKEN",
  taskId: "AG_WORKER_TASK_ID",
  attempt: "AG_WORKER_ATTEMPT",
} as const;

export class WorkerLeaseClaimError extends Error {}

/**
 * Claim'as iš aplinkos kintamųjų, kuriuos dispatch'as perduoda workeriui.
 *
 * DALINIS claim'as (pvz. yra lease ID, bet nėra fencing token'o) yra klaida, o ne „claim'o
 * nėra": kitaip pakaktų ištrinti vieną kintamąjį, kad vartai persijungtų į `unmanaged`.
 */
export function resolveWorkerLeaseClaim(env: NodeJS.ProcessEnv = process.env): WorkerLeaseClaim | undefined {
  const leaseId = env[LEASE_ENV.leaseId]?.trim();
  const ownerId = env[LEASE_ENV.ownerId]?.trim();
  const rawToken = env[LEASE_ENV.fencingToken]?.trim();

  if (!leaseId && !ownerId && !rawToken) return undefined;
  if (!leaseId || !ownerId || !rawToken) {
    throw new WorkerLeaseClaimError(
      `Nepilnas worker lease claim: reikalingi ${LEASE_ENV.leaseId}, ${LEASE_ENV.ownerId} ir ${LEASE_ENV.fencingToken}`,
    );
  }

  const fencingToken = Number(rawToken);
  if (!Number.isInteger(fencingToken) || fencingToken < 1) {
    throw new WorkerLeaseClaimError(`${LEASE_ENV.fencingToken} turi būti teigiamas sveikas skaičius, gauta '${rawToken}'`);
  }

  const attemptRaw = env[LEASE_ENV.attempt]?.trim();
  const attempt = attemptRaw ? Number(attemptRaw) : undefined;
  if (attemptRaw && (!Number.isInteger(attempt) || (attempt as number) < 1)) {
    throw new WorkerLeaseClaimError(`${LEASE_ENV.attempt} turi būti teigiamas sveikas skaičius, gauta '${attemptRaw}'`);
  }

  const taskId = env[LEASE_ENV.taskId]?.trim();
  return {
    lease_id: leaseId,
    owner_id: ownerId,
    fencing_token: fencingToken,
    ...(taskId ? { task_id: taskId } : {}),
    ...(attempt !== undefined ? { attempt } : {}),
  };
}

// ---------------------------------------------------------------------------
// Lease APRĖPTIS (task failo skaitymas iš AG/tasks bucket'ų)
// ---------------------------------------------------------------------------

/**
 * Gyvo lease'o task'o Markdown. Ieškoma visuose bucket'uose, pirmenybė toms vietoms, kur
 * guli VYKDOMAS task'as — būtent jam lease ir išduodamas. `normalizeTaskReference` yra ir
 * sanitizacija: separatoriai virsta `-`, tad `task_id` iš lease failo negali nurodyti kelio
 * už `AG/tasks/<bucket>/` ribų.
 */
const LEASE_TASK_PRIORITY_BUCKETS: readonly TaskBucket[] = ["active", "delegated", "queue"];
const LEASE_TASK_LOOKUP_BUCKETS: readonly TaskBucket[] = [
  ...LEASE_TASK_PRIORITY_BUCKETS,
  ...taskBuckets.filter((bucket) => !LEASE_TASK_PRIORITY_BUCKETS.includes(bucket)),
];

async function readLeaseTaskMarkdown(
  fs: SchedulingFileSystemPort,
  projectRoot: string,
  taskId: string,
): Promise<string | undefined> {
  const stem = normalizeTaskReference(taskId);
  if (!stem) return undefined;
  for (const bucket of LEASE_TASK_LOOKUP_BUCKETS) {
    try {
      const markdown = await fs.readTextFileIfExists(path.join(projectRoot, "AG", "tasks", bucket, `${stem}.md`));
      if (markdown !== undefined) return markdown;
    } catch {
      // Neperskaitomas — bandomas kitas bucket'as; visiška nesėkmė virsta neišspręsta
      // aprėptimi, kurią `leaseScopeCoversPath` traktuoja kaip „gina viską".
    }
  }
  return undefined;
}

/**
 * Ką šis lease gina: savo izoliuotą darbo kopiją ir savo task'o deklaruotus kelius.
 *
 * Task'o failo nebuvimas, neperskaitomas turinys ar nedeklaruotas `## Failai` scope palieka
 * `allowedPaths` neapibrėžtą — t. y. lease gina visą produkto medį.
 */
export async function resolveWorkerLeaseScope(
  fs: SchedulingFileSystemPort,
  projectRoot: string,
  lease: WorkerLease,
): Promise<WorkerLeaseScope> {
  const worktreePath = lease.worktree_path
    ? normalizeProjectPath(projectRoot, lease.worktree_path)
    : undefined;
  const markdown = await readLeaseTaskMarkdown(fs, projectRoot, lease.task_id);
  const declared = markdown === undefined ? [] : allowedPaths(markdown);
  return {
    lease,
    // Už šio medžio ribų rodantis worktree kelias praleidžiamas: repo-relative tikslas į jį
    // patekti negali, o `normalizeScopeValue` tokį įrašą vis tiek atmestų.
    ...(worktreePath && isProjectRelativePath(worktreePath) ? { worktreePath } : {}),
    ...(declared.length > 0 ? { allowedPaths: declared } : {}),
  };
}

/**
 * Kurie iš gyvų lease'ų gina konkretų kelią. Aprėpties skaitymo klaida įrašo lease'ą į
 * ginančiųjų aibę: nežinojimas apie svetimą scope negali atverti vartų.
 */
async function leaseRelevanceForPath(
  fs: SchedulingFileSystemPort,
  projectRoot: string,
  leases: readonly WorkerLease[],
  guardedPath: string,
  now: Date,
): Promise<(lease: WorkerLease) => boolean> {
  const guarding = new Set<string>();
  for (const lease of leases) {
    if (!isLeaseActive(lease, now)) continue;
    try {
      if (leaseScopeCoversPath(await resolveWorkerLeaseScope(fs, projectRoot, lease), guardedPath)) {
        guarding.add(lease.lease_id);
      }
    } catch {
      guarding.add(lease.lease_id);
    }
  }
  return (lease) => guarding.has(lease.lease_id);
}

function deniedAuthority(reason: string): RuntimeAuthority {
  return { status: "lease-missing", ok: false, reason };
}

/**
 * Pilnas runtime vartas hook'ams ir task-state perėjimams: nuskaito store, išsprendžia
 * claim'ą iš aplinkos ir grąžina verdiktą. Bet kokia klaida (sugadintas lease, nepilnas
 * claim) virsta DRAUDIMU, o ne praleidimu.
 */
export async function authorizeWorkerRuntimeMutation(input: {
  deps: WorkerLeaseStoreDeps;
  projectRoot: string;
  env?: NodeJS.ProcessEnv;
  taskId?: string;
  now?: Date;
  /** Gyvumo patikros injekcija testams; produkcijoje — realus `process.kill(pid, 0)`. */
  isOwnerAlive?: (pid: number) => boolean;
  /**
   * Repo-relative rašymo kelias, kurio nuosavybė sprendžiama. Kai pateiktas, claim'o
   * neturinčioje šakoje svetimas lease blokuoja tik tada, kai kelias patenka į JO aprėptį.
   * Kai nepateiktas (git commit, task būsenos perėjimas — jie liečia visą medį), bet kuris
   * gyvas lease blokuoja.
   */
  guardedPath?: string;
}): Promise<RuntimeAuthority> {
  const now = input.now ?? (input.deps.clock ?? systemSchedulingClock).now();
  const isAlive = input.isOwnerAlive ?? processIsAlive;
  let claim: WorkerLeaseClaim | undefined;
  try {
    claim = resolveWorkerLeaseClaim(input.env ?? process.env);
  } catch (error: unknown) {
    return deniedAuthority(error instanceof Error ? error.message : String(error));
  }

  let leases: WorkerLease[];
  try {
    leases = await listWorkerLeases(input.deps.fs, input.projectRoot);
  } catch (error: unknown) {
    return deniedAuthority(`worker lease store neperskaitomas: ${error instanceof Error ? error.message : String(error)}`);
  }

  // Aprėptis skaičiuojama tik ten, kur ji ką nors keičia: claim'o šaka jos neklausia, o be
  // `guardedPath` (commit, task-state) gina visas medis.
  const isLeaseRelevant =
    claim || input.guardedPath === undefined
      ? undefined
      : await leaseRelevanceForPath(input.deps.fs, input.projectRoot, leases, input.guardedPath, now);

  return authorizeRuntimeMutation({
    leases,
    ...(claim ? { claim } : {}),
    ...(input.taskId === undefined ? {} : { taskId: input.taskId }),
    now,
    isOwnerProcessDead: (lease) => isLeaseOwnerProcessDead(lease, isAlive),
    ...(isLeaseRelevant ? { isLeaseRelevant } : {}),
  });
}

/**
 * Atlaisvina paliktus (`held`, bet be gyvo savininko arba pasibaigusius) worker lease'us.
 *
 * Savininko gyvumas tikrinamas TIK `loop-<pid>` formos owner'iams — būtent juos išduoda
 * slot provisioning'as, ir tik jų mirtis palieka našlaitį. Kitokios formos owner'is
 * atlaisvinamas tik per TTL. Grąžina log eilutes vietoje ambient IO; reaper'is yra
 * HIGIENA, ne vartai: bet kokia klaida virsta eilute, o ne mestu išimtimi.
 */
export async function reapDeadWorkerLeases(
  deps: WorkerLeaseStoreDeps,
  projectRoot: string,
  options: { now?: Date; isOwnerAlive?: (pid: number) => boolean } = {},
): Promise<string[]> {
  const lines: string[] = [];
  try {
    const now = options.now ?? (deps.clock ?? systemSchedulingClock).now();
    const isAlive = options.isOwnerAlive ?? processIsAlive;
    for (const lease of await listWorkerLeases(deps.fs, projectRoot)) {
      if (lease.status !== "held") continue;
      const ownerDead = isLeaseOwnerProcessDead(lease, isAlive);
      if (!ownerDead && !isLeaseExpired(lease, now)) continue;
      const released = await releaseWorkerLease({
        deps,
        projectRoot,
        workerId: lease.worker_id,
        claim: leaseClaimOf(lease),
        now,
      });
      lines.push(
        released.status === "ok"
          ? `LEASE REAPED: worker=${lease.worker_id} task=${lease.task_id} lease=${lease.lease_id} ` +
              `reason=${ownerDead ? `owner ${lease.owner_id} nebegyvas` : "TTL pasibaigęs"}`
          : `LEASE REAP DENIED: worker=${lease.worker_id} lease=${lease.lease_id}`,
      );
    }
  } catch (error) {
    // Reaper'is yra higiena, ne vartai: jo klaida negali sustabdyti loop starto.
    lines.push(`LEASE REAP FAILED: ${error instanceof Error ? error.message : String(error)}`);
  }
  return lines;
}
