import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { describe, expect, test } from "vitest";

import {
  CASE_FOLDING_SHA256,
  generateUnicodeCaseFoldSource,
} from "../../scripts/generate-unicode-case-fold.js";

const PROJECT_ROOT = resolve(import.meta.dirname, "../..");
const FIXTURE_PATH = resolve(
  PROJECT_ROOT,
  "test/fixtures/unicode/CaseFolding-17.0.0.txt",
);
const GENERATED_PATH = resolve(PROJECT_ROOT, "src/text/unicode-case-fold.ts");

describe("Unicode case-fold generator", () => {
  test("rejects local inputs that do not match the pinned Unicode 17 source", () => {
    expect(() => generateUnicodeCaseFoldSource(Buffer.from("not CaseFolding 17")))
      .toThrow(new RegExp(CASE_FOLDING_SHA256, "i"));
  });

  test("deterministically reproduces the committed runtime table", async () => {
    const source = await readFile(FIXTURE_PATH);
    const committed = await readFile(GENERATED_PATH, "utf8");
    const generated = generateUnicodeCaseFoldSource(source);

    expect(generateUnicodeCaseFoldSource(source)).toBe(generated);
    expect(generated).toBe(committed);
  });

  test("publishes a clearly named offline package script", async () => {
    const packageJson = JSON.parse(
      await readFile(resolve(PROJECT_ROOT, "package.json"), "utf8"),
    ) as { readonly scripts?: Readonly<Record<string, string>> };

    expect(packageJson.scripts?.["generate:unicode-case-fold"])
      .toBe("node --import tsx scripts/generate-unicode-case-fold.ts");
  });

  test("ships the complete Unicode License v3 notice beside the generated data", async () => {
    const license = await readFile(
      resolve(PROJECT_ROOT, "licenses/UNICODE-LICENSE.txt"),
      "utf8",
    );
    const generated = await readFile(GENERATED_PATH, "utf8");

    expect(license).toContain("UNICODE LICENSE V3");
    expect(license).toContain("COPYRIGHT AND PERMISSION NOTICE");
    expect(license).toContain("Permission is hereby granted, free of charge");
    expect(license).toContain("THE DATA FILES AND SOFTWARE ARE PROVIDED \"AS IS\"");
    expect(license).toMatch(/prior written authorization of the\s+copyright holder/u);
    expect(license).toContain("SPDX-License-Identifier: Unicode-3.0");
    expect(generated).toContain("licenses/UNICODE-LICENSE.txt");
  });
});
