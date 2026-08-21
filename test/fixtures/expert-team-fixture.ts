import { readFileSync } from "node:fs";

import { parseExpert, type Expert } from "../../src/experts/expert.js";
import type { SelectionRequest } from "../../src/experts/selector.js";
import {
  createExpertTeamPlan,
  type ExpertTeamMember,
  type ExpertTeamPlan,
} from "../../src/workflow/team-record.js";

const template = JSON.parse(
  readFileSync(new URL("./experts/translated.json", import.meta.url), "utf8"),
) as Record<string, unknown>;

export function expertFixture(
  slug: string,
  capabilities: readonly string[],
  preferredTasks: readonly ("implement" | "review")[],
): Expert {
  return parseExpert({
    ...structuredClone(template),
    id: `ezagent.test.${slug}`,
    nameZh: `测试专家${slug}`,
    capabilities: [...capabilities],
    domains: ["engineering"],
    projectSignals: ["typescript"],
    preferredTasks: [...preferredTasks],
  });
}

export function requestFixture(overrides: Partial<SelectionRequest> = {}): SelectionRequest {
  return {
    capabilities: ["api-design"],
    domains: ["engineering"],
    projectSignals: ["typescript"],
    risk: "standard",
    reviewAfter: 6,
    ...overrides,
  };
}

function member(expertId: string, mode: "implement" | "review", scope: string): ExpertTeamMember {
  return {
    expertId,
    mode,
    reasons: mode === "review" ? ["independent-review"] : ["covers:api-design"],
    scope: [scope],
    deliverables: [mode === "review" ? "审查结论" : "实现"],
    qualityGates: [mode === "review" ? "不得自审" : "测试通过"],
  };
}

function team(revision: number, members: readonly ExpertTeamMember[]): ExpertTeamPlan {
  return createExpertTeamPlan({
    schemaVersion: 1,
    teamRevision: revision,
    requirementId: "REQ-20260821-001",
    specId: "SPEC-20260821-001",
    taskId: "TASK-20260821-001",
    taskRevision: revision - 1,
    selectionRequest: { ...requestFixture({ risk: "standard" }), risk: "standard" },
    members,
    uncoveredCapabilities: [],
    requiresPlanReview: false,
    catalogFingerprint: `sha256:${"a".repeat(64)}`,
    selectionFingerprint: `sha256:${"b".repeat(64)}`,
  });
}

export function previousTeam(): ExpertTeamPlan {
  return team(1, [
    member("ezagent.test.frontend", "implement", "前端"),
    member("ezagent.test.backend", "implement", "后端"),
    member("ezagent.test.reviewer", "review", "独立审查"),
  ]);
}

export function nextTeam(): ExpertTeamPlan {
  return team(2, [
    member("ezagent.test.backend", "implement", "后端与审计"),
    member("ezagent.test.security", "implement", "安全"),
    member("ezagent.test.reviewer", "review", "独立审查"),
  ]);
}
