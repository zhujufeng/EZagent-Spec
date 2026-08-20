import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { z } from "zod";

import { isWorkItemId } from "../domain/id.js";

const workItemKinds = ["requirement", "spec", "task"] as const;
const workItemStatuses = [
  "captured", "clarifying", "specified", "approved", "planned", "implementing",
  "verifying", "completed", "cancelled",
] as const;
const riskLevels = ["consult", "light", "standard", "high"] as const;

function assertAllowedKeys(value: unknown, allowedKeys: readonly string[], label: string): void {
  if (value === null || typeof value !== "object") {
    return;
  }
  const allowed = new Set(allowedKeys);
  const unknownKey = Object.keys(value).find((key) => !allowed.has(key));
  if (unknownKey !== undefined) {
    throw new Error(`${label} contains unsupported key: ${unknownKey}`);
  }
}

const projectConfigKeys = ["schemaVersion", "name", "gitTracking"] as const;
const workspaceStateKeys = ["schemaVersion", "revision", "activeWorkItem", "safeMode"] as const;
const activeWorkItemKeys = ["id", "kind", "status", "risk", "revision"] as const;

const projectConfigSchema = z.object({
  schemaVersion: z.literal(1),
  name: z.string().trim().min(1),
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
  const value: unknown = parseYaml(text);
  assertAllowedKeys(value, projectConfigKeys, "project config");
  return projectConfigSchema.parse(value);
}

export function serializeProjectConfig(config: ProjectConfig): string {
  assertAllowedKeys(config, projectConfigKeys, "project config");
  return stringifyYaml(projectConfigSchema.parse(config));
}

export function parseWorkspaceState(value: unknown): WorkspaceState {
  assertAllowedKeys(value, workspaceStateKeys, "workspace state");
  if (value !== null && typeof value === "object" && "activeWorkItem" in value) {
    const activeWorkItem = (value as { activeWorkItem?: unknown }).activeWorkItem;
    assertAllowedKeys(activeWorkItem, activeWorkItemKeys, "active work item");
  }
  return workspaceStateSchema.parse(value);
}
