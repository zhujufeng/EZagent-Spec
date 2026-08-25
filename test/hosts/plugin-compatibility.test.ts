import { readdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { parse } from "yaml";
import { describe, expect, test } from "vitest";

const ROOT = resolve(import.meta.dirname, "../..");
const PLUGIN_ROOT = resolve(ROOT, "plugins/ezagent-spec");

async function json(path: string): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(resolve(ROOT, path), "utf8")) as Record<string, unknown>;
}

describe("Claude Code and OpenCode compatibility", () => {
  test("publishes a Claude Code plugin and repository marketplace", async () => {
    const manifest = await json("plugins/ezagent-spec/.claude-plugin/plugin.json");
    expect(manifest).toMatchObject({
      name: "ezagent-spec",
      displayName: "EZagent Work Harness",
      version: "0.4.1",
      author: { name: "zhujufeng" },
      repository: "https://github.com/zhujufeng/EZagent-Spec",
      license: "MIT",
      skills: "./skills/",
    });
    expect(manifest).not.toHaveProperty("hooks");
    expect(manifest).not.toHaveProperty("mcpServers");

    expect(await json(".claude-plugin/marketplace.json")).toEqual({
      name: "ezagent",
      owner: { name: "zhujufeng" },
      plugins: [{
        name: "ezagent-spec",
        source: "./plugins/ezagent-spec",
        description: "中文、本地优先的通用 Agent Work Harness。",
        version: "0.4.1",
        category: "Developer Tools",
      }],
    });
  });

  test("uses a package root that can be installed directly as .opencode", async () => {
    expect(await readdir(PLUGIN_ROOT)).toEqual(expect.arrayContaining(["skills", "dist", "catalog"]));
    expect((await readFile(resolve(PLUGIN_ROOT, "dist/ezagent-cli.mjs"))).byteLength).toBeGreaterThan(0);
    expect((await readFile(resolve(PLUGIN_ROOT, "catalog/experts.json"))).byteLength).toBeGreaterThan(0);
  });

  test("publishes thin OpenCode entrypoints for default project discovery", async () => {
    const wrappersRoot = resolve(ROOT, ".opencode/skills");
    const wrappers = (await readdir(wrappersRoot, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
    const canonical = (await readdir(resolve(PLUGIN_ROOT, "skills"), { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
    expect(wrappers).toEqual(canonical);
    for (const name of wrappers) {
      const contents = await readFile(resolve(wrappersRoot, name, "SKILL.md"), "utf8");
      expect(contents).toContain(`../../../plugins/ezagent-spec/skills/${name}/SKILL.md`);
      expect(contents).toContain("canonical 文件");
    }
  });

  test("keeps every skill inside the portable Agent Skills subset", async () => {
    const skillDirectories = (await readdir(resolve(PLUGIN_ROOT, "skills"), { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);

    for (const directory of skillDirectories) {
      const contents = await readFile(resolve(PLUGIN_ROOT, "skills", directory, "SKILL.md"), "utf8");
      const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/u.exec(contents);
      expect(match, directory).not.toBeNull();
      const frontmatter = parse(match![1]!) as Record<string, unknown>;
      expect(frontmatter.name).toBe(directory);
      expect(directory).toMatch(/^[a-z0-9]+(?:-[a-z0-9]+)*$/u);
      expect(directory.length).toBeLessThanOrEqual(64);
      expect(frontmatter.description).toEqual(expect.any(String));
      expect(Buffer.byteLength(frontmatter.description as string, "utf8")).toBeLessThanOrEqual(4_096);
      expect((frontmatter.description as string).length).toBeLessThanOrEqual(1_024);
      expect(Object.keys(frontmatter).sort()).toEqual(["description", "name"]);
    }
  });

  test("defines native isolated-subagent execution for non-Codex hosts", async () => {
    for (const skill of ["ezagent-execute", "ezagent-review"]) {
      const contents = await readFile(resolve(PLUGIN_ROOT, "skills", skill, "SKILL.md"), "utf8");
      expect(contents).toContain("Claude Code");
      expect(contents).toContain("OpenCode");
      expect(contents).toContain("<plugin-root>/catalog/experts.json");
      expect(contents).toMatch(/宿主原生 subagent/u);
      expect(contents).toMatch(/没有可用 subagent 能力.*blocked/su);
      expect(contents).toMatch(/协调器.*不得模拟|不得由协调器模拟/u);
    }
  });
});
