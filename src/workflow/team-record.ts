import { createHash } from "node:crypto";

import { z } from "zod";

import { isWorkItemId } from "../domain/id.js";
import type { PlanRisk } from "./plan-artifacts.js";

export type ExpertTeamMode = "analysis" | "implement" | "review";

export interface ExpertTeamMember {
  readonly expertId: string;
  readonly mode: ExpertTeamMode;
  readonly reasons: readonly string[];
  readonly scope: readonly string[];
  readonly deliverables: readonly string[];
  readonly qualityGates: readonly string[];
}

export interface ExpertTeamPlan {
  readonly schemaVersion: 1;
  readonly teamRevision: number;
  readonly requirementId: string;
  readonly specId: string;
  readonly taskId: string;
  readonly taskRevision: number;
  readonly selectionRequest: {
    readonly capabilities: readonly string[];
    readonly domains: readonly string[];
    readonly projectSignals: readonly string[];
    readonly risk: PlanRisk;
    readonly reviewAfter: number;
  };
  readonly members: readonly ExpertTeamMember[];
  readonly uncoveredCapabilities: readonly string[];
  readonly requiresPlanReview: boolean;
  readonly catalogFingerprint: `sha256:${string}`;
  readonly selectionFingerprint: `sha256:${string}`;
  readonly teamFingerprint: `sha256:${string}`;
}

const EXPERT_ID = /^ezagent\.[a-z0-9]+(?:-[a-z0-9]+)*(?:\.[a-z0-9]+(?:-[a-z0-9]+)*)*$/u;
const TOKEN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;
const HASH = /^sha256:[0-9a-f]{64}$/u;
const CONTROL = /[\u0000-\u001f\u007f]/u;

function workItemId(prefix: "REQ" | "SPEC" | "TASK") {
  return z.string().refine(
    (value) => value.startsWith(`${prefix}-`) && isWorkItemId(value),
    `invalid ${prefix} ID`,
  );
}

const boundedText = z.string().min(1).max(4_096)
  .refine((value) => value === value.trim() && value === value.normalize("NFC") && !CONTROL.test(value));
const textList = z.array(boundedText).min(1).max(128);
const tokenList = z.array(z.string().min(1).max(64).regex(TOKEN)).max(512);

const memberSchema = z.object({
  expertId: z.string().max(160).regex(EXPERT_ID),
  mode: z.enum(["analysis", "implement", "review"]),
  reasons: textList,
  scope: textList,
  deliverables: textList,
  qualityGates: textList,
}).strict();

const teamBaseSchema = z.object({
  schemaVersion: z.literal(1),
  teamRevision: z.number().int().positive(),
  requirementId: workItemId("REQ"),
  specId: workItemId("SPEC"),
  taskId: workItemId("TASK"),
  taskRevision: z.number().int().nonnegative(),
  selectionRequest: z.object({
    capabilities: tokenList.min(1),
    domains: tokenList,
    projectSignals: tokenList,
    risk: z.enum(["light", "standard", "high"]),
    reviewAfter: z.number().int().nonnegative().max(4_096),
  }).strict(),
  members: z.array(memberSchema).min(1).max(4_096),
  uncoveredCapabilities: tokenList,
  requiresPlanReview: z.boolean(),
  catalogFingerprint: z.string().regex(HASH),
  selectionFingerprint: z.string().regex(HASH),
}).strict();

const teamSchema = teamBaseSchema.extend({
  teamFingerprint: z.string().regex(HASH),
}).strict();

function portableCompare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function sortedUnique(values: readonly string[], label: string): readonly string[] {
  const sorted = [...values].sort(portableCompare);
  if (new Set(sorted).size !== sorted.length) throw new TypeError(`${label} contains duplicates`);
  return Object.freeze(sorted);
}

function canonicalBase(value: z.infer<typeof teamBaseSchema>): Omit<ExpertTeamPlan, "teamFingerprint"> {
  const members = [...value.members]
    .sort((left, right) => portableCompare(left.expertId, right.expertId))
    .map((member) => Object.freeze({
      ...member,
      reasons: sortedUnique(member.reasons, `${member.expertId} reasons`),
      scope: sortedUnique(member.scope, `${member.expertId} scope`),
      deliverables: sortedUnique(member.deliverables, `${member.expertId} deliverables`),
      qualityGates: sortedUnique(member.qualityGates, `${member.expertId} quality gates`),
    }));
  if (new Set(members.map((member) => member.expertId)).size !== members.length) {
    throw new TypeError("expert team contains duplicate members");
  }
  return Object.freeze({
    ...value,
    selectionRequest: Object.freeze({
      ...value.selectionRequest,
      capabilities: sortedUnique(value.selectionRequest.capabilities, "capabilities"),
      domains: sortedUnique(value.selectionRequest.domains, "domains"),
      projectSignals: sortedUnique(value.selectionRequest.projectSignals, "project signals"),
    }),
    members: Object.freeze(members),
    uncoveredCapabilities: sortedUnique(value.uncoveredCapabilities, "uncovered capabilities"),
    catalogFingerprint: value.catalogFingerprint as `sha256:${string}`,
    selectionFingerprint: value.selectionFingerprint as `sha256:${string}`,
  });
}

function digest(value: unknown): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(JSON.stringify(value)).digest("hex")}`;
}

export function createExpertTeamPlan(
  value: Omit<ExpertTeamPlan, "teamFingerprint">,
): ExpertTeamPlan {
  const base = canonicalBase(teamBaseSchema.parse(value));
  return Object.freeze({ ...base, teamFingerprint: digest(base) });
}

export function parseExpertTeamPlan(value: unknown): ExpertTeamPlan {
  const parsed = teamSchema.parse(value);
  const { teamFingerprint, ...base } = parsed;
  const expected = createExpertTeamPlan({
    ...base,
    catalogFingerprint: base.catalogFingerprint as `sha256:${string}`,
    selectionFingerprint: base.selectionFingerprint as `sha256:${string}`,
  });
  if (teamFingerprint !== expected.teamFingerprint) {
    throw new TypeError("expert team fingerprint mismatch");
  }
  return expected;
}

export function serializeExpertTeamPlan(value: ExpertTeamPlan): string {
  return `${JSON.stringify(parseExpertTeamPlan(value), null, 2)}\n`;
}

export function teamHistoryPath(taskId: string, teamRevision: number): string {
  if (!taskId.startsWith("TASK-") || !isWorkItemId(taskId)) throw new TypeError("invalid Task ID");
  if (!Number.isSafeInteger(teamRevision) || teamRevision < 1) {
    throw new TypeError("team revision must be a positive safe integer");
  }
  return `experts/teams/${taskId}/${String(teamRevision).padStart(6, "0")}.json`;
}

export function approvalToken(
  canonicalProjectRoot: string,
  workspaceRevision: number,
  team: ExpertTeamPlan,
  largeTeamDecision?: "accepted",
): `sha256:${string}` {
  if (typeof canonicalProjectRoot !== "string"
    || canonicalProjectRoot.length === 0
    || canonicalProjectRoot.includes("\0")) {
    throw new TypeError("canonical project root is invalid");
  }
  if (!Number.isSafeInteger(workspaceRevision) || workspaceRevision < 0) {
    throw new TypeError("workspace revision is invalid");
  }
  if (largeTeamDecision !== undefined && largeTeamDecision !== "accepted") {
    throw new TypeError("large team decision is invalid");
  }
  return digest({
    schemaVersion: 1,
    canonicalProjectRoot,
    workspaceRevision,
    team: parseExpertTeamPlan(team),
    largeTeamDecision: largeTeamDecision ?? null,
  });
}
