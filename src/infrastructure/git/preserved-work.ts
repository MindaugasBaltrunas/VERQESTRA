// Preserved darbo (`refs/verqestra/preserved/<sha>`, žr. rollback-scope.ts `preserveTaskScope`)
// izoliuotas materializavimas detached worktree'e. Tik materializavimas: jokio sprendimo, ar
// darbas atkuriamas, jokio patikrų paleidimo — tai paliekama vėlesniam (atskiros užduoties)
// review use-case'ui, kuris šią funkciją gaus per portą.
//
// Naudoja tą patį worktree mechanizmą kaip task-scoped kopijos: git plumbing per
// `worktree-git-util`, kelio saugumą ir šaknies gitignore invariantą per `worktree-layout`,
// šalinimą (su Windows ilgo kelio fallback grandine) per `worktree-removal`, o dist/node_modules
// bootstrap'ą (kad vėliau būtų galima paleisti patikras) — per `worktree-runtime`, SAVANORIŠKAI:
// be jo worktree turi tik versijuotus failus, ir tai yra tinkamas numatytas elgesys šiai užduočiai.

import { mkdir } from "node:fs/promises";
import path from "node:path";
import { run } from "../process/run-process.js";
import { gitResolveCommit } from "./git-client.js";
import { ensureWorktreeRuntime, type EnsureWorktreeRuntimeInput } from "./worktrees/worktree-runtime.js";
import { worktreeGit, worktreeGitFailure } from "./worktrees/worktree-git-util.js";
import { WORKTREE_ROOT_DIR, assertInsideProject, worktreeRootIsIgnored } from "./worktrees/worktree-layout.js";
import {
  pruneWorktrees,
  removeIfEmptyDir,
  removeWorktreeDirectory,
  type WorktreeGitRunner,
} from "./worktrees/worktree-removal.js";

/** Bootstrap žingsnis PO worktree sukūrimo — be `projectRoot`/`worktreeAbs`, juos priduoda ši funkcija. */
export type PreservedWorkRuntime = Omit<EnsureWorktreeRuntimeInput, "projectRoot" | "worktreeAbs">;

export type MaterializedPreservedWork = {
  /** Detached worktree absoliutus kelias. */
  worktreePath: string;
  /** Preserved commit'o tėvo sha — būsena, prieš kurią diffinosi išsaugotas darbas. */
  baseRef: string;
  /** Keliai, kurie skyrėsi tarp `baseRef` ir preserved commit'o. */
  changedPaths: string[];
  /** Pašalina worktree'ą. Nesėkmė meta klaidą — kvietėjas sprendžia, ar tai fail-closed. */
  dispose: () => Promise<void>;
};

export type MaterializePreservedWorkResult =
  | { ok: true; work: MaterializedPreservedWork }
  | { ok: false; reason: "ref-not-found"; ref: string }
  | { ok: false; reason: "empty-diff"; ref: string; baseRef: string }
  | { ok: false; reason: "worktree-failed"; ref: string; message: string };

export type MaterializePreservedWorkInput = {
  projectRoot: string;
  /** `refs/verqestra/preserved/<sha>`. */
  ref: string;
  /** Numatyta: `.ag/worktrees/preserved/<sha12>`. Testams/pakartotiniam naudojimui — savas kelias. */
  worktreePath?: string;
  /** Papildomas dist/node_modules bootstrap; be jo worktree turi tik versijuotus failus. */
  runtime?: PreservedWorkRuntime;
  /** Tik testams: dispose git runner'is (long-path fallback injekcijai). */
  removalRunner?: WorktreeGitRunner;
  /** Tik testams: dispose fallback-3 katalogo šalintojas. */
  removalRemover?: (target: string) => Promise<void>;
};

function defaultWorktreePath(projectRoot: string, commit: string): string {
  return path.resolve(projectRoot, WORKTREE_ROOT_DIR, "preserved", commit.slice(0, 12));
}

/**
 * `refs/verqestra/preserved/<sha>` → izoliuotas detached worktree su tuo pačiu turiniu.
 *
 * Kiekviena nesėkmė grįžta kaip rezultato tipas, ne throw: ref gali neegzistuoti (jau
 * išvalytas arba klaidingai perduotas), diff gali būti tuščias (preserve žingsnis nieko
 * neišsaugojo), arba pats `git worktree add` gali nepavykti (užimtas kelias, FS klaida).
 * Bet kuriuo atveju kvietėjas gauna aiškią priežastį, o ne pusiau sukurtą worktree.
 */
export async function materializePreservedWork(
  input: MaterializePreservedWorkInput,
): Promise<MaterializePreservedWorkResult> {
  const projectRoot = path.resolve(input.projectRoot);
  const ref = input.ref;

  const commit = await gitResolveCommit(ref, projectRoot);
  if (!commit) return { ok: false, reason: "ref-not-found", ref };

  const parentArgs = ["rev-parse", "--verify", `${commit}^1`];
  const parent = await worktreeGit(projectRoot, parentArgs);
  if (parent.code !== 0) {
    return { ok: false, reason: "worktree-failed", ref, message: worktreeGitFailure(parent, parentArgs) };
  }
  const baseRef = parent.stdout.trim();

  const diffArgs = ["diff", "--name-only", baseRef, commit];
  const diff = await worktreeGit(projectRoot, diffArgs);
  if (diff.code !== 0) {
    return { ok: false, reason: "worktree-failed", ref, message: worktreeGitFailure(diff, diffArgs) };
  }
  const changedPaths = diff.stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  if (changedPaths.length === 0) return { ok: false, reason: "empty-diff", ref, baseRef };

  const worktreePath = input.worktreePath ? path.resolve(input.worktreePath) : defaultWorktreePath(projectRoot, commit);
  try {
    assertInsideProject(projectRoot, worktreePath);
  } catch (error) {
    return { ok: false, reason: "worktree-failed", ref, message: error instanceof Error ? error.message : String(error) };
  }
  if (!(await worktreeRootIsIgnored(projectRoot))) {
    return {
      ok: false,
      reason: "worktree-failed",
      ref,
      message: `${WORKTREE_ROOT_DIR} nėra gitignore'inta — preserved worktree padarytų pagrindinį medį nešvarų`,
    };
  }

  await mkdir(path.dirname(worktreePath), { recursive: true });
  const addArgs = ["worktree", "add", "--detach", worktreePath, commit];
  const added = await worktreeGit(projectRoot, addArgs);
  if (added.code !== 0) {
    return { ok: false, reason: "worktree-failed", ref, message: worktreeGitFailure(added, addArgs) };
  }

  if (input.runtime) {
    await ensureWorktreeRuntime({ projectRoot, worktreeAbs: worktreePath, ...input.runtime });
  }

  const dispose = async (): Promise<void> => {
    const removal = await removeWorktreeDirectory(input.removalRunner ?? run, projectRoot, worktreePath, input.removalRemover);
    if (removal.status !== "removed") {
      throw new Error(`preserved worktree dispose nepavyko (${worktreePath}): ${removal.message}`);
    }
    await pruneWorktrees(projectRoot);
    await removeIfEmptyDir(path.dirname(worktreePath));
  };

  return { ok: true, work: { worktreePath, baseRef, changedPaths, dispose } };
}
