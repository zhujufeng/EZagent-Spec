import { createHash } from "node:crypto";

import { z } from "zod";

import { isWorkItemId } from "../domain/id.js";
import { containsSensitiveContent } from "../text/sensitive-content.js";
import { unicodeDefaultCaseFold } from "../text/unicode-case-fold.js";
import { isWellFormedUnicode } from "../text/unicode.js";

export type SpecialistPurpose = "analysis" | "implementation" | "review";
export type SpecialistMode = "analysis" | "implement" | "review";
export type SpecialistIsolationReason =
  | "domain-judgment"
  | "context-isolation"
  | "parallel-work"
  | "independent-review";

export interface CapabilityNeedDraftV2 {
  readonly id: string;
  readonly sliceId: string;
  readonly purpose: SpecialistPurpose;
  readonly capabilities: readonly string[];
  readonly domains: readonly string[];
  readonly projectSignals: readonly string[];
  readonly isolationReason: SpecialistIsolationReason;
}

export interface SpecialistAssessmentDraftV2 {
  readonly decision: "not-needed" | "required";
  readonly reasons: readonly string[];
  readonly needs: readonly CapabilityNeedDraftV2[];
}

export interface SpecialistDelegationV2 {
  readonly id: string;
  readonly capabilityNeedId: string;
  readonly expertId: string;
  readonly workItemId: string;
  readonly workSpecId: string;
  readonly workSpecRevision: number;
  readonly sliceId: string;
  readonly mode: SpecialistMode;
  readonly reasons: readonly string[];
  readonly scope: readonly string[];
  readonly deliverableInterfaceIds: readonly string[];
  readonly criterionIds: readonly string[];
  readonly evidenceRequirements: readonly string[];
}

export interface SpecialistPlanV2Input {
  readonly schemaVersion: 2;
  readonly revision: number;
  readonly workItemId: string;
  readonly workSpecId: string;
  readonly workSpecRevision: number;
  readonly catalogFingerprint: `sha256:${string}`;
  readonly selectionFingerprint: `sha256:${string}`;
  readonly assessment: SpecialistAssessmentDraftV2;
  readonly delegations: readonly SpecialistDelegationV2[];
  readonly uncoveredCapabilities: readonly string[];
  readonly blockers: readonly string[];
}

export interface SpecialistPlanV2 extends SpecialistPlanV2Input {
  readonly planFingerprint: `sha256:${string}`;
}

export interface SpecialistDelegationDiffV2 {
  readonly added: readonly string[];
  readonly removed: readonly string[];
  readonly changed: readonly string[];
  readonly unchanged: readonly string[];
}

const CONTROL = /[\u0000-\u001f\u007f]/u;
const IDENTIFIER = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u;
const TOKEN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;
const EXPERT_ID = /^ezagent\.[a-z0-9]+(?:-[a-z0-9]+)*(?:\.[a-z0-9]+(?:-[a-z0-9]+)*)*$/u;
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

function uniqueList<T extends z.ZodTypeAny>(item: T, label: string, minimum = 0, maximum = 128) {
  return z.array(item).min(minimum).max(maximum).superRefine((values, context) => {
    const seen = new Set<string>();
    for (const [index, value] of values.entries()) {
      const key = unicodeDefaultCaseFold(String(value).normalize("NFKC")).normalize("NFKC");
      if (seen.has(key)) {
        context.addIssue({ code: "custom", path: [index], message: `${label} contains a duplicate` });
      }
      seen.add(key);
    }
  });
}

const identifierSchema = z.string().min(1).max(96).regex(IDENTIFIER);
const tokenSchema = z.string().min(1).max(64).regex(TOKEN);
const expertIdSchema = z.string().min(1).max(160).regex(EXPERT_ID);
const hashSchema = z.string().regex(HASH);

function workItemId(prefix: "SPEC" | "TASK") {
  return z.string().refine(
    (value) => value.startsWith(`${prefix}-`) && isWorkItemId(value),
    `invalid ${prefix} ID`,
  );
}

const capabilityNeedSchema = z.object({
  id: identifierSchema,
  sliceId: identifierSchema,
  purpose: z.enum(["analysis", "implementation", "review"]),
  capabilities: uniqueList(tokenSchema, "capabilities", 1, 512),
  domains: uniqueList(tokenSchema, "domains", 0, 512),
  projectSignals: uniqueList(tokenSchema, "project signals", 0, 512),
  isolationReason: z.enum([
    "domain-judgment", "context-isolation", "parallel-work", "independent-review",
  ]),
}).strict();

const assessmentSchema = z.object({
  decision: z.enum(["not-needed", "required"]),
  reasons: uniqueList(boundedText("assessment reason", 2_048), "assessment reasons", 1),
  needs: z.array(capabilityNeedSchema).max(128),
}).strict().superRefine((assessment, context) => {
  if (assessment.decision === "not-needed" && assessment.needs.length !== 0) {
    context.addIssue({ code: "custom", path: ["needs"], message: "not-needed assessment cannot contain needs" });
  }
  if (assessment.decision === "required" && assessment.needs.length === 0) {
    context.addIssue({ code: "custom", path: ["needs"], message: "required assessment must contain needs" });
  }
  const ids = new Set<string>();
  for (const [index, need] of assessment.needs.entries()) {
    if (ids.has(need.id)) {
      context.addIssue({ code: "custom", path: ["needs", index, "id"], message: "capability need IDs must be unique" });
    }
    ids.add(need.id);
    if (need.purpose === "review" && need.isolationReason !== "independent-review") {
      context.addIssue({
        code: "custom",
        path: ["needs", index, "isolationReason"],
        message: "review capability needs require independent-review isolation",
      });
    }
    if (need.purpose !== "review" && need.isolationReason === "independent-review") {
      context.addIssue({
        code: "custom",
        path: ["needs", index, "isolationReason"],
        message: "independent-review isolation requires review purpose",
      });
    }
  }
});

const delegationSchema = z.object({
  id: identifierSchema,
  capabilityNeedId: identifierSchema,
  expertId: expertIdSchema,
  workItemId: workItemId("TASK"),
  workSpecId: workItemId("SPEC"),
  workSpecRevision: z.number().int().nonnegative(),
  sliceId: identifierSchema,
  mode: z.enum(["analysis", "implement", "review"]),
  reasons: uniqueList(boundedText("delegation reason", 2_048), "delegation reasons", 1),
  scope: uniqueList(boundedText("delegation scope", 4_096), "delegation scope", 1),
  deliverableInterfaceIds: uniqueList(identifierSchema, "deliverable interface IDs", 1, 64),
  criterionIds: uniqueList(identifierSchema, "criterion IDs", 1, 128),
  evidenceRequirements: uniqueList(boundedText("evidence requirement", 1_024), "evidence requirements", 1),
}).strict();

const planInputSchema = z.object({
  schemaVersion: z.literal(2),
  revision: z.number().int().positive(),
  workItemId: workItemId("TASK"),
  workSpecId: workItemId("SPEC"),
  workSpecRevision: z.number().int().nonnegative(),
  catalogFingerprint: hashSchema,
  selectionFingerprint: hashSchema,
  assessment: assessmentSchema,
  delegations: z.array(delegationSchema).max(4_096),
  uncoveredCapabilities: uniqueList(tokenSchema, "uncovered capabilities", 0, 512),
  blockers: uniqueList(boundedText("Specialist blocker", 2_048), "Specialist blockers", 0, 512),
}).strict().superRefine((plan, context) => {
  if (plan.assessment.decision === "not-needed") {
    if (plan.delegations.length !== 0) {
      context.addIssue({ code: "custom", path: ["delegations"], message: "not-needed plan cannot contain delegations" });
    }
    if (plan.uncoveredCapabilities.length !== 0 || plan.blockers.length !== 0) {
      context.addIssue({ code: "custom", message: "not-needed plan cannot contain selection blockers" });
    }
  }

  const needs = new Map(plan.assessment.needs.map((need) => [need.id, need]));
  const delegationIds = new Set<string>();
  for (const [index, delegation] of plan.delegations.entries()) {
    if (delegationIds.has(delegation.id)) {
      context.addIssue({ code: "custom", path: ["delegations", index, "id"], message: "delegation IDs must be unique" });
    }
    delegationIds.add(delegation.id);
    if (delegation.workItemId !== plan.workItemId
      || delegation.workSpecId !== plan.workSpecId
      || delegation.workSpecRevision !== plan.workSpecRevision) {
      context.addIssue({ code: "custom", path: ["delegations", index], message: "delegation Work binding does not match its plan" });
    }
    const need = needs.get(delegation.capabilityNeedId);
    if (need === undefined) {
      context.addIssue({ code: "custom", path: ["delegations", index, "capabilityNeedId"], message: "delegation references an unknown Capability Need" });
      continue;
    }
    if (delegation.sliceId !== need.sliceId) {
      context.addIssue({ code: "custom", path: ["delegations", index, "sliceId"], message: "delegation Slice does not match its Capability Need" });
    }
    const expectedMode: SpecialistMode = need.purpose === "implementation" ? "implement" : need.purpose;
    if (delegation.mode !== expectedMode) {
      context.addIssue({ code: "custom", path: ["delegations", index, "mode"], message: "delegation mode does not match its Capability Need" });
    }
  }

  if (plan.assessment.decision === "required" && plan.blockers.length === 0) {
    for (const need of plan.assessment.needs) {
      if (!plan.delegations.some(({ capabilityNeedId }) => capabilityNeedId === need.id)) {
        context.addIssue({ code: "custom", path: ["delegations"], message: `Capability Need has no delegation: ${need.id}` });
      }
    }
  }

  const implementationBySlice = new Map<string, Set<string>>();
  for (const delegation of plan.delegations) {
    if (delegation.mode === "review") continue;
    const experts = implementationBySlice.get(delegation.sliceId) ?? new Set<string>();
    experts.add(delegation.expertId);
    implementationBySlice.set(delegation.sliceId, experts);
  }
  for (const [index, delegation] of plan.delegations.entries()) {
    if (delegation.mode === "review"
      && implementationBySlice.get(delegation.sliceId)?.has(delegation.expertId)) {
      context.addIssue({ code: "custom", path: ["delegations", index, "expertId"], message: "independent reviewer cannot implement the same Slice" });
    }
  }
});

const planSchema = planInputSchema.extend({ planFingerprint: hashSchema }).strict();

function portableCompare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function sorted(values: readonly string[]): readonly string[] {
  return Object.freeze([...values].sort(portableCompare));
}

function canonicalInput(value: z.infer<typeof planInputSchema>): SpecialistPlanV2Input {
  return Object.freeze({
    ...value,
    catalogFingerprint: value.catalogFingerprint as `sha256:${string}`,
    selectionFingerprint: value.selectionFingerprint as `sha256:${string}`,
    assessment: Object.freeze({
      ...value.assessment,
      reasons: sorted(value.assessment.reasons),
      needs: Object.freeze([...value.assessment.needs]
        .sort((left, right) => portableCompare(left.id, right.id))
        .map((need) => Object.freeze({
          ...need,
          capabilities: sorted(need.capabilities),
          domains: sorted(need.domains),
          projectSignals: sorted(need.projectSignals),
        }))),
    }),
    delegations: Object.freeze([...value.delegations]
      .sort((left, right) => portableCompare(left.id, right.id))
      .map((delegation) => Object.freeze({
        ...delegation,
        reasons: sorted(delegation.reasons),
        scope: sorted(delegation.scope),
        deliverableInterfaceIds: sorted(delegation.deliverableInterfaceIds),
        criterionIds: sorted(delegation.criterionIds),
        evidenceRequirements: sorted(delegation.evidenceRequirements),
      }))),
    uncoveredCapabilities: sorted(value.uncoveredCapabilities),
    blockers: sorted(value.blockers),
  });
}

function digest(value: unknown): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(JSON.stringify(value)).digest("hex")}`;
}

export function parseSpecialistAssessmentDraftV2(value: unknown): SpecialistAssessmentDraftV2 {
  const parsed = assessmentSchema.parse(value);
  return canonicalInput({
    schemaVersion: 2,
    revision: 1,
    workItemId: "TASK-20000101-001",
    workSpecId: "SPEC-20000101-001",
    workSpecRevision: 0,
    catalogFingerprint: `sha256:${"0".repeat(64)}`,
    selectionFingerprint: `sha256:${"0".repeat(64)}`,
    assessment: parsed,
    delegations: [],
    uncoveredCapabilities: [],
    blockers: parsed.decision === "required" ? ["assessment-only"] : [],
  }).assessment;
}

export function createSpecialistPlanV2(value: SpecialistPlanV2Input): SpecialistPlanV2 {
  const input = canonicalInput(planInputSchema.parse(value));
  return Object.freeze({ ...input, planFingerprint: digest(input) });
}

export function parseSpecialistPlanV2(value: unknown): SpecialistPlanV2 {
  const parsed = planSchema.parse(value);
  const { planFingerprint, ...input } = parsed;
  const expected = createSpecialistPlanV2({
    ...input,
    catalogFingerprint: input.catalogFingerprint as `sha256:${string}`,
    selectionFingerprint: input.selectionFingerprint as `sha256:${string}`,
  });
  if (planFingerprint !== expected.planFingerprint) {
    throw new TypeError("Specialist Plan fingerprint mismatch");
  }
  return expected;
}

export function serializeSpecialistPlanV2(value: SpecialistPlanV2): string {
  return `${JSON.stringify(parseSpecialistPlanV2(value), null, 2)}\n`;
}

export function diffSpecialistPlansV2(
  previousValue: unknown,
  nextValue: unknown,
): SpecialistDelegationDiffV2 {
  const previous = parseSpecialistPlanV2(previousValue);
  const next = parseSpecialistPlanV2(nextValue);
  if (previous.workItemId !== next.workItemId
    || previous.workSpecId !== next.workSpecId
    || previous.workSpecRevision !== next.workSpecRevision) {
    throw new TypeError("Specialist replan cannot change the Work Contract identity");
  }
  const before = new Map(previous.delegations.map((delegation) => [delegation.id, delegation]));
  const after = new Map(next.delegations.map((delegation) => [delegation.id, delegation]));
  const added: string[] = [];
  const removed: string[] = [];
  const changed: string[] = [];
  const unchanged: string[] = [];
  for (const [id, delegation] of after) {
    const old = before.get(id);
    if (old === undefined) added.push(id);
    else if (JSON.stringify(old) === JSON.stringify(delegation)) unchanged.push(id);
    else changed.push(id);
  }
  for (const id of before.keys()) {
    if (!after.has(id)) removed.push(id);
  }
  return Object.freeze({
    added: Object.freeze(added.sort(portableCompare)),
    removed: Object.freeze(removed.sort(portableCompare)),
    changed: Object.freeze(changed.sort(portableCompare)),
    unchanged: Object.freeze(unchanged.sort(portableCompare)),
  });
}

export function specialistPlanHistoryPath(workItemId: string, revision: number): string {
  if (!workItemId.startsWith("TASK-") || !isWorkItemId(workItemId)) {
    throw new TypeError("invalid Specialist Plan Task ID");
  }
  if (!Number.isSafeInteger(revision) || revision < 1) {
    throw new TypeError("Specialist Plan revision must be a positive safe integer");
  }
  return `experts/plans/${workItemId}/${String(revision).padStart(6, "0")}.json`;
}
