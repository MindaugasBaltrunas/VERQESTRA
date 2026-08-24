import type { Provider } from "./state.js";

/**
 * Read-only host connections contract: Claude Code and Codex provider state and
 * the GitHub connection.
 *
 * The mobile client never probes a CLI and never talks to GitHub: the host
 * gateway projects its own richer view into the sanitized objects declared by
 * `api-contract.yaml` (`AgentProviderStatus`, `GitHubConnection`), and only
 * those fields exist here. What the host also knows and this contract
 * deliberately excludes — executable paths, project roots, connection ids,
 * reason codes, authorization expiry and every token — is not needed to read a
 * connection state, and each of them would widen what a lost device exposes.
 *
 * The port is read-only by construction: it declares no method that connects,
 * disconnects, authorizes or otherwise changes a provider's auth state, so no
 * mobile caller can reach one through this contract.
 */

/**
 * Providers the Connections space always accounts for, in presentation order.
 *
 * The screen reports a row per provider rather than a row per answer: a host
 * that omits Codex has not told the operator that Codex is fine, and a missing
 * row would read as exactly that.
 */
export const agentProviders: readonly Provider[] = Object.freeze([
  "claude-code",
  "codex",
] as const);

/** `AgentProviderStatus.status` of the contract. */
export type AgentConnectionStatus =
  | "unavailable"
  | "authentication_required"
  | "ready"
  | "busy"
  | "error";

export type AgentConnection = Readonly<{
  provider: Provider;
  status: AgentConnectionStatus;
  /** Normalized CLI version the host could read; `null` when it read none. */
  version: string | null;
}>;

/** `GitHubConnection.status` of the contract. */
export type GitHubConnectionStatus =
  | "disconnected"
  | "authorization_required"
  | "connected"
  | "error";

export type GitHubConnection = Readonly<{
  status: GitHubConnectionStatus;
  /** Account login the host reported; `null` when it reported none. */
  account: string | null;
  /**
   * Whether a host-side authorization is waiting to be completed.
   *
   * The contract also carries the short-lived authorization URL, and it stops at
   * the gateway on purpose: this space reads connection state and starts none,
   * so a link that begins an authorization flow has no receiver here.
   */
  authorizationPending: boolean;
}>;

export type HostConnectionsSnapshot = Readonly<{
  /**
   * `null` when the host serves no provider-status surface at all — deliberately
   * not an empty list, because "the host did not answer" and "the host reports
   * no provider" are different facts and the screen words them differently.
   */
  agents: readonly AgentConnection[] | null;
  /** `null` when the host serves no GitHub surface at all; never a fabricated state. */
  github: GitHubConnection | null;
}>;

export type ConnectionsReadFailureCode =
  | "unavailable"
  | "unauthorized"
  | "invalid_response"
  | "transport_failed";

/** Failure contract of {@link HostConnectionsReadPort}; adapters map their own errors onto it. */
export class ConnectionsReadError extends Error {
  constructor(readonly code: ConnectionsReadFailureCode, message: string) {
    super(message);
    this.name = "ConnectionsReadError";
  }
}

/**
 * Read-only by construction: one read method and no mutating one, so no mobile
 * caller can connect, disconnect or re-authorize a provider through it.
 */
export interface HostConnectionsReadPort {
  readConnections(): Promise<HostConnectionsSnapshot>;
}

/**
 * Defensive bound on an accepted snapshot: the host answers for a fixed, small
 * set of providers, and a host that does not — because it is old, buggy or
 * hostile — must not be able to grow the Connections list without bound.
 *
 * Only duplicates and unknown providers are removed; no status is rewritten, so
 * what the screen reports about a provider stays the host's own answer.
 */
export function clampAgentConnections(
  agents: readonly AgentConnection[],
): readonly AgentConnection[] {
  const seen = new Set<Provider>();
  return Object.freeze(agents.filter((agent) => {
    if (!agentProviders.includes(agent.provider) || seen.has(agent.provider)) return false;
    seen.add(agent.provider);
    return true;
  }));
}
