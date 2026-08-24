import type { AgentProvider } from "../../domain/terminal-session.js";

export type DirectAgentTerminalHandle = {
  /**
   * Operating-system process id of the spawned agent.
   *
   * Restart reconciliation needs it to ask {@link ProcessIdentityPort} for the
   * authoritative identity; the supervisor deliberately records what that port
   * reports rather than its own spawn timestamp, so the value written at start
   * and the value compared after a restart come from one source and a recycled
   * PID is detectable.
   */
  readonly pid: number;
  /** Host-resolved absolute executable actually launched. */
  readonly executable: string;
  write(text: string): Promise<void>;
  resize(cols: number, rows: number): Promise<void>;
  interrupt(): Promise<void>;
  terminate(): Promise<void>;
  close(): Promise<void>;
};

export interface DirectAgentTerminalPort {
  start(input: {
    sessionId: string;
    provider: AgentProvider;
    cwd: string;
    cols: number;
    rows: number;
    onOutput: (data: string) => void;
    onExit: (exitCode: number | null) => void;
  }): Promise<DirectAgentTerminalHandle>;
}
