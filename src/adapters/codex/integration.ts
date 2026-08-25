import { createHash, randomUUID } from "node:crypto";
import { type Stats } from "node:fs";
import { lstat, mkdir, open } from "node:fs/promises";
import { join } from "node:path";

import { CANONICAL_INITIAL_STATE } from "../../audit/recovery.js";
import { WORKSPACE_DIRECTORIES } from "../../workspace/layout.js";
import { WorkspaceRepository } from "../../workspace/repository.js";
import { serializeProjectConfig } from "../../workspace/schema.js";
import { mergeEzagentAgentsBlock } from "./agents-md.js";
import {
  assertRealDirectory,
  assertRealDirectoryIdentity,
  identity,
  noFollowReadFlags,
  observedLstat as observed,
  readHandleBounded,
  readNoFollowPathBounded,
  sameFile,
  sameNode,
  syncDirectoryBestEffort as syncDirectory,
  type BoundedReadPolicy,
  type FileIdentity,
} from "./safe-fs.js";

const MAX_AGENTS_BYTES = 1_048_576;
const MANAGED_PATHS = [
  ".ezagent/**",
  "AGENTS.md#EZAGENT",
  ".codex/agents/ezagent-*.toml",
] as const;
const POST_INITIALIZATION_CONTINUATION = Object.freeze({
  agentsInstructions: "next-run",
  sameRun: "invoke-ezagent-router-if-request-remains",
  fallback: "start-new-run",
} as const);
const AGENTS_READ_POLICY: BoundedReadPolicy = Object.freeze({
  maximumBytes: MAX_AGENTS_BYTES,
  invalidMessage: "AGENTS.md must be a bounded regular file",
  changedMessage: "AGENTS.md changed during read",
  exceedsMessage: "AGENTS.md must be a bounded regular file",
  mapOpenError: (error: unknown) => (
    (error as NodeJS.ErrnoException).code === "ELOOP"
      ? new Error("AGENTS.md must be a bounded regular file", { cause: error })
      : error
  ),
});

interface IntegrationFileHandle {
  readonly stat: () => Promise<Stats>;
  readonly read: (
    buffer: Buffer,
    offset: number,
    length: number,
    position: number | null,
  ) => Promise<{ readonly bytesRead: number }>;
  readonly write: (
    buffer: Uint8Array,
    offset: number,
    length: number,
    position: number | null,
  ) => Promise<{ readonly bytesWritten: number }>;
  readonly truncate: (length: number) => Promise<void>;
  readonly sync: () => Promise<void>;
  readonly close: () => Promise<void>;
}

interface IntegrationContext {
  readonly project: {
    readonly schemaVersion: number;
    readonly name: string;
    readonly gitTracking: string;
  };
  readonly recovered: boolean;
}

interface IntegrationRepository {
  readonly readContext: () => Promise<IntegrationContext>;
}

export interface CodexIntegrationRuntime {
  readonly lstat: (path: string) => Promise<Stats>;
  readonly open: (path: string, flags: string | number, mode?: number) => Promise<IntegrationFileHandle>;
  readonly mkdir: (path: string) => Promise<void>;
  readonly createRepository: (root: string) => IntegrationRepository;
  readonly randomId: () => string;
}

export const nodeCodexIntegrationRuntime: CodexIntegrationRuntime = {
  lstat,
  open: async (path, flags, mode) => open(path, flags, mode),
  mkdir: async (path) => { await mkdir(path); },
  createRepository: (root) => new WorkspaceRepository(root),
  randomId: randomUUID,
};

interface AgentsObservation {
  readonly bytes: Buffer | undefined;
  readonly identity: FileIdentity | undefined;
  readonly rootIdentity: FileIdentity;
  readonly text: string;
}

interface WorkspaceObservation {
  readonly exists: boolean;
  readonly projectRootIdentity: FileIdentity;
  readonly workspaceIdentity: FileIdentity | undefined;
  readonly backupsIdentity: FileIdentity | undefined;
}

interface RecoveryFile {
  readonly bytes: Buffer;
  readonly identity: FileIdentity;
  readonly path: string;
}

interface RecoveryDirectory {
  readonly backupsIdentity: FileIdentity;
  readonly identity: FileIdentity;
  readonly path: string;
  readonly projectRootIdentity: FileIdentity;
  readonly workspaceIdentity: FileIdentity;
}

type RecoveryVerification =
  | { readonly ok: true }
  | { readonly ok: false; readonly cause: unknown };

export class InspectionRequiredError extends Error {
  readonly code = "INSPECTION_REQUIRED" as const;
  readonly operation: string;
  readonly recoveryPath: string;
  readonly backupPath: string | undefined;
  readonly paths: readonly string[];

  constructor(
    operation: string,
    recoveryPath: string,
    backupPath: string | undefined,
    cause: unknown,
  ) {
    super(
      `${operation} failed and requires inspection; recovery: ${recoveryPath}; backup: ${backupPath ?? "not-created"}`,
      { cause },
    );
    this.name = "InspectionRequiredError";
    this.operation = operation;
    this.recoveryPath = recoveryPath;
    this.backupPath = backupPath;
    this.paths = Object.freeze(backupPath === undefined
      ? [recoveryPath]
      : [recoveryPath, backupPath]);
  }
}

async function projectRootIdentity(
  runtime: CodexIntegrationRuntime,
  projectRoot: string,
): Promise<FileIdentity> {
  const stat = await runtime.lstat(projectRoot);
  assertRealDirectory(stat, "project root");
  return identity(stat);
}

async function assertDirectoryIdentity(
  runtime: CodexIntegrationRuntime,
  path: string,
  expected: FileIdentity,
  label: string,
): Promise<void> {
  await assertRealDirectoryIdentity(
    runtime,
    path,
    expected,
    label,
    `${label} changed during integration publication`,
  );
}

async function assertProjectRootIdentity(
  runtime: CodexIntegrationRuntime,
  projectRoot: string,
  expected: FileIdentity,
): Promise<void> {
  await assertRealDirectoryIdentity(
    runtime,
    projectRoot,
    expected,
    "project root",
    "project root changed during integration publication",
  );
}

function decodeAgents(bytes: Buffer): string {
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    throw new Error("AGENTS.md must not contain a UTF-8 BOM");
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch (error: unknown) {
    throw new Error("AGENTS.md must contain valid UTF-8", { cause: error });
  }
}

async function readAgents(
  projectRoot: string,
  runtime: CodexIntegrationRuntime,
): Promise<AgentsObservation> {
  const rootBefore = await projectRootIdentity(runtime, projectRoot);
  const path = join(projectRoot, "AGENTS.md");
  const before = await observed(runtime, path);
  if (before === undefined) {
    if (await observed(runtime, path) !== undefined) throw new Error("AGENTS.md changed during read");
    const rootAfter = await projectRootIdentity(runtime, projectRoot);
    if (!sameNode(rootBefore, rootAfter)) throw new Error("project root changed during AGENTS.md read");
    return { bytes: undefined, identity: undefined, rootIdentity: rootBefore, text: "" };
  }

  const opened = await readNoFollowPathBounded(runtime, path, before, AGENTS_READ_POLICY);
  const rootAfter = await projectRootIdentity(runtime, projectRoot);
  if (!sameNode(rootBefore, rootAfter)) throw new Error("project root changed during AGENTS.md read");
  return {
    bytes: opened.bytes,
    identity: opened.identity,
    rootIdentity: rootBefore,
    text: decodeAgents(opened.bytes),
  };
}

function agentsToken(bytes: Buffer | undefined): string {
  return bytes === undefined
    ? "missing"
    : `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function sameAgentsObservation(left: AgentsObservation, right: AgentsObservation): boolean {
  if (!sameNode(left.rootIdentity, right.rootIdentity)) return false;
  if (agentsToken(left.bytes) !== agentsToken(right.bytes)) return false;
  if (left.identity === undefined || right.identity === undefined) return left.identity === right.identity;
  return sameFile(left.identity, right.identity);
}

function inspectionError(
  operation: string,
  recoveryPath: string,
  backupPath: string | undefined,
  cause: unknown,
): InspectionRequiredError {
  return new InspectionRequiredError(operation, recoveryPath, backupPath, cause);
}

function isInspectionError(error: unknown): error is InspectionRequiredError {
  return error instanceof InspectionRequiredError;
}

async function verifyRecoveryFile(
  runtime: CodexIntegrationRuntime,
  file: RecoveryFile,
): Promise<RecoveryVerification> {
  try {
    const before = await observed(runtime, file.path);
    if (before === undefined || !before.isFile() || before.isSymbolicLink()) {
      return { ok: false, cause: new Error("recovery file path is missing or not a real file") };
    }
    const opened = await readNoFollowPathBounded(runtime, file.path, before, AGENTS_READ_POLICY);
    const valid = sameNode(opened.identity, file.identity)
      && opened.bytes.equals(file.bytes);
    return valid
      ? { ok: true }
      : { ok: false, cause: new Error("recovery file identity or content changed") };
  } catch (error: unknown) {
    return { ok: false, cause: error };
  }
}

async function writeAll(handle: IntegrationFileHandle, bytes: Buffer): Promise<void> {
  let offset = 0;
  while (offset < bytes.length) {
    const { bytesWritten } = await handle.write(bytes, offset, bytes.length - offset, offset);
    if (bytesWritten <= 0) throw new Error("write made no progress");
    offset += bytesWritten;
  }
  await handle.truncate(bytes.length);
}

async function createExclusiveFile(
  runtime: CodexIntegrationRuntime,
  path: string,
  bytes: Buffer,
  recoveryPath: string,
  backupPath: string | undefined,
): Promise<RecoveryFile> {
  let handle: IntegrationFileHandle;
  try {
    handle = await runtime.open(path, "wx", 0o600);
  } catch (error: unknown) {
    throw inspectionError("exclusive recovery-file creation", recoveryPath, backupPath, error);
  }
  let failure: unknown;
  try {
    await writeAll(handle, bytes);
    await handle.sync();
    const stat = await handle.stat();
    const file: RecoveryFile = { bytes, identity: identity(stat), path };
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size !== bytes.length) {
      throw new Error("recovery file is not a bounded regular file");
    }
    return file;
  } catch (error: unknown) {
    failure = inspectionError("recovery-file write", recoveryPath, backupPath ?? path, error);
    throw failure;
  } finally {
    try {
      await handle.close();
    } catch (error: unknown) {
      if (failure === undefined) {
        throw inspectionError("recovery-file close", recoveryPath, backupPath ?? path, error);
      }
    }
  }
}

async function createWorkspaceFile(
  runtime: CodexIntegrationRuntime,
  workspacePath: string,
  relativePath: string,
  contents: string,
): Promise<void> {
  const path = join(workspacePath, ...relativePath.split("/"));
  const bytes = Buffer.from(contents, "utf8");
  const file = await createExclusiveFile(runtime, path, bytes, workspacePath, undefined);
  const verification = await verifyRecoveryFile(runtime, file);
  if (!verification.ok) {
    throw inspectionError("workspace-file verification", workspacePath, undefined, verification.cause);
  }
}

async function createExclusiveDirectory(
  runtime: CodexIntegrationRuntime,
  path: string,
  recoveryPath: string,
): Promise<FileIdentity> {
  if (await observed(runtime, path) !== undefined) {
    throw inspectionError("exclusive directory allocation", recoveryPath, undefined, new Error(path));
  }
  try {
    await runtime.mkdir(path);
  } catch (error: unknown) {
    throw inspectionError("exclusive directory allocation", recoveryPath, undefined, error);
  }
  try {
    const stat = await runtime.lstat(path);
    assertRealDirectory(stat, "integration directory");
    return identity(stat);
  } catch (error: unknown) {
    throw inspectionError("exclusive directory verification", recoveryPath, undefined, error);
  }
}

async function createWorkspaceNoClobber(
  projectRoot: string,
  name: string,
  serializedProject: string,
  expectedProjectRoot: FileIdentity,
  runtime: CodexIntegrationRuntime,
): Promise<WorkspaceObservation> {
  const workspacePath = join(projectRoot, ".ezagent");
  await assertProjectRootIdentity(runtime, projectRoot, expectedProjectRoot);
  const workspaceIdentity = await createExclusiveDirectory(runtime, workspacePath, workspacePath);

  const created = new Map<string, FileIdentity>([[workspacePath, workspaceIdentity]]);
  try {
    await assertProjectRootIdentity(runtime, projectRoot, expectedProjectRoot);
    for (const relativeDirectory of WORKSPACE_DIRECTORIES) {
      let parent = workspacePath;
      for (const component of relativeDirectory.split("/")) {
        const path = join(parent, component);
        if (!created.has(path)) {
          created.set(path, await createExclusiveDirectory(runtime, path, workspacePath));
          await assertDirectoryIdentity(runtime, parent, created.get(parent)!, "workspace directory ancestor");
        }
        parent = path;
      }
    }

    await createWorkspaceFile(runtime, workspacePath, "state/workspace.json", `${JSON.stringify(CANONICAL_INITIAL_STATE, null, 2)}\n`);
    await createWorkspaceFile(runtime, workspacePath, "audit/events.jsonl", "");
    await createWorkspaceFile(
      runtime,
      workspacePath,
      "project.yaml",
      serializedProject,
    );
    for (const directory of [...created.keys()].reverse()) await syncDirectory(runtime, directory);
    await assertDirectoryIdentity(runtime, workspacePath, workspaceIdentity, "workspace root");
    await assertProjectRootIdentity(runtime, projectRoot, expectedProjectRoot);
    await syncDirectory(runtime, projectRoot);
    await assertProjectRootIdentity(runtime, projectRoot, expectedProjectRoot);
  } catch (error: unknown) {
    if (isInspectionError(error)) throw error;
    throw inspectionError("workspace publication", workspacePath, undefined, error);
  }

  let context: IntegrationContext;
  try {
    context = await runtime.createRepository(projectRoot).readContext();
    if (
      context.recovered
      || context.project.schemaVersion !== 1
      || context.project.name !== name
      || context.project.gitTracking !== "none"
    ) {
      throw new Error("context mismatch");
    }
    await assertDirectoryIdentity(runtime, workspacePath, workspaceIdentity, "workspace root");
    await assertDirectoryIdentity(
      runtime,
      join(workspacePath, "backups"),
      created.get(join(workspacePath, "backups"))!,
      "workspace backups directory",
    );
    await assertProjectRootIdentity(runtime, projectRoot, expectedProjectRoot);
  } catch (error: unknown) {
    if (isInspectionError(error)) throw error;
    throw inspectionError("workspace verification", workspacePath, undefined, error);
  }
  return {
    exists: true,
    projectRootIdentity: expectedProjectRoot,
    workspaceIdentity,
    backupsIdentity: created.get(join(workspacePath, "backups"))!,
  };
}

async function inspectWorkspace(
  projectRoot: string,
  name: string,
  expectedProjectRoot: FileIdentity,
  runtime: CodexIntegrationRuntime,
): Promise<WorkspaceObservation> {
  await assertProjectRootIdentity(runtime, projectRoot, expectedProjectRoot);
  const workspacePath = join(projectRoot, ".ezagent");
  const workspace = await observed(runtime, workspacePath);
  if (workspace === undefined) {
    await assertProjectRootIdentity(runtime, projectRoot, expectedProjectRoot);
    return {
      exists: false,
      projectRootIdentity: expectedProjectRoot,
      workspaceIdentity: undefined,
      backupsIdentity: undefined,
    };
  }
  assertRealDirectory(workspace, "existing workspace");
  let context: IntegrationContext;
  try {
    context = await runtime.createRepository(projectRoot).readContext();
  } catch (error: unknown) {
    throw new Error("existing .ezagent is incomplete or corrupt; refusing in-place initialization", { cause: error });
  }
  if (
    context.recovered
    || context.project.schemaVersion !== 1
    || context.project.name !== name
    || context.project.gitTracking !== "none"
  ) {
    throw new Error("existing .ezagent is incomplete, corrupt, or configured differently");
  }
  const backupsPath = join(workspacePath, "backups");
  const backups = await runtime.lstat(backupsPath);
  assertRealDirectory(backups, "workspace backups directory");
  await assertProjectRootIdentity(runtime, projectRoot, expectedProjectRoot);
  return {
    exists: true,
    projectRootIdentity: expectedProjectRoot,
    workspaceIdentity: identity(workspace),
    backupsIdentity: identity(backups),
  };
}

async function revalidateWorkspaceObservation(
  projectRoot: string,
  observation: WorkspaceObservation,
  runtime: CodexIntegrationRuntime,
): Promise<void> {
  await assertProjectRootIdentity(runtime, projectRoot, observation.projectRootIdentity);
  const workspacePath = join(projectRoot, ".ezagent");
  const workspace = await observed(runtime, workspacePath);
  if (!observation.exists) {
    if (workspace !== undefined) throw new Error("workspace changed before publication");
    await assertProjectRootIdentity(runtime, projectRoot, observation.projectRootIdentity);
    return;
  }
  if (
    workspace === undefined
    || observation.workspaceIdentity === undefined
    || !workspace.isDirectory()
    || workspace.isSymbolicLink()
    || !sameNode(identity(workspace), observation.workspaceIdentity)
  ) {
    throw new Error("workspace changed before publication");
  }
  const backups = await observed(runtime, join(workspacePath, "backups"));
  if (
    backups === undefined
    || observation.backupsIdentity === undefined
    || !backups.isDirectory()
    || backups.isSymbolicLink()
    || !sameNode(identity(backups), observation.backupsIdentity)
  ) {
    throw new Error("workspace backups directory changed before publication");
  }
  await assertProjectRootIdentity(runtime, projectRoot, observation.projectRootIdentity);
}

async function ensureRecoveryDirectory(
  projectRoot: string,
  observation: WorkspaceObservation,
  runtime: CodexIntegrationRuntime,
): Promise<RecoveryDirectory> {
  const workspacePath = join(projectRoot, ".ezagent");
  const backupsPath = join(workspacePath, "backups");
  await revalidateWorkspaceObservation(projectRoot, observation, runtime);
  const path = join(backupsPath, "agents-md");
  let directory = await observed(runtime, path);
  if (directory === undefined) {
    try {
      await runtime.mkdir(path);
    } catch (error: unknown) {
      throw inspectionError("AGENTS recovery-directory creation", path, undefined, error);
    }
    try {
      await assertDirectoryIdentity(runtime, workspacePath, observation.workspaceIdentity!, "workspace root");
      await assertDirectoryIdentity(runtime, backupsPath, observation.backupsIdentity!, "workspace backups directory");
      await assertProjectRootIdentity(runtime, projectRoot, observation.projectRootIdentity);
      directory = await runtime.lstat(path);
      assertRealDirectory(directory, "AGENTS recovery directory");
      await syncDirectory(runtime, backupsPath);
      await assertProjectRootIdentity(runtime, projectRoot, observation.projectRootIdentity);
    } catch (error: unknown) {
      if (isInspectionError(error)) throw error;
      throw inspectionError("AGENTS recovery-directory verification", path, undefined, error);
    }
  } else {
    assertRealDirectory(directory, "AGENTS recovery directory");
  }
  const directoryIdentity = identity(directory);
  await assertDirectoryIdentity(runtime, path, directoryIdentity, "AGENTS recovery directory");
  await assertProjectRootIdentity(runtime, projectRoot, observation.projectRootIdentity);
  return {
    backupsIdentity: observation.backupsIdentity!,
    identity: directoryIdentity,
    path,
    projectRootIdentity: observation.projectRootIdentity,
    workspaceIdentity: observation.workspaceIdentity!,
  };
}

async function assertRecoveryDirectory(
  projectRoot: string,
  directory: RecoveryDirectory,
  runtime: CodexIntegrationRuntime,
): Promise<void> {
  await assertProjectRootIdentity(runtime, projectRoot, directory.projectRootIdentity);
  await assertDirectoryIdentity(runtime, join(projectRoot, ".ezagent"), directory.workspaceIdentity, "workspace root");
  await assertDirectoryIdentity(runtime, join(projectRoot, ".ezagent", "backups"), directory.backupsIdentity, "workspace backups directory");
  await assertDirectoryIdentity(runtime, directory.path, directory.identity, "AGENTS recovery directory");
  await assertProjectRootIdentity(runtime, projectRoot, directory.projectRootIdentity);
}

async function durableRecoveryFile(
  projectRoot: string,
  directory: RecoveryDirectory,
  bytes: Buffer,
  suffix: "bak" | "next",
  backupPath: string | undefined,
  runtime: CodexIntegrationRuntime,
): Promise<RecoveryFile> {
  try {
    await assertRecoveryDirectory(projectRoot, directory, runtime);
  } catch (error: unknown) {
    throw inspectionError(
      "AGENTS recovery-directory revalidation",
      directory.path,
      backupPath,
      error,
    );
  }
  const token = runtime.randomId().replaceAll("-", "").slice(0, 32);
  const path = join(directory.path, `AGENTS.md.${token}.${suffix}`);
  const file = await createExclusiveFile(runtime, path, bytes, directory.path, backupPath);
  const verification = await verifyRecoveryFile(runtime, file);
  if (!verification.ok) {
    throw inspectionError("AGENTS recovery-file verification", directory.path, backupPath ?? path, verification.cause);
  }
  try {
    await syncDirectory(runtime, directory.path);
  } catch (error: unknown) {
    throw inspectionError(
      "AGENTS recovery-directory sync",
      directory.path,
      backupPath ?? file.path,
      error,
    );
  }
  try {
    await assertRecoveryDirectory(projectRoot, directory, runtime);
  } catch (error: unknown) {
    throw inspectionError(
      "AGENTS recovery-directory revalidation",
      directory.path,
      backupPath ?? file.path,
      error,
    );
  }
  const durableVerification = await verifyRecoveryFile(runtime, file);
  if (!durableVerification.ok) {
    throw inspectionError("AGENTS recovery-file durability", directory.path, backupPath ?? path, durableVerification.cause);
  }
  return file;
}

async function updateExistingAgents(
  projectRoot: string,
  before: AgentsObservation,
  mergedBytes: Buffer,
  backup: RecoveryFile,
  next: RecoveryFile,
  directory: RecoveryDirectory,
  runtime: CodexIntegrationRuntime,
): Promise<void> {
  const target = join(projectRoot, "AGENTS.md");
  try {
    await assertRecoveryDirectory(projectRoot, directory, runtime);
  } catch (error: unknown) {
    throw inspectionError("AGENTS publication preflight", next.path, backup.path, error);
  }
  let handle: IntegrationFileHandle;
  try {
    handle = await runtime.open(target, noFollowReadFlags(true));
  } catch (error: unknown) {
    throw inspectionError("AGENTS publication open", next.path, backup.path, error);
  }

  let failure: unknown;
  try {
    const current = await readHandleBounded(handle, AGENTS_READ_POLICY, before.identity);
    if (!current.bytes.equals(before.bytes!)) throw new Error("AGENTS.md changed before publication");
    await assertRecoveryDirectory(projectRoot, directory, runtime);
    const targetBefore = await runtime.lstat(target);
    if (!sameFile(identity(targetBefore), before.identity!)) throw new Error("AGENTS.md changed before publication");
    await writeAll(handle, mergedBytes);
    await handle.sync();
    const published = await readHandleBounded(handle, AGENTS_READ_POLICY);
    if (!published.bytes.equals(mergedBytes)) throw new Error("published AGENTS.md content mismatch");
    const targetAfter = await observed(runtime, target);
    if (targetAfter === undefined || !sameFile(identity(targetAfter), published.identity)) {
      throw new Error("AGENTS.md path was replaced during publication");
    }
    await assertRecoveryDirectory(projectRoot, directory, runtime);
  } catch (error: unknown) {
    failure = inspectionError("AGENTS publication", next.path, backup.path, error);
    throw failure;
  } finally {
    try {
      await handle.close();
    } catch (error: unknown) {
      if (failure === undefined) {
        throw inspectionError("AGENTS publication close", next.path, backup.path, error);
      }
    }
  }

  try {
    await assertProjectRootIdentity(runtime, projectRoot, directory.projectRootIdentity);
    await syncDirectory(runtime, projectRoot);
    await assertProjectRootIdentity(runtime, projectRoot, directory.projectRootIdentity);
  } catch (error: unknown) {
    throw inspectionError("AGENTS project-directory sync", next.path, backup.path, error);
  }
}

async function publishMissingAgents(
  projectRoot: string,
  next: RecoveryFile,
  directory: RecoveryDirectory,
  runtime: CodexIntegrationRuntime,
): Promise<void> {
  const target = join(projectRoot, "AGENTS.md");
  try {
    await assertRecoveryDirectory(projectRoot, directory, runtime);
    if (await observed(runtime, target) !== undefined) {
      throw inspectionError("AGENTS no-clobber publication", next.path, undefined, new Error("target appeared"));
    }
    const published = await createExclusiveFile(runtime, target, next.bytes, next.path, undefined);
    await assertProjectRootIdentity(runtime, projectRoot, directory.projectRootIdentity);
    const verification = await verifyRecoveryFile(runtime, published);
    if (!verification.ok) {
      throw inspectionError("AGENTS no-clobber verification", next.path, undefined, verification.cause);
    }
    try {
      await assertProjectRootIdentity(runtime, projectRoot, directory.projectRootIdentity);
      await syncDirectory(runtime, projectRoot);
      await assertProjectRootIdentity(runtime, projectRoot, directory.projectRootIdentity);
    } catch (error: unknown) {
      throw inspectionError("AGENTS project-directory sync", next.path, undefined, error);
    }
  } catch (error: unknown) {
    if (isInspectionError(error)) throw error;
    throw inspectionError("AGENTS no-clobber publication", next.path, undefined, error);
  }
}

export async function previewCodexIntegration(
  projectRoot: string,
  runtime: CodexIntegrationRuntime = nodeCodexIntegrationRuntime,
): Promise<{ readonly paths: typeof MANAGED_PATHS; readonly agentsToken: string }> {
  const agents = await readAgents(projectRoot, runtime);
  return { paths: MANAGED_PATHS, agentsToken: agentsToken(agents.bytes) };
}

export async function initializeCodexIntegration(
  projectRoot: string,
  name: string,
  expectedToken: string,
  runtime: CodexIntegrationRuntime = nodeCodexIntegrationRuntime,
): Promise<{
  readonly initialized: true;
  readonly root: string;
  readonly continuation: typeof POST_INITIALIZATION_CONTINUATION;
}> {
  const before = await readAgents(projectRoot, runtime);
  if (agentsToken(before.bytes) !== expectedToken) {
    throw new Error("AGENTS.md preview is stale; preview again");
  }
  const merged = mergeEzagentAgentsBlock(before.text);
  const mergedBytes = Buffer.from(merged, "utf8");
  if (mergedBytes.length > MAX_AGENTS_BYTES) throw new Error("AGENTS.md must be a bounded regular file");
  const serializedProject = serializeProjectConfig({ schemaVersion: 1, name, gitTracking: "none" });

  let workspace = await inspectWorkspace(projectRoot, name, before.rootIdentity, runtime);
  const finalAgents = await readAgents(projectRoot, runtime);
  if (!sameAgentsObservation(before, finalAgents)) throw new Error("AGENTS.md changed before publication");
  await revalidateWorkspaceObservation(projectRoot, workspace, runtime);

  const workspaceWasCreated = !workspace.exists;
  if (!workspace.exists) {
    workspace = await createWorkspaceNoClobber(
      projectRoot,
      name,
      serializedProject,
      before.rootIdentity,
      runtime,
    );
  }
  if (mergedBytes.equals(before.bytes ?? Buffer.alloc(0))) {
    try {
      await revalidateWorkspaceObservation(projectRoot, workspace, runtime);
      await assertProjectRootIdentity(runtime, projectRoot, before.rootIdentity);
      const current = await readAgents(projectRoot, runtime);
      if (!sameAgentsObservation(before, current) || !current.bytes?.equals(mergedBytes)) {
        throw new Error("AGENTS.md changed before no-op completion");
      }
    } catch (error: unknown) {
      if (isInspectionError(error)) throw error;
      if (workspaceWasCreated) {
        throw inspectionError(
          "integration no-op verification",
          join(projectRoot, ".ezagent"),
          undefined,
          error,
        );
      }
      throw error;
    }
    return {
      initialized: true,
      root: projectRoot,
      continuation: POST_INITIALIZATION_CONTINUATION,
    };
  }

  const intendedRecoveryPath = join(projectRoot, ".ezagent", "backups", "agents-md");
  let knownBackupPath: string | undefined;
  try {
    const recoveryDirectory = await ensureRecoveryDirectory(projectRoot, workspace, runtime);
    const backup = before.bytes === undefined
      ? undefined
      : await durableRecoveryFile(projectRoot, recoveryDirectory, before.bytes, "bak", undefined, runtime);
    knownBackupPath = backup?.path;
    const next = await durableRecoveryFile(
      projectRoot,
      recoveryDirectory,
      mergedBytes,
      "next",
      backup?.path,
      runtime,
    );

    if (before.bytes === undefined) {
      await publishMissingAgents(projectRoot, next, recoveryDirectory, runtime);
    } else {
      await updateExistingAgents(projectRoot, before, mergedBytes, backup!, next, recoveryDirectory, runtime);
    }

    try {
      await revalidateWorkspaceObservation(projectRoot, workspace, runtime);
      await assertProjectRootIdentity(runtime, projectRoot, before.rootIdentity);
    } catch (error: unknown) {
      throw inspectionError("integration verification", next.path, backup?.path, error);
    }
    let published: AgentsObservation;
    try {
      published = await readAgents(projectRoot, runtime);
    } catch (error: unknown) {
      throw inspectionError("integration verification", next.path, backup?.path, error);
    }
    if (!published.bytes?.equals(mergedBytes)) {
      throw inspectionError("integration verification", next.path, backup?.path, new Error("AGENTS.md mismatch"));
    }
    if (!sameNode(published.rootIdentity, before.rootIdentity)) {
      throw inspectionError("integration verification", next.path, backup?.path, new Error("project root changed"));
    }
    if (
      before.identity !== undefined
      && (published.identity === undefined || !sameNode(published.identity, before.identity))
    ) {
      throw inspectionError("integration verification", next.path, backup?.path, new Error("AGENTS.md identity changed"));
    }
  } catch (error: unknown) {
    if (isInspectionError(error)) throw error;
    throw inspectionError(
      "integration recovery workflow",
      intendedRecoveryPath,
      knownBackupPath,
      error,
    );
  }
  return {
    initialized: true,
    root: projectRoot,
    continuation: POST_INITIALIZATION_CONTINUATION,
  };
}
