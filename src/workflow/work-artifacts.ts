import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { z } from "zod";

import { isWorkItemId } from "../domain/id.js";
import type { WorkItemStatus } from "../domain/work-item.js";
import { isWellFormedUnicode } from "../text/unicode.js";
import {
  parseBriefV2,
  parseSlicePlan,
  parseWorkContractDraft,
  parseWorkSpecV2,
  type BriefV2,
  type SlicePlan,
  type WorkContractDraftV2,
  type WorkMode,
  type WorkSpecV2,
} from "./work-contract.js";

export type SliceStatus = "pending" | "executing" | "accepted" | "revise" | "cancelled";

export interface BriefArtifactV2 {
  readonly schemaVersion: 2;
  readonly id: string;
  readonly status: "specified";
  readonly revision: number;
  readonly brief: BriefV2;
}

export interface WorkSpecArtifactV2 {
  readonly schemaVersion: 2;
  readonly id: string;
  readonly briefId: string;
  readonly status: "approved";
  readonly revision: number;
  readonly workSpec: WorkSpecV2;
}

export interface SliceArtifactV2 extends SlicePlan {
  readonly status: SliceStatus;
}

export interface WorkItemArtifactV2 {
  readonly schemaVersion: 2;
  readonly id: string;
  readonly briefId: string;
  readonly workSpecId: string;
  readonly status: WorkItemStatus;
  readonly revision: number;
  readonly title: string;
  readonly slices: readonly SliceArtifactV2[];
}

export interface WorkArtifactsV2 {
  readonly brief: BriefArtifactV2;
  readonly workSpec: WorkSpecArtifactV2;
  readonly workItem: WorkItemArtifactV2;
}

const CONTROL = /[\u0000-\u001f\u007f]/u;
const STATUSES = [
  "captured", "clarifying", "specified", "approved", "planned", "implementing",
  "verifying", "completed", "cancelled",
] as const;

function workItemId(prefix: "REQ" | "SPEC" | "TASK") {
  return z.string().refine(
    (value) => value.startsWith(`${prefix}-`) && isWorkItemId(value),
    `invalid ${prefix} ID`,
  );
}

const titleSchema = z.string().max(512)
  .transform((value) => value.trim().normalize("NFC"))
  .pipe(z.string().min(1).max(256).refine(isWellFormedUnicode).refine((value) => !CONTROL.test(value)));

const briefArtifactSchema = z.object({
  schemaVersion: z.literal(2),
  id: workItemId("REQ"),
  status: z.literal("specified"),
  revision: z.number().int().nonnegative(),
  brief: z.unknown(),
}).strict();

const workSpecArtifactSchema = z.object({
  schemaVersion: z.literal(2),
  id: workItemId("SPEC"),
  briefId: workItemId("REQ"),
  status: z.literal("approved"),
  revision: z.number().int().nonnegative(),
  workSpec: z.unknown(),
}).strict();

const workItemArtifactSchema = z.object({
  schemaVersion: z.literal(2),
  id: workItemId("TASK"),
  briefId: workItemId("REQ"),
  workSpecId: workItemId("SPEC"),
  status: z.enum(STATUSES),
  revision: z.number().int().nonnegative(),
  title: titleSchema,
  slices: z.array(z.unknown()).min(1).max(15),
}).strict();

function exactSlice(value: unknown): SliceArtifactV2 {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("Slice artifact must be an object");
  }
  const record = value as Record<string, unknown>;
  const allowed = [
    "id", "title", "intendedOutcome", "inputPointers", "deliverableInterfaceIds",
    "criterionIds", "blockedBy", "humanCheckpoint", "status",
  ];
  const unsupported = Object.keys(record).find((key) => !allowed.includes(key));
  if (unsupported !== undefined) throw new TypeError(`unsupported Slice artifact field: ${unsupported}`);
  const status = z.enum(["pending", "executing", "accepted", "revise", "cancelled"])
    .parse(record.status);
  const plan = parseSlicePlan(Object.fromEntries(
    Object.entries(record).filter(([key]) => key !== "status"),
  ));
  return Object.freeze({ ...plan, status });
}

function freezeArtifacts(value: WorkArtifactsV2): WorkArtifactsV2 {
  return Object.freeze({
    brief: Object.freeze({ ...value.brief, brief: parseBriefV2(value.brief.brief) }),
    workSpec: Object.freeze({ ...value.workSpec, workSpec: parseWorkSpecV2(value.workSpec.workSpec) }),
    workItem: Object.freeze({
      ...value.workItem,
      slices: Object.freeze(value.workItem.slices.map(exactSlice)),
    }),
  });
}

export function createWorkArtifactsV2(
  draftValue: unknown,
  ids: { readonly briefId: string; readonly workSpecId: string; readonly workItemId: string },
): WorkArtifactsV2 {
  const draft: WorkContractDraftV2 = parseWorkContractDraft(draftValue);
  return freezeArtifacts({
    brief: {
      schemaVersion: 2,
      id: workItemId("REQ").parse(ids.briefId),
      status: "specified",
      revision: 0,
      brief: draft.brief,
    },
    workSpec: {
      schemaVersion: 2,
      id: workItemId("SPEC").parse(ids.workSpecId),
      briefId: workItemId("REQ").parse(ids.briefId),
      status: "approved",
      revision: 0,
      workSpec: draft.workSpec,
    },
    workItem: {
      schemaVersion: 2,
      id: workItemId("TASK").parse(ids.workItemId),
      briefId: workItemId("REQ").parse(ids.briefId),
      workSpecId: workItemId("SPEC").parse(ids.workSpecId),
      status: "planned",
      revision: 0,
      title: draft.brief.requestSummary,
      slices: draft.workSpec.slicePlan.map((slice) => ({ ...slice, status: "pending" })),
    },
  });
}

export function parseBriefArtifactV2(value: unknown): BriefArtifactV2 {
  const parsed = briefArtifactSchema.parse(value);
  return Object.freeze({ ...parsed, brief: parseBriefV2(parsed.brief) });
}

export function parseWorkSpecArtifactV2(value: unknown): WorkSpecArtifactV2 {
  const parsed = workSpecArtifactSchema.parse(value);
  return Object.freeze({ ...parsed, workSpec: parseWorkSpecV2(parsed.workSpec) });
}

export function parseWorkItemArtifactV2(value: unknown): WorkItemArtifactV2 {
  const parsed = workItemArtifactSchema.parse(value);
  return Object.freeze({ ...parsed, slices: Object.freeze(parsed.slices.map(exactSlice)) });
}

function yamlValue(text: string): unknown {
  if (typeof text !== "string" || text.length === 0 || text.length > 1_048_576) {
    throw new TypeError("artifact YAML must be bounded non-empty text");
  }
  return parseYaml(text);
}

export const parseBriefArtifactV2Yaml = (text: string): BriefArtifactV2 => (
  parseBriefArtifactV2(yamlValue(text))
);
export const parseWorkSpecArtifactV2Yaml = (text: string): WorkSpecArtifactV2 => (
  parseWorkSpecArtifactV2(yamlValue(text))
);
export const parseWorkItemArtifactV2Yaml = (text: string): WorkItemArtifactV2 => (
  parseWorkItemArtifactV2(yamlValue(text))
);

function serializeYaml(value: unknown): string {
  return stringifyYaml(value, { lineWidth: 0 });
}

export const serializeBriefArtifactV2 = (value: BriefArtifactV2): string => (
  serializeYaml(parseBriefArtifactV2(value))
);
export const serializeWorkSpecArtifactV2 = (value: WorkSpecArtifactV2): string => (
  serializeYaml(parseWorkSpecArtifactV2(value))
);
export const serializeWorkItemArtifactV2 = (value: WorkItemArtifactV2): string => (
  serializeYaml(parseWorkItemArtifactV2(value))
);

export function workModeRisk(mode: WorkMode): "brief" | "standard" | "high" {
  return mode === "controlled" ? "high" : mode;
}
