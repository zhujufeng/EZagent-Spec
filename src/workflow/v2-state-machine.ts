import type { SliceArtifactV2, WorkItemArtifactV2 } from "./work-artifacts.js";

function freezeWorkItem(
  workItem: WorkItemArtifactV2,
  slices: readonly SliceArtifactV2[],
  status: WorkItemArtifactV2["status"],
): WorkItemArtifactV2 {
  return Object.freeze({
    ...workItem,
    status,
    revision: workItem.revision + 1,
    slices: Object.freeze(slices.map((slice) => Object.freeze({ ...slice }))),
  });
}

function sliceIndex(workItem: WorkItemArtifactV2, sliceId: string): number {
  const index = workItem.slices.findIndex(({ id }) => id === sliceId);
  if (index === -1) throw new Error("Work Item references an unknown Slice");
  return index;
}

function assertDependenciesAccepted(workItem: WorkItemArtifactV2, slice: SliceArtifactV2): void {
  if (slice.blockedBy.some((dependencyId) => (
    workItem.slices.find(({ id }) => id === dependencyId)?.status !== "accepted"
  ))) {
    throw new Error("Slice dependencies must be accepted before this transition");
  }
}

export function startV2Slice(
  workItem: WorkItemArtifactV2,
  sliceId: string,
): WorkItemArtifactV2 {
  if (!["planned", "implementing"].includes(workItem.status)) {
    throw new Error("Work Item is not ready to start a Slice");
  }
  const index = sliceIndex(workItem, sliceId);
  const current = workItem.slices[index]!;
  if (!["pending", "revise"].includes(current.status)) {
    throw new Error("Slice is not ready to start");
  }
  if (workItem.slices.some(({ id, status }) => id !== sliceId && status === "executing")) {
    throw new Error("another Slice is executing; finish its review before starting a new Slice");
  }
  assertDependenciesAccepted(workItem, current);
  const slices = workItem.slices.map((slice, sliceIndexValue) => (
    sliceIndexValue === index ? { ...slice, status: "executing" as const } : slice
  ));
  return freezeWorkItem(workItem, slices, "implementing");
}

export function reviewV2Slice(
  workItem: WorkItemArtifactV2,
  sliceId: string,
  accepted: boolean,
): WorkItemArtifactV2 {
  const index = sliceIndex(workItem, sliceId);
  const current = workItem.slices[index]!;
  if (!["executing", "accepted"].includes(current.status)) {
    throw new Error("Evidence review requires an executing Slice or an accepted Slice re-review");
  }
  if (!["implementing", "verifying"].includes(workItem.status)) {
    throw new Error("Work Item is not ready for Evidence review");
  }
  assertDependenciesAccepted(workItem, current);
  const slices = workItem.slices.map((slice, sliceIndexValue) => (
    sliceIndexValue === index
      ? { ...slice, status: accepted ? "accepted" as const : "revise" as const }
      : slice
  ));
  return freezeWorkItem(
    workItem,
    slices,
    slices.every(({ status }) => status === "accepted") ? "verifying" : "implementing",
  );
}

export function completeV2WorkItem(workItem: WorkItemArtifactV2): WorkItemArtifactV2 {
  if (workItem.status !== "verifying"
    || workItem.slices.some(({ status }) => status !== "accepted")) {
    throw new Error("every Slice must be accepted before Work Item completion");
  }
  return freezeWorkItem(workItem, workItem.slices, "completed");
}

export function cancelV2WorkItem(workItem: WorkItemArtifactV2): WorkItemArtifactV2 {
  if (workItem.status === "completed" || workItem.status === "cancelled") {
    throw new Error("terminal Work Item cannot be cancelled");
  }
  const slices = workItem.slices.map((slice) => (
    slice.status === "accepted" ? slice : { ...slice, status: "cancelled" as const }
  ));
  return freezeWorkItem(workItem, slices, "cancelled");
}
