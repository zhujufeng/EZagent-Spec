import { describe, expect, test } from "vitest";

import {
  approvalToken,
  createExpertTeamPlan,
  parseExpertTeamPlan,
  serializeExpertTeamPlan,
  teamHistoryPath,
} from "../../src/workflow/team-record.js";

describe("ExpertTeamPlan record", () => {
  test("round-trips canonically and binds approval to root and workspace revision", () => {
    const team = createExpertTeamPlan({
      schemaVersion: 1,
      teamRevision: 1,
      requirementId: "REQ-20260821-001",
      specId: "SPEC-20260821-001",
      taskId: "TASK-20260821-001",
      taskRevision: 0,
      selectionRequest: {
        capabilities: ["api-design"],
        domains: ["engineering"],
        projectSignals: ["typescript"],
        risk: "standard",
        reviewAfter: 6,
      },
      members: [
        {
          expertId: "ezagent.test.implementer",
          mode: "implement",
          reasons: ["covers:api-design"],
          scope: ["用户资料 API"],
          deliverables: ["实现和测试"],
          qualityGates: ["API 测试通过"],
        },
        {
          expertId: "ezagent.test.reviewer",
          mode: "review",
          reasons: ["independent-review"],
          scope: ["只读审查失败路径"],
          deliverables: ["审查结论"],
          qualityGates: ["不得自审"],
        },
      ],
      uncoveredCapabilities: [],
      requiresPlanReview: false,
      catalogFingerprint: `sha256:${"a".repeat(64)}`,
      selectionFingerprint: `sha256:${"b".repeat(64)}`,
    });
    const parsed = parseExpertTeamPlan(JSON.parse(serializeExpertTeamPlan(team)));
    expect(parseExpertTeamPlan(JSON.parse(serializeExpertTeamPlan(parsed)))).toEqual(parsed);
    expect(approvalToken("/project", 7, parsed)).not.toBe(approvalToken("/project", 8, parsed));
    expect(teamHistoryPath(parsed.taskId, parsed.teamRevision))
      .toBe(`experts/teams/${parsed.taskId}/000001.json`);
  });
});
