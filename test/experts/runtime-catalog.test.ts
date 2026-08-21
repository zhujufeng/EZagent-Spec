import { readFile } from "node:fs/promises";
import { describe, expect, test } from "vitest";

import {
  loadRuntimeCatalogBytes,
  parseRuntimeCatalog,
} from "../../src/experts/runtime-catalog.js";

describe("runtime expert catalog", () => {
  test("loads all locked experts and derives stable controlled vocabularies", async () => {
    const bytes = await readFile("catalog/normalized/experts.json");
    const catalog = parseRuntimeCatalog(bytes);
    expect(catalog.experts).toHaveLength(265);
    expect(catalog.fingerprint).toMatch(/^sha256:[0-9a-f]{64}$/u);
    expect([...catalog.capabilities]).toEqual([...catalog.capabilities].sort());
    expect(catalog.capabilities.size).toBeGreaterThan(0);
  });

  test("uses only an explicit local file and rejects malformed or oversized input", async () => {
    await expect(loadRuntimeCatalogBytes("/definitely/missing/experts.json")).rejects.toThrow();
    expect(() => parseRuntimeCatalog(Buffer.from('{"schemaVersion":1,"experts":[]}'))).toThrow();
    expect(() => parseRuntimeCatalog(Buffer.alloc(16 * 1024 * 1024 + 1))).toThrow();
  });
});
