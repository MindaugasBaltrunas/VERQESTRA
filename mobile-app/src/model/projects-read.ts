/**
 * Read-only project directory contract: the registered projects a device may
 * see, their repository binding and the working-tree state of one of them.
 *
 * The mobile client holds no path to a repository: the host registry decides
 * which projects exist and which of them this device may read, and it projects
 * them into the sanitized objects declared by `api-contract.yaml`
 * (`ProjectSummary`, `ProjectGitHubStatus`). `repository` is a logical name and
 * never an absolute host path, and the workspace root, the isolated worktree
 * path and every credential stay on the host.
 *
 * The port is read-only by construction: it declares no method that creates,
 * binds, checks out or otherwise changes a project, so no mobile caller can
 * reach one through this contract.
 */

/** AG Loop UI state of one project, as reported by the host registry. */
export type ProjectAgLoopUiState = "online" | "offline" | "not_configured";

/** `ProjectSummary` of the contract. */
export type ProjectSummary = Readonly<{
  projectId: string;
  name: string;
  /** Logical repository name; never an absolute host path. */
  repository: string;
  branch: string;
  agLoopUi: ProjectAgLoopUiState;
}>;

/**
 * `ProjectGitHubStatus` of the contract: the repository binding and how far the
 * checked-out branch has drifted from its remote. It carries no project id,
 * exactly as the contract declares it — the binding to a project is the request
 * that asked for it, and the Model keeps the two together itself.
 */
export type ProjectRepositoryStatus = Readonly<{
  repository: string;
  branch: string;
  dirty: boolean;
  ahead: number;
  behind: number;
}>;

export type ProjectsReadFailureCode =
  | "unavailable"
  | "unauthorized"
  | "not_found"
  | "repository_not_bound"
  | "invalid_response"
  | "transport_failed";

/** Failure contract of {@link ProjectsReadPort}; adapters map their own errors onto it. */
export class ProjectsReadError extends Error {
  constructor(readonly code: ProjectsReadFailureCode, message: string) {
    super(message);
    this.name = "ProjectsReadError";
  }
}

/**
 * Read-only by construction: two read methods and no mutating one, so no mobile
 * caller can create a project or change a repository binding through it.
 */
export interface ProjectsReadPort {
  readProjects(): Promise<readonly ProjectSummary[]>;
  readRepositoryStatus(input: Readonly<{ projectId: string }>): Promise<ProjectRepositoryStatus>;
}

/**
 * Defensive bound on an accepted project list, in the same spirit as the
 * terminal buffer limit: the host caps its own answer, and a host that does not
 * must still not be able to grow mobile memory without bound. The screen keeps
 * reporting how many projects the host named, so a capped list never reads as
 * the whole registry.
 */
export const maxListedProjects = 200;

/**
 * Applies {@link maxListedProjects} and drops projects the screen could not tell
 * apart. A duplicate id would give two rows the same identity — one of them
 * showing another project's branch under a selected row's header — so the first
 * answer for an id wins and the rest are removed.
 */
export function clampProjectList(
  projects: readonly ProjectSummary[],
): readonly ProjectSummary[] {
  return Object.freeze(distinctProjects(projects).slice(0, maxListedProjects));
}

/**
 * How many distinct projects the host named. This — not the raw answer length —
 * is what the screen reports as the size of the registry, so a duplicated entry
 * cannot make a fully shown list look partially hidden.
 */
export function countDistinctProjects(projects: readonly ProjectSummary[]): number {
  return distinctProjects(projects).length;
}

/** Deduplicated but uncapped: the cap is the caller's, the count must see past it. */
function distinctProjects(projects: readonly ProjectSummary[]): ProjectSummary[] {
  const seen = new Set<string>();
  const kept: ProjectSummary[] = [];
  for (const project of projects) {
    if (seen.has(project.projectId)) continue;
    seen.add(project.projectId);
    kept.push(project);
  }
  return kept;
}
