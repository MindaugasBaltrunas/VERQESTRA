import type { DirectAgentTerminalPort } from "./ports/direct-agent-terminal-port.js";
import type { GitRunnerPort } from "./ports/git-runner-port.js";
import type { ProcessIdentityPort } from "./ports/process-identity-port.js";
import type { SessionRegistryStorePort } from "./ports/session-registry-store-port.js";
import type { PersistedSessionRecord } from "../domain/session-registry.js";
import type { ProjectRegistry } from "./project-registry.js";
import {
  assertTerminalLease,
  revokeTerminalLease,
  StaleTerminalLeaseError,
} from "../domain/terminal-control-lease.js";
import type { TerminalLifecyclePayload, TerminalSequencedEvent } from "../domain/terminal-replay-buffer.js";
import { transitionTerminalSession } from "../domain/terminal-session.js";
import {
  TerminalSupervisorError,
  type RuntimeSession,
  type TerminalSupervisorDependencies,
  type WorktreeAllocationPort,
} from "./terminal-supervisor-model.js";

/**
 * Bendra terminalo supervizoriaus BŪSENA ir primityvai, kuriais naudojasi ir nuotolinis
 * paviršius, ir vietinis atkūrimas.
 *
 * Kodėl atskiras objektas, o ne privatūs klasės laukai (kaip etalone): 911 eilučių klasė
 * neįtelpa į ≤500 eilučių vartą, o jos metodai visi iki vieno dalijasi ta pačia būsena —
 * `sessions`, `activeSessionId`, operacijų eilė. Nukopijuoti būseną į dvi klases reikštų dvi
 * tiesos versijas apie tą patį gyvą PTY; todėl ji yra VIENA, o dalys ją gauna.
 *
 * NUKRYPIMAS, kurį reikia žinoti: etalone šie laukai ir metodai buvo `private`. Čia jie
 * matomi paketo viduje, nes kitaip vietinio atkūrimo modulis jų nepasiektų. Kaina reali, bet
 * ribota: šis modulis nėra eksportuojamas iš paketo barelio, o vieša klasė
 * (`terminal-supervisor.ts`) savo `runtime` laiko privačiai — tad iš paketo IŠORĖS paviršius
 * nepakito nė vienu nariu. Alternatyva — dubliuoti būseną arba per paveldėjimą sujungti dvi
 * klases — būtų blogesnė už matomumo susiaurinimą vienam moduliui.
 */
export class TerminalSupervisorRuntime {
  readonly sessions = new Map<string, RuntimeSession>();
  readonly createRequests = new Map<string, string>();
  activeSessionId: string | undefined;
  private operationQueue: Promise<void> = Promise.resolve();

  readonly projects: ProjectRegistry;
  readonly git: GitRunnerPort;
  readonly worktrees: WorktreeAllocationPort;
  readonly terminals: DirectAgentTerminalPort;
  readonly clock: () => Date;
  readonly leaseTtlMs: number;
  readonly registry: SessionRegistryStorePort | undefined;
  readonly processes: ProcessIdentityPort | undefined;
  readonly gatewayInstanceId: string | undefined;

  constructor(dependencies: TerminalSupervisorDependencies) {
    this.projects = dependencies.projects;
    this.git = dependencies.git;
    this.worktrees = dependencies.worktrees;
    this.terminals = dependencies.terminals;
    this.clock = dependencies.clock ?? (() => new Date());
    this.leaseTtlMs = dependencies.leaseTtlMs ?? 5 * 60 * 1000;
    this.registry = dependencies.registry;
    this.processes = dependencies.processes;
    this.gatewayInstanceId = dependencies.gatewayInstanceId;
    if (!Number.isSafeInteger(this.leaseTtlMs) || this.leaseTtlMs <= 0) {
      throw new Error("Terminal lease TTL is invalid");
    }
    if ((this.registry || this.processes || this.gatewayInstanceId)
      && !(this.registry && this.processes && this.gatewayInstanceId)) {
      // A half-configured registry would persist records that reconciliation can
      // never reattach, which is worse than staying in memory.
      throw new Error("Session persistence needs registry, processes and gatewayInstanceId together");
    }
  }

  /**
   * Upserts the durable record for a session after any state or lease change.
   *
   * Persistence failures do not fail the terminal operation that triggered them:
   * the process is already running and the in-memory supervisor remains
   * authoritative for this gateway lifetime. The cost of a lost write is that
   * reconciliation treats the session as orphaned after a restart, which is the
   * safe direction.
   */
  async syncRegistry(runtime: RuntimeSession): Promise<void> {
    if (!this.registry || !this.gatewayInstanceId) return;
    const record: PersistedSessionRecord = {
      sessionId: runtime.session.sessionId,
      projectId: runtime.session.projectId,
      provider: runtime.session.provider,
      worktreeRoot: runtime.worktreeRoot,
      branch: runtime.session.branch,
      baseCommit: runtime.session.baseCommit,
      state: runtime.session.state,
      lease: {
        leaseId: runtime.lease.leaseId,
        ownerDeviceId: runtime.lease.ownerDeviceId,
        generation: runtime.lease.generation,
        expiresAt: runtime.lease.expiresAt,
        // `revokeTerminalLease` expires the lease immediately, so expiry is the
        // only durable signal the domain type carries.
        status: Date.parse(runtime.lease.expiresAt) <= this.clock().getTime() ? "expired" : "active",
      },
      ...(runtime.processIdentity ? { process: runtime.processIdentity } : {}),
      gatewayInstanceId: this.gatewayInstanceId,
    };
    try {
      await this.registry.update((snapshot) => ({
        snapshot: {
          ...snapshot,
          revision: snapshot.revision + 1,
          sessions: { ...snapshot.sessions, [record.sessionId]: record },
        },
        result: undefined,
      }));
    } catch {
      // See doc comment: a lost record degrades to `orphaned`, never to a
      // wrongly reattached session.
    }
  }

  async exclusively<T>(operation: () => Promise<T>): Promise<T> {
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

  requireRuntime(projectId: string, sessionId: string): RuntimeSession {
    const runtime = this.sessions.get(sessionId);
    if (!runtime || runtime.session.projectId !== projectId) {
      throw new TerminalSupervisorError("session_not_live", "Terminal session was not found");
    }
    return runtime;
  }

  assertFence(
    runtime: RuntimeSession,
    input: {
      ownerDeviceId: string;
      leaseId: string;
      leaseGeneration: number;
    },
  ): void {
    try {
      assertTerminalLease(runtime.lease, {
        leaseId: input.leaseId,
        generation: input.leaseGeneration,
        ownerDeviceId: input.ownerDeviceId,
        sessionId: runtime.session.sessionId,
        now: this.clock(),
      });
    } catch (error) {
      if (error instanceof StaleTerminalLeaseError) {
        throw new TerminalSupervisorError("stale_terminal_lease", "Terminal lease is stale");
      }
      throw error;
    }
  }

  publishEvents(runtime: RuntimeSession, events: readonly TerminalSequencedEvent[]): void {
    for (const event of events) {
      for (const listener of runtime.eventListeners) {
        try {
          listener(event);
        } catch {
          // A transport listener cannot interrupt terminal output retention.
        }
      }
    }
  }

  /** Sequences one lifecycle event into the replay log and fans it out. */
  emit(runtime: RuntimeSession, payload: TerminalLifecyclePayload): void {
    this.publishEvents(runtime, [runtime.replay.appendLifecycle(payload, this.clock())]);
  }

  /** Publishes the current lease as a `server.lease` event after any change. */
  emitLease(runtime: RuntimeSession): void {
    this.emit(runtime, {
      type: "server.lease",
      ownerDeviceId: runtime.lease.ownerDeviceId,
      generation: runtime.lease.generation,
      expiresAt: runtime.lease.expiresAt,
    });
  }

  /** Publishes a session state transition as a `server.session` event. */
  emitSessionState(runtime: RuntimeSession, reason?: string): void {
    this.emit(runtime, {
      type: "server.session",
      state: runtime.session.state,
      ...(reason ? { reason } : {}),
    });
  }

  handleExit(sessionId: string): void {
    void this.exclusively(async () => {
      const runtime = this.sessions.get(sessionId);
      if (!runtime) return;
      let processExitConfirmed = false;
      if (runtime.session.state === "closing") {
        runtime.session = transitionTerminalSession(runtime.session, "ended");
        processExitConfirmed = true;
      } else if (
        runtime.session.state === "creating" ||
        runtime.session.state === "starting" ||
        runtime.session.state === "live" ||
        runtime.session.state === "interrupting"
      ) {
        runtime.session = transitionTerminalSession(runtime.session, "failed");
        processExitConfirmed = true;
      } else if (runtime.session.state === "orphaned") {
        runtime.session = transitionTerminalSession(runtime.session, "ended");
        processExitConfirmed = true;
      }
      if (!processExitConfirmed) return;
      this.publishEvents(runtime, runtime.output.flush(this.clock()));
      this.emitSessionState(runtime, "provider process exited");
      runtime.lease = revokeTerminalLease(runtime.lease, this.clock());
      this.emitLease(runtime);
      if (this.activeSessionId === sessionId) this.activeSessionId = undefined;
      await this.syncRegistry(runtime);
    });
  }

  handleOutput(sessionId: string, data: string): void {
    void this.exclusively(async () => {
      const runtime = this.sessions.get(sessionId);
      if (!runtime) return;
      this.publishEvents(runtime, runtime.output.push(data, this.clock()));
    });
  }
}
