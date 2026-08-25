import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";

import { afterEach, describe, expect, test } from "vitest";

import {
  inspectCodexExpertTeam,
  reconcileCodexExpertTeam,
} from "../../src/adapters/codex/expert-team.js";
import {
  cleanupWorkflowTeamFixtures,
  createAppliedWorkflowTeamFixture,
  createWorkflowTeamFixture,
} from "../fixtures/workflow-team-fixture.js";
import { genericWorkContractDraft } from "../fixtures/work-contract-fixture.js";

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

  test("materializes approved v2 Slice delegations with their complete contract", async () => {
    const fixture = await createWorkflowTeamFixture();
    const draft = {
      ...genericWorkContractDraft,
      specialistAssessment: {
        decision: "required" as const,
        reasons: ["实现和审查需要隔离"],
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
    await fixture.service.workApply({ draft, approvalToken: preview.approvalToken });

    expect((await inspectCodexExpertTeam(fixture.root, fixture.catalog)).status).toBe("pending");
    const result = await reconcileCodexExpertTeam(fixture.root, fixture.catalog);
    expect(result.files).toHaveLength(2);
    expect((await inspectCodexExpertTeam(fixture.root, fixture.catalog)).status).toBe("ready");

    const generated = (await readdir(join(fixture.root, ".codex", "agents")))
      .filter((name) => name.startsWith("ezagent-"));
    const contents = await Promise.all(generated.map((name) => (
      readFile(join(fixture.root, ".codex", "agents", name), "utf8")
    )));
    expect(contents.join("\n")).toContain(preview.workSpec.id);
    expect(contents.join("\n")).toContain("slice-tracer");
    expect(contents.join("\n")).toContain("Delegation IDs");
    expect(contents.join("\n")).toContain("Evidence requirements");

    const replanInput = {
      specialistAssessment: {
        decision: "not-needed" as const,
        reasons: ["后续执行不再需要隔离的领域能力"],
        needs: [],
      },
    };
    const replan = await fixture.service.specialistReplanPreview(replanInput);
    await fixture.service.specialistReplanApply({
      ...replanInput,
      approvalToken: replan.approvalToken,
    });
    await reconcileCodexExpertTeam(fixture.root, fixture.catalog);
    expect((await readdir(join(fixture.root, ".codex", "agents")))
      .filter((name) => name.startsWith("ezagent-"))).toEqual([]);
  });
});
