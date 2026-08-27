import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { describe, expect, test } from "vitest";

const PROJECT_ROOT = fileURLToPath(new URL("../../", import.meta.url));

async function readJson(relativePath: string): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(new URL(relativePath, `file://${PROJECT_ROOT}/`), "utf8")) as Record<
    string,
    unknown
  >;
}

describe("EZagent Work Harness Codex plugin metadata", () => {
  test("declares the plugin manifest with per-prompt Router activation", async () => {
    const manifest = await readJson("plugins/ezagent-spec/.codex-plugin/plugin.json");

    expect(manifest).toMatchObject({
      name: "ezagent-spec",
      version: "0.7.0",
      author: { name: "zhujufeng" },
      license: "MIT",
      skills: "./skills/",
      hooks: "./hooks/ezagent-hooks.json",
      interface: {
        displayName: "EZagent Work Harness",
        developerName: "zhujufeng",
        category: "Developer Tools",
        websiteURL: "https://github.com/zhujufeng/EZagent-Spec",
      },
    });
    expect((manifest.interface as { capabilities?: unknown }).capabilities)
      .toContain("Lifecycle Hooks");
    expect(manifest).not.toHaveProperty("mcpServers");
    expect(manifest).not.toHaveProperty("apps");

    const hooks = await readJson("plugins/ezagent-spec/hooks/ezagent-hooks.json");
    expect(hooks).toEqual({
      description: "Re-establish EZagent Router ownership on every prompt in initialized projects.",
      hooks: {
        UserPromptSubmit: [{
          hooks: [{
            type: "command",
            command: 'node "${CLAUDE_PLUGIN_ROOT}/hooks/ezagent-router-prompt.mjs"',
            timeout: 5,
            statusMessage: "Loading EZagent Router...",
          }],
        }],
      },
    });
  });

  test("publishes the plugin through the public ezagent marketplace", async () => {
    const marketplace = await readJson(".agents/plugins/marketplace.json");

    expect(marketplace).toEqual({
      name: "ezagent",
      interface: {
        displayName: "EZagent",
      },
      plugins: [
        {
          name: "ezagent-spec",
          source: {
            source: "local",
            path: "./plugins/ezagent-spec",
          },
          policy: {
            installation: "AVAILABLE",
            authentication: "ON_INSTALL",
          },
          category: "Developer Tools",
        },
      ],
    });
  });
});
