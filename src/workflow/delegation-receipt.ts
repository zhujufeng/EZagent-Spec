import { createHash } from "node:crypto";

import { z } from "zod";

import { isWorkItemId } from "../domain/id.js";
import { containsSensitiveContent } from "../text/sensitive-content.js";
import { unicodeDefaultCaseFold } from "../text/unicode-case-fold.js";
import { isWellFormedUnicode } from "../text/unicode.js";
import type { SpecialistDelegationV2 } from "./specialist-plan.js";

const CONTROL = /[\u0000-\u001f\u007f]/u;
const IDENTIFIER = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u;
const EXPERT_ID = /^ezagent\.[a-z0-9]+(?:-[a-z0-9]+)*(?:\.[a-z0-9]+(?:-[a-z0-9]+)*)*$/u;
const HASH = /^sha256:[0-9a-f]{64}$/u;
const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;

function boundedText(label: string, maximum: number) {
  return z.string().max(maximum + 256)
    .transform((value) => value.trim().normalize("NFC"))
    .pipe(z.string()
      .min(1, `${label} must not be blank`)
      .max(maximum, `${label} is too long`)
      .refine(isWellFormedUnicode, `${label} must be well-formed Unicode`)
      .refine((value) => !CONTROL.test(value), `${label} contains control characters`)
      .refine((value) => !containsSensitiveContent(value), `${label} contains sensitive content`));
}

const identifierSchema = z.string().min(1).max(96).regex(IDENTIFIER);
const expertIdSchema = z.string().min(1).max(160).regex(EXPERT_ID);
const hashSchema = z.string().regex(HASH);
const taskIdSchema = z.string().refine((value) => value.startsWith("TASK-") && isWorkItemId(value));
const specIdSchema = z.string().refine((value) => value.startsWith("SPEC-") && isWorkItemId(value));
const instantSchema = z.string().regex(ISO_INSTANT).refine((value) => {
  const observed = new Date(value);
  return Number.isFinite(observed.getTime()) && observed.toISOString() === value;
}, "timestamp must be a canonical UTC instant");

const pointerSchema = z.object({
  kind: z.enum(["evidence", "file", "document", "external-record"]),
  locator: boundedText("Delegation Evidence pointer locator", 2_048),
  contentHash: hashSchema.optional(),
}).strict();

const binding = {
  delegationId: identifierSchema,
  expertId: expertIdSchema,
  workItemId: taskIdSchema,
  workSpecId: specIdSchema,
  workSpecRevision: z.number().int().nonnegative(),
  sliceId: identifierSchema,
  planFingerprint: hashSchema,
};

const dispatchSchema = z.object({
  schemaVersion: z.literal(1),
  kind: z.literal("specialist-dispatch"),
  delegationId: identifierSchema,
  expertId: expertIdSchema,
  workItemId: taskIdSchema,
  workSpecId: specIdSchema,
  workSpecRevision: z.number().int().nonnegative(),
  sliceId: identifierSchema,
  mode: z.enum(["analysis", "review", "implement"]),
  scope: z.array(boundedText("Delegation dispatch scope", 512)).min(1).max(64),
  deliverableInterfaceIds: z.array(identifierSchema).max(64),
  criterionIds: z.array(identifierSchema).max(128),
  evidenceRequirements: z.array(boundedText("Delegation dispatch Evidence requirement", 512)).max(128),
}).strict();

const startReceiptV1Schema = z.object({
  schemaVersion: z.literal(1),
  kind: z.literal("start"),
  ...binding,
  mode: z.enum(["analysis", "review", "implement"]),
  status: z.literal("started"),
  startedAt: instantSchema,
}).strict();

const startReceiptV2Schema = z.object({
  schemaVersion: z.literal(2),
  kind: z.literal("start"),
  ...binding,
  dispatchFingerprint: hashSchema,
  mode: z.enum(["analysis", "review", "implement"]),
  status: z.literal("started"),
  startedAt: instantSchema,
}).strict();

const startReceiptSchema = z.discriminatedUnion("schemaVersion", [
  startReceiptV1Schema,
  startReceiptV2Schema,
]);

const completionInputV1Schema = z.object({
  schemaVersion: z.literal(1),
  expertId: expertIdSchema,
  planFingerprint: hashSchema,
  status: z.enum(["completed", "blocked"]),
  summary: boundedText("Delegation result summary", 2_048),
  resultHash: hashSchema,
  evidencePointers: z.array(pointerSchema).max(128),
}).strict();

const completionInputV2Schema = z.object({
  schemaVersion: z.literal(2),
  expertId: expertIdSchema,
  planFingerprint: hashSchema,
  dispatchFingerprint: hashSchema,
  status: z.enum(["completed", "blocked"]),
  summary: boundedText("Delegation result summary", 2_048),
  resultHash: hashSchema,
  evidencePointers: z.array(pointerSchema).max(128),
}).strict();

const completionInputSchema = z.discriminatedUnion("schemaVersion", [
  completionInputV1Schema,
  completionInputV2Schema,
]).superRefine((input, context) => {
  const seen = new Set<string>();
  for (const [index, pointer] of input.evidencePointers.entries()) {
    const key = unicodeDefaultCaseFold(`${pointer.kind}:${pointer.locator}`).normalize("NFKC");
    if (seen.has(key)) {
      context.addIssue({
        code: "custom",
        path: ["evidencePointers", index],
        message: "Delegation Evidence pointers contain a duplicate",
      });
    }
    seen.add(key);
  }
  if (input.status === "completed" && input.evidencePointers.length === 0) {
    context.addIssue({
      code: "custom",
      path: ["evidencePointers"],
      message: "completed Delegation requires at least one Evidence pointer",
    });
  }
});

const completionReceiptV1Schema = z.object({
  schemaVersion: z.literal(1),
  kind: z.literal("completion"),
  ...binding,
  status: z.enum(["completed", "blocked"]),
  summary: boundedText("Delegation result summary", 2_048),
  resultHash: hashSchema,
  evidencePointers: z.array(pointerSchema).max(128),
  completedAt: instantSchema,
}).strict();

const completionReceiptV2Schema = z.object({
  schemaVersion: z.literal(2),
  kind: z.literal("completion"),
  ...binding,
  dispatchFingerprint: hashSchema,
  status: z.enum(["completed", "blocked"]),
  summary: boundedText("Delegation result summary", 2_048),
  resultHash: hashSchema,
  evidencePointers: z.array(pointerSchema).max(128),
  completedAt: instantSchema,
}).strict();

const completionReceiptSchema = z.discriminatedUnion("schemaVersion", [
  completionReceiptV1Schema,
  completionReceiptV2Schema,
]).superRefine((receipt, context) => {
  const seen = new Set<string>();
  for (const [index, pointer] of receipt.evidencePointers.entries()) {
    const key = unicodeDefaultCaseFold(`${pointer.kind}:${pointer.locator}`).normalize("NFKC");
    if (seen.has(key)) {
      context.addIssue({
        code: "custom",
        path: ["evidencePointers", index],
        message: "Delegation Evidence pointers contain a duplicate",
      });
    }
    seen.add(key);
  }
  if (receipt.status === "completed" && receipt.evidencePointers.length === 0) {
    context.addIssue({
      code: "custom",
      path: ["evidencePointers"],
      message: "completed Delegation requires at least one Evidence pointer",
    });
  }
});

export type DelegationEvidencePointer = Readonly<z.infer<typeof pointerSchema>>;
export type DelegationDispatch = Readonly<z.infer<typeof dispatchSchema>>;
export type DelegationCompletionInput = Readonly<z.infer<typeof completionInputSchema>>;
export type DelegationStartReceipt = Readonly<z.infer<typeof startReceiptSchema>>;
export type DelegationStartReceiptV2 = Readonly<z.infer<typeof startReceiptV2Schema>>;
export type DelegationCompletionReceipt = Readonly<z.infer<typeof completionReceiptSchema>>;

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

function canonicalInstant(value: Date, label: string): string {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    throw new TypeError(`${label} is invalid`);
  }
  return value.toISOString();
}

export function parseDelegationCompletionInput(value: unknown): DelegationCompletionInput {
  return deepFreeze(completionInputSchema.parse(value));
}

export function parseDelegationDispatch(value: unknown): DelegationDispatch {
  return deepFreeze(dispatchSchema.parse(value));
}

export function createDelegationDispatch(delegation: SpecialistDelegationV2): DelegationDispatch {
  return parseDelegationDispatch({
    schemaVersion: 1,
    kind: "specialist-dispatch",
    delegationId: delegation.id,
    expertId: delegation.expertId,
    workItemId: delegation.workItemId,
    workSpecId: delegation.workSpecId,
    workSpecRevision: delegation.workSpecRevision,
    sliceId: delegation.sliceId,
    mode: delegation.mode,
    scope: delegation.scope,
    deliverableInterfaceIds: delegation.deliverableInterfaceIds,
    criterionIds: delegation.criterionIds,
    evidenceRequirements: delegation.evidenceRequirements,
  });
}

export function delegationDispatchFingerprint(value: unknown): `sha256:${string}` {
  const dispatch = parseDelegationDispatch(value);
  return `sha256:${createHash("sha256").update(JSON.stringify(dispatch), "utf8").digest("hex")}`;
}

export function parseDelegationStartReceipt(value: unknown): DelegationStartReceipt {
  return deepFreeze(startReceiptSchema.parse(value));
}

export function parseDelegationCompletionReceipt(value: unknown): DelegationCompletionReceipt {
  return deepFreeze(completionReceiptSchema.parse(value));
}

export function createDelegationStartReceipt(
  delegation: SpecialistDelegationV2,
  planFingerprint: `sha256:${string}`,
  startedAt: Date,
): DelegationStartReceiptV2 {
  const dispatch = createDelegationDispatch(delegation);
  return parseDelegationStartReceipt({
    schemaVersion: 2,
    kind: "start",
    delegationId: delegation.id,
    expertId: delegation.expertId,
    workItemId: delegation.workItemId,
    workSpecId: delegation.workSpecId,
    workSpecRevision: delegation.workSpecRevision,
    sliceId: delegation.sliceId,
    planFingerprint,
    dispatchFingerprint: delegationDispatchFingerprint(dispatch),
    mode: delegation.mode,
    status: "started",
    startedAt: canonicalInstant(startedAt, "Delegation start timestamp"),
  }) as DelegationStartReceiptV2;
}

export function createDelegationCompletionReceipt(
  delegation: SpecialistDelegationV2,
  inputValue: unknown,
  start: DelegationStartReceipt,
  completedAt: Date,
): DelegationCompletionReceipt {
  const input = parseDelegationCompletionInput(inputValue);
  if (start.schemaVersion !== input.schemaVersion) {
    throw new TypeError("Delegation completion schema does not match its start receipt");
  }
  if (start.schemaVersion === 2
    && input.schemaVersion === 2
    && start.dispatchFingerprint !== input.dispatchFingerprint) {
    throw new TypeError("Delegation completion dispatch fingerprint does not match its start receipt");
  }
  return parseDelegationCompletionReceipt({
    schemaVersion: input.schemaVersion,
    kind: "completion",
    delegationId: delegation.id,
    expertId: delegation.expertId,
    workItemId: delegation.workItemId,
    workSpecId: delegation.workSpecId,
    workSpecRevision: delegation.workSpecRevision,
    sliceId: delegation.sliceId,
    planFingerprint: input.planFingerprint,
    ...(input.schemaVersion === 2 ? { dispatchFingerprint: input.dispatchFingerprint } : {}),
    status: input.status,
    summary: input.summary,
    resultHash: input.resultHash,
    evidencePointers: input.evidencePointers,
    completedAt: canonicalInstant(completedAt, "Delegation completion timestamp"),
  });
}

export function serializeDelegationStartReceipt(value: DelegationStartReceipt): string {
  return `${JSON.stringify(parseDelegationStartReceipt(value), null, 2)}\n`;
}

export function serializeDelegationCompletionReceipt(value: DelegationCompletionReceipt): string {
  return `${JSON.stringify(parseDelegationCompletionReceipt(value), null, 2)}\n`;
}

function receiptBasePath(
  workItemId: string,
  delegationId: string,
  planRevision?: number,
): string {
  taskIdSchema.parse(workItemId);
  identifierSchema.parse(delegationId);
  const base = `experts/receipts/${workItemId}/${delegationId}`;
  if (planRevision === undefined) return base;
  if (!Number.isSafeInteger(planRevision) || planRevision < 1) {
    throw new TypeError("Delegation receipt Plan revision must be a positive safe integer");
  }
  return `${base}/revisions/${String(planRevision).padStart(6, "0")}`;
}

export function delegationStartReceiptPath(
  workItemId: string,
  delegationId: string,
  planRevision?: number,
): string {
  return `${receiptBasePath(workItemId, delegationId, planRevision)}/start.json`;
}

export function delegationCompletionReceiptPath(
  workItemId: string,
  delegationId: string,
  planRevision?: number,
): string {
  return `${receiptBasePath(workItemId, delegationId, planRevision)}/completion.json`;
}
