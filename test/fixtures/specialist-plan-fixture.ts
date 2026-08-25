import type { SpecialistPlanV2Input } from "../../src/workflow/specialist-plan.js";

export const requiredSpecialistPlanInput: SpecialistPlanV2Input = {
  schemaVersion: 2,
  revision: 1,
  workItemId: "TASK-20260825-001",
  workSpecId: "SPEC-20260825-001",
  workSpecRevision: 0,
  catalogFingerprint: `sha256:${"a".repeat(64)}`,
  selectionFingerprint: `sha256:${"b".repeat(64)}`,
  assessment: {
    decision: "required",
    reasons: ["实现与独立审查需要隔离上下文"],
    needs: [
      {
        id: "need-implementation",
        sliceId: "slice-tracer",
        purpose: "implementation",
        capabilities: ["frontend-development"],
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
  delegations: [
    {
      id: "delegation-implementation",
      capabilityNeedId: "need-implementation",
      expertId: "ezagent.engineering.frontend-developer",
      workItemId: "TASK-20260825-001",
      workSpecId: "SPEC-20260825-001",
      workSpecRevision: 0,
      sliceId: "slice-tracer",
      mode: "implement",
      reasons: ["covers:frontend-development"],
      scope: ["只实现 tracer Slice 的前端交付接口"],
      deliverableInterfaceIds: ["deliverable-analysis"],
      criterionIds: ["criterion-explained"],
      evidenceRequirements: ["artifact"],
    },
    {
      id: "delegation-review",
      capabilityNeedId: "need-review",
      expertId: "ezagent.engineering.code-reviewer",
      workItemId: "TASK-20260825-001",
      workSpecId: "SPEC-20260825-001",
      workSpecRevision: 0,
      sliceId: "slice-tracer",
      mode: "review",
      reasons: ["independent-review"],
      scope: ["只读审查 tracer Slice 的交付结果"],
      deliverableInterfaceIds: ["deliverable-analysis"],
      criterionIds: ["criterion-explained"],
      evidenceRequirements: ["comparison"],
    },
  ],
  uncoveredCapabilities: [],
  blockers: [],
};

export const notNeededSpecialistPlanInput: SpecialistPlanV2Input = {
  schemaVersion: 2,
  revision: 1,
  workItemId: "TASK-20260825-002",
  workSpecId: "SPEC-20260825-002",
  workSpecRevision: 0,
  catalogFingerprint: `sha256:${"c".repeat(64)}`,
  selectionFingerprint: `sha256:${"d".repeat(64)}`,
  assessment: {
    decision: "not-needed",
    reasons: ["单一只读 Slice 不需要额外领域能力或上下文隔离"],
    needs: [],
  },
  delegations: [],
  uncoveredCapabilities: [],
  blockers: [],
};

export const specialistDelegationFixture = requiredSpecialistPlanInput.delegations[0]!;
