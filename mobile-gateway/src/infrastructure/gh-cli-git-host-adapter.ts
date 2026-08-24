import type {
  GitHostConnection,
  GitHostIssue,
  GitHostPort,
  GitHostPullRequest,
  GitHostRepositoryBinding,
  GitHostRepositoryStatus,
  GitHostWriteContext,
} from "../application/ports/git-host-port.js";
import type { GitRunnerPort, GitRunResult } from "../application/ports/git-runner-port.js";
import {
  createGhCliRunner,
  GH_CLI_NOT_INSTALLED,
  GH_CLI_UNAVAILABLE,
  type GhCliResult,
  type GhCliRunner,
} from "./gh-cli-runner.js";
import {
  ACCOUNT_PATTERN,
  assertBranch,
  assertWriteArgument,
  boundedLimit,
  CONNECTION_ID,
  count,
  DETACHED_BRANCH,
  GITHUB_HOSTNAME,
  GitHostError,
  issueFrom,
  jsonArray,
  jsonValue,
  parseGitHubRemote,
  pullRequestFrom,
  PULL_REQUEST_URL_PATTERN,
  unavailable,
  unreadable,
} from "./gh-cli-git-host-parse.js";

/**
 * MVP {@link GitHostPort} adapter over the operator's own GitHub CLI session.
 *
 * The split between the two host tools is the load-bearing decision:
 *
 * - **Repository facts are local.** Binding and status come from `git` in the
 *   project root. They answer "which repository, which branch, how far apart"
 *   without a network call and without an authorized GitHub session, so the
 *   Projects screen keeps working while the CLI is signed out.
 * - **GitHub facts come from `gh`.** Connection state, issues and pull requests
 *   are named operations with a fixed argument vector each. There is no method
 *   that takes a command line, and `--repo` is always the binding this adapter
 *   validated itself — never a repository the CLI infers from a directory.
 * - **Nothing secret is produced.** A remote URL may legitimately carry a token
 *   (`https://user:token@github.com/owner/name.git`); it is parsed and dropped,
 *   and only `owner/name` survives. Raw CLI output is never forwarded: a parse
 *   failure becomes a code, not a fragment of what the tool printed.
 *
 * The state/PKCE authorization flow and, later, a GitHub App replace exactly one
 * method here ({@link GhCliGitHostAdapter.beginAuthorization}) plus its
 * connection lookup; nothing above this class changes with them.
 *
 * Parsinimas ir validacija gyvena `gh-cli-git-host-parse.ts` (žr. ten dėl skaidymo);
 * `GitHostError` re-eksportuojamas iš čia, nes etalone jis buvo šio failo eksportas.
 */

export { GitHostError } from "./gh-cli-git-host-parse.js";

export type GhCliGitHostAdapterDependencies = Readonly<{
  git: GitRunnerPort;
  /** Absolute host path of a registered project. */
  projectRoot: (projectId: string) => string;
  /** Injected by the tests; defaults to the real GitHub CLI runner. */
  run?: GhCliRunner;
  /** Host-configured GitHub CLI executable, e.g. an absolute path on Windows. */
  executable?: string;
}>;

export class GhCliGitHostAdapter implements GitHostPort {
  private readonly git: GitRunnerPort;
  private readonly projectRoot: (projectId: string) => string;
  private readonly run: GhCliRunner;

  constructor(dependencies: GhCliGitHostAdapterDependencies) {
    this.git = dependencies.git;
    this.projectRoot = dependencies.projectRoot;
    this.run = dependencies.run ?? createGhCliRunner(dependencies.executable);
  }

  /**
   * Host connection state, fail-closed: only a CLI that exits zero is reported
   * as `connected`. "Not installed", "cannot run" and "not authorized" are
   * distinct because each one has a different operator action.
   */
  async connection(): Promise<GitHostConnection> {
    const result = await this.run(["auth", "status", "--hostname", GITHUB_HOSTNAME]);
    if (result.exitCode === GH_CLI_NOT_INSTALLED) {
      return Object.freeze({
        connectionId: CONNECTION_ID,
        status: "disconnected" as const,
        reasonCode: "cli_not_installed",
      });
    }
    if (result.exitCode === GH_CLI_UNAVAILABLE) {
      return Object.freeze({
        connectionId: CONNECTION_ID,
        status: "error" as const,
        reasonCode: "cli_unavailable",
      });
    }
    if (result.exitCode !== 0) {
      return Object.freeze({
        connectionId: CONNECTION_ID,
        status: "authorization_required" as const,
        reasonCode: "not_authenticated",
      });
    }
    // Only the login is lifted out of the report; the masked token line and the
    // host paths around it are never read.
    const account = ACCOUNT_PATTERN.exec(`${result.stdout}\n${result.stderr}`)?.[1];
    return Object.freeze({
      connectionId: CONNECTION_ID,
      status: "connected" as const,
      ...(account === undefined ? {} : { account }),
    });
  }

  /**
   * There is no non-interactive authorization through the CLI: `gh auth login`
   * is a conversation, and this package may neither open a shell nor drive
   * another process' input. The honest answer is therefore the current state
   * plus a reason the operator can act on — authorize on the host — and never a
   * URL, because a URL this adapter cannot generate would be a fabrication.
   */
  async beginAuthorization(_input: { requestId: string }): Promise<GitHostConnection> {
    const current = await this.connection();
    if (current.status === "connected") return current;
    return Object.freeze({
      connectionId: CONNECTION_ID,
      status: "authorization_required" as const,
      reasonCode: "interactive_authorization_required",
    });
  }

  /**
   * Revocation would sign the whole host out of a session this gateway does not
   * own, and the CLI's logout is interactive when more than one account is
   * present. The host-held authorization is the operator's to revoke until the
   * gateway holds a credential of its own.
   */
  async revokeConnection(_input: { requestId: string }): Promise<void> {
    throw new GitHostError(
      "unsupported_operation",
      "GitHub authorization is revoked on the host, not from a device",
    );
  }

  /**
   * The binding is derived from the live `origin` remote rather than stored:
   * there is no state file to drift from the repository the operator actually
   * pushes to, and a project that is moved or unbound stops being bound at once.
   */
  async binding(input: { projectId: string }): Promise<GitHostRepositoryBinding | undefined> {
    const remote = await this.local(input.projectId, ["remote", "get-url", "origin"]);
    if (remote.exitCode !== 0) return undefined;
    const parsed = parseGitHubRemote(remote.stdout);
    if (!parsed) return undefined;
    return Object.freeze({
      projectId: input.projectId,
      owner: parsed.owner,
      repository: parsed.repository,
      defaultBranch: await this.defaultBranch(input.projectId),
    });
  }

  async repositoryStatus(input: { projectId: string }): Promise<GitHostRepositoryStatus> {
    const repository = await this.requireRepository(input.projectId);
    const head = await this.local(input.projectId, ["symbolic-ref", "--quiet", "--short", "HEAD"]);
    const branch = head.exitCode === 0 && head.stdout.trim().length > 0
      ? head.stdout.trim()
      : DETACHED_BRANCH;
    // `diff --quiet HEAD` is the port's own definition of dirty — "working tree
    // or index has uncommitted changes" — expressed as an exit code: 0 clean,
    // 1 dirty, anything else a real failure. It prints nothing, so a large
    // working set cannot overflow the runner's output buffer. Untracked files
    // are deliberately not counted as dirty; they are not changes to `HEAD`.
    const diff = await this.local(input.projectId, ["diff", "--quiet", "HEAD"]);
    if (diff.exitCode !== 0 && diff.exitCode !== 1) {
      throw new GitHostError("github_unavailable", "Repository status could not be read");
    }
    // No upstream is an ordinary state for a fresh branch, not a failure: the
    // divergence is simply unknown, and zero is what the contract can carry.
    const divergence = await this.local(
      input.projectId,
      ["rev-list", "--left-right", "--count", "@{upstream}...HEAD"],
    );
    const counts = divergence.exitCode === 0
      ? /^(\d{1,9})\s+(\d{1,9})/.exec(divergence.stdout.trim())
      : undefined;
    return Object.freeze({
      repository,
      branch,
      dirty: diff.exitCode === 1,
      ahead: count(counts?.[2]),
      behind: count(counts?.[1]),
    });
  }

  async listIssues(input: { projectId: string; limit: number }): Promise<readonly GitHostIssue[]> {
    const repository = await this.requireRepository(input.projectId);
    const result = await this.gh([
      "issue",
      "list",
      "--repo",
      repository,
      "--state",
      "all",
      "--limit",
      String(boundedLimit(input.limit)),
      "--json",
      "number,title,state,url,labels,updatedAt",
    ]);
    return Object.freeze(jsonArray(result).map(issueFrom));
  }

  async issue(input: { projectId: string; issueNumber: number }): Promise<GitHostIssue> {
    const repository = await this.requireRepository(input.projectId);
    if (!Number.isSafeInteger(input.issueNumber) || input.issueNumber < 1) {
      throw new GitHostError("github_unavailable", "GitHub issue number is invalid");
    }
    const result = await this.gh([
      "issue",
      "view",
      String(input.issueNumber),
      "--repo",
      repository,
      "--json",
      "number,title,state,url,labels,updatedAt",
    ]);
    return issueFrom(jsonValue(result));
  }

  async listPullRequests(
    input: { projectId: string; limit: number },
  ): Promise<readonly GitHostPullRequest[]> {
    const repository = await this.requireRepository(input.projectId);
    const result = await this.gh([
      "pr",
      "list",
      "--repo",
      repository,
      "--state",
      "all",
      "--limit",
      String(boundedLimit(input.limit)),
      "--json",
      "number,title,state,isDraft,url,headRefName,baseRefName,updatedAt",
    ]);
    return Object.freeze(jsonArray(result).map(pullRequestFrom));
  }

  async createPullRequest(
    write: GitHostWriteContext,
    input: {
      sessionId: string;
      title: string;
      draft: boolean;
      headBranch: string;
      baseBranch: string;
    },
  ): Promise<GitHostPullRequest> {
    // The binding the operator approved is re-checked against the live remote
    // BEFORE the GitHub CLI is touched: a repository that changed under the
    // approval must not receive the write at all, not even a rejected attempt.
    const repository = await this.requireRepository(write.projectId);
    if (repository !== write.expectedRepository) {
      throw new GitHostError(
        "binding_mismatch",
        "Approved repository no longer matches the project binding",
      );
    }
    const title = assertWriteArgument(input.title, "title");
    const baseBranch = assertBranch(input.baseBranch, "base branch");
    const headBranch = assertBranch(input.headBranch, "head branch");
    const result = await this.gh([
      "pr",
      "create",
      "--repo",
      repository,
      "--base",
      baseBranch,
      "--head",
      headBranch,
      "--title",
      title,
      ...(input.draft ? ["--draft"] : []),
      // The description is written from the reviewed session on the host, not
      // from anything a device sent, so the created request starts empty.
      "--body",
      "",
    ]);
    if (result.exitCode !== 0) throw unavailable();
    const url = result.stdout.trim().split(/\r?\n/).at(-1)?.trim() ?? "";
    const number = PULL_REQUEST_URL_PATTERN.exec(url)?.[1];
    if (number === undefined) throw unreadable();
    return Object.freeze({
      number: count(number),
      title,
      state: "open" as const,
      draft: input.draft,
      url,
      headBranch,
      baseBranch,
      updatedAt: new Date().toISOString(),
    });
  }

  /**
   * `owner/name` of the bound repository, or a not-bound failure.
   *
   * Only the remote is read: the default branch costs further processes and no
   * caller of this helper needs it, so a status read stays at four short-lived
   * `git` commands.
   */
  private async requireRepository(projectId: string): Promise<string> {
    const remote = await this.local(projectId, ["remote", "get-url", "origin"]);
    const parsed = remote.exitCode === 0 ? parseGitHubRemote(remote.stdout) : undefined;
    if (!parsed) {
      throw new GitHostError(
        "repository_not_bound",
        "Project has no GitHub origin remote",
      );
    }
    return `${parsed.owner}/${parsed.repository}`;
  }

  /**
   * `origin/HEAD` is the remote's own answer. When the local clone has no such
   * ref — a bare `git clone --depth` or a manually added remote — the two
   * conventional names are probed before falling back to the checked-out branch,
   * so a default branch is never invented.
   */
  private async defaultBranch(projectId: string): Promise<string> {
    const remoteHead = await this.local(
      projectId,
      ["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"],
    );
    if (remoteHead.exitCode === 0) {
      const name = remoteHead.stdout.trim().replace(/^origin\//, "");
      if (name.length > 0) return name;
    }
    for (const candidate of ["main", "master"]) {
      const reference = await this.local(
        projectId,
        ["rev-parse", "--verify", "--quiet", `refs/remotes/origin/${candidate}`],
      );
      if (reference.exitCode === 0) return candidate;
    }
    const head = await this.local(projectId, ["symbolic-ref", "--quiet", "--short", "HEAD"]);
    const branch = head.stdout.trim();
    return head.exitCode === 0 && branch.length > 0 ? branch : DETACHED_BRANCH;
  }

  private async local(projectId: string, args: readonly string[]): Promise<GitRunResult> {
    return this.git.run(this.projectRoot(projectId), args);
  }

  private async gh(args: readonly string[]): Promise<GhCliResult> {
    const result = await this.run(args);
    if (result.exitCode !== 0) throw unavailable();
    return result;
  }
}
