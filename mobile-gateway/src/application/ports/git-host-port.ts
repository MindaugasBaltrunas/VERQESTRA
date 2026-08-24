/**
 * Transport-neutral GitHub boundary.
 *
 * `design.md` §8 makes GitHub a port of its own — "GitHub yra atskiras
 * `GitHostPort`, o ne terminalo komanda" — so that repository work is a set of
 * structured use cases rather than text typed into an agent terminal. The MVP
 * adapter drives an already authenticated GitHub CLI session on the operator's
 * own machine; a personal-account authorization flow with a one-time `state`
 * and PKCE, and later a GitHub App for the team/server mode, sit behind this
 * same interface without changing it.
 *
 * Two properties are load-bearing and are asserted by the contract tests:
 *
 * - **No shell surface.** The port exposes named operations only. There is no
 *   method that takes a command line, so an untrusted phrase — voice
 *   transcription included — has nowhere to become one.
 * - **No secret ever leaves the host.** Every type below carries public
 *   metadata: account name, repository name, branch, counts, issue and pull
 *   request identity. Authorization material stays in the host secret store, and
 *   the only URL a client sees is a short-lived, host-generated authorization
 *   link.
 *
 * The HTTP layer projects a subset of these types onto the sanitized DTOs of
 * `api-contract.yaml`; this port is the richer, transport-independent view.
 */

export type GitHostConnectionStatus =
  | "disconnected"
  | "authorization_required"
  | "connected"
  | "error";

export type GitHostConnection = Readonly<{
  /** Stable handle for the host-side connection. Not usable as authorization. */
  connectionId: string;
  status: GitHostConnectionStatus;
  /** Public account or installation login, when connected. */
  account?: string;
  /** Short-lived host-generated authorization URL. Never a bearer value. */
  authorizationUrl?: string;
  /** ISO-8601 expiry of {@link GitHostConnection.authorizationUrl}. */
  authorizationExpiresAt?: string;
  /** Machine-readable cause when `status` is `error`. */
  reasonCode?: string;
}>;

/**
 * The repository a project is bound to. `spec.md` requires the binding to be
 * verified before every write, which is why {@link GitHostWriteContext} carries
 * the repository the operator saw rather than letting the adapter re-resolve it.
 */
export type GitHostRepositoryBinding = Readonly<{
  projectId: string;
  owner: string;
  repository: string;
  defaultBranch: string;
}>;

export type GitHostRepositoryStatus = Readonly<{
  /** `owner/name` of the bound repository. */
  repository: string;
  branch: string;
  /** Working tree or index has uncommitted changes. */
  dirty: boolean;
  /** Commits ahead of the tracked remote branch. */
  ahead: number;
  /** Commits behind the tracked remote branch. */
  behind: number;
}>;

export type GitHostIssue = Readonly<{
  number: number;
  title: string;
  state: "open" | "closed";
  url: string;
  labels: readonly string[];
  updatedAt: string;
}>;

export type GitHostPullRequest = Readonly<{
  number: number;
  title: string;
  state: "open" | "closed" | "merged";
  draft: boolean;
  url: string;
  headBranch: string;
  baseBranch: string;
  updatedAt: string;
}>;

/**
 * Everything a write needs beyond its own arguments.
 *
 * Making it a required first parameter of every mutating method is how
 * "verify the binding, the scope and an explicit approval before each write"
 * becomes a type-level obligation instead of a convention an adapter can skip.
 */
export type GitHostWriteContext = Readonly<{
  projectId: string;
  /** `owner/name` the operator saw when approving; re-checked against the live binding. */
  expectedRepository: string;
  /** `<deviceId>:<counter>`, so a retried write cannot create a second pull request. */
  idempotencyKey: string;
  /** `commandId` of the accepted command intent that authorised this write. */
  approvedCommandId: string;
}>;

/**
 * Reads are project- or host-scoped; writes additionally require a
 * {@link GitHostWriteContext}. Disconnecting revokes the host-held
 * authorization and never touches the local repository.
 */
export interface GitHostPort {
  connection(): Promise<GitHostConnection>;
  /** Starts host-side authorization and returns the state the client may see. */
  beginAuthorization(input: { requestId: string }): Promise<GitHostConnection>;
  /** Revokes the host-held authorization; the local repository is retained. */
  revokeConnection(input: { requestId: string }): Promise<void>;
  binding(input: { projectId: string }): Promise<GitHostRepositoryBinding | undefined>;
  repositoryStatus(input: { projectId: string }): Promise<GitHostRepositoryStatus>;
  listIssues(input: { projectId: string; limit: number }): Promise<readonly GitHostIssue[]>;
  issue(input: { projectId: string; issueNumber: number }): Promise<GitHostIssue>;
  listPullRequests(input: { projectId: string; limit: number }): Promise<readonly GitHostPullRequest[]>;
  createPullRequest(
    write: GitHostWriteContext,
    input: {
      sessionId: string;
      title: string;
      draft: boolean;
      headBranch: string;
      baseBranch: string;
    },
  ): Promise<GitHostPullRequest>;
}
