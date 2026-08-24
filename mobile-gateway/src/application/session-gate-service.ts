import { realpath } from "node:fs/promises";
import path from "node:path";
import type { LocalControlActor } from "../domain/command-intent.js";
import { isTerminalSessionState } from "../domain/session-registry.js";
import {
  InvalidWorktreeTransitionError,
  transitionWorktree,
  type WorktreeRecord,
  type WorktreeState,
} from "../domain/worktree-lifecycle.js";
import { LocalControlError } from "./local-control-errors.js";
import { assertLocalGitArgv } from "./local-git-argv-policy.js";
import {
  assertGateCommand,
  assertGateCommandCatalogue,
  gateStatusOf,
  orderedGateCommands,
  type GateCommandCatalogue,
} from "./session-gate-policy.js";
import type { GateCommandRunnerPort } from "./ports/gate-command-runner-port.js";
import type { GitRunnerPort } from "./ports/git-runner-port.js";
import type {
  GateResult,
  SessionGateEvidenceWritePort,
} from "./ports/session-gate-evidence-port.js";
import type { SessionRegistryStorePort } from "./ports/session-registry-store-port.js";

/**
 * Runs the five gates `design.md` §7 requires and records what they said.
 *
 * The service exists as its own entry point rather than as a step of
 * `preview()` for a plain reason: a preview is a read that owes the operator an
 * answer immediately, while a typecheck and a test suite take minutes. Folding
 * one into the other would either block a status request behind a build or
 * teach the operator to retry a preview until the gates happen to be done.
 *
 * Two further properties are structural:
 *
 * - **Evidence describes one commit.** Git is read before the gates and again
 *   after them; if HEAD moved or the tree became dirty in between, nothing is
 *   recorded. Otherwise the gates would have proven one commit while the record
 *   claimed another, and the integration flow merges the commit.
 * - **Nothing is recorded incrementally.** All five gates run — a red one does
 *   not stop the rest, because an operator repairing a branch needs the whole
 *   picture — and the record is written once, complete. A partial record read
 *   mid-run would be indistinguishable from a run that simply had fewer gates.
 */

export type SessionGateDependencies = Readonly<{
  registry: SessionRegistryStorePort;
  git: GitRunnerPort;
  runner: GateCommandRunnerPort;
  evidence: SessionGateEvidenceWritePort;
  catalogue: GateCommandCatalogue;
  /** Absolute root every session worktree must resolve inside. */
  sessionRoot: string;
  clock?: () => Date;
}>;

export type SessionGateRun = Readonly<{
  sessionId: string;
  commit: string;
  gates: readonly GateResult[];
  allPassed: boolean;
  recordedAt: string;
}>;

const COMMIT_OID = /^[0-9a-f]{40}$/;

/** Worktree dispositions a gate run may be started from. */
const RUNNABLE_STATES: ReadonlySet<WorktreeState> = new Set(["ready", "dirty", "review_ready"]);

function isInside(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
}

export class SessionGateService {
  /** Sessions with a run in flight; a second request is refused, never queued. */
  private readonly running = new Set<string>();

  private readonly registry: SessionRegistryStorePort;
  private readonly git: GitRunnerPort;
  private readonly runner: GateCommandRunnerPort;
  private readonly evidence: SessionGateEvidenceWritePort;
  private readonly catalogue: GateCommandCatalogue;
  private readonly sessionRoot: string;
  private readonly clock: () => Date;

  constructor(dependencies: SessionGateDependencies) {
    this.registry = dependencies.registry;
    this.git = dependencies.git;
    this.runner = dependencies.runner;
    this.evidence = dependencies.evidence;
    this.catalogue = dependencies.catalogue;
    this.sessionRoot = dependencies.sessionRoot;
    this.clock = dependencies.clock ?? (() => new Date());
    // Host configuration is checked once, at construction: a catalogue that
    // could only be refused at run time would let a misconfigured host look
    // healthy until the operator was already waiting on a result.
    assertGateCommandCatalogue(this.catalogue);
    if (!path.isAbsolute(this.sessionRoot)) {
      throw new Error("Session gate service session root must be absolute");
    }
  }

  private async readGit(worktreeRoot: string, args: readonly string[]): Promise<string> {
    assertLocalGitArgv(args, "read");
    const result = await this.git.run(worktreeRoot, args);
    if (result.exitCode !== 0) {
      throw new LocalControlError("internal_error", `Worktree state could not be read (git ${args[0]})`);
    }
    return result.stdout;
  }

  /**
   * The branch HEAD points at, or a refusal the operator can act on.
   *
   * `symbolic-ref` exits non-zero for a detached HEAD, which is a state an
   * operator can reach and undo — not a broken host. Reading it through
   * {@link readGit} would report that ordinary situation as an internal fault
   * and hide the one fact that explains it.
   */
  private async checkedOutBranch(worktreeRoot: string): Promise<string> {
    const args = ["symbolic-ref", "--short", "HEAD"];
    assertLocalGitArgv(args, "read");
    const result = await this.git.run(worktreeRoot, args);
    if (result.exitCode !== 0) {
      throw new LocalControlError("conflict", "The worktree has no branch checked out");
    }
    return result.stdout.trim();
  }

  /** HEAD commit and cleanliness, read together so they describe one instant. */
  private async observeWorktree(
    worktreeRoot: string,
  ): Promise<Readonly<{ commit: string; clean: boolean }>> {
    const commit = (await this.readGit(worktreeRoot, [
      "rev-parse",
      "--verify",
      "HEAD^{commit}",
    ])).trim();
    if (!COMMIT_OID.test(commit)) {
      throw new LocalControlError("internal_error", "Worktree reported an unusable commit");
    }
    const clean = (await this.readGit(worktreeRoot, ["status", "--porcelain"])).trim() === "";
    return Object.freeze({ commit, clean });
  }

  /** The worktree record for a session whose agent has finished writing to it. */
  private async runnableWorktree(sessionId: string): Promise<WorktreeRecord> {
    const snapshot = await this.registry.read();
    const record = snapshot.worktrees[sessionId];
    if (!record) {
      throw new LocalControlError("not_found", "No worktree is recorded for this session");
    }
    const session = snapshot.sessions[sessionId];
    // A gate run reads the whole tree while the agent may still be writing to
    // it, so an unfinished session is refused rather than measured.
    if (!session || !isTerminalSessionState(session.state)) {
      throw new LocalControlError("conflict", "The session is still running in this worktree");
    }
    if (!RUNNABLE_STATES.has(record.state)) {
      throw new LocalControlError("conflict", `Gates cannot run on a ${record.state} worktree`);
    }
    return record;
  }

  /** The canonical worktree path, proven to be inside the configured root. */
  private async canonicalWorktreeRoot(record: WorktreeRecord): Promise<string> {
    let sessionRoot: string;
    let resolved: string;
    try {
      // Both sides are canonicalised, exactly as `IsolatedWorktreeService` does
      // when it creates the record. Comparing a resolved worktree against an
      // UNRESOLVED root would refuse every session on a host whose session root
      // passes through a symlink or a junction — `/tmp` on macOS is one — and
      // the refusal would look like a corrupt registry rather than a
      // configuration that never matched.
      sessionRoot = await realpath(this.sessionRoot);
      resolved = await realpath(record.worktreeRoot);
    } catch {
      throw new LocalControlError("internal_error", "Recorded worktree path could not be resolved");
    }
    if (!path.isAbsolute(resolved) || !isInside(sessionRoot, resolved)) {
      throw new LocalControlError("internal_error", "Recorded worktree resolves outside the session root");
    }
    return resolved;
  }

  /**
   * Every gate, in required order, one at a time. Running them in parallel
   * would have five commands share one worktree's build cache and output
   * directories, so the results would describe the interference rather than the
   * work. A runner that throws is a host fault, not a verdict, and is recorded
   * as `errored` so the run still produces a complete record.
   */
  private async runCatalogue(worktreeRoot: string): Promise<readonly GateResult[]> {
    const results: GateResult[] = [];
    for (const command of orderedGateCommands(this.catalogue)) {
      assertGateCommand(command);
      // `NonNullable`: `GateResult["status"]` yra opcionalus, tad jo tipas neša `undefined`, o
      // `exactOptionalPropertyTypes` tokios reikšmės į opcionalų lauką neįleidžia. Čia statusas
      // priskiriamas ABIEJOSE šakose, tad `undefined` niekada nepasiekia įrašo — tipas tai ir sako.
      let status: NonNullable<GateResult["status"]>;
      let durationMs = 0;
      try {
        const outcome = await this.runner.run({
          cwd: worktreeRoot,
          executable: command.executable,
          args: command.args,
          timeoutMs: command.timeoutMs,
        });
        status = gateStatusOf(outcome);
        durationMs = outcome.durationMs;
      } catch {
        status = "errored";
      }
      results.push(Object.freeze({
        name: command.name,
        passed: status === "passed",
        status,
        durationMs,
      }));
    }
    return Object.freeze(results);
  }

  /**
   * Re-reads the disposition after the gates have run and before anything is
   * written.
   *
   * It is a pure check: it commits nothing, so a worktree that moved to a final
   * state while the gates ran ends the run with no evidence file and no registry
   * write at all. The authoritative check stays inside {@link recordDisposition}'s
   * mutation, because that one is the only one that cannot be raced; this one
   * exists so the common case does not leave an evidence record describing a run
   * whose result nobody can use.
   *
   * The window between this read and that write is deliberately NOT closed. Doing
   * so would need either an atomic evidence+registry write or a `delete` method
   * on the evidence port — and giving the writer the power to erase evidence is a
   * worse property than a narrow window. The guarantee is therefore stated
   * exactly: a disposition conflict that is visible when the gates finish records
   * nothing.
   *
   * The code and the message are word for word the ones the mutation raises, so
   * the caller cannot tell the two paths apart.
   */
  private async assertStillRunnable(sessionId: string): Promise<void> {
    const snapshot = await this.registry.read();
    const record = snapshot.worktrees[sessionId];
    if (!record) {
      throw new LocalControlError("not_found", "Worktree record disappeared during the gate run");
    }
    if (!RUNNABLE_STATES.has(record.state)) {
      throw new LocalControlError("conflict", `Worktree became ${record.state} during the gate run`);
    }
  }

  /**
   * One atomic registry write for the whole run.
   *
   * The transition path is computed from the snapshot INSIDE the mutation, not
   * from the record read at the start, so a preview that moved the worktree to
   * `review_ready` in the meantime cannot make this write attempt a transition
   * the state machine has already taken. A worktree that is already
   * `review_ready` needs no move at all: re-running the gates after a fix
   * replaces the evidence and leaves the disposition where it is.
   */
  private async recordDisposition(
    sessionId: string,
    gates: readonly GateResult[],
  ): Promise<void> {
    const review = {
      processEnded: true,
      gitStatusCaptured: true,
      recordedGates: gates.map((gate) => gate.name),
    };
    try {
      await this.registry.update((snapshot) => {
        const record = snapshot.worktrees[sessionId];
        if (!record) {
          throw new LocalControlError("not_found", "Worktree record disappeared during the gate run");
        }
        // A worktree that reached `integrated` or `quarantined` while the gates
        // ran is no longer the one they measured. Writing the record back
        // unchanged would bump the revision and report success for a run whose
        // result can never be used.
        if (!RUNNABLE_STATES.has(record.state)) {
          throw new LocalControlError("conflict", `Worktree became ${record.state} during the gate run`);
        }
        const states: readonly WorktreeState[] = record.state === "ready"
          ? ["dirty", "review_ready"]
          : record.state === "dirty"
            ? ["review_ready"]
            : [];
        let updated = record;
        for (const state of states) {
          updated = transitionWorktree(updated, state, { review });
        }
        return {
          snapshot: {
            ...snapshot,
            revision: snapshot.revision + 1,
            worktrees: { ...snapshot.worktrees, [sessionId]: updated },
          },
          result: undefined,
        };
      });
    } catch (error) {
      if (error instanceof LocalControlError) throw error;
      if (error instanceof InvalidWorktreeTransitionError) {
        throw new LocalControlError("conflict", "Worktree cannot be recorded as reviewable");
      }
      throw new LocalControlError("internal_error", "Worktree disposition could not be recorded");
    }
  }

  async runGates(input: { sessionId: string; actor: LocalControlActor }): Promise<SessionGateRun> {
    // Ownership first, before any I/O: a caller the transport never proved is
    // the local owner must not be able to make the host read a registry, let
    // alone start five commands.
    if (!input.actor.isLocalOsOwner) {
      throw new LocalControlError("forbidden", "Quality gates are reserved for the local OS owner");
    }
    if (this.running.has(input.sessionId)) {
      throw new LocalControlError("conflict", "Quality gates are already running for this session");
    }
    this.running.add(input.sessionId);
    try {
      const record = await this.runnableWorktree(input.sessionId);
      const worktreeRoot = await this.canonicalWorktreeRoot(record);
      const branch = await this.checkedOutBranch(worktreeRoot);
      if (branch !== record.branch) {
        throw new LocalControlError("conflict", "The worktree is not on the branch the registry recorded");
      }
      const before = await this.observeWorktree(worktreeRoot);
      if (!before.clean) {
        // Evidence names a commit and the integration flow merges that commit,
        // so uncommitted work would be tested and then silently left behind.
        throw new LocalControlError("conflict", "The worktree has uncommitted changes");
      }

      const gates = await this.runCatalogue(worktreeRoot);

      const after = await this.observeWorktree(worktreeRoot);
      if (after.commit !== before.commit || !after.clean) {
        throw new LocalControlError(
          "conflict",
          "The worktree changed while the gates were running; nothing was recorded",
        );
      }

      await this.assertStillRunnable(input.sessionId);

      const recordedAt = this.clock().toISOString();
      try {
        await this.evidence.record({
          sessionId: input.sessionId,
          commit: before.commit,
          gates,
          recordedAt,
        });
      } catch {
        throw new LocalControlError("internal_error", "Gate evidence could not be recorded");
      }
      await this.recordDisposition(input.sessionId, gates);

      return Object.freeze({
        sessionId: input.sessionId,
        commit: before.commit,
        gates,
        allPassed: gates.every((gate) => gate.passed),
        recordedAt,
      });
    } finally {
      this.running.delete(input.sessionId);
    }
  }
}
