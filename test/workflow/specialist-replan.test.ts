import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { afterEach, describe, expect, test } from "vitest";

import {
  cleanupWorkflowTeamFixtures,
  createWorkflowTeamFixture,
} from "../fixtures/workflow-team-fixture.js";
import { genericWorkContractDraft } from "../fixtures/work-contract-fixture.js";

afterEach(cleanupWorkflowTeamFixtures);

function requiredDraft() {
  return {
    ...genericWorkContractDraft,
    specialistAssessment: {
      decision: "required" as const,
      reasons: ["实现与审查需要隔离"],
      needs: [
        {
          id: "need-implementation",
          sliceId: "slice-tracer",
          purpose: "implementation" as const,
          capabilities: ["api-design"],
          domains: ["engineering"],
          projectSignals: ["typescript"],
          isolationReason: "domain-judgment" as const,
        },
        {
          id: "need-review",
          sliceId: "slice-tracer",
          purpose: "review" as const,
          capabilities: ["api-design"],
          domains: ["engineering"],
          projectSignals: ["typescript"],
          isolationReason: "independent-review" as const,
        },
      ],
    },
    workSpec: {
      ...genericWorkContractDraft.workSpec,
      reviewPolicy: {
        method: "independent-agent" as const,
        reasons: ["实现结果需要独立审查"],
        reviewAfterSlices: 1,
      },
    },
  };
}

const NOT_NEEDED = {
  decision: "not-needed" as const,
  reasons: ["后续执行不再需要隔离的领域能力"],
  needs: [],
};

describe("Specialist-only replan", () => {
  test("previews and applies an exact canonical delegation diff without changing the Work Contract", async () => {
    const fixture = await createWorkflowTeamFixture();
    const draft = requiredDraft();
    const initialPreview = await fixture.service.workPreview(draft);
    const applied = await fixture.service.workApply({
      draft,
      approvalToken: initialPreview.approvalToken,
    });
    const beforePreview = await fixture.snapshot();

    const preview = await fixture.service.specialistReplanPreview({
      specialistAssessment: NOT_NEEDED,
    });

    expect(await fixture.snapshot()).toEqual(beforePreview);
    expect(preview.workSpec).toEqual(applied.workSpec);
    expect(preview.workItem).toEqual(applied.workItem);
    expect(preview.previousPlan.planFingerprint).toBe(applied.specialistPlan.planFingerprint);
    expect(preview.nextPlan).toMatchObject({
      revision: 2,
      assessment: { decision: "not-needed" },
      delegations: [],
    });
    expect(preview.diff).toEqual({
      added: [],
      removed: applied.specialistPlan.delegations.map(({ id }) => id).sort(),
      changed: [],
      unchanged: [],
    });

    const replanned = await fixture.service.specialistReplanApply({
      specialistAssessment: NOT_NEEDED,
      approvalToken: preview.approvalToken,
    });
    expect(replanned.nextPlan.revision).toBe(2);
    expect(replanned.workspaceRevision).toBe(2);
    await expect(readFile(
      join(fixture.root, ".ezagent", "experts", "plans", applied.workItem.id, "000001.json"),
      "utf8",
    )).resolves.toContain(applied.specialistPlan.planFingerprint);
    await expect(readFile(
      join(fixture.root, ".ezagent", "experts", "plans", applied.workItem.id, "000002.json"),
      "utf8",
    )).resolves.toContain('"decision": "not-needed"');
    await expect(readFile(join(fixture.root, ".ezagent", "experts", "active.yaml"), "utf8"))
      .resolves.toContain("experts: []");
  });

  test("rejects Work Contract fields, stale approval, and an unfinished Delegation", async () => {
    const fixture = await createWorkflowTeamFixture();
    const draft = requiredDraft();
    const initialPreview = await fixture.service.workPreview(draft);
    const applied = await fixture.service.workApply({ draft, approvalToken: initialPreview.approvalToken });

    await expect(fixture.service.specialistReplanPreview({
      specialistAssessment: NOT_NEEDED,
      workSpec: applied.workSpec,
    })).rejects.toThrow(/unsupported/iu);
    const preview = await fixture.service.specialistReplanPreview({ specialistAssessment: NOT_NEEDED });
    await fixture.bumpWorkspaceRevision();
    await expect(fixture.service.specialistReplanApply({
      specialistAssessment: NOT_NEEDED,
      approvalToken: preview.approvalToken,
    })).rejects.toThrow(/approval token/iu);

    const second = await createWorkflowTeamFixture();
    const secondPreview = await second.service.workPreview(draft);
    const secondApplied = await second.service.workApply({
      draft,
      approvalToken: secondPreview.approvalToken,
    });
    await second.service.workStartSlice("slice-tracer");
    await second.service.delegationStart(secondApplied.specialistPlan.delegations[0]!.id);
    await expect(second.service.specialistReplanPreview({ specialistAssessment: NOT_NEEDED }))
      .rejects.toThrow(/unfinished Delegation/u);
  });

  test("cancellation retires active Specialists while preserving plan and receipt history", async () => {
    const fixture = await createWorkflowTeamFixture();
    const draft = requiredDraft();
    const preview = await fixture.service.workPreview(draft);
    const applied = await fixture.service.workApply({ draft, approvalToken: preview.approvalToken });
    const started = await fixture.service.workStartSlice("slice-tracer");
    const receipt = await fixture.service.delegationStart(applied.specialistPlan.delegations[0]!.id);

    await fixture.service.retireTeam(applied.workItem.id, started.revision, "cancelled");

    expect((await fixture.repository.readState()).activeWorkItem).toBeNull();
    await expect(readFile(join(fixture.root, ".ezagent", "experts", "active.yaml"), "utf8"))
      .resolves.toContain("experts: []");
    await expect(readFile(join(fixture.root, ".ezagent", receipt.receiptPath), "utf8"))
      .resolves.toContain('"status": "started"');
    await expect(readFile(
      join(fixture.root, ".ezagent", "experts", "plans", applied.workItem.id, "000001.json"),
      "utf8",
    )).resolves.toContain(applied.specialistPlan.planFingerprint);
  });
});
