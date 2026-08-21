import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { afterEach, describe, expect, test } from "vitest";

import {
  cleanupWorkflowTeamFixtures,
  createAppliedWorkflowTeamFixture,
} from "../fixtures/workflow-team-fixture.js";

afterEach(cleanupWorkflowTeamFixtures);

interface KnowledgeCaptureResult {
  readonly knowledgePath: string;
  readonly knowledgeHash: `sha256:${string}`;
  readonly task: { readonly status: string; readonly revision: number };
  readonly state: { readonly activeWorkItem: null; readonly revision: number };
}

interface KnowledgeCompleter {
  completeActiveTask(expectedTaskRevision: number, input: unknown): Promise<KnowledgeCaptureResult>;
}

describe("minimal Knowledge completion", () => {
  test("atomically completes a verified Task and restores bounded Knowledge in a fresh session", async () => {
    const fixture = await createAppliedWorkflowTeamFixture();
    await fixture.service.transitionActiveTask("implementing", 0);
    await fixture.service.transitionActiveTask("verifying", 1);

    expect(fixture.service).toHaveProperty("completeActiveTask");
    const result = await (fixture.service as unknown as KnowledgeCompleter).completeActiveTask(2, {
      schemaVersion: 1,
      title: "用户资料校验完成",
      summary: "资料 API 已拒绝非法输入并通过回归测试。",
      decisions: ["在 API 边界统一执行结构化校验。"],
      constraints: ["保持现有登录流程不变。"],
      verificationEvidence: ["API 单元测试与独立审查通过。"],
      followUps: ["后续复用同一套字段错误结构。"],
    });

    expect(result).toMatchObject({
      knowledgePath: `knowledge/decisions/${fixture.applied.spec.id}.md`,
      knowledgeHash: expect.stringMatching(/^sha256:[0-9a-f]{64}$/u),
      task: { status: "completed", revision: 3 },
      state: { activeWorkItem: null, revision: 4 },
    });
    const persisted = await readFile(join(fixture.root, ".ezagent", result.knowledgePath), "utf8");
    expect(persisted).toContain("用户资料校验完成");
    expect(persisted).not.toMatch(/chat|transcript/iu);

    const resumed = await fixture.freshService().resumeContext() as unknown as {
      readonly knowledge: readonly Record<string, unknown>[];
      readonly task: null;
      readonly team: null;
    };
    expect(resumed.task).toBeNull();
    expect(resumed.team).toBeNull();
    expect(resumed.knowledge).toEqual([{
      specId: fixture.applied.spec.id,
      taskId: fixture.taskId,
      path: result.knowledgePath,
      title: "用户资料校验完成",
      summary: "资料 API 已拒绝非法输入并通过回归测试。",
      contentHash: result.knowledgeHash,
    }]);
  });

  test("rejects unsupported Knowledge fields without changing project state", async () => {
    const fixture = await createAppliedWorkflowTeamFixture();
    await fixture.service.transitionActiveTask("implementing", 0);
    await fixture.service.transitionActiveTask("verifying", 1);
    const before = await fixture.snapshot();

    expect(fixture.service).toHaveProperty("completeActiveTask");
    await expect((fixture.service as unknown as KnowledgeCompleter).completeActiveTask(2, {
      schemaVersion: 1,
      title: "用户资料校验完成",
      summary: "完成。",
      decisions: ["使用结构化校验。"],
      constraints: ["不改变登录。"],
      verificationEvidence: ["测试通过。"],
      followUps: [],
      chatTranscript: "不应持久化的聊天内容",
    })).rejects.toThrow();
    expect(await fixture.snapshot()).toEqual(before);
  });
});
