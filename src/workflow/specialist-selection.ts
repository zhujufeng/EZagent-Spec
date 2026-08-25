import { createHash } from "node:crypto";

import type { RiskLevel } from "../domain/work-item.js";
import type { Expert } from "../experts/expert.js";
import type { RuntimeCatalog } from "../experts/runtime-catalog.js";
import { selectExperts } from "../experts/selector.js";
import {
  createSpecialistPlanV2,
  parseSpecialistAssessmentDraftV2,
  type CapabilityNeedDraftV2,
  type SpecialistAssessmentDraftV2,
  type SpecialistDelegationV2,
  type SpecialistMode,
  type SpecialistPlanV2,
} from "./specialist-plan.js";
import { parseWorkSpecV2, type WorkMode, type WorkSpecV2 } from "./work-contract.js";

export interface SpecialistSelectionInputV2 {
  readonly workItemId: string;
  readonly workSpecId: string;
  readonly workSpecRevision: number;
  readonly planRevision: number;
  readonly workSpec: WorkSpecV2;
  readonly assessment: SpecialistAssessmentDraftV2;
}

function portableCompare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function digest(value: unknown): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(JSON.stringify(value)).digest("hex")}`;
}

function selectionRisk(mode: WorkMode): RiskLevel {
  switch (mode) {
    case "brief": return "light";
    case "standard": return "standard";
    case "controlled": return "high";
  }
}

function preferredForNeed(expert: Expert, need: CapabilityNeedDraftV2): boolean {
  switch (need.purpose) {
    case "implementation": return expert.preferredTasks.includes("implement");
    case "review": return expert.preferredTasks.includes("review");
    case "analysis": return expert.preferredTasks.some((task) => (
      task === "clarify" || task === "design" || task === "verify"
    ));
  }
}

function modeForNeed(need: CapabilityNeedDraftV2): SpecialistMode {
  return need.purpose === "implementation" ? "implement" : need.purpose;
}

function unique(values: readonly string[]): readonly string[] {
  return [...new Set(values)].sort(portableCompare);
}

function delegationId(needId: string, expertId: string): string {
  return `delegation-${digest({ needId, expertId }).slice("sha256:".length, "sha256:".length + 24)}`;
}

function needOrder(left: CapabilityNeedDraftV2, right: CapabilityNeedDraftV2): number {
  const rank = { analysis: 0, implementation: 1, review: 2 } as const;
  return rank[left.purpose] - rank[right.purpose] || portableCompare(left.id, right.id);
}

export function proposeSpecialistPlanV2(
  catalog: RuntimeCatalog,
  input: SpecialistSelectionInputV2,
): SpecialistPlanV2 {
  const workSpec = parseWorkSpecV2(input.workSpec);
  const assessment = parseSpecialistAssessmentDraftV2(input.assessment);
  const delegations: SpecialistDelegationV2[] = [];
  const uncovered = new Set<string>();
  const blockers = new Set<string>();
  const selectionAudits: { readonly needId: string; readonly fingerprint: string }[] = [];
  const assignedBySlice = new Map<string, Set<string>>();
  const slices = new Map(workSpec.slicePlan.map((slice) => [slice.id, slice]));
  const criteria = new Map(workSpec.acceptanceCriteria.map((criterion) => [criterion.id, criterion]));

  for (const need of [...assessment.needs].sort(needOrder)) {
    const slice = slices.get(need.sliceId);
    if (slice === undefined) throw new TypeError(`Capability Need references an unknown Slice: ${need.sliceId}`);
    const assigned = assignedBySlice.get(need.sliceId) ?? new Set<string>();
    const candidates = catalog.experts.filter((expert) => (
      preferredForNeed(expert, need) && (need.purpose !== "review" || !assigned.has(expert.id))
    ));
    const result = selectExperts([...candidates], {
      capabilities: [...need.capabilities],
      domains: [...need.domains],
      projectSignals: [...need.projectSignals],
      risk: selectionRisk(workSpec.mode),
      reviewAfter: 4_096,
    });
    selectionAudits.push({ needId: need.id, fingerprint: result.audit.fingerprint });

    for (const capability of result.uncoveredCapabilities) {
      uncovered.add(capability);
      blockers.add(`capability-uncovered:${capability}`);
    }
    if (need.purpose === "review" && result.selected.length === 0) {
      blockers.add(`independent-reviewer-missing:${need.id}`);
    }

    const evidenceRequirements = unique(slice.criterionIds.flatMap((criterionId) => (
      criteria.get(criterionId)?.requiredEvidenceKinds ?? []
    )));
    for (const selected of result.selected) {
      delegations.push({
        id: delegationId(need.id, selected.expert.id),
        capabilityNeedId: need.id,
        expertId: selected.expert.id,
        workItemId: input.workItemId,
        workSpecId: input.workSpecId,
        workSpecRevision: input.workSpecRevision,
        sliceId: need.sliceId,
        mode: modeForNeed(need),
        reasons: unique([...selected.reasons, `need:${need.id}`]),
        scope: unique([workSpec.outcome, ...workSpec.scope, slice.intendedOutcome]),
        deliverableInterfaceIds: [...slice.deliverableInterfaceIds],
        criterionIds: [...slice.criterionIds],
        evidenceRequirements,
      });
      if (need.purpose !== "review") assigned.add(selected.expert.id);
    }
    assignedBySlice.set(need.sliceId, assigned);
  }

  const selectionFingerprint = digest({
    catalogFingerprint: catalog.fingerprint,
    assessment,
    selectionAudits: selectionAudits.sort((left, right) => portableCompare(left.needId, right.needId)),
    delegations: delegations.map(({ id, capabilityNeedId, expertId, mode }) => ({
      id, capabilityNeedId, expertId, mode,
    })).sort((left, right) => portableCompare(left.id, right.id)),
    uncoveredCapabilities: [...uncovered].sort(portableCompare),
    blockers: [...blockers].sort(portableCompare),
  });

  return createSpecialistPlanV2({
    schemaVersion: 2,
    revision: input.planRevision,
    workItemId: input.workItemId,
    workSpecId: input.workSpecId,
    workSpecRevision: input.workSpecRevision,
    catalogFingerprint: catalog.fingerprint,
    selectionFingerprint,
    assessment,
    delegations,
    uncoveredCapabilities: [...uncovered],
    blockers: [...blockers],
  });
}
