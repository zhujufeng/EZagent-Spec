import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { execa } from "execa";
import { afterEach, describe, expect, test } from "vitest";

const REPOSITORY_ROOT = resolve(import.meta.dirname, "../..");
const PLUGIN_ROOT = join(REPOSITORY_ROOT, "plugins", "ezagent-spec");
const HOOK_PATH = join(PLUGIN_ROOT, "hooks", "ezagent-router-prompt.mjs");
const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((path) => (
    rm(path, { recursive: true, force: true })
  )));
});

async function temporaryProject(initialized: boolean): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "ezagent-prompt-hook-"));
  temporaryRoots.push(root);
  if (initialized) {
    await mkdir(join(root, ".ezagent"));
    await writeFile(join(root, ".ezagent", "project.yaml"), "schemaVersion: 1\n", "utf8");
  }
  return root;
}

async function runHook(cwd: string, prompt: string): Promise<{
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}> {
  const result = await execa(process.execPath, [HOOK_PATH], {
    cwd,
    env: {
      ...process.env,
      PLUGIN_ROOT,
      PLUGIN_DATA: join(tmpdir(), "ezagent-prompt-hook-data"),
      CLAUDE_PLUGIN_ROOT: PLUGIN_ROOT,
    },
    input: JSON.stringify({
      session_id: "test-session",
      turn_id: "test-turn",
      cwd,
      hook_event_name: "UserPromptSubmit",
      prompt,
    }),
    reject: false,
    timeout: 5_000,
  });
  return {
    exitCode: result.exitCode ?? -1,
    stdout: result.stdout,
    stderr: result.stderr,
  };
}

describe("EZagent per-prompt Router hook", () => {
  test("injects Router ownership for every independent prompt in an initialized project", async () => {
    const project = await temporaryProject(true);
    const nested = join(project, "packages", "app");
    await mkdir(nested, { recursive: true });

    for (const prompt of [
      "给订单列表增加导出功能",
      "这是另一个全新需求：分析库存预警偏差",
    ]) {
      const result = await runHook(nested, prompt);

      expect(result.exitCode, result.stderr).toBe(0);
      expect(result.stderr).toBe("");
      const output = JSON.parse(result.stdout) as {
        readonly hookSpecificOutput?: {
          readonly hookEventName?: string;
          readonly additionalContext?: string;
        };
      };
      expect(output.hookSpecificOutput?.hookEventName).toBe("UserPromptSubmit");
      expect(output.hookSpecificOutput?.additionalContext)
        .toMatch(/ezagent-spec:ezagent-router.*\$ezagent-router/su);
      expect(output.hookSpecificOutput?.additionalContext)
        .toMatch(/session-[0-9a-f]{64}.*--session/su);
      expect(output.hookSpecificOutput?.additionalContext).not.toContain("test-session");
      expect(result.stdout).not.toContain(prompt);
    }
  });

  test("is a silent no-op outside initialized projects", async () => {
    const project = await temporaryProject(false);
    const result = await runHook(project, "普通问题");

    expect(result.exitCode, result.stderr).toBe(0);
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe("");
  });
});
