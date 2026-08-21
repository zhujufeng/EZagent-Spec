import { describe, expect, test } from "vitest";

import { readBoundedJsonInput } from "../../src/cli/json-input.js";

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
});
