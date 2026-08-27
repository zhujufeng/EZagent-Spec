import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { z } from "zod";

import { isWorkItemId } from "../domain/id.js";

const workItemKinds = ["requirement", "spec", "task"] as const;
const workItemStatuses = [
  "captured", "clarifying", "specified", "approved", "planned", "implementing",
  "verifying", "completed", "cancelled",
] as const;
const riskLevels = ["consult", "light", "brief", "standard", "high"] as const;

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
const workspaceStateKeys = ["schemaVersion", "revision", "activeWorkItem", "sessions", "safeMode"] as const;
const activeWorkItemKeys = ["id", "kind", "status", "risk", "revision"] as const;
const sessionKeys = ["key", "activeWorkItem"] as const;
const SESSION_KEY = /^[a-z0-9](?:[a-z0-9-]{0,94}[a-z0-9])?$/u;

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

const sessionSchema = z.object({
  key: z.string().min(1).max(96).regex(SESSION_KEY),
  activeWorkItem: activeWorkItemSchema,
}).strict();

const workspaceStateSchema = z.object({
  schemaVersion: z.literal(1),
  revision: z.number().int().nonnegative(),
  activeWorkItem: activeWorkItemSchema.nullable(),
  sessions: z.array(sessionSchema).max(128).optional(),
  safeMode: z.boolean(),
}).strict().superRefine((state, context) => {
  const sessionKeys = new Set<string>();
  const workItemIds = new Set<string>();
  for (const [index, session] of (state.sessions ?? []).entries()) {
    if (sessionKeys.has(session.key)) {
      context.addIssue({ code: "custom", path: ["sessions", index, "key"], message: "session key must be unique" });
    }
    sessionKeys.add(session.key);
    if (workItemIds.has(session.activeWorkItem.id)) {
      context.addIssue({
        code: "custom",
        path: ["sessions", index, "activeWorkItem", "id"],
        message: "active Work Item must belong to only one session",
      });
    }
    workItemIds.add(session.activeWorkItem.id);
  }
});

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
  if (value !== null && typeof value === "object" && "sessions" in value) {
    const sessions = (value as { sessions?: unknown }).sessions;
    if (Array.isArray(sessions)) {
      for (const session of sessions) {
        assertAllowedKeys(session, sessionKeys, "workspace session");
        if (session !== null && typeof session === "object" && "activeWorkItem" in session) {
          assertAllowedKeys(
            (session as { activeWorkItem?: unknown }).activeWorkItem,
            activeWorkItemKeys,
            "session active work item",
          );
        }
      }
    }
  }
  return workspaceStateSchema.parse(value);
}

export function parseSessionKey(value: unknown): string {
  return z.string().min(1).max(96).regex(SESSION_KEY).parse(value);
}
