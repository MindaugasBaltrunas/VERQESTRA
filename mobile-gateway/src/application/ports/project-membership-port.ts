export interface ProjectMembershipPort {
  canReadProject(principalId: string, projectId: string): Promise<boolean>;
  canControlTerminal(principalId: string, projectId: string): Promise<boolean>;
}

export class SoloOwnerProjectMembership implements ProjectMembershipPort {
  async canReadProject(_principalId: string, _projectId: string): Promise<boolean> {
    return true;
  }

  async canControlTerminal(_principalId: string, _projectId: string): Promise<boolean> {
    return true;
  }
}
