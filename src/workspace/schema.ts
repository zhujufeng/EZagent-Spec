import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { z } from "zod";

import { isWorkItemId } from "../domain/id.js";

const workItemKinds = ["requirement", "spec", "task"] as const;
const workItemStatuses = [
  "captured", "clarifying", "specified", "approved", "planned", "implementing",
  "verifying", "completed", "cancelled",
] as const;
const riskLevels = ["consult", "light", "standard", "high"] as const;

const projectConfigSchema = z.object({
  schemaVersion: z.literal(1),
  name: z.string().min(1),
  gitTracking: z.enum(["none", "artifacts", "all"]).default("none"),
}).strict();

const activeWorkItemSchema = z.object({
  id: z.string().refine(isWorkItemId, "invalid work item ID"),
  kind: z.enum(workItemKinds),
  status: z.enum(workItemStatuses),
  risk: z.enum(riskLevels),
  revision: z.number().int().nonnegative(),
}).strict().superRefine((item, context) => {
  const expectedPrefix = { requirement: "REQ", spec: "SPEC", task: "TASK" }[item.kind];
  if (!item.id.startsWith(`${expectedPrefix}-`)) {
    context.addIssue({ code: "custom", path: ["id"], message: "work item ID prefix does not match kind" });
  }
});

const workspaceStateSchema = z.object({
  schemaVersion: z.literal(1),
  revision: z.number().int().nonnegative(),
  activeWorkItem: activeWorkItemSchema.nullable(),
  safeMode: z.boolean(),
}).strict();

export type ProjectConfig = z.infer<typeof projectConfigSchema>;
export type WorkItemState = z.infer<typeof activeWorkItemSchema>;
export type WorkspaceState = Omit<z.infer<typeof workspaceStateSchema>, "activeWorkItem"> & {
  activeWorkItem: WorkItemState | null;
};

export function parseProjectConfig(text: string): ProjectConfig {
  return projectConfigSchema.parse(parseYaml(text));
}

export function serializeProjectConfig(config: ProjectConfig): string {
  return stringifyYaml(projectConfigSchema.parse(config));
}

export function parseWorkspaceState(value: unknown): WorkspaceState {
  return workspaceStateSchema.parse(value);
}
