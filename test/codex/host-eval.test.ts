import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, test } from "vitest";

import {
  buildCodexExecArgv,
  buildCodexResumeArgv,
  createArtifactRunRoot,
  hostEvalProcessOptions,
  installedPlugin,
  loadHostEvalSuite,
  threadIdFromJsonl,
  verifyHostEvalEvidence,
} from "../../scripts/codex-host-eval.js";

const SUITE_PATH = fileURLToPath(
  new URL("../fixtures/codex-host-eval.json", import.meta.url),
);
const COMMIT = "a".repeat(40);
const TRANSCRIPT_HASH = "b".repeat(64);
const temporaryPaths: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryPaths.splice(0).map((path) => (
    rm(path, { recursive: true, force: true })
  )));
});

function passingEvidence(): unknown {
  return {
    schemaVersion: 1,
    suiteSchemaVersion: 1,
    runId: "2026-08-22T010203Z",
    createdAt: "2026-08-21T17:02:03.000Z",
    platform: "darwin-arm64",
    codexVersion: "codex-cli 0.148.0",
    plugin: {
      pluginId: "ezagent-spec@ezagent",
      version: "0.1.0",
    },
    commit: COMMIT,
    cases: [{
      id: "explicit-init",
      expectedPolicy: "initialize",
      exitCode: 0,
      timedOut: false,
      workspaceChanged: false,
      workspaceBeforeSha256: TRANSCRIPT_HASH,
      workspaceAfterSha256: TRANSCRIPT_HASH,
      transcriptSha256: TRANSCRIPT_HASH,
      review: {
        status: "pass",
        reason: "Entered initialization preview and requested confirmation before writes.",
      },
    }],
  };
}

describe("Codex host evaluation corpus", () => {
  test("covers every activation policy and behavioral category", async () => {
    const suite = await loadHostEvalSuite(SUITE_PATH);

    expect(suite.schemaVersion).toBe(1);
    expect(suite.pluginId).toBe("ezagent-spec@ezagent");
    expect(new Set(suite.cases.map(({ id }) => id)).size).toBe(suite.cases.length);
    expect(new Set(suite.cases.map(({ expectedPolicy }) => expectedPolicy))).toEqual(new Set([
      "consult-no-work",
      "no-workflow",
      "initialize",
      "router-quick",
      "router-brief",
      "router-standard",
      "router-controlled",
    ]));
    expect(new Set(suite.cases.flatMap(({ categories }) => categories))).toEqual(new Set([
      "explicit",
      "implicit",
      "negative",
      "boundary",
      "follow-up",
    ]));
    expect(suite.cases.filter(({ followUpPrompt }) => followUpPrompt !== undefined)).toHaveLength(1);
    for (const fixture of suite.cases) {
      expect(fixture.prompt.trim(), fixture.id).not.toBe("");
      expect(fixture.reviewCriteria.length, fixture.id).toBeGreaterThan(0);
    }
  });
});

describe("Codex host evaluation safety", () => {
  test("builds read-only argv without a shell or sandbox bypass", () => {
    expect(buildCodexExecArgv(
      "/tmp/host-case",
      "帮我实现登录页",
      "/tmp/final.txt",
      true,
    )).toEqual([
      "exec",
      "--json",
      "--ephemeral",
      "--sandbox",
      "read-only",
      "--cd",
      "/tmp/host-case",
      "--output-last-message",
      "/tmp/final.txt",
      "帮我实现登录页",
    ]);
    expect(buildCodexResumeArgv(
      "019c0000-0000-7000-8000-000000000000",
      "继续",
      "/tmp/follow-up.txt",
    )).toEqual([
      "exec",
      "resume",
      "--json",
      "--ephemeral",
      "--output-last-message",
      "/tmp/follow-up.txt",
      "019c0000-0000-7000-8000-000000000000",
      "继续",
    ]);
    expect(hostEvalProcessOptions("/tmp/host-case")).toEqual({
      cwd: "/tmp/host-case",
      reject: false,
      shell: false,
      stdin: "ignore",
      timeout: 240_000,
      forceKillAfterDelay: 10_000,
    });
  });

  test("requires the exact installed and enabled plugin", () => {
    expect(installedPlugin({
      installed: [{
        pluginId: "ezagent-spec@ezagent",
        name: "ezagent-spec",
        marketplaceName: "ezagent",
        version: "0.1.0",
        installed: true,
        enabled: true,
      }],
    })).toMatchObject({ pluginId: "ezagent-spec@ezagent", version: "0.1.0" });
    expect(() => installedPlugin({ installed: [] }))
      .toThrow(/ezagent-spec@ezagent.*not installed/iu);
    expect(() => installedPlugin({
      installed: [{
        pluginId: "ezagent-spec@ezagent",
        name: "ezagent-spec",
        marketplaceName: "ezagent",
        version: "0.1.0",
        installed: true,
        enabled: false,
      }],
    })).toThrow(/ezagent-spec@ezagent.*not installed/iu);
  });

  test("parses one thread id from Codex JSONL", () => {
    const jsonl = [
      JSON.stringify({ type: "thread.started", thread_id: "019c0000-0000-7000-8000-000000000000" }),
      JSON.stringify({ type: "turn.completed" }),
    ].join("\n");

    expect(threadIdFromJsonl(jsonl)).toBe("019c0000-0000-7000-8000-000000000000");
    expect(() => threadIdFromJsonl('{"type":"turn.completed"}\n')).toThrow(/thread.started/iu);
  });

  test("creates the artifact parent and one fresh run directory", async () => {
    const root = await mkdtemp(join(tmpdir(), "ezagent-host-eval-test-"));
    temporaryPaths.push(root);

    const runRoot = await createArtifactRunRoot(
      join(root, ".artifacts", "codex-host-eval"),
      "20260822T010203000Z",
    );

    await expect(stat(runRoot)).resolves.toMatchObject({});
    expect(runRoot).toBe(join(root, ".artifacts", "codex-host-eval", "20260822T010203000Z"));
    await expect(createArtifactRunRoot(
      join(root, ".artifacts", "codex-host-eval"),
      "../escape",
    )).rejects.toThrow(/run id/iu);
  });

  test("accepts complete evidence bound to the expected cases and commit", () => {
    expect(verifyHostEvalEvidence(passingEvidence(), ["explicit-init"], COMMIT))
      .toMatchObject({ commit: COMMIT });
  });

  test.each([
    ["missing case", { cases: [] }],
    ["duplicate case", {
      cases: [
        (passingEvidence() as { cases: unknown[] }).cases[0],
        (passingEvidence() as { cases: unknown[] }).cases[0],
      ],
    }],
    ["non-zero exit", { cases: [{
      ...(passingEvidence() as { cases: Array<Record<string, unknown>> }).cases[0],
      exitCode: 1,
    }] }],
    ["timeout", { cases: [{
      ...(passingEvidence() as { cases: Array<Record<string, unknown>> }).cases[0],
      timedOut: true,
    }] }],
    ["changed workspace", { cases: [{
      ...(passingEvidence() as { cases: Array<Record<string, unknown>> }).cases[0],
      workspaceChanged: true,
      workspaceAfterSha256: "c".repeat(64),
    }] }],
    ["empty transcript hash", { cases: [{
      ...(passingEvidence() as { cases: Array<Record<string, unknown>> }).cases[0],
      transcriptSha256: "",
    }] }],
    ["pending review", { cases: [{
      ...(passingEvidence() as { cases: Array<Record<string, unknown>> }).cases[0],
      review: { status: "pending", reason: "" },
    }] }],
    ["empty passing reason", { cases: [{
      ...(passingEvidence() as { cases: Array<Record<string, unknown>> }).cases[0],
      review: { status: "pass", reason: "" },
    }] }],
  ])("rejects %s evidence", (_name, override) => {
    const evidence = { ...(passingEvidence() as Record<string, unknown>), ...override };
    expect(() => verifyHostEvalEvidence(evidence, ["explicit-init"], COMMIT)).toThrow();
  });

  test("rejects evidence for a stale commit", () => {
    expect(() => verifyHostEvalEvidence(passingEvidence(), ["explicit-init"], "c".repeat(40)))
      .toThrow(/commit/iu);
  });
});
