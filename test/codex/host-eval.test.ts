import { fileURLToPath } from "node:url";

import { describe, expect, test } from "vitest";

import { loadHostEvalSuite } from "../../scripts/codex-host-eval.js";

const SUITE_PATH = fileURLToPath(
  new URL("../fixtures/codex-host-eval.json", import.meta.url),
);

describe("Codex host evaluation corpus", () => {
  test("covers every activation policy and behavioral category", async () => {
    const suite = await loadHostEvalSuite(SUITE_PATH);

    expect(suite.schemaVersion).toBe(1);
    expect(suite.pluginId).toBe("ezagent-spec@ezagent");
    expect(new Set(suite.cases.map(({ id }) => id)).size).toBe(suite.cases.length);
    expect(new Set(suite.cases.map(({ expectedPolicy }) => expectedPolicy))).toEqual(new Set([
      "consult-no-work",
      "no-workflow",
      "initialize",
      "router-light",
      "router-standard",
      "router-high",
    ]));
    expect(new Set(suite.cases.flatMap(({ categories }) => categories))).toEqual(new Set([
      "explicit",
      "implicit",
      "negative",
      "boundary",
      "follow-up",
    ]));
    expect(suite.cases.filter(({ followUpPrompt }) => followUpPrompt !== undefined)).toHaveLength(1);
    for (const fixture of suite.cases) {
      expect(fixture.prompt.trim(), fixture.id).not.toBe("");
      expect(fixture.reviewCriteria.length, fixture.id).toBeGreaterThan(0);
    }
  });
});
