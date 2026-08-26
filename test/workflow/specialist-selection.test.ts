import { describe, expect, test } from "vitest";

import { parseRuntimeCatalog } from "../../src/experts/runtime-catalog.js";
import { parseWorkContractDraft } from "../../src/workflow/work-contract.js";
import { proposeSpecialistPlanV2 } from "../../src/workflow/specialist-selection.js";
import { expertFixture } from "../fixtures/expert-team-fixture.js";
import { genericWorkContractDraft } from "../fixtures/work-contract-fixture.js";

const catalog = parseRuntimeCatalog(Buffer.from(JSON.stringify({
  schemaVersion: 1,
  experts: [
    expertFixture("implementer", ["api-design"], ["implement"]),
    expertFixture("reviewer", ["code-review"], ["review"]),
    expertFixture("self-reviewer", ["api-design", "code-review"], ["implement", "review"]),
  ],
})));

function selectionInput() {
  const contract = parseWorkContractDraft({
    ...genericWorkContractDraft,
    specialistAssessment: {
      decision: "required",
      reasons: ["实现和审查需要隔离"],
      needs: [
        {
          id: "need-implementation",
          sliceId: "slice-tracer",
          purpose: "implementation",
          capabilities: ["api-design"],
          domains: ["engineering"],
          projectSignals: ["typescript"],
          isolationReason: "domain-judgment",
        },
        {
          id: "need-review",
          sliceId: "slice-tracer",
          purpose: "review",
          capabilities: ["code-review"],
          domains: ["engineering"],
          projectSignals: ["typescript"],
          isolationReason: "independent-review",
        },
      ],
    },
    workSpec: {
      ...genericWorkContractDraft.workSpec,
      reviewPolicy: {
        method: "independent-agent",
        reasons: ["实现结果需要独立审查"],
        reviewAfterSlices: 1,
      },
    },
  });
  return {
    workItemId: "TASK-20260825-010",
    workSpecId: "SPEC-20260825-010",
    workSpecRevision: 0,
    planRevision: 1,
    workSpec: contract.workSpec,
    assessment: contract.specialistAssessment,
  } as const;
}

describe("v2 Specialist selection", () => {
  test("selects deterministic Slice-bound implementers and an independent reviewer", () => {
    const first = proposeSpecialistPlanV2(catalog, selectionInput());
    const second = proposeSpecialistPlanV2(catalog, selectionInput());

    expect(second).toEqual(first);
    expect(first.blockers).toEqual([]);
    expect(first.delegations.map(({ mode }) => mode).sort()).toEqual(["implement", "review"]);
    const implementer = first.delegations.find(({ mode }) => mode === "implement")!;
    const reviewer = first.delegations.find(({ mode }) => mode === "review")!;
    expect(reviewer.expertId).not.toBe(implementer.expertId);
    expect(first.selectionFingerprint).toMatch(/^sha256:[0-9a-f]{64}$/u);
    expect(new Set(first.delegations.map(({ id }) => id)).size).toBe(first.delegations.length);
  });

  test("preserves an explicit no-Specialist assessment", () => {
    const contract = parseWorkContractDraft(genericWorkContractDraft);
    const plan = proposeSpecialistPlanV2(catalog, {
      ...selectionInput(),
      workSpec: contract.workSpec,
      assessment: contract.specialistAssessment,
    });

    expect(plan.assessment.decision).toBe("not-needed");
    expect(plan.delegations).toEqual([]);
    expect(plan.blockers).toEqual([]);
  });

  test("reports uncovered capabilities without substituting an unrelated expert", () => {
    const input = selectionInput();
    const plan = proposeSpecialistPlanV2(catalog, {
      ...input,
      assessment: {
        decision: "required",
        reasons: ["需要目录中不存在的专业能力"],
        needs: [{
          id: "need-missing",
          sliceId: "slice-tracer",
          purpose: "implementation",
          capabilities: ["quantum-ledger"],
          domains: ["engineering"],
          projectSignals: [],
          isolationReason: "domain-judgment",
        }],
      },
      workSpec: {
        ...input.workSpec,
        reviewPolicy: { method: "self", reasons: ["测试缺口"], reviewAfterSlices: 1 },
      },
    });

    expect(plan.delegations).toEqual([]);
    expect(plan.uncoveredCapabilities).toEqual(["quantum-ledger"]);
    expect(plan.blockers).toContain("capability-uncovered:quantum-ledger");
  });

  test("blocks unknown domains instead of selecting an unrelated expert", () => {
    const input = selectionInput();
    const plan = proposeSpecialistPlanV2(catalog, {
      ...input,
      assessment: {
        decision: "required",
        reasons: ["需求带有目录无法验证的领域词"],
        needs: [{
          id: "need-unknown-domain",
          sliceId: "slice-tracer",
          purpose: "implementation",
          capabilities: ["api-design"],
          domains: ["refund-domain"],
          projectSignals: [],
          isolationReason: "domain-judgment",
        }],
      },
      workSpec: {
        ...input.workSpec,
        reviewPolicy: { method: "self", reasons: ["测试领域保护"], reviewAfterSlices: 1 },
      },
    });

    expect(plan.delegations).toEqual([]);
    expect(plan.uncoveredCapabilities).toEqual([]);
    expect(plan.blockers).toEqual(["domain-unmatched:refund-domain"]);
  });
});
