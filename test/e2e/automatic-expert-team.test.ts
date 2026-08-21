import { spawn } from "node:child_process";
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { afterAll, beforeAll, describe, expect, test } from "vitest";

import { buildPlugin } from "../../scripts/build-plugin.js";

const REPOSITORY_ROOT = resolve(import.meta.dirname, "../..");
const temporaryRoots: string[] = [];
let cliPath = "";

interface CliResult {
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

interface TeamMember {
  readonly expertId: string;
  readonly mode: "implement" | "review";
}

interface Selection {
  readonly members: readonly TeamMember[];
  readonly selectionFingerprint: string;
}

const standardProfileValidationPlan = () => ({
  schemaVersion: 1,
  requirement: { title: "用户资料输入校验", summary: "拒绝非法资料更新" },
  spec: {
    goal: "校验用户资料 API 输入",
    scope: ["用户资料更新接口"],
    nonGoals: ["不改变登录流程"],
    acceptance: ["非法输入返回结构化错误"],
    verification: ["运行 API 单元测试"],
  },
  task: {
    title: "实现资料校验",
    risk: "standard" as "light" | "standard" | "high",
    allowedPaths: ["src/users/**", "test/users/**"],
    deliverables: ["实现和回归测试"],
    qualityGates: ["API 测试通过", "独立审查失败路径"],
  },
  selection: {
    capabilities: ["production-implementation"],
    domains: ["engineering"],
    projectSignals: ["api"],
    reviewAfter: 6,
  },
});

function offlineEnvironment(): NodeJS.ProcessEnv {
  const allowed = new Set([
    "COMSPEC", "LANG", "LC_ALL", "PATHEXT", "SYSTEMROOT", "TEMP", "TMP", "TMPDIR", "WINDIR",
  ]);
  const environment = Object.fromEntries(
    Object.entries(process.env).filter(([name]) => allowed.has(name.toUpperCase())),
  );
  environment.PATH = "";
  return environment;
}

async function invoke(root: string, args: readonly string[], input?: unknown): Promise<CliResult> {
  return new Promise((fulfill, reject) => {
    const child = spawn(process.execPath, [cliPath, ...args], {
      cwd: root,
      env: offlineEnvironment(),
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => { stdout += chunk; });
    child.stderr.on("data", (chunk: string) => { stderr += chunk; });
    child.once("error", reject);
    child.once("close", (code) => fulfill({ code, stdout, stderr }));
    child.stdin.end(input === undefined ? undefined : `${JSON.stringify(input)}\n`);
  });
}

async function cliJson<T>(
  root: string,
  command: string,
  input?: unknown,
  approvalToken?: string,
): Promise<T> {
  const args = [command, "--root", root];
  if (command === "context") args.push("--json");
  if (approvalToken !== undefined) args.push("--approval-token", approvalToken);
  const result = await invoke(root, args, input);
  expect(result, result.stderr).toMatchObject({ code: 0, stderr: "" });
  return JSON.parse(result.stdout) as T;
}

function assignmentsFor(selection: Selection) {
  return selection.members.map((member) => ({
    expertId: member.expertId,
    scope: [member.mode === "review" ? "独立只读审查失败路径" : "实现用户资料校验"],
    deliverables: [member.mode === "review" ? "审查结论" : "实现与测试"],
    qualityGates: [member.mode === "review" ? "不得自审" : "API 测试通过"],
  }));
}

async function initializedTemporaryProject(name: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "ezagent-team-e2e-"));
  temporaryRoots.push(root);
  const preview = await cliJson<{ readonly agentsToken: string }>(root, "integration-preview");
  const initialized = await invoke(root, [
    "integration-init", "--root", root, "--name", name, "--agents-token", preview.agentsToken,
  ]);
  expect(initialized, initialized.stderr).toMatchObject({ code: 0, stderr: "" });
  return root;
}

beforeAll(async () => {
  const pluginRoot = await mkdtemp(join(tmpdir(), "ezagent-team-plugin-"));
  temporaryRoots.push(pluginRoot);
  await buildPlugin(pluginRoot);
  cliPath = join(pluginRoot, "dist", "ezagent-cli.mjs");
}, 30_000);

afterAll(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe.sequential("automatic expert-team packaged workflow", () => {
  test("selects, approves, materializes, restores, replans, and retires a real expert team", async () => {
    await expect(lstat(join(REPOSITORY_ROOT, ".ezagent"))).rejects.toMatchObject({ code: "ENOENT" });
    const environment = offlineEnvironment();
    expect(environment.PATH).toBe("");
    expect(Object.keys(environment)).not.toContainEqual(
      expect.stringMatching(/(?:proxy|npm|git|network)/iu),
    );

    const root = await initializedTemporaryProject("自动专家闭环");
    await expect(lstat(join(root, ".git"))).rejects.toMatchObject({ code: "ENOENT" });
    const userAgent = join(root, ".codex", "agents", "user-owned.toml");
    await mkdir(resolve(userAgent, ".."), { recursive: true });
    await writeFile(userAgent, "name = \"用户专家\"\n", "utf8");

    const draft = standardProfileValidationPlan();
    const selection = await cliJson<Selection>(root, "team-select-preview", draft);
    expect(selection.members.some((member) => member.mode === "implement")).toBe(true);
    expect(selection.members.some((member) => member.mode === "review")).toBe(true);

    const previewInput = {
      draft,
      selectionFingerprint: selection.selectionFingerprint,
      assignments: assignmentsFor(selection),
    };
    const preview = await cliJson<{ readonly approvalToken: string }>(
      root,
      "plan-preview",
      previewInput,
    );
    const applied = await cliJson<{
      readonly platformSyncStatus: string;
      readonly task: { readonly id: string; readonly revision: number };
      readonly team: { readonly teamFingerprint: string };
    }>(root, "plan-apply", previewInput, preview.approvalToken);
    expect(applied.platformSyncStatus).toBe("ready");
    expect(await readFile(userAgent, "utf8")).toBe("name = \"用户专家\"\n");

    const firstRestart = await invoke(root, ["context", "--root", root, "--json"]);
    const secondRestart = await invoke(root, ["context", "--root", root, "--json"]);
    expect(firstRestart).toMatchObject({ code: 0, stderr: "" });
    expect(secondRestart.stdout).toBe(firstRestart.stdout);
    const restarted = JSON.parse(firstRestart.stdout) as {
      readonly team: { readonly teamFingerprint: string };
      readonly platformSyncStatus: string;
    };
    expect(restarted.team.teamFingerprint).toBe(applied.team.teamFingerprint);
    expect(restarted.platformSyncStatus).toBe("ready");

    const replacement = structuredClone(draft);
    replacement.task.deliverables.push("安全校验实现");
    replacement.task.qualityGates.push("安全路径测试通过");
    replacement.selection.capabilities.push("security-appsec-engineer");
    replacement.selection.domains.push("security");
    replacement.selection.projectSignals.push("security-review");
    const nextSelection = await cliJson<Selection>(root, "team-select-preview", replacement);
    const replanInput = {
      draft: replacement,
      selectionFingerprint: nextSelection.selectionFingerprint,
      assignments: assignmentsFor(nextSelection),
    };
    const replanPreview = await cliJson<{
      readonly approvalToken: string;
      readonly diff: { readonly added: readonly string[]; readonly changed: readonly string[] };
    }>(root, "replan-preview", replanInput);
    expect(replanPreview.diff.added.length + replanPreview.diff.changed.length).toBeGreaterThan(0);
    const replanned = await cliJson<{
      readonly task: { readonly id: string; readonly revision: number };
      readonly diff: { readonly added: readonly string[]; readonly changed: readonly string[] };
      readonly platformSyncStatus: string;
    }>(root, "replan-apply", replanInput, replanPreview.approvalToken);
    expect(replanned.platformSyncStatus).toBe("ready");
    expect(replanned.diff).toEqual(replanPreview.diff);

    const cancelled = await invoke(root, [
      "transition", "--root", root, "--to", "cancelled", "--revision", String(replanned.task.revision),
    ]);
    expect(cancelled, cancelled.stderr).toMatchObject({ code: 0, stderr: "" });
    const retired = await cliJson<{ readonly team: null }>(root, "context");
    expect(retired.team).toBeNull();
    expect(await readdir(join(
      root,
      ".ezagent",
      "experts",
      "teams",
      replanned.task.id,
    ))).toEqual(["000001.json", "000002.json"]);

    const highRoot = await initializedTemporaryProject("高风险授权门");
    const highDraft = structuredClone(standardProfileValidationPlan());
    highDraft.task.risk = "high";
    const highSelection = await cliJson<Selection>(highRoot, "team-select-preview", highDraft);
    const highInput = {
      draft: highDraft,
      selectionFingerprint: highSelection.selectionFingerprint,
      assignments: assignmentsFor(highSelection),
    };
    const highPreview = await cliJson<{ readonly approvalToken: string }>(
      highRoot,
      "plan-preview",
      highInput,
    );
    await cliJson(highRoot, "plan-apply", highInput, highPreview.approvalToken);
    const blocked = await invoke(highRoot, [
      "transition", "--root", highRoot, "--to", "implementing", "--revision", "0",
    ]);
    expect(blocked.code).not.toBe(0);
    expect(blocked.stderr).toMatch(/authorization/iu);
    const highContext = await cliJson<{
      readonly state: { readonly activeWorkItem: { readonly status: string } };
    }>(highRoot, "context");
    expect(highContext.state.activeWorkItem.status).toBe("planned");
    await expect(lstat(join(REPOSITORY_ROOT, ".ezagent"))).rejects.toMatchObject({ code: "ENOENT" });
  }, 30_000);
});
