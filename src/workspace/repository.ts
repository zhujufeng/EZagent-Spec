import { randomUUID } from "node:crypto";
import { lstatSync, realpathSync } from "node:fs";
import { lstat, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";

import {
  parseAuditEvent,
  readAuditEvents,
  type AuditEvent,
  type AuditMetadata,
} from "../audit/events.js";
import { CANONICAL_INITIAL_STATE, recoverState } from "../audit/recovery.js";
import {
  lstatBigint,
  stableFileIdentity,
  type StableFileIdentity,
} from "../filesystem/stats.js";

import { atomicWriteText } from "./atomic-write.js";
import { workspaceCommitRuntime } from "./commit-runtime.js";
import {
  assertWorkspaceDirectoryBinding,
  captureExistingWorkspaceDirectoryBinding,
  ensureWorkspaceDirectoryChains,
  nodeWorkspaceDirectoryRuntime,
  validateExistingWorkspaceDirectoryChains,
} from "./directory-boundary.js";
import {
  WorkspaceCorruptError,
  WorkspaceLockedError,
  WorkspaceNotInitializedError,
} from "./errors.js";
import { WORKSPACE_DIRECTORIES, workspacePaths, type WorkspacePaths } from "./layout.js";
import { withWorkspaceLock } from "./lock.js";
import {
  artifactParentDirectories,
  artifactHashesMatch,
  createPendingMutation,
  ensureArtifactBoundaries,
  hashText,
  normalizeWorkspaceMutation,
  targetPath,
  validateExistingArtifactBoundaries,
  type PendingMutation,
  type WorkspaceMutationWrite,
} from "./mutation.js";
import {
  nodePendingMarkerStore,
  type PendingMarkerObservation,
} from "./pending-marker.js";
import { workspaceInitializeRetryRuntime } from "./retry-runtime.js";
import {
  parseProjectConfig,
  parseWorkspaceState,
  serializeProjectConfig,
  type ProjectConfig,
  type WorkspaceState,
} from "./schema.js";

const INITIAL_STATE: WorkspaceState = CANONICAL_INITIAL_STATE;
const SAFE_INITIAL_STATE: WorkspaceState = { ...CANONICAL_INITIAL_STATE, safeMode: true };
const INITIALIZE_LOCK_RETRY_INITIAL_MS = 10;
const INITIALIZE_LOCK_RETRY_MAX_MS = 250;
const DEFAULT_INITIALIZE_TIMEOUT_MS = 60_000;

export interface WorkspaceInitializeOptions {
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
}

interface NormalizedInitializeOptions {
  readonly timeoutMs: number;
  readonly signal: AbortSignal | undefined;
}

type WorkspaceTextRead =
  | { readonly exists: false; readonly cause: unknown }
  | { readonly exists: true; readonly contents: string };

function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === "ENOENT";
}

function isLockContention(error: unknown): error is WorkspaceLockedError {
  return error instanceof WorkspaceLockedError && error.code === "LOCK_CONTENDED";
}

function normalizeProjectConfig(config: ProjectConfig): ProjectConfig {
  return parseProjectConfig(serializeProjectConfig(config));
}

function sameProjectConfig(left: ProjectConfig, right: ProjectConfig): boolean {
  return left.schemaVersion === right.schemaVersion
    && left.name === right.name
    && left.gitTracking === right.gitTracking;
}

function assertSameProjectConfig(existing: ProjectConfig, requested: ProjectConfig): void {
  if (!sameProjectConfig(existing, requested)) {
    throw new Error("workspace already initialized with different configuration");
  }
}

function normalizeInitializeOptions(options: WorkspaceInitializeOptions | undefined): NormalizedInitializeOptions {
  const timeoutMs = options?.timeoutMs ?? DEFAULT_INITIALIZE_TIMEOUT_MS;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new TypeError("initialize timeoutMs must be a finite positive number");
  }
  options?.signal?.throwIfAborted();
  return { timeoutMs, signal: options?.signal };
}

function lockWaitTimeout(lock: string, timeoutMs: number): WorkspaceLockedError {
  return new WorkspaceLockedError(`Workspace lock wait timed out after ${timeoutMs}ms: ${lock}`, {
    code: "LOCK_WAIT_TIMEOUT",
  });
}

async function readWorkspaceText(path: string, label: string): Promise<WorkspaceTextRead> {
  let fileStat: Awaited<ReturnType<typeof lstat>>;
  try {
    fileStat = await lstat(path);
  } catch (error: unknown) {
    if (isMissing(error)) {
      return { exists: false, cause: error };
    }
    throw new WorkspaceCorruptError(`${label} is unreadable or corrupt: ${path}`, { cause: error });
  }
  if (!fileStat.isFile()) {
    const cause = new Error(`${label} expected regular file`);
    throw new WorkspaceCorruptError(`${label} must be a regular file: ${path}`, { cause });
  }

  try {
    // The local-only workflow assumes no adversarial replacement between this lstat and read.
    return { exists: true, contents: await readFile(path, "utf8") };
  } catch (error: unknown) {
    throw new WorkspaceCorruptError(`${label} is unreadable or corrupt: ${path}`, { cause: error });
  }
}

async function readExistingProject(path: string): Promise<ProjectConfig | undefined> {
  const project = await readWorkspaceText(path, "workspace project");
  if (!project.exists) {
    return undefined;
  }

  try {
    return parseProjectConfig(project.contents);
  } catch (error: unknown) {
    throw new WorkspaceCorruptError(`workspace project is unreadable or corrupt: ${path}`, { cause: error });
  }
}

async function readExistingProjectWithinBoundaries(
  paths: Readonly<WorkspacePaths>,
  relativeDirectories: readonly string[],
): Promise<ProjectConfig | undefined> {
  await validateExistingWorkspaceDirectoryChains(
    nodeWorkspaceDirectoryRuntime,
    paths.root,
    relativeDirectories,
  );
  return readExistingProject(paths.project);
}

function isInitialState(state: WorkspaceState): boolean {
  return state.schemaVersion === INITIAL_STATE.schemaVersion
    && state.revision === INITIAL_STATE.revision
    && state.activeWorkItem === INITIAL_STATE.activeWorkItem
    && state.safeMode === INITIAL_STATE.safeMode;
}

async function inspectInitialState(path: string): Promise<boolean> {
  const stateFile = await readWorkspaceText(path, "workspace state");
  if (!stateFile.exists) {
    return false;
  }

  let state: WorkspaceState;
  try {
    const value: unknown = JSON.parse(stateFile.contents);
    state = parseWorkspaceState(value);
  } catch (error: unknown) {
    throw new WorkspaceCorruptError(`workspace state is unreadable or corrupt: ${path}`, { cause: error });
  }
  if (!isInitialState(state)) {
    const cause = new Error("uncommitted workspace state is not the canonical initial state");
    throw new WorkspaceCorruptError(`workspace state is not safe to initialize over: ${path}`, { cause });
  }
  return true;
}

async function inspectEmptyAudit(path: string): Promise<boolean> {
  const auditFile = await readWorkspaceText(path, "workspace audit");
  if (!auditFile.exists) {
    return false;
  }
  if (auditFile.contents !== "") {
    const cause = new Error("uncommitted workspace audit is not empty");
    throw new WorkspaceCorruptError(`workspace audit is not safe to initialize over: ${path}`, { cause });
  }
  return true;
}

async function assertProjectionFileBoundary(path: string, label: string): Promise<void> {
  let observed: Awaited<ReturnType<typeof lstat>>;
  try {
    observed = await lstat(path);
  } catch (error: unknown) {
    if (isMissing(error)) return;
    throw new WorkspaceCorruptError(`${label} boundary is unreadable: ${path}`, { cause: error });
  }
  if (!observed.isFile()) {
    throw new WorkspaceCorruptError(`${label} must be a regular file: ${path}`, {
      cause: new Error(`expected regular ${label} file or missing projection`),
    });
  }
}

async function assertProjectionFileBoundaries(paths: Readonly<WorkspacePaths>): Promise<void> {
  await Promise.all([
    assertProjectionFileBoundary(paths.state, "workspace state"),
    assertProjectionFileBoundary(paths.audit, "workspace audit"),
    assertProjectionFileBoundary(paths.pendingMutation, "pending mutation"),
  ]);
}

async function assertRequiredWorkspaceDirectories(paths: Readonly<WorkspacePaths>): Promise<void> {
  for (const relativeDirectory of WORKSPACE_DIRECTORIES) {
    const path = join(paths.root, ...relativeDirectory.split("/"));
    let observed: Awaited<ReturnType<typeof lstat>>;
    try {
      observed = await lstat(path);
    } catch (error: unknown) {
      throw new WorkspaceCorruptError(`required workspace directory is missing or unreadable: ${path}`, {
        cause: error,
      });
    }
    if (!observed.isDirectory()) {
      throw new WorkspaceCorruptError(`required workspace directory must be real: ${path}`, {
        cause: new Error("expected required real workspace directory"),
      });
    }
  }
}

async function readProjectionState(path: string): Promise<WorkspaceState> {
  const stateFile = await readWorkspaceText(path, "workspace state");
  if (!stateFile.exists) {
    throw new WorkspaceCorruptError(`workspace state is unreadable or corrupt: ${path}`, { cause: stateFile.cause });
  }
  try {
    return parseWorkspaceState(JSON.parse(stateFile.contents) as unknown);
  } catch (error: unknown) {
    throw new WorkspaceCorruptError(`workspace state is unreadable or corrupt: ${path}`, { cause: error });
  }
}

function stateMatchesAudit(state: WorkspaceState, events: readonly AuditEvent[]): boolean {
  const projected = recoverState(events);
  return isDeepStrictEqual(state, projected);
}

async function pendingMutationIsCommitted(
  paths: Readonly<WorkspacePaths>,
  marker: PendingMutation,
  state: WorkspaceState,
  events: readonly AuditEvent[],
): Promise<boolean> {
  const finalEvent = events.at(-1);
  return state.revision === marker.toRevision
    && hashText(JSON.stringify(state)) === marker.stateHash
    && finalEvent !== undefined
    && finalEvent.sequence === marker.toRevision
    && hashText(JSON.stringify(finalEvent)) === marker.eventHash
    && isDeepStrictEqual(finalEvent.state, state)
    && await artifactHashesMatch(paths.root, marker);
}

function invalidPendingMutation(paths: Readonly<WorkspacePaths>, cause?: unknown): WorkspaceCorruptError {
  return new WorkspaceCorruptError(`workspace has an unresolved pending mutation: ${paths.pendingMutation}`, {
    cause: cause ?? new Error("pending mutation cannot be proven fully committed"),
  });
}

export type { WorkspaceMutationWrite } from "./mutation.js";

export class WorkspaceRepository {
  readonly projectRoot: string;
  private readonly projectRootIdentity: StableFileIdentity;

  constructor(projectRoot: string) {
    if (typeof projectRoot !== "string" || projectRoot.length === 0 || projectRoot.includes("\0")) {
      throw new TypeError("project root must be a non-empty path");
    }
    this.projectRoot = realpathSync(resolve(projectRoot));
    const observed = lstatSync(this.projectRoot, { bigint: true });
    const identity = stableFileIdentity(observed);
    if (!observed.isDirectory() || identity === undefined) {
      throw new TypeError("project root must be a real directory with a stable identity");
    }
    this.projectRootIdentity = identity;
  }

  private async assertProjectRootIdentity(): Promise<void> {
    try {
      const observed = await lstatBigint(this.projectRoot);
      const identity = stableFileIdentity(observed);
      if (!observed.isDirectory()
        || identity === undefined
        || identity.dev !== this.projectRootIdentity.dev
        || identity.ino !== this.projectRootIdentity.ino) {
        throw new Error("identity mismatch");
      }
    } catch (error: unknown) {
      throw new WorkspaceCorruptError(`project root identity changed: ${this.projectRoot}`, {
        cause: error,
      });
    }
  }

  async initialize(config: ProjectConfig, options?: WorkspaceInitializeOptions): Promise<void> {
    const normalized = normalizeProjectConfig(config);
    const normalizedOptions = normalizeInitializeOptions(options);
    const paths = workspacePaths(this.projectRoot);
    const startedAt = workspaceInitializeRetryRuntime.now();
    let retryDelay = INITIALIZE_LOCK_RETRY_INITIAL_MS;
    let hasContended = false;

    for (;;) {
      await this.assertProjectRootIdentity();
      normalizedOptions.signal?.throwIfAborted();
      if (hasContended) {
        const completed = await readExistingProjectWithinBoundaries(paths, WORKSPACE_DIRECTORIES);
        if (completed !== undefined) {
          assertSameProjectConfig(completed, normalized);
          return;
        }
        normalizedOptions.signal?.throwIfAborted();
        if (workspaceInitializeRetryRuntime.now() - startedAt >= normalizedOptions.timeoutMs) {
          throw lockWaitTimeout(paths.lock, normalizedOptions.timeoutMs);
        }
      }
      try {
        await withWorkspaceLock(this.projectRoot, async () => {
          await this.assertProjectRootIdentity();
          const existing = await readExistingProjectWithinBoundaries(paths, WORKSPACE_DIRECTORIES);
          if (existing !== undefined) {
            assertSameProjectConfig(existing, normalized);
            return;
          }

          const stateExists = await inspectInitialState(paths.state);
          const auditExists = await inspectEmptyAudit(paths.audit);
          await ensureWorkspaceDirectoryChains(
            nodeWorkspaceDirectoryRuntime,
            paths.root,
            WORKSPACE_DIRECTORIES,
          );
          const directoryBinding = await captureExistingWorkspaceDirectoryBinding(
            nodeWorkspaceDirectoryRuntime,
            paths.root,
            WORKSPACE_DIRECTORIES,
          );
          if (!stateExists) {
            await this.assertProjectRootIdentity();
            await atomicWriteText(paths.state, `${JSON.stringify(INITIAL_STATE, null, 2)}\n`);
            await assertWorkspaceDirectoryBinding(nodeWorkspaceDirectoryRuntime, directoryBinding);
          }
          if (!auditExists) {
            await this.assertProjectRootIdentity();
            await atomicWriteText(paths.audit, "");
            await assertWorkspaceDirectoryBinding(nodeWorkspaceDirectoryRuntime, directoryBinding);
          }
          await this.assertProjectRootIdentity();
          await atomicWriteText(paths.project, serializeProjectConfig(normalized));
          await assertWorkspaceDirectoryBinding(nodeWorkspaceDirectoryRuntime, directoryBinding);
          await this.assertProjectRootIdentity();
        });
        return;
      } catch (error: unknown) {
        if (!isLockContention(error)) {
          throw error;
        }
        hasContended = true;

        const completed = await readExistingProjectWithinBoundaries(paths, WORKSPACE_DIRECTORIES);
        if (completed !== undefined) {
          assertSameProjectConfig(completed, normalized);
          return;
        }
        normalizedOptions.signal?.throwIfAborted();
        const remaining = normalizedOptions.timeoutMs - (workspaceInitializeRetryRuntime.now() - startedAt);
        if (remaining <= 0) {
          throw lockWaitTimeout(paths.lock, normalizedOptions.timeoutMs);
        }
        const wait = Math.min(retryDelay, remaining);
        await workspaceInitializeRetryRuntime.wait(wait, normalizedOptions.signal);
        retryDelay = Math.min(retryDelay * 2, INITIALIZE_LOCK_RETRY_MAX_MS);
      }
    }
  }

  async readProject(): Promise<ProjectConfig> {
    await this.assertProjectRootIdentity();
    const paths = workspacePaths(this.projectRoot);
    await validateExistingWorkspaceDirectoryChains(nodeWorkspaceDirectoryRuntime, paths.root, []);
    const projectFile = await readWorkspaceText(paths.project, "workspace project");
    if (!projectFile.exists) {
      throw new WorkspaceNotInitializedError(`workspace is not initialized: ${paths.project}`, {
        cause: projectFile.cause,
      });
    }

    try {
      const project = parseProjectConfig(projectFile.contents);
      await this.assertProjectRootIdentity();
      return project;
    } catch (error: unknown) {
      throw new WorkspaceCorruptError(`workspace project is unreadable or corrupt: ${paths.project}`, {
        cause: error,
      });
    }
  }

  async readState(): Promise<WorkspaceState> {
    await this.readProject();
    const paths = workspacePaths(this.projectRoot);
    await validateExistingWorkspaceDirectoryChains(nodeWorkspaceDirectoryRuntime, paths.root, ["state"]);
    return readProjectionState(paths.state);
  }

  async commitMutation(
    next: WorkspaceState,
    expectedRevision: number,
    eventType: string,
    writes: readonly WorkspaceMutationWrite[] = [],
    metadata: AuditMetadata = {},
  ): Promise<void> {
    // Normalize the complete request before lock acquisition or any filesystem side effect.
    const mutation = normalizeWorkspaceMutation(next, expectedRevision, eventType, writes, metadata);
    await withWorkspaceLock(this.projectRoot, async () => {
      await this.assertProjectRootIdentity();
      await this.readProject();
      const paths = workspacePaths(this.projectRoot);
      await validateExistingWorkspaceDirectoryChains(
        nodeWorkspaceDirectoryRuntime,
        paths.root,
        WORKSPACE_DIRECTORIES,
      );
      await assertRequiredWorkspaceDirectories(paths);
      await assertProjectionFileBoundaries(paths);

      const events = await readAuditEvents(paths.audit);
      const current = recoverState(events);
      let storedState: WorkspaceState | undefined;
      try {
        storedState = await readProjectionState(paths.state);
      } catch {
        storedState = undefined;
      }
      const pendingObservation = await nodePendingMarkerStore.readPendingMarker(paths.pendingMutation);
      const pending = pendingObservation?.marker;
      if (pending !== undefined) {
        if (!await pendingMutationIsCommitted(paths, pending, current, events)) {
          throw invalidPendingMutation(paths);
        }
        if (storedState === undefined || !isDeepStrictEqual(storedState, current)) {
          await workspaceCommitRuntime.atomicWriteText(paths.state, `${JSON.stringify(current, null, 2)}\n`);
        }
        await workspaceCommitRuntime.removePendingMarker(paths.pendingMutation, pendingObservation!);
      } else if (storedState === undefined || !isDeepStrictEqual(storedState, current)) {
        await workspaceCommitRuntime.atomicWriteText(paths.state, `${JSON.stringify(current, null, 2)}\n`);
      }
      if (current.safeMode) {
        throw new WorkspaceCorruptError("workspace is in safe mode; mutation is disabled");
      }
      if (current.revision !== mutation.expectedRevision) {
        throw new Error(
          `revision conflict: expected ${mutation.expectedRevision}, actual ${current.revision}`,
        );
      }
      if (mutation.next.revision !== current.revision + 1) {
        throw new Error("next workspace revision must increment by exactly one");
      }

      // All existing paths are checked before publishing the transaction marker.
      await validateExistingArtifactBoundaries(paths.root, mutation.writes);
      const directoryBinding = await captureExistingWorkspaceDirectoryBinding(
        nodeWorkspaceDirectoryRuntime,
        paths.root,
        [...WORKSPACE_DIRECTORIES, ...artifactParentDirectories(mutation.writes)],
      );
      const at = new Date().toISOString();
      const auditEvent = parseAuditEvent({
        sequence: mutation.next.revision,
        at,
        type: mutation.eventType,
        state: mutation.next,
        metadata: mutation.metadata,
      });
      const marker = createPendingMutation(
        randomUUID(),
        at,
        current.revision,
        auditEvent,
        mutation.writes,
      );
      // Capacity is known before transaction evidence or artifact side effects.
      await workspaceCommitRuntime.preflightAuditAppend(paths.audit, auditEvent);
      const markerObservation = await workspaceCommitRuntime.publishPendingMarker(paths.pendingMutation, marker);
      await assertWorkspaceDirectoryBinding(nodeWorkspaceDirectoryRuntime, directoryBinding);

      // The marker precedes every artifact side effect. Audit is durable before state publication.
      await ensureArtifactBoundaries(paths.root, mutation.writes);
      await assertWorkspaceDirectoryBinding(nodeWorkspaceDirectoryRuntime, directoryBinding);
      for (const write of mutation.writes) {
        await assertWorkspaceDirectoryBinding(nodeWorkspaceDirectoryRuntime, directoryBinding);
        await workspaceCommitRuntime.atomicWriteText(targetPath(paths.root, write.relativePath), write.content);
        await assertWorkspaceDirectoryBinding(nodeWorkspaceDirectoryRuntime, directoryBinding);
      }
      await assertWorkspaceDirectoryBinding(nodeWorkspaceDirectoryRuntime, directoryBinding);
      await workspaceCommitRuntime.appendAuditEvent(paths.audit, auditEvent);
      await assertWorkspaceDirectoryBinding(nodeWorkspaceDirectoryRuntime, directoryBinding);
      await workspaceCommitRuntime.atomicWriteText(paths.state, `${JSON.stringify(mutation.next, null, 2)}\n`);
      await assertWorkspaceDirectoryBinding(nodeWorkspaceDirectoryRuntime, directoryBinding);
      await workspaceCommitRuntime.removePendingMarker(paths.pendingMutation, markerObservation);
      await assertWorkspaceDirectoryBinding(nodeWorkspaceDirectoryRuntime, directoryBinding);
      await this.assertProjectRootIdentity();
    });
  }

  async recordState(next: WorkspaceState, expectedRevision: number, eventType: string): Promise<void> {
    await this.commitMutation(next, expectedRevision, eventType);
  }

  async readContext(): Promise<{ project: ProjectConfig; state: WorkspaceState; recovered: boolean }> {
    const project = await this.readProject();
    const paths = workspacePaths(this.projectRoot);
    await validateExistingWorkspaceDirectoryChains(
      nodeWorkspaceDirectoryRuntime,
      paths.root,
      WORKSPACE_DIRECTORIES,
    );
    await assertRequiredWorkspaceDirectories(paths);
    // Directory/symlink boundary errors are not recovery projection failures and must surface.
    await assertProjectionFileBoundaries(paths);

    let events: AuditEvent[];
    try {
      events = await readAuditEvents(paths.audit);
    } catch {
      return { project, state: { ...SAFE_INITIAL_STATE }, recovered: false };
    }

    let projectedState: WorkspaceState | undefined;
    try {
      projectedState = await readProjectionState(paths.state);
    } catch {
      projectedState = undefined;
    }

    let pendingObservation: PendingMarkerObservation | undefined;
    try {
      pendingObservation = await nodePendingMarkerStore.readPendingMarker(paths.pendingMutation);
    } catch {
      return { project, state: { ...SAFE_INITIAL_STATE }, recovered: false };
    }
    const pending = pendingObservation?.marker;
    if (pending !== undefined) {
      const recovered = recoverState(events);
      if (!await pendingMutationIsCommitted(paths, pending, recovered, events)) {
        return { project, state: { ...SAFE_INITIAL_STATE }, recovered: false };
      }
      if (projectedState === undefined || !isDeepStrictEqual(projectedState, recovered)) {
        return { project, state: recovered, recovered: true };
      }
    }

    if (projectedState !== undefined && stateMatchesAudit(projectedState, events)) {
      return { project, state: projectedState, recovered: false };
    }
    return { project, state: recoverState(events), recovered: true };
  }
}
