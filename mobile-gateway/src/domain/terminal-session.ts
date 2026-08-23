export type AgentProvider = "claude-code" | "codex";
export type TerminalSessionState =
  | "creating"
  | "starting"
  | "live"
  | "interrupting"
  | "closing"
  | "ended"
  | "failed"
  | "orphaned";

export type TerminalSession = Readonly<{
  sessionId: string;
  projectId: string;
  provider: AgentProvider;
  workspaceMode: "isolated-worktree";
  branch: string;
  baseCommit: string;
  state: TerminalSessionState;
  revision: number;
}>;

const allowedTransitions: Readonly<Record<TerminalSessionState, readonly TerminalSessionState[]>> = {
  creating: ["starting", "failed", "orphaned"],
  starting: ["live", "failed", "orphaned"],
  live: ["interrupting", "closing", "failed", "orphaned"],
  interrupting: ["live", "closing", "failed", "orphaned"],
  closing: ["ended", "failed", "orphaned"],
  ended: [],
  failed: [],
  orphaned: ["live", "ended"],
};

export function transitionTerminalSession(
  session: TerminalSession,
  next: TerminalSessionState,
): TerminalSession {
  if (!allowedTransitions[session.state].includes(next)) {
    throw new Error(`Invalid terminal session transition: ${session.state} -> ${next}`);
  }
  return Object.freeze({ ...session, state: next, revision: session.revision + 1 });
}
