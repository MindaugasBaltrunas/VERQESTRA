import { access, realpath } from "node:fs/promises";
import path from "node:path";

export type RegisteredProject = Readonly<{
  projectId: string;
  name: string;
  repository: string;
  branch: string;
  rootId: string;
  projectRoot: string;
}>;

export type ProjectSummary = Readonly<{
  projectId: string;
  name: string;
  repository: string;
  branch: string;
}>;

function isInside(parent: string, candidate: string): boolean {
  const relative = path.relative(parent, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

export class ProjectRegistry {
  readonly #allowedRoots: ReadonlyMap<string, string>;
  readonly #projects = new Map<string, RegisteredProject>();

  private constructor(allowedRoots: ReadonlyMap<string, string>) {
    this.#allowedRoots = allowedRoots;
  }

  static async create(roots: Readonly<Record<string, string>>): Promise<ProjectRegistry> {
    const canonical = new Map<string, string>();
    for (const [rootId, configuredPath] of Object.entries(roots)) {
      if (!rootId || !path.isAbsolute(configuredPath)) {
        throw new Error("Workspace roots require a stable id and absolute host path");
      }
      canonical.set(rootId, await realpath(configuredPath));
    }
    if (canonical.size === 0) throw new Error("At least one workspace root is required");
    return new ProjectRegistry(canonical);
  }

  async registerExisting(input: {
    projectId: string;
    name: string;
    rootId: string;
    relativePath: string;
    branch?: string;
  }): Promise<ProjectSummary> {
    if (this.#projects.has(input.projectId)) throw new Error("projectId already registered");
    if (path.isAbsolute(input.relativePath) || input.relativePath.includes("\0")) {
      throw new Error("Project path must be relative to an allowed workspace root");
    }
    const allowedRoot = this.#allowedRoots.get(input.rootId);
    if (!allowedRoot) throw new Error("Unknown workspace root");
    const candidate = await realpath(path.resolve(allowedRoot, input.relativePath));
    if (!isInside(allowedRoot, candidate)) throw new Error("Project resolves outside its workspace root");
    await access(path.join(candidate, ".git"));
    const branch = input.branch ?? "unknown";
    if (
      input.name.trim().length === 0 ||
      input.name.length > 80 ||
      branch.length === 0 ||
      branch.length > 255 ||
      /[\0\r\n]/.test(branch)
    ) {
      throw new Error("Project name or branch is invalid");
    }
    const project = Object.freeze({
      projectId: input.projectId,
      name: input.name.trim(),
      repository: path.basename(candidate),
      branch,
      rootId: input.rootId,
      projectRoot: candidate,
    });
    this.#projects.set(project.projectId, project);
    return {
      projectId: project.projectId,
      name: project.name,
      repository: project.repository,
      branch: project.branch,
    };
  }

  require(projectId: string): RegisteredProject {
    const project = this.#projects.get(projectId);
    if (!project) throw new Error("Project not found");
    return project;
  }

  list(): readonly ProjectSummary[] {
    return [...this.#projects.values()].map(({ projectId, name, repository, branch }) => ({
      projectId,
      name,
      repository,
      branch,
    }));
  }
}
