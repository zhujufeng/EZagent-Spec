import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, test } from "vitest";

import { readBoundedJsonFile, readBoundedJsonInput } from "../../src/cli/json-input.js";

function source(text: string) {
  return {
    chunks: (async function* () {
      yield Buffer.from(text, "utf8");
    })(),
  };
}

describe("bounded JSON stdin", () => {
  test("accepts one UTF-8 JSON document and rejects trailing or oversized data", async () => {
    await expect(readBoundedJsonInput(source('{"schemaVersion":1}')))
      .resolves.toEqual({ schemaVersion: 1 });
    await expect(readBoundedJsonInput(source("{}{}"))).rejects.toThrow("JSON");
    await expect(readBoundedJsonInput(source("x".repeat(65_537)))).rejects.toThrow("65536");
  });

  test("reads one bounded JSON document from a regular file without consuming stdin", async () => {
    const root = await mkdtemp(join(tmpdir(), "ezagent-json-input-"));
    const path = join(root, "work contract.json");
    try {
      await writeFile(path, '{"schemaVersion":2,"brief":{"title":"demo"}}\n', "utf8");
      await expect(readBoundedJsonFile(path)).resolves.toEqual({
        schemaVersion: 2,
        brief: { title: "demo" },
      });

      await writeFile(path, "x".repeat(65_537), "utf8");
      await expect(readBoundedJsonFile(path)).rejects.toThrow("65536");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
