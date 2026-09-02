// Orphan'ų įvardijimas ir surinkimas (etalono worktree-lifecycle.ts orphan pusė, task
// 0020). `findOrphanWorktrees` našlaitį tik ĮVARDIJA; `reapOrphanWorktree` jį pašalina —
// bet tik kai pašalinimas nieko nekainuoja: kopija švari, šakos viršūnė pasiekiama iš
// pirminės šakos ir joks gyvas lease jos nereikalauja. Visi kiti keliai — `kept` arba
// `quarantined`: neaiški būsena laukia žmogaus. Lease store čia tik SKAITOMA.

import path from "node:path";
import {
  isLeaseActive,
  type WorkerLease,
} from "../../../domain/scheduling/worker-lease-rules.js";
import { nonRuntimeDirtyEntriesFromStatus } from "../../../domain/git/changes.js";
import { nodeFsAdapter } from "../../fs/node-fs-adapter.js";
import { run } from "../../process/run-process.js";
import { gitResolveCommit, gitWorktreeList, type GitWorktreeEntry } from "../git-client.js";
import { WORKTREE_ROOT_DIR, assertInsideProject } from "./worktree-layout.js";
import { entryFor, worktreeGit, worktreeGitFailure } from "./worktree-git-util.js";
import { quarantineWorktree, readWorktreeOwner } from "./worktree-owner.js";
import { removeIfEmptyDir, removeWorktreeDirectory, pruneWorktrees, type WorktreeGitRunner } from "./worktree-removal.js";
import { deleteWorktreeBranch } from "./worktree-branch-integration.js";
import type { WorktreeOwnerMarker, WorktreeQuarantineReason } from "./worktree-state-classifier.js";

export type OrphanWorktree = {
  entry: GitWorktreeEntry;
  owner?: WorktreeOwnerMarker;
  reason: "no-owner-marker" | "lease-not-active";
};

/**
 * Kopijos po `.ag/worktrees`, kurių už nugaros nebėra gyvo lease'o. Svetimi (ne AG)
 * worktree'ai ignoruojami — modulis atsako tik už savo namespace. Orphan'as NĖRA
 * automatiškai šalinamas: sprendimą priima iškvietėjas.
 */
export async function findOrphanWorktrees(input: {
  projectRoot: string;
  leases: readonly WorkerLease[];
  now?: Date;
}): Promise<OrphanWorktree[]> {
  const projectRoot = path.resolve(input.projectRoot);
  const now = input.now ?? new Date();
  const namespace = path.resolve(projectRoot, WORKTREE_ROOT_DIR);

  const orphans: OrphanWorktree[] = [];
  for (const entry of await gitWorktreeList(projectRoot)) {
    const entryPath = path.resolve(entry.path);
    const relative = path.relative(namespace, entryPath);
    if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) continue;

    const owner = await readWorktreeOwner(entryPath);
    if (!owner) {
      orphans.push({ entry, reason: "no-owner-marker" });
      continue;
    }
    const lease = input.leases.find((candidate) => candidate.lease_id === owner.lease_id);
    if (!lease || !isLeaseActive(lease, now) || lease.fencing_token !== owner.fencing_token) {
      orphans.push({ entry, owner, reason: "lease-not-active" });
    }
  }

  return orphans.sort((left, right) => left.entry.path.localeCompare(right.entry.path));
}

export type UnregisteredWorktreeDir = {
  /** Absoliutus kelias iki worker-task-attempt katalogo. */
  path: string;
  /** `run_id` katalogas virš jo — reikalingas, kad tuščias `run_id` katalogas irgi būtų pašalintas. */
  parentRunDir: string;
};

/**
 * `.ag/worktrees/<run_id>/*` katalogai, kurių NĖRA `git worktree list` (task 079 auditas:
 * 40 tokių katalogų, 1+ GB, niekada nebuvo pašalinti, nes `findOrphanWorktrees` mato TIK git
 * registracijas). Jie gimsta retai — nutrūkęs provizionavimas prieš `git worktree add`,
 * arba `removeWorktreeDirectory` fallback-3 likutis, kai `worktree prune` po jo nerado ką
 * valyti. Grąžinama TIK sąrašas; amžiaus patikra ir šalinimas — iškvietėjo pusėje, kad ši
 * funkcija liktų gryna ir testuojama be laiko mock'inimo.
 */
export async function findUnregisteredWorktreeDirectories(input: {
  projectRoot: string;
}): Promise<UnregisteredWorktreeDir[]> {
  const projectRoot = path.resolve(input.projectRoot);
  const namespace = path.resolve(projectRoot, WORKTREE_ROOT_DIR);
  const registered = (await gitWorktreeList(projectRoot)).map((entry) => path.resolve(entry.path));

  const result: UnregisteredWorktreeDir[] = [];
  for (const runId of await nodeFsAdapter.listSubdirectories(namespace)) {
    const parentRunDir = path.join(namespace, runId);
    for (const child of await nodeFsAdapter.listSubdirectories(parentRunDir)) {
      const childPath = path.join(parentRunDir, child);
      if (!registered.some((entry) => samePath(entry, childPath))) {
        result.push({ path: childPath, parentRunDir });
      }
    }
  }
  return result.sort((left, right) => left.path.localeCompare(right.path));
}

/** `lease_id` reikšmė, kai savininko žymos nebėra — eilutė vis tiek turi lauką, ir jis nemeluoja. */
export const ORPHAN_MISSING_LEASE_ID = "missing";

export type OrphanReapOutcome =
  /** Darbo kopija ir šaka pašalintos: darbo neprarasta, nes viskas jau buvo pirminėje šakoje. */
  | { status: "reaped"; path: string; branch: string; lease_id: string }
  /**
   * Palikta stovėti. `reason` — `uncommitted-changes`, `unmerged-commits` arba
   * `check-failed:<detalė>`; `removed` žymi retą atvejį, kai kopija jau pašalinta, o
   * sustota ties šakos trynimu (svarbu iškvietėjo šalinimų limitui).
   */
  | { status: "kept"; path: string; reason: string; removed?: boolean }
  /** Kopiją reikalauja GYVAS lease — konkurencinis loop'as ją naudoja dabar. */
  | { status: "skipped"; path: string }
  /** Būsena neaiški: kopija užrakinta karantinui, o ne pašalinta. */
  | { status: "quarantined"; path: string; reasons: WorktreeQuarantineReason[] };

/**
 * Log eilutė privalo likti VIENA eilute (git stderr naujos eilutės suploninamos į tarpus).
 * Ilgis NEKARPOMAS (task 0048) — apkirpimas slėpdavo tikrą `check-failed` priežastį.
 */
function reapDetail(message: string): string {
  return message.replace(/\s*\r?\n\s*/g, " ").trim();
}

/** Kelių lyginimas fail-closed: Windows'e didžiosios/mažosios raidės to paties kelio neišskiria. */
function samePath(left: string, right: string): boolean {
  const a = path.resolve(left);
  const b = path.resolve(right);
  return process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;
}

/** Ar bent vienas GYVAS lease reikalauja šios kopijos (pagal kelią arba savininko žymą). */
function liveLeaseClaims(input: {
  projectRoot: string;
  worktreePath: string;
  owner: WorktreeOwnerMarker | undefined;
  leases: readonly WorkerLease[];
  now: Date;
}): boolean {
  return input.leases.some((lease) => {
    if (!isLeaseActive(lease, input.now)) return false;
    if (input.owner && lease.lease_id === input.owner.lease_id) return true;
    if (!lease.worktree_path) return false;
    return samePath(path.resolve(input.projectRoot, lease.worktree_path), input.worktreePath);
  });
}

type ReapTreeState =
  | { status: "clean" }
  | { status: "dirty" }
  | { status: "unmerged" }
  /** Git komanda nepavyko — būsena NEĮRODYTA, tad ji negali reikšti „švaru". */
  | { status: "check-failed"; detail: string };

/**
 * Darbo kopijos švarumas fail-closed: bendrieji helperiai git klaidą paverčia tuščiu
 * sąrašu, o ČIA tuščias sąrašas reikštų LEIDIMĄ TRINTI — todėl būsena nuskaitoma
 * tiesiogiai ir nesėkmė grąžinama įvardyta.
 */
async function reapTreeState(worktreePath: string): Promise<ReapTreeState> {
  const unmergedArgs = ["ls-files", "--unmerged"];
  const unmerged = await worktreeGit(worktreePath, unmergedArgs);
  if (unmerged.code !== 0) return { status: "check-failed", detail: worktreeGitFailure(unmerged, unmergedArgs) };
  if (unmerged.stdout.trim().length > 0) return { status: "unmerged" };

  const statusArgs = ["status", "--short", "--untracked-files=all"];
  const status = await worktreeGit(worktreePath, statusArgs);
  if (status.code !== 0) return { status: "check-failed", detail: worktreeGitFailure(status, statusArgs) };
  // Runtime keliai yra paties loop'o pėdsakas, ne produkto darbas — ta pati riba kaip
  // nonRuntimeDirtyPaths, tik be klaidos rijimo.
  if (nonRuntimeDirtyEntriesFromStatus(status.stdout).length > 0) return { status: "dirty" };
  return { status: "clean" };
}

/**
 * Pašalina VIENĄ našlaitį — arba įvardija, kodėl to daryti negalima. Tvarka yra dalis
 * kontrakto: visi įrodymai surenkami PRIEŠ pirmą šalinimą. Neįrodyta sąlyga visada
 * reiškia „palikti", niekada — „bandyti toliau".
 */
export async function reapOrphanWorktree(input: {
  projectRoot: string;
  orphan: OrphanWorktree;
  leases: readonly WorkerLease[];
  /** Su kuo lyginama, ar šakoje liko neintegruoto darbo. Numatytai — `HEAD`. */
  primaryRef?: string;
  now?: Date;
  /** Tik testams: git runner'is ŠALINIMO grandinei; įrodymų žingsniai kviečia tikrą git. */
  runner?: WorktreeGitRunner;
  /** Tik testams: `fallback-3` katalogo šalintojas. */
  remover?: (target: string) => Promise<void>;
}): Promise<OrphanReapOutcome> {
  const projectRoot = path.resolve(input.projectRoot);
  const { entry, owner } = input.orphan;
  const worktreePath = path.resolve(entry.path);
  const now = input.now ?? new Date();
  const kept = (reason: string, removed = false): OrphanReapOutcome =>
    removed ? { status: "kept", path: worktreePath, reason, removed } : { status: "kept", path: worktreePath, reason };

  // 1. Namespace. Tikrinama iš naujo, nepasitikint iškvietėjo atranka.
  try {
    assertInsideProject(projectRoot, worktreePath);
    assertInsideProject(path.resolve(projectRoot, WORKTREE_ROOT_DIR), worktreePath);
  } catch {
    return kept("check-failed:outside-project");
  }

  // 2. Gyvas lease. Fail-closed prieš lygiagretų loop'ą.
  if (liveLeaseClaims({ projectRoot, worktreePath, owner, leases: input.leases, now })) {
    return { status: "skipped", path: worktreePath };
  }

  // 3. Užraktas yra žmogaus sprendimas (karantinas), o ne kliūtis, kurią automatika apeina.
  if (entry.locked) return kept("check-failed:locked");

  // 4. Šakos tapatybė. Tiesa yra git registracija; savininko žyma tik privalo jai neprieštarauti.
  if (entry.detached) {
    await quarantineWorktree({ projectRoot, worktreePath, reasons: ["detached-head"], now });
    return { status: "quarantined", path: worktreePath, reasons: ["detached-head"] };
  }
  const branch = entry.branch?.replace(/^refs\/heads\//, "");
  if (!branch) return kept("check-failed:unknown-branch");
  if (owner && owner.branch !== branch) return kept("check-failed:branch-mismatch");

  // 5. Švarumas. Dingęs katalogas tikrinamas atskirai: git klaida negali reikšti leidimo trinti.
  const directoryPresent = await nodeFsAdapter.exists(worktreePath);
  if (directoryPresent) {
    const tree = await reapTreeState(worktreePath);
    if (tree.status === "check-failed") return kept(`check-failed:${reapDetail(tree.detail)}`);
    if (tree.status === "dirty") return kept("uncommitted-changes");
    if (tree.status === "unmerged") {
      await quarantineWorktree({ projectRoot, worktreePath, reasons: ["unmerged-paths"], now });
      return { status: "quarantined", path: worktreePath, reasons: ["unmerged-paths"] };
    }
  }

  // 6. Neintegruotas darbas. Tikrinama PRIEŠ bet kokį šalinimą.
  const branchHead = await gitResolveCommit(`refs/heads/${branch}`, projectRoot);
  if (!branchHead) return kept(`check-failed:${reapDetail(`cannot-resolve-branch ${branch}`)}`);
  const primaryRef = input.primaryRef ?? "HEAD";
  const primaryHead = await gitResolveCommit(primaryRef, projectRoot);
  if (!primaryHead) return kept(`check-failed:${reapDetail(`cannot-resolve-ref ${primaryRef}`)}`);
  const ancestorArgs = ["merge-base", "--is-ancestor", branchHead, primaryHead];
  const ancestor = await worktreeGit(projectRoot, ancestorArgs);
  if (ancestor.code === 1) return kept("unmerged-commits");
  if (ancestor.code !== 0) return kept(`check-failed:${reapDetail(worktreeGitFailure(ancestor, ancestorArgs))}`);

  // 7. Darbo kopija. Ta pati grandinė kaip removeTaskWorktree (Windows ilgo kelio fallback'ai).
  //
  // Task 125 diagnozė (2026-09-02, flake P2): `git worktree remove` (be --force) atsisako
  // šalinti TIK jei jo vidinis FS skenas MATO nešvarų failą TĄ akimirką. Ką tik įrašytas
  // runtime-only failas (pvz. `vq/state/...`, atominis tmp+rename) retai gali dar nebūti
  // matomas tam skenui Windows'e (FS metaduomenų/AV-indexer vėlavimas) — tada šis kvietimas
  // praeina BE --force ir žemiau grąžinamas grynas `reaped` (be `archive=`), o ne laukiamas
  // `kept`. Tai NĖRA turinio praradimas: `reapTreeState` (5 žingsnis) tokį turinį jau laiko
  // "švariu" per `nonRuntimeDirtyEntriesFromStatus` (tas pats runtime-prefix'ų sąrašas kaip
  // `worktree-removal.ts` RUNTIME_JUNK_PREFIXES) — jis niekada nebuvo laikomas darbu, kurio
  // reikia archyvuoti. Jei ši lenktynė kada nors pasireikštų su NE-runtime (produkto) turiniu,
  // tai būtų realus defektas — bet `reapTreeState` jį būtų pažymėjęs `dirty` jau anksčiau ir
  // sustabdęs prieš pasiekiant šią eilutę, nepriklausomai nuo šios lenktynės.
  if (directoryPresent) {
    const removal = await removeWorktreeDirectory(input.runner ?? run, projectRoot, worktreePath, input.remover);
    if (removal.status !== "removed") return kept(`check-failed:${reapDetail(removal.message)}`);
  }
  await pruneWorktrees(projectRoot);
  if (!directoryPresent && entryFor(await gitWorktreeList(projectRoot), worktreePath)) {
    return kept("check-failed:stale-registration survived prune");
  }
  await removeIfEmptyDir(path.dirname(worktreePath));

  // 8. Šaka. Tik `git branch -d`: git atsisakymas trinti nesulietą šaką yra reikalinga savybė.
  const deleted = await deleteWorktreeBranch({ projectRoot, branch });
  if (deleted.status === "deleted" || deleted.status === "absent") {
    return { status: "reaped", path: worktreePath, branch, lease_id: owner?.lease_id ?? ORPHAN_MISSING_LEASE_ID };
  }
  // Kopijos nebėra, bet šaka lieka diske — neintegruotas darbas nedingsta.
  if (deleted.status === "unmerged") return kept("unmerged-commits", true);
  return kept(`check-failed:${reapDetail(deleted.message)}`, true);
}
