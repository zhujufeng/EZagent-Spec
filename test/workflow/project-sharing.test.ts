import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { afterEach, describe, expect, test } from "vitest";

import { parseProjectContext } from "../../src/workflow/project-context.js";
import {
  cleanupWorkflowTeamFixtures,
  createWorkflowTeamFixture,
} from "../fixtures/workflow-team-fixture.js";

afterEach(cleanupWorkflowTeamFixtures);

const sharedContext = parseProjectContext({
  schemaVersion: 1,
  summary: "提供轻量、结构化的 Agent 研发流程。",
  terms: [{ name: "Pattern", meaning: "经人工批准的团队经验。" }],
  constraints: ["不自动执行 Git。"],
  sources: [{ path: "README.md", purpose: "项目入口。" }],
});

describe("explicit artifact sharing", () => {
  test("previews without writes and atomically enables or updates artifact sharing", async () => {
    const fixture = await createWorkflowTeamFixture();
    const before = await fixture.snapshot();

    const preview = await fixture.service.sharingPreview(sharedContext);

    expect(preview).toMatchObject({
      currentGitTracking: "none",
      targetGitTracking: "artifacts",
      writePaths: ["project.yaml", "knowledge/project.yaml"],
      workspaceRevision: 0,
      approvalToken: expect.stringMatching(/^sha256:[0-9a-f]{64}$/u),
    });
    expect(preview.sharedPaths).toContain("knowledge/patterns/SPEC-*.md");
    expect(preview.excludedPaths).toContain("audit/**");
    expect(await fixture.snapshot()).toEqual(before);

    const applied = await fixture.service.sharingApply({
      projectContext: sharedContext,
      approvalToken: preview.approvalToken,
    });
    expect(applied).toMatchObject({ workspaceRevision: 1, gitTracking: "artifacts" });
    expect((await fixture.repository.readProject()).gitTracking).toBe("artifacts");
    expect(await readFile(join(fixture.root, ".ezagent", "knowledge", "project.yaml"), "utf8"))
      .toContain("提供轻量、结构化的 Agent 研发流程");
    expect(await readFile(join(fixture.root, ".ezagent", "audit", "events.jsonl"), "utf8"))
      .not.toContain("提供轻量、结构化的 Agent 研发流程");
    await expect(readFile(join(fixture.root, ".gitignore"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });

    const updatedContext = parseProjectContext({
      ...sharedContext,
      constraints: [...sharedContext.constraints, "只共享摘要和路径。"],
    });
    const updatePreview = await fixture.service.sharingPreview(updatedContext);
    expect(updatePreview.currentGitTracking).toBe("artifacts");
    const updated = await fixture.service.sharingApply({
      projectContext: updatedContext,
      approvalToken: updatePreview.approvalToken,
    });
    expect(updated.workspaceRevision).toBe(2);
  });

  test("rejects stale, changed, or cross-project approvals without any additional write", async () => {
    const fixture = await createWorkflowTeamFixture();
    const other = await createWorkflowTeamFixture();
    const preview = await fixture.service.sharingPreview(sharedContext);
    const before = await fixture.snapshot();

    await expect(fixture.service.sharingApply({
      projectContext: parseProjectContext({ ...sharedContext, summary: "changed" }),
      approvalToken: preview.approvalToken,
    })).rejects.toThrow(/approval token/iu);
    await expect(other.service.sharingApply({
      projectContext: sharedContext,
      approvalToken: preview.approvalToken,
    })).rejects.toThrow(/approval token/iu);
    expect(await fixture.snapshot()).toEqual(before);

    await fixture.bumpWorkspaceRevision();
    const afterBump = await fixture.snapshot();
    await expect(fixture.service.sharingApply({
      projectContext: sharedContext,
      approvalToken: preview.approvalToken,
    })).rejects.toThrow(/approval token/iu);
    expect(await fixture.snapshot()).toEqual(afterBump);
  });

  test("rejects all-mode and safe-mode workspaces before previewing", async () => {
    const allFixture = await createWorkflowTeamFixture();
    await writeFile(
      join(allFixture.root, ".ezagent", "project.yaml"),
      "schemaVersion: 1\nname: expert test\ngitTracking: all\n",
      "utf8",
    );
    await expect(allFixture.service.sharingPreview(sharedContext)).rejects.toThrow(/none or artifacts/iu);

    const safeFixture = await createWorkflowTeamFixture();
    const state = await safeFixture.repository.readState();
    await safeFixture.repository.recordState(
      { ...state, revision: state.revision + 1, safeMode: true },
      state.revision,
      "fixture-safe-mode",
    );
    const before = await safeFixture.snapshot();
    await expect(safeFixture.service.sharingPreview(sharedContext)).rejects.toThrow(/safe mode/iu);
    expect(await safeFixture.snapshot()).toEqual(before);
  });
});
