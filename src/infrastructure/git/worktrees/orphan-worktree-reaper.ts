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
// eilutes. Eskalacija turi DU nepriklausomus vartus, ir kiekvienas jų yra atskiras
// atsisakymas prarasti darbą:
//   1. AMŽIUS ARBA TASK'O BŪSENA — kopija tampa eskalacijai tinkama, kai ji sena bent tiek,
//      kiek gali gyvuoti bet kuris lease (paprastam dirty/check-failed keliui — lease TTL;
//      rizikingesniam unlock/karantino keliui — senasis 24 h ORPHAN_ESCALATION_MIN_AGE_MS),
//      ARBA kai jos task'as jau `done`/dingęs. Iki 2026-08-29 (task 079) šios dvi sąlygos
//      buvo IR, ne ARBA, su viena 24 h amžiaus riba VISIEMS keliams — tai kūrė mirties
//      spiralę (GeoGravity auditas): task'as niekada nepasiekia `done`, kol jo našlaitė
//      kopija laiko šakos/kelio vardą, o kopija niekada neeskaluojama, kol task'as nėra
//      `done`. Saugumą nuo per ankstyvo pašalinimo dabar užtikrina PATS archyvavimas
//      (žemiau) ir 074-b merge-base sargas prieš `branch -D`, o ne task'o gyvavimo ciklas —
//      tad bucket'o sąlyga liko tik kaip papildomas KELIAS, ne būtina sąlyga.
//   2. PRIEŽASTIS — kelios priežastys (`outside-project`, `locked`, `branch-mismatch`, …)
//      NIEKADA neeskaluojamos: jos reiškia, kad mes nesuprantame, ką matome.
// Ir net praėjus abu, darbas pirma ARCHYVUOJAMAS kaip diff'as, ir tik tada šalinama su
// `--force`. `ORPHAN KEPT` lieka TIK atvejams, kur pats archyvavimas ar šalinimas nepavyko.
//
// Grąžinamos EILUTĖS, o ne rašoma tiesiai į žurnalą: taip verdiktus mato testai be ambient IO.
// Lease saugykla neliečiama — našlaičio lease įrašas yra fencing skaitiklio atmintis.
//
// Šis failas taip pat atlieka DVI papildomas higienos pakopas (task 079), abi po
// registracijomis paremto praėjimo: FS-lygio GC katalogams be jokios git registracijos
// (`reapUnregisteredWorktreeDirectories`), ir limitą viršijusių kandidatų eilė kitam
// praėjimui (`readDeferredQueue`/`writeDeferredQueue`), kad `ORPHAN_WORKTREE_REAP_LIMIT`
// nepaliktų tos pačios uodegos amžinai laukti.

import path from "node:path";
import {
  ORPHAN_ARCHIVE_DIR,
  ORPHAN_ESCALATION_MIN_AGE_MS,
  ORPHAN_WORKTREE_REAP_LIMIT,
  WAVE_SLOT_LEASE_TTL_MS,
} from "../../../application/scheduling/loop-runtime-config.js";
import { taskBuckets } from "../../../domain/tasks/buckets.js";
import { nodeFsAdapter } from "../../fs/node-fs-adapter.js";
import { gitResolveCommit } from "../git-client.js";
import { run, type CommandResult } from "../../process/run-process.js";
import {
  findOrphanWorktrees,
  findUnregisteredWorktreeDirectories,
  reapOrphanWorktree,
  type OrphanWorktree,
} from "./worktree-reaper.js";
import { removeIfEmptyDir } from "./worktree-removal.js";
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

/**
 * Kopija pakankamai sena, kad JOKS lease, galėjęs ją teisėtai laikyti pagal lease store
 * apskaitą, dabar nebegalėtų būti aktyvus — nepriklausomai nuo to, ar orphan detekcija jį
 * jau pažymėjo neaktyviu. Naudojama TIK paprastam dirty/check-failed keliui (žr.
 * `isEscalationEligible`); trumpesnis už `ORPHAN_ESCALATION_MIN_AGE_MS` SĄMONINGAI — kai
 * turinys jau archyvuojamas prieš šalinant (žr. `escalateOrphanRemoval`), ilgas laukimas
 * nebeapsaugo nieko, ko neapsaugotų pats archyvas.
 */
const PRESERVE_FORCE_MIN_AGE_MS = WAVE_SLOT_LEASE_TTL_MS;

/**
 * Du nepriklausomi eskalacijos KELIAI (priežastis tikrinama atskirai, žr. isEscalatableReason):
 * arba kopija jau sena bent tiek, kiek gali gyvuoti lease, arba jos task'as jau `done`/dingęs.
 * ARBA, ne IR — žr. failo antraštės pastabą 2026-08-29 (task 079) dėl mirties spiralės,
 * kurią sukėlė ankstesnė IR sąlyga.
 *
 * Amžiaus riba PRIKLAUSO nuo kelio: paprastam dirty/check-failed turiniui užtenka
 * `PRESERVE_FORCE_MIN_AGE_MS` (lease TTL), nes archyvas jau apsaugo turinį. `unlock` keliui
 * (karantinas: unmerged-paths, detached-head) būsena yra NEAIŠKI ta prasme, kad automatas
 * pats atrakina užraktą prieš šalindamas — tam paliekamas senasis, konservatyvesnis
 * `ORPHAN_ESCALATION_MIN_AGE_MS` (24 h).
 */
async function isEscalationEligible(
  agRoot: string,
  owner: WorktreeOwnerMarker,
  now: Date,
  ageFloorMs: number,
): Promise<boolean> {
  const createdAt = Date.parse(owner.created_at);
  const ageEligible = Number.isFinite(createdAt) && now.getTime() - createdAt >= ageFloorMs;
  if (ageEligible) return true;
  const bucket = await resolvedTaskBucket(agRoot, owner.task_id);
  // Dingęs task'as arba `done` — darbas nebereikalingas. Bet koks kitas bucket'as reiškia
  // gyvą task'ą; jo kopija lieka stovėti TIK jei ji dar ir jauna.
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
  const ageFloorMs = input.unlock ? ORPHAN_ESCALATION_MIN_AGE_MS : PRESERVE_FORCE_MIN_AGE_MS;
  if (!(await isEscalationEligible(input.agRoot, owner, input.now, ageFloorMs))) return undefined;

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

/** Katalogas be git registracijos laikomas prieš šalinant — apsauga nuo dar vykstančio provizionavimo. */
const UNREGISTERED_DIR_MIN_AGE_MS = 60 * 60 * 1000;

/**
 * FS-lygio GC: `.ag/worktrees/<run_id>/*` katalogai be jokios `git worktree list` registracijos.
 * Niekada nešalina to, ką `git worktree list` mato — `findUnregisteredWorktreeDirectories` jau
 * garantuoja disjoint'ą su registracijomis; čia lieka tik amžiaus patikra ir šalinimas.
 */
async function reapUnregisteredWorktreeDirectories(input: { projectRoot: string; now: Date }): Promise<string[]> {
  const lines: string[] = [];
  const candidates = await findUnregisteredWorktreeDirectories({ projectRoot: input.projectRoot });
  const touchedParents = new Set<string>();

  for (const candidate of candidates) {
    const mtime = await nodeFsAdapter.directoryModifiedAtMs(candidate.path);
    if (mtime === undefined || input.now.getTime() - mtime < UNREGISTERED_DIR_MIN_AGE_MS) continue;
    await nodeFsAdapter.removeDirectory(candidate.path);
    touchedParents.add(candidate.parentRunDir);
    lines.push(`ORPHAN DIR REMOVED: ${orphanLogPath(input.projectRoot, candidate.path)} (no registration)`);
  }

  for (const parent of touchedParents) await removeIfEmptyDir(parent);
  return lines;
}

type DeferredQueueState = { deferred: string[] };

/** Mažas state failas kitam praėjimui — ne archyvo katalogas, tad savo raktas, ne ORPHAN_ARCHIVE_DIR. */
const DEFERRED_QUEUE_FILE = ["state", "orphan-reap-deferred.json"] as const;

/** Sugadintas ar nesamas failas — tuščia eilė, ne klaida: kito praėjimo alfabetinė tvarka lieka teisinga. */
async function readDeferredQueue(runtimeRoot: string): Promise<string[]> {
  const raw = await nodeFsAdapter.readTextFileIfExists(path.join(runtimeRoot, ...DEFERRED_QUEUE_FILE));
  if (raw === undefined) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    const deferred =
      typeof parsed === "object" && parsed !== null && "deferred" in parsed
        ? (parsed as DeferredQueueState).deferred
        : undefined;
    return Array.isArray(deferred) ? deferred.filter((value): value is string => typeof value === "string") : [];
  } catch {
    return [];
  }
}

async function writeDeferredQueue(runtimeRoot: string, deferred: readonly string[]): Promise<void> {
  const state: DeferredQueueState = { deferred: [...deferred] };
  await nodeFsAdapter.writeTextFile(path.join(runtimeRoot, ...DEFERRED_QUEUE_FILE), JSON.stringify(state, null, 2));
}

/** Praėjusio praėjimo nukirptieji keliauja į sąrašo PRADŽIĄ — kitaip alfabetinė tvarka juos badautų amžinai. */
function prioritizeDeferred(orphans: readonly OrphanWorktree[], deferredPaths: readonly string[]): OrphanWorktree[] {
  const deferredSet = new Set(deferredPaths.map((entry) => path.resolve(entry)));
  const prioritized = orphans.filter((orphan) => deferredSet.has(path.resolve(orphan.entry.path)));
  const rest = orphans.filter((orphan) => !deferredSet.has(path.resolve(orphan.entry.path)));
  return [...prioritized, ...rest];
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
    const foundOrphans = await findOrphanWorktrees({ projectRoot: input.projectRoot, leases: input.leases, now });
    const deferredFromLastPass = await readDeferredQueue(input.runtimeRoot);
    const orphans = prioritizeDeferred(foundOrphans, deferredFromLastPass);

    let removals = 0;
    const deferredPaths: string[] = [];
    for (const orphan of orphans) {
      // Limitas tikrinamas PRIEŠ darbą: praėjimas su dešimtimis kopijų kitaip taptų minučių
      // operacija kiekvienos bangos pradžioje.
      if (removals >= limit) {
        deferredPaths.push(path.resolve(orphan.entry.path));
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

    if (deferredPaths.length > 0) {
      lines.push(
        `ORPHAN REAP TRUNCATED: removed=${removals} limit=${limit}; liko ${deferredPaths.length} kitam praėjimui`,
      );
    }
    await writeDeferredQueue(input.runtimeRoot, deferredPaths);

    try {
      lines.push(...(await reapUnregisteredWorktreeDirectories({ projectRoot: input.projectRoot, now })));
    } catch (error: unknown) {
      lines.push(`ORPHAN DIR GC FAILED: ${error instanceof Error ? error.message : String(error)}`);
    }
  } catch (error: unknown) {
    lines.push(`ORPHAN REAP FAILED: ${error instanceof Error ? error.message : String(error)}`);
  }
  return lines;
}
