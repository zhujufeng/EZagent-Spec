import { describe, expect, test } from "vitest";

import {
  PROJECT_CONTEXT_MAX_BYTES,
  PROJECT_CONTEXT_PATH,
  parseProjectContext,
  parseProjectContextYaml,
  serializeProjectContext,
} from "../../src/workflow/project-context.js";

const validContext = {
  schemaVersion: 1,
  summary: "  结构化管理 Agent 研发流程。  ",
  terms: [{ name: "  质量门  ", meaning: "  Task 完成前必须通过的验证。  " }],
  constraints: ["  默认不共享本地运行数据。  "],
  sources: [{ path: "docs/architecture.md", purpose: "  架构入口。  " }],
} as const;

describe("ProjectContext", () => {
  test("normalizes, freezes, and canonically round-trips a bounded project index", () => {
    const parsed = parseProjectContext(validContext);

    expect(PROJECT_CONTEXT_PATH).toBe("knowledge/project.yaml");
    expect(parsed).toEqual({
      schemaVersion: 1,
      summary: "结构化管理 Agent 研发流程。",
      terms: [{ name: "质量门", meaning: "Task 完成前必须通过的验证。" }],
      constraints: ["默认不共享本地运行数据。"],
      sources: [{ path: "docs/architecture.md", purpose: "架构入口。" }],
    });
    expect(Object.isFrozen(parsed)).toBe(true);
    expect(Object.isFrozen(parsed.terms)).toBe(true);
    expect(Object.isFrozen(parsed.terms[0])).toBe(true);
    expect(Object.isFrozen(parsed.constraints)).toBe(true);
    expect(Object.isFrozen(parsed.sources[0])).toBe(true);

    const yaml = serializeProjectContext(parsed);
    expect(Buffer.byteLength(yaml, "utf8")).toBeLessThanOrEqual(PROJECT_CONTEXT_MAX_BYTES);
    expect(parseProjectContextYaml(yaml)).toEqual(parsed);
    expect(serializeProjectContext(parseProjectContextYaml(yaml))).toBe(yaml);
  });

  test("rejects unknown fields, duplicate values, unsafe paths, and oversized lists", () => {
    expect(() => parseProjectContext({ ...validContext, rawPrompt: "secret" })).toThrow();
    expect(() => parseProjectContext({
      ...validContext,
      constraints: ["Only local", " only LOCAL "],
    })).toThrow(/duplicate/iu);
    expect(() => parseProjectContext({
      ...validContext,
      terms: [
        { name: "API", meaning: "Application interface" },
        { name: "api", meaning: "Duplicate term" },
      ],
    })).toThrow(/duplicate/iu);

    for (const path of [
      "/absolute.md",
      "C:/absolute.md",
      "../outside.md",
      "docs\\windows.md",
      "docs//empty.md",
      "docs/CON.md",
      "docs/trailing. ",
    ]) {
      expect(() => parseProjectContext({
        ...validContext,
        sources: [{ path, purpose: "invalid" }],
      }), path).toThrow();
    }

    expect(() => parseProjectContext({
      ...validContext,
      sources: Array.from({ length: 33 }, (_, index) => ({
        path: `docs/${index}.md`,
        purpose: `source ${index}`,
      })),
    })).toThrow();
  });

  test("rejects malformed or over-budget YAML before returning a value", () => {
    expect(() => parseProjectContextYaml(serializeProjectContext({
      ...parseProjectContext(validContext),
      summary: "e\u0301",
    }))).not.toThrow();
    expect(parseProjectContext({ ...validContext, summary: "e\u0301" }).summary).toBe("é");
    expect(() => parseProjectContextYaml("")) .toThrow(/bounded/iu);
    expect(() => parseProjectContextYaml("x".repeat(PROJECT_CONTEXT_MAX_BYTES + 1)))
      .toThrow(/bounded/iu);
  });
});
