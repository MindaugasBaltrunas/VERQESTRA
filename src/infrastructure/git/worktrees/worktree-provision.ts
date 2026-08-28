// Izoliuotos kopijos inspekcija ir kūrimas/saugus perėmimas (etalono
// worktree-lifecycle.ts provision pusė). Trys invariantai (etalonas):
//   1. pagrindinė šaka nejuda ir pagrindinis medis neliečiamas (tik `git worktree`);
//   2. neaiški būsena niekada nevaloma automatiškai — ji keliauja į karantiną;
//   3. nuosavybė yra lease, ne kelias.
// Nuosavybės TAISYKLĖS — domain/scheduling; čia lieka git ir failų sistema.

import path from "node:path";
import {
  type WorkerLease,
  type WorkerLeaseClaim,
} from "../../../domain/scheduling/worker-lease-rules.js";
import { nodeFsAdapter } from "../../fs/node-fs-adapter.js";
import { gitWorktreeList, isGitRepository } from "../git-client.js";
import { nonRuntimeDirtyPaths } from "../integration-branch.js";
import {
  WORKTREE_ROOT_DIR,
  worktreeLayout,
  worktreeRootIsIgnored,
  type WorktreeIdentity,
  type WorktreeLayout,
} from "./worktree-layout.js";
import { entryFor, unmergedPathsIn, worktreeGit, worktreeGitFailure } from "./worktree-git-util.js";
import { ownerMarkerFor, quarantineWorktree, readWorktreeOwner, writeWorktreeOwner } from "./worktree-owner.js";
import { cleanupWorktreeRegistrations } from "./worktree-registration-cleanup.js";
import {
  classifyWorktreeState,
  type WorktreeOwnerMarker,
  type WorktreeQuarantineReason,
  type WorktreeState,
} from "./worktree-state-classifier.js";

/** Esamos kopijos būsena. Nesantis katalogas ir neregistruotas worktree abu reiškia `absent`. */
export async function inspectTaskWorktree(input: {
  projectRoot: string;
  identity: WorktreeIdentity;
  claim?: WorkerLeaseClaim;
}): Promise<WorktreeState> {
  const layout = worktreeLayout(input.projectRoot, input.identity);
  const entries = await gitWorktreeList(input.projectRoot);
  const entry = entryFor(entries, layout.path);
  if (!entry) return { status: "absent" };
  if (!(await nodeFsAdapter.exists(layout.path))) {
    // git dar turi įrašą, bet katalogo nebėra — tai prunable orphan'as, ne švari pradžia.
    return { status: "quarantine", entry, reasons: ["prunable"] };
  }

  const [dirtyPaths, unmerged, owner] = await Promise.all([
    nonRuntimeDirtyPaths(layout.path),
    unmergedPathsIn(layout.path),
    readWorktreeOwner(layout.path),
  ]);

  return classifyWorktreeState({
    entry,
    expectedBranch: layout.branch,
    dirtyPaths,
    unmergedPaths: unmerged,
    ...(owner ? { owner } : {}),
    ...(input.claim ? { claim: input.claim } : {}),
  });
}

export type CreateWorktreeResult =
  | { status: "created"; layout: WorktreeLayout; owner: WorktreeOwnerMarker }
  /** Kopija jau buvo ir yra saugiai tęsiama (tas pats lease, švarus medis, ta pati šaka). */
  | { status: "reused"; layout: WorktreeLayout; owner: WorktreeOwnerMarker }
  /** Kopijos būsena neaiški — ji užrakinta ir palikta žmogui. */
  | { status: "quarantined"; layout: WorktreeLayout; reasons: WorktreeQuarantineReason[] }
  | { status: "infrastructure"; message: string };

/**
 * Sukuria arba saugiai perima izoliuotą darbo kopiją.
 *
 * Kraštinis atvejis, dėl kurio ši funkcija egzistuoja: po kracho kopija LIEKA. Jei jos
 * būsena švari, ta pati šaka ir tas pats lease — darbas tęsiamas. Bet koks kitas variantas
 * keliauja į karantiną; automatinis `remove --force` čia negalimas, nes jis sunaikintų
 * vienintelį likusį neužcommitinto darbo egzempliorių.
 */
export async function createTaskWorktree(input: {
  projectRoot: string;
  identity: WorktreeIdentity;
  lease: WorkerLease;
  baseRef: string;
  now?: Date;
}): Promise<CreateWorktreeResult> {
  const projectRoot = path.resolve(input.projectRoot);
  const layout = worktreeLayout(projectRoot, input.identity);
  const now = input.now ?? new Date();

  if (!(await isGitRepository(projectRoot))) {
    return { status: "infrastructure", message: `${projectRoot} is not a git repository` };
  }
  if (!(await worktreeRootIsIgnored(projectRoot))) {
    return {
      status: "infrastructure",
      message: `${WORKTREE_ROOT_DIR} nėra gitignore'inta — izoliuotos kopijos padarytų pagrindinį medį nešvarų`,
    };
  }

  const claim: WorkerLeaseClaim = {
    lease_id: input.lease.lease_id,
    owner_id: input.lease.owner_id,
    fencing_token: input.lease.fencing_token,
  };
  let existing = await inspectTaskWorktree({ projectRoot, identity: input.identity, claim });

  if (existing.status === "quarantine" && existing.reasons.length === 1 && existing.reasons[0] === "prunable") {
    // Negyva registracija (katalogo nebėra) — `prune` ją išvalo prieš `add`, kad nauja kopija
    // negautų kolizijos sufikso vien dėl to, kad `.git/worktrees/<name>/` dar egzistuoja.
    await cleanupWorktreeRegistrations({ projectRoot });
    existing = await inspectTaskWorktree({ projectRoot, identity: input.identity, claim });
  }

  if (existing.status === "reusable") {
    const owner = ownerMarkerFor(input.lease, layout.branch, now.toISOString());
    await writeWorktreeOwner(layout.path, owner);
    return { status: "reused", layout, owner };
  }
  if (existing.status === "quarantine") {
    await quarantineWorktree({ projectRoot, worktreePath: layout.path, reasons: existing.reasons, now });
    return { status: "quarantined", layout, reasons: existing.reasons };
  }

  await nodeFsAdapter.makeDirectory(path.dirname(layout.path));

  const branchExists = await worktreeGit(projectRoot, ["show-ref", "--verify", "--quiet", `refs/heads/${layout.branch}`]);
  const args =
    branchExists.code === 0
      ? ["worktree", "add", layout.path, layout.branch]
      : ["worktree", "add", "-b", layout.branch, layout.path, input.baseRef];

  const added = await worktreeGit(projectRoot, args);
  if (added.code !== 0) return { status: "infrastructure", message: worktreeGitFailure(added, args) };

  const owner = ownerMarkerFor(input.lease, layout.branch, now.toISOString());
  await writeWorktreeOwner(layout.path, owner);
  return { status: "created", layout, owner };
}
