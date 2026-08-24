import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { afterEach, describe, expect, test } from "vitest";

import {
  cleanupWorkflowTeamFixtures,
  createWorkflowTeamFixture,
} from "../fixtures/workflow-team-fixture.js";
import { genericWorkContractDraft } from "../fixtures/work-contract-fixture.js";

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
  });
});
