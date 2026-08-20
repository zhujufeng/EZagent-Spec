import type { WorkItemKind } from "./work-item.js";

const PREFIXES: Record<WorkItemKind, string> = {
  requirement: "REQ",
  spec: "SPEC",
  task: "TASK",
};

const WORK_ITEM_ID = /^(REQ|SPEC|TASK)-(\d{4})(\d{2})(\d{2})-(\d{3}|[1-9]\d{3,})$/;

function parseWorkItemId(value: string): { sequence: number } | undefined {
  const match = WORK_ITEM_ID.exec(value);
  if (match === null) {
    return undefined;
  }

  const [, , yearText, monthText, dayText, sequenceText] = match;
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const sequence = Number(sequenceText);
  if (year < 1000 || year > 9999) {
    return undefined;
  }
  if (!Number.isSafeInteger(sequence) || sequence < 1) {
    return undefined;
  }

  const date = new Date(0);
  date.setUTCFullYear(year, month - 1, day);
  date.setUTCHours(0, 0, 0, 0);
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    return undefined;
  }

  return { sequence };
}

export function createWorkItemId(
  kind: WorkItemKind,
  date: Date,
  sequence: number,
): string {
  if (!Number.isSafeInteger(sequence) || sequence < 1) {
    throw new Error("sequence must be a positive integer");
  }
  if (!Number.isFinite(date.getTime())) {
    throw new Error("invalid date");
  }

  const yearNumber = date.getUTCFullYear();
  if (yearNumber < 1000 || yearNumber > 9999) {
    throw new Error("date year must be between 1000 and 9999");
  }
  const year = yearNumber.toString();
  const month = (date.getUTCMonth() + 1).toString().padStart(2, "0");
  const day = date.getUTCDate().toString().padStart(2, "0");
  const value = `${PREFIXES[kind]}-${year}${month}${day}-${sequence.toString().padStart(3, "0")}`;
  if (parseWorkItemId(value) === undefined) {
    throw new Error("invalid work item ID");
  }
  return value;
}

export function isWorkItemId(value: string): boolean {
  return parseWorkItemId(value) !== undefined;
}
