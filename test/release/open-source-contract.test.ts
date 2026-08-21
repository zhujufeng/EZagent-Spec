import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { parse } from "yaml";
import { describe, expect, test } from "vitest";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));

async function text(path: string): Promise<string> {
  return readFile(join(ROOT, path), "utf8");
}

describe("open-source release contract", () => {
  test("publishes EZagent-owned code under MIT without enabling npm publication", async () => {
    const license = await text("LICENSE");
    const packageJson = JSON.parse(await text("package.json")) as {
      readonly private?: boolean;
      readonly license?: string;
    };

    expect(license).toContain("MIT License");
    expect(license).toContain("Copyright (c) 2026 EZagent Contributors");
    expect(packageJson).toMatchObject({ private: true, license: "MIT" });
  });

  test("ships public contribution and private vulnerability-reporting guidance", async () => {
    const contributing = await text("CONTRIBUTING.md");
    const security = await text("SECURITY.md");

    expect(contributing).toContain("npm run plugin:verify");
    expect(contributing).toContain("npm run verify");
    expect(contributing).toContain("MIT License");
    expect(security).toContain("security/advisories/new");
    expect(security).toContain("不要在公开 Issue");
  });

  test("keeps the private vulnerability channel actionable", async () => {
    const security = await text("SECURITY.md");

    expect(security).toContain("security/advisories/new");
    expect(security).toMatch(/2 个工作日/u);
    expect(security).toMatch(/7 个自然日/u);
    expect(security).toMatch(/通道不可用.*不要.*漏洞细节/su);
  });

  test("runs weekly npm dependency updates and audits high vulnerabilities in CI", async () => {
    const dependabot = parse(await text(".github/dependabot.yml")) as {
      readonly version: number;
      readonly updates: ReadonlyArray<Record<string, unknown>>;
    };
    const workflow = await text(".github/workflows/ci.yml");

    expect(dependabot.version).toBe(2);
    expect(dependabot.updates).toContainEqual(expect.objectContaining({
      "package-ecosystem": "npm",
      directory: "/",
      schedule: { interval: "weekly" },
      "open-pull-requests-limit": 5,
    }));
    expect(workflow).toContain("npm audit --audit-level=high");
  });

  test("versions single-maintainer branch and immutable release-tag rulesets", async () => {
    const main = JSON.parse(await text(".github/rulesets/main.json")) as Record<string, unknown>;
    const tags = JSON.parse(await text(".github/rulesets/release-tags.json")) as Record<string, unknown>;

    expect(main).toMatchObject({ name: "Protect main", target: "branch", enforcement: "active" });
    expect(main).toHaveProperty("conditions.ref_name.include", ["~DEFAULT_BRANCH"]);
    expect(main).toHaveProperty("bypass_actors.0", {
      actor_id: 5,
      actor_type: "RepositoryRole",
      bypass_mode: "always",
    });
    expect(main).toHaveProperty("rules", expect.arrayContaining([
      { type: "deletion" },
      { type: "non_fast_forward" },
      expect.objectContaining({ type: "pull_request" }),
      expect.objectContaining({ type: "required_status_checks" }),
    ]));
    expect(tags).toMatchObject({
      name: "Protect release tags",
      target: "tag",
      enforcement: "active",
    });
    expect(tags).toHaveProperty("conditions.ref_name.include", ["refs/tags/v*"]);
    expect(tags).toHaveProperty("rules", expect.arrayContaining([
      { type: "deletion" },
      { type: "update" },
    ]));
  });
});
