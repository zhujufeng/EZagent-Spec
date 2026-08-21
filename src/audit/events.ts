import { constants } from "node:fs";
import { dirname } from "node:path";

import {
  boundedStatSize,
  exactInteger,
  lstatBigint,
  openBigint,
  stableFileIdentity,
  statMtimeNanoseconds,
  type PortableStats,
} from "../filesystem/stats.js";
import { isWellFormedUnicode } from "../text/unicode.js";
import { WorkspaceCorruptError } from "../workspace/errors.js";
import { parseWorkspaceState, type WorkspaceState } from "../workspace/schema.js";

const EVENT_KEYS = ["sequence", "at", "type", "state", "metadata"] as const;
const MAX_EVENT_TYPE_LENGTH = 128;
const MAX_METADATA_KEYS = 32;
const MAX_METADATA_KEY_LENGTH = 64;
const MAX_METADATA_STRING_LENGTH = 256;
const MAX_METADATA_ARRAY_LENGTH = 32;
const MAX_METADATA_ARRAY_ITEM_LENGTH = 160;
const MAX_AUDIT_BYTES = 16 * 1024 * 1024;
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
  readonly readFile: () => Promise<Buffer>;
  readonly writeFile: (contents: string, encoding: "utf8") => Promise<void>;
  readonly sync: () => Promise<void>;
  readonly close: () => Promise<void>;
  readonly stat: () => Promise<PortableStats>;
}

export interface AuditFileRuntime {
  readonly lstat: (path: string) => Promise<PortableStats>;
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
      if (item.length > MAX_METADATA_ARRAY_LENGTH) {
        throw new TypeError(`audit metadata string array must have at most ${MAX_METADATA_ARRAY_LENGTH} items: ${key}`);
      }
      for (let index = 0; index < item.length; index += 1) {
        const entry = item[index];
        if (!Object.hasOwn(item, index) || typeof entry !== "string" || entry.length > MAX_METADATA_ARRAY_ITEM_LENGTH) {
          throw new TypeError(`audit metadata string array is invalid: ${key}`);
        }
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
    || !isWellFormedUnicode(value.type)
    || !/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u.test(value.type)
  ) {
    throw new TypeError(`audit event type must be a lowercase hyphenated slug up to ${MAX_EVENT_TYPE_LENGTH} characters`);
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

async function observe(runtime: AuditFileRuntime, path: string): Promise<PortableStats | undefined> {
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
): Promise<PortableStats> {
  const parent = dirname(path);
  const parentStat = await observe(runtime, parent);
  if (parentStat === undefined || !parentStat.isDirectory()) {
    throw new WorkspaceCorruptError(`workspace audit parent must be a real directory: ${parent}`, {
      cause: new Error("expected real audit directory"),
    });
  }
  const fileStat = await observe(runtime, path);
  if (fileStat === undefined) {
    throw new WorkspaceCorruptError(`workspace audit is unreadable or corrupt: ${path}`, {
      cause: Object.assign(new Error("audit file is missing"), { code: "ENOENT" }),
    });
  }
  if (!fileStat.isFile()) {
    throw new WorkspaceCorruptError(`workspace audit must be a regular file: ${path}`, {
      cause: new Error("expected regular audit file"),
    });
  }
  if (
    exactInteger(fileStat.nlink) !== 1n
    || stableFileIdentity(fileStat) === undefined
  ) {
    throw new WorkspaceCorruptError(`workspace audit requires unique stable file identity: ${path}`, {
      cause: new Error("audit must have nlink=1 and stable dev/ino identity"),
    });
  }
  if (boundedStatSize(fileStat, MAX_AUDIT_BYTES) === undefined) {
    throw new WorkspaceCorruptError(`workspace audit exceeds size limit: ${path}`, {
      cause: new Error(`audit size limit is ${MAX_AUDIT_BYTES} bytes`),
    });
  }
  return fileStat;
}

function sameAuditIdentity(left: PortableStats, right: PortableStats): boolean {
  const leftIdentity = stableFileIdentity(left);
  const rightIdentity = stableFileIdentity(right);
  const leftSize = boundedStatSize(left, MAX_AUDIT_BYTES);
  const rightSize = boundedStatSize(right, MAX_AUDIT_BYTES);
  const leftMtimeNs = statMtimeNanoseconds(left);
  const rightMtimeNs = statMtimeNanoseconds(right);
  return leftIdentity !== undefined
    && rightIdentity !== undefined
    && leftIdentity.dev === rightIdentity.dev
    && leftIdentity.ino === rightIdentity.ino
    && exactInteger(left.nlink) === 1n
    && exactInteger(right.nlink) === 1n
    && leftSize !== undefined
    && leftSize === rightSize
    && leftMtimeNs !== undefined
    && leftMtimeNs === rightMtimeNs;
}

function auditIdentityError(path: string): WorkspaceCorruptError {
  return new WorkspaceCorruptError(`workspace audit identity changed while open: ${path}`, {
    cause: new Error("audit pre-open and opened handle identity differ"),
  });
}

function corruptAudit(path: string, line: number, cause: unknown): WorkspaceCorruptError {
  return new WorkspaceCorruptError(`workspace audit is corrupt: ${path}; line ${line}`, { cause });
}

function auditCapacityError(path: string): WorkspaceCorruptError {
  return new WorkspaceCorruptError(`workspace audit append exceeds size limit: ${path}`, {
    cause: new Error(`audit size limit is ${MAX_AUDIT_BYTES} bytes; archive or compact the audit before retrying`),
  });
}

function auditLine(rawEvent: AuditEvent): string {
  return `${JSON.stringify(parseAuditEvent(rawEvent))}\n`;
}

export function createAuditStore(runtime: AuditFileRuntime) {
  async function preflight(path: string, rawEvent: AuditEvent): Promise<void> {
    const lineBytes = Buffer.byteLength(auditLine(rawEvent), "utf8");
    const before = await assertAuditBoundary(runtime, path);
    if (boundedStatSize(before, MAX_AUDIT_BYTES)! + lineBytes > MAX_AUDIT_BYTES) {
      throw auditCapacityError(path);
    }
  }

  async function append(path: string, rawEvent: AuditEvent): Promise<void> {
    const line = auditLine(rawEvent);
    const lineBytes = Buffer.byteLength(line, "utf8");
    const before = await assertAuditBoundary(runtime, path);
    if (boundedStatSize(before, MAX_AUDIT_BYTES)! + lineBytes > MAX_AUDIT_BYTES) {
      throw auditCapacityError(path);
    }
    let handle: AuditFileHandle | undefined;
    let failure: unknown;
    try {
      handle = await runtime.open(
        path,
        // O_NOFOLLOW is defense-in-depth where supported; lstat/open-handle identity is the portable invariant.
        constants.O_WRONLY | constants.O_APPEND | constants.O_NOFOLLOW,
        0o600,
      );
      const opened = await handle.stat();
      if (!opened.isFile() || !sameAuditIdentity(before, opened)) {
        throw auditIdentityError(path);
      }
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
    const before = await assertAuditBoundary(runtime, path);
    let handle: AuditFileHandle | undefined;
    let bytes: Buffer | undefined;
    let failure: unknown;
    try {
      handle = await runtime.open(
        path,
        constants.O_RDONLY | constants.O_NOFOLLOW,
        0o600,
      );
      const opened = await handle.stat();
      if (!opened.isFile() || !sameAuditIdentity(before, opened)) {
        throw auditIdentityError(path);
      }
      bytes = await handle.readFile();
      const afterRead = await handle.stat();
      if (
        !afterRead.isFile()
        || !sameAuditIdentity(opened, afterRead)
        || bytes.byteLength !== boundedStatSize(afterRead, MAX_AUDIT_BYTES)
        || bytes.byteLength > MAX_AUDIT_BYTES
      ) {
        throw auditIdentityError(path);
      }
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
      if (failure instanceof WorkspaceCorruptError) throw failure;
      throw new WorkspaceCorruptError(`workspace audit is unreadable or corrupt: ${path}`, { cause: failure });
    }
    const after = await assertAuditBoundary(runtime, path);
    if (
      !sameAuditIdentity(before, after)
      || bytes === undefined
      || bytes.byteLength !== boundedStatSize(after, MAX_AUDIT_BYTES)
      || bytes.byteLength > MAX_AUDIT_BYTES
    ) {
      throw auditIdentityError(path);
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

  return { appendAuditEvent: append, preflightAuditAppend: preflight, readAuditEvents: read };
}

const nodeAuditStore = createAuditStore({
  lstat: lstatBigint,
  open: openBigint,
});

export const appendAuditEvent = nodeAuditStore.appendAuditEvent;
export const preflightAuditAppend = nodeAuditStore.preflightAuditAppend;
export const readAuditEvents = nodeAuditStore.readAuditEvents;
