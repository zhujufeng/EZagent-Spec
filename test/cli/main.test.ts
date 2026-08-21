import { constants, type Stats } from "node:fs";
import { chmod, mkdtemp, readFile, readdir, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { execa } from "execa";
import { afterEach, beforeAll, describe, expect, test } from "vitest";

import { readAuditEvents } from "../../src/audit/events.js";
import type { CodexIntegrationRuntime } from "../../src/adapters/codex/integration.js";
import { WorkspaceRepository } from "../../src/workspace/repository.js";
import { workspacePaths } from "../../src/workspace/layout.js";
import type { WorkItemState } from "../../src/domain/work-item.js";
import { formatCliError, runCli as runCliInProcess, type CliRuntime } from "../../src/cli/main.js";
import { isWellFormedUnicode } from "../../src/text/unicode.js";

const PROJECT_ROOT = resolve(import.meta.dirname, "../..");
const CLI_PATH = join(PROJECT_ROOT, "dist", "src", "cli", "main.js");
const temporaryRoots: string[] = [];

async function temporaryProject(label = "EZagent CLI project with spaces "): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), label));
  temporaryRoots.push(root);
  return root;
}

async function runCli(
  args: readonly string[],
  cwd = PROJECT_ROOT,
  options: { readonly input?: string } = {},
) {
  const command = process.platform === "win32" ? process.execPath : CLI_PATH;
  const commandArgs = process.platform === "win32" ? [CLI_PATH, ...args] : args;
  return execa(command, commandArgs, {
    cwd,
    reject: false,
    stripFinalNewline: false,
    ...options,
  });
}

interface CliResult {
  readonly exitCode?: number;
  readonly stdout: string;
  readonly stderr: string;
}

function expectJsonSuccess(result: CliResult): unknown {
  expect(result.exitCode).toBe(0);
  expect(result.stderr).toBe("");
  expect(result.stdout.endsWith("\n")).toBe(true);
  expect(result.stdout.slice(0, -1)).not.toContain("\n");
  return JSON.parse(result.stdout) as unknown;
}

function expectSingleLineFailure(result: CliResult, message?: string): void {
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
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, {
    recursive: true,
    force: true,
    maxRetries: 5,
    retryDelay: 100,
  })));
});

beforeAll(async () => {
  await execa("npm", ["run", "build"], { cwd: PROJECT_ROOT });
});

describe.sequential("ezagent CLI", () => {
  test("publishes the configured bin with a hashbang and direct-execution permission", async () => {
    const packageJson = JSON.parse(await readFile(join(PROJECT_ROOT, "package.json"), "utf8")) as {
      readonly bin?: Readonly<Record<string, string>>;
    };
    const builtCli = await readFile(CLI_PATH, "utf8");

    expect(packageJson.bin).toEqual({ ezagent: "./dist/src/cli/main.js" });
    expect(builtCli.startsWith("#!/usr/bin/env node\n")).toBe(true);

    if (process.platform !== "win32") {
      expect((await stat(CLI_PATH)).mode & 0o777).toBe(0o755);
      const root = await temporaryProject();
      const result = await execa(CLI_PATH, ["doctor", "--root", root], {
        reject: false,
        stripFinalNewline: false,
      });
      expect(expectJsonSuccess(result)).toMatchObject({ ok: true, root });
    }
  });

  test("passes the catalog gate and audits the runtime-only package", async () => {
    const before = (await readdir(PROJECT_ROOT)).sort();
    const cache = await temporaryProject("EZagent npm cache ");
    const packed = await execa("npm", ["pack", "--dry-run", "--json"], {
      cwd: PROJECT_ROOT,
      env: { npm_config_cache: cache },
    });
    expect(packed.stdout).toContain("catalog valid: 265 experts, 0 provenance errors");
    const jsonStart = packed.stdout.indexOf("[\n");
    expect(jsonStart).toBeGreaterThanOrEqual(0);
    const manifests = JSON.parse(packed.stdout.slice(jsonStart)) as readonly [{
      readonly files: readonly { readonly path: string; readonly mode: number }[];
    }];
    const files = manifests[0].files;
    const paths = files.map(({ path }) => path);
    const cliEntry = files.find(({ path }) => path === "dist/src/cli/main.js");
    const expertsEntry = files.find(({ path }) => path === "catalog/normalized/experts.json");
    const catalogLockEntry = files.find(({ path }) => path === "catalog/normalized/catalog.lock.json");

    expect(cliEntry?.mode).toBe(process.platform === "win32" ? 0o644 : 0o755);
    expect(expertsEntry?.mode).toBe(0o644);
    expect(catalogLockEntry?.mode).toBe(0o644);
    expect(paths).toContain("dist/src/workspace/repository.js");
    expect(paths).toContain("dist/src/domain/state-machine.js");
    expect(paths).toContain("README.md");
    expect(paths).toContain("THIRD_PARTY_NOTICES.md");
    expect(paths).toContain("licenses/agency-agents-MIT.txt");
    expect(paths).toContain("licenses/agency-agents-zh-MIT.txt");
    expect(paths).toContain("dist/src/experts/catalog.js");
    expect(paths).toContain("dist/src/experts/active.js");
    expect(paths).toContain("dist/src/experts/selector.js");
    expect(paths).toContain("dist/src/experts/bounded-read.js");
    expect(paths).toContain("catalog/normalized/experts.json");
    expect(paths).toContain("catalog/normalized/catalog.lock.json");
    expect(paths).not.toContain("dist/src/experts/importer.js");
    expect(paths).not.toContain("dist/src/experts/source-lock.js");
    expect(paths).not.toContain("dist/src/experts/attested-source-contract.js");
    expect(paths.some((path) => path.includes("verify-catalog"))).toBe(false);
    expect(paths.some((path) => path.startsWith("vendor-sources/"))).toBe(false);
    expect(paths).not.toContain("catalog/sources.lock.json");
    expect(paths).not.toContain("catalog/taxonomy.yaml");
    expect(paths).toContain("licenses/UNICODE-LICENSE.txt");
    expect(paths.some((path) => /^(?:src|test|docs|dist\/test)\//u.test(path))).toBe(false);
    expect(paths.some((path) => path.endsWith(".map") || path.endsWith(".d.ts"))).toBe(false);
    expect((await readdir(PROJECT_ROOT)).some((path) => path.endsWith(".tgz"))).toBe(false);
    expect((await readdir(PROJECT_ROOT)).sort()).toEqual(before);
  }, 30_000);

  test("doctor resolves a real directory without creating workspace state", async () => {
    const root = await temporaryProject();
    const result = await runCli(["doctor", "--root", basename(root)], dirname(root));

    const output = expectJsonSuccess(result);
    expect(output).toMatchObject({
      ok: true,
      node: process.version,
    });
    expect(await realpath((output as { root: string }).root)).toBe(await realpath(root));
    expect((await readdir(root)).sort()).toEqual([]);
  });

  test("doctor rejects missing roots and regular files", async () => {
    const root = await temporaryProject();
    const file = join(root, "not-a-directory");
    await writeFile(file, "", "utf8");

    expectSingleLineFailure(await runCli(["doctor", "--root", join(root, "missing")]), "does not exist");
    expectSingleLineFailure(await runCli(["doctor", "--root", file]), "not a directory");
    expect((await readdir(root)).sort()).toEqual(["not-a-directory"]);
  });

  test("doctor checks read, write, and traversal access without writing", async () => {
    const writes: string[] = [];
    let checkedMode: number | undefined;
    const denied = Object.assign(new Error("denied"), { code: "EACCES" });
    const runtime = {
      cwd: () => PROJECT_ROOT,
      nodeVersion: process.version,
      lstat: async () => ({ isDirectory: () => true }),
      access: async (_path: string, mode: number) => {
        checkedMode = mode;
        throw denied;
      },
      createRepository: (root: string) => new WorkspaceRepository(root),
    } as unknown as CliRuntime;

    await expect(runCliInProcess(
      ["doctor", "--root", PROJECT_ROOT],
      { stdout: { write: (contents) => writes.push(contents) } },
      runtime,
    )).rejects.toThrow("not readable, writable, and traversable");
    expect(checkedMode).toBe(constants.R_OK | constants.W_OK | constants.X_OK);
    expect(writes).toEqual([]);
  });

  test("doctor rejects an unwritable directory without creating workspace state on POSIX", async () => {
    if (process.platform === "win32" || process.getuid?.() === 0) return;
    const root = await temporaryProject();
    await chmod(root, 0o500);
    try {
      const result = await runCli(["doctor", "--root", root]);
      expectSingleLineFailure(result, "not readable, writable, and traversable");
      expect((await readdir(root)).sort()).toEqual([]);
    } finally {
      await chmod(root, 0o700);
    }
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
      requirement: null,
      spec: null,
      task: null,
      team: null,
      knowledge: [],
      blockers: [],
      recoveryStatus: "ready",
      platformSyncStatus: "none",
    });
  });

  test("previews, applies, verifies, and completes an expert-team Task through JSON stdin", async () => {
    const root = await temporaryProject();
    expectJsonSuccess(await runCli(["init", "--root", root, "--name", "CLI Team"]));
    const draft = {
      schemaVersion: 1,
      requirement: { title: "用户资料输入校验", summary: "拒绝非法资料更新" },
      spec: {
        goal: "校验用户资料输入",
        scope: ["用户资料更新"],
        nonGoals: ["不改变登录"],
        acceptance: ["非法输入返回错误"],
        verification: ["运行单元测试"],
      },
      task: {
        title: "实现资料校验",
        risk: "standard",
        allowedPaths: ["src/users/**", "test/users/**"],
        deliverables: ["实现与测试"],
        qualityGates: ["测试通过", "独立审查"],
      },
      selection: {
        capabilities: ["production-implementation"],
        domains: ["engineering"],
        projectSignals: ["api"],
        reviewAfter: 6,
      },
    };
    const selection = expectJsonSuccess(await runCli(
      ["team-select-preview", "--root", root],
      PROJECT_ROOT,
      { input: `${JSON.stringify(draft)}\n` },
    )) as { readonly members: readonly { readonly expertId: string; readonly mode: string }[]; readonly selectionFingerprint: string };
    const input = {
      draft,
      selectionFingerprint: selection.selectionFingerprint,
      assignments: selection.members.map((member) => ({
        expertId: member.expertId,
        scope: [member.mode === "review" ? "独立只读审查" : "实现资料校验"],
        deliverables: [member.mode === "review" ? "审查结论" : "实现与测试"],
        qualityGates: [member.mode === "review" ? "不得自审" : "测试通过"],
      })),
    };
    const preview = expectJsonSuccess(await runCli(
      ["plan-preview", "--root", root],
      PROJECT_ROOT,
      { input: `${JSON.stringify(input)}\n` },
    )) as { readonly approvalToken: string };
    const applied = expectJsonSuccess(await runCli(
      ["plan-apply", "--root", root, "--approval-token", preview.approvalToken],
      PROJECT_ROOT,
      { input: `${JSON.stringify(input)}\n` },
    ));
    expect(applied).toMatchObject({ task: { status: "planned" }, platformSyncStatus: "ready" });
    const transitioned = expectJsonSuccess(await runCli([
      "transition", "--root", root,
      "--to", "implementing",
      "--revision", "0",
    ]));
    expect(transitioned).toMatchObject({
      activeWorkItem: { status: "implementing", revision: 1 },
    });
    expectJsonSuccess(await runCli([
      "transition", "--root", root,
      "--to", "verifying",
      "--revision", "1",
    ]));
    const knowledgeInput = {
      schemaVersion: 1,
      title: "用户资料校验完成",
      summary: "资料 API 已拒绝非法输入。",
      decisions: ["统一在 API 边界校验。"],
      constraints: ["不改变登录流程。"],
      verificationEvidence: ["单元测试和独立审查通过。"],
      followUps: [],
    };
    const completed = expectJsonSuccess(await runCli(
      ["transition", "--root", root, "--to", "completed", "--revision", "2"],
      PROJECT_ROOT,
      { input: `${JSON.stringify(knowledgeInput)}\n` },
    ));
    expect(completed).toMatchObject({
      task: { status: "completed", revision: 3 },
      state: { activeWorkItem: null },
      knowledgePath: expect.stringMatching(/^knowledge\/decisions\/SPEC-/u),
    });
    expect(expectJsonSuccess(await runCli(["context", "--root", root, "--json"]))).toMatchObject({
      task: null,
      team: null,
      knowledge: [{ title: "用户资料校验完成", summary: "资料 API 已拒绝非法输入。" }],
    });
    await expect(readAuditEvents(workspacePaths(root).audit)).resolves.toMatchObject([
      { type: "plan-approved" },
      { type: "work-item-transitioned", metadata: {} },
      { type: "work-item-transitioned", metadata: {} },
      { type: "task-completed", metadata: { knowledgePath: expect.stringMatching(/^knowledge\/decisions\/SPEC-/u) } },
    ]);
  }, 30_000);

  test("previews Codex integration as one-line JSON without creating project state", async () => {
    const root = await temporaryProject();

    expect(expectJsonSuccess(await runCli(["integration-preview", "--root", root]))).toEqual({
      paths: [".ezagent/**", "AGENTS.md#EZAGENT", ".codex/agents/ezagent-*.toml"],
      agentsToken: "missing",
    });
    expect((await readdir(root)).sort()).toEqual([]);
  });

  test("uses the injected Codex runtime for integration commands", async () => {
    const writes: string[] = [];
    const virtualRoot = resolve("/virtual", "project");
    const missing = Object.assign(new Error("missing"), { code: "ENOENT" });
    const rootStat = {
      dev: 1,
      ino: 2,
      mode: 0o40700,
      nlink: 1,
      size: 0,
      isDirectory: () => true,
      isFile: () => false,
      isSymbolicLink: () => false,
    } as Stats;
    const observedPaths: string[] = [];
    const codexIntegrationRuntime: CodexIntegrationRuntime = {
      lstat: async (path) => {
        observedPaths.push(path);
        if (path === virtualRoot) return rootStat;
        throw missing;
      },
      open: async () => { throw new Error("unexpected open"); },
      mkdir: async () => { throw new Error("unexpected mkdir"); },
      createRepository: () => { throw new Error("unexpected repository"); },
      randomId: () => { throw new Error("unexpected random id"); },
    };
    const runtime = {
      cwd: () => "/virtual",
      nodeVersion: process.version,
      lstat: async () => rootStat,
      access: async () => undefined,
      createRepository: (root: string) => new WorkspaceRepository(root),
      codexIntegrationRuntime,
    } as unknown as CliRuntime;

    await runCliInProcess(
      ["integration-preview", "--root", "project"],
      { stdout: { write: (contents) => writes.push(contents) } },
      runtime,
    );

    expect(JSON.parse(writes[0]!)).toEqual({
      paths: [".ezagent/**", "AGENTS.md#EZAGENT", ".codex/agents/ezagent-*.toml"],
      agentsToken: "missing",
    });
    expect(observedPaths).toContain(virtualRoot);
    expect(observedPaths).toContain(join(virtualRoot, "AGENTS.md"));
  });

  test("initializes Codex integration from its preview token", async () => {
    const root = await temporaryProject();
    await writeFile(join(root, "AGENTS.md"), "# User rules\n", "utf8");
    const preview = expectJsonSuccess(await runCli(["integration-preview", "--root", root])) as {
      readonly agentsToken: string;
    };

    expect(expectJsonSuccess(await runCli([
      "integration-init", "--root", root, "--name", " Demo ",
      "--agents-token", preview.agentsToken,
    ]))).toEqual({ initialized: true, root });

    const agents = await readFile(join(root, "AGENTS.md"), "utf8");
    expect(agents.startsWith("# User rules\n")).toBe(true);
    expect(agents.match(/EZAGENT:START/gu)).toHaveLength(1);
    expect(expectJsonSuccess(await runCli(["context", "--root", root, "--json"]))).toMatchObject({
      project: { name: "Demo", gitTracking: "none" },
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
    const usage = "usage: ezagent <doctor|init|context|transition|integration-preview|integration-init|team-select-preview|plan-preview|plan-apply|replan-preview|replan-apply|experts-reconcile> [options]\n";
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
      expect((await readdir(root)).sort()).toEqual([]);
    },
  );

  test("blocks Task implementation when no approved materialized expert team exists", async () => {
    const active: WorkItemState = {
      id: "TASK-20260820-001",
      kind: "task",
      status: "planned",
      risk: "high",
      revision: 0,
    };
    const { root, repository } = await initializedWorkspace(active);

    const result = await runCli([
      "transition", "--root", root,
      "--to", "implementing",
      "--revision", "0",
    ]);

    expectSingleLineFailure(result, "inspection-required");
    await expect(repository.readState()).resolves.toMatchObject({ revision: 1, activeWorkItem: active });
    await expect(readAuditEvents(workspacePaths(root).audit)).resolves.toHaveLength(1);
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
    ["removed authorization option", ["--to", "clarifying", "--revision", "0", "--high-risk-authorization", "AUTH-20260820-001"], "unknown option"],
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

  test("removes terminal controls and ANSI injection from child-process errors", async () => {
    const injectedOption = "--unknown\u001b[31m\t\u0085";

    const result = await runCli(["doctor", injectedOption]);

    expectSingleLineFailure(result, "unknown option");
    const body = result.stderr.slice(0, -1);
    expect(body).not.toMatch(/[\u0000-\u001f\u007f-\u009f]/u);
    expect(body).not.toMatch(/\u001b\[[0-?]*[ -/]*[@-~]/u);
  });

  test("formats arbitrary errors as safe well-formed single-line text", () => {
    const formatted = formatCliError(new Error(
      "失败\u0000\t\u001b[31m\u0085\u2028\u2029\u202e\u2066\ud800中文",
    ));

    expect(formatted).toContain("失败");
    expect(formatted).toContain("中文");
    expect(formatted).not.toMatch(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/u);
    expect(formatted).not.toMatch(/\p{Cf}/u);
    expect(isWellFormedUnicode(formatted)).toBe(true);
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
