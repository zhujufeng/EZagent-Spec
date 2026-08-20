import { parseWorkspaceState, type WorkspaceState } from "../workspace/schema.js";
import { parseAuditEvent, type AuditEvent } from "./events.js";

export const CANONICAL_INITIAL_STATE: WorkspaceState = {
  schemaVersion: 1,
  revision: 0,
  activeWorkItem: null,
  safeMode: false,
};

export function recoverState(events: readonly AuditEvent[]): WorkspaceState {
  if (events.length === 0) {
    return { ...CANONICAL_INITIAL_STATE };
  }
  let recovered: WorkspaceState = CANONICAL_INITIAL_STATE;
  for (let index = 0; index < events.length; index += 1) {
    const validated = parseAuditEvent(events[index]);
    const expected = index + 1;
    if (validated.sequence !== expected) {
      throw new Error(`audit sequence must be contiguous: expected ${expected}, received ${validated.sequence}`);
    }
    recovered = parseWorkspaceState(validated.state);
  }
  return recovered;
}
