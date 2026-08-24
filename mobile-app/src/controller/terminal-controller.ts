import type {
  CredentialPort,
  GatewayPort,
  TerminalSession,
  TerminalWriteAction,
  TerminalWriteGatePort,
} from "../model/ports.js";
import type { AppEvent } from "../model/reducer.js";
import type { Provider, TerminalState } from "../model/state.js";

export interface TerminalStreamControlPort {
  start(input: Readonly<{
    url: string;
    accessToken: string;
    projectId: string;
    sessionId: string;
    lastAckSequence: number;
  }>): void;
  stop(): void;
}

/**
 * Longest input accepted for delivery. The composer refuses the same bound one
 * layer earlier through `terminalInputMaxLength`; the two names belong to
 * different layers and `src/tests/terminal-presentation.test.ts` keeps their
 * values identical.
 */
export const terminalInputCharacterLimit = 16_384;

export class TerminalApplicationError extends Error {
  constructor(
    readonly code:
      | "session_already_active"
      | "session_not_active"
      | "not_paired"
      | "invalid_input"
      | "unlock_required"
      | "operation_failed",
    message: string,
  ) {
    super(message);
    this.name = "TerminalApplicationError";
  }
}

function modelTerminalState(state: TerminalSession["state"]): TerminalState {
  switch (state) {
    case "creating":
    case "starting":
      return "creating";
    case "live":
    case "interrupting":
      return "live";
    case "closing":
      return "closing";
    case "ended":
      return "ended";
    case "failed":
      return "failed";
    case "orphaned":
      return "read-only";
  }
}

export class TerminalController {
  private activeSession: TerminalSession | undefined;
  private startInFlight = false;

  constructor(
    private readonly gateway: GatewayPort,
    private readonly credentials: CredentialPort,
    private readonly stream: TerminalStreamControlPort,
    private readonly streamUrl: string,
    private readonly dispatch: (event: AppEvent) => void,
    /**
     * Required, never optional: an omittable gate makes an ungated controller
     * constructible, which is precisely the fail-open this guard exists to stop.
     */
    private readonly writeGate: TerminalWriteGatePort,
  ) {}

  get session(): TerminalSession | undefined {
    return this.activeSession;
  }

  /**
   * Every host mutation passes through here. The gate's own error never escapes
   * the controller — the screen learns that confirmation is needed, not which
   * biometric subsystem refused it.
   */
  private async requireUnlock(action: TerminalWriteAction): Promise<void> {
    try {
      await this.writeGate.requireUnlock(action);
    } catch {
      this.dispatch({ type: "error", message: "Biometric confirmation is required." });
      throw new TerminalApplicationError(
        "unlock_required",
        "Terminal write requires biometric unlock",
      );
    }
  }

  async start(input: Readonly<{
    projectId: string;
    provider: Provider;
    cols: number;
    rows: number;
  }>): Promise<TerminalSession> {
    if (this.activeSession || this.startInFlight) {
      throw new TerminalApplicationError(
        "session_already_active",
        "A mobile terminal session is already active",
      );
    }
    // Claimed before the prompt, so a second start cannot slip in while the
    // operator is confirming the first.
    this.startInFlight = true;
    try {
      await this.requireUnlock("start");
    } catch (error) {
      this.startInFlight = false;
      throw error;
    }
    this.dispatch({ type: "terminal.state", state: "creating" });
    this.dispatch({ type: "error", message: null });
    try {
      const session = await this.gateway.createTerminalSession({
        ...input,
        workspaceMode: "isolated-worktree",
      });
      this.activeSession = session;
      const credential = await this.credentials.loadDeviceCredential();
      if (!credential) {
        throw new TerminalApplicationError("not_paired", "Device is not paired");
      }
      this.dispatch({
        type: "terminal.state",
        state: modelTerminalState(session.state),
      });
      this.stream.start({
        url: this.streamUrl,
        accessToken: credential.accessToken,
        projectId: session.projectId,
        sessionId: session.sessionId,
        lastAckSequence: 0,
      });
      return session;
    } catch (error) {
      // Only a session that reached the host can be `failed`: when creation
      // itself failed nothing exists to close, and reporting `failed` would
      // leave the screen with no way back to a startable state.
      this.dispatch({
        type: "terminal.state",
        state: this.activeSession ? "failed" : "none",
      });
      this.dispatch({
        type: "error",
        message: error instanceof TerminalApplicationError && error.code === "not_paired"
          ? "Device pairing is required."
          : "Terminal session could not be started.",
      });
      throw error;
    } finally {
      this.startInFlight = false;
    }
  }

  submitKeyboard(text: string): Promise<void> {
    return this.submit(text, "keyboard");
  }

  submitConfirmedVoice(text: string): Promise<void> {
    return this.submit(text, "voice");
  }

  private async submit(text: string, source: "keyboard" | "voice"): Promise<void> {
    const session = this.requireActive();
    if (text.length === 0 || text.length > terminalInputCharacterLimit) {
      // The composer refuses this input before it can be sent, so reaching here
      // means some other caller did; it still has to be visible to the operator
      // rather than only to whoever awaits the rejection.
      this.dispatch({ type: "error", message: "Terminal command was rejected as invalid." });
      throw new TerminalApplicationError("invalid_input", "Terminal input is invalid");
    }
    // After validation: input the host would refuse anyway must not cost the
    // operator a biometric prompt.
    await this.requireUnlock("input");
    try {
      await this.gateway.writeTerminalInput({
        projectId: session.projectId,
        sessionId: session.sessionId,
        lease: session.lease,
        text,
        source,
      });
    } catch (error) {
      this.dispatch({ type: "error", message: "Terminal command was not delivered." });
      throw error;
    }
  }

  async resize(cols: number, rows: number): Promise<void> {
    const session = this.requireActive();
    await this.requireUnlock("resize");
    await this.gateway.resizeTerminal({
      projectId: session.projectId,
      sessionId: session.sessionId,
      lease: session.lease,
      cols,
      rows,
    });
  }

  async interrupt(): Promise<void> {
    const session = this.requireActive();
    await this.requireUnlock("interrupt");
    try {
      await this.gateway.signalTerminal({
        projectId: session.projectId,
        sessionId: session.sessionId,
        lease: session.lease,
        signal: "interrupt",
      });
    } catch (error) {
      this.dispatch({ type: "error", message: "Interrupt was not delivered." });
      throw error;
    }
  }

  async terminate(): Promise<void> {
    const session = this.requireActive();
    await this.requireUnlock("terminate");
    const snapshot = await this.gateway.signalTerminal({
      projectId: session.projectId,
      sessionId: session.sessionId,
      lease: session.lease,
      signal: "terminate",
    });
    if (snapshot) this.updateSession(snapshot);
  }

  async close(): Promise<void> {
    const session = this.requireActive();
    await this.requireUnlock("close");
    this.dispatch({ type: "terminal.state", state: "closing" });
    let snapshot: TerminalSession;
    try {
      snapshot = await this.gateway.closeTerminal({
        projectId: session.projectId,
        sessionId: session.sessionId,
        lease: session.lease,
      });
    } catch (error) {
      // The host session survived the failed close, so the screen must go back
      // to showing it instead of staying stuck in `closing` with no way out.
      this.dispatch({ type: "terminal.state", state: modelTerminalState(session.state) });
      this.dispatch({ type: "error", message: "Terminal session could not be closed." });
      throw error;
    }
    this.updateSession(snapshot);
    this.stream.stop();
    this.activeSession = undefined;
    // The session is over, so its unlock window must not carry into the next
    // one: a new session starts with a fresh confirmation.
    this.writeGate.lock();
  }

  detachStream(): void {
    this.stream.stop();
    // Detaching is the operator stepping away from the terminal. Carrying an
    // open confirmation window across that gap would let whoever holds the
    // phone next write to the host without being asked.
    this.writeGate.lock();
  }

  async refreshSnapshot(): Promise<TerminalSession> {
    const session = this.requireActive();
    const snapshot = await this.gateway.getTerminalSession({
      projectId: session.projectId,
      sessionId: session.sessionId,
    });
    this.updateSession(snapshot);
    return snapshot;
  }

  private updateSession(session: TerminalSession): void {
    this.activeSession = session;
    this.dispatch({ type: "terminal.state", state: modelTerminalState(session.state) });
  }

  private requireActive(): TerminalSession {
    if (!this.activeSession) {
      throw new TerminalApplicationError(
        "session_not_active",
        "No mobile terminal session is active",
      );
    }
    return this.activeSession;
  }
}
