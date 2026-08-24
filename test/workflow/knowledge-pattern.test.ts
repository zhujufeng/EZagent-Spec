import { describe, expect, test } from "vitest";

import {
  KNOWLEDGE_PATTERN_MAX_BYTES,
  createKnowledgePattern,
  knowledgePatternPath,
  parseKnowledgePatternMarkdown,
  parseKnowledgePromotionDraft,
  serializeKnowledgePattern,
} from "../../src/workflow/knowledge-pattern.js";

const draft = {
  schemaVersion: 1,
  sourceSpecId: "SPEC-20260824-001",
  title: "  原子发布 Pattern  ",
  summary: "  先验证所有输入，再发布 mutation。  ",
  tags: ["  workspace  ", "atomic-write"],
  guidance: ["  将预览 token 绑定 workspace revision。  "],
  constraints: ["  不执行自动 Git 操作。  "],
} as const;

describe("KnowledgePattern", () => {
  test("builds one frozen canonical Pattern from a normalized promotion draft", () => {
    const normalized = parseKnowledgePromotionDraft(draft);
    const pattern = createKnowledgePattern(
      normalized,
      "TASK-20260824-001",
      `sha256:${"a".repeat(64)}`,
    );

    expect(knowledgePatternPath(pattern.sourceSpecId)).toBe(
      "knowledge/patterns/SPEC-20260824-001.md",
    );
    expect(pattern).toMatchObject({
      title: "原子发布 Pattern",
      summary: "先验证所有输入，再发布 mutation。",
      tags: ["workspace", "atomic-write"],
      sourceTaskId: "TASK-20260824-001",
    });
    expect(Object.isFrozen(pattern)).toBe(true);
    expect(Object.isFrozen(pattern.tags)).toBe(true);
    expect(Object.isFrozen(pattern.guidance)).toBe(true);

    const markdown = serializeKnowledgePattern(pattern);
    expect(Buffer.byteLength(markdown, "utf8")).toBeLessThanOrEqual(KNOWLEDGE_PATTERN_MAX_BYTES);
    expect(parseKnowledgePatternMarkdown(markdown)).toEqual(pattern);
    expect(serializeKnowledgePattern(parseKnowledgePatternMarkdown(markdown))).toBe(markdown);
  });

  test("rejects unknown fields, duplicate terms, unsafe IDs, hashes, and noncanonical Markdown", () => {
    expect(() => parseKnowledgePromotionDraft({ ...draft, rawKnowledge: "secret" })).toThrow();
    expect(() => parseKnowledgePromotionDraft({ ...draft, tags: ["API", " api "] }))
      .toThrow(/duplicate/iu);
    expect(() => parseKnowledgePromotionDraft({ ...draft, sourceSpecId: "../SPEC-1" })).toThrow();
    expect(() => createKnowledgePattern(
      parseKnowledgePromotionDraft(draft),
      "TASK-20260824-001",
      "sha256:BAD",
    )).toThrow();

    const pattern = createKnowledgePattern(
      parseKnowledgePromotionDraft(draft),
      "TASK-20260824-001",
      `sha256:${"b".repeat(64)}`,
    );
    expect(() => parseKnowledgePatternMarkdown(`${serializeKnowledgePattern(pattern)}\n`))
      .toThrow(/canonical/iu);
  });
});
