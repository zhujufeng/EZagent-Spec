import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { afterEach, describe, expect, test } from "vitest";

import {
  cleanupWorkflowTeamFixtures,
  createWorkflowTeamFixture,
} from "../fixtures/workflow-team-fixture.js";
import {
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
      blockers: [],
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

  test("accepts a Slice only after its typed Evidence covers every criterion", async () => {
    const fixture = await createWorkflowTeamFixture();
    const preview = await fixture.service.workPreview(genericWorkContractDraft);
    const applied = await fixture.service.workApply({
      draft: genericWorkContractDraft,
      approvalToken: preview.approvalToken,
    });

    const reviewed = await fixture.service.workReviewSlice(genericEvidenceBundle(
      applied.workItem.id,
      applied.workSpec.id,
    ));

    expect(reviewed.coverage.complete).toBe(true);
    expect(reviewed.workItem).toMatchObject({
      status: "verifying",
      revision: 1,
      slices: [{ id: "slice-tracer", status: "accepted" }],
    });
    expect(reviewed.evidencePath).toBe(
      `quality/runs/${applied.workItem.id}/slice-tracer/000001.json`,
    );
    expect((await fixture.repository.readState()).activeWorkItem).toMatchObject({
      status: "verifying",
      revision: 1,
    });
  });

  test("returns an incomplete Slice to revise instead of treating partial Evidence as done", async () => {
    const fixture = await createWorkflowTeamFixture();
    const preview = await fixture.service.workPreview(genericWorkContractDraft);
    const applied = await fixture.service.workApply({
      draft: genericWorkContractDraft,
      approvalToken: preview.approvalToken,
    });
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

    const preview = await fixture.service.sideEffectPreview("approval-publish");

    expect(await fixture.snapshot()).toEqual(before);
    expect(preview).toMatchObject({
      action: "发布已审查内容",
      target: "content-platform:brand-channel",
      contentHash: `sha256:${"b".repeat(64)}`,
      workItemId: applied.workItem.id,
    });

    const approved = await fixture.service.sideEffectApply({
      approvalPointId: "approval-publish",
      approvalToken: preview.approvalToken,
    });

    expect(approved).toMatchObject({
      status: "approved",
      externalActionExecuted: false,
      approvalPointId: "approval-publish",
      contentHash: `sha256:${"b".repeat(64)}`,
    });
    await expect(readFile(join(fixture.root, ".ezagent", approved.authorizationPath), "utf8"))
      .resolves.toContain('"externalActionExecuted": false');
  });

  test("rejects a Side Effect token after the workspace changes", async () => {
    const fixture = await createWorkflowTeamFixture();
    const draft = controlledActionDraft();
    const workPreview = await fixture.service.workPreview(draft);
    await fixture.service.workApply({ draft, approvalToken: workPreview.approvalToken });
    const preview = await fixture.service.sideEffectPreview("approval-publish");
    await fixture.bumpWorkspaceRevision();
    const before = await fixture.snapshot();

    await expect(fixture.service.sideEffectApply({
      approvalPointId: "approval-publish",
      approvalToken: preview.approvalToken,
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
      workItem: { status: "completed", revision: 2 },
      decision: { schemaVersion: 3, evidencePaths: [expect.stringContaining("quality/runs/")] },
      decisionPath: `knowledge/decisions/${applied.workSpec.id}.md`,
    });
    expect((await fixture.service.resumeContext()).knowledge).toMatchObject([
      { specId: applied.workSpec.id, title: "业务预警偏差分析完成" },
    ]);
  });
});
