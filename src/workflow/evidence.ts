import { z } from "zod";

import { isWorkItemId } from "../domain/id.js";
import { unicodeDefaultCaseFold } from "../text/unicode-case-fold.js";
import { isWellFormedUnicode } from "../text/unicode.js";
import { parseWorkSpecV2, type EvidenceKind, type WorkSpecV2 } from "./work-contract.js";

const CONTROL = /[\u0000-\u001f\u007f]/u;
const IDENTIFIER = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u;
const HASH = /^sha256:[0-9a-f]{64}$/u;
const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/u;

function boundedText(label: string, maximum = 4_096) {
  return z.string().max(maximum + 256)
    .transform((value) => value.trim().normalize("NFC"))
    .pipe(z.string()
      .min(1, `${label} must not be blank`)
      .max(maximum, `${label} is too long`)
      .refine(isWellFormedUnicode, `${label} must be well-formed Unicode`)
      .refine((value) => !CONTROL.test(value), `${label} contains control characters`));
}

function uniqueTextList(label: string, minimum = 1, maximum = 128) {
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
const hashSchema = z.string().regex(HASH);
const instantSchema = z.string().regex(ISO_INSTANT).refine((value) => {
  const observed = new Date(value);
  return Number.isFinite(observed.getTime()) && observed.toISOString() === value;
}, "timestamp must be a canonical UTC instant");
const dateSchema = z.string().regex(ISO_DATE).refine((value) => {
  const observed = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(observed.getTime()) && observed.toISOString().startsWith(value);
}, "date must be a valid calendar date");

const pointerSchema = z.object({
  kind: z.enum(["file", "document", "dataset", "application", "external-system", "other"]),
  locator: boundedText("evidence locator", 2_048),
  purpose: boundedText("evidence purpose", 1_024),
}).strict();

const base = {
  id: identifierSchema,
  criterionIds: z.array(identifierSchema).min(1).max(128).superRefine((values, context) => {
    if (new Set(values).size !== values.length) {
      context.addIssue({ code: "custom", message: "Evidence criterion IDs contain a duplicate" });
    }
  }),
  sliceId: identifierSchema,
  observedAt: instantSchema,
  summary: boundedText("evidence summary", 2_048),
};

const evidenceSchema = z.discriminatedUnion("kind", [
  z.object({
    ...base,
    kind: z.literal("command"),
    command: boundedText("evidence command", 4_096),
    environment: boundedText("command environment", 1_024),
    exitCode: z.number().int(),
    outcome: z.enum(["passed", "failed"]),
  }).strict(),
  z.object({
    ...base,
    kind: z.literal("artifact"),
    resource: pointerSchema,
    contentHash: hashSchema,
    method: boundedText("artifact check method", 2_048),
    outcome: z.enum(["passed", "failed"]),
  }).strict(),
  z.object({
    ...base,
    kind: z.literal("checklist"),
    items: z.array(z.object({
      statement: boundedText("checklist item", 2_048),
      outcome: z.enum(["passed", "failed", "blocked"]),
      summary: boundedText("checklist item summary", 1_024),
    }).strict()).min(1).max(128),
  }).strict(),
  z.object({
    ...base,
    kind: z.literal("comparison"),
    baseline: boundedText("comparison baseline", 2_048),
    candidate: boundedText("comparison candidate", 2_048),
    method: boundedText("comparison method", 2_048),
    differences: uniqueTextList("comparison differences", 0),
    threshold: boundedText("comparison threshold", 2_048),
    outcome: z.enum(["passed", "failed"]),
  }).strict(),
  z.object({
    ...base,
    kind: z.literal("citation"),
    source: pointerSchema,
    claim: boundedText("supported claim", 2_048),
    accessedAt: dateSchema,
  }).strict(),
  z.object({
    ...base,
    kind: z.literal("human-approval"),
    approvalPointId: identifierSchema,
    contentHash: hashSchema,
    conclusion: z.enum(["approved", "rejected"]),
  }).strict(),
  z.object({
    ...base,
    kind: z.literal("external-record"),
    system: boundedText("external system", 512),
    recordRef: boundedText("external record reference", 2_048),
    observedStatus: boundedText("external observed status", 1_024),
    outcome: z.enum(["confirmed", "failed"]),
  }).strict(),
]);

const bundleSchema = z.object({
  schemaVersion: z.literal(1),
  workItemId: z.string().refine((value) => value.startsWith("TASK-") && isWorkItemId(value)),
  workSpecId: z.string().refine((value) => value.startsWith("SPEC-") && isWorkItemId(value)),
  workSpecRevision: z.number().int().nonnegative(),
  sliceId: identifierSchema,
  entries: z.array(evidenceSchema).min(1).max(512),
}).strict().superRefine((bundle, context) => {
  const seen = new Set<string>();
  for (const [index, entry] of bundle.entries.entries()) {
    if (seen.has(entry.id)) {
      context.addIssue({ code: "custom", path: ["entries", index, "id"], message: "Evidence IDs must be unique" });
    }
    seen.add(entry.id);
    if (entry.sliceId !== bundle.sliceId) {
      context.addIssue({ code: "custom", path: ["entries", index, "sliceId"], message: "Evidence must belong to its bundle Slice" });
    }
  }
});

export type Evidence = Readonly<z.infer<typeof evidenceSchema>>;
export interface EvidenceBundle {
  readonly schemaVersion: 1;
  readonly workItemId: string;
  readonly workSpecId: string;
  readonly workSpecRevision: number;
  readonly sliceId: string;
  readonly entries: readonly Evidence[];
}

export interface CriterionCoverage {
  readonly criterionId: string;
  readonly requiredKinds: readonly EvidenceKind[];
  readonly observedKinds: readonly EvidenceKind[];
  readonly missingKinds: readonly EvidenceKind[];
  readonly status: "covered" | "missing";
}

export interface EvidenceCoverage {
  readonly complete: boolean;
  readonly criteria: readonly CriterionCoverage[];
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

function portableCompare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function evidencePassed(entry: Evidence): boolean {
  switch (entry.kind) {
    case "citation": return true;
    case "human-approval": return entry.conclusion === "approved";
    case "checklist": return entry.items.every((item) => item.outcome === "passed");
    case "external-record": return entry.outcome === "confirmed";
    default: return entry.outcome === "passed";
  }
}

export function parseEvidenceBundle(value: unknown): EvidenceBundle {
  return deepFreeze(bundleSchema.parse(value)) as EvidenceBundle;
}

export function parseEvidenceBundleJson(text: string): EvidenceBundle {
  if (typeof text !== "string" || text.length === 0 || text.length > 1_048_576) {
    throw new TypeError("Evidence bundle JSON must be bounded non-empty text");
  }
  return parseEvidenceBundle(JSON.parse(text) as unknown);
}

export function serializeEvidenceBundle(value: EvidenceBundle): string {
  return `${JSON.stringify(parseEvidenceBundle(value), null, 2)}\n`;
}

export function evidenceBundlePath(
  workItemId: string,
  sliceId: string,
  workItemRevision: number,
): string {
  if (!workItemId.startsWith("TASK-") || !isWorkItemId(workItemId)) {
    throw new TypeError("invalid Evidence Work Item ID");
  }
  identifierSchema.parse(sliceId);
  if (!Number.isSafeInteger(workItemRevision) || workItemRevision < 1) {
    throw new TypeError("Evidence Work Item revision must be a positive safe integer");
  }
  return `quality/runs/${workItemId}/${sliceId}/${String(workItemRevision).padStart(6, "0")}.json`;
}

export function reviewEvidenceCoverage(
  workSpecValue: unknown,
  bundleValue: unknown,
): EvidenceCoverage {
  const workSpec: WorkSpecV2 = parseWorkSpecV2(workSpecValue);
  const bundle = parseEvidenceBundle(bundleValue);
  const slice = workSpec.slicePlan.find(({ id }) => id === bundle.sliceId);
  if (slice === undefined) throw new Error("Evidence bundle references an unknown Slice");
  const criteria = new Map(workSpec.acceptanceCriteria.map((criterion) => [criterion.id, criterion]));
  const allowedCriteria = new Set(slice.criterionIds);
  for (const entry of bundle.entries) {
    if (entry.kind === "human-approval") {
      const point = workSpec.approvalPoints.find(({ id }) => id === entry.approvalPointId);
      if (point === undefined || point.contentHash !== entry.contentHash) {
        throw new Error("human approval Evidence content does not match its Approval Point");
      }
    }
    for (const criterionId of entry.criterionIds) {
      const criterion = criteria.get(criterionId);
      if (criterion === undefined || !allowedCriteria.has(criterionId)) {
        throw new Error("Evidence references an Acceptance Criterion outside its Slice");
      }
      if (!criterion.requiredEvidenceKinds.includes(entry.kind)) {
        throw new Error("Evidence kind does not match its Acceptance Criterion");
      }
    }
  }

  const coverage = slice.criterionIds.map((criterionId): CriterionCoverage => {
    const criterion = criteria.get(criterionId)!;
    const requiredKinds = [...criterion.requiredEvidenceKinds].sort(portableCompare);
    const observedKinds = [...new Set(bundle.entries
      .filter((entry) => entry.criterionIds.includes(criterionId) && evidencePassed(entry))
      .map((entry) => entry.kind))].sort(portableCompare);
    const observed = new Set(observedKinds);
    const missingKinds = requiredKinds.filter((kind) => !observed.has(kind));
    return Object.freeze({
      criterionId,
      requiredKinds: Object.freeze(requiredKinds),
      observedKinds: Object.freeze(observedKinds),
      missingKinds: Object.freeze(missingKinds),
      status: missingKinds.length === 0 ? "covered" : "missing",
    });
  });
  return Object.freeze({
    complete: coverage.every(({ status }) => status === "covered"),
    criteria: Object.freeze(coverage),
  });
}
