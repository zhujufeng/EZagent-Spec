import { appendAuditEvent, preflightAuditAppend } from "../audit/events.js";

import { atomicWriteText } from "./atomic-write.js";
import { nodePendingMarkerStore } from "./pending-marker.js";

/** Narrow, internal fault-injection seam for the durable mutation pipeline. */
export const workspaceCommitRuntime = {
  atomicWriteText,
  appendAuditEvent,
  preflightAuditAppend,
  publishPendingMarker: nodePendingMarkerStore.publishPendingMarker,
  removePendingMarker: nodePendingMarkerStore.removePendingMarker,
};
