import { describe, expect, test } from "vitest";

import config, {
  slowTestTimeoutForPlatform,
  testTimeoutForPlatform,
} from "../vitest.config.js";

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

  test("gives heavyweight filesystem workflows a targeted Windows timeout budget", () => {
    expect(slowTestTimeoutForPlatform("win32")).toBe(60_000);
    expect(slowTestTimeoutForPlatform("darwin")).toBe(30_000);
  });
});
