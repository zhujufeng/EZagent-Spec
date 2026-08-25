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
    const workflowConfig = parse(workflow) as {
      readonly on: {
        readonly push: {
          readonly branches: readonly string[];
          readonly tags?: unknown;
          readonly "tags-ignore"?: unknown;
        };
      };
    };

    expect(dependabot.version).toBe(2);
    expect(dependabot.updates).toContainEqual(expect.objectContaining({
      "package-ecosystem": "npm",
      directory: "/",
      schedule: { interval: "weekly" },
      "open-pull-requests-limit": 5,
    }));
    expect(workflow).toContain("npm audit --audit-level=high");
    expect(workflowConfig.on.push.branches).toEqual(["**"]);
    expect(workflowConfig.on.push).not.toHaveProperty("tags");
    expect(workflowConfig.on.push).not.toHaveProperty("tags-ignore");
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

  test("documents an explicit real-Codex release gate without adding it to PR CI", async () => {
    const packageJson = JSON.parse(await text("package.json")) as {
      readonly scripts: Record<string, string>;
    };
    const workflow = await text(".github/workflows/ci.yml");
    const guide = await text("docs/release/codex-host-acceptance.md");
    const ignore = await text(".gitignore");

    expect(packageJson.scripts["plugin:host-eval"]).toBe(
      "node --import tsx scripts/codex-host-eval.ts run",
    );
    expect(packageJson.scripts["plugin:host-eval:verify"]).toBe(
      "node --import tsx scripts/codex-host-eval.ts verify",
    );
    expect(packageJson.scripts["plugin:post-init-eval"]).toBe(
      "node --import tsx scripts/codex-post-init-eval.ts run",
    );
    expect(packageJson.scripts["plugin:post-init-eval:verify"]).toBe(
      "node --import tsx scripts/codex-post-init-eval.ts verify",
    );
    expect(workflow).not.toContain("plugin:host-eval");
    expect(workflow).not.toContain("plugin:post-init-eval");
    expect(guide).toContain("codex plugin add ezagent-spec@ezagent");
    expect(guide).toContain("npm run plugin:post-init-eval");
    expect(guide).toContain("npm run plugin:post-init-eval:verify");
    expect(guide).toContain("git tag -s");
    expect(guide).toContain("git verify-tag");
    expect(ignore).toContain(".artifacts/codex-host-eval/");
    expect(ignore).toContain(".artifacts/codex-post-init-eval/");
  });
});
