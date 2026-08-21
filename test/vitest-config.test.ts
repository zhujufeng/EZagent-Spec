import { describe, expect, test } from "vitest";

import config from "../vitest.config.js";

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
});
