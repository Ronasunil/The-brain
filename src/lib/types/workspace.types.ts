export interface Workspace {
  id: string;
  name: string;
  user_id: string | null;
  created_at: Date;
}

export interface CreateWorkspaceInput {
  name: string;
  user_id: string;
}

export interface UpdateWorkspaceInput {
  name?: string;
}
