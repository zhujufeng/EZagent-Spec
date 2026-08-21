import { afterEach, describe, expect, test } from "vitest";

import {
  inspectCodexExpertTeam,
  reconcileCodexExpertTeam,
} from "../../src/adapters/codex/expert-team.js";
import {
  cleanupWorkflowTeamFixtures,
  createAppliedWorkflowTeamFixture,
} from "../fixtures/workflow-team-fixture.js";

afterEach(cleanupWorkflowTeamFixtures);

describe("Codex expert-team adapter", () => {
  test("renders every approved member and reports ready after reconciliation", async () => {
    const fixture = await createAppliedWorkflowTeamFixture();
    expect((await inspectCodexExpertTeam(fixture.root, fixture.catalog)).status).toBe("pending");
    const result = await reconcileCodexExpertTeam(fixture.root, fixture.catalog);
    expect(result.files.length).toBe(fixture.team.members.length);
    expect((await inspectCodexExpertTeam(fixture.root, fixture.catalog)).status).toBe("ready");
  });

  test("never overwrites a user-owned agent and returns inspection-required on managed drift", async () => {
    const fixture = await createAppliedWorkflowTeamFixture();
    await fixture.writeUserAgent("keep.toml", "user content\n");
    await reconcileCodexExpertTeam(fixture.root, fixture.catalog);
    expect(await fixture.readUserAgent("keep.toml")).toBe("user content\n");
    await fixture.modifyFirstManagedAgent();
    await expect(reconcileCodexExpertTeam(fixture.root, fixture.catalog)).rejects.toMatchObject({
      code: "INSPECTION_REQUIRED",
    });
  });
});
