import {
  agentProviders,
  type AgentConnection,
  type AgentConnectionStatus,
  type ConnectionsReadFailureCode,
  type GitHubConnectionStatus,
} from "../../model/connections-read.js";
import type { ReadChannelLinkState } from "../../model/read-channel.js";
import type { AppState, Provider } from "../../model/state.js";
import type {
  AgentConnectionRow,
  ConnectionsAgentsViewState,
  ConnectionsChannelViewState,
  ConnectionsGitHubViewState,
  ConnectionsViewState,
} from "../../view/connections-view-state.js";

/**
 * Presentation for the read-only Connections space.
 *
 * Every decision the screen needs is taken here: which provider row exists, how
 * a missing answer is worded, and — most importantly — that "the host did not
 * say" is never softened into "everything is fine". The screen renders rows and
 * labels and derives nothing.
 *
 * The view state carries no connect, disconnect or authorize affordance,
 * because the space has none: it reads connection state and changes none.
 */

const linkLabels: Readonly<Record<ReadChannelLinkState, string>> = Object.freeze({
  connecting: "Connecting",
  connected: "Connected",
  degraded: "Reconnecting — last known state",
  offline: "Offline",
});

const failureMessages: Readonly<Record<ConnectionsReadFailureCode, string>> = Object.freeze({
  unavailable: "The host connection surface is not reachable.",
  unauthorized: "Device pairing is required.",
  invalid_response: "The connections response was rejected.",
  transport_failed: "The connections read failed.",
});

const providerLabels: Readonly<Record<Provider, string>> = Object.freeze({
  "claude-code": "Claude Code",
  "codex": "Codex",
});

const agentStatusLabels: Readonly<Record<AgentConnectionStatus, string>> = Object.freeze({
  unavailable: "Not installed on the host",
  authentication_required: "Sign-in required on the host",
  ready: "Ready",
  busy: "Busy — a session is running",
  error: "Host probe failed",
});

const gitHubStatusLabels: Readonly<Record<GitHubConnectionStatus, string>> = Object.freeze({
  disconnected: "Disconnected",
  authorization_required: "Authorization required on the host",
  connected: "Connected",
  error: "Host GitHub check failed",
});

/** What a row says when the host answered without mentioning that provider. */
const notReportedLabel = "Not reported by the host";

function isReading(state: AppState): boolean {
  return state.connectionsReadsInFlight > 0;
}

function hasSnapshot(state: AppState): boolean {
  return state.agentConnections !== null || state.githubConnection !== null;
}

function presentChannel(state: AppState): ConnectionsChannelViewState {
  // Nothing has ever been attempted or answered, so an offline badge would blame
  // the network for a channel that was simply never wired up. A read in flight or
  // a recorded failure both mean the channel is configured.
  const unconfigured = !hasSnapshot(state) &&
    state.connectionsError === null &&
    !isReading(state) &&
    state.connectionsLink !== "connecting";
  return Object.freeze({
    link: state.connectionsLink,
    label: unconfigured ? "Not configured" : linkLabels[state.connectionsLink],
    refreshing: isReading(state),
    // Staleness is "a state is on screen that the last read did not confirm".
    stale: hasSnapshot(state) && state.connectionsError !== null,
    errorMessage: state.connectionsError === null
      ? null
      : failureMessages[state.connectionsError],
    canRetry: !unconfigured && !isReading(state),
  });
}

function agentRow(
  provider: Provider,
  reported: AgentConnection | undefined,
): AgentConnectionRow {
  // A provider the host did not mention is unknown, not idle: reporting it as
  // anything else would invent an answer the operator could act on.
  if (reported === undefined) {
    return Object.freeze({
      provider,
      label: providerLabels[provider],
      status: null,
      statusLabel: notReportedLabel,
      ready: false,
      needsAttention: false,
      detailLabel: null,
    });
  }
  return Object.freeze({
    provider,
    label: providerLabels[provider],
    status: reported.status,
    statusLabel: agentStatusLabels[reported.status],
    ready: reported.status === "ready",
    // `busy` is a working provider, so it needs nothing from the operator;
    // the other two say the host is waiting for them.
    needsAttention: reported.status === "authentication_required" ||
      reported.status === "unavailable" ||
      reported.status === "error",
    detailLabel: reported.version === null ? null : `Version ${reported.version}`,
  });
}

function presentAgents(state: AppState): ConnectionsAgentsViewState {
  const reported = state.agentConnections;
  return Object.freeze({
    available: reported !== null,
    rows: Object.freeze(agentProviders.map((provider) => agentRow(
      provider,
      reported?.find((agent) => agent.provider === provider),
    ))),
    isEmpty: reported !== null && reported.length === 0,
    emptyLabel: "The host reported no agent provider.",
    unavailableLabel: "No provider state has been received yet.",
  });
}

function presentGitHub(state: AppState): ConnectionsGitHubViewState {
  const github = state.githubConnection;
  if (github === null) {
    return Object.freeze({
      available: false,
      status: null,
      statusLabel: notReportedLabel,
      connected: false,
      needsAttention: false,
      accountLabel: null,
      authorizationLabel: null,
      unavailableLabel: "No GitHub state has been received yet.",
    });
  }
  return Object.freeze({
    available: true,
    status: github.status,
    statusLabel: gitHubStatusLabels[github.status],
    connected: github.status === "connected",
    needsAttention: github.status !== "connected",
    accountLabel: github.account === null ? null : `Account ${github.account}`,
    authorizationLabel: github.authorizationPending
      ? "An authorization is waiting to be completed on the host."
      : null,
    unavailableLabel: "No GitHub state has been received yet.",
  });
}

export function presentConnections(state: AppState): ConnectionsViewState {
  const showLoadingPlaceholder = !hasSnapshot(state) &&
    (isReading(state) || state.connectionsLink === "connecting");
  return Object.freeze({
    title: "Connections — read-only",
    readOnly: true,
    connection: presentChannel(state),
    showLoadingPlaceholder,
    showUnavailablePlaceholder: !hasSnapshot(state) && !showLoadingPlaceholder,
    unavailableLabel: "No connection state has been received yet.",
    agents: presentAgents(state),
    github: presentGitHub(state),
  });
}
