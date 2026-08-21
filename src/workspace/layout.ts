import { join } from "node:path";

export const WORKSPACE_DIRECTORIES = [
  "state", "requirements", "specs", "tasks", "knowledge/decisions", "knowledge/patterns",
  "experts", "quality/runs", "audit", "backups",
] as const;

export interface WorkspacePaths {
  readonly root: string;
  readonly project: string;
  readonly state: string;
  readonly lock: string;
  readonly audit: string;
  readonly pendingMutation: string;
}

export interface WorkspacePathApi {
  readonly join: (...paths: string[]) => string;
}

const nodeWorkspacePathApi: WorkspacePathApi = { join };

export function workspacePaths(
  projectRoot: string,
  pathApi: WorkspacePathApi = nodeWorkspacePathApi,
): Readonly<WorkspacePaths> {
  const root = pathApi.join(projectRoot, ".ezagent");
  return {
    root,
    project: pathApi.join(root, "project.yaml"),
    state: pathApi.join(root, "state", "workspace.json"),
    lock: pathApi.join(root, "state", "write.lock"),
    audit: pathApi.join(root, "audit", "events.jsonl"),
    pendingMutation: pathApi.join(root, "state", "pending-mutation.json"),
  };
}
