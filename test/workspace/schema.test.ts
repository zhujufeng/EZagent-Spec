import { join } from "node:path";

import { describe, expect, test } from "vitest";

import { WORKSPACE_DIRECTORIES, workspacePaths } from "../../src/workspace/layout.js";
import {
  WorkspaceCorruptError,
  WorkspaceLockedError,
  WorkspaceNotInitializedError,
} from "../../src/workspace/errors.js";
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
    expect(() => parseProjectConfig("schemaVersion: 1\nname: Demo\n__proto__: true\n")).toThrow();
    expect(() => parseProjectConfig("schemaVersion: 1\nname: Demo\nschemaVersion: 1\n")).toThrow();
    expect(() => parseProjectConfig("---\nschemaVersion: 1\nname: Demo\n---\nschemaVersion: 1\nname: Other\n")).toThrow();
    expect(parseProjectConfig("schemaVersion: 1\nname: '  Demo  '\n")).toEqual({
      schemaVersion: 1,
      name: "Demo",
      gitTracking: "none",
    });
    expect(() => parseProjectConfig("schemaVersion: 1\nname: '   '\n")).toThrow();
  });

  test("rejects unknown keys during config serialization", () => {
    expect(() => serializeProjectConfig(JSON.parse('{"schemaVersion":1,"name":"Demo","__proto__":true}'))).toThrow();
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

  test("accepts all valid ID and kind prefix pairs", () => {
    for (const [id, kind] of [
      ["REQ-20260820-001", "requirement"],
      ["SPEC-20260820-001", "spec"],
      ["TASK-20260820-001", "task"],
    ] as const) {
      expect(parseWorkspaceState({ ...validState, activeWorkItem: { ...validState.activeWorkItem!, id, kind }}).activeWorkItem?.id).toBe(id);
    }
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
    expect(() => parseWorkspaceState(JSON.parse('{"schemaVersion":1,"revision":0,"activeWorkItem":null,"safeMode":false,"__proto__":true}'))).toThrow();
    expect(() => parseWorkspaceState({ ...validState, schemaVersion: 2 })).toThrow();
    expect(() => parseWorkspaceState({ ...validState, safeMode: "false" })).toThrow();
    expect(() => parseWorkspaceState({ ...validState, activeWorkItem: { ...validState.activeWorkItem!, id: "TASK-invalid" } })).toThrow();
    expect(() => parseWorkspaceState({ ...validState, activeWorkItem: { ...validState.activeWorkItem!, kind: "requirement" } })).toThrow();
    expect(() => parseWorkspaceState({ ...validState, activeWorkItem: { ...validState.activeWorkItem!, id: "REQ-20260820-001", kind: "task" } })).toThrow();
    expect(() => parseWorkspaceState({ ...validState, activeWorkItem: { ...validState.activeWorkItem!, id: "TASK-20260820-001", kind: "requirement" } })).toThrow();
    expect(() => parseWorkspaceState({ ...validState, activeWorkItem: { ...validState.activeWorkItem!, revision: -1 } })).toThrow();
    expect(() => parseWorkspaceState({ ...validState, activeWorkItem: { ...validState.activeWorkItem!, status: "unknown" } })).toThrow();
    expect(() => parseWorkspaceState({ ...validState, activeWorkItem: { ...validState.activeWorkItem!, risk: "unknown" } })).toThrow();
    expect(() => parseWorkspaceState({ ...validState, activeWorkItem: { ...validState.activeWorkItem!, extra: true } })).toThrow();
    const nestedWithProto = JSON.parse('{"schemaVersion":1,"revision":0,"activeWorkItem":{"id":"TASK-20260820-001","kind":"task","status":"approved","risk":"standard","revision":2,"__proto__":true},"safeMode":false}');
    expect(() => parseWorkspaceState(nestedWithProto)).toThrow();
  });
});

describe("workspace errors", () => {
  test("have stable names and preserve causes", () => {
    const cause = new Error("root");
    for (const [ErrorType, name] of [
      [WorkspaceNotInitializedError, "WorkspaceNotInitializedError"],
      [WorkspaceCorruptError, "WorkspaceCorruptError"],
      [WorkspaceLockedError, "WorkspaceLockedError"],
    ] as const) {
      const error = new ErrorType("message", { cause });
      expect(error).toBeInstanceOf(ErrorType);
      expect(error.name).toBe(name);
      expect(error.message).toBe("message");
      expect(error.cause).toBe(cause);
    }
  });

  test("workspace lock errors expose an optional stable code", () => {
    const cause = new Error("root");
    const error = new WorkspaceLockedError("timed out", { cause, code: "LOCK_WAIT_TIMEOUT" });

    expect(error.code).toBe("LOCK_WAIT_TIMEOUT");
    expect(error.cause).toBe(cause);
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
