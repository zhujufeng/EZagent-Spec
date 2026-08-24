import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { afterEach, describe, expect, test } from "vitest";

import {
  createKnowledgeRecord,
  serializeKnowledgeRecord,
} from "../../src/workflow/knowledge.js";
import {
  createKnowledgePattern,
  parseKnowledgePromotionDraft,
  serializeKnowledgePattern,
} from "../../src/workflow/knowledge-pattern.js";
import {
  parseProjectContext,
  serializeProjectContext,
} from "../../src/workflow/project-context.js";
import {
  cleanupWorkflowTeamFixtures,
  createWorkflowTeamFixture,
} from "../fixtures/workflow-team-fixture.js";

afterEach(cleanupWorkflowTeamFixtures);

const projectContext = parseProjectContext({
  schemaVersion: 1,
  summary: "管理结构化 Agent 研发流程。",
  terms: [{ name: "质量门", meaning: "Task 完成前必须通过的验证。" }],
  constraints: ["共享必须显式启用。"],
  sources: [{ path: "README.md", purpose: "产品入口。" }],
});

function currentDecision(specId: string, taskId: string, title: string, summary: string) {
  return serializeKnowledgeRecord(createKnowledgeRecord(specId, taskId, {
    schemaVersion: 2,
    title,
    summary,
    decisions: ["API 边界统一校验。"],
    constraints: ["保持向后兼容。"],
    verificationEvidence: ["测试通过。"],
    qualityGateReceipts: [{
      gate: "测试通过",
      command: "npm test",
      outcome: "passed",
      exitCode: 0,
      summary: "Tests passed.",
    }],
    followUps: [],
  }));
}

const legacyDecision = `---
schemaVersion: 1
specId: SPEC-20260820-001
taskId: TASK-20260820-001
title: 旧版 API 决策
summary: 历史 API 兼容策略。
decisions:
  - 保持旧字段可读。
constraints:
  - 不重写历史文件。
verificationEvidence:
  - 历史测试通过。
followUps: []
---

# 旧版 API 决策

历史 API 兼容策略。

## 决策

- 保持旧字段可读。

## 约束

- 不重写历史文件。

## 验证证据

- 历史测试通过。

## 后续事项

- 无
`;

describe("shared knowledge context", () => {
  test("treats a missing project index as compatible and returns a frozen null", async () => {
    const fixture = await createWorkflowTeamFixture();

    const resumed = await fixture.service.resumeContext();

    expect(resumed.projectContext).toBeNull();
    expect(resumed.recoveryStatus).toBe("ready");
    expect(resumed.blockers).toEqual([]);
    expect(Object.isFrozen(resumed)).toBe(true);
  });

  test("loads a valid project index and closes failed inspection on corruption", async () => {
    const validFixture = await createWorkflowTeamFixture();
    await writeFile(
      join(validFixture.root, ".ezagent", "knowledge", "project.yaml"),
      serializeProjectContext(projectContext),
      "utf8",
    );
    const resumed = await validFixture.service.resumeContext();
    expect(resumed.projectContext).toEqual(projectContext);
    expect(Object.isFrozen(resumed.projectContext?.sources[0])).toBe(true);

    const corruptFixture = await createWorkflowTeamFixture();
    await writeFile(
      join(corruptFixture.root, ".ezagent", "knowledge", "project.yaml"),
      "schemaVersion: 1\nsummary: broken\nterms: []\nconstraints: []\nsources: []\nunknown: true\n",
      "utf8",
    );
    const corrupt = await corruptFixture.service.resumeContext();
    expect(corrupt).toMatchObject({
      safeMode: true,
      recoveryStatus: "inspection-required",
      projectContext: null,
      blockers: ["project-context-corrupt"],
    });
  });

  test("selects bounded summaries from canonical v1/v2 Decisions and Patterns without persisting terms", async () => {
    const fixture = await createWorkflowTeamFixture();
    const knowledgeRoot = join(fixture.root, ".ezagent", "knowledge");
    await mkdir(join(knowledgeRoot, "decisions"), { recursive: true });
    await mkdir(join(knowledgeRoot, "patterns"), { recursive: true });
    await writeFile(join(knowledgeRoot, "decisions", "SPEC-20260820-001.md"), legacyDecision, "utf8");
    await writeFile(
      join(knowledgeRoot, "decisions", "SPEC-20260821-001.md"),
      currentDecision("SPEC-20260821-001", "TASK-20260821-001", "API 校验", "API 输入必须校验。"),
      "utf8",
    );
    await writeFile(
      join(knowledgeRoot, "decisions", "SPEC-20260822-001.md"),
      currentDecision("SPEC-20260822-001", "TASK-20260822-001", "近期无关决策", "发布文档。"),
      "utf8",
    );
    const pattern = createKnowledgePattern(parseKnowledgePromotionDraft({
      schemaVersion: 1,
      sourceSpecId: "SPEC-20260823-001",
      title: "API 原子发布 Pattern",
      summary: "API 变更先预览再批准。",
      tags: ["api"],
      guidance: ["绑定 revision。"],
      constraints: ["不自动 Git。"],
    }), "TASK-20260823-001", `sha256:${"a".repeat(64)}`);
    await writeFile(
      join(knowledgeRoot, "patterns", "SPEC-20260823-001.md"),
      serializeKnowledgePattern(pattern),
      "utf8",
    );
    const before = await fixture.snapshot();

    const selected = await fixture.service.knowledgeContext({ schemaVersion: 1, terms: ["api"] });

    expect(selected.relevant.map(({ source }) => [source.kind, source.specId])).toEqual([
      ["pattern", "SPEC-20260823-001"],
      ["decision", "SPEC-20260821-001"],
      ["decision", "SPEC-20260820-001"],
    ]);
    expect(selected.recent.map(({ source }) => source.specId)).toEqual(["SPEC-20260822-001"]);
    for (const item of [...selected.relevant, ...selected.recent]) {
      expect(item).toEqual({
        source: item.source,
        path: expect.stringMatching(/^knowledge\/(?:patterns|decisions)\/SPEC-/u),
        title: expect.any(String),
        summary: expect.any(String),
        contentHash: expect.stringMatching(/^sha256:[0-9a-f]{64}$/u),
        relevanceScore: expect.any(Number),
      });
    }
    expect(await fixture.snapshot()).toEqual(before);
  });
});
