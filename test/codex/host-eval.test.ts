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
  selectHostEvalCases,
  threadIdFromJsonl,
  verifyHostEvalEvidence,
} from "../../scripts/codex-host-eval.js";
import {
  buildCodexPostInitExecArgv,
  ezagentCommandSequenceFromJsonl,
  loadPostInitEvalSuite,
  unexpectedPostInitWorkspacePaths,
  verifyPostInitEvalEvidence,
} from "../../scripts/codex-post-init-eval.js";

const SUITE_PATH = fileURLToPath(
  new URL("../fixtures/codex-host-eval.json", import.meta.url),
);
const POST_INIT_SUITE_PATH = fileURLToPath(
  new URL("../fixtures/codex-post-init-eval.json", import.meta.url),
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
      specialistExpectation: "not-evaluated",
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

function passingPostInitEvidence(): unknown {
  return {
    schemaVersion: 1,
    suiteSchemaVersion: 1,
    runId: "2026-08-25T010203Z",
    createdAt: "2026-08-24T17:02:03.000Z",
    platform: "win32-x64",
    codexVersion: "codex-cli 0.190.0",
    plugin: {
      pluginId: "ezagent-spec@ezagent",
      version: "0.5.0",
    },
    commit: COMMIT,
    case: {
      id: "combined-init-go-planning",
      exitCode: 0,
      timedOut: false,
      initialWorkspaceChanged: false,
      workspaceBeforeSha256: "a".repeat(64),
      workspaceAfterInitialSha256: "a".repeat(64),
      workspaceAfterFollowUpSha256: "c".repeat(64),
      transcriptSha256: TRANSCRIPT_HASH,
      initialized: true,
      workspaceRevision: 0,
      activeWorkItemPresent: false,
      observedCommandSequence: [
        "integration-preview",
        "integration-init",
        "context",
        "work-preview",
      ],
      forbiddenCommandsObserved: [],
      unexpectedWorkspacePaths: [],
      review: {
        status: "pass",
        reason: "Router selected Standard and actually handed the request to ezagent-spec.",
      },
    },
  };
}

describe("Codex host evaluation corpus", () => {
  test("selects one named case for bounded regression runs", async () => {
    const suite = await loadHostEvalSuite(SUITE_PATH);

    expect(selectHostEvalCases(suite, "initialized-indirect-expert-request"))
      .toEqual([expect.objectContaining({ id: "initialized-indirect-expert-request" })]);
    expect(selectHostEvalCases(suite).map(({ id }) => id))
      .toEqual(suite.cases.map(({ id }) => id));
    expect(() => selectHostEvalCases(suite, "missing-case"))
      .toThrow(/unknown.*missing-case/iu);
  });

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
    expect(new Set(suite.cases.map(({ specialistExpectation }) => specialistExpectation)))
      .toEqual(new Set([
        "not-evaluated",
        "not-needed",
        "analysis-delegation",
        "independent-review-delegation",
      ]));
    for (const expectation of [
      "not-needed",
      "analysis-delegation",
      "independent-review-delegation",
    ] as const) {
      expect(suite.cases.filter((fixture) => fixture.specialistExpectation === expectation))
        .toHaveLength(1);
    }
    const delegationCriteria = suite.cases
      .filter(({ specialistExpectation }) => specialistExpectation.endsWith("delegation"))
      .flatMap(({ reviewCriteria }) => reviewCriteria)
      .join("\n");
    expect(delegationCriteria).toMatch(/Work Preview.*批准前.*不得.*实际委派/su);
    expect(delegationCriteria).toMatch(/批准后.*dispatch/su);
    expect(delegationCriteria).toMatch(/有界.*摘要/su);
    for (const fixture of suite.cases) {
      expect(fixture.prompt.trim(), fixture.id).not.toBe("");
      expect(fixture.reviewCriteria.length, fixture.id).toBeGreaterThan(0);
    }
  });

  test("defines the combined initialization and planning regression sequence", async () => {
    const suite = await loadPostInitEvalSuite(POST_INIT_SUITE_PATH);

    expect(suite.schemaVersion).toBe(1);
    expect(suite.pluginId).toBe("ezagent-spec@ezagent");
    expect(suite.case.expectedCommandSequence).toEqual([
      "integration-preview",
      "integration-init",
      "context",
      "work-preview",
    ]);
    expect(suite.case.forbiddenCommands).toContain("work-apply");
    expect(suite.case.forbiddenWorkspacePrefixes).toContain("docs/superpowers/");
    expect(`${suite.case.initialPrompt}\n${suite.case.confirmationPrompt}`)
      .not.toMatch(/Router|context|work-preview|Work Preview/iu);
    expect(suite.case.reviewCriteria.join("\n")).toMatch(/context.*不.*完成.*路由/su);
    expect(suite.case.reviewCriteria.join("\n")).toMatch(/初始化.*批准.*不.*Work Contract/su);
  });
});

describe("Codex host evaluation safety", () => {
  test("builds workspace-write argv while evidence still enforces zero project changes", () => {
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
      "workspace-write",
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
      timeout: 420_000,
      forceKillAfterDelay: 10_000,
    });
  });

  test("builds an isolated workspace-write argv for post-initialization continuation", () => {
    expect(buildCodexPostInitExecArgv(
      "/tmp/post-init-case",
      "启用 EZagent，然后规划 Go 工具",
      "/tmp/post-init-final.txt",
    )).toEqual([
      "exec",
      "--json",
      "--sandbox",
      "workspace-write",
      "--cd",
      "/tmp/post-init-case",
      "--output-last-message",
      "/tmp/post-init-final.txt",
      "启用 EZagent，然后规划 Go 工具",
    ]);
  });

  test("extracts only executed EZagent CLI commands from Codex JSONL", () => {
    const jsonl = [
      JSON.stringify({
        type: "item.completed",
        item: {
          type: "command_execution",
          command: "node /plugin/dist/ezagent-cli.mjs integration-preview --root /tmp/project",
        },
      }),
      JSON.stringify({
        type: "item.completed",
        item: { type: "agent_message", text: "I will not run work-apply." },
      }),
      JSON.stringify({
        type: "item.completed",
        item: {
          type: "command_execution",
          command: "node '/plugin/dist/ezagent-cli.mjs' 'integration-init' --root '/tmp/project'",
        },
      }),
      JSON.stringify({
        type: "item.completed",
        item: {
          type: "command_execution",
          command: "node /plugin/dist/ezagent-cli.mjs context --root /tmp/project --json",
        },
      }),
      JSON.stringify({
        type: "item.completed",
        item: {
          type: "command_execution",
          command: "node /plugin/dist/ezagent-cli.mjs work-preview --root /tmp/project",
        },
      }),
    ].join("\n");

    expect(ezagentCommandSequenceFromJsonl(jsonl)).toEqual([
      "integration-preview",
      "integration-init",
      "context",
      "work-preview",
    ]);
  });

  test("accepts post-init evidence only after the exact safe continuation", async () => {
    const suite = await loadPostInitEvalSuite(POST_INIT_SUITE_PATH);

    expect(verifyPostInitEvalEvidence(passingPostInitEvidence(), suite, COMMIT))
      .toMatchObject({ commit: COMMIT });
  });

  test("allows only integration-managed paths in the post-init workspace", async () => {
    const suite = await loadPostInitEvalSuite(POST_INIT_SUITE_PATH);

    expect(unexpectedPostInitWorkspacePaths([
      "AGENTS.md",
      ".ezagent/project.yaml",
      ".ezagent/state/workspace.json",
      ".codex/agents/ezagent-reviewer.toml",
      "docs/superpowers/plans/portpeek.md",
      "README.md",
    ], suite)).toEqual([
      "README.md",
      "docs/superpowers/plans/portpeek.md",
    ]);
  });

  test.each([
    ["writes before approval", {
      initialWorkspaceChanged: true,
      workspaceAfterInitialSha256: "d".repeat(64),
    }, /before initialization approval/iu],
    ["stops after context", {
      observedCommandSequence: ["integration-preview", "integration-init", "context"],
    }, /command sequence/iu],
    ["applies a Work Contract", {
      workspaceRevision: 1,
      activeWorkItemPresent: true,
    }, /approval boundary/iu],
    ["writes a Superpowers plan", {
      unexpectedWorkspacePaths: ["docs/superpowers/plans/portpeek.md"],
    }, /unexpected paths/iu],
    ["has no completed manual review", {
      review: { status: "pending", reason: "" },
    }, /manual review/iu],
  ] as const)("rejects post-init evidence that %s", async (_name, caseOverride, pattern) => {
    const suite = await loadPostInitEvalSuite(POST_INIT_SUITE_PATH);
    const base = passingPostInitEvidence() as {
      readonly case: Readonly<Record<string, unknown>>;
    } & Readonly<Record<string, unknown>>;
    const evidence = { ...base, case: { ...base.case, ...caseOverride } };

    expect(() => verifyPostInitEvalEvidence(evidence, suite, COMMIT)).toThrow(pattern);
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
