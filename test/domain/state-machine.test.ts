import { describe, expect, test } from "vitest";

import { transitionWorkItem } from "../../src/domain/state-machine.js";
import type { WorkItemState } from "../../src/domain/work-item.js";

describe("work item state machine", () => {
  test("requires approval before implementing a specified Spec", () => {
    const current: WorkItemState = {
      id: "SPEC-20260820-001",
      kind: "spec",
      status: "specified",
      risk: "standard",
      revision: 2,
    };

    expect(() =>
      transitionWorkItem(current, { to: "implementing", expectedRevision: 2 }),
    ).toThrow(/approved/);
  });

  test("allows a verifying Task to return to implementing", () => {
    const current: WorkItemState = {
      id: "TASK-20260820-001",
      kind: "task",
      status: "verifying",
      risk: "standard",
      revision: 5,
    };

    expect(
      transitionWorkItem(current, { to: "implementing", expectedRevision: 5 }),
    ).toEqual({ ...current, status: "implementing", revision: 6 });
  });

  test("requires authorization for a high-risk Task's first implementation", () => {
    const current: WorkItemState = {
      id: "TASK-20260820-002",
      kind: "task",
      status: "planned",
      risk: "high",
      revision: 1,
    };

    expect(() =>
      transitionWorkItem(current, { to: "implementing", expectedRevision: 1 }),
    ).toThrow(/authorization/);
  });
});
