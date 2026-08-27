import { mkdtemp, rm, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, test } from "vitest";

import {
  CLI_SIDE_EFFECT_PAYLOAD_MAX_BYTES,
  readBoundedJsonArgument,
  readBoundedJsonFile,
  readBoundedJsonInput,
  readBoundedPayloadFile,
} from "../../src/cli/json-input.js";

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

  test("parses one bounded JSON argv document", () => {
    expect(readBoundedJsonArgument('{"schemaVersion":2,"title":"退款幂等"}')).toEqual({
      schemaVersion: 2,
      title: "退款幂等",
    });
    expect(() => readBoundedJsonArgument("{}{}"))
      .toThrow(/exactly one JSON document/iu);
    expect(() => readBoundedJsonArgument(`{"value":"${"x".repeat(24_577)}"}`))
      .toThrow(/24576/iu);
  });

  test("reads exact bounded Side Effect payload bytes from a regular file", async () => {
    const root = await mkdtemp(join(tmpdir(), "ezagent-payload-input-"));
    const path = join(root, "payload.bin");
    try {
      const payload = Buffer.from([0x00, 0xff, 0x61, 0x0a]);
      await writeFile(path, payload);
      await expect(readBoundedPayloadFile(path)).resolves.toEqual(payload);

      await truncate(path, CLI_SIDE_EFFECT_PAYLOAD_MAX_BYTES + 1);
      await expect(readBoundedPayloadFile(path)).rejects.toThrow(String(CLI_SIDE_EFFECT_PAYLOAD_MAX_BYTES));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
