import type {
  AgLoopDashboard,
  AgLoopLearning,
  AgLoopLogName,
  AgLoopLogs,
  AgLoopPolicyControls,
  AgLoopStreamMessage,
  AgLoopTaskBucket,
  AgLoopTokenAnalytics,
  AgLoopTokenUsage,
  AgLoopUiReadPort,
} from "./ports/ag-loop-ui-read-port.js";
import type { ProjectMembershipPort } from "./ports/project-membership-port.js";
import { ProjectRegistry, type ProjectSummary } from "./project-registry.js";

export type MobileProjectSummary = ProjectSummary & Readonly<{
  agLoopUi: "online" | "offline" | "not_configured";
}>;

export class ProjectReadError extends Error {
  constructor(
    readonly code: "project_not_found" | "ag_loop_ui_offline",
    message: string,
  ) {
    super(message);
    this.name = "ProjectReadError";
  }
}

export class ProjectReadService {
  constructor(
    private readonly registry: ProjectRegistry,
    private readonly membership: ProjectMembershipPort,
    private readonly agLoopUiForProject: (projectId: string) => AgLoopUiReadPort | undefined,
  ) {}

  private async requireVisible(principalId: string, projectId: string): Promise<void> {
    if (!await this.membership.canReadProject(principalId, projectId)) {
      throw new ProjectReadError("project_not_found", "Project is not visible");
    }
    try {
      this.registry.require(projectId);
    } catch {
      throw new ProjectReadError("project_not_found", "Project is not visible");
    }
  }

  /**
   * Resolves the AG Loop UI of a project the principal may read.
   *
   * Every AG read goes through here, so visibility is decided before an upstream
   * call is made and an unconfigured UI is the same answer as an absent one.
   */
  private async requireAgLoopUi(principalId: string, projectId: string): Promise<AgLoopUiReadPort> {
    await this.requireVisible(principalId, projectId);
    const adapter = this.agLoopUiForProject(projectId);
    if (!adapter) {
      throw new ProjectReadError("ag_loop_ui_offline", "AG Loop UI is not configured");
    }
    return adapter;
  }

  /**
   * Runs one AG Loop UI read and collapses every upstream fault to
   * `ag_loop_ui_offline`. The original error is deliberately dropped: it carries
   * upstream status text and host paths, and the phone is told what it can act
   * on, which is that the read is unavailable and retrying is worthwhile.
   */
  private async read<T>(
    principalId: string,
    projectId: string,
    operation: (adapter: AgLoopUiReadPort) => Promise<T>,
  ): Promise<T> {
    const adapter = await this.requireAgLoopUi(principalId, projectId);
    try {
      return await operation(adapter);
    } catch {
      throw new ProjectReadError("ag_loop_ui_offline", "AG Loop UI is offline");
    }
  }

  async list(principalId: string): Promise<readonly MobileProjectSummary[]> {
    const visible: MobileProjectSummary[] = [];
    for (const project of this.registry.list()) {
      if (!await this.membership.canReadProject(principalId, project.projectId)) {
        continue;
      }
      const adapter = this.agLoopUiForProject(project.projectId);
      let agLoopUi: MobileProjectSummary["agLoopUi"] = "not_configured";
      if (adapter) {
        try {
          agLoopUi = (await adapter.dashboard()).availability;
        } catch {
          agLoopUi = "offline";
        }
      }
      visible.push({ ...project, agLoopUi });
    }
    return visible;
  }

  async dashboard(principalId: string, projectId: string): Promise<AgLoopDashboard> {
    return this.read(principalId, projectId, (adapter) => adapter.dashboard());
  }

  async taskBucket(
    principalId: string,
    projectId: string,
    bucket: string,
  ): Promise<AgLoopTaskBucket> {
    return this.read(principalId, projectId, (adapter) => adapter.taskBucket(bucket));
  }

  async logs(
    principalId: string,
    projectId: string,
    log: AgLoopLogName,
    lines: number,
  ): Promise<AgLoopLogs> {
    return this.read(principalId, projectId, (adapter) => adapter.logs(log, lines));
  }

  async tokenUsage(
    principalId: string,
    projectId: string,
    limit: number,
  ): Promise<AgLoopTokenUsage> {
    return this.read(principalId, projectId, (adapter) => adapter.tokenUsage(limit));
  }

  async tokenAnalytics(principalId: string, projectId: string): Promise<AgLoopTokenAnalytics> {
    return this.read(principalId, projectId, (adapter) => adapter.tokenAnalytics());
  }

  async policyControls(principalId: string, projectId: string): Promise<AgLoopPolicyControls> {
    return this.read(principalId, projectId, (adapter) => adapter.policyControls());
  }

  async learning(principalId: string, projectId: string): Promise<AgLoopLearning> {
    return this.read(principalId, projectId, (adapter) => adapter.learning());
  }

  /**
   * Authorizes the caller and hands back the sanitized activity stream.
   *
   * Authorization happens now, while a response status can still be chosen; the
   * stream itself is consumed later by the transport, where an upstream fault
   * can only end the stream, not change its status code.
   */
  async activityStream(
    principalId: string,
    projectId: string,
    signal: AbortSignal,
  ): Promise<AsyncIterable<AgLoopStreamMessage>> {
    const adapter = await this.requireAgLoopUi(principalId, projectId);
    return adapter.activityStream(signal);
  }
}
