import { ConnectionsReadError } from "../model/connections-read.js";
import type {
  ConnectionsReadFailureCode,
  HostConnectionsReadPort,
} from "../model/connections-read.js";
import type { AppEvent } from "../model/reducer.js";

function failureCode(error: unknown): ConnectionsReadFailureCode {
  return error instanceof ConnectionsReadError ? error.code : "transport_failed";
}

/**
 * Drives the read-only host connections channel: it turns port results and port
 * failures into Model events and never rejects at its caller, because a failed
 * background read is a screen state (`degraded` / `offline`), not a command
 * failure.
 *
 * The concrete {@link HostConnectionsReadPort} implementation is supplied by the
 * composition root, so this controller carries no transport knowledge — and,
 * having no other method, no path through which a screen could start, complete
 * or revoke a host authorization.
 */
export class ConnectionsController {
  constructor(
    private readonly reads: HostConnectionsReadPort,
    private readonly dispatch: (event: AppEvent) => void,
  ) {}

  async refresh(): Promise<void> {
    this.dispatch({ type: "connections.read-started" });
    try {
      const snapshot = await this.reads.readConnections();
      this.dispatch({ type: "connections.snapshot", snapshot });
    } catch (error) {
      this.dispatch({ type: "connections.read-failed", failure: failureCode(error) });
    } finally {
      this.dispatch({ type: "connections.read-settled" });
    }
  }
}
