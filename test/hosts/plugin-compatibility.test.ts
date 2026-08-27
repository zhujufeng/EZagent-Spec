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
      version: "0.7.1",
      author: { name: "zhujufeng" },
      repository: "https://github.com/zhujufeng/EZagent-Spec",
      license: "MIT",
      skills: "./skills/",
      hooks: "./hooks/ezagent-hooks.json",
    });
    expect(manifest).not.toHaveProperty("mcpServers");

    expect(await json(".claude-plugin/marketplace.json")).toEqual({
      name: "ezagent",
      owner: { name: "zhujufeng" },
      plugins: [{
        name: "ezagent-spec",
        source: "./plugins/ezagent-spec",
        description: "面向 Codex、Claude Code 和 OpenCode 的本地优先 Agent Work Harness：把自然语言需求转成可审批、可恢复、证据驱动的工作，并按需匹配 Specialist。",
        version: "0.7.1",
        category: "Developer Tools",
      }],
    });
  });

  test("documents Claude Desktop as an honest Cowork experiment instead of inheriting Claude Code support", async () => {
    const readme = await readFile(resolve(ROOT, "README.md"), "utf8");

    expect(readme).toContain("Claude Desktop Chat | 有限支持");
    expect(readme).toContain("Claude Desktop Cowork | 实验性支持，待同事实机验收");
    expect(readme).toContain("Hooks 与 sub-agent 只在 Cowork 运行");
    expect(readme).toContain("Customize → Plugins");
    expect(readme).toContain("https://github.com/zhujufeng/EZagent-Spec");
    expect(readme).toContain("第一次验收如果提示安装 Node，先不要批准");
    expect(readme).toContain("Specialist 真实 sub-agent：通过 / blocked / 失败");
    expect(readme).toContain("至少获得一台 macOS 和一台 Windows 的完整回报");
    expect(readme).toContain("不能继承 Cowork 或 Claude Code 的结论");
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
