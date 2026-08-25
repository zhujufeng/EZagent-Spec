import { spawn } from "node:child_process";
import { lstat, mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, test } from "vitest";

import { buildPlugin } from "../../scripts/build-plugin.js";
import {
  controlledActionDraft,
  genericEvidenceBundle,
  genericWorkContractDraft,
} from "../fixtures/work-contract-fixture.js";

const temporaryRoots: string[] = [];
let cliPath = "";

interface CliResult {
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

interface AppliedV2 {
  readonly platformSyncStatus: "none" | "ready";
  readonly workItem: { readonly id: string; readonly revision: number };
  readonly workSpec: { readonly id: string };
  readonly specialistPlan: {
    readonly planFingerprint: string;
    readonly delegations: readonly {
      readonly id: string;
      readonly expertId: string;
      readonly mode: "analysis" | "implement" | "review";
    }[];
  };
}

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

async function json<T>(root: string, args: readonly string[], input?: unknown): Promise<T> {
  const result = await invoke(root, args, input);
  expect(result, result.stderr).toMatchObject({ code: 0, stderr: "" });
  return JSON.parse(result.stdout) as T;
}

async function initializedProject(name: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "ezagent-v2-specialist-e2e-"));
  temporaryRoots.push(root);
  const preview = await json<{ readonly agentsToken: string }>(
    root,
    ["integration-preview", "--root", root],
  );
  await json(root, [
    "integration-init", "--root", root, "--name", name, "--agents-token", preview.agentsToken,
  ]);
  return root;
}

async function generatedAgents(root: string): Promise<readonly string[]> {
  try {
    return (await readdir(join(root, ".codex", "agents")))
      .filter((name) => name.startsWith("ezagent-")).sort();
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

async function previewAndApply(root: string, draft: unknown): Promise<AppliedV2> {
  const preview = await json<{ readonly approvalToken: string }>(
    root,
    ["work-preview", "--root", root],
    draft,
  );
  return json<AppliedV2>(
    root,
    ["work-apply", "--root", root, "--approval-token", preview.approvalToken],
    draft,
  );
}

function implementationDraft() {
  return {
    ...genericWorkContractDraft,
    specialistAssessment: {
      decision: "required" as const,
      reasons: ["跨工程与数据平台的实现需要隔离领域上下文"],
      needs: [{
        id: "need-cross-domain-implementation",
        sliceId: "slice-tracer",
        purpose: "implementation" as const,
        capabilities: ["production-implementation"],
        domains: ["engineering", "data-platform"],
        projectSignals: ["typescript"],
        isolationReason: "domain-judgment" as const,
      }],
    },
    workSpec: {
      ...genericWorkContractDraft.workSpec,
      mode: "standard" as const,
    },
  };
}

function mixedReviewDraft() {
  const controlled = controlledActionDraft();
  return {
    ...controlled,
    specialistAssessment: {
      decision: "required" as const,
      reasons: ["实施、独立审查和人工判断必须相互隔离"],
      needs: [
        {
          id: "need-controlled-implementation",
          sliceId: "slice-tracer",
          purpose: "implementation" as const,
          capabilities: ["production-implementation"],
          domains: ["engineering"],
          projectSignals: ["api"],
          isolationReason: "domain-judgment" as const,
        },
        {
          id: "need-controlled-review",
          sliceId: "slice-tracer",
          purpose: "review" as const,
          capabilities: ["production-implementation"],
          domains: ["engineering"],
          projectSignals: ["api"],
          isolationReason: "independent-review" as const,
        },
      ],
    },
    workSpec: {
      ...controlled.workSpec,
      acceptanceCriteria: [{
        ...controlled.workSpec.acceptanceCriteria[0],
        requiredEvidenceKinds: ["comparison" as const, "artifact" as const, "human-approval" as const],
      }],
    },
  };
}

async function completeDelegations(root: string, applied: AppliedV2): Promise<void> {
  for (const delegation of applied.specialistPlan.delegations) {
    await json(root, [
      "delegation-start", "--root", root, "--delegation", delegation.id,
    ]);
    await json(root, [
      "delegation-complete", "--root", root, "--delegation", delegation.id,
    ], {
      schemaVersion: 1,
      expertId: delegation.expertId,
      planFingerprint: applied.specialistPlan.planFingerprint,
      status: "completed",
      summary: "已在批准范围内完成交付与验证。",
      resultHash: `sha256:${"f".repeat(64)}`,
      evidencePointers: [{ kind: "file", locator: "deliverables/alert-analysis.md" }],
    });
  }
}

const decision = {
  schemaVersion: 3,
  title: "v2 Specialist 工作完成",
  summary: "交付、Evidence 和 Delegation receipts 均已验证。",
  decisions: ["采用已验证的分析结果。"],
  constraints: ["不扩大已批准范围。"],
  followUps: [],
};

beforeAll(async () => {
  const pluginRoot = await mkdtemp(join(tmpdir(), "ezagent-v2-specialist-plugin-"));
  temporaryRoots.push(pluginRoot);
  await buildPlugin(pluginRoot);
  cliPath = join(pluginRoot, "dist", "ezagent-cli.mjs");
}, 30_000);

afterAll(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe.sequential("v2 Specialist orchestration packaged workflow", () => {
  test("records an explicit no-Specialist decision without creating project Agents", async () => {
    const root = await initializedProject("无 Specialist 路径");
    const applied = await previewAndApply(root, genericWorkContractDraft);

    expect(applied).toMatchObject({
      platformSyncStatus: "none",
      specialistPlan: { delegations: [], assessment: { decision: "not-needed" } },
    });
    expect(await generatedAgents(root)).toEqual([]);
    const context = await json<{
      readonly specialists: { readonly status: string; readonly delegations: readonly unknown[] };
      readonly platformSyncStatus: string;
    }>(root, ["context", "--root", root, "--json"]);
    expect(context).toMatchObject({
      specialists: { status: "not-needed", delegations: [] },
      platformSyncStatus: "none",
    });
  });

  test("restores implementation Specialists, records receipts, and retires managed Agents on completion", async () => {
    const root = await initializedProject("实施 Specialist 路径");
    const applied = await previewAndApply(root, implementationDraft());
    expect(applied.specialistPlan.delegations.some(({ mode }) => mode === "implement")).toBe(true);
    expect(applied.platformSyncStatus).toBe("ready");
    expect(await generatedAgents(root)).toHaveLength(applied.specialistPlan.delegations.length);

    const firstRestart = await invoke(root, ["context", "--root", root, "--json"]);
    const secondRestart = await invoke(root, ["context", "--root", root, "--json"]);
    expect(firstRestart).toMatchObject({ code: 0, stderr: "" });
    expect(secondRestart.stdout).toBe(firstRestart.stdout);
    expect(JSON.parse(firstRestart.stdout)).toMatchObject({
      specialists: { status: "ready", planFingerprint: applied.specialistPlan.planFingerprint },
      platformSyncStatus: "ready",
    });

    await json(root, ["work-start", "--root", root, "--slice", "slice-tracer"]);
    await completeDelegations(root, applied);
    const reviewed = await json<{
      readonly coverage: { readonly complete: boolean };
      readonly delegationCoverage: { readonly complete: boolean };
    }>(root, ["work-review", "--root", root], genericEvidenceBundle(
      applied.workItem.id,
      applied.workSpec.id,
    ));
    expect(reviewed).toMatchObject({
      coverage: { complete: true },
      delegationCoverage: { complete: true },
    });
    const completed = await json<{ readonly platformSyncStatus: string }>(
      root,
      ["work-complete", "--root", root],
      decision,
    );
    expect(completed.platformSyncStatus).toBe("none");
    expect(await generatedAgents(root)).toEqual([]);
    await expect(readFile(join(
      root,
      ".ezagent",
      "experts",
      "plans",
      applied.workItem.id,
      "000001.json",
    ), "utf8")).resolves.toContain(applied.specialistPlan.planFingerprint);
    const receiptRoots = await readdir(join(root, ".ezagent", "experts", "receipts", applied.workItem.id));
    expect(receiptRoots).toHaveLength(applied.specialistPlan.delegations.length);
  }, 30_000);

  test("uses a distinct reviewer plus human Evidence and retires the mixed-review Agents", async () => {
    const root = await initializedProject("Mixed Review Specialist 路径");
    const applied = await previewAndApply(root, mixedReviewDraft());
    const implementer = applied.specialistPlan.delegations.find(({ mode }) => mode === "implement");
    const reviewer = applied.specialistPlan.delegations.find(({ mode }) => mode === "review");
    expect(implementer).toBeDefined();
    expect(reviewer).toBeDefined();
    expect(reviewer!.expertId).not.toBe(implementer!.expertId);

    await json(root, ["work-start", "--root", root, "--slice", "slice-tracer"]);
    await completeDelegations(root, applied);
    const baseEvidence = genericEvidenceBundle(applied.workItem.id, applied.workSpec.id);
    const evidence = {
      ...baseEvidence,
      entries: [...baseEvidence.entries, {
        id: "evidence-human-approval",
        kind: "human-approval" as const,
        criterionIds: ["criterion-explained"],
        sliceId: "slice-tracer",
        observedAt: "2026-08-24T08:10:00.000Z",
        summary: "内容审查者明确批准匹配 hash 的发布草稿。",
        approvalPointId: "approval-publish",
        contentHash: `sha256:${"b".repeat(64)}`,
        conclusion: "approved" as const,
      }],
    };
    const reviewed = await json<{
      readonly workItem: { readonly status: string };
      readonly delegationCoverage: { readonly complete: boolean };
    }>(root, ["work-review", "--root", root], evidence);
    expect(reviewed).toMatchObject({
      workItem: { status: "verifying" },
      delegationCoverage: { complete: true },
    });
    await json(root, ["work-complete", "--root", root], decision);
    expect(await generatedAgents(root)).toEqual([]);
    await expect(lstat(join(root, ".ezagent", "experts", "receipts", applied.workItem.id)))
      .resolves.toMatchObject({});
  }, 30_000);
});
