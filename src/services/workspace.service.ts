import { AppError } from "../lib/errors/app-error";
import { WorkspaceRepository } from "../db/workspace.repository";
import { Workspace, UpdateWorkspaceInput } from "../lib/types/workspace.types";

export const WorkspaceService = {
  async create(name: string, userId: string): Promise<Workspace> {
    return WorkspaceRepository.create({ name, user_id: userId });
  },

  async getById(id: string): Promise<Workspace> {
    const workspace = await WorkspaceRepository.findById(id);
    if (!workspace) {
      throw new AppError("Workspace not found", 404);
    }
    return workspace;
  },

  async listForUser(userId: string): Promise<Workspace[]> {
    return WorkspaceRepository.findByOwner(userId);
  },

  async update(
    id: string,
    userId: string,
    data: UpdateWorkspaceInput,
  ): Promise<Workspace> {
    const workspace = await this.getById(id);
    this.ensureOwner(workspace, userId);
    return WorkspaceRepository.update(id, data);
  },

  async delete(id: string, userId: string): Promise<void> {
    const workspace = await this.getById(id);
    this.ensureOwner(workspace, userId);
    await WorkspaceRepository.delete(id);
  },

  /**
   * Throws AppError(403) if the given user does not own the workspace.
   * Used by route middleware to gate every workspace-scoped endpoint.
   */
  async assertOwnership(userId: string, workspaceId: string): Promise<Workspace> {
    const workspace = await this.getById(workspaceId);
    this.ensureOwner(workspace, userId);
    return workspace;
  },

  ensureOwner(workspace: Workspace, userId: string): void {
    if (workspace.user_id !== userId) {
      throw new AppError("Forbidden: not a member of this workspace", 403);
    }
  },
};
