import { describe, expect, test } from "vitest";

import { transitionWorkItem } from "../../src/domain/state-machine.js";
import type { WorkItemState } from "../../src/domain/work-item.js";

describe("work item state machine", () => {
  const statuses = [
    "captured",
    "clarifying",
    "specified",
    "approved",
    "planned",
    "implementing",
    "verifying",
    "completed",
    "cancelled",
  ] as const;
  const expectedEdges: Record<(typeof statuses)[number], readonly (typeof statuses)[number][]> = {
    captured: ["clarifying", "cancelled"],
    clarifying: ["captured", "specified", "cancelled"],
    specified: ["clarifying", "approved", "cancelled"],
    approved: ["planned", "cancelled"],
    planned: ["implementing", "cancelled"],
    implementing: ["verifying", "cancelled"],
    verifying: ["implementing", "completed", "cancelled"],
    completed: [],
    cancelled: [],
  };

  test("matches the independent legal transition table", () => {
    for (const from of statuses) {
      for (const to of statuses) {
        const current: WorkItemState = {
          id: "TASK-20260820-001",
          kind: "task",
          status: from,
          risk: "standard",
          revision: 1,
        };
        const shouldSucceed = expectedEdges[from].includes(to);
        if (shouldSucceed) {
          expect(transitionWorkItem(current, { to, expectedRevision: 1 })).toEqual({
            ...current,
            status: to,
            revision: 2,
          });
        } else {
          const expectedError =
            to === "implementing" &&
            from !== "approved" &&
            from !== "planned" &&
            from !== "verifying"
              ? "work item must be approved before implementing"
              : `illegal transition: ${from} -> ${to}`;
          expect(() => transitionWorkItem(current, { to, expectedRevision: 1 })).toThrow(
            expectedError,
          );
        }
      }
    }
  });

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

  test("blocks a high-risk Task's first implementation in this release", () => {
    const current: WorkItemState = {
      id: "TASK-20260820-002",
      kind: "task",
      status: "planned",
      risk: "high",
      revision: 1,
    };

    expect(() =>
      transitionWorkItem(current, { to: "implementing", expectedRevision: 1 }),
    ).toThrow("high-risk implementation is not supported in this release");
  });

  test("checks revision conflicts before other transition errors", () => {
    const current: WorkItemState = {
      id: "SPEC-20260820-001",
      kind: "spec",
      status: "specified",
      risk: "standard",
      revision: 2,
    };
    expect(() =>
      transitionWorkItem(current, { to: "implementing", expectedRevision: 1 }),
    ).toThrow("revision conflict: expected 1, actual 2");
  });

  test("keeps direct approved to implementing illegal", () => {
    const current: WorkItemState = {
      id: "TASK-20260820-001",
      kind: "task",
      status: "approved",
      risk: "standard",
      revision: 3,
    };
    expect(() =>
      transitionWorkItem(current, { to: "implementing", expectedRevision: 3 }),
    ).toThrow("illegal transition: approved -> implementing");
  });

  test("does not allow a caller-provided authorization to bypass the high-risk block", () => {
    const current: WorkItemState = {
      id: "TASK-20260820-001",
      kind: "task",
      status: "planned",
      risk: "high",
      revision: 1,
    };
    const legacyRequest = {
      to: "implementing",
      expectedRevision: 1,
      highRiskAuthorizationId: "AUTH-1",
    } as const;
    expect(() => transitionWorkItem(current, legacyRequest))
      .toThrow("high-risk implementation is not supported in this release");
    expect(current).toEqual({
      id: "TASK-20260820-001",
      kind: "task",
      status: "planned",
      risk: "high",
      revision: 1,
    });
  });

  test("also blocks a high-risk Task from returning to implementation", () => {
    const current: WorkItemState = {
      id: "TASK-20260820-001",
      kind: "task",
      status: "verifying",
      risk: "high",
      revision: 5,
    };
    expect(() => transitionWorkItem(current, {
      to: "implementing",
      expectedRevision: 5,
    })).toThrow("high-risk implementation is not supported in this release");
  });
});
