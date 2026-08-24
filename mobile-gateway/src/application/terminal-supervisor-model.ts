import type { DirectAgentTerminalHandle, DirectAgentTerminalPort } from "./ports/direct-agent-terminal-port.js";
import type { GitRunnerPort } from "./ports/git-runner-port.js";
import type { ProcessIdentityPort } from "./ports/process-identity-port.js";
import type { SessionRegistryStorePort } from "./ports/session-registry-store-port.js";
import type { ProcessIdentity } from "../domain/session-registry.js";
import type { WorktreeAllocation } from "./isolated-worktree-service.js";
import type { ProjectRegistry } from "./project-registry.js";
import type { TerminalOutputPipeline } from "./terminal-output-pipeline.js";
import type { TerminalControlLease } from "../domain/terminal-control-lease.js";
import type {
  TerminalReplayBuffer,
  TerminalReplayResult,
  TerminalSequencedEvent,
} from "../domain/terminal-replay-buffer.js";
import type { AgentProvider, TerminalSession } from "../domain/terminal-session.js";

/**
 * Terminalo supervizoriaus FORMOS ir grynosios taisyklės.
 *
 * SKAIDYMAS (VERQESTRA ≤500 eil. vartas; etalone visa tai buvo viename 911 eilučių faile —
 * didžiausiame visame pakete). Pjūvis eina per ribą, kurią etalonas įvardija pats:
 *
 *   „The last two are raised only by the local recovery methods below, which no remote route
 *    calls. The remote error mapping is therefore unchanged: a phone can never receive them."
 *
 * Iš to gimsta keturios dalys: formos (šis failas), BENDRA būsena su primityvais
 * (`terminal-supervisor-runtime`), vietinis atkūrimas (`terminal-supervisor-local`) ir viešas
 * nuotolinis paviršius (`terminal-supervisor`). Klasė, kurios metodai dalijasi privačia
 * būsena, kitaip nesiskaido — todėl būsena iškelta į atskirą vidinį objektą, o ne kopijuojama.
 */

export const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export interface WorktreeAllocationPort {
  allocate(input: {
    repositoryRoot: string;
    sessionId: string;
    baseCommit: string;
  }): Promise<WorktreeAllocation>;
}

export type TerminalSessionSnapshot = Readonly<{
  sessionId: string;
  projectId: string;
  provider: AgentProvider;
  workspaceMode: "isolated-worktree";
  branch: string;
  state: TerminalSession["state"];
  lease: Readonly<{
    leaseId: string;
    ownerDeviceId: string;
    generation: number;
    expiresAt: string;
  }>;
  nextSequence: number;
}>;

export type TerminalInputResult = Readonly<{
  inputId: string;
  status: "accepted" | "written" | "rejected" | "unknown";
}>;

export type InputLedgerRecord = {
  text: string;
  source: "keyboard" | "voice";
  result: TerminalInputResult;
};

export type RuntimeSession = {
  session: TerminalSession;
  lease: TerminalControlLease;
  worktreeRoot: string;
  handle?: DirectAgentTerminalHandle;
  replay: TerminalReplayBuffer;
  output: TerminalOutputPipeline;
  inputs: Map<string, InputLedgerRecord>;
  eventListeners: Set<(event: TerminalSequencedEvent) => void>;
  /**
   * Authoritative identity as reported by the host, recorded once at start.
   *
   * `| undefined`, ne `?`: laukas priskiriamas besąlygiškai iš neprivalomo
   * `ProcessIdentityPort` (`await core.processes?.identify(...)`), tad su
   * `exactOptionalPropertyTypes` opcionalus laukas tokio priskyrimo nepriimtų. Skaitytojams
   * niekas nepakito — ir `syncRegistry`, ir `forceCloseLocally` „nėra" ir „tuščia" jau
   * traktuoja vienodai.
   */
  processIdentity: ProcessIdentity | undefined;
};

export type TerminalOutputStream = Readonly<{
  snapshot: TerminalSessionSnapshot;
  replay: TerminalReplayResult;
  close(): Promise<void>;
}>;

export class TerminalSupervisorError extends Error {
  constructor(
    readonly code:
      | "host_busy"
      | "project_not_found"
      | "session_not_live"
      | "duplicate_request"
      | "stale_terminal_lease"
      | "terminal_start_failed"
      // The last two are raised only by the local recovery methods, which no
      // remote route calls. The remote error mapping is therefore unchanged: a
      // phone can never receive them, and adding them to the versioned remote
      // envelope would publish a local-only failure mode to every device.
      | "session_revision_mismatch"
      | "process_identity_unverified",
    message: string,
  ) {
    super(message);
    this.name = "TerminalSupervisorError";
  }
}

export function validateDimensions(cols: number, rows: number): void {
  if (
    !Number.isSafeInteger(cols) ||
    cols < 20 ||
    cols > 500 ||
    !Number.isSafeInteger(rows) ||
    rows < 5 ||
    rows > 300
  ) {
    throw new Error("Terminal dimensions are invalid");
  }
}

export function snapshotOf(runtime: RuntimeSession): TerminalSessionSnapshot {
  return Object.freeze({
    sessionId: runtime.session.sessionId,
    projectId: runtime.session.projectId,
    provider: runtime.session.provider,
    workspaceMode: "isolated-worktree",
    branch: runtime.session.branch,
    state: runtime.session.state,
    lease: Object.freeze({
      leaseId: runtime.lease.leaseId,
      ownerDeviceId: runtime.lease.ownerDeviceId,
      generation: runtime.lease.generation,
      expiresAt: runtime.lease.expiresAt,
    }),
    nextSequence: runtime.replay.snapshot().nextSequence,
  });
}

export type TerminalSupervisorDependencies = Readonly<{
  projects: ProjectRegistry;
  git: GitRunnerPort;
  worktrees: WorktreeAllocationPort;
  terminals: DirectAgentTerminalPort;
  clock?: () => Date;
  leaseTtlMs?: number;
  /**
   * Durable session registry. Supplying it together with {@link processes} and
   * {@link gatewayInstanceId} makes sessions survivable across a gateway
   * restart; omitting all three keeps the supervisor purely in-memory.
   */
  registry?: SessionRegistryStorePort;
  processes?: ProcessIdentityPort;
  gatewayInstanceId?: string;
}>;
