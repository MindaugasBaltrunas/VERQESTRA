import type {
  AgentConnectionStatus,
  GitHubConnectionStatus,
} from "../model/connections-read.js";
import type { ReadChannelLinkState } from "../model/read-channel.js";
import type { Provider } from "../model/state.js";

/**
 * View state of the read-only Connections space. Types only — the projection
 * that fills them is `controller/presentation/connections-presenter.ts`; see
 * `ag-loop-view-state.ts` for why the two are separate files here.
 */

/** Re-exported so a screen never has to name the Model to describe itself. */
export type {
  AgentConnectionStatus,
  GitHubConnectionStatus,
} from "../model/connections-read.js";

export type ConnectionsChannelViewState = Readonly<{
  link: ReadChannelLinkState;
  label: string;
  refreshing: boolean;
  /** The shown state is cached and no longer confirmed by the host. */
  stale: boolean;
  errorMessage: string | null;
  canRetry: boolean;
}>;

export type AgentConnectionRow = Readonly<{
  provider: Provider;
  label: string;
  /** `null` exactly when the host reported nothing about this provider. */
  status: AgentConnectionStatus | null;
  statusLabel: string;
  /** A session can be started against this provider right now. */
  ready: boolean;
  /** Operator action is needed on the host before this provider can be used. */
  needsAttention: boolean;
  /** Host CLI version, when one was reported; never a path. */
  detailLabel: string | null;
}>;

export type ConnectionsAgentsViewState = Readonly<{
  /** The host answered about providers at all. */
  available: boolean;
  /** Always one row per known provider, answered or not. */
  rows: readonly AgentConnectionRow[];
  /** The host answered, and named no provider at all. */
  isEmpty: boolean;
  emptyLabel: string;
  unavailableLabel: string;
}>;

export type ConnectionsGitHubViewState = Readonly<{
  available: boolean;
  status: GitHubConnectionStatus | null;
  statusLabel: string;
  connected: boolean;
  needsAttention: boolean;
  /** Account login the host reported; never a token, e-mail or path. */
  accountLabel: string | null;
  /**
   * Set when the host has an authorization waiting. It is a statement, not a
   * link: completing an authorization is host-side work, and this space offers
   * no way to start one.
   */
  authorizationLabel: string | null;
  unavailableLabel: string;
}>;

export type ConnectionsViewState = Readonly<{
  title: string;
  /** Structural, not a flag: this space exposes no connection mutation. */
  readOnly: true;
  connection: ConnectionsChannelViewState;
  showLoadingPlaceholder: boolean;
  /** Nothing was received and nothing is being read: offline or never configured. */
  showUnavailablePlaceholder: boolean;
  unavailableLabel: string;
  agents: ConnectionsAgentsViewState;
  github: ConnectionsGitHubViewState;
}>;
