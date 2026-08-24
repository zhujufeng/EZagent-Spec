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

export function genericEvidenceBundle(workItemId: string, workSpecId: string) {
  return {
    schemaVersion: 1 as const,
    workItemId,
    workSpecId,
    workSpecRevision: 0,
    sliceId: "slice-tracer",
    entries: [
      {
        id: "evidence-comparison",
        kind: "comparison" as const,
        criterionIds: ["criterion-explained"],
        sliceId: "slice-tracer",
        observedAt: "2026-08-24T08:00:00.000Z",
        summary: "小样本中的预警结果与实际结果已完成对照。",
        baseline: "当前预警结果",
        candidate: "实际业务结果",
        method: "按同一口径逐条对照",
        differences: ["一个样本的阈值与实际状态不一致"],
        threshold: "所有差异均可定位到明确口径或规则",
        outcome: "passed" as const,
      },
      {
        id: "evidence-artifact",
        kind: "artifact" as const,
        criterionIds: ["criterion-explained"],
        sliceId: "slice-tracer",
        observedAt: "2026-08-24T08:05:00.000Z",
        summary: "偏差分析已按交付接口形成。",
        resource: {
          kind: "document" as const,
          locator: "deliverables/alert-analysis.md",
          purpose: "供结果审查者检查",
        },
        contentHash: `sha256:${"a".repeat(64)}`,
        method: "检查必需章节与事实、推断、建议的分离",
        outcome: "passed" as const,
      },
    ],
  };
}
