import { describe, expect, test } from "vitest";

import {
  parseKnowledgeContextQuery,
  selectKnowledge,
  type KnowledgeCandidate,
} from "../../src/workflow/knowledge-selection.js";

const hash = (character: string): `sha256:${string}` => `sha256:${character.repeat(64)}`;

function pattern(
  specId: string,
  fields: Partial<Omit<Extract<KnowledgeCandidate, { source: { kind: "pattern" } }>, "source" | "path" | "contentHash">> = {},
): KnowledgeCandidate {
  return {
    source: { kind: "pattern", specId },
    path: `knowledge/patterns/${specId}.md`,
    title: "通用经验",
    summary: "团队经验摘要",
    tags: [],
    guidance: [],
    constraints: [],
    contentHash: hash("a"),
    ...fields,
  };
}

function decision(
  specId: string,
  fields: Partial<Omit<Extract<KnowledgeCandidate, { source: { kind: "decision" } }>, "source" | "path" | "contentHash">> = {},
): KnowledgeCandidate {
  return {
    source: { kind: "decision", specId },
    path: `knowledge/decisions/${specId}.md`,
    title: "任务决策",
    summary: "任务知识摘要",
    decisions: [],
    constraints: [],
    contentHash: hash("b"),
    ...fields,
  };
}

describe("Knowledge selection", () => {
  test("parses a short, normalized, unique and frozen query", () => {
    const query = parseKnowledgeContextQuery({
      schemaVersion: 1,
      terms: ["  API  ", "e\u0301"],
    });
    expect(query.terms).toEqual(["API", "é"]);
    expect(Object.isFrozen(query)).toBe(true);
    expect(Object.isFrozen(query.terms)).toBe(true);

    expect(() => parseKnowledgeContextQuery({ schemaVersion: 1, terms: ["API", " api "] }))
      .toThrow(/duplicate/iu);
    expect(() => parseKnowledgeContextQuery({
      schemaVersion: 1,
      terms: Array.from({ length: 17 }, (_, index) => `${index}`),
    })).toThrow();
    expect(() => parseKnowledgeContextQuery({ schemaVersion: 1, terms: ["x".repeat(129)] }))
      .toThrow();
  });

  test("scores every matching field with Unicode case folding", () => {
    const selected = selectKnowledge(
      { schemaVersion: 1, terms: ["STRASSE"] },
      [pattern("SPEC-20260824-001", {
        title: "Straße 发布",
        summary: "Straße 摘要",
        tags: ["Straße"],
        guidance: ["复用 Straße 流程"],
        constraints: ["Straße 只在本地"],
      })],
    );

    expect(selected.relevant).toHaveLength(1);
    expect(selected.relevant[0]?.relevanceScore).toBe(10);
    expect(Object.isFrozen(selected.relevant[0]?.source)).toBe(true);
  });

  test("returns at most three ranked relevant and two deduplicated recent decisions", () => {
    const candidates = [
      decision("SPEC-20260824-006", { summary: "unrelated newest" }),
      decision("SPEC-20260824-005", { title: "API decision" }),
      pattern("SPEC-20260824-005", { title: "API pattern" }),
      decision("SPEC-20260824-004", { summary: "API summary" }),
      pattern("SPEC-20260824-003", { summary: "API summary" }),
      decision("SPEC-20260824-002", { decisions: ["API detail"] }),
      decision("SPEC-20260824-001", { summary: "unrelated oldest" }),
    ];

    const selected = selectKnowledge({ schemaVersion: 1, terms: ["api"] }, candidates);

    expect(selected.relevant.map(({ source, relevanceScore }) => [source.kind, source.specId, relevanceScore]))
      .toEqual([
        ["pattern", "SPEC-20260824-005", 3],
        ["pattern", "SPEC-20260824-003", 2],
        ["decision", "SPEC-20260824-004", 2],
      ]);
    expect(selected.recent.map(({ source, relevanceScore }) => [source.specId, relevanceScore]))
      .toEqual([
        ["SPEC-20260824-006", 0],
        ["SPEC-20260824-002", 1],
      ]);
    expect([...selected.relevant, ...selected.recent]).toHaveLength(5);
    expect(new Set([...selected.relevant, ...selected.recent].map(({ source }) => source.specId)).size)
      .toBe(5);
  });

  test("prefers Pattern on equal scores and never fills relevant with zero-score records", () => {
    const selected = selectKnowledge({ schemaVersion: 1, terms: ["atomic"] }, [
      decision("SPEC-20260824-003", { title: "atomic decision" }),
      pattern("SPEC-20260824-002", { title: "atomic pattern" }),
      decision("SPEC-20260824-001", { title: "unrelated" }),
    ]);

    expect(selected.relevant.map(({ source }) => source.kind)).toEqual(["pattern", "decision"]);
    expect(selected.relevant).toHaveLength(2);
    expect(selected.recent.map(({ source }) => source.specId)).toEqual(["SPEC-20260824-001"]);
  });
});
