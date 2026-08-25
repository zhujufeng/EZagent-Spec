import { join } from "node:path";

import type { RuntimeCatalog } from "../../experts/runtime-catalog.js";
import { ExpertTeamWorkflowService } from "../../workflow/service.js";
import {
  inspectProjectAgents,
  nodeProjectAgentRuntime,
  ProjectAgentInspectionRequiredError,
  renderProjectAgent,
  syncProjectAgents,
  type ProjectAgentReadiness,
  type ProjectAgentRuntime,
  type RenderedProjectAgent,
} from "./project-agent.js";

export type CodexExpertTeamReadiness = ProjectAgentReadiness | { readonly status: "none" };

async function renderedApprovedTeam(
  projectRoot: string,
  catalog: RuntimeCatalog,
  runtime: ProjectAgentRuntime,
): Promise<readonly RenderedProjectAgent[] | null> {
  const workflow = new ExpertTeamWorkflowService(projectRoot);
  const active = await runtime.readActiveExperts(projectRoot);
  const activeById = new Map(active.experts.map((expert) => [expert.id, expert]));
  const specialistPlan = await workflow.activeSpecialistPlanRecord();
  if (specialistPlan !== null) {
    if (specialistPlan.catalogFingerprint !== catalog.fingerprint) {
      throw new Error("approved Specialist Plan catalog fingerprint mismatch");
    }
    if (specialistPlan.delegations.length === 0) return Object.freeze([]);
    const byExpert = new Map<string, typeof specialistPlan.delegations[number][]>();
    for (const delegation of specialistPlan.delegations) {
      const assigned = byExpert.get(delegation.expertId) ?? [];
      assigned.push(delegation);
      byExpert.set(delegation.expertId, assigned);
    }
    return Object.freeze([...byExpert.entries()].sort(([left], [right]) => (
      left < right ? -1 : left > right ? 1 : 0
    )).map(([expertId, delegations]) => {
      const expert = catalog.byId.get(expertId);
      if (expert === undefined) throw new Error(`approved Specialist is absent from catalog: ${expertId}`);
      const activeExpert = activeById.get(expertId);
      if (activeExpert === undefined || !activeExpert.taskIds.includes(specialistPlan.workItemId)) {
        throw new Error(`approved Specialist is absent from active projection: ${expertId}`);
      }
      const modes = new Set(delegations.map(({ mode }) => mode));
      const mode = modes.has("implement") ? "implement" : modes.has("analysis") ? "analysis" : "review";
      const unique = (values: readonly string[]) => Object.freeze([...new Set(values)].sort());
      return renderProjectAgent(expert, {
        taskIds: [specialistPlan.workItemId],
        workSpecIds: [specialistPlan.workSpecId],
        sliceIds: unique(delegations.map(({ sliceId }) => sliceId)),
        delegationIds: unique(delegations.map(({ id }) => id)),
        mode,
        reason: activeExpert.reason,
        scope: unique(delegations.flatMap(({ scope }) => scope)),
        deliverables: unique(delegations.flatMap(({ deliverableInterfaceIds }) => deliverableInterfaceIds)),
        qualityGates: unique(delegations.flatMap(({ evidenceRequirements }) => evidenceRequirements)),
        evidenceRequirements: unique(delegations.flatMap(({ evidenceRequirements }) => evidenceRequirements)),
      });
    }));
  }

  const team = await workflow.activeTeamRecord();
  if (team === null) return null;
  if (team.catalogFingerprint !== catalog.fingerprint) {
    throw new Error("approved expert team catalog fingerprint mismatch");
  }
  return Object.freeze(team.members.map((member) => {
    const expert = catalog.byId.get(member.expertId);
    if (expert === undefined) throw new Error(`approved expert is absent from catalog: ${member.expertId}`);
    const activeExpert = activeById.get(member.expertId);
    if (activeExpert === undefined || !activeExpert.taskIds.includes(team.taskId)) {
      throw new Error(`approved expert is absent from active projection: ${member.expertId}`);
    }
    return renderProjectAgent(expert, {
      taskIds: [team.taskId],
      mode: member.mode,
      reason: activeExpert.reason,
      scope: member.scope,
      deliverables: member.deliverables,
      qualityGates: member.qualityGates,
    });
  }));
}

export async function inspectCodexExpertTeam(
  projectRoot: string,
  catalog: RuntimeCatalog,
  runtime: ProjectAgentRuntime = nodeProjectAgentRuntime,
): Promise<CodexExpertTeamReadiness> {
  try {
    const rendered = await renderedApprovedTeam(projectRoot, catalog, runtime);
    return rendered === null ? { status: "none" } : inspectProjectAgents(projectRoot, rendered, runtime);
  } catch {
    return { status: "inspection-required", reason: "approved expert team requires inspection" };
  }
}

export async function reconcileCodexExpertTeam(
  projectRoot: string,
  catalog: RuntimeCatalog,
  runtime: ProjectAgentRuntime = nodeProjectAgentRuntime,
): Promise<{ readonly synced: true; readonly files: readonly string[] }> {
  try {
    const rendered = await renderedApprovedTeam(projectRoot, catalog, runtime);
    return await syncProjectAgents(projectRoot, rendered ?? Object.freeze([]), runtime);
  } catch (error: unknown) {
    if (error instanceof ProjectAgentInspectionRequiredError) throw error;
    throw new ProjectAgentInspectionRequiredError(
      "Codex expert team reconciliation",
      join(projectRoot, ".ezagent", "backups", "generated-codex-agents"),
      undefined,
      error,
    );
  }
}
