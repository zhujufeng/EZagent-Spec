import { describe, expect, test } from "vitest";

import { parseWorkContractDraft } from "../../src/workflow/work-contract.js";

export const genericWorkContractDraft = {
  schemaVersion: 2,
  brief: {
    requestSummary: "分析一个业务预警偏差并给出修正建议",
    intendedOutcome: "用一个小样本解释偏差并形成可审查的建议",
    actors: ["需求提出者", "结果审查者"],
    canonicalTerms: [
      { name: "业务预警", meaning: "按当前规则生成的异常提示" },
    ],
    decisions: ["先用一个小样本验证分析口径"],
    assumptions: [
      { statement: "本轮只读数据", source: "user", confirmed: true },
    ],
    openQuestions: [],
    sourcePointers: [
      { kind: "dataset", locator: "business-alerts:sample", purpose: "复现偏差" },
    ],
  },
  workSpec: {
    mode: "brief",
    outcome: "解释业务预警偏差并给出可验证的修正建议",
    scope: ["分析一个已确认的小样本"],
    nonGoals: ["不修改任何生产规则"],
    deliverableInterfaces: [
      {
        id: "deliverable-analysis",
        kind: "analysis",
        description: "一份可供业务审查的偏差分析",
        requiredSections: ["口径", "异常样本", "原因", "建议"],
        invariants: ["事实、推断和建议分开表达"],
        consumer: "结果审查者",
      },
    ],
    acceptanceCriteria: [
      {
        id: "criterion-explained",
        statement: "至少一个偏差样本可以被复现并解释",
        requiredEvidenceKinds: ["comparison", "artifact"],
      },
    ],
    boundaries: [
      {
        id: "boundary-read-only",
        dimension: "data",
        rule: "只读已确认的数据样本",
        resources: [
          {
            kind: "dataset",
            locator: "business-alerts:sample",
            purpose: "复现偏差",
            access: "read",
          },
        ],
      },
    ],
    approvalPoints: [],
    reviewPolicy: {
      method: "self",
      reasons: ["只读且影响范围有限"],
      reviewAfterSlices: 1,
    },
    slicePlan: [
      {
        id: "slice-tracer",
        title: "复现一个偏差样本",
        intendedOutcome: "证明分析口径和证据路径可用",
        inputPointers: [
          { kind: "dataset", locator: "business-alerts:sample", purpose: "复现偏差" },
        ],
        deliverableInterfaceIds: ["deliverable-analysis"],
        criterionIds: ["criterion-explained"],
        blockedBy: [],
        humanCheckpoint: true,
      },
    ],
  },
} as const;

describe("Work Contract v2", () => {
  test("accepts one domain-neutral tracer slice without a role enum or expert team", () => {
    const contract = parseWorkContractDraft(genericWorkContractDraft);

    expect(contract.workSpec.mode).toBe("brief");
    expect(contract.workSpec.slicePlan[0]?.id).toBe("slice-tracer");
    expect(contract).not.toHaveProperty("role");
    expect(contract).not.toHaveProperty("expertTeam");
    expect(Object.isFrozen(contract.workSpec.slicePlan)).toBe(true);
  });
});
