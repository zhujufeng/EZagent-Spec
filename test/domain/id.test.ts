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

  test("accepts generated IDs for every kind and large canonical sequences", () => {
    const date = new Date("2026-08-20T01:00:00Z");
    expect(isWorkItemId(createWorkItemId("requirement", date, 1))).toBe(true);
    expect(isWorkItemId(createWorkItemId("spec", date, 999))).toBe(true);
    expect(isWorkItemId(createWorkItemId("task", date, 1000))).toBe(true);
  });

  test.each([
    "THING-20260820-001",
    "SPEC-20261399-001",
    "SPEC-20260230-001",
    "SPEC-20260820-000",
    "SPEC-20260820-0001",
    "SPEC-20260820-9007199254740992",
  ])("rejects noncanonical or impossible ID %s", (value) => {
    expect(isWorkItemId(value)).toBe(false);
  });

  test.each([
    0,
    1.5,
    Number.MAX_SAFE_INTEGER + 1,
  ])("rejects invalid sequence %s", (sequence) => {
    expect(() =>
      createWorkItemId("task", new Date("2026-08-20T01:00:00Z"), sequence),
    ).toThrow("sequence must be a positive integer");
  });

  test("rejects invalid dates and noncanonical UTC years", () => {
    expect(() => createWorkItemId("task", new Date("invalid"), 1)).toThrow(
      "invalid date",
    );
    const tooEarly = new Date("2026-08-20T01:00:00Z");
    tooEarly.setUTCFullYear(999);
    const tooLate = new Date("2026-08-20T01:00:00Z");
    tooLate.setUTCFullYear(10000);
    expect(() => createWorkItemId("task", tooEarly, 1)).toThrow(
      "date year must be between 1000 and 9999",
    );
    expect(() => createWorkItemId("task", tooLate, 1)).toThrow(
      "date year must be between 1000 and 9999",
    );
  });

  test("generated IDs are accepted by the canonical validator", () => {
    expect(
      isWorkItemId(createWorkItemId("spec", new Date("2026-08-20T01:00:00Z"), 1000)),
    ).toBe(true);
  });
});
