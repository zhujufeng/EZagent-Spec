import { describe, expect, test } from "vitest";

import {
  parseEvidenceBundle,
  reviewEvidenceCoverage,
} from "../../src/workflow/evidence.js";
import { parseWorkContractDraft } from "../../src/workflow/work-contract.js";
import { genericWorkContractDraft } from "../fixtures/work-contract-fixture.js";

describe("Evidence", () => {
  test("reviews a Slice criterion using non-command Evidence", () => {
    const contract = parseWorkContractDraft(genericWorkContractDraft);
    const bundle = parseEvidenceBundle({
      schemaVersion: 1,
      workItemId: "TASK-20260824-001",
      workSpecId: "SPEC-20260824-001",
      workSpecRevision: 0,
      sliceId: "slice-tracer",
      entries: [
        {
          id: "evidence-comparison",
          kind: "comparison",
          criterionIds: ["criterion-explained"],
          sliceId: "slice-tracer",
          observedAt: "2026-08-24T08:00:00.000Z",
          summary: "小样本中的预警结果与实际结果已完成对照。",
          baseline: "当前预警结果",
          candidate: "实际业务结果",
          method: "按同一口径逐条对照",
          differences: ["一个样本的阈值与实际状态不一致"],
          threshold: "所有差异均可定位到明确口径或规则",
          outcome: "passed",
        },
        {
          id: "evidence-artifact",
          kind: "artifact",
          criterionIds: ["criterion-explained"],
          sliceId: "slice-tracer",
          observedAt: "2026-08-24T08:05:00.000Z",
          summary: "偏差分析已按交付接口形成。",
          resource: {
            kind: "document",
            locator: "deliverables/alert-analysis.md",
            purpose: "供结果审查者检查",
          },
          contentHash: `sha256:${"a".repeat(64)}`,
          method: "检查必需章节与事实、推断、建议的分离",
          outcome: "passed",
        },
      ],
    });

    expect(reviewEvidenceCoverage(contract.workSpec, bundle)).toEqual({
      complete: true,
      criteria: [{
        criterionId: "criterion-explained",
        requiredKinds: ["artifact", "comparison"],
        observedKinds: ["artifact", "comparison"],
        missingKinds: [],
        status: "covered",
      }],
    });
  });
});
