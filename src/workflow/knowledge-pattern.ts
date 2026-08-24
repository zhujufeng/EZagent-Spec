import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { z } from "zod";

import { isWorkItemId } from "../domain/id.js";
import { unicodeDefaultCaseFold } from "../text/unicode-case-fold.js";
import { isWellFormedUnicode } from "../text/unicode.js";

export const KNOWLEDGE_PATTERN_MAX_BYTES = 128 * 1024;

export interface KnowledgePromotionDraft {
  readonly schemaVersion: 1;
  readonly sourceSpecId: string;
  readonly title: string;
  readonly summary: string;
  readonly tags: readonly string[];
  readonly guidance: readonly string[];
  readonly constraints: readonly string[];
}

export interface KnowledgePattern extends KnowledgePromotionDraft {
  readonly sourceTaskId: string;
  readonly sourceKnowledgeHash: `sha256:${string}`;
}

const CONTROL = /[\u0000-\u001f\u007f]/u;
const HASH = /^sha256:[0-9a-f]{64}$/u;
const RAW_PADDING = 256;

function textSchema(label: string, maximum: number) {
  return z.string().max(maximum + RAW_PADDING)
    .transform((value) => value.trim().normalize("NFC"))
    .pipe(z.string()
      .min(1, `${label} must not be blank`)
      .max(maximum, `${label} is too long`)
      .refine(isWellFormedUnicode, `${label} must be well-formed Unicode`)
      .refine((value) => !CONTROL.test(value), `${label} contains control characters`));
}

function workItemId(prefix: "SPEC" | "TASK") {
  return z.string().refine(
    (value) => value.startsWith(`${prefix}-`) && isWorkItemId(value),
    `invalid ${prefix} ID`,
  );
}

function duplicateKey(value: string): string {
  return unicodeDefaultCaseFold(value.normalize("NFKC")).normalize("NFKC");
}

function textList(label: string, maximumLength: number) {
  return z.array(textSchema(label, maximumLength)).max(32).superRefine((values, context) => {
    const seen = new Set<string>();
    for (const [index, value] of values.entries()) {
      const key = duplicateKey(value);
      if (seen.has(key)) {
        context.addIssue({ code: "custom", path: [index], message: `${label} contains a duplicate` });
      }
      seen.add(key);
    }
  });
}

const promotionDraftSchema = z.object({
  schemaVersion: z.literal(1),
  sourceSpecId: workItemId("SPEC"),
  title: textSchema("Pattern title", 256),
  summary: textSchema("Pattern summary", 4_096),
  tags: textList("Pattern tags", 128),
  guidance: textList("Pattern guidance", 4_096),
  constraints: textList("Pattern constraints", 4_096),
}).strict();

const patternSchema = promotionDraftSchema.extend({
  sourceTaskId: workItemId("TASK"),
  sourceKnowledgeHash: z.string().regex(HASH),
}).strict();

function freezeDraft(value: z.infer<typeof promotionDraftSchema>): KnowledgePromotionDraft {
  return Object.freeze({
    ...value,
    tags: Object.freeze([...value.tags]),
    guidance: Object.freeze([...value.guidance]),
    constraints: Object.freeze([...value.constraints]),
  });
}

function freezePattern(value: z.infer<typeof patternSchema>): KnowledgePattern {
  return Object.freeze({
    ...value,
    tags: Object.freeze([...value.tags]),
    guidance: Object.freeze([...value.guidance]),
    constraints: Object.freeze([...value.constraints]),
    sourceKnowledgeHash: value.sourceKnowledgeHash as `sha256:${string}`,
  });
}

export function parseKnowledgePromotionDraft(value: unknown): KnowledgePromotionDraft {
  return freezeDraft(promotionDraftSchema.parse(value));
}

export function createKnowledgePattern(
  draft: KnowledgePromotionDraft,
  sourceTaskId: string,
  sourceKnowledgeHash: string,
): KnowledgePattern {
  return freezePattern(patternSchema.parse({
    ...parseKnowledgePromotionDraft(draft),
    sourceTaskId,
    sourceKnowledgeHash,
  }));
}

function markdownList(values: readonly string[]): string {
  return values.length === 0 ? "- 无" : values.map((value) => `- ${value}`).join("\n");
}

function serializeParsedPattern(pattern: KnowledgePattern): string {
  return [
    "---",
    stringifyYaml(pattern, { lineWidth: 0 }).trimEnd(),
    "---",
    "",
    `# ${pattern.title}`,
    "",
    pattern.summary,
    "",
    "## 标签",
    "",
    markdownList(pattern.tags),
    "",
    "## 指引",
    "",
    markdownList(pattern.guidance),
    "",
    "## 约束",
    "",
    markdownList(pattern.constraints),
    "",
  ].join("\n");
}

export function serializeKnowledgePattern(value: KnowledgePattern): string {
  const pattern = freezePattern(patternSchema.parse(value));
  const contents = serializeParsedPattern(pattern);
  if (Buffer.byteLength(contents, "utf8") > KNOWLEDGE_PATTERN_MAX_BYTES) {
    throw new TypeError(`Knowledge Pattern exceeds ${KNOWLEDGE_PATTERN_MAX_BYTES} bytes`);
  }
  return contents;
}

export function parseKnowledgePatternMarkdown(contents: string): KnowledgePattern {
  if (typeof contents !== "string"
    || contents.length === 0
    || Buffer.byteLength(contents, "utf8") > KNOWLEDGE_PATTERN_MAX_BYTES
    || !contents.startsWith("---\n")
    || !isWellFormedUnicode(contents)) {
    throw new TypeError("Knowledge Pattern must be bounded canonical Markdown");
  }
  const end = contents.indexOf("\n---\n", 4);
  if (end < 0) throw new TypeError("Knowledge Pattern frontmatter is incomplete");
  const pattern = freezePattern(patternSchema.parse(parseYaml(contents.slice(4, end))));
  if (serializeParsedPattern(pattern) !== contents) {
    throw new TypeError("Knowledge Pattern is not canonical");
  }
  return pattern;
}

export function knowledgePatternPath(sourceSpecId: string): string {
  if (!sourceSpecId.startsWith("SPEC-") || !isWorkItemId(sourceSpecId)) {
    throw new TypeError("invalid source SPEC ID");
  }
  return `knowledge/patterns/${sourceSpecId}.md`;
}
