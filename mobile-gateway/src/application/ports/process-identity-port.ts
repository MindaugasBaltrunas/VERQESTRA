import type { ProcessIdentity } from "../../domain/session-registry.js";

/**
 * Read-only view of the host process table.
 *
 * Reconciliation must "verify process identity without sending signals"
 * (`runtime-state-machines.md`), so this port deliberately exposes no signal,
 * kill or attach operation — probing liveness with signal 0 would still be a
 * signal, and an implementation that could kill would put restart recovery one
 * bug away from terminating an unrelated process that inherited the PID.
 */
export interface ProcessIdentityPort {
  /** Current identity for `pid`, or `undefined` when no such process exists. */
  identify(pid: number): Promise<ProcessIdentity | undefined>;
}
