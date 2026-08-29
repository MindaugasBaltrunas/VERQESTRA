// Našlaičių darbo kopijų valymas ir ESKALACIJA (etalonas: AG_loop
// orchestrator/loop/orphan-worktree-reaper.ts).
//
// Kodėl to reikia: nutrūkęs worker'is palieka registruotą darbo kopiją IR jos šaką. Primityvai
// (`findOrphanWorktrees`, `reapOrphanWorktree`) našlaitį suranda ir pašalina TIK tada, kai jis
// įrodytai švarus. Viskas kita — necommit'intas darbas, neintegruoti commit'ai, sulūžusi git
// patikra, karantinas — grąžinama kaip `kept` ir lieka stovėti AMŽINAI. Tai teisinga, kol
// task'as dar gyvas, ir nereikalinga, kai jis jau `done` arba iš viso dingo.
//
// Šis modulis prideda tik tai, ko primityvai neturi: apimtį, limitą, eskalaciją ir žurnalo
// eilutes. Eskalacija turi TRIS nepriklausomus vartus, ir kiekvienas jų yra atskiras
// atsisakymas prarasti darbą:
//   1. AMŽIUS — kopija jaunesnė nei para paliekama, nes „gal dar dirba" tebėra tikėtina;
//   2. TASK'O BŪSENA — eskaluojama tik `done` arba jau dingusio task'o kopija;
//   3. PRIEŽASTIS — kelios priežastys (`outside-project`, `locked`, `branch-mismatch`, …)
//      NIEKADA neeskaluojamos: jos reiškia, kad mes nesuprantame, ką matome.
// Ir net praėjus visus tris, darbas pirma ARCHYVUOJAMAS kaip diff'as, ir tik tada šalinama.
//
// Grąžinamos EILUTĖS, o ne rašoma tiesiai į žurnalą: taip verdiktus mato testai be ambient IO.
// Lease saugykla neliečiama — našlaičio lease įrašas yra fencing skaitiklio atmintis.

import path from "node:path";
import {
  ORPHAN_ARCHIVE_DIR,
  ORPHAN_ESCALATION_MIN_AGE_MS,
  ORPHAN_WORKTREE_REAP_LIMIT,
} from "../../../application/scheduling/loop-runtime-config.js";
import { taskBuckets } from "../../../domain/tasks/buckets.js";
import { nodeFsAdapter } from "../../fs/node-fs-adapter.js";
import { gitResolveCommit } from "../git-client.js";
import { run, type CommandResult } from "../../process/run-process.js";
import { findOrphanWorktrees, reapOrphanWorktree, type OrphanWorktree } from "./worktree-reaper.js";
import { cleanupWorktreeRegistrations } from "./worktree-registration-cleanup.js";
import type { WorktreeOwnerMarker } from "./worktree-state-classifier.js";
import type { WorkerLease } from "../../../domain/scheduling/worker-lease-rules.js";

/**
 * Priežastys, kurių NIEKADA neeskaluojame.
 *
 * Bendra jų savybė: visos reiškia, kad kopijos tapatybė NEĮRODYTA (svetimas kelias, užrakinta,
 * nežinoma ar nesutampanti šaka, pasenusi registracija). Eskalacija tokiu atveju šalintų tai,
 * ko net negalime patikimai įvardyti.
 */
const NEVER_ESCALATE_REASON_PREFIXES = [
  "check-failed:outside-project",
  "check-failed:locked",
  "check-failed:unknown-branch",
  "check-failed:branch-mismatch",
  "check-failed:stale-registration",
];

function isEscalatableReason(reason: string): boolean {
  return !NEVER_ESCALATE_REASON_PREFIXES.some((prefix) => reason.startsWith(prefix));
}

/** Repo-santykinis POSIX kelias — tokia forma žurnalo eilutės lieka mašiniškai stabilios. */
function orphanLogPath(projectRoot: string, target: string): string {
  const relative = path.relative(path.resolve(projectRoot), target);
  const usable = relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative) ? relative : target;
  return usable.split(path.sep).join("/");
}

/** Task'o bucket'as pagal failo vardą; `undefined`, kai task'o nebėra nė viename bucket'e. */
async function resolvedTaskBucket(agRoot: string, taskId: string): Promise<string | undefined> {
  for (const bucket of taskBuckets) {
    const files = await nodeFsAdapter.listMarkdownFiles(path.join(agRoot, "tasks", bucket));
    if (files.some((file) => path.basename(file, ".md") === taskId)) return bucket;
  }
  return undefined;
}

/** Trys eskalacijos vartai: amžius ir task'o būsena (priežastis tikrinama atskirai). */
async function isEscalationEligible(agRoot: string, owner: WorktreeOwnerMarker, now: Date): Promise<boolean> {
  const createdAt = Date.parse(owner.created_at);
  if (!Number.isFinite(createdAt) || now.getTime() - createdAt < ORPHAN_ESCALATION_MIN_AGE_MS) return false;
  const bucket = await resolvedTaskBucket(agRoot, owner.task_id);
  // Dingęs task'as arba `done` — darbas nebereikalingas. Bet koks kitas bucket'as reiškia
  // gyvą task'ą, ir jo kopija lieka stovėti.
  return bucket === undefined || bucket === "done";
}

async function writeOrphanArchive(runtimeRoot: string, name: string, content: string): Promise<string> {
  const archiveDir = path.join(runtimeRoot, ...ORPHAN_ARCHIVE_DIR);
  await nodeFsAdapter.makeDirectory(archiveDir);
  const archivePath = path.join(archiveDir, `${name.replace(/[\\/]/g, "-")}.patch`);
  await nodeFsAdapter.writeTextFile(archivePath, content);
  return archivePath;
}

/**
 * Diff'as prieš pirminę šaką.
 *
 * Esant katalogui, pirma daromas `add -A`: be jo necommit'inti IR neįtraukti failai į diff'ą
 * nepatektų, ir archyvas tylėtų būtent apie tą darbą, dėl kurio jis kuriamas.
 */
async function diffAgainstPrimary(
  projectRoot: string,
  worktreePath: string,
  directoryPresent: boolean,
  branch: string | undefined,
  primaryHead: string,
): Promise<CommandResult | undefined> {
  if (directoryPresent) {
    await run("git", ["-C", worktreePath, "add", "-A"], { cwd: worktreePath });
    return await run("git", ["-C", worktreePath, "diff", "--cached", "--binary", primaryHead], { cwd: worktreePath });
  }
  if (branch === undefined) return undefined;
  return await run("git", ["-C", projectRoot, "diff", "--binary", primaryHead, branch], { cwd: projectRoot });
}

/** `--force` grandinė TIK eskalacijai; normalus šalinimo kelias lieka nepaliestas. */
async function forceRemoveWorktree(projectRoot: string, worktreePath: string): Promise<boolean> {
  const first = await run("git", ["-C", projectRoot, "worktree", "remove", "--force", worktreePath], {
    cwd: projectRoot,
  });
  if (first.code === 0) return true;
  // win32 ilgų kelių atvejis: ta pati komanda su `core.longpaths` dažnai praeina.
  const longpaths = await run(
    "git",
    ["-c", "core.longpaths=true", "-C", projectRoot, "worktree", "remove", "--force", worktreePath],
    { cwd: projectRoot },
  );
  return longpaths.code === 0;
}

async function escalateOrphanRemoval(input: {
  projectRoot: string;
  runtimeRoot: string;
  worktreePath: string;
  branch: string | undefined;
  primaryRef: string;
  unlock: boolean;
}): Promise<
  | { status: "reaped"; archivePath: string; registrationCleanupError?: string }
  | { status: "parked"; archivePath: string; branch: string; registrationCleanupError?: string }
  | { status: "failed" }
> {
  const { projectRoot, worktreePath, branch, primaryRef, unlock } = input;
  try {
    if (unlock) {
      const unlocked = await run("git", ["-C", projectRoot, "worktree", "unlock", worktreePath], { cwd: projectRoot });
      if (unlocked.code !== 0 && !/not locked/i.test(unlocked.stderr)) return { status: "failed" };
    }

    const primaryHead = await gitResolveCommit(primaryRef, projectRoot);
    if (primaryHead === undefined) return { status: "failed" };

    const directoryPresent = await nodeFsAdapter.exists(worktreePath);
    const diff = await diffAgainstPrimary(projectRoot, worktreePath, directoryPresent, branch, primaryHead);
    // Nepavykęs diff'as sustabdo VISKĄ: be archyvo šalinimas būtų neatstatomas darbo praradimas.
    if (diff === undefined || diff.code !== 0) return { status: "failed" };

    const archivePath = await writeOrphanArchive(
      input.runtimeRoot,
      branch ?? path.basename(worktreePath),
      diff.stdout,
    );

    if (directoryPresent && !(await forceRemoveWorktree(projectRoot, worktreePath))) return { status: "failed" };
    // Plikas `git worktree prune` paliktų negyvą registraciją su pasenusiu `index.lock`
    // (GeoGravity 1179) — `cleanupWorktreeRegistrations` prune'ą jau apima.
    const registrationCleanup = await cleanupWorktreeRegistrations({ projectRoot });

    if (branch !== undefined) {
      // Neigiamas/klaidos kodas reiškia, kad `branch` turi commit'ų, kurių nėra `primaryHead`
      // istorijoje — tokia šaka NIEKADA netrinama, net praėjus visus kitus eskalacijos vartus.
      const integrated = await run(
        "git",
        ["-C", projectRoot, "merge-base", "--is-ancestor", branch, primaryHead],
        { cwd: projectRoot },
      );
      if (integrated.code !== 0) {
        return {
          status: "parked",
          archivePath: orphanLogPath(projectRoot, archivePath),
          branch,
          ...(registrationCleanup.error !== undefined ? { registrationCleanupError: registrationCleanup.error } : {}),
        };
      }

      const deleted = await run("git", ["-C", projectRoot, "branch", "-D", branch], { cwd: projectRoot });
      if (deleted.code !== 0 && !/not found/i.test(deleted.stderr)) return { status: "failed" };
    }

    return {
      status: "reaped",
      archivePath: orphanLogPath(projectRoot, archivePath),
      ...(registrationCleanup.error !== undefined ? { registrationCleanupError: registrationCleanup.error } : {}),
    };
  } catch {
    return { status: "failed" };
  }
}

async function tryEscalate(input: {
  projectRoot: string;
  runtimeRoot: string;
  agRoot: string;
  orphan: OrphanWorktree;
  worktreePath: string;
  now: Date;
  primaryRef: string;
  unlock: boolean;
}): Promise<
  | { status: "reaped" | "parked"; branch: string; leaseId: string; archivePath: string; registrationCleanupError?: string }
  | undefined
> {
  const owner = input.orphan.owner;
  if (owner === undefined) return undefined;
  if (!(await isEscalationEligible(input.agRoot, owner, input.now))) return undefined;

  const branch = input.orphan.entry.branch?.replace(/^refs\/heads\//, "") ?? owner.branch;
  const result = await escalateOrphanRemoval({
    projectRoot: input.projectRoot,
    runtimeRoot: input.runtimeRoot,
    worktreePath: input.worktreePath,
    branch,
    primaryRef: input.primaryRef,
    unlock: input.unlock,
  });
  return result.status === "reaped" || result.status === "parked"
    ? {
        status: result.status,
        branch,
        leaseId: owner.lease_id,
        archivePath: result.archivePath,
        ...(result.registrationCleanupError !== undefined
          ? { registrationCleanupError: result.registrationCleanupError }
          : {}),
      }
    : undefined;
}

export type ReapOrphanWorktreesInput = {
  projectRoot: string;
  runtimeRoot: string;
  agRoot: string;
  leases: readonly WorkerLease[];
  limit?: number;
  now?: Date;
  primaryRef?: string;
};

/**
 * Pašalina našlaites kopijas ir jų šakas; senas `done`/dingusių task'ų nešvarias kopijas
 * eskaluoja (archyvas + priverstinis šalinimas).
 *
 * NIEKADA nemeta: tai HIGIENA, ne vartai. Nepavykęs valymas virsta žurnalo eilute, o loop'as
 * tęsiasi — priešingu atveju viena pakibusi kopija blokuotų visą eilę.
 */
export async function reapOrphanWorktrees(input: ReapOrphanWorktreesInput): Promise<string[]> {
  const lines: string[] = [];
  try {
    const limit = input.limit ?? ORPHAN_WORKTREE_REAP_LIMIT;
    const now = input.now ?? new Date();
    const primaryRef = input.primaryRef ?? "HEAD";
    const orphans = await findOrphanWorktrees({ projectRoot: input.projectRoot, leases: input.leases, now });

    let removals = 0;
    let deferred = 0;
    for (const orphan of orphans) {
      // Limitas tikrinamas PRIEŠ darbą: praėjimas su dešimtimis kopijų kitaip taptų minučių
      // operacija kiekvienos bangos pradžioje.
      if (removals >= limit) {
        deferred += 1;
        continue;
      }

      const outcome = await reapOrphanWorktree({
        projectRoot: input.projectRoot,
        orphan,
        leases: input.leases,
        now,
        primaryRef,
      });
      const logPath = orphanLogPath(input.projectRoot, outcome.path);

      if (outcome.status === "reaped") {
        removals += 1;
        lines.push(`ORPHAN REAPED: path=${logPath} branch=${outcome.branch} leaseId=${outcome.lease_id}`);
        continue;
      }
      // Gyvas lease — TYLI praleista eilutė yra teisingas elgesys: čia nieko neįvyko.
      if (outcome.status === "skipped") continue;

      const escalated =
        outcome.status === "kept" && !isEscalatableReason(outcome.reason)
          ? undefined
          : await tryEscalate({
              projectRoot: input.projectRoot,
              runtimeRoot: input.runtimeRoot,
              agRoot: input.agRoot,
              orphan,
              worktreePath: outcome.path,
              now,
              primaryRef,
              unlock: outcome.status === "quarantined",
            });

      if (escalated !== undefined) {
        removals += 1;
        const verb = escalated.status === "parked" ? "ORPHAN INTEGRATION PARKED" : "ORPHAN REAPED";
        lines.push(
          `${verb}: path=${logPath} branch=${escalated.branch} leaseId=${escalated.leaseId} archive=${escalated.archivePath}`,
        );
        if (escalated.registrationCleanupError !== undefined) {
          lines.push(
            `ORPHAN REGISTRATION CLEANUP FAILED: path=${logPath} error=${escalated.registrationCleanupError}`,
          );
        }
        continue;
      }

      if (outcome.status === "kept") {
        lines.push(`ORPHAN KEPT: path=${logPath} reason=${outcome.reason}`);
      } else {
        // Karantinas privalo būti MATOMAS: kopija lieka stovėti ir laukia žmogaus.
        lines.push(`ORPHAN KEPT: path=${logPath} reason=check-failed:quarantined:${outcome.reasons.join(",")}`);
      }
    }

    if (deferred > 0) {
      lines.push(`ORPHAN REAP TRUNCATED: removed=${removals} limit=${limit}; liko ${deferred} kitam praėjimui`);
    }
  } catch (error: unknown) {
    lines.push(`ORPHAN REAP FAILED: ${error instanceof Error ? error.message : String(error)}`);
  }
  return lines;
}
