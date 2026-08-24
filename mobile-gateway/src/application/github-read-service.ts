import type {
  GitHostConnection,
  GitHostPort,
  GitHostRepositoryStatus,
} from "./ports/git-host-port.js";
import type { ProjectMembershipPort } from "./ports/project-membership-port.js";
import type { ProjectRegistry } from "./project-registry.js";

/**
 * The GitHub facts a mobile client is allowed to see.
 *
 * `GitHostPort` is the richer host view; `api-contract.yaml` declares two
 * sanitized objects with `additionalProperties: false`. This service is the only
 * place that crosses between them, which is why the projection is written field
 * by field instead of spreading: a field added to the port later cannot leak
 * into a response by accident, and `connectionId`, `reasonCode` and the
 * authorization expiry stay on the host because the contract has no room for
 * them.
 *
 * Reading GitHub state costs host processes, so a poll from a reconnecting
 * client must not become a process per request. The host-wide connection is
 * cached briefly and shared between concurrent callers; repository status is
 * not, because `dirty`, `ahead` and `behind` change with every local commit and
 * a stale answer there is worse than a slow one.
 */

/** `GitHubConnection` of the contract. */
export type GitHubConnectionDto = Readonly<{
  status: "disconnected" | "authorization_required" | "connected" | "error";
  account?: string;
  authorizationUrl?: string;
}>;

/** `ProjectGitHubStatus` of the contract. */
export type ProjectGitHubStatusDto = Readonly<{
  repository: string;
  branch: string;
  dirty: boolean;
  ahead: number;
  behind: number;
}>;

export class GitHubReadError extends Error {
  constructor(
    readonly code: "project_not_found" | "repository_not_bound" | "github_unavailable",
    message: string,
  ) {
    super(message);
    this.name = "GitHubReadError";
  }
}

export type GitHubReadServiceDependencies = Readonly<{
  registry: ProjectRegistry;
  membership: ProjectMembershipPort;
  gitHost: GitHostPort;
  clock?: () => Date;
  /** How long a host connection answer stays reusable. */
  cacheTtlMs?: number;
}>;

const DEFAULT_CACHE_TTL_MS = 15_000;

/**
 * A failed lookup is cached far more briefly than a successful one: a transient
 * host fault must not stick to the Connections screen for the full window, while
 * a persistent one still must not start a process per request.
 */
const FAILED_LOOKUP_CACHE_TTL_MS = 3_000;

type ConnectionCacheEntry = Readonly<{ dto: GitHubConnectionDto; expiresAtMs: number }>;

/**
 * The port declares no error type and application code may not import an
 * adapter, so a host failure is recognised by the shape it carries rather than
 * by its class. Anything without a code is simply an unknown failure.
 */
function portErrorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" ? code : undefined;
}

/** Optional fields are omitted rather than set to `undefined`, so the object equals its JSON form. */
function connectionDto(connection: GitHostConnection): GitHubConnectionDto {
  return Object.freeze({
    status: connection.status,
    ...(connection.account === undefined ? {} : { account: connection.account }),
    ...(connection.authorizationUrl === undefined
      ? {}
      : { authorizationUrl: connection.authorizationUrl }),
  });
}

export class GitHubReadService {
  private readonly registry: ProjectRegistry;
  private readonly membership: ProjectMembershipPort;
  private readonly gitHost: GitHostPort;
  private readonly clock: () => Date;
  private readonly cacheTtlMs: number;
  // `| undefined`, ne `?`: abu laukai nunulinami eksplicitiškai, o su
  // `exactOptionalPropertyTypes` opcionalus laukas tokio priskyrimo nepriima.
  private connectionCache: ConnectionCacheEntry | undefined;
  private connectionInFlight: Promise<GitHubConnectionDto> | undefined;
  /** Incremented by {@link GitHubReadService.invalidateConnection}. */
  private connectionEpoch = 0;

  constructor(dependencies: GitHubReadServiceDependencies) {
    this.registry = dependencies.registry;
    this.membership = dependencies.membership;
    this.gitHost = dependencies.gitHost;
    this.clock = dependencies.clock ?? (() => new Date());
    this.cacheTtlMs = dependencies.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS;
    if (!Number.isSafeInteger(this.cacheTtlMs) || this.cacheTtlMs < 0) {
      throw new Error("GitHub connection cache TTL is invalid");
    }
  }

  /**
   * Host connection state. This read has no error path: "no CLI", "not
   * authorized" and "the host failed" are all states the operator can act on,
   * so they are reported as a status rather than as a failed request.
   */
  async connection(): Promise<GitHubConnectionDto> {
    const cached = this.cachedConnection();
    if (cached) return cached;
    // Concurrent readers share one lookup; otherwise every reconnecting client
    // would start its own CLI process for the same host-wide answer.
    const pending = this.connectionInFlight;
    if (pending) return pending;
    const lookup: Promise<GitHubConnectionDto> = this.readConnection().finally(() => {
      if (this.connectionInFlight === lookup) this.connectionInFlight = undefined;
    });
    this.connectionInFlight = lookup;
    return lookup;
  }

  /**
   * Drops the cached connection answer.
   *
   * A mutation that changed the host connection makes the cache a lie for up to
   * the full TTL, and the Connections screen is exactly where that lie is most
   * visible. Bumping the epoch — rather than only clearing the entry — is what
   * stops a lookup that was already in flight from writing its pre-mutation
   * answer back into the cache after the invalidation.
   */
  invalidateConnection(): void {
    this.connectionCache = undefined;
    this.connectionEpoch += 1;
  }

  /** Bound repository and working-tree divergence of one visible project. */
  async projectStatus(principalId: string, projectId: string): Promise<ProjectGitHubStatusDto> {
    await this.requireVisible(principalId, projectId);
    let status: GitHostRepositoryStatus;
    try {
      status = await this.gitHost.repositoryStatus({ projectId });
    } catch (error) {
      if (portErrorCode(error) === "repository_not_bound") {
        throw new GitHubReadError(
          "repository_not_bound",
          "Project is not bound to a GitHub repository",
        );
      }
      // The reason stays on the host: a Git or CLI failure message can name a
      // path, an account or, in a remote URL, a credential.
      throw new GitHubReadError("github_unavailable", "GitHub repository status is unavailable");
    }
    return Object.freeze({
      repository: status.repository,
      branch: status.branch,
      dirty: status.dirty,
      ahead: status.ahead,
      behind: status.behind,
    });
  }

  /** An invisible project and an unknown project are the same answer, by design. */
  private async requireVisible(principalId: string, projectId: string): Promise<void> {
    if (!await this.membership.canReadProject(principalId, projectId)) {
      throw new GitHubReadError("project_not_found", "Project is not visible");
    }
    try {
      this.registry.require(projectId);
    } catch {
      throw new GitHubReadError("project_not_found", "Project is not visible");
    }
  }

  private cachedConnection(): GitHubConnectionDto | undefined {
    const entry = this.connectionCache;
    if (!entry) return undefined;
    if (entry.expiresAtMs <= this.clock().getTime()) {
      this.connectionCache = undefined;
      return undefined;
    }
    return entry.dto;
  }

  private async readConnection(): Promise<GitHubConnectionDto> {
    const epoch = this.connectionEpoch;
    let dto: GitHubConnectionDto;
    try {
      dto = connectionDto(await this.gitHost.connection());
    } catch {
      // A thrown port is itself a connection state; the client sees `error` and
      // never the host's own words about it.
      dto = Object.freeze({ status: "error" as const });
    }
    const ttlMs = dto.status === "error"
      ? Math.min(FAILED_LOOKUP_CACHE_TTL_MS, this.cacheTtlMs)
      : this.cacheTtlMs;
    // The caller of this lookup still gets its answer; only the CACHE is
    // withheld, because an answer read before a mutation must not be served to
    // anyone afterwards.
    if (epoch === this.connectionEpoch) {
      this.connectionCache = { dto, expiresAtMs: this.clock().getTime() + ttlMs };
    }
    return dto;
  }
}
