import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { afterEach, describe, expect, test } from "vitest";

import {
  cleanupWorkflowTeamFixtures,
  createWorkflowTeamFixture,
} from "../fixtures/workflow-team-fixture.js";

afterEach(cleanupWorkflowTeamFixtures);

describe("ExpertTeamWorkflowService", () => {
  test("keeps both previews read-only and commits Plan/team/active/audit once", async () => {
    const fixture = await createWorkflowTeamFixture();
    const before = await fixture.snapshot();
    const selection = await fixture.service.selectPreview(fixture.draft);
    const preview = await fixture.service.planPreview({
      draft: fixture.draft,
      selectionFingerprint: selection.selectionFingerprint,
      assignments: fixture.assignmentsFor(selection),
    });
    expect(await fixture.snapshot()).toEqual(before);

    const applied = await fixture.service.planApply({
      draft: fixture.draft,
      selectionFingerprint: selection.selectionFingerprint,
      assignments: fixture.assignmentsFor(selection),
      approvalToken: preview.approvalToken,
    });
    expect(applied.task.status).toBe("planned");
    expect(applied.team.members.some((member) => member.mode === "review")).toBe(true);
    expect(await readFile(join(fixture.root, ".ezagent", "experts", "active.yaml"), "utf8"))
      .toContain(applied.task.id);
    expect((await fixture.repository.readState()).revision).toBe(1);
  });

  test("rejects an expired token without any artifact or revision change", async () => {
    const fixture = await createWorkflowTeamFixture();
    const prepared = await fixture.prepareApprovedInput();
    await fixture.bumpWorkspaceRevision();
    const before = await fixture.snapshot();
    await expect(fixture.service.planApply(prepared)).rejects.toThrow("approval token");
    expect(await fixture.snapshot()).toEqual(before);
  });

  test("rejects unknown domain and project signal before applying any artifact", async () => {
    const fixture = await createWorkflowTeamFixture();
    const draft = structuredClone(fixture.draft);
    draft.selection.domains = ["enginnering"];
    draft.selection.projectSignals = ["appi"];
    const selection = await fixture.service.selectPreview(draft);
    const input = {
      draft,
      selectionFingerprint: selection.selectionFingerprint,
      assignments: fixture.assignmentsFor(selection),
    };
    const preview = await fixture.service.planPreview(input);
    expect(preview.vocabularyMismatches).toMatchObject({
      domains: ["enginnering"],
      projectSignals: ["appi"],
    });
    const before = await fixture.snapshot();

    await expect(fixture.service.planApply({
      ...input,
      approvalToken: preview.approvalToken,
    })).rejects.toThrow(/unknown domains.*project signals/iu);
    expect(await fixture.snapshot()).toEqual(before);
  });

  test("requires an explicit accepted decision for a team above the soft threshold", async () => {
    const fixture = await createWorkflowTeamFixture({ capabilityCount: 7, reviewAfter: 6 });
    const selection = await fixture.service.selectPreview(fixture.draft);
    const input = {
      draft: fixture.draft,
      selectionFingerprint: selection.selectionFingerprint,
      assignments: fixture.assignmentsFor(selection),
    };
    const preview = await fixture.service.planPreview(input);
    expect(preview.blockers).toContain("large-team-review-required");
    await expect(fixture.service.planApply({
      ...input,
      approvalToken: preview.approvalToken,
    })).rejects.toThrow("large team");

    const acceptedInput = { ...input, largeTeamDecision: "accepted" as const };
    const acceptedPreview = await fixture.service.planPreview(acceptedInput);
    await expect(fixture.service.planApply({
      ...acceptedInput,
      approvalToken: acceptedPreview.approvalToken,
    })).resolves.toMatchObject({ task: { status: "planned" } });
  });
});
