import {
  InvalidWorktreeTransitionError,
  transitionWorktree,
  type WorktreeRecord,
  type WorktreeState,
  type WorktreeTransitionContext,
} from "../domain/worktree-lifecycle.js";
import { isTerminalSessionState } from "../domain/session-registry.js";
import { LocalControlError } from "./local-control-errors.js";
import { diffDigestOf, gateDigestOf, gatesPassedOf } from "./local-integration-digests.js";
import { assertLocalGitArgv } from "./local-git-argv-policy.js";
import { isCommitOid, isSafeBranchName } from "./git-ref-shapes.js";
import { repositoryRelativePaths } from "./repository-relative-path.js";
import type { GitRunnerPort } from "./ports/git-runner-port.js";
import type {
  SessionGateEvidence,
  SessionGateEvidencePort,
} from "./ports/session-gate-evidence-port.js";
import type { SessionRegistryStorePort } from "./ports/session-registry-store-port.js";

/**
 * KĄ SAKO repozitorija — skaitymo pusė vietinės integracijos srauto.
 *
 * SKAIDYMAS (VERQESTRA ≤500 eil. vartas; etalone `local-integration-service.ts` buvo 547
 * eilutės). Pjūvis vienas ir eina per prasmę: čia — kiekvienas Git faktas ir worktree įrašo
 * perkėlimas; `local-integration-service.ts` — dviejų žingsnių patvirtinimas (preview →
 * confirm), kuris tais faktais naudojasi.
 *
 * Kodėl skaidymas čia nekainuoja enkapsuliacijos, skirtingai nei `terminal-supervisor`
 * atveju: šios funkcijos NETURI kintamos būsenos. Viskas, ko jos prašo — portai ir
 * konfigūracija — ateina `IntegrationReadDeps` objektu, tad jos yra laisvos funkcijos, o ne
 * klasės, kuriai reikėtų atverti privačius laukus.
 */

export type IntegrationReadDeps = Readonly<{
  git: GitRunnerPort;
  registry: SessionRegistryStorePort;
  gates: SessionGateEvidencePort;
  /** Repository the session's branch must be integrated INTO. */
  repositoryRootOf: (sessionId: string) => Promise<string>;
  /**
   * Gates that must appear in the evidence, green, before an integration is
   * possible. The verifier's own configuration, never the artefact's.
   */
  requiredGateNames: readonly string[];
}>;

/** Everything the confirm step must observe again, gathered in one pass. */
export type ObservedRepository = Readonly<{
  repositoryRoot: string;
  worktree: WorktreeRecord;
  /** The session that owns this worktree reached a terminal state. */
  processEnded: boolean;
  sourceCommit: string;
  targetBranch: string;
  targetHead: string;
  targetClean: boolean;
  changedFiles: readonly string[];
  diffDigest: string;
  gateDigest: string;
  gatesPassed: boolean;
  evidence?: SessionGateEvidence;
}>;

export async function readGit(
  deps: IntegrationReadDeps,
  repositoryRoot: string,
  args: readonly string[],
): Promise<string> {
  assertLocalGitArgv(args, "read");
  const result = await deps.git.run(repositoryRoot, args);
  if (result.exitCode !== 0) {
    throw new LocalControlError("internal_error", `Repository state could not be read (git ${args[0]})`);
  }
  return result.stdout;
}

/**
 * The worktree record plus the one session fact the review rule depends on.
 *
 * Both come from the same snapshot read on purpose: whether the agent process
 * has finished is what separates reviewable work from a session still writing
 * to the tree, and reading it separately would let the two disagree. A session
 * the registry does not know, or one whose outcome is `orphaned`, counts as
 * NOT ended — the review evidence must be observed, never assumed.
 */
async function worktreeOf(
  deps: IntegrationReadDeps,
  sessionId: string,
): Promise<Readonly<{ record: WorktreeRecord; processEnded: boolean }>> {
  const snapshot = await deps.registry.read();
  const record = snapshot.worktrees[sessionId];
  if (!record) {
    throw new LocalControlError("not_found", "No worktree is recorded for this session");
  }
  if (!isSafeBranchName(record.branch)) {
    throw new LocalControlError("internal_error", "Recorded session branch is not a plain ref name");
  }
  const session = snapshot.sessions[sessionId];
  return Object.freeze({
    record,
    processEnded: session !== undefined && isTerminalSessionState(session.state),
  });
}

/** Reads every fact the preview shows and the confirm re-checks. */
export async function observe(
  deps: IntegrationReadDeps,
  sessionId: string,
): Promise<ObservedRepository> {
  const { record: worktree, processEnded } = await worktreeOf(deps, sessionId);
  const repositoryRoot = await deps.repositoryRootOf(sessionId);
  const sourceCommit = (await readGit(deps, repositoryRoot, [
    "rev-parse",
    "--verify",
    `${worktree.branch}^{commit}`,
  ])).trim();
  const targetBranch = (await readGit(deps, repositoryRoot, ["symbolic-ref", "--short", "HEAD"])).trim();
  const targetHead = (await readGit(deps, repositoryRoot, [
    "rev-parse",
    "--verify",
    "HEAD^{commit}",
  ])).trim();
  if (!isCommitOid(sourceCommit) || !isCommitOid(targetHead) || targetBranch.length === 0) {
    throw new LocalControlError("internal_error", "Repository reported an unusable branch or commit");
  }
  const targetClean = (await readGit(deps, repositoryRoot, ["status", "--porcelain"])).trim() === "";
  const range = `${targetHead}...${sourceCommit}`;
  const changedFiles = repositoryRelativePaths(
    await readGit(deps, repositoryRoot, ["diff", "--name-only", range]),
  );
  const rawDiff = await readGit(deps, repositoryRoot, ["diff", "--unified=0", range]);
  const evidence = await deps.gates.evidenceFor(sessionId);
  return Object.freeze({
    repositoryRoot,
    worktree,
    processEnded,
    sourceCommit,
    targetBranch,
    targetHead,
    targetClean,
    changedFiles,
    diffDigest: diffDigestOf(changedFiles, rawDiff),
    gateDigest: gateDigestOf(evidence),
    gatesPassed: gatesPassedOf(evidence, sourceCommit, deps.requiredGateNames),
    ...(evidence ? { evidence } : {}),
  });
}

export async function transition(
  deps: IntegrationReadDeps,
  sessionId: string,
  next: WorktreeState,
  context: WorktreeTransitionContext,
): Promise<void> {
  try {
    await deps.registry.update((snapshot) => {
      const record = snapshot.worktrees[sessionId];
      if (!record) {
        throw new LocalControlError("not_found", "Worktree record disappeared during the integration");
      }
      return {
        snapshot: {
          ...snapshot,
          revision: snapshot.revision + 1,
          worktrees: {
            ...snapshot.worktrees,
            [sessionId]: transitionWorktree(record, next, context),
          },
        },
        result: undefined,
      };
    });
  } catch (error) {
    if (error instanceof LocalControlError) throw error;
    if (error instanceof InvalidWorktreeTransitionError) {
      throw new LocalControlError("conflict", `Worktree cannot move to ${next}`);
    }
    throw new LocalControlError("internal_error", "Worktree disposition could not be recorded");
  }
}

/**
 * Records that reviewable work exists, when the evidence for it does.
 *
 * A preview is a read; it must not fail because bookkeeping did, and it must
 * not invent review evidence it did not see. Both directions are why this
 * swallows its own failure and why it does nothing at all without recorded
 * gates and a clean target.
 */
export async function recordReviewReady(
  deps: IntegrationReadDeps,
  worktree: WorktreeRecord,
  evidence: SessionGateEvidence | undefined,
  targetClean: boolean,
  processEnded: boolean,
): Promise<void> {
  if (!processEnded || !evidence || evidence.gates.length === 0 || !targetClean) return;
  const path: readonly WorktreeState[] = worktree.state === "ready"
    ? ["dirty", "review_ready"]
    : worktree.state === "dirty"
      ? ["review_ready"]
      : [];
  if (path.length === 0) return;
  const review = {
    // Every field is something this preview actually observed: the registry
    // reported a terminal session state, `git status --porcelain` ran a few
    // lines above, and the gate names come from recorded evidence.
    processEnded,
    gitStatusCaptured: true,
    recordedGates: evidence.gates.map((gate) => gate.name),
  };
  try {
    for (const state of path) {
      await transition(deps, worktree.sessionId, state, { review });
    }
  } catch {
    // The disposition stays where it was; the preview itself is unaffected.
  }
}
