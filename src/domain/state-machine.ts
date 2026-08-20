import type { TransitionRequest, WorkItemState, WorkItemStatus } from "./work-item.js";

const ALLOWED_TRANSITIONS: Record<WorkItemStatus, readonly WorkItemStatus[]> = {
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

export function transitionWorkItem(
  current: WorkItemState,
  request: TransitionRequest,
): WorkItemState {
  if (request.expectedRevision !== current.revision) {
    throw new Error(
      `revision conflict: expected ${request.expectedRevision}, actual ${current.revision}`,
    );
  }

  if (
    request.to === "implementing" &&
    current.status !== "approved" &&
    current.status !== "planned" &&
    current.status !== "verifying"
  ) {
    throw new Error("work item must be approved before implementing");
  }

  if (!ALLOWED_TRANSITIONS[current.status].includes(request.to)) {
    throw new Error(`illegal transition: ${current.status} -> ${request.to}`);
  }

  if (
    request.to === "implementing" &&
    current.risk === "high" &&
    current.status !== "verifying" &&
    !request.highRiskAuthorizationId
  ) {
    throw new Error("high-risk implementation requires authorization");
  }

  return { ...current, status: request.to, revision: current.revision + 1 };
}
