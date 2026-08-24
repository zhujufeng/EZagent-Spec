import { createHash } from "node:crypto";

import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { z } from "zod";

import { isWorkItemId } from "../domain/id.js";
import { containsSensitiveContent } from "../text/sensitive-content.js";
import { unicodeDefaultCaseFold } from "../text/unicode-case-fold.js";
import { isWellFormedUnicode } from "../text/unicode.js";

const CONTROL = /[\u0000-\u001f\u007f]/u;
const MAX_KNOWLEDGE_BYTES = 256 * 1024;

interface KnowledgeFields {
  readonly title: string;
  readonly summary: string;
  readonly decisions: readonly string[];
  readonly constraints: readonly string[];
  readonly verificationEvidence: readonly string[];
  readonly followUps: readonly string[];
}

export interface QualityGateReceipt {
  readonly gate: string;
  readonly command: string;
  readonly outcome: "passed";
  readonly exitCode: 0;
  readonly summary: string;
}

export interface KnowledgeCaptureInput extends KnowledgeFields {
  readonly schemaVersion: 2;
  readonly qualityGateReceipts: readonly QualityGateReceipt[];
}

export interface LegacyKnowledgeRecord extends KnowledgeFields {
  readonly schemaVersion: 1;
  readonly specId: string;
  readonly taskId: string;
}

export interface CurrentKnowledgeRecord extends KnowledgeCaptureInput {
  readonly specId: string;
  readonly taskId: string;
}

export interface DecisionCaptureInput {
  readonly schemaVersion: 3;
  readonly title: string;
  readonly summary: string;
  readonly decisions: readonly string[];
  readonly constraints: readonly string[];
  readonly followUps: readonly string[];
}

export interface DecisionRecord extends DecisionCaptureInput {
  readonly specId: string;
  readonly taskId: string;
  readonly evidencePaths: readonly string[];
}

export type KnowledgeRecord = LegacyKnowledgeRecord | CurrentKnowledgeRecord | DecisionRecord;

function textSchema(label: string, maximum: number) {
  return z.string().max(maximum + 256)
    .transform((value) => value.trim().normalize("NFC"))
    .pipe(z.string()
      .min(1, `${label} must not be blank`)
      .max(maximum, `${label} is too long`)
      .refine(isWellFormedUnicode, `${label} must be well-formed Unicode`)
      .refine((value) => !CONTROL.test(value), `${label} contains control characters`));
}

function textList(label: string, minimum: number) {
  return z.array(textSchema(label, 4_096)).min(minimum).max(64).superRefine((values, context) => {
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

function workItemId(prefix: "SPEC" | "TASK") {
  return z.string().refine(
    (value) => value.startsWith(`${prefix}-`) && isWorkItemId(value),
    `invalid ${prefix} ID`,
  );
}

const knowledgeFields = {
  title: textSchema("knowledge title", 256),
  summary: textSchema("knowledge summary", 4_096),
  decisions: textList("knowledge decisions", 1),
  constraints: textList("knowledge constraints", 1),
  verificationEvidence: textList("knowledge verification evidence", 1),
  followUps: textList("knowledge follow-ups", 0),
} as const;

function safeTextSchema(label: string, maximum: number) {
  return textSchema(label, maximum)
    .refine((value) => !containsSensitiveContent(value), `${label} contains sensitive content`);
}

function safeTextList(label: string, minimum: number) {
  return z.array(safeTextSchema(label, 4_096)).min(minimum).max(64);
}

const decisionFields = {
  title: safeTextSchema("decision title", 256),
  summary: safeTextSchema("decision summary", 4_096),
  decisions: safeTextList("decision", 1),
  constraints: safeTextList("decision constraint", 1),
  followUps: safeTextList("decision follow-up", 0),
} as const;

const receiptSchema = z.object({
  gate: textSchema("quality gate receipt gate", 4_096),
  command: textSchema("quality gate receipt command", 4_096),
  outcome: z.literal("passed"),
  exitCode: z.literal(0),
  summary: textSchema("quality gate receipt summary", 4_096),
}).strict();

const receiptsSchema = z.array(receiptSchema).min(1).max(64).superRefine((receipts, context) => {
  const seen = new Set<string>();
  for (const [index, receipt] of receipts.entries()) {
    const key = unicodeDefaultCaseFold(receipt.gate.normalize("NFKC")).normalize("NFKC");
    if (seen.has(key)) {
      context.addIssue({
        code: "custom",
        path: [index, "gate"],
        message: "quality gate receipts contain a duplicate gate",
      });
    }
    seen.add(key);
  }
});

const captureSchema = z.object({
  schemaVersion: z.literal(2),
  ...knowledgeFields,
  qualityGateReceipts: receiptsSchema,
}).strict();

const legacyRecordSchema = z.object({
  schemaVersion: z.literal(1),
  specId: workItemId("SPEC"),
  taskId: workItemId("TASK"),
  ...knowledgeFields,
}).strict();

const currentRecordSchema = z.object({
  schemaVersion: z.literal(2),
  specId: workItemId("SPEC"),
  taskId: workItemId("TASK"),
  ...knowledgeFields,
  qualityGateReceipts: receiptsSchema,
}).strict();

const decisionCaptureSchema = z.object({
  schemaVersion: z.literal(3),
  ...decisionFields,
}).strict();

const evidencePathSchema = z.string().min(1).max(1_024)
  .regex(/^quality\/runs\/TASK-\d{8}-(?:\d{3}|[1-9]\d{3,})\/[a-z][a-z0-9]*(?:-[a-z0-9]+)*\/\d{6,}\.json$/u);

const decisionRecordSchema = z.object({
  schemaVersion: z.literal(3),
  specId: workItemId("SPEC"),
  taskId: workItemId("TASK"),
  ...decisionFields,
  evidencePaths: z.array(evidencePathSchema).min(1).max(15),
}).strict().superRefine((record, context) => {
  if (new Set(record.evidencePaths).size !== record.evidencePaths.length) {
    context.addIssue({ code: "custom", path: ["evidencePaths"], message: "decision evidence paths contain a duplicate" });
  }
  if (record.evidencePaths.some((path) => !path.startsWith(`quality/runs/${record.taskId}/`))) {
    context.addIssue({ code: "custom", path: ["evidencePaths"], message: "decision evidence path does not match Task" });
  }
});

const readableRecordSchema = z.discriminatedUnion(
  "schemaVersion",
  [legacyRecordSchema, currentRecordSchema, decisionRecordSchema],
);

function freezeReceipts(
  receipts: readonly z.infer<typeof receiptSchema>[],
): readonly QualityGateReceipt[] {
  return Object.freeze(receipts.map((receipt) => Object.freeze({ ...receipt })));
}

function freezeLegacyRecord(
  value: z.infer<typeof legacyRecordSchema>,
): LegacyKnowledgeRecord {
  return Object.freeze({
    ...value,
    decisions: Object.freeze([...value.decisions]),
    constraints: Object.freeze([...value.constraints]),
    verificationEvidence: Object.freeze([...value.verificationEvidence]),
    followUps: Object.freeze([...value.followUps]),
  });
}

function freezeCurrentRecord(
  value: z.infer<typeof currentRecordSchema>,
): CurrentKnowledgeRecord {
  return Object.freeze({
    ...value,
    decisions: Object.freeze([...value.decisions]),
    constraints: Object.freeze([...value.constraints]),
    verificationEvidence: Object.freeze([...value.verificationEvidence]),
    qualityGateReceipts: freezeReceipts(value.qualityGateReceipts),
    followUps: Object.freeze([...value.followUps]),
  });
}

function freezeDecisionRecord(value: z.infer<typeof decisionRecordSchema>): DecisionRecord {
  return Object.freeze({
    ...value,
    decisions: Object.freeze([...value.decisions]),
    constraints: Object.freeze([...value.constraints]),
    followUps: Object.freeze([...value.followUps]),
    evidencePaths: Object.freeze([...value.evidencePaths]),
  });
}

export function parseKnowledgeCaptureInput(value: unknown): KnowledgeCaptureInput {
  const parsed = captureSchema.parse(value);
  return Object.freeze({
    ...parsed,
    decisions: Object.freeze([...parsed.decisions]),
    constraints: Object.freeze([...parsed.constraints]),
    verificationEvidence: Object.freeze([...parsed.verificationEvidence]),
    qualityGateReceipts: freezeReceipts(parsed.qualityGateReceipts),
    followUps: Object.freeze([...parsed.followUps]),
  });
}

export function createKnowledgeRecord(
  specId: string,
  taskId: string,
  input: KnowledgeCaptureInput,
): CurrentKnowledgeRecord {
  return freezeCurrentRecord(currentRecordSchema.parse({
    ...parseKnowledgeCaptureInput(input),
    specId,
    taskId,
  }));
}

export function parseDecisionCaptureInput(value: unknown): DecisionCaptureInput {
  const parsed = decisionCaptureSchema.parse(value);
  return Object.freeze({
    ...parsed,
    decisions: Object.freeze([...parsed.decisions]),
    constraints: Object.freeze([...parsed.constraints]),
    followUps: Object.freeze([...parsed.followUps]),
  });
}

export function createDecisionRecord(
  specId: string,
  taskId: string,
  inputValue: unknown,
  evidencePaths: readonly string[],
): DecisionRecord {
  return freezeDecisionRecord(decisionRecordSchema.parse({
    ...parseDecisionCaptureInput(inputValue),
    specId,
    taskId,
    evidencePaths,
  }));
}

function markdownList(values: readonly string[]): string {
  return values.length === 0 ? "- 无" : values.map((value) => `- ${value}`).join("\n");
}

function serializeRecordDocument(record: KnowledgeRecord): string {
  const frontmatter = stringifyYaml(record, { lineWidth: 0 });
  const sections = [
    "---",
    frontmatter.trimEnd(),
    "---",
    "",
    `# ${record.title}`,
    "",
    record.summary,
    "",
    "## 决策",
    "",
    markdownList(record.decisions),
    "",
    "## 约束",
    "",
    markdownList(record.constraints),
  ];
  if (record.schemaVersion === 3) {
    sections.push(
      "",
      "## Evidence bundles",
      "",
      markdownList(record.evidencePaths),
    );
  } else {
    sections.push(
      "",
      "## 验证证据",
      "",
      markdownList(record.verificationEvidence),
    );
  }
  if (record.schemaVersion === 2) {
    sections.push(
      "",
      "## 质量门回执",
      "",
      ...record.qualityGateReceipts.map((receipt) => (
        `- ${receipt.gate} | ${receipt.command} | passed (0) | ${receipt.summary}`
      )),
    );
  }
  sections.push(
    "",
    "## 后续事项",
    "",
    markdownList(record.followUps),
    "",
  );
  return sections.join("\n");
}

function serializeLegacyKnowledgeRecord(value: LegacyKnowledgeRecord): string {
  return serializeRecordDocument(freezeLegacyRecord(legacyRecordSchema.parse(value)));
}

export function serializeKnowledgeRecord(value: CurrentKnowledgeRecord | DecisionRecord): string {
  return serializeRecordDocument(value.schemaVersion === 2
    ? freezeCurrentRecord(currentRecordSchema.parse(value))
    : freezeDecisionRecord(decisionRecordSchema.parse(value)));
}

export function parseKnowledgeRecordMarkdown(contents: string): KnowledgeRecord {
  if (
    typeof contents !== "string"
    || contents.length === 0
    || Buffer.byteLength(contents, "utf8") > MAX_KNOWLEDGE_BYTES
    || !contents.startsWith("---\n")
  ) {
    throw new TypeError("Knowledge record must be bounded canonical Markdown");
  }
  const end = contents.indexOf("\n---\n", 4);
  if (end < 0) throw new TypeError("Knowledge record frontmatter is incomplete");
  const parsed = readableRecordSchema.parse(parseYaml(contents.slice(4, end)));
  const record: KnowledgeRecord = parsed.schemaVersion === 1
    ? freezeLegacyRecord(parsed)
    : parsed.schemaVersion === 2
      ? freezeCurrentRecord(parsed)
      : freezeDecisionRecord(parsed);
  const canonical = record.schemaVersion === 1
    ? serializeLegacyKnowledgeRecord(record)
    : serializeKnowledgeRecord(record);
  if (canonical !== contents) {
    throw new TypeError("Knowledge record is not canonical");
  }
  return record;
}

export function knowledgeRecordPath(specId: string): string {
  if (!specId.startsWith("SPEC-") || !isWorkItemId(specId)) throw new TypeError("invalid SPEC ID");
  return `knowledge/decisions/${specId}.md`;
}

export function knowledgeContentHash(contents: string): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(contents, "utf8").digest("hex")}`;
}
