import type { ActiveExperts } from "../experts/active.js";
import type { ExpertTeamPlan } from "./team-record.js";
import type { SpecialistPlanV2 } from "./specialist-plan.js";

function portableCompare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

export function addActiveTeam(
  active: ActiveExperts,
  team: ExpertTeamPlan,
): ActiveExperts {
  const byId = new Map(active.experts.map((expert) => [expert.id, {
    id: expert.id,
    reason: expert.reason,
    taskIds: [...expert.taskIds],
  }]));
  for (const member of team.members) {
    const existing = byId.get(member.expertId);
    const reason = member.reasons.join("; ");
    if (existing === undefined) {
      byId.set(member.expertId, { id: member.expertId, reason, taskIds: [team.taskId] });
    } else if (!existing.taskIds.includes(team.taskId)) {
      existing.taskIds.push(team.taskId);
    }
  }
  return {
    revision: active.revision + 1,
    experts: [...byId.values()].map((expert) => ({
      ...expert,
      taskIds: expert.taskIds.sort(portableCompare),
    })).sort((left, right) => portableCompare(left.id, right.id)),
  };
}

export function addActiveSpecialists(
  active: ActiveExperts,
  plan: SpecialistPlanV2,
): ActiveExperts {
  const byId = new Map(active.experts.map((expert) => [expert.id, {
    id: expert.id,
    reason: expert.reason,
    taskIds: [...expert.taskIds],
  }]));
  for (const expertId of new Set(plan.delegations.map(({ expertId }) => expertId))) {
    const existing = byId.get(expertId);
    if (existing === undefined) {
      byId.set(expertId, {
        id: expertId,
        reason: `approved v2 Specialist for ${plan.workItemId}`,
        taskIds: [plan.workItemId],
      });
    } else if (!existing.taskIds.includes(plan.workItemId)) {
      existing.taskIds.push(plan.workItemId);
    }
  }
  return {
    revision: active.revision + 1,
    experts: [...byId.values()].map((expert) => ({
      ...expert,
      taskIds: expert.taskIds.sort(portableCompare),
    })).sort((left, right) => portableCompare(left.id, right.id)),
  };
}

export function replaceActiveSpecialists(
  active: ActiveExperts,
  previous: SpecialistPlanV2,
  next: SpecialistPlanV2,
): ActiveExperts {
  const previousIds = new Set(previous.delegations.map(({ expertId }) => expertId));
  const byId = new Map<string, { id: string; reason: string; taskIds: string[] }>(active.experts.flatMap((expert) => {
    if (!previousIds.has(expert.id)) return [[expert.id, { ...expert, taskIds: [...expert.taskIds] }] as const];
    const taskIds = expert.taskIds.filter((taskId) => taskId !== previous.workItemId);
    return taskIds.length === 0 ? [] : [[expert.id, { ...expert, taskIds }] as const];
  }));
  for (const expertId of new Set(next.delegations.map(({ expertId }) => expertId))) {
    const existing = byId.get(expertId);
    if (existing === undefined) {
      byId.set(expertId, {
        id: expertId,
        reason: `approved v2 Specialist for ${next.workItemId}`,
        taskIds: [next.workItemId],
      });
    } else if (!existing.taskIds.includes(next.workItemId)) {
      existing.taskIds.push(next.workItemId);
    }
  }
  return {
    revision: active.revision + 1,
    experts: [...byId.values()].map((expert) => ({
      ...expert,
      taskIds: expert.taskIds.sort(portableCompare),
    })).sort((left, right) => portableCompare(left.id, right.id)),
  };
}

export function retireActiveSpecialists(
  active: ActiveExperts,
  workItemId: string,
  plan: SpecialistPlanV2 | null,
): ActiveExperts {
  const specialistIds = new Set(plan?.delegations.map(({ expertId }) => expertId) ?? []);
  return {
    revision: active.revision + 1,
    experts: active.experts.flatMap((expert) => {
      if (!specialistIds.has(expert.id)) return [expert];
      const taskIds = expert.taskIds.filter((taskId) => taskId !== workItemId);
      return taskIds.length === 0 ? [] : [{ ...expert, taskIds }];
    }),
  };
}

export function replaceActiveTeam(
  active: ActiveExperts,
  previous: ExpertTeamPlan,
  next: ExpertTeamPlan,
): ActiveExperts {
  const previousIds = new Set(previous.members.map((member) => member.expertId));
  const withoutPreviousTask: ActiveExperts = {
    revision: active.revision,
    experts: active.experts.flatMap((expert) => {
      if (!previousIds.has(expert.id)) return [expert];
      const taskIds = expert.taskIds.filter((taskId) => taskId !== previous.taskId);
      return taskIds.length === 0 ? [] : [{ ...expert, taskIds }];
    }),
  };
  return addActiveTeam(withoutPreviousTask, next);
}

export function retireActiveTeam(active: ActiveExperts, team: ExpertTeamPlan): ActiveExperts {
  const teamIds = new Set(team.members.map((member) => member.expertId));
  return {
    revision: active.revision + 1,
    experts: active.experts.flatMap((expert) => {
      if (!teamIds.has(expert.id)) return [expert];
      const taskIds = expert.taskIds.filter((taskId) => taskId !== team.taskId);
      return taskIds.length === 0 ? [] : [{ ...expert, taskIds }];
    }),
  };
}
