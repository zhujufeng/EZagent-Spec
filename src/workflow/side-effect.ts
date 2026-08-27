import { createHash } from "node:crypto";

import { z } from "zod";

import { isWorkItemId } from "../domain/id.js";
import { isWellFormedUnicode } from "../text/unicode.js";

export interface SideEffectAuthorization {
  readonly schemaVersion: 1;
  readonly workItemId: string;
  readonly workSpecId: string;
  readonly workSpecRevision: number;
  readonly approvalPointId: string;
  readonly action: string;
  readonly target: string;
  readonly contentHash: `sha256:${string}`;
  readonly status: "approved";
  readonly approvedAt: string;
  readonly externalActionExecuted: false;
}

// ponytail: bounded in-memory hashing covers text and ordinary document payloads;
// switch to a stable streaming reader if real media publishing is added.
export const SIDE_EFFECT_PAYLOAD_MAX_BYTES = 16 * 1024 * 1024;

export function sideEffectPayloadHash(value: unknown): `sha256:${string}` {
  if (!(value instanceof Uint8Array) || value.byteLength < 1) {
    throw new TypeError("Side Effect payload must be non-empty bytes");
  }
  if (value.byteLength > SIDE_EFFECT_PAYLOAD_MAX_BYTES) {
    throw new TypeError(`Side Effect payload exceeds ${SIDE_EFFECT_PAYLOAD_MAX_BYTES} bytes`);
  }
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

const CONTROL = /[\u0000-\u001f\u007f]/u;
const IDENTIFIER = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u;
const HASH = /^sha256:[0-9a-f]{64}$/u;
const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;

function boundedText(label: string, maximum = 2_048) {
  return z.string().max(maximum + 256)
    .transform((value) => value.trim().normalize("NFC"))
    .pipe(z.string()
      .min(1, `${label} must not be blank`)
      .max(maximum, `${label} is too long`)
      .refine(isWellFormedUnicode, `${label} must be well-formed Unicode`)
      .refine((value) => !CONTROL.test(value), `${label} contains control characters`));
}

function itemId(prefix: "SPEC" | "TASK") {
  return z.string().refine(
    (value) => value.startsWith(`${prefix}-`) && isWorkItemId(value),
    `invalid ${prefix} ID`,
  );
}

const authorizationSchema = z.object({
  schemaVersion: z.literal(1),
  workItemId: itemId("TASK"),
  workSpecId: itemId("SPEC"),
  workSpecRevision: z.number().int().nonnegative(),
  approvalPointId: z.string().min(1).max(96).regex(IDENTIFIER),
  action: boundedText("Side Effect action", 1_024),
  target: boundedText("Side Effect target"),
  contentHash: z.string().regex(HASH),
  status: z.literal("approved"),
  approvedAt: z.string().regex(ISO_INSTANT).refine((value) => {
    const observed = new Date(value);
    return Number.isFinite(observed.getTime()) && observed.toISOString() === value;
  }),
  externalActionExecuted: z.literal(false),
}).strict();

export function parseSideEffectAuthorization(value: unknown): SideEffectAuthorization {
  return Object.freeze(authorizationSchema.parse(value)) as SideEffectAuthorization;
}

export function serializeSideEffectAuthorization(value: SideEffectAuthorization): string {
  return `${JSON.stringify(parseSideEffectAuthorization(value), null, 2)}\n`;
}

export function sideEffectAuthorizationPath(
  workItemId: string,
  approvalPointId: string,
  workspaceRevision: number,
): string {
  itemId("TASK").parse(workItemId);
  z.string().min(1).max(96).regex(IDENTIFIER).parse(approvalPointId);
  if (!Number.isSafeInteger(workspaceRevision) || workspaceRevision < 1) {
    throw new TypeError("Side Effect authorization revision must be a positive safe integer");
  }
  return `quality/runs/${workItemId}/approvals/${approvalPointId}/${String(workspaceRevision).padStart(6, "0")}.json`;
}
