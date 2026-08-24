import { z } from "zod";

import { isWorkItemId } from "../domain/id.js";
import { containsSensitiveContent } from "../text/sensitive-content.js";
import { isWellFormedUnicode } from "../text/unicode.js";
import type { ContextPointer } from "./work-contract.js";

export interface WorkJournalAppendInput {
  readonly schemaVersion: 1;
  readonly workItemId: string;
  readonly sliceId: string;
  readonly summary: string;
  readonly observations: readonly string[];
  readonly decisions: readonly string[];
  readonly failedApproaches: readonly string[];
  readonly nextStep: string;
  readonly contextPointers: readonly ContextPointer[];
}

export interface WorkJournalEntry extends WorkJournalAppendInput {
  readonly sequence: number;
}

const CONTROL = /[\u0000-\u001f\u007f]/u;
const IDENTIFIER = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u;
const MAX_JOURNAL_BYTES = 4 * 1024 * 1024;
const MAX_JOURNAL_ENTRIES = 512;

function safeText(label: string, maximum = 2_048) {
  return z.string().max(maximum + 256)
    .transform((value) => value.trim().normalize("NFC"))
    .pipe(z.string()
      .min(1, `${label} must not be blank`)
      .max(maximum, `${label} is too long`)
      .refine(isWellFormedUnicode, `${label} must be well-formed Unicode`)
      .refine((value) => !CONTROL.test(value), `${label} contains control characters`)
      .refine((value) => !containsSensitiveContent(value), `${label} contains sensitive content`));
}

const pointerSchema = z.object({
  kind: z.enum(["file", "document", "dataset", "application", "external-system", "other"]),
  locator: safeText("context locator"),
  purpose: safeText("context purpose", 1_024),
}).strict();

const appendSchema = z.object({
  schemaVersion: z.literal(1),
  workItemId: z.string().refine((value) => value.startsWith("TASK-") && isWorkItemId(value)),
  sliceId: z.string().min(1).max(96).regex(IDENTIFIER),
  summary: safeText("Journal summary"),
  observations: z.array(safeText("Journal observation")).max(128),
  decisions: z.array(safeText("Journal decision")).max(128),
  failedApproaches: z.array(safeText("Journal failed approach")).max(128),
  nextStep: safeText("Journal next step"),
  contextPointers: z.array(pointerSchema).max(128),
}).strict();

const entrySchema = appendSchema.extend({
  sequence: z.number().int().positive().max(MAX_JOURNAL_ENTRIES),
}).strict();

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

export function parseWorkJournalAppendInput(value: unknown): WorkJournalAppendInput {
  return deepFreeze(appendSchema.parse(value)) as WorkJournalAppendInput;
}

export function createWorkJournalEntry(value: unknown, sequence: number): WorkJournalEntry {
  const input = parseWorkJournalAppendInput(value);
  return deepFreeze(entrySchema.parse({ ...input, sequence })) as WorkJournalEntry;
}

export function parseWorkJournalJsonl(text: string, workItemId: string): readonly WorkJournalEntry[] {
  if (typeof text !== "string" || text.length === 0 || text.length > MAX_JOURNAL_BYTES) {
    throw new TypeError("Work Journal must be bounded non-empty JSONL");
  }
  const lines = text.split("\n");
  if (lines.at(-1) !== "") throw new TypeError("Work Journal JSONL must end with a newline");
  lines.pop();
  if (lines.length === 0 || lines.length > MAX_JOURNAL_ENTRIES || lines.some((line) => line.length === 0)) {
    throw new TypeError("Work Journal contains an invalid entry count");
  }
  const entries = lines.map((line, index) => {
    let value: unknown;
    try {
      value = JSON.parse(line) as unknown;
    } catch {
      throw new TypeError("Work Journal contains invalid JSON");
    }
    const entry = deepFreeze(entrySchema.parse(value)) as WorkJournalEntry;
    if (entry.workItemId !== workItemId || entry.sequence !== index + 1) {
      throw new TypeError("Work Journal identity or sequence is invalid");
    }
    return entry;
  });
  return Object.freeze(entries);
}

export function serializeWorkJournalEntry(value: WorkJournalEntry): string {
  return `${JSON.stringify(deepFreeze(entrySchema.parse(value)))}\n`;
}

export function workJournalPath(workItemId: string): string {
  if (!workItemId.startsWith("TASK-") || !isWorkItemId(workItemId)) {
    throw new TypeError("invalid Work Journal Work Item ID");
  }
  return `journals/${workItemId}.jsonl`;
}
