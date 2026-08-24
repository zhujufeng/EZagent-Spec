import { z } from "zod";

import { containsSensitiveContent } from "../text/sensitive-content.js";
import { unicodeDefaultCaseFold } from "../text/unicode-case-fold.js";
import { isWellFormedUnicode } from "../text/unicode.js";

export type WorkMode = "brief" | "standard" | "controlled";
export type EvidenceKind =
  | "command"
  | "artifact"
  | "checklist"
  | "comparison"
  | "citation"
  | "human-approval"
  | "external-record";

export interface ContextPointer {
  readonly kind: "file" | "document" | "dataset" | "application" | "external-system" | "other";
  readonly locator: string;
  readonly purpose: string;
}

export interface BriefV2 {
  readonly requestSummary: string;
  readonly intendedOutcome: string;
  readonly actors: readonly string[];
  readonly canonicalTerms: readonly { readonly name: string; readonly meaning: string }[];
  readonly decisions: readonly string[];
  readonly assumptions: readonly {
    readonly statement: string;
    readonly source: "user" | "project" | "agent-recommendation";
    readonly confirmed: boolean;
  }[];
  readonly openQuestions: readonly string[];
  readonly sourcePointers: readonly ContextPointer[];
}

export interface DeliverableInterface {
  readonly id: string;
  readonly kind: "code" | "document" | "analysis" | "dataset" | "visual" | "draft-action" | "other";
  readonly description: string;
  readonly requiredSections: readonly string[];
  readonly invariants: readonly string[];
  readonly consumer: string;
}

export interface AcceptanceCriterion {
  readonly id: string;
  readonly statement: string;
  readonly requiredEvidenceKinds: readonly EvidenceKind[];
}

export interface ResourceRef extends ContextPointer {
  readonly access: "read" | "draft" | "write" | "publish";
}

export interface Boundary {
  readonly id: string;
  readonly dimension: "resource" | "data" | "people" | "time" | "budget" | "system" | "operation";
  readonly rule: string;
  readonly resources: readonly ResourceRef[];
}

export interface ApprovalPoint {
  readonly id: string;
  readonly action: string;
  readonly target: string;
  readonly contentSummary: string;
  readonly contentHash: `sha256:${string}`;
  readonly impact: string;
  readonly reversible: boolean;
  readonly verification: string;
  readonly recovery: string;
}

export interface ReviewPolicy {
  readonly method: "self" | "independent-agent" | "human" | "mixed";
  readonly reasons: readonly string[];
  readonly reviewAfterSlices: number;
}

export interface SlicePlan {
  readonly id: string;
  readonly title: string;
  readonly intendedOutcome: string;
  readonly inputPointers: readonly ContextPointer[];
  readonly deliverableInterfaceIds: readonly string[];
  readonly criterionIds: readonly string[];
  readonly blockedBy: readonly string[];
  readonly humanCheckpoint: boolean;
}

export interface WorkSpecV2 {
  readonly mode: WorkMode;
  readonly outcome: string;
  readonly scope: readonly string[];
  readonly nonGoals: readonly string[];
  readonly deliverableInterfaces: readonly DeliverableInterface[];
  readonly acceptanceCriteria: readonly AcceptanceCriterion[];
  readonly boundaries: readonly Boundary[];
  readonly approvalPoints: readonly ApprovalPoint[];
  readonly reviewPolicy: ReviewPolicy;
  readonly slicePlan: readonly SlicePlan[];
}

export interface WorkContractDraftV2 {
  readonly schemaVersion: 2;
  readonly brief: BriefV2;
  readonly workSpec: WorkSpecV2;
}

const CONTROL = /[\u0000-\u001f\u007f]/u;
const IDENTIFIER = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u;
const HASH = /^sha256:[0-9a-f]{64}$/u;

function boundedText(label: string, maximum = 4_096) {
  return z.string().max(maximum + 256)
    .transform((value) => value.trim().normalize("NFC"))
    .pipe(z.string()
      .min(1, `${label} must not be blank`)
      .max(maximum, `${label} is too long`)
      .refine(isWellFormedUnicode, `${label} must be well-formed Unicode`)
      .refine((value) => !CONTROL.test(value), `${label} contains control characters`)
      .refine((value) => !containsSensitiveContent(value), `${label} contains sensitive content`));
}

function uniqueTextList(label: string, minimum = 0, maximum = 64) {
  return z.array(boundedText(label)).min(minimum).max(maximum).superRefine((values, context) => {
    const seen = new Set<string>();
    for (const [index, value] of values.entries()) {
      const key = unicodeDefaultCaseFold(value.normalize("NFKC")).normalize("NFKC");
      if (seen.has(key)) {
        context.addIssue({ code: "custom", path: [index], message: `${label} contains a duplicate` });
      }
      seen.add(key);
    }
  });
}

const identifierSchema = z.string().min(1).max(96).regex(IDENTIFIER);
const pointerSchema = z.object({
  kind: z.enum(["file", "document", "dataset", "application", "external-system", "other"]),
  locator: boundedText("context locator", 2_048),
  purpose: boundedText("context purpose", 1_024),
}).strict();

const resourceSchema = pointerSchema.extend({
  access: z.enum(["read", "draft", "write", "publish"]),
}).strict();

const briefSchema = z.object({
  requestSummary: boundedText("request summary", 4_096),
  intendedOutcome: boundedText("intended outcome", 4_096),
  actors: uniqueTextList("actors", 1),
  canonicalTerms: z.array(z.object({
    name: boundedText("canonical term", 256),
    meaning: boundedText("canonical meaning", 2_048),
  }).strict()).max(128),
  decisions: uniqueTextList("decisions"),
  assumptions: z.array(z.object({
    statement: boundedText("assumption", 2_048),
    source: z.enum(["user", "project", "agent-recommendation"]),
    confirmed: z.boolean(),
  }).strict()).max(128),
  openQuestions: uniqueTextList("open questions"),
  sourcePointers: z.array(pointerSchema).max(128),
}).strict();

const deliverableSchema = z.object({
  id: identifierSchema,
  kind: z.enum(["code", "document", "analysis", "dataset", "visual", "draft-action", "other"]),
  description: boundedText("deliverable description", 2_048),
  requiredSections: uniqueTextList("required sections"),
  invariants: uniqueTextList("deliverable invariants", 1),
  consumer: boundedText("deliverable consumer", 512),
}).strict();

const criterionSchema = z.object({
  id: identifierSchema,
  statement: boundedText("acceptance criterion", 2_048),
  requiredEvidenceKinds: z.array(z.enum([
    "command", "artifact", "checklist", "comparison", "citation", "human-approval", "external-record",
  ])).min(1).max(7).superRefine((values, context) => {
    if (new Set(values).size !== values.length) {
      context.addIssue({ code: "custom", message: "required evidence kinds contain a duplicate" });
    }
  }),
}).strict();

const boundarySchema = z.object({
  id: identifierSchema,
  dimension: z.enum(["resource", "data", "people", "time", "budget", "system", "operation"]),
  rule: boundedText("boundary rule", 2_048),
  resources: z.array(resourceSchema).max(128),
}).strict();

const approvalPointSchema = z.object({
  id: identifierSchema,
  action: boundedText("approval action", 1_024),
  target: boundedText("approval target", 2_048),
  contentSummary: boundedText("approval content summary", 4_096),
  contentHash: z.string().regex(HASH),
  impact: boundedText("approval impact", 2_048),
  reversible: z.boolean(),
  verification: boundedText("approval verification", 2_048),
  recovery: boundedText("approval recovery", 2_048),
}).strict();

const slicePlanSchema = z.object({
  id: identifierSchema,
  title: boundedText("slice title", 256),
  intendedOutcome: boundedText("slice intended outcome", 2_048),
  inputPointers: z.array(pointerSchema).max(128),
  deliverableInterfaceIds: z.array(identifierSchema).min(1).max(64),
  criterionIds: z.array(identifierSchema).min(1).max(128),
  blockedBy: z.array(identifierSchema).max(15),
  humanCheckpoint: z.boolean(),
}).strict();

const workSpecSchema = z.object({
  mode: z.enum(["brief", "standard", "controlled"]),
  outcome: boundedText("work outcome", 4_096),
  scope: uniqueTextList("scope", 1),
  nonGoals: uniqueTextList("non-goals", 1),
  deliverableInterfaces: z.array(deliverableSchema).min(1).max(64),
  acceptanceCriteria: z.array(criterionSchema).min(1).max(128),
  boundaries: z.array(boundarySchema).max(128),
  approvalPoints: z.array(approvalPointSchema).max(128),
  reviewPolicy: z.object({
    method: z.enum(["self", "independent-agent", "human", "mixed"]),
    reasons: uniqueTextList("review reasons", 1),
    reviewAfterSlices: z.number().int().positive().max(15),
  }).strict(),
  slicePlan: z.array(slicePlanSchema).min(1).max(15),
}).strict().superRefine((spec, context) => {
  const uniqueIds = (values: readonly { readonly id: string }[], path: string) => {
    const seen = new Set<string>();
    for (const [index, value] of values.entries()) {
      if (seen.has(value.id)) {
        context.addIssue({ code: "custom", path: [path, index, "id"], message: `${path} contains a duplicate ID` });
      }
      seen.add(value.id);
    }
    return seen;
  };
  const deliverables = uniqueIds(spec.deliverableInterfaces, "deliverableInterfaces");
  const criteria = uniqueIds(spec.acceptanceCriteria, "acceptanceCriteria");
  uniqueIds(spec.boundaries, "boundaries");
  uniqueIds(spec.approvalPoints, "approvalPoints");
  const slices = uniqueIds(spec.slicePlan, "slicePlan");

  if (spec.mode === "controlled"
    && spec.reviewPolicy.method !== "human"
    && spec.reviewPolicy.method !== "mixed") {
    context.addIssue({
      code: "custom",
      path: ["reviewPolicy", "method"],
      message: "Controlled Mode review must include human or mixed judgment",
    });
  }
  if ((spec.reviewPolicy.method === "human" || spec.reviewPolicy.method === "mixed")
    && !spec.acceptanceCriteria.some(({ requiredEvidenceKinds }) => (
      requiredEvidenceKinds.includes("human-approval")
    ))) {
    context.addIssue({
      code: "custom",
      path: ["acceptanceCriteria"],
      message: "human and mixed review require human-approval Evidence",
    });
  }

  for (const [boundaryIndex, boundary] of spec.boundaries.entries()) {
    for (const [resourceIndex, resource] of boundary.resources.entries()) {
      if (resource.access !== "write" && resource.access !== "publish") continue;
      if (spec.mode !== "controlled") {
        context.addIssue({
          code: "custom",
          path: ["boundaries", boundaryIndex, "resources", resourceIndex, "access"],
          message: "external write and publish access require Controlled Mode",
        });
      }
      if (!spec.approvalPoints.some(({ target }) => target === resource.locator)) {
        context.addIssue({
          code: "custom",
          path: ["boundaries", boundaryIndex, "resources", resourceIndex],
          message: "external write and publish access require a target-matched Approval Point",
        });
      }
    }
  }

  for (const [index, slice] of spec.slicePlan.entries()) {
    for (const id of slice.deliverableInterfaceIds) {
      if (!deliverables.has(id)) {
        context.addIssue({ code: "custom", path: ["slicePlan", index, "deliverableInterfaceIds"], message: `unknown Deliverable Interface: ${id}` });
      }
    }
    for (const id of slice.criterionIds) {
      if (!criteria.has(id)) {
        context.addIssue({ code: "custom", path: ["slicePlan", index, "criterionIds"], message: `unknown Acceptance Criterion: ${id}` });
      }
    }
    for (const id of slice.blockedBy) {
      if (!slices.has(id) || id === slice.id) {
        context.addIssue({ code: "custom", path: ["slicePlan", index, "blockedBy"], message: `invalid Slice dependency: ${id}` });
      }
    }
  }
  if (spec.slicePlan[0]?.blockedBy.length !== 0) {
    context.addIssue({ code: "custom", path: ["slicePlan", 0, "blockedBy"], message: "the Tracer Slice must be unblocked" });
  }
  for (const criterion of spec.acceptanceCriteria) {
    if (!spec.slicePlan.some((slice) => slice.criterionIds.includes(criterion.id))) {
      context.addIssue({ code: "custom", path: ["acceptanceCriteria"], message: `Acceptance Criterion is not covered by a Slice: ${criterion.id}` });
    }
  }
}).strict();

const workContractDraftSchema = z.object({
  schemaVersion: z.literal(2),
  brief: briefSchema,
  workSpec: workSpecSchema,
}).strict();

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

export function parseWorkContractDraft(value: unknown): WorkContractDraftV2 {
  return deepFreeze(workContractDraftSchema.parse(value)) as WorkContractDraftV2;
}

export function parseBriefV2(value: unknown): BriefV2 {
  return deepFreeze(briefSchema.parse(value)) as BriefV2;
}

export function parseWorkSpecV2(value: unknown): WorkSpecV2 {
  return deepFreeze(workSpecSchema.parse(value)) as WorkSpecV2;
}

export function parseSlicePlan(value: unknown): SlicePlan {
  return deepFreeze(slicePlanSchema.parse(value)) as SlicePlan;
}
