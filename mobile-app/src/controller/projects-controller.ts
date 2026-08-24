import { ProjectsReadError } from "../model/projects-read.js";
import type { ProjectsReadFailureCode, ProjectsReadPort } from "../model/projects-read.js";
import type { AppEvent } from "../model/reducer.js";

function failureCode(error: unknown): ProjectsReadFailureCode {
  return error instanceof ProjectsReadError ? error.code : "transport_failed";
}

/**
 * Drives the read-only project directory: it turns port results and port
 * failures into Model events and never rejects at its caller, because a failed
 * background read is a screen state, not a command failure.
 *
 * The two reads are kept apart on purpose. The registry listing is host-wide,
 * while the repository state belongs to one project, so a project whose
 * repository cannot be read must not make the whole list look unreachable — and
 * a list that failed must not hide a binding the host did answer.
 */
export class ProjectsController {
  constructor(
    private readonly reads: ProjectsReadPort,
    private readonly dispatch: (event: AppEvent) => void,
  ) {}

  /**
   * Reads the registry and, when a project is selected, its repository state.
   * The listing is read first: it is what decides whether the selected project
   * is still registered at all.
   */
  async refresh(input: Readonly<{ projectId: string | null }>): Promise<void> {
    await this.readProjects();
    if (input.projectId !== null) await this.refreshRepository({ projectId: input.projectId });
  }

  /** Selects a project and reads its repository state; the listing is left untouched. */
  async selectProject(input: Readonly<{ projectId: string }>): Promise<void> {
    this.dispatch({ type: "project.selected", projectId: input.projectId });
    await this.refreshRepository(input);
  }

  /**
   * Re-reads the repository state of an already open project. It deliberately
   * dispatches no selection: a project that is already open must not be
   * re-selected just to refresh it, because selecting resets the spaces that
   * follow the project.
   */
  async refreshRepository(input: Readonly<{ projectId: string }>): Promise<void> {
    const projectId = input.projectId;
    // Scoped: this read answers for one project's binding, never for the
    // registry channel, whose link only a listing may move.
    this.dispatch({ type: "projects.read-started", scope: "repository" });
    try {
      const status = await this.reads.readRepositoryStatus({ projectId });
      // The project id travels with the answer so the Model can drop a read the
      // operator already navigated away from.
      this.dispatch({ type: "projects.repository-status", projectId, status });
    } catch (error) {
      this.dispatch({
        type: "projects.repository-failed",
        projectId,
        failure: failureCode(error),
      });
    } finally {
      this.dispatch({ type: "projects.read-settled" });
    }
  }

  private async readProjects(): Promise<void> {
    this.dispatch({ type: "projects.read-started", scope: "list" });
    try {
      const projects = await this.reads.readProjects();
      this.dispatch({ type: "projects.list", projects });
    } catch (error) {
      this.dispatch({ type: "projects.read-failed", failure: failureCode(error) });
    } finally {
      this.dispatch({ type: "projects.read-settled" });
    }
  }
}
