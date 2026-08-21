import { createHash } from "node:crypto";

import type { Expert } from "../experts/expert.js";
import { selectExperts, type SelectionRequest } from "../experts/selector.js";
import type { PlanRisk } from "./plan-artifacts.js";
import {
  createExpertTeamPlan,
  parseExpertTeamPlan,
  type ExpertTeamPlan,
} from "./team-record.js";

export type ExpertTeamBlocker =
  | "capability-uncovered"
  | "independent-reviewer-missing"
  | "large-team-review-required";

export interface ProposedExpertMember {
  readonly expertId: string;
  readonly mode: "implement" | "review";
  readonly reasons: readonly string[];
}

export interface ExpertTeamProposal {
  readonly members: readonly ProposedExpertMember[];
  readonly uncoveredCapabilities: readonly string[];
  readonly blockers: readonly ExpertTeamBlocker[];
  readonly requiresPlanReview: boolean;
  readonly selectionFingerprint: `sha256:${string}`;
  readonly selectionRequest: Readonly<SelectionRequest> & { readonly risk: PlanRisk };
}

export interface AssignmentDraft {
  readonly expertId: string;
  readonly scope: readonly string[];
  readonly deliverables: readonly string[];
  readonly qualityGates: readonly string[];
}

export interface TeamIdentity {
  readonly teamRevision: number;
  readonly requirementId: string;
  readonly specId: string;
  readonly taskId: string;
  readonly taskRevision: number;
  readonly catalogFingerprint: `sha256:${string}`;
}

export interface TeamDiff {
  readonly added: readonly string[];
  readonly removed: readonly string[];
  readonly changed: readonly string[];
  readonly unchanged: readonly string[];
}

function portableCompare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function digest(value: unknown): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(JSON.stringify(value)).digest("hex")}`;
}

function frozenRequest(request: SelectionRequest): ExpertTeamProposal["selectionRequest"] {
  if (request.risk === "consult") {
    throw new TypeError("consult requests do not create expert teams");
  }
  return Object.freeze({
    capabilities: Object.freeze([...request.capabilities].sort(portableCompare)),
    domains: Object.freeze([...request.domains].sort(portableCompare)),
    projectSignals: Object.freeze([...request.projectSignals].sort(portableCompare)),
    risk: request.risk,
    reviewAfter: request.reviewAfter,
  });
}

function overlapReasons(expert: Expert, request: SelectionRequest): readonly string[] {
  const capabilities = new Set(request.capabilities);
  const domains = new Set(request.domains);
  const signals = new Set(request.projectSignals);
  return Object.freeze([
    "independent-review",
    ...expert.capabilities.filter((value) => capabilities.has(value)).map((value) => `review-capability:${value}`),
    ...expert.domains.filter((value) => domains.has(value)).map((value) => `review-domain:${value}`),
    ...expert.projectSignals.filter((value) => signals.has(value)).map((value) => `review-signal:${value}`),
  ].sort(portableCompare));
}

function reviewerScore(expert: Expert, request: SelectionRequest): number {
  const capabilities = new Set(request.capabilities);
  const domains = new Set(request.domains);
  const signals = new Set(request.projectSignals);
  return expert.capabilities.filter((value) => capabilities.has(value)).length * 6
    + expert.domains.filter((value) => domains.has(value)).length * 4
    + expert.projectSignals.filter((value) => signals.has(value)).length * 2;
}

export function proposeExpertTeam(
  catalog: readonly Expert[],
  request: SelectionRequest,
): ExpertTeamProposal {
  const selectionRequest = frozenRequest(request);
  const implementers = catalog.filter((expert) => expert.preferredTasks.includes("implement"));
  const selected = selectExperts([...implementers], {
    capabilities: [...selectionRequest.capabilities],
    domains: [...selectionRequest.domains],
    projectSignals: [...selectionRequest.projectSignals],
    risk: selectionRequest.risk,
    reviewAfter: selectionRequest.reviewAfter,
  });
  const members: ProposedExpertMember[] = selected.selected.map((item) => Object.freeze({
    expertId: item.expert.id,
    mode: "implement" as const,
    reasons: Object.freeze([...item.reasons].sort(portableCompare)),
  }));

  const implementerIds = new Set(members.map((member) => member.expertId));
  let reviewerMissing = false;
  if (selectionRequest.risk === "standard" || selectionRequest.risk === "high") {
    const reviewer = catalog
      .filter((expert) => expert.preferredTasks.includes("review") && !implementerIds.has(expert.id))
      .map((expert) => ({ expert, score: reviewerScore(expert, selectionRequest) }))
      .filter(({ score }) => score > 0)
      .sort((left, right) => right.score - left.score || portableCompare(left.expert.id, right.expert.id))[0];
    if (reviewer === undefined) {
      reviewerMissing = true;
    } else {
      members.push(Object.freeze({
        expertId: reviewer.expert.id,
        mode: "review",
        reasons: overlapReasons(reviewer.expert, selectionRequest),
      }));
    }
  }

  members.sort((left, right) => portableCompare(left.expertId, right.expertId));
  const requiresPlanReview = members.length > selectionRequest.reviewAfter;
  const blockers: ExpertTeamBlocker[] = [];
  if (selected.uncoveredCapabilities.length > 0) blockers.push("capability-uncovered");
  if (reviewerMissing) blockers.push("independent-reviewer-missing");
  if (requiresPlanReview) blockers.push("large-team-review-required");

  const proposalCore = {
    selectionRequest,
    members,
    uncoveredCapabilities: [...selected.uncoveredCapabilities].sort(portableCompare),
    blockers,
    requiresPlanReview,
    baseSelectionAuditFingerprint: selected.audit.fingerprint,
  };
  return Object.freeze({
    members: Object.freeze(members),
    uncoveredCapabilities: Object.freeze(proposalCore.uncoveredCapabilities),
    blockers: Object.freeze(blockers),
    requiresPlanReview,
    selectionFingerprint: digest(proposalCore),
    selectionRequest,
  });
}

export function finalizeExpertTeam(
  proposal: ExpertTeamProposal,
  assignments: readonly AssignmentDraft[],
  identity: TeamIdentity,
): ExpertTeamPlan {
  if (!Array.isArray(assignments)) throw new TypeError("expert assignments must be an array");
  const assignmentById = new Map<string, AssignmentDraft>();
  for (const assignment of assignments) {
    if (assignmentById.has(assignment.expertId)) {
      throw new TypeError(`duplicate expert assignment: ${assignment.expertId}`);
    }
    assignmentById.set(assignment.expertId, assignment);
  }
  const proposedIds = new Set(proposal.members.map((member) => member.expertId));
  if (assignmentById.size !== proposedIds.size
    || [...assignmentById].some(([expertId]) => !proposedIds.has(expertId))) {
    throw new TypeError("assignments must match the proposed expert team exactly");
  }

  return createExpertTeamPlan({
    schemaVersion: 1,
    ...identity,
    selectionRequest: {
      capabilities: [...proposal.selectionRequest.capabilities],
      domains: [...proposal.selectionRequest.domains],
      projectSignals: [...proposal.selectionRequest.projectSignals],
      risk: proposal.selectionRequest.risk,
      reviewAfter: proposal.selectionRequest.reviewAfter,
    },
    members: proposal.members.map((member) => {
      const assignment = assignmentById.get(member.expertId)!;
      return {
        expertId: member.expertId,
        mode: member.mode,
        reasons: member.reasons,
        scope: assignment.scope,
        deliverables: assignment.deliverables,
        qualityGates: assignment.qualityGates,
      };
    }),
    uncoveredCapabilities: proposal.uncoveredCapabilities,
    requiresPlanReview: proposal.requiresPlanReview,
    selectionFingerprint: proposal.selectionFingerprint,
  });
}

export function diffExpertTeams(
  previous: ExpertTeamPlan,
  next: ExpertTeamPlan,
): TeamDiff {
  const before = parseExpertTeamPlan(previous);
  const after = parseExpertTeamPlan(next);
  const beforeById = new Map(before.members.map((member) => [member.expertId, member]));
  const afterById = new Map(after.members.map((member) => [member.expertId, member]));
  const added: string[] = [];
  const removed: string[] = [];
  const changed: string[] = [];
  const unchanged: string[] = [];

  for (const [expertId, member] of afterById) {
    const old = beforeById.get(expertId);
    if (old === undefined) added.push(expertId);
    else if (JSON.stringify(old) === JSON.stringify(member)) unchanged.push(expertId);
    else changed.push(expertId);
  }
  for (const expertId of beforeById.keys()) {
    if (!afterById.has(expertId)) removed.push(expertId);
  }
  return Object.freeze({
    added: Object.freeze(added.sort(portableCompare)),
    removed: Object.freeze(removed.sort(portableCompare)),
    changed: Object.freeze(changed.sort(portableCompare)),
    unchanged: Object.freeze(unchanged.sort(portableCompare)),
  });
}
