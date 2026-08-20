import { constants, type Stats } from "node:fs";
import { lstat, open, readFile } from "node:fs/promises";
import { dirname } from "node:path";

import { WorkspaceCorruptError } from "../workspace/errors.js";
import { parseWorkspaceState, type WorkspaceState } from "../workspace/schema.js";

const EVENT_KEYS = ["sequence", "at", "type", "state", "metadata"] as const;
const MAX_EVENT_TYPE_LENGTH = 128;
const MAX_METADATA_KEYS = 32;
const MAX_METADATA_KEY_LENGTH = 64;
const MAX_METADATA_STRING_LENGTH = 256;
const MAX_METADATA_ARRAY_LENGTH = 32;
const MAX_METADATA_ARRAY_ITEM_LENGTH = 160;
const DANGEROUS_KEYS = new Set(["__proto__", "prototype", "constructor"]);

export type AuditMetadataValue = string | number | boolean | null | readonly string[];
export type AuditMetadata = Readonly<Record<string, AuditMetadataValue>>;

export interface AuditEvent {
  readonly sequence: number;
  readonly at: string;
  readonly type: string;
  readonly state: WorkspaceState;
  readonly metadata: AuditMetadata;
}

export interface AuditFileHandle {
  readonly writeFile: (contents: string, encoding: "utf8") => Promise<void>;
  readonly sync: () => Promise<void>;
  readonly close: () => Promise<void>;
}

export interface AuditFileRuntime {
  readonly lstat: (path: string) => Promise<Stats>;
  readonly readFile: (path: string) => Promise<Buffer>;
  readonly open: (path: string, flags: number, mode: number) => Promise<AuditFileHandle>;
}

function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === "ENOENT";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertExactKeys(value: Record<string, unknown>, expected: readonly string[], label: string): void {
  const allowed = new Set(expected);
  const actual = Object.keys(value);
  const unsupported = actual.find((key) => !allowed.has(key));
  if (unsupported !== undefined) {
    throw new TypeError(`${label} contains unsupported key: ${unsupported}`);
  }
  const missing = expected.find((key) => !Object.hasOwn(value, key));
  if (missing !== undefined) {
    throw new TypeError(`${label} is missing required key: ${missing}`);
  }
}

function parseMetadata(value: unknown): AuditMetadata {
  if (!isRecord(value)) {
    throw new TypeError("audit metadata must be an object");
  }
  const entries = Object.entries(value);
  if (entries.length > MAX_METADATA_KEYS) {
    throw new TypeError(`audit metadata must have at most ${MAX_METADATA_KEYS} keys`);
  }

  const parsed = Object.create(null) as Record<string, AuditMetadataValue>;
  for (const [key, item] of entries) {
    if (
      key.length === 0
      || key.length > MAX_METADATA_KEY_LENGTH
      || DANGEROUS_KEYS.has(key)
      || /[\u0000-\u001f\u007f]/u.test(key)
    ) {
      throw new TypeError(`audit metadata contains invalid key: ${key}`);
    }
    if (typeof item === "string") {
      if (item.length > MAX_METADATA_STRING_LENGTH) {
        throw new TypeError(`audit metadata string is too long: ${key}`);
      }
      parsed[key] = item;
      continue;
    }
    if (typeof item === "number") {
      if (!Number.isFinite(item)) {
        throw new TypeError(`audit metadata number must be finite: ${key}`);
      }
      parsed[key] = item;
      continue;
    }
    if (typeof item === "boolean" || item === null) {
      parsed[key] = item;
      continue;
    }
    if (Array.isArray(item)) {
      const entriesAreBoundedStrings = Array.from(
        { length: item.length },
        (_, index) => item[index],
      ).every((entry) => typeof entry === "string" && entry.length <= MAX_METADATA_ARRAY_ITEM_LENGTH);
      if (
        item.length > MAX_METADATA_ARRAY_LENGTH
        || !entriesAreBoundedStrings
      ) {
        throw new TypeError(`audit metadata string array is invalid: ${key}`);
      }
      parsed[key] = [...item] as string[];
      continue;
    }
    throw new TypeError(`audit metadata contains unsupported value: ${key}`);
  }
  return parsed;
}

function parseIsoTimestamp(value: unknown): string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value)) {
    throw new TypeError("audit event timestamp must be a canonical ISO timestamp");
  }
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== value) {
    throw new TypeError("audit event timestamp is invalid");
  }
  return value;
}

export function parseAuditEvent(value: unknown): AuditEvent {
  if (!isRecord(value)) {
    throw new TypeError("audit event must be an object");
  }
  assertExactKeys(value, EVENT_KEYS, "audit event");
  if (!Number.isSafeInteger(value.sequence) || (value.sequence as number) <= 0) {
    throw new TypeError("audit event sequence must be a positive safe integer");
  }
  if (
    typeof value.type !== "string"
    || value.type.length === 0
    || value.type.length > MAX_EVENT_TYPE_LENGTH
    || value.type !== value.type.trim()
  ) {
    throw new TypeError(`audit event type must be 1-${MAX_EVENT_TYPE_LENGTH} non-whitespace characters`);
  }
  const state = parseWorkspaceState(value.state);
  if (state.revision !== value.sequence) {
    throw new TypeError("audit event state revision must match sequence");
  }
  return {
    sequence: value.sequence as number,
    at: parseIsoTimestamp(value.at),
    type: value.type,
    state,
    metadata: parseMetadata(value.metadata),
  };
}

async function observe(runtime: AuditFileRuntime, path: string): Promise<Stats | undefined> {
  try {
    return await runtime.lstat(path);
  } catch (error: unknown) {
    if (isMissing(error)) {
      return undefined;
    }
    throw new WorkspaceCorruptError(`workspace audit boundary is unreadable: ${path}`, { cause: error });
  }
}

async function assertAuditBoundary(
  runtime: AuditFileRuntime,
  path: string,
  allowMissingFile: boolean,
): Promise<void> {
  const parent = dirname(path);
  const parentStat = await observe(runtime, parent);
  if (parentStat === undefined || !parentStat.isDirectory()) {
    throw new WorkspaceCorruptError(`workspace audit parent must be a real directory: ${parent}`, {
      cause: new Error("expected real audit directory"),
    });
  }
  const fileStat = await observe(runtime, path);
  if (fileStat === undefined) {
    if (allowMissingFile) return;
    throw new WorkspaceCorruptError(`workspace audit is unreadable or corrupt: ${path}`, {
      cause: Object.assign(new Error("audit file is missing"), { code: "ENOENT" }),
    });
  }
  if (!fileStat.isFile()) {
    throw new WorkspaceCorruptError(`workspace audit must be a regular file: ${path}`, {
      cause: new Error("expected regular audit file"),
    });
  }
}

function corruptAudit(path: string, line: number, cause: unknown): WorkspaceCorruptError {
  return new WorkspaceCorruptError(`workspace audit is corrupt: ${path}; line ${line}`, { cause });
}

export function createAuditStore(runtime: AuditFileRuntime) {
  async function append(path: string, rawEvent: AuditEvent): Promise<void> {
    const validated = parseAuditEvent(rawEvent);
    await assertAuditBoundary(runtime, path, true);
    const line = `${JSON.stringify(validated)}\n`;
    let handle: AuditFileHandle | undefined;
    let failure: unknown;
    try {
      handle = await runtime.open(
        path,
        constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | constants.O_NOFOLLOW,
        0o600,
      );
      await handle.writeFile(line, "utf8");
      await handle.sync();
    } catch (error: unknown) {
      failure = error;
    }

    if (handle !== undefined) {
      try {
        await handle.close();
      } catch (error: unknown) {
        failure ??= error;
      }
    }
    if (failure !== undefined) {
      throw failure;
    }
  }

  async function read(path: string): Promise<AuditEvent[]> {
    await assertAuditBoundary(runtime, path, false);
    let bytes: Buffer;
    try {
      bytes = await runtime.readFile(path);
    } catch (error: unknown) {
      throw new WorkspaceCorruptError(`workspace audit is unreadable or corrupt: ${path}`, { cause: error });
    }
    let text: string;
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch (error: unknown) {
      throw corruptAudit(path, 1, error);
    }
    if (text.length === 0) {
      return [];
    }
    if (!text.endsWith("\n")) {
      const line = text.split("\n").length;
      throw corruptAudit(path, line, new Error("audit has a torn unterminated tail"));
    }

    const lines = text.slice(0, -1).split("\n");
    const events: AuditEvent[] = [];
    for (let index = 0; index < lines.length; index += 1) {
      const lineNumber = index + 1;
      const line = lines[index]!;
      if (line.length === 0) {
        throw corruptAudit(path, lineNumber, new Error("audit contains an internal empty line"));
      }
      try {
        const parsed = parseAuditEvent(JSON.parse(line) as unknown);
        if (parsed.sequence !== lineNumber) {
          throw new Error(`audit sequence must be ${lineNumber}, received ${parsed.sequence}`);
        }
        events.push(parsed);
      } catch (error: unknown) {
        throw corruptAudit(path, lineNumber, error);
      }
    }
    return events;
  }

  return { appendAuditEvent: append, readAuditEvents: read };
}

const nodeAuditStore = createAuditStore({
  lstat,
  readFile,
  open,
});

export const appendAuditEvent = nodeAuditStore.appendAuditEvent;
export const readAuditEvents = nodeAuditStore.readAuditEvents;
