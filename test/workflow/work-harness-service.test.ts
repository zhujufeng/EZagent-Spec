import { readFile, rm } from "node:fs/promises";
import { join } from "node:path";

import { afterEach, describe, expect, test } from "vitest";

import {
  cleanupWorkflowTeamFixtures,
  createWorkflowTeamFixture,
} from "../fixtures/workflow-team-fixture.js";
import {
  CONTROLLED_ACTION_CONTENT_HASH,
  CONTROLLED_ACTION_PAYLOAD,
  controlledActionDraft,
  genericEvidenceBundle,
  genericWorkContractDraft,
} from "../fixtures/work-contract-fixture.js";

afterEach(cleanupWorkflowTeamFixtures);

describe("Agent Work Harness service", () => {
  test("previews and atomically starts a Brief Mode Work Item without selecting experts", async () => {
    const fixture = await createWorkflowTeamFixture();
    const before = await fixture.snapshot();

    const preview = await fixture.service.workPreview(genericWorkContractDraft);

    expect(await fixture.snapshot()).toEqual(before);
    expect(preview.workSpec.workSpec.mode).toBe("brief");
    expect(preview.workItem.slices[0]?.status).toBe("pending");
    expect(preview.specialistPlan).toMatchObject({
      assessment: { decision: "not-needed", needs: [] },
      delegations: [],
      blockers: [],
    });
    expect(preview).not.toHaveProperty("team");

    const applied = await fixture.service.workApply({
      draft: genericWorkContractDraft,
      approvalToken: preview.approvalToken,
    });

    expect(applied.workspaceRevision).toBe(1);
    expect((await fixture.repository.readState()).activeWorkItem).toMatchObject({
      id: applied.workItem.id,
      risk: "brief",
      status: "planned",
    });
    await expect(readFile(
      join(fixture.root, ".ezagent", "requirements", `${applied.brief.id}.yaml`),
      "utf8",
    )).resolves.toContain("schemaVersion: 2");
    await expect(readFile(
      join(fixture.root, ".ezagent", "experts", "plans", applied.workItem.id, "000001.json"),
      "utf8",
    )).resolves.toContain('"decision": "not-needed"');

    const resumed = await fixture.service.resumeContext();
    expect(resumed).toMatchObject({
      recoveryStatus: "ready",
      requirement: { id: applied.brief.id, sourceSchemaVersion: 2 },
      spec: { id: applied.workSpec.id, sourceSchemaVersion: 2, mode: "brief" },
      task: {
        id: applied.workItem.id,
        sourceSchemaVersion: 2,
        slices: [{ id: "slice-tracer", status: "pending" }],
      },
      team: null,
      specialists: { status: "not-needed", delegations: [] },
      blockers: [],
    });
  });

  test("selects, persists, and resumes approved v2 Specialists", async () => {
    const fixture = await createWorkflowTeamFixture();
    const draft = {
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

    const preview = await fixture.service.workPreview(draft);
    expect(preview.specialistPlan).toMatchObject({
      assessment: { decision: "required" },
      blockers: [],
    });
    expect(preview.specialistPlan.delegations.map(({ mode }) => mode).sort())
      .toEqual(["implement", "review"]);

    const applied = await fixture.service.workApply({ draft, approvalToken: preview.approvalToken });
    await expect(readFile(
      join(fixture.root, ".ezagent", "experts", "active.yaml"),
      "utf8",
    )).resolves.toContain("ezagent.test.implementer-0");

    const resumed = await fixture.service.resumeContext();
    expect(resumed.specialists).toMatchObject({
      status: "ready",
      planRevision: 1,
      planFingerprint: applied.specialistPlan.planFingerprint,
    });
    expect(resumed.specialists?.delegations).toHaveLength(2);
  });

  test("persists immutable delegation receipts and keeps review incomplete until all are completed", async () => {
    const fixture = await createWorkflowTeamFixture();
    const draft = {
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
    const preview = await fixture.service.workPreview(draft);
    const applied = await fixture.service.workApply({ draft, approvalToken: preview.approvalToken });
    await fixture.service.workStartSlice("slice-tracer");
    const implementation = applied.specialistPlan.delegations.find(({ mode }) => mode === "implement")!;
    const reviewer = applied.specialistPlan.delegations.find(({ mode }) => mode === "review")!;
    const completion = (expertId: string, dispatchFingerprint: string) => ({
      schemaVersion: 2 as const,
      expertId,
      planFingerprint: applied.specialistPlan.planFingerprint,
      dispatchFingerprint,
      status: "completed" as const,
      summary: "委派范围内的结果与证据已完成。",
      resultHash: `sha256:${"c".repeat(64)}` as const,
      evidencePointers: [{
        kind: "file" as const,
        locator: "src/result.ts",
        contentHash: `sha256:${"c".repeat(64)}` as const,
      }],
    });

    const started = await fixture.service.delegationStart(implementation.id);
    expect(started).toMatchObject({
      delegation: { id: implementation.id, expertId: implementation.expertId },
      receipt: { status: "started", planFingerprint: applied.specialistPlan.planFingerprint },
    });
    await expect(fixture.service.delegationStart(implementation.id)).rejects.toThrow(/already exists/iu);
    await expect(fixture.service.delegationComplete(implementation.id, {
      ...completion(implementation.expertId, started.receipt.dispatchFingerprint),
      expertId: reviewer.expertId,
    })).rejects.toThrow(/expert/iu);
    await expect(fixture.service.delegationComplete(implementation.id, {
      ...completion(implementation.expertId, started.receipt.dispatchFingerprint),
      planFingerprint: `sha256:${"d".repeat(64)}`,
    })).rejects.toThrow(/stale/iu);

    const reviewerStarted = await fixture.service.delegationStart(reviewer.id);
    const completed = await fixture.service.delegationComplete(
      implementation.id,
      completion(implementation.expertId, started.receipt.dispatchFingerprint),
    );
    expect(completed.receipt).toMatchObject({ status: "completed", expertId: implementation.expertId });
    await expect(fixture.service.delegationComplete(
      implementation.id,
      completion(implementation.expertId, started.receipt.dispatchFingerprint),
    )).rejects.toThrow(/already exists/iu);

    const incompleteReview = await fixture.service.workReviewSlice(genericEvidenceBundle(
      applied.workItem.id,
      applied.workSpec.id,
    ));
    expect(incompleteReview.coverage.complete).toBe(true);
    expect(incompleteReview.delegationCoverage).toMatchObject({
      complete: false,
      delegations: expect.arrayContaining([
        expect.objectContaining({ delegationId: implementation.id, status: "completed" }),
        expect.objectContaining({ delegationId: reviewer.id, status: "missing" }),
      ]),
    });
    expect(incompleteReview.workItem.slices[0]?.status).toBe("revise");

    await fixture.service.workStartSlice("slice-tracer");
    await fixture.service.delegationComplete(
      reviewer.id,
      completion(reviewer.expertId, reviewerStarted.receipt.dispatchFingerprint),
    );
    const accepted = await fixture.service.workReviewSlice(genericEvidenceBundle(
      applied.workItem.id,
      applied.workSpec.id,
    ));
    expect(accepted.delegationCoverage.complete).toBe(true);
    expect(accepted.workItem).toMatchObject({
      status: "verifying",
      slices: [{ status: "accepted" }],
    });
    const completedWork = await fixture.service.workComplete({
      schemaVersion: 3,
      title: "委派工作完成",
      summary: "实现与独立审查回执均已验证。",
      decisions: ["保留已验证的分析结论。"],
      constraints: ["不扩大已批准范围。"],
      followUps: [],
    });
    expect(completedWork.state.activeWorkItem).toBeNull();
    await expect(readFile(join(fixture.root, ".ezagent", "experts", "active.yaml"), "utf8"))
      .resolves.toContain("experts: []");
    await expect(readFile(join(fixture.root, ".ezagent", completed.receiptPath), "utf8"))
      .resolves.toContain('"status": "completed"');
  }, 30_000);

  test("rejects a blocked Specialist Plan without mutating the workspace", async () => {
    const fixture = await createWorkflowTeamFixture();
    const draft = {
      ...genericWorkContractDraft,
      specialistAssessment: {
        decision: "required" as const,
        reasons: ["需要不存在的能力"],
        needs: [{
          id: "need-missing",
          sliceId: "slice-tracer",
          purpose: "implementation" as const,
          capabilities: ["quantum-ledger"],
          domains: ["engineering"],
          projectSignals: [],
          isolationReason: "domain-judgment" as const,
        }],
      },
    };
    const before = await fixture.snapshot();
    const preview = await fixture.service.workPreview(draft);

    expect(preview.specialistPlan.blockers).toContain("capability-uncovered:quantum-ledger");
    await expect(fixture.service.workApply({ draft, approvalToken: preview.approvalToken }))
      .rejects.toThrow(/blocker/u);
    expect(await fixture.snapshot()).toEqual(before);
  });

  test("resumes a pre-Specialist v2 Work Item as legacy-unassessed", async () => {
    const fixture = await createWorkflowTeamFixture();
    const preview = await fixture.service.workPreview(genericWorkContractDraft);
    const applied = await fixture.service.workApply({
      draft: genericWorkContractDraft,
      approvalToken: preview.approvalToken,
    });
    await rm(join(fixture.root, ".ezagent", "experts", "plans", applied.workItem.id), {
      recursive: true,
    });

    await expect(fixture.service.resumeContext()).resolves.toMatchObject({
      recoveryStatus: "ready",
      specialists: {
        status: "legacy-unassessed",
        planRevision: null,
        delegations: [],
      },
    });
  });

  test("keeps an active v1 coding Plan on the legacy adapter", async () => {
    const fixture = await createWorkflowTeamFixture();
    await fixture.service.planApply(await fixture.prepareApprovedInput());

    const resumed = await fixture.service.resumeContext();

    expect(resumed.requirement?.sourceSchemaVersion).toBe(1);
    expect(resumed.spec).toMatchObject({ sourceSchemaVersion: 1, mode: null });
    expect(resumed.task).toMatchObject({ sourceSchemaVersion: 1, slices: [] });
    expect(resumed.team).not.toBeNull();
  });

  test("rejects Evidence review until the Slice has been explicitly started", async () => {
    const fixture = await createWorkflowTeamFixture();
    const preview = await fixture.service.workPreview(genericWorkContractDraft);
    const applied = await fixture.service.workApply({
      draft: genericWorkContractDraft,
      approvalToken: preview.approvalToken,
    });

    await expect(fixture.service.workReviewSlice(genericEvidenceBundle(
      applied.workItem.id,
      applied.workSpec.id,
    ))).rejects.toThrow(/executing Slice/u);
    expect((await fixture.repository.readState()).activeWorkItem).toMatchObject({
      status: "planned",
      revision: 0,
    });
  });

  test("accepts a Slice only after its typed Evidence covers every criterion", async () => {
    const fixture = await createWorkflowTeamFixture();
    const preview = await fixture.service.workPreview(genericWorkContractDraft);
    const applied = await fixture.service.workApply({
      draft: genericWorkContractDraft,
      approvalToken: preview.approvalToken,
    });
    await fixture.service.workStartSlice("slice-tracer");

    const reviewed = await fixture.service.workReviewSlice(genericEvidenceBundle(
      applied.workItem.id,
      applied.workSpec.id,
    ));

    expect(reviewed.coverage.complete).toBe(true);
    expect(reviewed.workItem).toMatchObject({
      status: "verifying",
      revision: 2,
      slices: [{ id: "slice-tracer", status: "accepted" }],
    });
    expect(reviewed.evidencePath).toBe(
      `quality/runs/${applied.workItem.id}/slice-tracer/000002.json`,
    );
    expect((await fixture.repository.readState()).activeWorkItem).toMatchObject({
      status: "verifying",
      revision: 2,
    });
  });

  test("starts one unblocked Slice and exposes executing state for session recovery", async () => {
    const fixture = await createWorkflowTeamFixture();
    const preview = await fixture.service.workPreview(genericWorkContractDraft);
    const applied = await fixture.service.workApply({
      draft: genericWorkContractDraft,
      approvalToken: preview.approvalToken,
    });

    const started = await fixture.service.workStartSlice("slice-tracer");

    expect(started).toMatchObject({
      status: "implementing",
      revision: 1,
      slices: [{ id: "slice-tracer", status: "executing" }],
    });
    expect((await fixture.service.resumeContext()).task).toMatchObject({
      status: "implementing",
      slices: [{ status: "executing" }],
    });
    expect(started.id).toBe(applied.workItem.id);
  });

  test("keeps at most one Slice executing at a time", async () => {
    const fixture = await createWorkflowTeamFixture();
    const tracer = genericWorkContractDraft.workSpec.slicePlan[0];
    const draft = {
      ...genericWorkContractDraft,
      workSpec: {
        ...genericWorkContractDraft.workSpec,
        slicePlan: [
          tracer,
          { ...tracer, id: "slice-two", title: "第二个切片", blockedBy: [] },
        ],
      },
    };
    const preview = await fixture.service.workPreview(draft);
    await fixture.service.workApply({ draft, approvalToken: preview.approvalToken });
    await fixture.service.workStartSlice("slice-tracer");

    await expect(fixture.service.workStartSlice("slice-two"))
      .rejects.toThrow(/another Slice is executing/u);
    expect((await fixture.service.resumeContext()).task?.slices).toMatchObject([
      { id: "slice-tracer", status: "executing" },
      { id: "slice-two", status: "pending" },
    ]);
  });

  test("returns an incomplete Slice to revise instead of treating partial Evidence as done", async () => {
    const fixture = await createWorkflowTeamFixture();
    const preview = await fixture.service.workPreview(genericWorkContractDraft);
    const applied = await fixture.service.workApply({
      draft: genericWorkContractDraft,
      approvalToken: preview.approvalToken,
    });
    await fixture.service.workStartSlice("slice-tracer");
    const incomplete = genericEvidenceBundle(applied.workItem.id, applied.workSpec.id);
    incomplete.entries.splice(1, 1);

    const reviewed = await fixture.service.workReviewSlice(incomplete);

    expect(reviewed.coverage).toMatchObject({
      complete: false,
      criteria: [{ missingKinds: ["artifact"], status: "missing" }],
    });
    expect(reviewed.workItem).toMatchObject({
      status: "implementing",
      slices: [{ status: "revise" }],
    });
  });

  test("records a narrow Side Effect approval without executing the external action", async () => {
    const fixture = await createWorkflowTeamFixture();
    const draft = controlledActionDraft();
    const workPreview = await fixture.service.workPreview(draft);
    const applied = await fixture.service.workApply({
      draft,
      approvalToken: workPreview.approvalToken,
    });
    const before = await fixture.snapshot();

    const payload = Buffer.from(CONTROLLED_ACTION_PAYLOAD, "utf8");
    const preview = await fixture.service.sideEffectPreview("approval-publish", payload);

    expect(await fixture.snapshot()).toEqual(before);
    expect(preview).toMatchObject({
      action: "发布已审查内容",
      target: "content-platform:brand-channel",
      contentHash: CONTROLLED_ACTION_CONTENT_HASH,
      workItemId: applied.workItem.id,
    });

    await expect(fixture.service.sideEffectApply({
      approvalPointId: "approval-publish",
      approvalToken: preview.approvalToken,
      payload: Buffer.from("changed after preview", "utf8"),
    })).rejects.toThrow(/payload hash.*Work Spec/iu);
    expect(await fixture.snapshot()).toEqual(before);

    const approved = await fixture.service.sideEffectApply({
      approvalPointId: "approval-publish",
      approvalToken: preview.approvalToken,
      payload,
    });

    expect(approved).toMatchObject({
      status: "approved",
      externalActionExecuted: false,
      approvalPointId: "approval-publish",
      contentHash: CONTROLLED_ACTION_CONTENT_HASH,
    });
    await expect(readFile(join(fixture.root, ".ezagent", approved.authorizationPath), "utf8"))
      .resolves.toContain('"externalActionExecuted": false');
  });

  test("rejects Side Effect approval when Core hashes different payload bytes", async () => {
    const fixture = await createWorkflowTeamFixture();
    const draft = controlledActionDraft();
    const workPreview = await fixture.service.workPreview(draft);
    await fixture.service.workApply({ draft, approvalToken: workPreview.approvalToken });
    const before = await fixture.snapshot();

    await expect(fixture.service.sideEffectPreview("approval-publish"))
      .rejects.toThrow(/payload.*non-empty bytes/iu);
    await expect(fixture.service.sideEffectPreview(
      "approval-publish",
      Buffer.from("different payload", "utf8"),
    )).rejects.toThrow(/payload hash.*Work Spec/iu);
    expect(await fixture.snapshot()).toEqual(before);
  });

  test("rejects a Side Effect token after the workspace changes", async () => {
    const fixture = await createWorkflowTeamFixture();
    const draft = controlledActionDraft();
    const workPreview = await fixture.service.workPreview(draft);
    await fixture.service.workApply({ draft, approvalToken: workPreview.approvalToken });
    const payload = Buffer.from(CONTROLLED_ACTION_PAYLOAD, "utf8");
    const preview = await fixture.service.sideEffectPreview("approval-publish", payload);
    await fixture.bumpWorkspaceRevision();
    const before = await fixture.snapshot();

    await expect(fixture.service.sideEffectApply({
      approvalPointId: "approval-publish",
      approvalToken: preview.approvalToken,
      payload,
    })).rejects.toThrow("approval token");
    expect(await fixture.snapshot()).toEqual(before);
  });

  test("resumes from a bounded Work Journal and rejects sensitive summaries", async () => {
    const fixture = await createWorkflowTeamFixture();
    const preview = await fixture.service.workPreview(genericWorkContractDraft);
    const applied = await fixture.service.workApply({
      draft: genericWorkContractDraft,
      approvalToken: preview.approvalToken,
    });

    const appended = await fixture.service.workJournalAppend({
      schemaVersion: 1,
      workItemId: applied.workItem.id,
      sliceId: "slice-tracer",
      summary: "已复现一个偏差样本。",
      observations: ["当前口径遗漏了一个业务状态。"],
      decisions: ["下一步只验证建议口径，不扩展数据范围。"],
      failedApproaches: ["按全部数据聚合会掩盖单个偏差。"],
      nextStep: "对照当前口径和建议口径。",
      contextPointers: [{
        kind: "dataset",
        locator: "business-alerts:sample",
        purpose: "继续复现",
      }],
    });

    expect(appended).toMatchObject({
      journalPath: `journals/${applied.workItem.id}.jsonl`,
      entry: { sequence: 1, sliceId: "slice-tracer" },
    });
    expect((await fixture.service.resumeContext()).journal).toMatchObject({
      sequence: 1,
      nextStep: "对照当前口径和建议口径。",
    });

    const beforeSensitiveAttempt = await fixture.snapshot();
    await expect(fixture.service.workJournalAppend({
      schemaVersion: 1,
      workItemId: applied.workItem.id,
      sliceId: "slice-tracer",
      summary: "候选人联系方式 somebody@example.com",
      observations: [],
      decisions: [],
      failedApproaches: [],
      nextStep: "继续处理",
      contextPointers: [],
    })).rejects.toThrow(/sensitive/iu);
    expect(await fixture.snapshot()).toEqual(beforeSensitiveAttempt);
  });

  test("completes accepted Slices only after re-reading Evidence and writes a Decision Record", async () => {
    const fixture = await createWorkflowTeamFixture();
    const preview = await fixture.service.workPreview(genericWorkContractDraft);
    const applied = await fixture.service.workApply({
      draft: genericWorkContractDraft,
      approvalToken: preview.approvalToken,
    });
    await fixture.service.workStartSlice("slice-tracer");
    await fixture.service.workReviewSlice(genericEvidenceBundle(
      applied.workItem.id,
      applied.workSpec.id,
    ));

    const completed = await fixture.service.workComplete({
      schemaVersion: 3,
      title: "业务预警偏差分析完成",
      summary: "小样本偏差已复现、解释并形成修正建议。",
      decisions: ["先在已确认范围内使用建议口径。"],
      constraints: ["未批准前不修改外部系统。"],
      followUps: ["由需求提出者决定是否扩大样本范围。"],
    });

    expect(completed).toMatchObject({
      state: { activeWorkItem: null },
      workItem: { status: "completed", revision: 3 },
      decision: { schemaVersion: 3, evidencePaths: [expect.stringContaining("quality/runs/")] },
      decisionPath: `knowledge/decisions/${applied.workSpec.id}.md`,
    });
    expect((await fixture.service.resumeContext()).knowledge).toMatchObject([
      { specId: applied.workSpec.id, title: "业务预警偏差分析完成" },
    ]);
  });
});
