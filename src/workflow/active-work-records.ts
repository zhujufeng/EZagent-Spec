import { lstat, readFile, readdir } from "node:fs/promises";
import { join } from "node:path";

import type { ActiveExperts } from "../experts/active.js";
import { workspacePaths } from "../workspace/layout.js";
import type { WorkspaceState } from "../workspace/schema.js";
import {
  parseRequirementArtifactYaml,
  parseSpecArtifactYaml,
  parseTaskArtifactYaml,
  type RequirementArtifact,
  type SpecArtifact,
  type TaskArtifact,
} from "./plan-artifacts.js";
import {
  parseSpecialistPlanV2,
  type SpecialistDelegationV2,
  type SpecialistPlanV2,
} from "./specialist-plan.js";
import {
  parseBriefArtifactV2Yaml,
  parseWorkItemArtifactV2Yaml,
  parseWorkSpecArtifactV2Yaml,
  workModeRisk,
  type BriefArtifactV2,
  type WorkItemArtifactV2,
  type WorkSpecArtifactV2,
} from "./work-artifacts.js";
import { parseExpertTeamPlan, type ExpertTeamPlan } from "./team-record.js";
import {
  createDelegationDispatch,
  delegationDispatchFingerprint,
  delegationCompletionReceiptPath,
  delegationStartReceiptPath,
  parseDelegationCompletionReceipt,
  parseDelegationStartReceipt,
  type DelegationCompletionReceipt,
  type DelegationStartReceipt,
} from "./delegation-receipt.js";

function portableCompare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

export interface ActiveRecords {
  readonly requirement: RequirementArtifact;
  readonly spec: SpecArtifact;
  readonly task: TaskArtifact;
  readonly team: ExpertTeamPlan;
  readonly activeExperts: ActiveExperts;
}

export interface ActiveWorkRecordsV2 {
  readonly brief: BriefArtifactV2;
  readonly workSpec: WorkSpecArtifactV2;
  readonly workItem: WorkItemArtifactV2;
  readonly specialistPlan: SpecialistPlanV2 | null;
}

export interface DelegationCoverageEntry {
  readonly delegationId: string;
  readonly expertId: string;
  readonly status: "completed" | "blocked" | "missing";
}

export interface DelegationCoverage {
  readonly complete: boolean;
  readonly delegations: readonly DelegationCoverageEntry[];
}

export async function readBoundedText(path: string, maximumBytes = 1_048_576): Promise<string> {
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

async function specialistPlanHistory(
  root: string,
  workItemId: string,
): Promise<readonly SpecialistPlanV2[]> {
  const directory = join(workspacePaths(root).root, "experts", "plans", workItemId);
  let names: string[];
  try {
    names = await readdir(directory);
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return Object.freeze([]);
    throw error;
  }
  if (names.length === 0 || names.some((name) => !/^\d{6,}\.json$/u.test(name))) {
    throw new Error("Specialist Plan history is missing or malformed");
  }
  return Object.freeze(await Promise.all([...names].sort(portableCompare).map(async (name) => {
    const value: unknown = JSON.parse(await readBoundedText(join(directory, name)));
    const plan = parseSpecialistPlanV2(value);
    if (plan.workItemId !== workItemId
      || name !== `${String(plan.revision).padStart(6, "0")}.json`) {
      throw new Error("Specialist Plan history identity mismatch");
    }
    return plan;
  })));
}

async function latestSpecialistPlan(
  root: string,
  workItemId: string,
): Promise<SpecialistPlanV2 | null> {
  const directory = join(workspacePaths(root).root, "experts", "plans", workItemId);
  let names: string[];
  try {
    names = await readdir(directory);
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  if (names.length === 0 || names.some((name) => !/^\d{6,}\.json$/u.test(name))) {
    throw new Error("Specialist Plan history is missing or malformed");
  }
  const name = [...names].sort(portableCompare).at(-1)!;
  const value: unknown = JSON.parse(await readBoundedText(join(directory, name)));
  const plan = parseSpecialistPlanV2(value);
  if (plan.workItemId !== workItemId
    || name !== `${String(plan.revision).padStart(6, "0")}.json`) {
    throw new Error("Specialist Plan history identity mismatch");
  }
  return plan;
}

async function readDelegationStartReceipt(
  root: string,
  workItemId: string,
  delegationId: string,
  planRevision?: number,
): Promise<DelegationStartReceipt | null> {
  const relativePath = delegationStartReceiptPath(workItemId, delegationId, planRevision);
  try {
    return parseDelegationStartReceipt(JSON.parse(await readBoundedText(
      join(workspacePaths(root).root, ...relativePath.split("/")),
    )) as unknown);
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

async function readDelegationCompletionReceipt(
  root: string,
  workItemId: string,
  delegationId: string,
  planRevision?: number,
): Promise<DelegationCompletionReceipt | null> {
  const relativePath = delegationCompletionReceiptPath(workItemId, delegationId, planRevision);
  try {
    return parseDelegationCompletionReceipt(JSON.parse(await readBoundedText(
      join(workspacePaths(root).root, ...relativePath.split("/")),
    )) as unknown);
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

export function receiptPlanRevision(plan: SpecialistPlanV2): number | undefined {
  return plan.revision === 1 ? undefined : plan.revision;
}

export async function readCurrentDelegationStartReceipt(
  root: string,
  plan: SpecialistPlanV2,
  delegationId: string,
): Promise<DelegationStartReceipt | null> {
  const current = await readDelegationStartReceipt(
    root,
    plan.workItemId,
    delegationId,
    receiptPlanRevision(plan),
  );
  if (current !== null || plan.revision === 1) return current;
  const legacy = await readDelegationStartReceipt(root, plan.workItemId, delegationId);
  return legacy?.planFingerprint === plan.planFingerprint ? legacy : null;
}

export async function readCurrentDelegationCompletionReceipt(
  root: string,
  plan: SpecialistPlanV2,
  delegationId: string,
): Promise<DelegationCompletionReceipt | null> {
  const current = await readDelegationCompletionReceipt(
    root,
    plan.workItemId,
    delegationId,
    receiptPlanRevision(plan),
  );
  if (current !== null || plan.revision === 1) return current;
  const legacy = await readDelegationCompletionReceipt(root, plan.workItemId, delegationId);
  return legacy?.planFingerprint === plan.planFingerprint ? legacy : null;
}

function receiptMatchesDelegation(
  receipt: DelegationCompletionReceipt,
  delegation: SpecialistDelegationV2,
  planFingerprint: `sha256:${string}`,
): boolean {
  return receipt.planFingerprint === planFingerprint
    && receipt.delegationId === delegation.id
    && receipt.expertId === delegation.expertId
    && receipt.workItemId === delegation.workItemId
    && receipt.workSpecId === delegation.workSpecId
    && receipt.workSpecRevision === delegation.workSpecRevision
    && receipt.sliceId === delegation.sliceId
    && (receipt.schemaVersion === 1
      || receipt.dispatchFingerprint === delegationDispatchFingerprint(
        createDelegationDispatch(delegation),
      ));
}

async function readCompatibleDelegationCompletionReceipt(
  root: string,
  planHistory: readonly SpecialistPlanV2[],
  activeDelegation: SpecialistDelegationV2,
): Promise<DelegationCompletionReceipt | null> {
  const [legacy, ...versioned] = await Promise.all([
    readDelegationCompletionReceipt(root, activeDelegation.workItemId, activeDelegation.id),
    ...planHistory.filter(({ revision }) => revision > 1).map(({ revision }) => (
      readDelegationCompletionReceipt(
        root,
        activeDelegation.workItemId,
        activeDelegation.id,
        revision,
      )
    )),
  ]);
  const candidates = [legacy, ...versioned].filter(
    (receipt): receipt is DelegationCompletionReceipt => receipt !== null,
  ).map((receipt) => {
    const originPlan = planHistory.find(({ planFingerprint }) => (
      planFingerprint === receipt.planFingerprint
    ));
    const originDelegation = originPlan?.delegations.find(({ id }) => id === receipt.delegationId);
    if (originPlan === undefined
      || originDelegation === undefined
      || !receiptMatchesDelegation(receipt, originDelegation, originPlan.planFingerprint)) {
      throw new Error("Delegation completion receipt does not match its Specialist Plan history");
    }
    return { receipt, originPlan, originDelegation };
  }).sort((left, right) => right.originPlan.revision - left.originPlan.revision);
  return candidates.find(({ originDelegation }) => (
    JSON.stringify(originDelegation) === JSON.stringify(activeDelegation)
  ))?.receipt ?? null;
}

export async function reviewDelegationCoverage(
  root: string,
  records: ActiveWorkRecordsV2,
  sliceId: string,
): Promise<DelegationCoverage> {
  const plan = records.specialistPlan;
  if (plan === null) return Object.freeze({ complete: true, delegations: Object.freeze([]) });
  const planHistory = await specialistPlanHistory(root, plan.workItemId);
  const required = plan.delegations.filter((delegation) => delegation.sliceId === sliceId);
  const delegations = await Promise.all(required.map(async (delegation): Promise<DelegationCoverageEntry> => {
    const receipt = await readCompatibleDelegationCompletionReceipt(root, planHistory, delegation);
    if (receipt === null) {
      return Object.freeze({ delegationId: delegation.id, expertId: delegation.expertId, status: "missing" });
    }
    return Object.freeze({
      delegationId: delegation.id,
      expertId: delegation.expertId,
      status: receipt.status,
    });
  }));
  return Object.freeze({
    complete: delegations.every(({ status }) => status === "completed"),
    delegations: Object.freeze(delegations),
  });
}

export async function assertNoUnfinishedDelegations(
  root: string,
  plan: SpecialistPlanV2,
): Promise<void> {
  for (const delegation of plan.delegations) {
    const [start, completion] = await Promise.all([
      readCurrentDelegationStartReceipt(root, plan, delegation.id),
      readCurrentDelegationCompletionReceipt(root, plan, delegation.id),
    ]);
    if (completion !== null && start === null) {
      throw new Error("Delegation receipt history is inconsistent");
    }
    if (start !== null && completion === null) {
      throw new Error(`Specialist replan has an unfinished Delegation: ${delegation.id}`);
    }
    if (start !== null && (start.expertId !== delegation.expertId
      || start.planFingerprint !== plan.planFingerprint
      || start.sliceId !== delegation.sliceId
      || (start.schemaVersion === 2
        && start.dispatchFingerprint !== delegationDispatchFingerprint(
          createDelegationDispatch(delegation),
        )))) {
      throw new Error("Delegation start receipt does not match the active Specialist Plan");
    }
    if (completion !== null && (completion.expertId !== delegation.expertId
      || completion.planFingerprint !== plan.planFingerprint
      || completion.sliceId !== delegation.sliceId
      || (completion.schemaVersion === 2
        && completion.dispatchFingerprint !== delegationDispatchFingerprint(
          createDelegationDispatch(delegation),
        )))) {
      throw new Error("Delegation completion receipt does not match the active Specialist Plan");
    }
  }
}

export async function readActiveRecords(
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

export async function readActiveWorkRecordsV2(
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
  const specialistPlan = await latestSpecialistPlan(root, workItem.id);
  if (specialistPlan !== null
    && (specialistPlan.workSpecId !== workSpec.id
      || specialistPlan.workSpecRevision !== workSpec.revision)) {
    throw new Error("Specialist Plan does not match the active Work Spec");
  }
  return Object.freeze({ brief, workSpec, workItem, specialistPlan });
}
