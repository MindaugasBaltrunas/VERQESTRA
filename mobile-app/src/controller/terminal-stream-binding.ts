import type { TerminalStreamClientObserver } from "../adapters/network/terminal-stream-client.js";
import type { AppEvent } from "../model/reducer.js";

export type AppEventDispatcher = (event: AppEvent) => void;

const errorMessages = Object.freeze({
  invalid_configuration: "Secure terminal connection is not configured.",
  protocol_error: "Terminal stream protocol error. Reconnecting…",
  transport_error: "Terminal connection was interrupted. Reconnecting…",
});

export function createTerminalStreamObserver(
  dispatch: AppEventDispatcher,
): TerminalStreamClientObserver {
  const observer: TerminalStreamClientObserver = {
    onConnectionChanged(state) {
      dispatch({ type: "connection.changed", state });
      if (state === "live") dispatch({ type: "error", message: null });
    },
    onSnapshot(snapshot) {
      dispatch({ type: "terminal.state", state: snapshot.state });
      if (snapshot.historyTruncated) {
        dispatch({ type: "terminal.history-truncated" });
      }
    },
    onOutput(data) {
      dispatch({ type: "terminal.output-chunk", data });
    },
    onHistoryTruncated() {
      dispatch({ type: "terminal.history-truncated" });
    },
    onError(code) {
      dispatch({ type: "error", message: errorMessages[code] });
    },
  };
  return Object.freeze(observer);
}
