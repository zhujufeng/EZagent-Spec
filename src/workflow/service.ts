import { createHash } from "node:crypto";
import { lstat, readFile, readdir, realpath } from "node:fs/promises";
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
import { transitionWorkItem } from "../domain/state-machine.js";
import type { WorkItemStatus } from "../domain/work-item.js";
import { workspacePaths } from "../workspace/layout.js";
import { WorkspaceRepository } from "../workspace/repository.js";
import {
  serializeProjectConfig,
  type ProjectConfig,
  type WorkspaceState,
} from "../workspace/schema.js";
import {
  finalizeExpertTeam,
  diffExpertTeams,
  proposeExpertTeam,
  type AssignmentDraft,
  type ExpertTeamBlocker,
  type ExpertTeamProposal,
  type TeamDiff,
} from "./expert-team.js";
import {
  parsePlanDraft,
  parseRequirementArtifactYaml,
  parseSpecArtifactYaml,
  parseTaskArtifactYaml,
  serializeRequirementArtifact,
  serializeSpecArtifact,
  serializeTaskArtifact,
  type PlanDraft,
  type RequirementArtifact,
  type SpecArtifact,
  type TaskArtifact,
} from "./plan-artifacts.js";
import { parseWorkContractDraft, type WorkContractDraftV2 } from "./work-contract.js";
import {
  createWorkArtifactsV2,
  parseBriefArtifactV2Yaml,
  parseWorkItemArtifactV2Yaml,
  parseWorkSpecArtifactV2Yaml,
  serializeBriefArtifactV2,
  serializeWorkItemArtifactV2,
  serializeWorkSpecArtifactV2,
  workModeRisk,
  type BriefArtifactV2,
  type WorkItemArtifactV2,
  type WorkSpecArtifactV2,
  type WorkArtifactsV2,
} from "./work-artifacts.js";
import {
  approvalToken,
  parseExpertTeamPlan,
  serializeExpertTeamPlan,
  teamHistoryPath,
  type ExpertTeamPlan,
} from "./team-record.js";
import {
  freezeWorkflowResumeContext,
  type ResumeKnowledge,
  type WorkflowResumeContext,
} from "./resume-context.js";
import {
  createKnowledgeRecord,
  knowledgeContentHash,
  knowledgeRecordPath,
  parseKnowledgeCaptureInput,
  parseKnowledgeRecordMarkdown,
  serializeKnowledgeRecord,
  type KnowledgeRecord,
  type QualityGateReceipt,
} from "./knowledge.js";
import {
  evidenceBundlePath,
  parseEvidenceBundle,
  reviewEvidenceCoverage,
  serializeEvidenceBundle,
  type EvidenceCoverage,
} from "./evidence.js";
import {
  KNOWLEDGE_PATTERN_MAX_BYTES,
  createKnowledgePattern,
  knowledgePatternPath,
  parseKnowledgePromotionDraft,
  parseKnowledgePatternMarkdown,
  serializeKnowledgePattern,
  type KnowledgePattern,
  type KnowledgePromotionDraft,
} from "./knowledge-pattern.js";
import {
  parseKnowledgeContextQuery,
  selectKnowledge,
  type KnowledgeCandidate,
  type KnowledgeSelection,
} from "./knowledge-selection.js";
import {
  PROJECT_CONTEXT_MAX_BYTES,
  PROJECT_CONTEXT_PATH,
  parseProjectContextYaml,
  parseProjectContext,
  serializeProjectContext,
  type ProjectContext,
} from "./project-context.js";

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

export interface WorkPreview extends WorkArtifactsV2 {
  readonly approvalToken: `sha256:${string}`;
  readonly workspaceRevision: number;
}

export type AppliedWork = Omit<WorkPreview, "approvalToken">;

export interface WorkSliceReviewResult {
  readonly workItem: WorkItemArtifactV2;
  readonly coverage: EvidenceCoverage;
  readonly evidencePath: string;
  readonly workspaceRevision: number;
}

export interface KnowledgeCaptureResult {
  readonly state: WorkspaceState;
  readonly task: TaskArtifact;
  readonly knowledge: KnowledgeRecord;
  readonly knowledgePath: string;
  readonly knowledgeHash: `sha256:${string}`;
}

export interface SharingPreview {
  readonly currentGitTracking: "none" | "artifacts";
  readonly targetGitTracking: "artifacts";
  readonly writePaths: readonly string[];
  readonly sharedPaths: readonly string[];
  readonly excludedPaths: readonly string[];
  readonly approvalToken: `sha256:${string}`;
  readonly workspaceRevision: number;
}

export interface SharingApplyInput {
  readonly projectContext: ProjectContext;
  readonly approvalToken: `sha256:${string}`;
}

export interface SharingApplyResult {
  readonly gitTracking: "artifacts";
  readonly projectContext: ProjectContext;
  readonly workspaceRevision: number;
}

export interface KnowledgePromotionPreview {
  readonly pattern: KnowledgePattern;
  readonly targetPath: string;
  readonly approvalToken: `sha256:${string}`;
  readonly workspaceRevision: number;
}

export interface KnowledgePromotionApplyInput {
  readonly draft: KnowledgePromotionDraft;
  readonly approvalToken: `sha256:${string}`;
}

export interface KnowledgePromotionApplyResult {
  readonly pattern: KnowledgePattern;
  readonly targetPath: string;
  readonly patternHash: `sha256:${string}`;
  readonly workspaceRevision: number;
}

export interface ReplanPreview {
  readonly requirement: RequirementArtifact;
  readonly spec: SpecArtifact;
  readonly task: TaskArtifact;
  readonly previousTeam: ExpertTeamPlan;
  readonly nextTeam: ExpertTeamPlan;
  readonly diff: TeamDiff;
  readonly blockers: readonly ExpertTeamBlocker[];
  readonly vocabularyMismatches: VocabularyMismatches;
  readonly approvalToken: `sha256:${string}`;
  readonly workspaceRevision: number;
}

interface PreparedPlan extends PlanPreview {
  readonly canonicalRoot: string;
  readonly state: WorkspaceState;
  readonly activeExperts: ActiveExperts;
}

interface PreparedWork extends WorkPreview {
  readonly canonicalRoot: string;
  readonly repository: WorkspaceRepository;
  readonly state: WorkspaceState;
}

interface ActiveRecords {
  readonly requirement: RequirementArtifact;
  readonly spec: SpecArtifact;
  readonly task: TaskArtifact;
  readonly team: ExpertTeamPlan;
  readonly activeExperts: ActiveExperts;
}

interface ActiveWorkRecordsV2 {
  readonly brief: BriefArtifactV2;
  readonly workSpec: WorkSpecArtifactV2;
  readonly workItem: WorkItemArtifactV2;
}

interface PreparedReplan extends ReplanPreview {
  readonly canonicalRoot: string;
  readonly state: WorkspaceState;
  readonly activeExperts: ActiveExperts;
}

interface PreparedSharing extends SharingPreview {
  readonly canonicalRoot: string;
  readonly repository: WorkspaceRepository;
  readonly state: WorkspaceState;
  readonly project: ProjectConfig;
  readonly projectContext: ProjectContext;
}

interface PreparedPromotion extends KnowledgePromotionPreview {
  readonly canonicalRoot: string;
  readonly repository: WorkspaceRepository;
  readonly state: WorkspaceState;
  readonly sourceKnowledgeHash: `sha256:${string}`;
}

const SHARING_WRITE_PATHS = Object.freeze(["project.yaml", PROJECT_CONTEXT_PATH]);
const SHARED_ARTIFACT_PATHS = Object.freeze([
  "project.yaml",
  "requirements/*.yaml",
  "specs/*.yaml",
  "tasks/*.yaml",
  PROJECT_CONTEXT_PATH,
  "knowledge/decisions/SPEC-*.md",
  "knowledge/patterns/SPEC-*.md",
]);
const EXCLUDED_LOCAL_PATHS = Object.freeze([
  "audit/**",
  "backups/**",
  "quality/runs/**",
  "state/**",
  "experts/active.yaml",
  "experts/teams/**",
]);

function portableCompare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

export async function loadDefaultRuntimeCatalog(): Promise<RuntimeCatalog> {
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
  readCatalog: loadDefaultRuntimeCatalog,
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

function assertKnownSelectionContext(mismatches: VocabularyMismatches): void {
  const unknown: string[] = [];
  if (mismatches.domains.length > 0) {
    unknown.push(`unknown domains: ${mismatches.domains.join(", ")}`);
  }
  if (mismatches.projectSignals.length > 0) {
    unknown.push(`unknown project signals: ${mismatches.projectSignals.join(", ")}`);
  }
  if (unknown.length > 0) throw new Error(unknown.join("; "));
}

function assertQualityGateReceipts(
  qualityGates: readonly string[],
  receipts: readonly QualityGateReceipt[],
): void {
  const expected = new Set(qualityGates);
  const actual = new Set(receipts.map(({ gate }) => gate));
  const missing = qualityGates.filter((gate) => !actual.has(gate));
  const unknown = receipts.map(({ gate }) => gate).filter((gate) => !expected.has(gate));
  if (missing.length > 0 || unknown.length > 0 || actual.size !== receipts.length) {
    throw new Error("quality gate receipts must match the active Task exactly");
  }
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

function replaceActiveTeam(
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

function retireActiveTeam(active: ActiveExperts, team: ExpertTeamPlan): ActiveExperts {
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

async function readBoundedText(path: string, maximumBytes = 1_048_576): Promise<string> {
  const observed = await lstat(path);
  if (!observed.isFile() || observed.isSymbolicLink() || observed.size < 1 || observed.size > maximumBytes) {
    throw new Error("Core artifact is not a bounded regular file");
  }
  const text = await readFile(path, "utf8");
  if (Buffer.byteLength(text, "utf8") !== observed.size) {
    throw new Error("Core artifact changed during read");
  }
  return text;
}

async function readProjectContext(root: string): Promise<ProjectContext | null> {
  const path = join(workspacePaths(root).root, ...PROJECT_CONTEXT_PATH.split("/"));
  try {
    return parseProjectContextYaml(await readBoundedText(path, PROJECT_CONTEXT_MAX_BYTES));
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

async function latestTeamRecord(root: string, taskId: string): Promise<ExpertTeamPlan> {
  const directory = join(workspacePaths(root).root, "experts", "teams", taskId);
  const names = await readdir(directory);
  if (names.length === 0 || names.some((name) => !/^\d{6,}\.json$/u.test(name))) {
    throw new Error("expert team history is missing or malformed");
  }
  const name = [...names].sort(portableCompare).at(-1)!;
  const value: unknown = JSON.parse(await readBoundedText(join(directory, name)));
  const team = parseExpertTeamPlan(value);
  if (team.taskId !== taskId || name !== `${String(team.teamRevision).padStart(6, "0")}.json`) {
    throw new Error("expert team history identity mismatch");
  }
  return team;
}

async function readActiveRecords(
  root: string,
  state: WorkspaceState,
  activeExperts: ActiveExperts,
): Promise<ActiveRecords> {
  const active = state.activeWorkItem;
  if (active === null || active.kind !== "task") throw new Error("no active Task with an expert team");
  const base = workspacePaths(root).root;
  const task = parseTaskArtifactYaml(await readBoundedText(join(base, "tasks", `${active.id}.yaml`)));
  const spec = parseSpecArtifactYaml(await readBoundedText(join(base, "specs", `${task.specId}.yaml`)));
  const requirement = parseRequirementArtifactYaml(
    await readBoundedText(join(base, "requirements", `${task.requirementId}.yaml`)),
  );
  const team = await latestTeamRecord(root, task.id);
  if (task.id !== active.id
    || task.status !== active.status
    || task.revision !== active.revision
    || spec.id !== task.specId
    || requirement.id !== task.requirementId
    || spec.requirementId !== requirement.id
    || team.requirementId !== requirement.id
    || team.specId !== spec.id
    || team.taskRevision > task.revision) {
    throw new Error("active Plan artifact identities do not match workspace state");
  }
  const projected = new Map(activeExperts.experts.map((expert) => [expert.id, expert]));
  if (team.members.some((member) => !projected.get(member.expertId)?.taskIds.includes(task.id))) {
    throw new Error("active expert projection does not match approved team");
  }
  return { requirement, spec, task, team, activeExperts };
}

async function readActiveWorkRecordsV2(
  root: string,
  state: WorkspaceState,
): Promise<ActiveWorkRecordsV2 | null> {
  const active = state.activeWorkItem;
  if (active === null || active.kind !== "task") throw new Error("no active Work Item");
  const base = workspacePaths(root).root;
  const taskText = await readBoundedText(join(base, "tasks", `${active.id}.yaml`));
  let workItem: WorkItemArtifactV2;
  try {
    workItem = parseWorkItemArtifactV2Yaml(taskText);
  } catch (v2Error: unknown) {
    try {
      parseTaskArtifactYaml(taskText);
      return null;
    } catch {
      throw v2Error;
    }
  }
  const workSpec = parseWorkSpecArtifactV2Yaml(
    await readBoundedText(join(base, "specs", `${workItem.workSpecId}.yaml`)),
  );
  const brief = parseBriefArtifactV2Yaml(
    await readBoundedText(join(base, "requirements", `${workItem.briefId}.yaml`)),
  );
  if (workItem.id !== active.id
    || workItem.status !== active.status
    || workItem.revision !== active.revision
    || workItem.briefId !== brief.id
    || workItem.workSpecId !== workSpec.id
    || workSpec.briefId !== brief.id
    || active.risk !== workModeRisk(workSpec.workSpec.mode)
    || workItem.slices.length !== workSpec.workSpec.slicePlan.length
    || workItem.slices.some((slice, index) => slice.id !== workSpec.workSpec.slicePlan[index]?.id)) {
    throw new Error("active Work Contract artifact identities do not match workspace state");
  }
  return Object.freeze({ brief, workSpec, workItem });
}

function replanToken(
  root: string,
  workspaceRevision: number,
  previous: ExpertTeamPlan,
  next: ExpertTeamPlan,
  diff: TeamDiff,
  decision?: "accepted",
): `sha256:${string}` {
  const base = approvalToken(root, workspaceRevision, next, decision);
  return `sha256:${createHash("sha256").update(JSON.stringify({
    schemaVersion: 1,
    base,
    previousTeamFingerprint: previous.teamFingerprint,
    diff,
  })).digest("hex")}`;
}

function sharingToken(
  canonicalRoot: string,
  workspaceRevision: number,
  project: ProjectConfig,
  existingProjectContext: ProjectContext | null,
  projectContext: ProjectContext,
): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(JSON.stringify({
    schemaVersion: 1,
    operation: "artifact-sharing",
    canonicalRoot,
    workspaceRevision,
    project,
    existingProjectContext,
    projectContext,
  })).digest("hex")}`;
}

function workToken(
  canonicalRoot: string,
  workspaceRevision: number,
  artifacts: WorkArtifactsV2,
): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(JSON.stringify({
    schemaVersion: 2,
    operation: "work-contract-approval",
    canonicalRoot,
    workspaceRevision,
    artifacts,
  })).digest("hex")}`;
}

function parseWorkApplyInput(value: unknown): {
  readonly draft: WorkContractDraftV2;
  readonly approvalToken: `sha256:${string}`;
} {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("Work approval input must be an object");
  }
  const record = value as Record<string, unknown>;
  const unsupported = Object.keys(record).find((key) => !["draft", "approvalToken"].includes(key));
  if (unsupported !== undefined) throw new TypeError(`unsupported Work approval input: ${unsupported}`);
  if (!Object.hasOwn(record, "draft") || !Object.hasOwn(record, "approvalToken")) {
    throw new TypeError("Work approval input requires draft and approvalToken");
  }
  if (typeof record.approvalToken !== "string" || !HASH.test(record.approvalToken)) {
    throw new TypeError("Work approval token is invalid");
  }
  return Object.freeze({
    draft: parseWorkContractDraft(record.draft),
    approvalToken: record.approvalToken as `sha256:${string}`,
  });
}

function parseSharingApplyInput(value: unknown): SharingApplyInput {
  const record = exactObject(
    value,
    ["projectContext", "approvalToken"],
    ["projectContext", "approvalToken"],
  );
  if (typeof record.approvalToken !== "string" || !HASH.test(record.approvalToken)) {
    throw new TypeError("sharing approval token is invalid");
  }
  return Object.freeze({
    projectContext: parseProjectContext(record.projectContext),
    approvalToken: record.approvalToken as `sha256:${string}`,
  });
}

function promotionToken(
  canonicalRoot: string,
  workspaceRevision: number,
  project: ProjectConfig,
  pattern: KnowledgePattern,
  targetPath: string,
): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(JSON.stringify({
    schemaVersion: 1,
    operation: "knowledge-promotion",
    canonicalRoot,
    workspaceRevision,
    project,
    pattern,
    targetPath,
  })).digest("hex")}`;
}

function parsePromotionApplyInput(value: unknown): KnowledgePromotionApplyInput {
  const record = exactObject(
    value,
    ["draft", "approvalToken"],
    ["draft", "approvalToken"],
  );
  if (typeof record.approvalToken !== "string" || !HASH.test(record.approvalToken)) {
    throw new TypeError("Knowledge promotion approval token is invalid");
  }
  return Object.freeze({
    draft: parseKnowledgePromotionDraft(record.draft),
    approvalToken: record.approvalToken as `sha256:${string}`,
  });
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

async function readRecentKnowledge(root: string): Promise<readonly ResumeKnowledge[]> {
  const directory = join(workspacePaths(root).root, "knowledge", "decisions");
  const names = (await readdir(directory))
    .filter((name) => /^SPEC-\d{8}-(?:\d{3}|[1-9]\d{3,})\.md$/u.test(name))
    .sort(portableCompare)
    .reverse()
    .slice(0, 5);
  return Promise.all(names.map(async (name) => {
    const path = `knowledge/decisions/${name}`;
    const contents = await readBoundedText(join(directory, name));
    const record = parseKnowledgeRecordMarkdown(contents);
    if (`${record.specId}.md` !== name) throw new Error("Knowledge record filename does not match Spec ID");
    return Object.freeze({
      specId: record.specId,
      taskId: record.taskId,
      path,
      title: record.title,
      summary: record.summary,
      contentHash: knowledgeContentHash(contents),
    });
  }));
}

const KNOWLEDGE_NAME = /^SPEC-\d{8}-(?:\d{3}|[1-9]\d{3,})\.md$/u;
const MAX_KNOWLEDGE_RECORDS = 2_048;

async function readKnowledgeCandidates(root: string): Promise<readonly KnowledgeCandidate[]> {
  const knowledgeRoot = join(workspacePaths(root).root, "knowledge");
  const [decisionNames, patternNames] = await Promise.all([
    readdir(join(knowledgeRoot, "decisions")),
    readdir(join(knowledgeRoot, "patterns")),
  ]);
  const decisionFiles = decisionNames.filter((name) => KNOWLEDGE_NAME.test(name));
  const patternFiles = patternNames.filter((name) => KNOWLEDGE_NAME.test(name));
  if (decisionFiles.length + patternFiles.length > MAX_KNOWLEDGE_RECORDS) {
    throw new Error("Knowledge collection exceeds the bounded record count");
  }

  const decisions = await Promise.all(decisionFiles.sort(portableCompare).map(async (name) => {
    const path = `knowledge/decisions/${name}`;
    const contents = await readBoundedText(join(knowledgeRoot, "decisions", name), 256 * 1024);
    const record = parseKnowledgeRecordMarkdown(contents);
    if (`${record.specId}.md` !== name) throw new Error("Knowledge record filename does not match Spec ID");
    return {
      source: { kind: "decision" as const, specId: record.specId },
      path,
      title: record.title,
      summary: record.summary,
      decisions: record.decisions,
      constraints: record.constraints,
      contentHash: knowledgeContentHash(contents),
    } satisfies KnowledgeCandidate;
  }));
  const patterns = await Promise.all(patternFiles.sort(portableCompare).map(async (name) => {
    const path = `knowledge/patterns/${name}`;
    const contents = await readBoundedText(join(knowledgeRoot, "patterns", name), KNOWLEDGE_PATTERN_MAX_BYTES);
    const pattern = parseKnowledgePatternMarkdown(contents);
    if (`${pattern.sourceSpecId}.md` !== name) throw new Error("Knowledge Pattern filename does not match source Spec ID");
    return {
      source: { kind: "pattern" as const, specId: pattern.sourceSpecId },
      path,
      title: pattern.title,
      summary: pattern.summary,
      tags: pattern.tags,
      guidance: pattern.guidance,
      constraints: pattern.constraints,
      contentHash: knowledgeContentHash(contents),
    } satisfies KnowledgeCandidate;
  }));
  return Object.freeze([...patterns, ...decisions]);
}

export class ExpertTeamWorkflowService {
  readonly projectRoot: string;
  readonly runtime: TeamWorkflowRuntime;

  constructor(projectRoot: string, runtime: TeamWorkflowRuntime = defaultRuntime) {
    this.projectRoot = projectRoot;
    this.runtime = runtime;
  }

  private async context(requireIdleWorkspace = true) {
    const canonicalRoot = await this.runtime.canonicalRoot(this.projectRoot);
    const repository = this.runtime.createRepository(canonicalRoot);
    const context = await repository.readContext();
    if (requireIdleWorkspace) requireIdle(context.state);
    return { canonicalRoot, repository, context };
  }

  private async prepareWork(draftValue: unknown): Promise<PreparedWork> {
    const draft = parseWorkContractDraft(draftValue);
    const { canonicalRoot, repository, context } = await this.context();
    const now = this.runtime.now();
    if (!Number.isFinite(now.getTime())) throw new Error("workflow clock is invalid");
    const [briefId, workSpecId, workItemId] = await Promise.all([
      nextId(canonicalRoot, "requirements", "REQ", now),
      nextId(canonicalRoot, "specs", "SPEC", now),
      nextId(canonicalRoot, "tasks", "TASK", now),
    ]);
    const artifacts = createWorkArtifactsV2(draft, { briefId, workSpecId, workItemId });
    return Object.freeze({
      ...artifacts,
      approvalToken: workToken(canonicalRoot, context.state.revision, artifacts),
      workspaceRevision: context.state.revision,
      canonicalRoot,
      repository,
      state: context.state,
    });
  }

  async workPreview(draftValue: unknown): Promise<WorkPreview> {
    const prepared = await this.prepareWork(draftValue);
    return Object.freeze({
      brief: prepared.brief,
      workSpec: prepared.workSpec,
      workItem: prepared.workItem,
      approvalToken: prepared.approvalToken,
      workspaceRevision: prepared.workspaceRevision,
    });
  }

  async workApply(inputValue: unknown): Promise<AppliedWork> {
    const input = parseWorkApplyInput(inputValue);
    const prepared = await this.prepareWork(input.draft);
    if (prepared.approvalToken !== input.approvalToken) {
      throw new Error("Work approval token no longer matches the current workspace or contract");
    }
    const writes = [
      {
        relativePath: `requirements/${prepared.brief.id}.yaml`,
        content: serializeBriefArtifactV2(prepared.brief),
      },
      {
        relativePath: `specs/${prepared.workSpec.id}.yaml`,
        content: serializeWorkSpecArtifactV2(prepared.workSpec),
      },
      {
        relativePath: `tasks/${prepared.workItem.id}.yaml`,
        content: serializeWorkItemArtifactV2(prepared.workItem),
      },
    ];
    await assertMissing(prepared.canonicalRoot, writes.map((write) => write.relativePath));
    const nextState: WorkspaceState = {
      schemaVersion: 1,
      revision: prepared.state.revision + 1,
      activeWorkItem: {
        id: prepared.workItem.id,
        kind: "task",
        status: "planned",
        risk: workModeRisk(prepared.workSpec.workSpec.mode),
        revision: prepared.workItem.revision,
      },
      safeMode: false,
    };
    await prepared.repository.commitMutation(
      nextState,
      prepared.state.revision,
      "work-contract-approved",
      writes,
      {
        briefId: prepared.brief.id,
        workSpecId: prepared.workSpec.id,
        workItemId: prepared.workItem.id,
        mode: prepared.workSpec.workSpec.mode,
        sliceCount: prepared.workItem.slices.length,
        criterionCount: prepared.workSpec.workSpec.acceptanceCriteria.length,
      },
    );
    return Object.freeze({
      brief: prepared.brief,
      workSpec: prepared.workSpec,
      workItem: prepared.workItem,
      workspaceRevision: nextState.revision,
    });
  }

  async workReviewSlice(bundleValue: unknown): Promise<WorkSliceReviewResult> {
    const bundle = parseEvidenceBundle(bundleValue);
    const { canonicalRoot, repository, context } = await this.context(false);
    if (context.state.safeMode) throw new Error("workspace is in safe mode");
    const records = await readActiveWorkRecordsV2(canonicalRoot, context.state);
    if (records === null) throw new Error("active v1 Plan cannot use v2 Evidence review");
    if (bundle.workItemId !== records.workItem.id
      || bundle.workSpecId !== records.workSpec.id
      || bundle.workSpecRevision !== records.workSpec.revision) {
      throw new Error("Evidence bundle does not match the active Work Contract revision");
    }
    const sliceIndex = records.workItem.slices.findIndex(({ id }) => id === bundle.sliceId);
    const currentSlice = records.workItem.slices[sliceIndex];
    if (currentSlice === undefined || !["pending", "executing", "revise"].includes(currentSlice.status)) {
      throw new Error("Slice is not ready for Evidence review");
    }
    if (currentSlice.blockedBy.some((id) => (
      records.workItem.slices.find((slice) => slice.id === id)?.status !== "accepted"
    ))) {
      throw new Error("Slice dependencies must be accepted before Evidence review");
    }
    const coverage = reviewEvidenceCoverage(records.workSpec.workSpec, bundle);
    const revision = records.workItem.revision + 1;
    const slices = records.workItem.slices.map((slice, index) => (
      index === sliceIndex
        ? { ...slice, status: coverage.complete ? "accepted" as const : "revise" as const }
        : slice
    ));
    const allAccepted = slices.every(({ status }) => status === "accepted");
    const workItem: WorkItemArtifactV2 = {
      ...records.workItem,
      status: allAccepted ? "verifying" : "implementing",
      revision,
      slices,
    };
    const path = evidenceBundlePath(workItem.id, bundle.sliceId, revision);
    await assertMissing(canonicalRoot, [path]);
    const nextState: WorkspaceState = {
      ...context.state,
      revision: context.state.revision + 1,
      activeWorkItem: {
        id: workItem.id,
        kind: "task",
        status: workItem.status,
        risk: workModeRisk(records.workSpec.workSpec.mode),
        revision: workItem.revision,
      },
    };
    await repository.commitMutation(
      nextState,
      context.state.revision,
      "slice-evidence-reviewed",
      [
        { relativePath: `tasks/${workItem.id}.yaml`, content: serializeWorkItemArtifactV2(workItem) },
        { relativePath: path, content: serializeEvidenceBundle(bundle) },
      ],
      {
        workItemId: workItem.id,
        workSpecId: records.workSpec.id,
        workSpecRevision: records.workSpec.revision,
        workItemRevision: workItem.revision,
        sliceId: bundle.sliceId,
        evidenceCount: bundle.entries.length,
        coverageComplete: coverage.complete,
      },
    );
    return Object.freeze({
      workItem,
      coverage,
      evidencePath: path,
      workspaceRevision: nextState.revision,
    });
  }

  async selectPreview(draftValue: unknown): Promise<SelectionPreview> {
    const draft = parsePlanDraft(draftValue);
    const [{ context }, catalog] = await Promise.all([this.context(false), this.runtime.readCatalog()]);
    if (context.state.safeMode) throw new Error("workspace is in safe mode");
    const proposal = proposeExpertTeam(catalog.experts, requestFor(draft));
    return Object.freeze({
      ...proposal,
      vocabularyMismatches: vocabularyMismatches(draft, catalog),
      catalogFingerprint: catalog.fingerprint,
    });
  }

  private async prepareSharing(projectContextValue: unknown): Promise<PreparedSharing> {
    const projectContext = parseProjectContext(projectContextValue);
    const { canonicalRoot, repository, context } = await this.context(false);
    if (context.state.safeMode) throw new Error("workspace is in safe mode");
    if (context.project.gitTracking !== "none" && context.project.gitTracking !== "artifacts") {
      throw new Error("artifact sharing requires current gitTracking to be none or artifacts");
    }
    const existingProjectContext = await readProjectContext(canonicalRoot);
    return Object.freeze({
      currentGitTracking: context.project.gitTracking,
      targetGitTracking: "artifacts",
      writePaths: SHARING_WRITE_PATHS,
      sharedPaths: SHARED_ARTIFACT_PATHS,
      excludedPaths: EXCLUDED_LOCAL_PATHS,
      approvalToken: sharingToken(
        canonicalRoot,
        context.state.revision,
        context.project,
        existingProjectContext,
        projectContext,
      ),
      workspaceRevision: context.state.revision,
      canonicalRoot,
      repository,
      state: context.state,
      project: context.project,
      projectContext,
    });
  }

  async sharingPreview(projectContextValue: unknown): Promise<SharingPreview> {
    const prepared = await this.prepareSharing(projectContextValue);
    return Object.freeze({
      currentGitTracking: prepared.currentGitTracking,
      targetGitTracking: prepared.targetGitTracking,
      writePaths: prepared.writePaths,
      sharedPaths: prepared.sharedPaths,
      excludedPaths: prepared.excludedPaths,
      approvalToken: prepared.approvalToken,
      workspaceRevision: prepared.workspaceRevision,
    });
  }

  async sharingApply(inputValue: unknown): Promise<SharingApplyResult> {
    const input = parseSharingApplyInput(inputValue);
    const prepared = await this.prepareSharing(input.projectContext);
    if (prepared.approvalToken !== input.approvalToken) {
      throw new Error("sharing approval token no longer matches the current workspace or project context");
    }
    const project: ProjectConfig = { ...prepared.project, gitTracking: "artifacts" };
    const projectContextContents = serializeProjectContext(prepared.projectContext);
    const nextState: WorkspaceState = {
      ...prepared.state,
      revision: prepared.state.revision + 1,
    };
    await prepared.repository.commitMutation(
      nextState,
      prepared.state.revision,
      "artifact-sharing-approved",
      [
        { relativePath: "project.yaml", content: serializeProjectConfig(project) },
        { relativePath: PROJECT_CONTEXT_PATH, content: projectContextContents },
      ],
      {
        previousGitTracking: prepared.project.gitTracking,
        targetGitTracking: "artifacts",
        projectContextHash: knowledgeContentHash(projectContextContents),
        termCount: prepared.projectContext.terms.length,
        constraintCount: prepared.projectContext.constraints.length,
        sourceCount: prepared.projectContext.sources.length,
      },
    );
    return Object.freeze({
      gitTracking: "artifacts",
      projectContext: prepared.projectContext,
      workspaceRevision: nextState.revision,
    });
  }

  private async prepareKnowledgePromotion(draftValue: unknown): Promise<PreparedPromotion> {
    const draft = parseKnowledgePromotionDraft(draftValue);
    const { canonicalRoot, repository, context } = await this.context(false);
    if (context.state.safeMode) throw new Error("workspace is in safe mode");
    if (context.project.gitTracking !== "artifacts") {
      throw new Error("Knowledge promotion requires gitTracking artifacts");
    }
    const sourcePath = knowledgeRecordPath(draft.sourceSpecId);
    const sourceContents = await readBoundedText(
      join(workspacePaths(canonicalRoot).root, ...sourcePath.split("/")),
      256 * 1024,
    );
    const source = parseKnowledgeRecordMarkdown(sourceContents);
    if (source.specId !== draft.sourceSpecId) {
      throw new Error("Knowledge promotion source identity does not match its filename");
    }
    const sourceKnowledgeHash = knowledgeContentHash(sourceContents);
    const pattern = createKnowledgePattern(draft, source.taskId, sourceKnowledgeHash);
    const targetPath = knowledgePatternPath(pattern.sourceSpecId);
    await assertMissing(canonicalRoot, [targetPath]);
    return Object.freeze({
      pattern,
      targetPath,
      approvalToken: promotionToken(
        canonicalRoot,
        context.state.revision,
        context.project,
        pattern,
        targetPath,
      ),
      workspaceRevision: context.state.revision,
      canonicalRoot,
      repository,
      state: context.state,
      sourceKnowledgeHash,
    });
  }

  async knowledgePromotionPreview(draftValue: unknown): Promise<KnowledgePromotionPreview> {
    const prepared = await this.prepareKnowledgePromotion(draftValue);
    return Object.freeze({
      pattern: prepared.pattern,
      targetPath: prepared.targetPath,
      approvalToken: prepared.approvalToken,
      workspaceRevision: prepared.workspaceRevision,
    });
  }

  async knowledgePromotionApply(inputValue: unknown): Promise<KnowledgePromotionApplyResult> {
    const input = parsePromotionApplyInput(inputValue);
    const prepared = await this.prepareKnowledgePromotion(input.draft);
    if (prepared.approvalToken !== input.approvalToken) {
      throw new Error("Knowledge promotion approval token no longer matches the source or workspace");
    }
    const contents = serializeKnowledgePattern(prepared.pattern);
    const patternHash = knowledgeContentHash(contents);
    const nextState: WorkspaceState = {
      ...prepared.state,
      revision: prepared.state.revision + 1,
    };
    await prepared.repository.commitMutation(
      nextState,
      prepared.state.revision,
      "knowledge-pattern-approved",
      [{ relativePath: prepared.targetPath, content: contents }],
      {
        sourceSpecId: prepared.pattern.sourceSpecId,
        sourceTaskId: prepared.pattern.sourceTaskId,
        sourceKnowledgeHash: prepared.sourceKnowledgeHash,
        targetPath: prepared.targetPath,
        patternHash,
        tagCount: prepared.pattern.tags.length,
        guidanceCount: prepared.pattern.guidance.length,
        constraintCount: prepared.pattern.constraints.length,
      },
    );
    return Object.freeze({
      pattern: prepared.pattern,
      targetPath: prepared.targetPath,
      patternHash,
      workspaceRevision: nextState.revision,
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
    assertKnownSelectionContext(prepared.vocabularyMismatches);
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

  private async prepareReplan(input: PlanPreviewInput): Promise<PreparedReplan> {
    const { canonicalRoot, context } = await this.context(false);
    if (context.state.safeMode) throw new Error("workspace is in safe mode");
    const [catalog, activeExperts] = await Promise.all([
      this.runtime.readCatalog(),
      this.runtime.readActiveExperts(canonicalRoot),
    ]);
    const current = await readActiveRecords(canonicalRoot, context.state, activeExperts);
    if (current.team.catalogFingerprint !== catalog.fingerprint) {
      throw new Error("approved expert team catalog fingerprint no longer matches runtime catalog");
    }
    const proposal = proposeExpertTeam(catalog.experts, requestFor(input.draft));
    if (proposal.selectionFingerprint !== input.selectionFingerprint) {
      throw new Error("selection fingerprint no longer matches the replacement Plan and catalog");
    }
    const spec: SpecArtifact = {
      schemaVersion: 1,
      id: current.spec.id,
      requirementId: current.requirement.id,
      status: "approved",
      revision: current.spec.revision + 1,
      ...input.draft.spec,
    };
    const task: TaskArtifact = {
      schemaVersion: 1,
      id: current.task.id,
      requirementId: current.requirement.id,
      specId: current.spec.id,
      status: "planned",
      revision: current.task.revision + 1,
      ...input.draft.task,
    };
    const nextTeam = finalizeExpertTeam(proposal, input.assignments, {
      teamRevision: current.team.teamRevision + 1,
      requirementId: current.requirement.id,
      specId: current.spec.id,
      taskId: current.task.id,
      taskRevision: task.revision,
      catalogFingerprint: catalog.fingerprint,
    });
    const diff = diffExpertTeams(current.team, nextTeam);
    return {
      requirement: current.requirement,
      spec,
      task,
      previousTeam: current.team,
      nextTeam,
      diff,
      blockers: proposal.blockers,
      vocabularyMismatches: vocabularyMismatches(input.draft, catalog),
      approvalToken: replanToken(
        canonicalRoot,
        context.state.revision,
        current.team,
        nextTeam,
        diff,
        input.largeTeamDecision,
      ),
      workspaceRevision: context.state.revision,
      canonicalRoot,
      state: context.state,
      activeExperts,
    };
  }

  async replanPreview(inputValue: unknown): Promise<ReplanPreview> {
    const prepared = await this.prepareReplan(parsePreviewInput(inputValue));
    return {
      requirement: prepared.requirement,
      spec: prepared.spec,
      task: prepared.task,
      previousTeam: prepared.previousTeam,
      nextTeam: prepared.nextTeam,
      diff: prepared.diff,
      blockers: prepared.blockers,
      vocabularyMismatches: prepared.vocabularyMismatches,
      approvalToken: prepared.approvalToken,
      workspaceRevision: prepared.workspaceRevision,
    };
  }

  async replanApply(inputValue: unknown): Promise<AppliedPlan & { readonly diff: TeamDiff }> {
    const input = parseApplyInput(inputValue);
    const prepared = await this.prepareReplan(input);
    if (prepared.approvalToken !== input.approvalToken) {
      throw new Error("approval token no longer matches the current replan diff or workspace revision");
    }
    assertKnownSelectionContext(prepared.vocabularyMismatches);
    if (prepared.blockers.includes("capability-uncovered")) {
      throw new Error("replacement Plan has uncovered capabilities");
    }
    if (prepared.blockers.includes("independent-reviewer-missing")) {
      throw new Error("replacement Plan has no independent reviewer");
    }
    if (prepared.blockers.includes("large-team-review-required")
      && input.largeTeamDecision !== "accepted") {
      throw new Error("large team requires an explicitly accepted replacement Plan decision");
    }

    const active = replaceActiveTeam(
      prepared.activeExperts,
      prepared.previousTeam,
      prepared.nextTeam,
    );
    const historyPath = teamHistoryPath(prepared.task.id, prepared.nextTeam.teamRevision);
    await assertMissing(prepared.canonicalRoot, [historyPath]);
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
      "plan-replanned",
      [
        { relativePath: `specs/${prepared.spec.id}.yaml`, content: serializeSpecArtifact(prepared.spec) },
        { relativePath: `tasks/${prepared.task.id}.yaml`, content: serializeTaskArtifact(prepared.task) },
        { relativePath: historyPath, content: serializeExpertTeamPlan(prepared.nextTeam) },
        { relativePath: "experts/active.yaml", content: serializeActiveExperts(active) },
      ],
      {
        requirementId: prepared.requirement.id,
        specId: prepared.spec.id,
        taskId: prepared.task.id,
        teamRevision: prepared.nextTeam.teamRevision,
        addedCount: prepared.diff.added.length,
        removedCount: prepared.diff.removed.length,
        changedCount: prepared.diff.changed.length,
        teamFingerprint: prepared.nextTeam.teamFingerprint,
      },
    );
    return {
      requirement: prepared.requirement,
      spec: prepared.spec,
      task: prepared.task,
      team: prepared.nextTeam,
      blockers: prepared.blockers,
      vocabularyMismatches: prepared.vocabularyMismatches,
      workspaceRevision: nextState.revision,
      diff: prepared.diff,
    };
  }

  async retireTeam(
    taskId: string,
    expectedTaskRevision: number,
    to: "cancelled",
  ): Promise<void> {
    const { canonicalRoot, context } = await this.context(false);
    if (context.state.safeMode) throw new Error("workspace is in safe mode");
    const active = context.state.activeWorkItem;
    if (active === null
      || active.kind !== "task"
      || active.id !== taskId
      || active.revision !== expectedTaskRevision) {
      throw new Error("active Task revision does not match expert team retirement request");
    }
    const activeExperts = await this.runtime.readActiveExperts(canonicalRoot);
    const records = await readActiveRecords(canonicalRoot, context.state, activeExperts);
    const task: TaskArtifact = {
      ...records.task,
      status: to,
      revision: records.task.revision + 1,
    };
    const retired = retireActiveTeam(activeExperts, records.team);
    const nextState: WorkspaceState = {
      ...context.state,
      revision: context.state.revision + 1,
      activeWorkItem: null,
    };
    await this.runtime.createRepository(canonicalRoot).commitMutation(
      nextState,
      context.state.revision,
      "expert-team-retired",
      [
        { relativePath: `tasks/${task.id}.yaml`, content: serializeTaskArtifact(task) },
        { relativePath: "experts/active.yaml", content: serializeActiveExperts(retired) },
      ],
      {
        taskId: task.id,
        terminalStatus: to,
        taskRevision: task.revision,
        teamRevision: records.team.teamRevision,
        teamFingerprint: records.team.teamFingerprint,
      },
    );
  }

  async completeActiveTask(
    expectedTaskRevision: number,
    inputValue: unknown,
  ): Promise<KnowledgeCaptureResult> {
    const input = parseKnowledgeCaptureInput(inputValue);
    const { canonicalRoot, context } = await this.context(false);
    if (context.state.safeMode) throw new Error("workspace is in safe mode");
    const active = context.state.activeWorkItem;
    if (active === null || active.kind !== "task") throw new Error("no active Task to complete");
    const activeExperts = await this.runtime.readActiveExperts(canonicalRoot);
    const records = await readActiveRecords(canonicalRoot, context.state, activeExperts);
    assertQualityGateReceipts(records.task.qualityGates, input.qualityGateReceipts);
    const activeWorkItem = transitionWorkItem(active, {
      to: "completed",
      expectedRevision: expectedTaskRevision,
    });
    const task: TaskArtifact = {
      ...records.task,
      status: activeWorkItem.status,
      revision: activeWorkItem.revision,
    };
    const knowledge = createKnowledgeRecord(records.spec.id, task.id, input);
    const knowledgePath = knowledgeRecordPath(records.spec.id);
    const knowledgeContents = serializeKnowledgeRecord(knowledge);
    parseKnowledgeRecordMarkdown(knowledgeContents);
    await assertMissing(canonicalRoot, [knowledgePath]);
    const knowledgeHash = knowledgeContentHash(knowledgeContents);
    const retired = retireActiveTeam(activeExperts, records.team);
    const nextState: WorkspaceState = {
      ...context.state,
      revision: context.state.revision + 1,
      activeWorkItem: null,
    };
    await this.runtime.createRepository(canonicalRoot).commitMutation(
      nextState,
      context.state.revision,
      "task-completed",
      [
        { relativePath: `tasks/${task.id}.yaml`, content: serializeTaskArtifact(task) },
        { relativePath: "experts/active.yaml", content: serializeActiveExperts(retired) },
        { relativePath: knowledgePath, content: knowledgeContents },
      ],
      {
        taskId: task.id,
        specId: records.spec.id,
        taskRevision: task.revision,
        teamRevision: records.team.teamRevision,
        teamFingerprint: records.team.teamFingerprint,
        knowledgePath,
        knowledgeHash,
        verificationEvidenceCount: knowledge.verificationEvidence.length,
        qualityGateReceiptCount: knowledge.qualityGateReceipts.length,
      },
    );
    return Object.freeze({ state: nextState, task, knowledge, knowledgePath, knowledgeHash });
  }

  async transitionActiveTask(
    to: WorkItemStatus,
    expectedTaskRevision: number,
  ): Promise<WorkspaceState> {
    if (to === "cancelled" || to === "completed") {
      throw new Error("terminal Task transitions must use the lifecycle retirement gate");
    }
    const { canonicalRoot, context } = await this.context(false);
    if (context.state.safeMode) throw new Error("workspace is in safe mode");
    const activeExperts = await this.runtime.readActiveExperts(canonicalRoot);
    const records = await readActiveRecords(canonicalRoot, context.state, activeExperts);
    const activeWorkItem = transitionWorkItem(context.state.activeWorkItem!, {
      to,
      expectedRevision: expectedTaskRevision,
    });
    const task: TaskArtifact = {
      ...records.task,
      status: activeWorkItem.status,
      revision: activeWorkItem.revision,
    };
    const nextState: WorkspaceState = {
      ...context.state,
      revision: context.state.revision + 1,
      activeWorkItem,
    };
    await this.runtime.createRepository(canonicalRoot).commitMutation(
      nextState,
      context.state.revision,
      "work-item-transitioned",
      [{ relativePath: `tasks/${task.id}.yaml`, content: serializeTaskArtifact(task) }],
      {},
    );
    return nextState;
  }

  async activeTeamRecord(): Promise<ExpertTeamPlan | null> {
    const { canonicalRoot, context } = await this.context(false);
    if (context.state.safeMode) throw new Error("workspace is in safe mode");
    if (context.state.activeWorkItem === null) return null;
    const activeExperts = await this.runtime.readActiveExperts(canonicalRoot);
    return (await readActiveRecords(canonicalRoot, context.state, activeExperts)).team;
  }

  async knowledgeContext(queryValue: unknown): Promise<KnowledgeSelection> {
    const query = parseKnowledgeContextQuery(queryValue);
    const { canonicalRoot, context } = await this.context(false);
    if (context.state.safeMode) throw new Error("workspace is in safe mode");
    return selectKnowledge(query, await readKnowledgeCandidates(canonicalRoot));
  }

  async resumeContext(): Promise<WorkflowResumeContext> {
    const { canonicalRoot, context } = await this.context(false);
    let projectContext: ProjectContext | null;
    try {
      projectContext = await readProjectContext(canonicalRoot);
    } catch {
      return freezeWorkflowResumeContext({
        workspaceRevision: context.state.revision,
        safeMode: true,
        recovered: context.recovered,
        recoveryStatus: "inspection-required",
        projectContext: null,
        requirement: null,
        spec: null,
        task: null,
        team: null,
        knowledge: [],
        blockers: ["project-context-corrupt"],
      });
    }
    let knowledge: readonly ResumeKnowledge[];
    try {
      knowledge = await readRecentKnowledge(canonicalRoot);
    } catch {
      return freezeWorkflowResumeContext({
        workspaceRevision: context.state.revision,
        safeMode: true,
        recovered: context.recovered,
        recoveryStatus: "inspection-required",
        projectContext,
        requirement: null,
        spec: null,
        task: null,
        team: null,
        knowledge: [],
        blockers: ["knowledge-corrupt"],
      });
    }
    if (context.state.safeMode) {
      return freezeWorkflowResumeContext({
        workspaceRevision: context.state.revision,
        safeMode: true,
        recovered: context.recovered,
        recoveryStatus: "inspection-required",
        projectContext,
        requirement: null,
        spec: null,
        task: null,
        team: null,
        knowledge,
        blockers: ["workspace-safe-mode"],
      });
    }
    if (context.state.activeWorkItem === null) {
      return freezeWorkflowResumeContext({
        workspaceRevision: context.state.revision,
        safeMode: false,
        recovered: context.recovered,
        recoveryStatus: "ready",
        projectContext,
        requirement: null,
        spec: null,
        task: null,
        team: null,
        knowledge,
        blockers: [],
      });
    }

    try {
      const v2Records = await readActiveWorkRecordsV2(canonicalRoot, context.state);
      if (v2Records !== null) {
        return freezeWorkflowResumeContext({
          workspaceRevision: context.state.revision,
          safeMode: false,
          recovered: context.recovered,
          recoveryStatus: "ready",
          projectContext,
          requirement: {
            sourceSchemaVersion: 2,
            id: v2Records.brief.id,
            title: v2Records.brief.brief.requestSummary,
            status: v2Records.brief.status,
            revision: v2Records.brief.revision,
          },
          spec: {
            sourceSchemaVersion: 2,
            id: v2Records.workSpec.id,
            requirementId: v2Records.brief.id,
            goal: v2Records.workSpec.workSpec.outcome,
            status: v2Records.workSpec.status,
            revision: v2Records.workSpec.revision,
            mode: v2Records.workSpec.workSpec.mode,
          },
          task: {
            sourceSchemaVersion: 2,
            id: v2Records.workItem.id,
            specId: v2Records.workSpec.id,
            title: v2Records.workItem.title,
            status: v2Records.workItem.status,
            risk: workModeRisk(v2Records.workSpec.workSpec.mode),
            revision: v2Records.workItem.revision,
            slices: v2Records.workItem.slices.map((slice) => ({
              id: slice.id,
              title: slice.title,
              intendedOutcome: slice.intendedOutcome,
              status: slice.status,
              humanCheckpoint: slice.humanCheckpoint,
            })),
          },
          team: null,
          knowledge,
          blockers: [],
        });
      }
      const [catalog, activeExperts] = await Promise.all([
        this.runtime.readCatalog(),
        this.runtime.readActiveExperts(canonicalRoot),
      ]);
      const records = await readActiveRecords(canonicalRoot, context.state, activeExperts);
      if (records.team.catalogFingerprint !== catalog.fingerprint) {
        throw new Error("catalog fingerprint mismatch");
      }
      const members = records.team.members.map((member) => {
        const expert = catalog.byId.get(member.expertId);
        if (expert === undefined) throw new Error("approved expert is absent from runtime catalog");
        return {
          expertId: member.expertId,
          nameZh: expert.nameZh,
          mode: member.mode,
          reasons: member.reasons,
        };
      });
      return freezeWorkflowResumeContext({
        workspaceRevision: context.state.revision,
        safeMode: false,
        recovered: context.recovered,
        recoveryStatus: "ready",
        projectContext,
        requirement: {
          sourceSchemaVersion: 1,
          id: records.requirement.id,
          title: records.requirement.title,
          status: records.requirement.status,
          revision: records.requirement.revision,
        },
        spec: {
          sourceSchemaVersion: 1,
          id: records.spec.id,
          requirementId: records.spec.requirementId,
          goal: records.spec.goal,
          status: records.spec.status,
          revision: records.spec.revision,
          mode: null,
        },
        task: {
          sourceSchemaVersion: 1,
          id: records.task.id,
          specId: records.task.specId,
          title: records.task.title,
          status: records.task.status,
          risk: records.task.risk,
          revision: records.task.revision,
          slices: [],
        },
        team: {
          teamRevision: records.team.teamRevision,
          taskId: records.team.taskId,
          taskRevision: records.team.taskRevision,
          teamFingerprint: records.team.teamFingerprint,
          catalogFingerprint: records.team.catalogFingerprint,
          members,
        },
        knowledge,
        blockers: [],
      });
    } catch {
      return freezeWorkflowResumeContext({
        workspaceRevision: context.state.revision,
        safeMode: true,
        recovered: context.recovered,
        recoveryStatus: "inspection-required",
        projectContext,
        requirement: null,
        spec: null,
        task: null,
        team: null,
        knowledge,
        blockers: ["active-plan-corrupt"],
      });
    }
  }
}
