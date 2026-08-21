import { describe, expect, test } from "vitest";

import { diffExpertTeams, proposeExpertTeam } from "../../src/workflow/expert-team.js";
import {
  expertFixture,
  nextTeam,
  previousTeam,
  requestFixture,
} from "../fixtures/expert-team-fixture.js";

describe("proposeExpertTeam", () => {
  test("selects the minimum implementer coverage plus an independent standard reviewer", () => {
    const proposal = proposeExpertTeam([
      expertFixture("broad", ["api-design", "validation"], ["implement"]),
      expertFixture("narrow", ["api-design"], ["implement"]),
      expertFixture("reviewer", ["api-design"], ["review"]),
    ], requestFixture({ risk: "standard", capabilities: ["api-design", "validation"] }));

    expect(proposal.members.map(({ expertId, mode }) => [expertId, mode])).toEqual([
      ["ezagent.test.broad", "implement"],
      ["ezagent.test.reviewer", "review"],
    ]);
    expect(proposal.uncoveredCapabilities).toEqual([]);
  });

  test("fails closed when standard work has no independent reviewer", () => {
    const proposal = proposeExpertTeam(
      [expertFixture("only", ["api-design"], ["implement"])],
      requestFixture({ risk: "standard", capabilities: ["api-design"] }),
    );
    expect(proposal.blockers).toContain("independent-reviewer-missing");
  });

  test.each([
    ["light", false],
    ["standard", true],
    ["high", true],
  ] as const)("applies the reviewer policy for %s risk", (risk, expectsReviewer) => {
    const proposal = proposeExpertTeam([
      expertFixture("implementer", ["api-design"], ["implement"]),
      expertFixture("reviewer", ["api-design"], ["review"]),
    ], requestFixture({ risk, capabilities: ["api-design"] }));
    expect(proposal.members.some((member) => member.mode === "review")).toBe(expectsReviewer);
  });

  test("uses reviewAfter only as a soft review threshold", () => {
    const proposal = proposeExpertTeam(
      Array.from({ length: 8 }, (_, index) => (
        expertFixture(`e-${index}`, [`cap-${index}`], ["implement"])
      )),
      requestFixture({
        risk: "light",
        capabilities: Array.from({ length: 8 }, (_, index) => `cap-${index}`),
        reviewAfter: 6,
      }),
    );
    expect(proposal.members).toHaveLength(8);
    expect(proposal.requiresPlanReview).toBe(true);
  });

  test("returns stable added, removed, changed, and unchanged replan members", () => {
    expect(diffExpertTeams(previousTeam(), nextTeam())).toEqual({
      added: ["ezagent.test.security"],
      removed: ["ezagent.test.frontend"],
      changed: ["ezagent.test.backend"],
      unchanged: ["ezagent.test.reviewer"],
    });
  });
});
