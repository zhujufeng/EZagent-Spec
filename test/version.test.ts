import { EZAGENT_VERSION } from "../src/version.js";

import { expect, test } from "vitest";

test("exports the package version", () => {
  expect(EZAGENT_VERSION).toBe("0.5.1");
});
