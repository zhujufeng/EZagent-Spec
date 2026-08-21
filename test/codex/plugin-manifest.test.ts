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

describe("EZagent Spec Codex plugin metadata", () => {
  test("declares the plugin manifest without inactive integrations", async () => {
    const manifest = await readJson("plugins/ezagent-spec/.codex-plugin/plugin.json");

    expect(manifest).toMatchObject({
      name: "ezagent-spec",
      version: "0.1.0",
      skills: "./skills/",
      interface: {
        displayName: "EZagent Spec",
        category: "Developer Tools",
      },
    });
    expect(manifest).not.toHaveProperty("hooks");
    expect(manifest).not.toHaveProperty("mcpServers");
    expect(manifest).not.toHaveProperty("apps");
  });

  test("publishes the plugin through the internal marketplace", async () => {
    const marketplace = await readJson(".agents/plugins/marketplace.json");

    expect(marketplace).toEqual({
      name: "ezagent-spec-internal",
      interface: {
        displayName: "EZagent Internal",
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
