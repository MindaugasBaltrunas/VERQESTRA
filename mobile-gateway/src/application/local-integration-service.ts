import { randomUUID } from "node:crypto";
import {
  assertIntegrationConfirmation,
  CommandIntentError,
  type IntegrationConfirmation,
  type IntegrationPreview,
  type IntegrationRevalidation,
  type IntegrationStrategy,
  type LocalControlActor,
} from "../domain/command-intent.js";
import { LocalControlError } from "./local-control-errors.js";
import { assertLocalGitArgv } from "./local-git-argv-policy.js";
import { isCommitOid } from "./git-ref-shapes.js";
import { REQUIRED_GATE_NAMES } from "./session-gate-policy.js";
import {
  observe,
  readGit,
  recordReviewReady,
  transition,
  type IntegrationReadDeps,
  type ObservedRepository,
} from "./local-integration-observe.js";
import type { GitRunnerPort } from "./ports/git-runner-port.js";
import type { SessionGateEvidencePort } from "./ports/session-gate-evidence-port.js";
import type { SessionRegistryStorePort } from "./ports/session-registry-store-port.js";

/**
 * The integration contract, re-exported for the transport that carries it.
 *
 * Dependencies point inwards, so `interfaces/http` may not import `domain/`
 * directly; the application module that owns this flow is the sanctioned path
 * for the router to reach it — the same arrangement `device-auth-service.ts`
 * provides for the remote router.
 */
export { assertDigest, CommandIntentError, INTEGRATION_STRATEGIES } from "../domain/command-intent.js";
export type {
  IntegrationConfirmation,
  IntegrationPreview,
  IntegrationStrategy,
  LocalControlActor,
} from "../domain/command-intent.js";

/**
 * Preview and confirm of a local branch integration.
 *
 * The whole point of the two-step flow in `local-control-contract.md` is that
 * the operator approves a SPECIFIC state of the repository, so this service is
 * organised around one rule: nothing observed during the preview is trusted at
 * confirm time. Every Git fact is read again, the domain re-checks it against
 * the preview, and only then does a merge run.
 *
 * Three further properties are structural rather than incidental:
 *
 * - **The preview cannot change Git.** It runs read-only plumbing exclusively,
 *   and `assertLocalGitArgv(..., "read")` is what makes that a refusal instead
 *   of a convention.
 * - **A preview is spent before it is used.** Confirmation burns the preview
 *   ahead of any work, so two concurrent confirms cannot both find it unused.
 * - **A conflict never destroys anything.** The merge is aborted, HEAD is
 *   verified to be exactly where it was, and the worktree returns to
 *   `review_ready` for manual resolution — it is never deleted.
 *
 * Skaitymo pusė gyvena `local-integration-observe.ts` (žr. ten dėl skaidymo priežasčių).
 */

export type LocalIntegrationDependencies = Readonly<{
  git: GitRunnerPort;
  registry: SessionRegistryStorePort;
  gates: SessionGateEvidencePort;
  /** Repository the session's branch must be integrated INTO. */
  repositoryRootOf: (sessionId: string) => Promise<string>;
  /**
   * Gates that must appear in the evidence, green, before an integration is
   * possible. Defaults to the five `design.md` §7 requires; a host may name
   * more, and this service — the verifier — is where that list lives.
   */
  requiredGateNames?: readonly string[];
  clock?: () => Date;
  previewTtlMs?: number;
  maxPreviews?: number;
}>;

export type IntegrationResult = Readonly<{
  integrationId: string;
  sessionId: string;
  targetBranch: string;
  targetHeadBefore: string;
  targetHeadAfter: string;
  mergeCommit: string;
  strategy: IntegrationStrategy;
}>;

type PreviewEntry = {
  preview: IntegrationPreview;
  sessionId: string;
  state: "issued" | "consumed";
  expiresAtMs: number;
};

const DEFAULT_PREVIEW_TTL_MS = 5 * 60 * 1000;
const DEFAULT_MAX_PREVIEWS = 32;

export class LocalIntegrationService {
  private readonly previews = new Map<string, PreviewEntry>();
  private operationQueue: Promise<void> = Promise.resolve();

  private readonly reads: IntegrationReadDeps;
  private readonly git: GitRunnerPort;
  private readonly clock: () => Date;
  private readonly previewTtlMs: number;
  private readonly maxPreviews: number;

  constructor(dependencies: LocalIntegrationDependencies) {
    this.git = dependencies.git;
    const requiredGateNames = dependencies.requiredGateNames ?? REQUIRED_GATE_NAMES;
    this.reads = Object.freeze({
      git: dependencies.git,
      registry: dependencies.registry,
      gates: dependencies.gates,
      repositoryRootOf: dependencies.repositoryRootOf,
      requiredGateNames,
    });
    this.clock = dependencies.clock ?? (() => new Date());
    this.previewTtlMs = dependencies.previewTtlMs ?? DEFAULT_PREVIEW_TTL_MS;
    this.maxPreviews = dependencies.maxPreviews ?? DEFAULT_MAX_PREVIEWS;
    if (
      !Number.isSafeInteger(this.previewTtlMs) || this.previewTtlMs <= 0 ||
      !Number.isSafeInteger(this.maxPreviews) || this.maxPreviews <= 0
    ) {
      throw new Error("Local integration preview bounds are invalid");
    }
    // An empty list would make every record "complete", and a duplicated name
    // would hide a typo behind a gate that happens to be recorded twice.
    if (
      requiredGateNames.length === 0 ||
      new Set(requiredGateNames).size !== requiredGateNames.length
    ) {
      throw new Error("Local integration required gate names are invalid");
    }
  }

  /**
   * One integration at a time, for the same reason the terminal supervisor
   * serialises its own work: two confirms interleaving around a merge would each
   * read a repository state the other is in the middle of changing.
   */
  private async exclusively<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.operationQueue;
    let release = (): void => undefined;
    this.operationQueue = new Promise<void>((resolveQueue) => {
      release = resolveQueue;
    });
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  }

  private issuePreview(preview: IntegrationPreview, sessionId: string, expiresAtMs: number): void {
    const nowMs = this.clock().getTime();
    for (const [integrationId, entry] of this.previews) {
      if (entry.expiresAtMs <= nowMs) {
        this.previews.delete(integrationId);
      }
    }
    if (this.previews.size >= this.maxPreviews) {
      throw new LocalControlError("rate_limited", "Too many integration previews are outstanding");
    }
    this.previews.set(preview.integrationId, { preview, sessionId, state: "issued", expiresAtMs });
  }

  async preview(input: { sessionId: string; actor: LocalControlActor }): Promise<IntegrationPreview> {
    return this.exclusively(async () => {
      if (!input.actor.isLocalOsOwner) {
        throw new LocalControlError("forbidden", "Integration preview is reserved for the local OS owner");
      }
      const observed = await observe(this.reads, input.sessionId);
      const expiresAtMs = this.clock().getTime() + this.previewTtlMs;
      const preview: IntegrationPreview = Object.freeze({
        integrationId: randomUUID(),
        sessionId: input.sessionId,
        sourceBranch: observed.worktree.branch,
        sourceCommit: observed.sourceCommit,
        targetBranch: observed.targetBranch,
        targetHead: observed.targetHead,
        changedFiles: observed.changedFiles,
        diffDigest: observed.diffDigest,
        gateDigest: observed.gateDigest,
        gatesPassed: observed.gatesPassed,
        targetClean: observed.targetClean,
        expiresAt: new Date(expiresAtMs).toISOString(),
      });
      this.issuePreview(preview, input.sessionId, expiresAtMs);
      await recordReviewReady(
        this.reads,
        observed.worktree,
        observed.evidence,
        observed.targetClean,
        observed.processEnded,
      );
      return preview;
    });
  }

  async integrate(input: {
    sessionId: string;
    confirmation: IntegrationConfirmation;
    actor: LocalControlActor;
    verifyConfirmation: (confirmation: IntegrationConfirmation) => boolean;
  }): Promise<IntegrationResult> {
    return this.exclusively(async () => {
      // Ownership is settled first, exactly as the preview settles it. The
      // domain re-checks the same fact during revalidation and remains the last
      // line of defence, but by then the preview has been spent and the
      // repository read six times — so a caller the transport never proved is
      // the local OS owner would be able to burn the operator's approval and
      // put the host's Git plumbing to work on the way to being refused.
      if (!input.actor.isLocalOsOwner) {
        throw new LocalControlError("forbidden", "Integration is reserved for the local OS owner");
      }
      const entry = this.previews.get(input.confirmation.integrationId);
      if (!entry) {
        throw new LocalControlError("not_found", "Integration preview is unknown or expired");
      }
      if (entry.sessionId !== input.sessionId) {
        throw new LocalControlError("invalid_request", "Integration preview belongs to another session");
      }
      // Spent before anything is read or run: a second confirm that arrives
      // while this one is working must find the preview already used rather
      // than race it to the merge.
      const previewConsumed = entry.state === "consumed";
      entry.state = "consumed";

      if (!input.verifyConfirmation(input.confirmation)) {
        throw new LocalControlError("forbidden", "local re-auth proof is invalid");
      }
      const now = this.clock();
      const actor: LocalControlActor = {
        ...input.actor,
        reauthenticatedAt: now.toISOString(),
      };
      const observed = await observe(this.reads, input.sessionId);
      const revalidation: IntegrationRevalidation = {
        now,
        previewConsumed,
        observedSourceCommit: observed.sourceCommit,
        observedTargetHead: observed.targetHead,
        observedTargetClean: observed.targetClean,
        observedDiffDigest: observed.diffDigest,
        observedGateDigest: observed.gateDigest,
        observedGatesPassed: observed.gatesPassed,
        actor,
      };
      try {
        assertIntegrationConfirmation(entry.preview, input.confirmation, revalidation);
      } catch (error) {
        if (error instanceof CommandIntentError) {
          // The domain already chose between "you sent something else"
          // (`invalid_request`) and "the world moved" (`conflict`); the codes
          // are shared, so nothing is re-decided here.
          throw new LocalControlError(error.code, error.message);
        }
        throw error;
      }
      // The domain compares commits, never names. Two refs can point at the same
      // commit, so a HEAD that was moved onto another branch of that same commit
      // passes every oid comparison while integrating into a branch the operator
      // was never shown. The previewed name is part of what was approved.
      if (observed.targetBranch !== entry.preview.targetBranch) {
        throw new LocalControlError("conflict", "Target branch changed after the preview");
      }

      await transition(this.reads, input.sessionId, "locally_integrating", { localOperator: true });
      await this.assertTargetStillApproved(observed, input.sessionId);
      const mergeArgs = ["merge", "--no-ff", "--no-edit", observed.sourceCommit];
      assertLocalGitArgv(mergeArgs, "integrate");
      const merge = await this.git.run(observed.repositoryRoot, mergeArgs);
      if (merge.exitCode !== 0) {
        await this.abortMerge(observed);
        await transition(this.reads, input.sessionId, "review_ready", {});
        throw new LocalControlError(
          "conflict",
          "Integration conflicted; the target is unchanged and the worktree is retained",
        );
      }
      const mergeCommit = await this.verifyMergeCommit(observed);
      await transition(this.reads, input.sessionId, "integrated", {});
      return Object.freeze({
        integrationId: input.confirmation.integrationId,
        sessionId: input.sessionId,
        targetBranch: observed.targetBranch,
        targetHeadBefore: observed.targetHead,
        targetHeadAfter: mergeCommit,
        mergeCommit,
        strategy: input.confirmation.strategy,
      });
    });
  }

  /**
   * The last look at the target before the merge runs.
   *
   * Recording `locally_integrating` is a durable write, so the repository has
   * had one more chance to move since it was observed. Re-reading HEAD and the
   * working tree here is what keeps "the operator approved a SPECIFIC state"
   * true right up to the command that changes it: a target that moved, or one
   * that stopped being clean, is refused while nothing has been touched, and
   * the worktree returns to `review_ready` rather than being left mid-flight.
   */
  private async assertTargetStillApproved(
    observed: ObservedRepository,
    sessionId: string,
  ): Promise<void> {
    const head = (await readGit(this.reads, observed.repositoryRoot, [
      "rev-parse",
      "--verify",
      "HEAD^{commit}",
    ])).trim();
    const clean = (await readGit(this.reads, observed.repositoryRoot, ["status", "--porcelain"])).trim() === "";
    if (head === observed.targetHead && clean) {
      return;
    }
    await transition(this.reads, sessionId, "review_ready", {});
    throw new LocalControlError("conflict", "The target moved after the integration was approved");
  }

  /**
   * Returns the target to exactly where it was.
   *
   * If the abort fails, or HEAD is not back at the previewed commit, the
   * repository is in a state this service must not guess about: it reports an
   * internal failure and leaves the worktree in `locally_integrating` so an
   * operator sees an unfinished integration instead of a tidy lie.
   */
  private async abortMerge(observed: ObservedRepository): Promise<void> {
    const abortArgs = ["merge", "--abort"];
    assertLocalGitArgv(abortArgs, "integrate");
    const abort = await this.git.run(observed.repositoryRoot, abortArgs);
    const head = (await readGit(this.reads, observed.repositoryRoot, [
      "rev-parse",
      "--verify",
      "HEAD^{commit}",
    ])).trim();
    if (abort.exitCode !== 0 || head !== observed.targetHead) {
      throw new LocalControlError(
        "internal_error",
        "Conflicted integration could not be rolled back; the repository needs manual attention",
      );
    }
  }

  /**
   * A `--no-ff` merge must produce a commit whose parents are exactly the
   * previewed target head and the previewed source commit. Anything else means
   * the merge did something other than what the operator approved.
   */
  private async verifyMergeCommit(observed: ObservedRepository): Promise<string> {
    const parents = (await readGit(this.reads, observed.repositoryRoot, [
      "rev-list",
      "--parents",
      "-n",
      "1",
      "HEAD",
    ])).trim().split(/\s+/);
    if (parents.length !== 3) {
      throw new LocalControlError("internal_error", "Merge produced an unexpected commit shape");
    }
    const [mergeCommit, first, second] = parents;
    if (
      // `mergeCommit === undefined` yra `noUncheckedIndexedAccess` pasekmė: `length !== 3`
      // patikra aukščiau tipo nesusiaurina. Elgesys nepakito — trijų elementų sąrašo pirmas
      // narys visada yra, o jei jo nebūtų, atsakymas yra tas pats atsisakymas.
      mergeCommit === undefined ||
      !isCommitOid(mergeCommit) ||
      first !== observed.targetHead ||
      second !== observed.sourceCommit
    ) {
      throw new LocalControlError("internal_error", "Merge produced an unexpected parent set");
    }
    return mergeCommit;
  }
}
