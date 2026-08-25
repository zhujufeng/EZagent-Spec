import { describe, expect, test } from "vitest";

import config, { testTimeoutForPlatform } from "../vitest.config.js";

describe("Vitest repository boundaries", () => {
  test("does not collect tests from local worktrees or tool caches", () => {
    const exclude = (config as { test?: { exclude?: readonly string[] } }).test?.exclude;

    expect(exclude).toEqual(expect.arrayContaining([
      ".worktrees/**",
      ".pnpm-store/**",
      ".codegraph/**",
      ".superpowers/**",
    ]));
  });

  test("allows slower Windows filesystem workflows without relaxing other platforms", () => {
    expect(testTimeoutForPlatform("win32")).toBe(30_000);
    expect(testTimeoutForPlatform("darwin")).toBe(5_000);
    expect(config.test?.testTimeout).toBe(testTimeoutForPlatform(process.platform));
  });
});
