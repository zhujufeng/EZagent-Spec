import { lstat, readdir, realpath } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import {
  ActiveExpertRepository,
  serializeActiveExperts,
  type ActiveExperts,
} from "../experts/active.js";
import {
  loadRuntimeCatalogBytes,
  parseRuntimeCatalog,
  type RuntimeCatalog,
} from "../experts/runtime-catalog.js";
import { createWorkItemId } from "../domain/id.js";
import { workspacePaths } from "../workspace/layout.js";
import { WorkspaceRepository } from "../workspace/repository.js";
import type { WorkspaceState } from "../workspace/schema.js";
import {
  finalizeExpertTeam,
  proposeExpertTeam,
  type AssignmentDraft,
  type ExpertTeamBlocker,
  type ExpertTeamProposal,
} from "./expert-team.js";
import {
  parsePlanDraft,
  serializeRequirementArtifact,
  serializeSpecArtifact,
  serializeTaskArtifact,
  type PlanDraft,
  type RequirementArtifact,
  type SpecArtifact,
  type TaskArtifact,
} from "./plan-artifacts.js";
import {
  approvalToken,
  serializeExpertTeamPlan,
  teamHistoryPath,
  type ExpertTeamPlan,
} from "./team-record.js";

const HASH = /^sha256:[0-9a-f]{64}$/u;

export interface TeamWorkflowRuntime {
  readonly now: () => Date;
  readonly canonicalRoot: (root: string) => Promise<string>;
  readonly readCatalog: () => Promise<RuntimeCatalog>;
  readonly createRepository: (root: string) => WorkspaceRepository;
  readonly readActiveExperts: (root: string) => Promise<ActiveExperts>;
}

export interface VocabularyMismatches {
  readonly capabilities: readonly string[];
  readonly domains: readonly string[];
  readonly projectSignals: readonly string[];
}

export interface SelectionPreview extends ExpertTeamProposal {
  readonly vocabularyMismatches: VocabularyMismatches;
  readonly catalogFingerprint: `sha256:${string}`;
}

export interface PlanPreviewInput {
  readonly draft: PlanDraft;
  readonly selectionFingerprint: `sha256:${string}`;
  readonly assignments: readonly AssignmentDraft[];
  readonly largeTeamDecision?: "accepted";
}

export interface PlanApplyInput extends PlanPreviewInput {
  readonly approvalToken: `sha256:${string}`;
}

export interface PlanPreview {
  readonly requirement: RequirementArtifact;
  readonly spec: SpecArtifact;
  readonly task: TaskArtifact;
  readonly team: ExpertTeamPlan;
  readonly blockers: readonly ExpertTeamBlocker[];
  readonly vocabularyMismatches: VocabularyMismatches;
  readonly approvalToken: `sha256:${string}`;
  readonly workspaceRevision: number;
}

export type AppliedPlan = Omit<PlanPreview, "approvalToken">;

interface PreparedPlan extends PlanPreview {
  readonly canonicalRoot: string;
  readonly state: WorkspaceState;
  readonly activeExperts: ActiveExperts;
}

function portableCompare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

async function defaultCatalog(): Promise<RuntimeCatalog> {
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    join(here, "..", "catalog", "experts.json"),
    join(here, "..", "..", "catalog", "normalized", "experts.json"),
    join(here, "..", "..", "..", "catalog", "normalized", "experts.json"),
  ];
  let missing: unknown;
  for (const candidate of candidates) {
    try {
      return parseRuntimeCatalog(await loadRuntimeCatalogBytes(candidate));
    } catch (error: unknown) {
      missing = error;
    }
  }
  throw new Error("local expert catalog is unavailable", { cause: missing });
}

const defaultRuntime: TeamWorkflowRuntime = {
  now: () => new Date(),
  canonicalRoot: realpath,
  readCatalog: defaultCatalog,
  createRepository: (root) => new WorkspaceRepository(root),
  readActiveExperts: async (root) => new ActiveExpertRepository(root).read(),
};

function exactObject(value: unknown, allowed: readonly string[], required: readonly string[]): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("Plan workflow input must be an object");
  }
  const record = value as Record<string, unknown>;
  const unsupported = Object.keys(record).find((key) => !allowed.includes(key));
  if (unsupported !== undefined) throw new TypeError(`unsupported Plan workflow input: ${unsupported}`);
  const missing = required.find((key) => !Object.hasOwn(record, key));
  if (missing !== undefined) throw new TypeError(`missing Plan workflow input: ${missing}`);
  return record;
}

function parseAssignments(value: unknown): readonly AssignmentDraft[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > 4_096) {
    throw new TypeError("assignments must be a bounded non-empty array");
  }
  return value.map((item) => {
    const record = exactObject(
      item,
      ["expertId", "scope", "deliverables", "qualityGates"],
      ["expertId", "scope", "deliverables", "qualityGates"],
    );
    if (typeof record.expertId !== "string") throw new TypeError("assignment expertId must be text");
    return {
      expertId: record.expertId,
      scope: record.scope as readonly string[],
      deliverables: record.deliverables as readonly string[],
      qualityGates: record.qualityGates as readonly string[],
    };
  });
}

function parsePreviewInput(value: unknown): PlanPreviewInput {
  const record = exactObject(
    value,
    ["draft", "selectionFingerprint", "assignments", "largeTeamDecision"],
    ["draft", "selectionFingerprint", "assignments"],
  );
  if (typeof record.selectionFingerprint !== "string" || !HASH.test(record.selectionFingerprint)) {
    throw new TypeError("selection fingerprint is invalid");
  }
  if (record.largeTeamDecision !== undefined && record.largeTeamDecision !== "accepted") {
    throw new TypeError("large team decision must be accepted when supplied");
  }
  return {
    draft: parsePlanDraft(record.draft),
    selectionFingerprint: record.selectionFingerprint as `sha256:${string}`,
    assignments: parseAssignments(record.assignments),
    ...(record.largeTeamDecision === "accepted" ? { largeTeamDecision: "accepted" } : {}),
  };
}

function parseApplyInput(value: unknown): PlanApplyInput {
  const record = exactObject(
    value,
    ["draft", "selectionFingerprint", "assignments", "largeTeamDecision", "approvalToken"],
    ["draft", "selectionFingerprint", "assignments", "approvalToken"],
  );
  if (typeof record.approvalToken !== "string" || !HASH.test(record.approvalToken)) {
    throw new TypeError("approval token is invalid");
  }
  const preview = parsePreviewInput({
    draft: record.draft,
    selectionFingerprint: record.selectionFingerprint,
    assignments: record.assignments,
    ...(record.largeTeamDecision === undefined ? {} : { largeTeamDecision: record.largeTeamDecision }),
  });
  return { ...preview, approvalToken: record.approvalToken as `sha256:${string}` };
}

function mismatch(values: readonly string[], vocabulary: ReadonlySet<string>): readonly string[] {
  return Object.freeze(values.filter((value) => !vocabulary.has(value)).sort(portableCompare));
}

function vocabularyMismatches(draft: PlanDraft, catalog: RuntimeCatalog): VocabularyMismatches {
  return Object.freeze({
    capabilities: mismatch(draft.selection.capabilities, catalog.capabilities),
    domains: mismatch(draft.selection.domains, catalog.domains),
    projectSignals: mismatch(draft.selection.projectSignals, catalog.projectSignals),
  });
}

function requestFor(draft: PlanDraft) {
  return {
    capabilities: [...draft.selection.capabilities],
    domains: [...draft.selection.domains],
    projectSignals: [...draft.selection.projectSignals],
    risk: draft.task.risk,
    reviewAfter: draft.selection.reviewAfter,
  };
}

function requireIdle(state: WorkspaceState): void {
  if (state.safeMode) throw new Error("workspace is in safe mode");
  if (state.activeWorkItem !== null) throw new Error("an active work item must be resolved before a new Plan");
}

async function nextId(
  root: string,
  directory: "requirements" | "specs" | "tasks",
  prefix: "REQ" | "SPEC" | "TASK",
  now: Date,
): Promise<string> {
  const path = join(workspacePaths(root).root, directory);
  const names = await readdir(path);
  const pattern = new RegExp(`^${prefix}-(\\d{8})-(\\d{3}|[1-9]\\d{3,})\\.yaml$`, "u");
  const date = `${now.getUTCFullYear().toString().padStart(4, "0")}${String(now.getUTCMonth() + 1).padStart(2, "0")}${String(now.getUTCDate()).padStart(2, "0")}`;
  let maximum = 0;
  for (const name of names) {
    const match = pattern.exec(name);
    if (match === null) throw new Error(`malformed Core artifact name in ${directory}`);
    if (match[1] === date) maximum = Math.max(maximum, Number(match[2]));
  }
  return createWorkItemId(
    prefix === "REQ" ? "requirement" : prefix === "SPEC" ? "spec" : "task",
    now,
    maximum + 1,
  );
}

function addActiveTeam(
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

async function assertMissing(root: string, relativePaths: readonly string[]): Promise<void> {
  for (const relativePath of relativePaths) {
    const path = join(workspacePaths(root).root, ...relativePath.split("/"));
    try {
      await lstat(path);
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw error;
    }
    throw new Error(`Core artifact already exists: ${relativePath}`);
  }
}

export class ExpertTeamWorkflowService {
  readonly projectRoot: string;
  readonly runtime: TeamWorkflowRuntime;

  constructor(projectRoot: string, runtime: TeamWorkflowRuntime = defaultRuntime) {
    this.projectRoot = projectRoot;
    this.runtime = runtime;
  }

  private async context() {
    const canonicalRoot = await this.runtime.canonicalRoot(this.projectRoot);
    const repository = this.runtime.createRepository(canonicalRoot);
    const context = await repository.readContext();
    requireIdle(context.state);
    return { canonicalRoot, repository, context };
  }

  async selectPreview(draftValue: unknown): Promise<SelectionPreview> {
    const draft = parsePlanDraft(draftValue);
    const [{ context }, catalog] = await Promise.all([this.context(), this.runtime.readCatalog()]);
    requireIdle(context.state);
    const proposal = proposeExpertTeam(catalog.experts, requestFor(draft));
    return Object.freeze({
      ...proposal,
      vocabularyMismatches: vocabularyMismatches(draft, catalog),
      catalogFingerprint: catalog.fingerprint,
    });
  }

  private async prepare(input: PlanPreviewInput): Promise<PreparedPlan> {
    const [{ canonicalRoot, context }, catalog] = await Promise.all([
      this.context(),
      this.runtime.readCatalog(),
    ]);
    const proposal = proposeExpertTeam(catalog.experts, requestFor(input.draft));
    if (proposal.selectionFingerprint !== input.selectionFingerprint) {
      throw new Error("selection fingerprint no longer matches the current Plan and catalog");
    }
    const now = this.runtime.now();
    if (!Number.isFinite(now.getTime())) throw new Error("workflow clock is invalid");
    const [requirementId, specId, taskId, activeExperts] = await Promise.all([
      nextId(canonicalRoot, "requirements", "REQ", now),
      nextId(canonicalRoot, "specs", "SPEC", now),
      nextId(canonicalRoot, "tasks", "TASK", now),
      this.runtime.readActiveExperts(canonicalRoot),
    ]);
    const requirement: RequirementArtifact = {
      schemaVersion: 1,
      id: requirementId,
      status: "specified",
      revision: 0,
      ...input.draft.requirement,
    };
    const spec: SpecArtifact = {
      schemaVersion: 1,
      id: specId,
      requirementId,
      status: "approved",
      revision: 0,
      ...input.draft.spec,
    };
    const task: TaskArtifact = {
      schemaVersion: 1,
      id: taskId,
      requirementId,
      specId,
      status: "planned",
      revision: 0,
      ...input.draft.task,
    };
    const team = finalizeExpertTeam(proposal, input.assignments, {
      teamRevision: 1,
      requirementId,
      specId,
      taskId,
      taskRevision: task.revision,
      catalogFingerprint: catalog.fingerprint,
    });
    const token = approvalToken(
      canonicalRoot,
      context.state.revision,
      team,
      input.largeTeamDecision,
    );
    return {
      requirement,
      spec,
      task,
      team,
      blockers: proposal.blockers,
      vocabularyMismatches: vocabularyMismatches(input.draft, catalog),
      approvalToken: token,
      workspaceRevision: context.state.revision,
      canonicalRoot,
      state: context.state,
      activeExperts,
    };
  }

  async planPreview(inputValue: unknown): Promise<PlanPreview> {
    const prepared = await this.prepare(parsePreviewInput(inputValue));
    return {
      requirement: prepared.requirement,
      spec: prepared.spec,
      task: prepared.task,
      team: prepared.team,
      blockers: prepared.blockers,
      vocabularyMismatches: prepared.vocabularyMismatches,
      approvalToken: prepared.approvalToken,
      workspaceRevision: prepared.workspaceRevision,
    };
  }

  async planApply(inputValue: unknown): Promise<AppliedPlan> {
    const input = parseApplyInput(inputValue);
    const prepared = await this.prepare(input);
    if (prepared.approvalToken !== input.approvalToken) {
      throw new Error("approval token no longer matches the current workspace revision or Plan");
    }
    if (prepared.blockers.includes("capability-uncovered")) {
      throw new Error("Plan has uncovered capabilities");
    }
    if (prepared.blockers.includes("independent-reviewer-missing")) {
      throw new Error("Plan has no independent reviewer");
    }
    if (prepared.blockers.includes("large-team-review-required")
      && input.largeTeamDecision !== "accepted") {
      throw new Error("large team requires an explicitly accepted Plan decision");
    }

    const active = addActiveTeam(prepared.activeExperts, prepared.team);
    const writes = [
      { relativePath: `requirements/${prepared.requirement.id}.yaml`, content: serializeRequirementArtifact(prepared.requirement) },
      { relativePath: `specs/${prepared.spec.id}.yaml`, content: serializeSpecArtifact(prepared.spec) },
      { relativePath: `tasks/${prepared.task.id}.yaml`, content: serializeTaskArtifact(prepared.task) },
      { relativePath: teamHistoryPath(prepared.task.id, prepared.team.teamRevision), content: serializeExpertTeamPlan(prepared.team) },
      { relativePath: "experts/active.yaml", content: serializeActiveExperts(active) },
    ];
    await assertMissing(prepared.canonicalRoot, writes.slice(0, 4).map((write) => write.relativePath));
    const nextState: WorkspaceState = {
      schemaVersion: 1,
      revision: prepared.state.revision + 1,
      activeWorkItem: {
        id: prepared.task.id,
        kind: "task",
        status: "planned",
        risk: prepared.task.risk,
        revision: prepared.task.revision,
      },
      safeMode: false,
    };
    await this.runtime.createRepository(prepared.canonicalRoot).commitMutation(
      nextState,
      prepared.state.revision,
      "plan-approved",
      writes,
      {
        requirementId: prepared.requirement.id,
        specId: prepared.spec.id,
        taskId: prepared.task.id,
        teamRevision: prepared.team.teamRevision,
        memberCount: prepared.team.members.length,
        teamFingerprint: prepared.team.teamFingerprint,
      },
    );
    return {
      requirement: prepared.requirement,
      spec: prepared.spec,
      task: prepared.task,
      team: prepared.team,
      blockers: prepared.blockers,
      vocabularyMismatches: prepared.vocabularyMismatches,
      workspaceRevision: nextState.revision,
    };
  }
}
