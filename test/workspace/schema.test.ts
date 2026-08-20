import { join } from "node:path";

import { describe, expect, test } from "vitest";

import { WORKSPACE_DIRECTORIES, workspacePaths } from "../../src/workspace/layout.js";
import {
  parseProjectConfig,
  parseWorkspaceState,
  serializeProjectConfig,
  type ProjectConfig,
  type WorkspaceState,
} from "../../src/workspace/schema.js";

describe("project config schema", () => {
  test("parses a valid local-only config", () => {
    expect(parseProjectConfig("schemaVersion: 1\nname: Demo\ngitTracking: none\n")).toEqual({
      schemaVersion: 1,
      name: "Demo",
      gitTracking: "none",
    });
  });

  test("defaults git tracking to none", () => {
    expect(parseProjectConfig("schemaVersion: 1\nname: Demo\n")).toEqual({
      schemaVersion: 1,
      name: "Demo",
      gitTracking: "none",
    });
  });

  test("round-trips a valid config", () => {
    const config: ProjectConfig = { schemaVersion: 1, name: "Demo", gitTracking: "all" };
    expect(parseProjectConfig(serializeProjectConfig(config))).toEqual(config);
  });

  test("rejects invalid project configs", () => {
    expect(() => parseProjectConfig("schemaVersion: 1\nname: \ngitTracking: none\n")).toThrow();
    expect(() => parseProjectConfig("schemaVersion: 2\nname: Demo\n")).toThrow();
    expect(() => parseProjectConfig("schemaVersion: 1\nname: Demo\ngitTracking: bad\n")).toThrow();
    expect(() => parseProjectConfig("schemaVersion: 1\nname: Demo\nextra: true\n")).toThrow();
  });
});

describe("workspace state schema", () => {
  const validState: WorkspaceState = {
    schemaVersion: 1,
    revision: 0,
    activeWorkItem: {
      id: "TASK-20260820-001",
      kind: "task",
      status: "approved",
      risk: "standard",
      revision: 2,
    },
    safeMode: false,
  };

  test("accepts a valid active task", () => {
    expect(parseWorkspaceState(validState)).toEqual(validState);
  });

  test("accepts a null active work item", () => {
    expect(parseWorkspaceState({ ...validState, activeWorkItem: null })).toEqual({
      ...validState,
      activeWorkItem: null,
    });
  });

  test("rejects invalid workspace and active item values", () => {
    for (const revision of [-1, 0.5]) {
      expect(() => parseWorkspaceState({ ...validState, revision })).toThrow();
    }
    expect(() => parseWorkspaceState({ ...validState, extra: true })).toThrow();
    expect(() => parseWorkspaceState({ ...validState, activeWorkItem: { ...validState.activeWorkItem!, id: "TASK-invalid" } })).toThrow();
    expect(() => parseWorkspaceState({ ...validState, activeWorkItem: { ...validState.activeWorkItem!, kind: "requirement" } })).toThrow();
    expect(() => parseWorkspaceState({ ...validState, activeWorkItem: { ...validState.activeWorkItem!, revision: -1 } })).toThrow();
    expect(() => parseWorkspaceState({ ...validState, activeWorkItem: { ...validState.activeWorkItem!, status: "unknown" } })).toThrow();
    expect(() => parseWorkspaceState({ ...validState, activeWorkItem: { ...validState.activeWorkItem!, risk: "unknown" } })).toThrow();
    expect(() => parseWorkspaceState({ ...validState, activeWorkItem: { ...validState.activeWorkItem!, extra: true } })).toThrow();
  });
});

describe("workspace layout", () => {
  test("defines the workspace directories and paths", () => {
    expect(WORKSPACE_DIRECTORIES).toEqual([
      "state", "requirements", "specs", "tasks", "knowledge/decisions", "knowledge/patterns",
      "experts", "quality/runs", "quality/authorizations", "audit", "backups",
    ]);
    expect(workspacePaths("project")).toEqual({
      root: join("project", ".ezagent"),
      project: join("project", ".ezagent", "project.yaml"),
      state: join("project", ".ezagent", "state", "workspace.json"),
      lock: join("project", ".ezagent", "state", "write.lock"),
      audit: join("project", ".ezagent", "audit", "events.jsonl"),
    });
  });
});
