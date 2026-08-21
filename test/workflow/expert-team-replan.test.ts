import { afterEach, describe, expect, test } from "vitest";

import {
  cleanupWorkflowTeamFixtures,
  createAppliedWorkflowTeamFixture,
} from "../fixtures/workflow-team-fixture.js";

afterEach(cleanupWorkflowTeamFixtures);

describe("expert-team replan and retirement", () => {
  test("previews a stable diff and writes a new immutable team revision", async () => {
    const fixture = await createAppliedWorkflowTeamFixture();
    const preview = await fixture.service.replanPreview(fixture.expandedDraft());
    expect(preview.diff.added.length).toBeGreaterThan(0);
    expect(preview.nextTeam.teamRevision).toBe(2);
    const applied = await fixture.service.replanApply({
      ...fixture.expandedDraft(),
      approvalToken: preview.approvalToken,
    });
    expect(applied.team.teamRevision).toBe(2);
    expect(await fixture.teamHistoryRevisions()).toEqual(["000001.json", "000002.json"]);
  });

  test("a fresh service restores the approved team and cancellation retires only this Task", async () => {
    const fixture = await createAppliedWorkflowTeamFixture();
    expect((await fixture.freshService().resumeContext()).team?.teamRevision).toBe(1);
    await fixture.service.retireTeam(fixture.taskId, fixture.taskRevision, "cancelled");
    expect((await fixture.freshService().resumeContext()).team).toBeNull();
    expect(await fixture.teamHistoryRevisions()).toEqual(["000001.json"]);
  });
});
