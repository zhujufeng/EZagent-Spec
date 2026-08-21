import { describe, expect, test } from "vitest";

import { parsePlanDraft } from "../../src/workflow/plan-artifacts.js";

export const standardPlanDraft = {
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
    risk: "standard",
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
} as const;

describe("Plan draft", () => {
  test("accepts bounded structured content without raw prompt fields", () => {
    expect(parsePlanDraft(standardPlanDraft).task.risk).toBe("standard");
  });

  test("rejects raw prompts, unknown keys, empty gates, and unsafe paths", () => {
    expect(() => parsePlanDraft({ ...standardPlanDraft, rawPrompt: "full chat" })).toThrow();
    expect(() => parsePlanDraft({
      ...standardPlanDraft,
      task: { ...standardPlanDraft.task, qualityGates: [] },
    })).toThrow();
    expect(() => parsePlanDraft({
      ...standardPlanDraft,
      task: { ...standardPlanDraft.task, allowedPaths: ["../outside"] },
    })).toThrow();
  });
});
