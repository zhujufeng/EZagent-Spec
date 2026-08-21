import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import {
  cp,
  lstat,
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rm,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, resolve, sep } from "node:path";

import { parse } from "yaml";
import { afterEach, describe, expect, test } from "vitest";

import { ALLOWED_BUNDLE_IMPORTS } from "../../scripts/build-plugin.js";

const REPOSITORY_ROOT = resolve(import.meta.dirname, "../..");
const SOURCE_PLUGIN_ROOT = join(REPOSITORY_ROOT, "plugins", "ezagent-spec");
const WORKFLOW_PATH = join(REPOSITORY_ROOT, ".github", "workflows", "ci.yml");
const CHECKOUT_ACTION = "actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1";
const SETUP_NODE_ACTION = "actions/setup-node@820762786026740c76f36085b0efc47a31fe5020";
const EXPECTED_PLUGIN_FILES = [
  ".codex-plugin/plugin.json",
  "LICENSE",
  "RUNTIME_DEPENDENCIES.md",
  "THIRD_PARTY_NOTICES.md",
  "catalog/catalog.lock.json",
  "catalog/experts.json",
  "dist/ezagent-cli.mjs",
  "licenses/UNICODE-LICENSE.txt",
  "licenses/agency-agents-MIT.txt",
  "licenses/agency-agents-zh-MIT.txt",
  "licenses/npm/yaml@2.9.0/LICENSE",
  "licenses/npm/zod@4.4.3/LICENSE",
  "skills/ezagent-implement/SKILL.md",
  "skills/ezagent-initialize/SKILL.md",
  "skills/ezagent-review/SKILL.md",
  "skills/ezagent-router/SKILL.md",
  "skills/ezagent-spec/SKILL.md",
] as const;
const MANAGED_PATHS = [
  ".ezagent/**",
  "AGENTS.md#EZAGENT",
  ".codex/agents/ezagent-*.toml",
] as const;
const CRITICAL_LF_PATHS = [
  "plugins/ezagent-spec/dist/ezagent-cli.mjs",
  "plugins/ezagent-spec/catalog/experts.json",
  "plugins/ezagent-spec/skills/ezagent-router/SKILL.md",
  "catalog/normalized/experts.json",
  "THIRD_PARTY_NOTICES.md",
  "licenses/agency-agents-MIT.txt",
] as const;
const temporaryRoots: string[] = [];

interface TreeEntry {
  readonly path: string;
  readonly mode: number;
  readonly sha256: string;
  readonly size: number;
}

interface WorkflowStep {
  readonly name?: string;
  readonly uses?: string;
  readonly run?: string;
  readonly with?: Readonly<Record<string, unknown>>;
  readonly env?: Readonly<Record<string, unknown>>;
}

interface WorkflowJob {
  readonly "runs-on": string;
  readonly "timeout-minutes": number;
  readonly strategy: {
    readonly "fail-fast": boolean;
    readonly matrix: { readonly os: readonly string[] };
  };
  readonly steps: readonly WorkflowStep[];
}

interface WorkflowDocument {
  readonly name: string;
  readonly on: Readonly<Record<string, unknown>>;
  readonly permissions: Readonly<Record<string, string>>;
  readonly concurrency: Readonly<Record<string, unknown>>;
  readonly jobs: Readonly<Record<string, WorkflowJob>>;
}

function compareStable(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

async function temporaryDirectory(prefix: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  temporaryRoots.push(root);
  return root;
}

async function treeSnapshot(root: string): Promise<readonly TreeEntry[]> {
  const entries: TreeEntry[] = [];

  async function visit(directory: string): Promise<void> {
    for (const name of (await readdir(directory)).sort(compareStable)) {
      const path = join(directory, name);
      const metadata = await lstat(path);
      expect(metadata.isSymbolicLink(), `unexpected symlink: ${path}`).toBe(false);
      if (metadata.isDirectory()) {
        await visit(path);
        continue;
      }
      expect(metadata.isFile(), `unexpected non-file: ${path}`).toBe(true);
      const contents = await readFile(path);
      entries.push({
        path: relative(root, path).split(sep).join("/"),
        mode: metadata.mode & 0o777,
        sha256: createHash("sha256").update(contents).digest("hex"),
        size: contents.byteLength,
      });
    }
  }

  await visit(root);
  return entries.sort((left, right) => compareStable(left.path, right.path));
}

function offlineEnvironment(): NodeJS.ProcessEnv {
  const required = new Set([
    "COMSPEC",
    "LANG",
    "LC_ALL",
    "PATHEXT",
    "SYSTEMROOT",
    "TEMP",
    "TMP",
    "TMPDIR",
    "WINDIR",
  ]);
  const environment = Object.fromEntries(
    Object.entries(process.env).filter(([name]) => required.has(name.toUpperCase())),
  );
  environment.PATH = "";
  expect(environment.PATH).toBe("");
  expect(Object.keys(environment)).not.toContainEqual(
    expect.stringMatching(/(?:proxy|npm|git|network)/iu),
  );
  return environment;
}

function localToolEnvironment(): NodeJS.ProcessEnv {
  const environment = offlineEnvironment();
  const pathEntry = Object.entries(process.env).find(([name]) => name.toUpperCase() === "PATH");
  expect(pathEntry?.[1]).toBeTruthy();
  environment.PATH = pathEntry![1];
  return environment;
}

async function runPackagedCli(
  cliPath: string,
  cwd: string,
  args: readonly string[],
  input?: unknown,
): Promise<unknown> {
  const argv = [cliPath, ...args];
  return new Promise((fulfill, reject) => {
    const child = execFile(process.execPath, argv, {
      cwd,
      encoding: "utf8",
      env: offlineEnvironment(),
      maxBuffer: 4 * 1_048_576,
      shell: false,
      windowsHide: true,
    }, (error, stdout, stderr) => {
      if (error !== null) {
        reject(new Error(`packaged CLI failed: ${stderr || error.message}`, { cause: error }));
        return;
      }
      try {
        expect(stderr).toBe("");
        fulfill(JSON.parse(stdout) as unknown);
      } catch (parseError: unknown) {
        reject(parseError);
      }
    });
    child.stdin?.end(input === undefined ? undefined : `${JSON.stringify(input)}\n`);
  });
}

async function runTextCommand(
  command: string,
  cwd: string,
  args: readonly string[],
): Promise<string> {
  return new Promise((fulfill, reject) => {
    execFile(command, [...args], {
      cwd,
      encoding: "utf8",
      env: localToolEnvironment(),
      maxBuffer: 1_048_576,
      shell: false,
      windowsHide: true,
    }, (error, stdout, stderr) => {
      if (error !== null) {
        reject(new Error(`command failed: ${stderr || error.message}`, { cause: error }));
        return;
      }
      expect(stderr).toBe("");
      fulfill(stdout);
    });
  });
}

function count(contents: string, needle: string): number {
  return contents.split(needle).length - 1;
}

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) => rm(root, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 100,
    })),
  );
});

describe.sequential("Codex plugin offline release smoke", () => {
  test("runs only the copied self-contained plugin and preserves repeatable project state", async () => {
    const temporaryRoot = await temporaryDirectory("ezagent-codex-offline-");
    const installedPlugin = join(temporaryRoot, "installed", "ezagent-spec");
    const projectRoot = join(temporaryRoot, "project argv ; $literal spaces");
    await mkdir(resolve(installedPlugin, ".."), { recursive: true });
    await cp(SOURCE_PLUGIN_ROOT, installedPlugin, {
      recursive: true,
      errorOnExist: true,
      force: false,
    });
    await mkdir(projectRoot);

    const pluginTree = await treeSnapshot(installedPlugin);
    expect(pluginTree.map(({ path }) => path)).toEqual(EXPECTED_PLUGIN_FILES);
    if (process.platform !== "win32") {
      expect(pluginTree.filter(({ mode }) => (mode & 0o111) !== 0).map(({ path }) => path)).toEqual([
        "dist/ezagent-cli.mjs",
      ]);
    }

    const pluginManifest = JSON.parse(
      await readFile(join(installedPlugin, ".codex-plugin", "plugin.json"), "utf8"),
    ) as Record<string, unknown>;
    expect(pluginManifest).not.toHaveProperty("hooks");
    expect(pluginManifest).not.toHaveProperty("mcpServers");
    expect(pluginManifest).not.toHaveProperty("apps");

    const allowedImports = new Set<string>(ALLOWED_BUNDLE_IMPORTS);
    expect([...allowedImports].some((specifier) => /(?:child_process|http|https|net|tls|dns)/iu.test(specifier))).toBe(false);
    const bundle = await readFile(join(installedPlugin, "dist", "ezagent-cli.mjs"), "utf8");
    const bundleImports = [
      ...bundle.matchAll(/\b(?:import|export)(?:[^"'`;]*?\bfrom)?\s*["']([^"']+)["']/gu),
      ...bundle.matchAll(/\brequire\s*\(\s*["']([^"']+)["']/gu),
    ].map((match) => match[1]!);
    expect(bundleImports.length).toBeGreaterThan(0);
    expect(bundleImports.every((specifier) => allowedImports.has(specifier))).toBe(true);
    expect(bundle).not.toMatch(
      /process\s*\.\s*(?:getBuiltinModule|binding|_linkedBinding)|\bmodule\s*\.\s*(?:createRequire|_load)|\b(?:eval|Function)\s*\(|\b(?:WebSocket|EventSource)\s*\(|navigator\s*\.\s*sendBeacon/u,
    );
    expect(bundle).not.toMatch(/\bfetch\s*\(|\bgit\s+(?:commit|push)|\b(?:telemetry|sentry|opentelemetry)\b/iu);

    const cliPath = join(installedPlugin, "dist", "ezagent-cli.mjs");
    await expect(runPackagedCli(cliPath, projectRoot, ["doctor", "--root", projectRoot])).resolves.toMatchObject({
      ok: true,
      root: projectRoot,
    });

    const beforePreview = await treeSnapshot(projectRoot);
    const preview = await runPackagedCli(cliPath, projectRoot, [
      "integration-preview",
      "--root",
      projectRoot,
    ]) as { readonly paths: readonly string[]; readonly agentsToken: string };
    expect(preview.paths).toEqual(MANAGED_PATHS);
    expect(preview.agentsToken).toBe("missing");
    expect(await treeSnapshot(projectRoot)).toEqual(beforePreview);

    const initialized = await runPackagedCli(cliPath, projectRoot, [
      "integration-init",
      "--root",
      projectRoot,
      "--name",
      "Demo ; $literal",
      "--agents-token",
      preview.agentsToken,
    ]);
    expect(initialized).toEqual({ initialized: true, root: projectRoot });

    const agents = await readFile(join(projectRoot, "AGENTS.md"), "utf8");
    expect(count(agents, "<!-- EZAGENT:START -->")).toBe(1);
    expect(count(agents, "<!-- EZAGENT:END -->")).toBe(1);
    expect(agents).toContain("$ezagent-router");
    expect(agents).toContain(".ezagent/project.yaml");

    const project = parse(await readFile(join(projectRoot, ".ezagent", "project.yaml"), "utf8")) as Record<string, unknown>;
    expect(project).toEqual({ schemaVersion: 1, name: "Demo ; $literal", gitTracking: "none" });

    const router = await readFile(
      join(installedPlugin, "skills", "ezagent-router", "SKILL.md"),
      "utf8",
    );
    expect(router).toContain(".ezagent/project.yaml");
    expect(router).toContain("dist/ezagent-cli.mjs");
    const routingSection = router.slice(router.indexOf("## 读取与路由"));
    expect(routingSection).toContain("支持 argv 数组");
    expect(routingSection).toContain("禁止拼接 shell 字符串");
    expect(routingSection).toContain('["node", "<absolute-cli-path>", "context", "--root", "<absolute-project-root>", "--json"]');
    expect(routingSection.indexOf('"context"')).toBeLessThan(routingSection.indexOf("consult"));

    const firstContext = await runPackagedCli(cliPath, projectRoot, [
      "context",
      "--root",
      projectRoot,
      "--json",
    ]);
    expect(firstContext).toEqual({
      project: { schemaVersion: 1, name: "Demo ; $literal", gitTracking: "none" },
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
    const afterFirstInitialization = await treeSnapshot(projectRoot);
    const secondPreview = await runPackagedCli(cliPath, projectRoot, [
      "integration-preview",
      "--root",
      projectRoot,
    ]) as { readonly paths: readonly string[]; readonly agentsToken: string };
    expect(secondPreview.paths).toEqual(MANAGED_PATHS);
    expect(await treeSnapshot(projectRoot)).toEqual(afterFirstInitialization);

    await runPackagedCli(cliPath, projectRoot, [
      "integration-init",
      "--root",
      projectRoot,
      "--name",
      "Demo ; $literal",
      "--agents-token",
      secondPreview.agentsToken,
    ]);
    expect(await treeSnapshot(projectRoot)).toEqual(afterFirstInitialization);
    await expect(runPackagedCli(cliPath, projectRoot, [
      "context",
      "--root",
      projectRoot,
      "--json",
    ])).resolves.toEqual(firstContext);

    const draft = {
      schemaVersion: 1,
      requirement: { title: "离线资料校验", summary: "验证复制插件的自动专家闭环" },
      spec: {
        goal: "校验资料 API 输入",
        scope: ["资料更新接口"],
        nonGoals: ["不改变登录"],
        acceptance: ["非法输入返回错误"],
        verification: ["运行 API 测试"],
      },
      task: {
        title: "实现资料校验",
        risk: "standard",
        allowedPaths: ["src/users/**", "test/users/**"],
        deliverables: ["实现和测试"],
        qualityGates: ["API 测试通过", "独立审查"],
      },
      selection: {
        capabilities: ["production-implementation"],
        domains: ["engineering"],
        projectSignals: ["api"],
        reviewAfter: 6,
      },
    };
    const selection = await runPackagedCli(cliPath, projectRoot, [
      "team-select-preview", "--root", projectRoot,
    ], draft) as {
      readonly members: readonly { readonly expertId: string; readonly mode: string }[];
      readonly selectionFingerprint: string;
    };
    expect(selection.members.some(({ mode }) => mode === "implement")).toBe(true);
    expect(selection.members.some(({ mode }) => mode === "review")).toBe(true);
    const planInput = {
      draft,
      selectionFingerprint: selection.selectionFingerprint,
      assignments: selection.members.map((member) => ({
        expertId: member.expertId,
        scope: [member.mode === "review" ? "独立只读审查" : "实现资料校验"],
        deliverables: [member.mode === "review" ? "审查结论" : "实现与测试"],
        qualityGates: [member.mode === "review" ? "不得自审" : "API 测试通过"],
      })),
    };
    const planPreview = await runPackagedCli(cliPath, projectRoot, [
      "plan-preview", "--root", projectRoot,
    ], planInput) as { readonly approvalToken: string };
    const applied = await runPackagedCli(cliPath, projectRoot, [
      "plan-apply", "--root", projectRoot, "--approval-token", planPreview.approvalToken,
    ], planInput) as { readonly platformSyncStatus: string };
    expect(applied.platformSyncStatus).toBe("ready");

    const restored = await runPackagedCli(cliPath, projectRoot, [
      "context", "--root", projectRoot, "--json",
    ]);
    expect(restored).toMatchObject({
      state: { activeWorkItem: { status: "planned" } },
      team: { teamRevision: 1 },
      platformSyncStatus: "ready",
    });
    const beforeReconcile = await treeSnapshot(join(projectRoot, ".codex", "agents"));
    await runPackagedCli(cliPath, projectRoot, ["experts-reconcile", "--root", projectRoot]);
    expect(await treeSnapshot(join(projectRoot, ".codex", "agents"))).toEqual(beforeReconcile);
    await expect(runPackagedCli(cliPath, projectRoot, [
      "context", "--root", projectRoot, "--json",
    ])).resolves.toEqual(restored);

    await runPackagedCli(cliPath, projectRoot, [
      "transition", "--root", projectRoot, "--to", "implementing", "--revision", "0",
    ]);
    await runPackagedCli(cliPath, projectRoot, [
      "transition", "--root", projectRoot, "--to", "verifying", "--revision", "1",
    ]);
    const completed = await runPackagedCli(cliPath, projectRoot, [
      "transition", "--root", projectRoot, "--to", "completed", "--revision", "2",
    ], {
      schemaVersion: 1,
      title: "资料校验完成",
      summary: "复制后的离线插件完成了标准任务。",
      decisions: ["在 API 边界执行结构化校验。"],
      constraints: ["不改变登录流程。"],
      verificationEvidence: ["离线端到端验证通过。"],
      followUps: [],
    }) as { readonly task: { readonly status: string }; readonly knowledgePath: string };
    expect(completed.task.status).toBe("completed");
    expect(completed.knowledgePath).toMatch(/^knowledge\/decisions\/SPEC-/u);
    await expect(runPackagedCli(cliPath, projectRoot, [
      "context", "--root", projectRoot, "--json",
    ])).resolves.toMatchObject({
      state: { activeWorkItem: null },
      task: null,
      team: null,
      knowledge: [{ title: "资料校验完成" }],
    });
  }, 30_000);

  test("defines read-only cross-platform CI and LF checkout contracts structurally", async () => {
    const attributeOutput = await runTextCommand("git", REPOSITORY_ROOT, [
      "check-attr",
      "-z",
      "eol",
      "--",
      ...CRITICAL_LF_PATHS,
    ]);
    const attributeFields = attributeOutput.split("\0");
    expect(attributeFields.pop()).toBe("");
    expect(attributeFields).toHaveLength(CRITICAL_LF_PATHS.length * 3);
    const attributes = Object.fromEntries(
      Array.from({ length: CRITICAL_LF_PATHS.length }, (_unused, index) => {
        const offset = index * 3;
        expect(attributeFields[offset + 1]).toBe("eol");
        return [attributeFields[offset]!, attributeFields[offset + 2]!];
      }),
    );
    expect(attributes).toEqual(Object.fromEntries(CRITICAL_LF_PATHS.map((path) => [path, "lf"])));

    const workflowText = await readFile(WORKFLOW_PATH, "utf8");
    const workflow = parse(workflowText) as WorkflowDocument;
    expect(workflowText).not.toMatch(/\$\{\{\s*secrets\./iu);
    expect(Object.keys(workflow).sort(compareStable)).toEqual([
      "concurrency",
      "jobs",
      "name",
      "on",
      "permissions",
    ]);
    expect(workflow.name).toBe("CI");
    expect(Object.keys(workflow.on).sort(compareStable)).toEqual([
      "pull_request",
      "push",
      "workflow_dispatch",
    ]);
    expect(workflow.permissions).toEqual({ contents: "read" });
    expect(workflow.concurrency).toEqual({
      group: "${{ github.workflow }}-${{ github.ref }}",
      "cancel-in-progress": true,
    });

    expect(Object.keys(workflow.jobs)).toEqual(["verify"]);
    const job = workflow.jobs.verify!;
    expect(Object.keys(job).sort(compareStable)).toEqual([
      "name",
      "runs-on",
      "steps",
      "strategy",
      "timeout-minutes",
    ]);
    expect(job["runs-on"]).toBe("${{ matrix.os }}");
    expect(job["timeout-minutes"]).toBeGreaterThan(0);
    expect(job["timeout-minutes"]).toBeLessThanOrEqual(45);
    expect(job.strategy).toEqual({
      "fail-fast": false,
      matrix: { os: ["macos-latest", "windows-latest"] },
    });

    expect(job.steps.every(({ env }) => env === undefined)).toBe(true);
    expect(job.steps.map(({ uses }) => uses).filter(Boolean)).toEqual([
      CHECKOUT_ACTION,
      SETUP_NODE_ACTION,
    ]);
    expect([CHECKOUT_ACTION, SETUP_NODE_ACTION]).toEqual([
      expect.stringMatching(/^actions\/checkout@[0-9a-f]{40}$/u),
      expect.stringMatching(/^actions\/setup-node@[0-9a-f]{40}$/u),
    ]);
    const checkout = job.steps.find(({ uses }) => uses === CHECKOUT_ACTION);
    expect(checkout?.with).toEqual({ "persist-credentials": false });
    const setupNode = job.steps.find(({ uses }) => uses === SETUP_NODE_ACTION);
    expect(setupNode?.with).toEqual({ "node-version": 22, cache: "npm" });
    expect(job.steps.map(({ run }) => run).filter(Boolean)).toEqual([
      "npm ci",
      "npm run plugin:check",
      "npm run verify",
    ]);
  });

  test("documents the public plugin boundary and verified platforms", async () => {
    const readme = await readFile(join(REPOSITORY_ROOT, "README.md"), "utf8");
    expect(readme).toContain("codex plugin marketplace add zhujufeng/EZagent-Spec --ref v0.1.0");
    expect(readme).toContain("codex plugin add ezagent-spec@ezagent");
    expect(readme).toContain("请帮我安装这个 Codex 插件");
    expect(readme).toContain("Node.js 22+");
    expect(readme).toContain("Router Skill + 项目内受管 `AGENTS.md`");
    expect(readme).toContain("不是 Codex lifecycle Hook");
    expect(readme).toContain("`PreToolUse` interception contract");
    expect(readme).toContain("本地核心的确定性状态转换");
    expect(readme).toContain("初始化一次");
    expect(readme).toContain("自然语言");
    expect(readme).toContain("Local-only");
    expect(readme).toContain("自动专家组队");
    expect(readme).toContain("Plan 和团队只确认一次");
    expect(readme).toContain("团队差异:");
    expect(readme).toContain("结构化 Knowledge");
    expect(readme).toContain("Task Finish");
    expect(readme).toContain("当前版本不支持高风险 Task 实施");
    expect(readme).toContain("关闭失败");
    expect(readme).toContain("MIT License");
    expect(readme).toContain("GitHub Actions 对 Windows 与 macOS");
    expect(readme).not.toContain("ezagent-spec-internal");
    expect(readme).not.toContain("Windows：pending first CI run");

    const roadmap = await readFile(
      join(REPOSITORY_ROOT, "docs", "superpowers", "plans", "2026-08-20-ezagent-spec-mvp-roadmap.md"),
      "utf8",
    );
    expect(roadmap).toContain("plugins/ezagent-spec/");
    expect(roadmap).toContain("Skills + managed AGENTS.md + bundled CLI");
    expect(roadmap).toContain("官方插件 validator + offline activation smoke");
    expect(roadmap).toContain("complete: standard workflow release gate verified");
    expect(roadmap).toContain("team-select-preview → plan-preview → plan-apply → implementing → verifying → Knowledge → completed");
    expect(roadmap).toContain("Knowledge");
    expect(roadmap).toContain("v0.1.0 不提供授权编号入口");
    expect(roadmap).toContain("macOS 与 Windows GitHub Actions");
    expect(roadmap).toContain("公开 marketplace");
    expect(roadmap).not.toContain("Windows：pending first CI run");
    expect(roadmap).not.toContain("hooks/hooks.json");
    expect(roadmap).not.toContain("automatic hooks");
  });
});
