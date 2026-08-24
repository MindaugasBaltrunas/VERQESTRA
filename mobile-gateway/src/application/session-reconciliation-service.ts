import { relative, resolve } from "node:path";
import type { GitRunnerPort } from "./ports/git-runner-port.js";
import type { ProcessIdentityPort } from "./ports/process-identity-port.js";
import type { SessionRegistryStorePort } from "./ports/session-registry-store-port.js";
import {
  decideReattachment,
  isTerminalSessionState,
  revokePersistedLease,
  type PersistedSessionRecord,
  type ReconciliationVerdict,
} from "../domain/session-registry.js";
import {
  transitionWorktree,
  type WorktreeRecord,
} from "../domain/worktree-lifecycle.js";

export type ReconciliationOutcome = Readonly<{
  sessionId: string;
  verdict: ReconciliationVerdict;
  /** Session state after reconciliation. */
  state: PersistedSessionRecord["state"];
  leaseGeneration: number;
}>;

export type ReconciliationReport = Readonly<{
  revision: number;
  outcomes: readonly ReconciliationOutcome[];
  reattached: readonly string[];
  orphaned: readonly string[];
  /** Worktrees whose allocation was interrupted and must never be reused. */
  quarantinedWorktrees: readonly string[];
}>;

function withinSessionRoot(sessionRoot: string, worktreeRoot: string): boolean {
  const relation = relative(resolve(sessionRoot), resolve(worktreeRoot));
  return relation.length > 0 && !relation.startsWith("..") && !resolve(worktreeRoot).endsWith(":");
}

/**
 * Gateway restart reconciliation (`runtime-state-machines.md`).
 *
 * Runs the seven specified steps in order: load the integrity-checked registry,
 * mark every non-terminal session `orphaned`, verify process identity WITHOUT
 * signalling, verify worktree containment and Git's own view of it, reattach
 * only exact matches, revoke every pre-restart lease generation, and leave
 * replay/audit metadata untouched.
 *
 * The service never synthesizes terminal output for the gap: a reattached
 * session resumes with its recorded sequence, and the client learns about the
 * gap through `historyTruncated` rather than through invented data.
 */
export class SessionReconciliationService {
  constructor(
    private readonly registry: SessionRegistryStorePort,
    private readonly processes: ProcessIdentityPort,
    private readonly git: GitRunnerPort,
    private readonly sessionRoot: string,
  ) {}

  private async gitReportsWorktree(record: PersistedSessionRecord): Promise<boolean> {
    try {
      const result = await this.git.run(record.worktreeRoot, ["rev-parse", "--show-toplevel"]);
      if (result.exitCode !== 0) {
        return false;
      }
      const reported = resolve(result.stdout.trim());
      return reported.length > 0 && reported === resolve(record.worktreeRoot);
    } catch {
      return false;
    }
  }

  async reconcile(): Promise<ReconciliationReport> {
    const current = await this.registry.read();

    // Steps 3–4 run before the write so the registry is replaced exactly once.
    const verdicts = new Map<string, ReconciliationVerdict>();
    for (const record of Object.values(current.sessions)) {
      if (isTerminalSessionState(record.state)) {
        verdicts.set(record.sessionId, "already_terminal");
        continue;
      }
      const observedProcess = record.process
        ? await this.processes.identify(record.process.pid)
        : undefined;
      verdicts.set(
        record.sessionId,
        decideReattachment(
          record,
          {
            // `exactOptionalPropertyTypes`: `ObservedSession.process` is optional, tad
            // eksplicitinis `undefined` čia yra tipo klaida. Sąlyginis spread'as sako tą patį
            // ką etalonas — „proceso nepavyko stebėti" reiškia lauko NEBUVIMĄ, ne tuščią reikšmę.
            ...(observedProcess === undefined ? {} : { process: observedProcess }),
            withinSessionRoot: withinSessionRoot(this.sessionRoot, record.worktreeRoot),
            gitReportsWorktree: await this.gitReportsWorktree(record),
          },
          current.gatewayInstanceId,
        ),
      );
    }

    return this.registry.update((snapshot) => {
      const sessions: Record<string, PersistedSessionRecord> = {};
      const outcomes: ReconciliationOutcome[] = [];
      for (const record of Object.values(snapshot.sessions)) {
        const verdict = verdicts.get(record.sessionId) ?? "orphaned";
        if (verdict === "already_terminal") {
          sessions[record.sessionId] = record;
          outcomes.push({
            sessionId: record.sessionId,
            verdict,
            state: record.state,
            leaseGeneration: record.lease.generation,
          });
          continue;
        }
        // Step 6 applies to every surviving session, including a reattached
        // one: a lease issued before the restart must never fence a mutation
        // afterwards.
        const lease = revokePersistedLease(record.lease);
        const reconciled: PersistedSessionRecord = {
          ...record,
          state: verdict === "reattached" ? "live" : "orphaned",
          lease,
        };
        sessions[record.sessionId] = reconciled;
        outcomes.push({
          sessionId: record.sessionId,
          verdict,
          state: reconciled.state,
          leaseGeneration: lease.generation,
        });
      }
      // A record still reading `allocating` means the gateway died between
      // creating the worktree and committing its success. The directory may or
      // may not exist and may or may not be complete, so it is quarantined —
      // never silently reused (`runtime-state-machines.md`).
      const worktrees: Record<string, WorktreeRecord> = {};
      const quarantinedWorktrees: string[] = [];
      for (const worktree of Object.values(snapshot.worktrees ?? {})) {
        if (worktree.state === "allocating") {
          worktrees[worktree.sessionId] = transitionWorktree(worktree, "quarantined", {
            quarantineReason: "allocation interrupted by gateway restart",
          });
          quarantinedWorktrees.push(worktree.sessionId);
        } else {
          worktrees[worktree.sessionId] = worktree;
        }
      }

      const report: ReconciliationReport = {
        revision: snapshot.revision + 1,
        outcomes,
        reattached: outcomes.filter((entry) => entry.verdict === "reattached").map((entry) => entry.sessionId),
        orphaned: outcomes.filter((entry) => entry.verdict === "orphaned").map((entry) => entry.sessionId),
        quarantinedWorktrees,
      };
      return {
        snapshot: { ...snapshot, revision: snapshot.revision + 1, sessions, worktrees },
        result: report,
      };
    });
  }
}
