import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

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
});
