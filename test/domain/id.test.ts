import { describe, expect, test } from "vitest";

import { createWorkItemId, isWorkItemId } from "../../src/domain/id.js";

describe("work item IDs", () => {
  test("creates a UTC date ID with a padded sequence", () => {
    expect(createWorkItemId("spec", new Date("2026-08-20T01:00:00Z"), 7)).toBe(
      "SPEC-20260820-007",
    );
  });

  test("rejects IDs with an unsupported kind prefix", () => {
    expect(isWorkItemId("THING-20260820-001")).toBe(false);
  });
});
