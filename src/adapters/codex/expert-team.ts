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
): Promise<readonly RenderedProjectAgent[] | null> {
  const team = await new ExpertTeamWorkflowService(projectRoot).activeTeamRecord();
  if (team === null) return null;
  if (team.catalogFingerprint !== catalog.fingerprint) {
    throw new Error("approved expert team catalog fingerprint mismatch");
  }
  return Object.freeze(team.members.map((member) => {
    const expert = catalog.byId.get(member.expertId);
    if (expert === undefined) throw new Error(`approved expert is absent from catalog: ${member.expertId}`);
    return renderProjectAgent(expert, {
      taskIds: [team.taskId],
      mode: member.mode,
      reason: member.reasons.join("; "),
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
    const rendered = await renderedApprovedTeam(projectRoot, catalog);
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
    const rendered = await renderedApprovedTeam(projectRoot, catalog);
    if (rendered === null) return { synced: true, files: Object.freeze([]) };
    return await syncProjectAgents(projectRoot, rendered, runtime);
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
