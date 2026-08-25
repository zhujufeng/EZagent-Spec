import { defineConfig, configDefaults } from "vitest/config";

export function testTimeoutForPlatform(platform: NodeJS.Platform): number {
  return platform === "win32" ? 30_000 : 5_000;
}

export function slowTestTimeoutForPlatform(platform: NodeJS.Platform): number {
  return platform === "win32" ? 60_000 : 30_000;
}

export default defineConfig({
  test: {
    testTimeout: testTimeoutForPlatform(process.platform),
    exclude: [
      ...configDefaults.exclude,
      "dist/**",
      ".worktrees/**",
      ".pnpm-store/**",
      ".codegraph/**",
      ".superpowers/**",
    ],
  },
});
