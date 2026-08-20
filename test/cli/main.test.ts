import { mkdtemp, readFile, readdir, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { execa } from "execa";
import { afterEach, beforeAll, describe, expect, test } from "vitest";

import { readAuditEvents } from "../../src/audit/events.js";
import { WorkspaceRepository } from "../../src/workspace/repository.js";
import { workspacePaths } from "../../src/workspace/layout.js";
import type { WorkItemState } from "../../src/domain/work-item.js";

const PROJECT_ROOT = resolve(import.meta.dirname, "../..");
const CLI_PATH = join(PROJECT_ROOT, "dist", "src", "cli", "main.js");
const temporaryRoots: string[] = [];

async function temporaryProject(label = "EZagent CLI project with spaces "): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), label));
  temporaryRoots.push(root);
  return root;
}

async function runCli(args: readonly string[], cwd = PROJECT_ROOT) {
  return execa(process.execPath, [CLI_PATH, ...args], {
    cwd,
    reject: false,
    stripFinalNewline: false,
  });
}

function expectJsonSuccess(result: Awaited<ReturnType<typeof runCli>>): unknown {
  expect(result.exitCode).toBe(0);
  expect(result.stderr).toBe("");
  expect(result.stdout.endsWith("\n")).toBe(true);
  expect(result.stdout.slice(0, -1)).not.toContain("\n");
  return JSON.parse(result.stdout) as unknown;
}

function expectSingleLineFailure(result: Awaited<ReturnType<typeof runCli>>, message?: string): void {
  expect(result.exitCode).not.toBe(0);
  expect(result.stdout).toBe("");
  expect(result.stderr.endsWith("\n")).toBe(true);
  expect(result.stderr.slice(0, -1)).not.toContain("\n");
  expect(result.stderr).not.toMatch(/\bat\s+.*\([^)]*:\d+:\d+\)/u);
  expect(result.stderr).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/iu);
  if (message !== undefined) expect(result.stderr).toContain(message);
}

async function initializedWorkspace(
  activeWorkItem: WorkItemState | null = null,
  safeMode = false,
): Promise<{ readonly root: string; readonly repository: WorkspaceRepository }> {
  const root = await temporaryProject();
  const repository = new WorkspaceRepository(root);
  await repository.initialize({ schemaVersion: 1, name: "Demo", gitTracking: "none" });
  if (activeWorkItem !== null || safeMode) {
    await repository.recordState({
      schemaVersion: 1,
      revision: 1,
      activeWorkItem,
      safeMode,
    }, 0, "work-item-captured");
  }
  return { root, repository };
}

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

beforeAll(async () => {
  await execa("npm", ["run", "build"], { cwd: PROJECT_ROOT });
});

describe("ezagent CLI", () => {
  test("doctor resolves a real directory without creating workspace state", async () => {
    const root = await temporaryProject();
    const result = await runCli(["doctor", "--root", basename(root)], dirname(root));

    const output = expectJsonSuccess(result);
    expect(output).toMatchObject({
      ok: true,
      node: process.version,
    });
    expect(await realpath((output as { root: string }).root)).toBe(await realpath(root));
    expect(await readdir(root)).toEqual([]);
  });

  test("doctor rejects missing roots and regular files", async () => {
    const root = await temporaryProject();
    const file = join(root, "not-a-directory");
    await writeFile(file, "", "utf8");

    expectSingleLineFailure(await runCli(["doctor", "--root", join(root, "missing")]), "does not exist");
    expectSingleLineFailure(await runCli(["doctor", "--root", file]), "not a directory");
    expect(await readdir(root)).toEqual(["not-a-directory"]);
  });

  test("initializes a path with spaces and returns machine-readable context", async () => {
    const root = await temporaryProject();

    expect(expectJsonSuccess(await runCli(["init", "--root", root, "--name", "  Demo  "]))).toEqual({
      ok: true,
      initialized: true,
      root,
    });
    expect(expectJsonSuccess(await runCli(["context", "--root", root, "--json"]))).toEqual({
      project: { schemaVersion: 1, name: "Demo", gitTracking: "none" },
      state: { schemaVersion: 1, revision: 0, activeWorkItem: null, safeMode: false },
      recovered: false,
    });
  });

  test.each([
    ["unknown flag", ["doctor", "--root", ".", "--wat", "value"], "unknown option"],
    ["duplicate flag", ["doctor", "--root", ".", "--root", "."], "duplicate option"],
    ["unexpected positional", ["doctor", "surprise"], "unexpected positional"],
    ["missing value", ["doctor", "--root"], "requires a value"],
    ["flag as value", ["doctor", "--root", "--name", "Demo"], "requires a value"],
    ["boolean value", ["context", "--root", ".", "--json", "yes"], "unexpected positional"],
    ["wrong-command option", ["doctor", "--json"], "unknown option"],
    ["missing json mode", ["context", "--root", "."], "--json is required"],
  ])("rejects %s", async (_label, args, message) => {
    expectSingleLineFailure(await runCli(args), message);
  });

  test("emits stable usage for a missing or unknown command", async () => {
    const usage = "usage: ezagent <doctor|init|context|transition> [options]\n";
    const missing = await runCli([]);
    const unknown = await runCli(["unknown"]);

    expectSingleLineFailure(missing);
    expectSingleLineFailure(unknown);
    expect(missing.stderr).toBe(usage);
    expect(unknown.stderr).toBe(usage);
  });

  test.each(["", "   ", "bad\nname", "x".repeat(129)])(
    "rejects an invalid project name before filesystem side effects: %j",
    async (name) => {
      const root = await temporaryProject();

      expectSingleLineFailure(
        await runCli(["init", "--root", root, "--name", name]),
        "project name",
      );
      expect(await readdir(root)).toEqual([]);
    },
  );

  test("transitions the active work item and records a normalized authorization ID", async () => {
    const active: WorkItemState = {
      id: "TASK-20260820-001",
      kind: "task",
      status: "planned",
      risk: "high",
      revision: 0,
    };
    const { root, repository } = await initializedWorkspace(active);

    const output = expectJsonSuccess(await runCli([
      "transition", "--root", root,
      "--to", "implementing",
      "--revision", "0",
      "--high-risk-authorization", "  AUTH-20260820-001  ",
    ]));

    expect(output).toEqual({
      schemaVersion: 1,
      revision: 2,
      activeWorkItem: { ...active, status: "implementing", revision: 1 },
      safeMode: false,
    });
    await expect(repository.readState()).resolves.toEqual(output);
    await expect(readAuditEvents(workspacePaths(root).audit)).resolves.toMatchObject([
      { sequence: 1, type: "work-item-captured" },
      {
        sequence: 2,
        type: "work-item-transitioned",
        metadata: { highRiskAuthorizationId: "AUTH-20260820-001" },
      },
    ]);
  });

  test.each([
    ["unknown status", ["--to", "unknown", "--revision", "0"], "--to must be"],
    ["empty revision", ["--to", "clarifying", "--revision", ""], "canonical"],
    ["NaN revision", ["--to", "clarifying", "--revision", "NaN"], "canonical"],
    ["partial revision", ["--to", "clarifying", "--revision", "1x"], "canonical"],
    ["decimal revision", ["--to", "clarifying", "--revision", "1.0"], "canonical"],
    ["negative revision", ["--to", "clarifying", "--revision", "-1"], "canonical"],
    ["unsafe revision", ["--to", "clarifying", "--revision", "9007199254740992"], "canonical"],
    ["revision conflict", ["--to", "clarifying", "--revision", "1"], "revision conflict"],
    ["illegal transition", ["--to", "completed", "--revision", "0"], "illegal transition"],
    [
      "invalid authorization date",
      ["--to", "clarifying", "--revision", "0", "--high-risk-authorization", "AUTH-20260230-001"],
      "authorization",
    ],
  ])("rejects %s without changing state or audit", async (_label, options, message) => {
    const active: WorkItemState = {
      id: "REQ-20260820-001",
      kind: "requirement",
      status: "captured",
      risk: "standard",
      revision: 0,
    };
    const { root } = await initializedWorkspace(active);
    const paths = workspacePaths(root);
    const before = await Promise.all([readFile(paths.state, "utf8"), readFile(paths.audit, "utf8")]);

    expectSingleLineFailure(await runCli(["transition", "--root", root, ...options]), message);
    expect(await Promise.all([readFile(paths.state, "utf8"), readFile(paths.audit, "utf8")])).toEqual(before);
  });

  test("rejects safe mode and a missing active work item explicitly", async () => {
    const active: WorkItemState = {
      id: "REQ-20260820-001",
      kind: "requirement",
      status: "captured",
      risk: "standard",
      revision: 0,
    };
    const safe = await initializedWorkspace(active, true);
    const empty = await initializedWorkspace();

    expectSingleLineFailure(
      await runCli(["transition", "--root", safe.root, "--to", "clarifying", "--revision", "0"]),
      "safe mode",
    );
    expectSingleLineFailure(
      await runCli(["transition", "--root", empty.root, "--to", "clarifying", "--revision", "0"]),
      "no active work item",
    );
  });

  test("reports recovered context and repairs it on the next transition", async () => {
    const active: WorkItemState = {
      id: "REQ-20260820-001",
      kind: "requirement",
      status: "captured",
      risk: "standard",
      revision: 0,
    };
    const { root, repository } = await initializedWorkspace(active);
    await writeFile(workspacePaths(root).state, "broken", "utf8");

    expect(expectJsonSuccess(await runCli(["context", "--root", root, "--json"]))).toMatchObject({
      state: { revision: 1, activeWorkItem: active },
      recovered: true,
    });
    expectJsonSuccess(await runCli([
      "transition", "--root", root, "--to", "clarifying", "--revision", "0",
    ]));
    await expect(repository.readContext()).resolves.toMatchObject({
      state: { revision: 2, activeWorkItem: { status: "clarifying", revision: 1 } },
      recovered: false,
    });
  });

  test("allows at most one concurrent transition with the same expected revision", async () => {
    const active: WorkItemState = {
      id: "REQ-20260820-001",
      kind: "requirement",
      status: "captured",
      risk: "standard",
      revision: 0,
    };
    const { root, repository } = await initializedWorkspace(active);
    const args = ["transition", "--root", root, "--to", "clarifying", "--revision", "0"];

    const results = await Promise.all([runCli(args), runCli(args)]);

    expect(results.filter(({ exitCode }) => exitCode === 0)).toHaveLength(1);
    expect(results.filter(({ exitCode }) => exitCode !== 0)).toHaveLength(1);
    await expect(repository.readContext()).resolves.toMatchObject({
      state: { revision: 2, activeWorkItem: { status: "clarifying", revision: 1 } },
    });
    await expect(readAuditEvents(workspacePaths(root).audit)).resolves.toHaveLength(2);
  });

  test("can be imported without executing a command", async () => {
    const result = await execa(process.execPath, [
      "--input-type=module",
      "--eval",
      `await import(${JSON.stringify(pathToFileURL(CLI_PATH).href)})`,
    ], { reject: false, stripFinalNewline: false });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe("");
  });

  test("does not mutate the project root while reading context", async () => {
    const { root } = await initializedWorkspace();
    const before = await stat(workspacePaths(root).state);

    expectJsonSuccess(await runCli(["context", "--root", root, "--json"]));

    const after = await stat(workspacePaths(root).state);
    expect(after.size).toBe(before.size);
    expect(after.mtimeMs).toBe(before.mtimeMs);
  });

  test("escapes Unicode line separators in one-line JSON output", async () => {
    const root = await temporaryProject();
    await new WorkspaceRepository(root).initialize({
      schemaVersion: 1,
      name: "Demo\u2028Project\u2029Name",
      gitTracking: "none",
    });

    const result = await runCli(["context", "--root", root, "--json"]);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).not.toContain("\u2028");
    expect(result.stdout).not.toContain("\u2029");
    expect(JSON.parse(result.stdout)).toMatchObject({ project: { name: "Demo\u2028Project\u2029Name" } });
  });
});
