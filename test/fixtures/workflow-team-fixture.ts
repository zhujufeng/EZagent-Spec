import { mkdtemp, readFile, readdir, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ActiveExpertRepository } from "../../src/experts/active.js";
import { parseRuntimeCatalog, type RuntimeCatalog } from "../../src/experts/runtime-catalog.js";
import type { AssignmentDraft, ExpertTeamProposal } from "../../src/workflow/expert-team.js";
import { ExpertTeamWorkflowService } from "../../src/workflow/service.js";
import { WorkspaceRepository } from "../../src/workspace/repository.js";
import { expertFixture } from "./expert-team-fixture.js";

const standardPlanDraft = {
  schemaVersion: 1 as const,
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
    risk: "standard" as const,
    allowedPaths: ["src/users/**", "test/users/**"],
    deliverables: ["实现和回归测试"],
    qualityGates: ["API 测试通过", "独立审查失败路径"],
  },
  selection: {
    capabilities: ["api-design"],
    domains: ["engineering"],
    projectSignals: ["typescript"],
    reviewAfter: 6,
  },
};

const roots: string[] = [];

export interface WorkflowFixtureOptions {
  readonly capabilityCount?: number;
  readonly reviewAfter?: number;
}

async function snapshotDirectory(root: string): Promise<readonly [string, string][]> {
  const entries: [string, string][] = [];
  async function walk(directory: string, prefix: string): Promise<void> {
    let children: Awaited<ReturnType<typeof readdir>>;
    try {
      children = await readdir(directory);
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    for (const name of children.sort()) {
      const relative = prefix === "" ? name : `${prefix}/${name}`;
      const path = join(directory, name);
      try {
        entries.push([relative, await readFile(path, "utf8")]);
      } catch (error: unknown) {
        if ((error as NodeJS.ErrnoException).code === "EISDIR") await walk(path, relative);
        else throw error;
      }
    }
  }
  await walk(join(root, ".ezagent"), "");
  return entries;
}

export async function createWorkflowTeamFixture(options: WorkflowFixtureOptions = {}) {
  const root = await mkdtemp(join(tmpdir(), "ezagent-team-workflow-"));
  roots.push(root);
  const repository = new WorkspaceRepository(root);
  await repository.initialize({ schemaVersion: 1, name: "专家团队测试", gitTracking: "none" });
  const capabilityCount = options.capabilityCount ?? 1;
  const capabilities = Array.from({ length: capabilityCount }, (_, index) => (
    capabilityCount === 1 ? "api-design" : `cap-${index}`
  ));
  const experts = [
    ...capabilities.map((capability, index) => (
      expertFixture(`implementer-${index}`, [capability], ["implement"])
    )),
    expertFixture("reviewer", capabilities, ["review"]),
  ];
  const catalog: RuntimeCatalog = parseRuntimeCatalog(Buffer.from(JSON.stringify({
    schemaVersion: 1,
    experts,
  })));
  const draft = structuredClone({
    ...standardPlanDraft,
    selection: {
      ...standardPlanDraft.selection,
      capabilities,
      reviewAfter: options.reviewAfter ?? standardPlanDraft.selection.reviewAfter,
    },
  });
  const runtime = {
    now: () => new Date("2026-08-21T08:00:00.000Z"),
    canonicalRoot: realpath,
    readCatalog: async () => catalog,
    createRepository: (projectRoot: string) => new WorkspaceRepository(projectRoot),
    readActiveExperts: async (projectRoot: string) => new ActiveExpertRepository(projectRoot).read(),
  };
  const service = new ExpertTeamWorkflowService(root, runtime);

  function assignmentsFor(selection: Pick<ExpertTeamProposal, "members">): AssignmentDraft[] {
    return selection.members.map((member) => ({
      expertId: member.expertId,
      scope: [member.mode === "review" ? "独立审查失败路径" : "实现用户资料校验"],
      deliverables: [member.mode === "review" ? "审查结论" : "实现与测试"],
      qualityGates: [member.mode === "review" ? "不得自审" : "API 测试通过"],
    }));
  }

  return {
    root,
    repository,
    catalog,
    draft,
    service,
    assignmentsFor,
    snapshot: async () => snapshotDirectory(root),
    prepareApprovedInput: async () => {
      const selection = await service.selectPreview(draft);
      const input = {
        draft,
        selectionFingerprint: selection.selectionFingerprint,
        assignments: assignmentsFor(selection),
      };
      const preview = await service.planPreview(input);
      return { ...input, approvalToken: preview.approvalToken };
    },
    bumpWorkspaceRevision: async () => {
      const state = await repository.readState();
      await repository.recordState({ ...state, revision: state.revision + 1 }, state.revision, "fixture-bump");
    },
  };
}

export async function cleanupWorkflowTeamFixtures(): Promise<void> {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
}
