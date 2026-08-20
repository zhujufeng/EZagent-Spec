import { createHash } from "node:crypto";
import { lstat, readFile } from "node:fs/promises";
import { join } from "node:path";
import { posix } from "node:path";

import {
  parseAuditEvent,
  type AuditEvent,
  type AuditMetadata,
} from "../audit/events.js";
import {
  ensureWorkspaceDirectoryChains,
  nodeWorkspaceDirectoryRuntime,
  validateExistingWorkspaceDirectoryChains,
} from "./directory-boundary.js";
import { WorkspaceCorruptError } from "./errors.js";
import { parseWorkspaceState, type WorkspaceState } from "./schema.js";

const ARTIFACT_ROOTS = new Set([
  "requirements", "specs", "tasks", "knowledge", "experts", "quality", "backups",
]);
const WINDOWS_DEVICE_NAME = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/iu;
const SHA256 = /^[0-9a-f]{64}$/u;
const PENDING_KEYS = [
  "schemaVersion", "token", "createdAt", "fromRevision", "toRevision", "stateHash", "eventHash", "writes",
] as const;
const PENDING_WRITE_KEYS = ["relativePath", "contentHash"] as const;
const MAX_MUTATION_WRITES = 256;

export interface WorkspaceMutationWrite {
  readonly relativePath: string;
  readonly content: string;
}

export interface NormalizedWorkspaceMutation {
  readonly next: WorkspaceState;
  readonly expectedRevision: number;
  readonly eventType: string;
  readonly writes: readonly WorkspaceMutationWrite[];
  readonly metadata: AuditMetadata;
}

export interface PendingMutationWrite {
  readonly relativePath: string;
  readonly contentHash: string;
}

export interface PendingMutation {
  readonly schemaVersion: 1;
  readonly token: string;
  readonly createdAt: string;
  readonly fromRevision: number;
  readonly toRevision: number;
  readonly stateHash: string;
  readonly eventHash: string;
  readonly writes: readonly PendingMutationWrite[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertExactKeys(value: Record<string, unknown>, keys: readonly string[], label: string): void {
  const allowed = new Set(keys);
  const unsupported = Object.keys(value).find((key) => !allowed.has(key));
  if (unsupported !== undefined) throw new TypeError(`${label} contains unsupported key: ${unsupported}`);
  const missing = keys.find((key) => !Object.hasOwn(value, key));
  if (missing !== undefined) throw new TypeError(`${label} is missing required key: ${missing}`);
}

function assertCanonicalTimestamp(value: unknown, label: string): asserts value is string {
  if (
    typeof value !== "string"
    || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value)
    || !Number.isFinite(Date.parse(value))
    || new Date(Date.parse(value)).toISOString() !== value
  ) {
    throw new TypeError(`${label} must be a canonical ISO timestamp`);
  }
}

export function validateArtifactRelativePath(value: unknown): string {
  if (
    typeof value !== "string"
    || value.length === 0
    || value.length > 1_024
    || value === "."
    || value.includes("\0")
    || value.includes("\\")
    || value.startsWith("/")
    || /^[A-Za-z]:/u.test(value)
    || /^[/\\]{2}/u.test(value)
  ) {
    throw new TypeError(`workspace write escapes .ezagent or is not portable: ${String(value)}`);
  }
  const components = value.split("/");
  if (components.length < 2 || !ARTIFACT_ROOTS.has(components[0]!)) {
    throw new TypeError(`workspace write is outside allowed artifact roots: ${value}`);
  }
  for (const component of components) {
    if (
      component.length === 0
      || component.length > 255
      || component === "."
      || component === ".."
      || component.endsWith(".")
      || component.endsWith(" ")
      || /[<>:"|?*\u0000-\u001f\u007f]/u.test(component)
      || WINDOWS_DEVICE_NAME.test(component)
    ) {
      throw new TypeError(`workspace write path is unsafe or not portable: ${value}`);
    }
  }
  return value.normalize("NFC");
}

function normalizeWrites(writes: readonly WorkspaceMutationWrite[]): readonly WorkspaceMutationWrite[] {
  if (!Array.isArray(writes) || writes.length > MAX_MUTATION_WRITES) {
    throw new TypeError(`workspace mutation must contain at most ${MAX_MUTATION_WRITES} writes`);
  }
  const seen = new Set<string>();
  return writes.map((write) => {
    if (!isRecord(write)) throw new TypeError("workspace mutation write must be an object");
    assertExactKeys(write, ["relativePath", "content"], "workspace mutation write");
    const relativePath = validateArtifactRelativePath(write.relativePath);
    if (typeof write.content !== "string") throw new TypeError("workspace mutation content must be text");
    const duplicateKey = relativePath.toLocaleLowerCase("en-US");
    if (seen.has(duplicateKey)) throw new TypeError(`duplicate workspace mutation target: ${relativePath}`);
    seen.add(duplicateKey);
    return { relativePath, content: write.content };
  });
}

export function normalizeWorkspaceMutation(
  next: WorkspaceState,
  expectedRevision: number,
  eventType: string,
  writes: readonly WorkspaceMutationWrite[],
  metadata: AuditMetadata,
): NormalizedWorkspaceMutation {
  const parsedNext = parseWorkspaceState(next);
  if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) {
    throw new TypeError("expectedRevision must be a non-negative safe integer");
  }
  const probe = parseAuditEvent({
    sequence: parsedNext.revision,
    at: "2000-01-01T00:00:00.000Z",
    type: eventType,
    state: parsedNext,
    metadata,
  });
  return {
    next: parsedNext,
    expectedRevision,
    eventType: probe.type,
    writes: normalizeWrites(writes),
    metadata: probe.metadata,
  };
}

export function hashText(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

export function targetPath(workspaceRoot: string, relativePath: string): string {
  return join(workspaceRoot, ...relativePath.split("/"));
}

function parentDirectories(writes: readonly { readonly relativePath: string }[]): readonly string[] {
  return [...new Set(writes.map(({ relativePath }) => posix.dirname(relativePath)))];
}

async function observeTarget(path: string): Promise<Awaited<ReturnType<typeof lstat>> | undefined> {
  try {
    return await lstat(path);
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw new WorkspaceCorruptError(`workspace artifact boundary is unreadable: ${path}`, { cause: error });
  }
}

async function assertRegularOrMissingTarget(path: string): Promise<void> {
  const observed = await observeTarget(path);
  if (observed !== undefined && !observed.isFile()) {
    throw new WorkspaceCorruptError(`workspace artifact target must be a regular file: ${path}`, {
      cause: new Error("expected regular artifact file or missing target"),
    });
  }
}

export async function validateExistingArtifactBoundaries(
  workspaceRoot: string,
  writes: readonly { readonly relativePath: string }[],
): Promise<void> {
  await validateExistingWorkspaceDirectoryChains(
    nodeWorkspaceDirectoryRuntime,
    workspaceRoot,
    parentDirectories(writes),
  );
  await Promise.all(writes.map(({ relativePath }) => assertRegularOrMissingTarget(targetPath(workspaceRoot, relativePath))));
}

export async function ensureArtifactBoundaries(
  workspaceRoot: string,
  writes: readonly { readonly relativePath: string }[],
): Promise<void> {
  await ensureWorkspaceDirectoryChains(nodeWorkspaceDirectoryRuntime, workspaceRoot, parentDirectories(writes));
  await Promise.all(writes.map(({ relativePath }) => assertRegularOrMissingTarget(targetPath(workspaceRoot, relativePath))));
}

export function createPendingMutation(
  token: string,
  createdAt: string,
  fromRevision: number,
  event: AuditEvent,
  writes: readonly WorkspaceMutationWrite[],
): PendingMutation {
  return {
    schemaVersion: 1,
    token,
    createdAt,
    fromRevision,
    toRevision: event.sequence,
    stateHash: hashText(JSON.stringify(event.state)),
    eventHash: hashText(JSON.stringify(event)),
    writes: writes.map((write) => ({
      relativePath: write.relativePath,
      contentHash: hashText(write.content),
    })),
  };
}

export function parsePendingMutation(value: unknown): PendingMutation {
  if (!isRecord(value)) throw new TypeError("pending mutation must be an object");
  assertExactKeys(value, PENDING_KEYS, "pending mutation");
  if (value.schemaVersion !== 1) throw new TypeError("pending mutation schemaVersion must be 1");
  if (typeof value.token !== "string" || value.token.length === 0 || value.token.length > 128) {
    throw new TypeError("pending mutation token is invalid");
  }
  assertCanonicalTimestamp(value.createdAt, "pending mutation createdAt");
  if (!Number.isSafeInteger(value.fromRevision) || (value.fromRevision as number) < 0) {
    throw new TypeError("pending mutation fromRevision is invalid");
  }
  if (!Number.isSafeInteger(value.toRevision) || value.toRevision !== (value.fromRevision as number) + 1) {
    throw new TypeError("pending mutation revisions are not contiguous");
  }
  if (typeof value.stateHash !== "string" || !SHA256.test(value.stateHash)) {
    throw new TypeError("pending mutation stateHash is invalid");
  }
  if (typeof value.eventHash !== "string" || !SHA256.test(value.eventHash)) {
    throw new TypeError("pending mutation eventHash is invalid");
  }
  if (!Array.isArray(value.writes) || value.writes.length > MAX_MUTATION_WRITES) {
    throw new TypeError("pending mutation writes are invalid");
  }
  const seen = new Set<string>();
  const writes = value.writes.map((rawWrite) => {
    if (!isRecord(rawWrite)) throw new TypeError("pending mutation write must be an object");
    assertExactKeys(rawWrite, PENDING_WRITE_KEYS, "pending mutation write");
    const relativePath = validateArtifactRelativePath(rawWrite.relativePath);
    if (typeof rawWrite.contentHash !== "string" || !SHA256.test(rawWrite.contentHash)) {
      throw new TypeError("pending mutation contentHash is invalid");
    }
    const duplicateKey = relativePath.toLocaleLowerCase("en-US");
    if (seen.has(duplicateKey)) throw new TypeError(`duplicate pending mutation target: ${relativePath}`);
    seen.add(duplicateKey);
    return { relativePath, contentHash: rawWrite.contentHash };
  });
  return {
    schemaVersion: 1,
    token: value.token,
    createdAt: value.createdAt,
    fromRevision: value.fromRevision as number,
    toRevision: value.toRevision as number,
    stateHash: value.stateHash,
    eventHash: value.eventHash,
    writes,
  };
}

export async function artifactHashesMatch(workspaceRoot: string, marker: PendingMutation): Promise<boolean> {
  await validateExistingArtifactBoundaries(workspaceRoot, marker.writes);
  for (const write of marker.writes) {
    try {
      const contents = await readFile(targetPath(workspaceRoot, write.relativePath), "utf8");
      if (hashText(contents) !== write.contentHash) return false;
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw new WorkspaceCorruptError(`workspace artifact is unreadable: ${write.relativePath}`, { cause: error });
    }
  }
  return true;
}
