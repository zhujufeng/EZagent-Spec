import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { afterEach, describe, expect, test } from "vitest";

import {
  createKnowledgeRecord,
  knowledgeRecordPath,
  serializeKnowledgeRecord,
} from "../../src/workflow/knowledge.js";
import { parseKnowledgePatternMarkdown } from "../../src/workflow/knowledge-pattern.js";
import { parseProjectContext } from "../../src/workflow/project-context.js";
import {
  cleanupWorkflowTeamFixtures,
  createWorkflowTeamFixture,
} from "../fixtures/workflow-team-fixture.js";

afterEach(cleanupWorkflowTeamFixtures);

const projectContext = parseProjectContext({
  schemaVersion: 1,
  summary: "结构化 Agent 研发流程。",
  terms: [],
  constraints: ["Pattern 必须经人工批准。"],
  sources: [{ path: "README.md", purpose: "项目入口。" }],
});

const promotionDraft = {
  schemaVersion: 1,
  sourceSpecId: "SPEC-20260821-001",
  title: "API 边界校验 Pattern",
  summary: "在 API 边界统一执行结构化校验。",
  tags: ["api", "validation"],
  guidance: ["先解析并规范化输入，再进入业务逻辑。"],
  constraints: ["保持旧字段可读。"],
} as const;

function decision(title = "API 校验完成") {
  return serializeKnowledgeRecord(createKnowledgeRecord(
    "SPEC-20260821-001",
    "TASK-20260821-001",
    {
      schemaVersion: 2,
      title,
      summary: "API 输入校验已完成。",
      decisions: ["统一结构化校验。"],
      constraints: ["保持旧字段可读。"],
      verificationEvidence: ["测试通过。"],
      qualityGateReceipts: [{
        gate: "API 测试",
        command: "npm run test:api",
        outcome: "passed",
        exitCode: 0,
        summary: "API tests passed.",
      }],
      followUps: [],
    },
  ));
}

async function sharedFixture() {
  const fixture = await createWorkflowTeamFixture();
  const sharing = await fixture.service.sharingPreview(projectContext);
  await fixture.service.sharingApply({
    projectContext,
    approvalToken: sharing.approvalToken,
  });
  await writeFile(
    join(fixture.root, ".ezagent", knowledgeRecordPath(promotionDraft.sourceSpecId)),
    decision(),
    "utf8",
  );
  return fixture;
}

describe("Knowledge Pattern promotion", () => {
  test("previews read-only and atomically publishes one scrubbed Pattern after approval", async () => {
    const fixture = await sharedFixture();
    const before = await fixture.snapshot();

    const preview = await fixture.service.knowledgePromotionPreview(promotionDraft);

    expect(preview).toMatchObject({
      pattern: {
        sourceSpecId: promotionDraft.sourceSpecId,
        sourceTaskId: "TASK-20260821-001",
        title: promotionDraft.title,
        sourceKnowledgeHash: expect.stringMatching(/^sha256:[0-9a-f]{64}$/u),
      },
      targetPath: "knowledge/patterns/SPEC-20260821-001.md",
      workspaceRevision: 1,
      approvalToken: expect.stringMatching(/^sha256:[0-9a-f]{64}$/u),
    });
    expect(await fixture.snapshot()).toEqual(before);

    const applied = await fixture.service.knowledgePromotionApply({
      draft: promotionDraft,
      approvalToken: preview.approvalToken,
    });
    expect(applied.workspaceRevision).toBe(2);
    const contents = await readFile(join(fixture.root, ".ezagent", applied.targetPath), "utf8");
    expect(parseKnowledgePatternMarkdown(contents)).toEqual(preview.pattern);
    expect(contents).not.toMatch(/npm run test:api|qualityGateReceipts|verificationEvidence|chat/iu);
    const audit = await readFile(join(fixture.root, ".ezagent", "audit", "events.jsonl"), "utf8");
    expect(audit).not.toContain(promotionDraft.summary);

    const after = await fixture.snapshot();
    await expect(fixture.service.knowledgePromotionPreview(promotionDraft))
      .rejects.toThrow(/already exists/iu);
    expect(await fixture.snapshot()).toEqual(after);
  });

  test("rejects local-only workspaces and supports canonical v1 Knowledge after sharing", async () => {
    const local = await createWorkflowTeamFixture();
    await writeFile(
      join(local.root, ".ezagent", knowledgeRecordPath(promotionDraft.sourceSpecId)),
      decision(),
      "utf8",
    );
    await expect(local.service.knowledgePromotionPreview(promotionDraft))
      .rejects.toThrow(/gitTracking.*artifacts/iu);

    const legacy = await sharedFixture();
    const legacyPath = join(legacy.root, ".ezagent", knowledgeRecordPath(promotionDraft.sourceSpecId));
    await writeFile(legacyPath, `---
schemaVersion: 1
specId: SPEC-20260821-001
taskId: TASK-20260821-001
title: 旧知识
summary: 旧版记录仍可晋升。
decisions:
  - 保持兼容读取。
constraints:
  - 不重写来源。
verificationEvidence:
  - 历史测试通过。
followUps: []
---

# 旧知识

旧版记录仍可晋升。

## 决策

- 保持兼容读取。

## 约束

- 不重写来源。

## 验证证据

- 历史测试通过。

## 后续事项

- 无
`, "utf8");
    await expect(legacy.service.knowledgePromotionPreview(promotionDraft))
      .resolves.toMatchObject({ pattern: { sourceTaskId: "TASK-20260821-001" } });
  });

  test("rejects source drift, stale revision, and safe mode without publishing a Pattern", async () => {
    const drift = await sharedFixture();
    const preview = await drift.service.knowledgePromotionPreview(promotionDraft);
    await writeFile(
      join(drift.root, ".ezagent", knowledgeRecordPath(promotionDraft.sourceSpecId)),
      decision("changed after preview"),
      "utf8",
    );
    const afterDrift = await drift.snapshot();
    await expect(drift.service.knowledgePromotionApply({
      draft: promotionDraft,
      approvalToken: preview.approvalToken,
    })).rejects.toThrow(/approval token/iu);
    expect(await drift.snapshot()).toEqual(afterDrift);

    const stale = await sharedFixture();
    const stalePreview = await stale.service.knowledgePromotionPreview(promotionDraft);
    await stale.bumpWorkspaceRevision();
    const afterBump = await stale.snapshot();
    await expect(stale.service.knowledgePromotionApply({
      draft: promotionDraft,
      approvalToken: stalePreview.approvalToken,
    })).rejects.toThrow(/approval token/iu);
    expect(await stale.snapshot()).toEqual(afterBump);

    const safe = await sharedFixture();
    const state = await safe.repository.readState();
    await safe.repository.recordState(
      { ...state, revision: state.revision + 1, safeMode: true },
      state.revision,
      "fixture-safe-mode",
    );
    const before = await safe.snapshot();
    await expect(safe.service.knowledgePromotionPreview(promotionDraft)).rejects.toThrow(/safe mode/iu);
    expect(await safe.snapshot()).toEqual(before);
  });
});
