import type { WorkItemKind } from "./work-item.js";

const PREFIXES: Record<WorkItemKind, string> = {
  requirement: "REQ",
  spec: "SPEC",
  task: "TASK",
};

const WORK_ITEM_ID = /^(REQ|SPEC|TASK)-\d{8}-\d{3,}$/;

export function createWorkItemId(
  kind: WorkItemKind,
  date: Date,
  sequence: number,
): string {
  if (!Number.isInteger(sequence) || sequence < 1) {
    throw new Error("sequence must be a positive integer");
  }

  const year = date.getUTCFullYear().toString().padStart(4, "0");
  const month = (date.getUTCMonth() + 1).toString().padStart(2, "0");
  const day = date.getUTCDate().toString().padStart(2, "0");
  return `${PREFIXES[kind]}-${year}${month}${day}-${sequence.toString().padStart(3, "0")}`;
}

export function isWorkItemId(value: string): boolean {
  return WORK_ITEM_ID.test(value);
}
