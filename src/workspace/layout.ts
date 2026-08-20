import { join } from "node:path";

export const WORKSPACE_DIRECTORIES = [
  "state", "requirements", "specs", "tasks", "knowledge/decisions", "knowledge/patterns",
  "experts", "quality/runs", "quality/authorizations", "audit", "backups",
] as const;

export interface WorkspacePaths {
  readonly root: string;
  readonly project: string;
  readonly state: string;
  readonly lock: string;
  readonly audit: string;
  readonly pendingMutation: string;
}

export function workspacePaths(projectRoot: string): Readonly<WorkspacePaths> {
  const root = join(projectRoot, ".ezagent");
  return {
    root,
    project: join(root, "project.yaml"),
    state: join(root, "state", "workspace.json"),
    lock: join(root, "state", "write.lock"),
    audit: join(root, "audit", "events.jsonl"),
    pendingMutation: join(root, "state", "pending-mutation.json"),
  };
}
