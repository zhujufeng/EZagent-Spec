import { lstat, readFile } from "node:fs/promises";

import { atomicWriteText } from "./atomic-write.js";
import {
  ensureWorkspaceDirectoryChains,
  nodeWorkspaceDirectoryRuntime,
  validateExistingWorkspaceDirectoryChains,
} from "./directory-boundary.js";
import {
  WorkspaceCorruptError,
  WorkspaceLockedError,
  WorkspaceNotInitializedError,
} from "./errors.js";
import { WORKSPACE_DIRECTORIES, workspacePaths } from "./layout.js";
import { withWorkspaceLock } from "./lock.js";
import { workspaceInitializeRetryRuntime } from "./retry-runtime.js";
import {
  parseProjectConfig,
  parseWorkspaceState,
  serializeProjectConfig,
  type ProjectConfig,
  type WorkspaceState,
} from "./schema.js";

const INITIAL_STATE: WorkspaceState = {
  schemaVersion: 1,
  revision: 0,
  activeWorkItem: null,
  safeMode: false,
};
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

export class WorkspaceRepository {
  constructor(readonly projectRoot: string) {}

  async initialize(config: ProjectConfig, options?: WorkspaceInitializeOptions): Promise<void> {
    const normalized = normalizeProjectConfig(config);
    const normalizedOptions = normalizeInitializeOptions(options);
    const paths = workspacePaths(this.projectRoot);
    const startedAt = workspaceInitializeRetryRuntime.now();
    let retryDelay = INITIALIZE_LOCK_RETRY_INITIAL_MS;
    let hasContended = false;

    for (;;) {
      normalizedOptions.signal?.throwIfAborted();
      if (hasContended) {
        const completed = await readExistingProject(paths.project);
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
          const existing = await readExistingProject(paths.project);
          if (existing !== undefined) {
            assertSameProjectConfig(existing, normalized);
            return;
          }

          await validateExistingWorkspaceDirectoryChains(
            nodeWorkspaceDirectoryRuntime,
            paths.root,
            WORKSPACE_DIRECTORIES,
          );
          const stateExists = await inspectInitialState(paths.state);
          const auditExists = await inspectEmptyAudit(paths.audit);
          await ensureWorkspaceDirectoryChains(
            nodeWorkspaceDirectoryRuntime,
            paths.root,
            WORKSPACE_DIRECTORIES,
          );
          if (!stateExists) {
            await atomicWriteText(paths.state, `${JSON.stringify(INITIAL_STATE, null, 2)}\n`);
          }
          if (!auditExists) {
            await atomicWriteText(paths.audit, "");
          }
          await atomicWriteText(paths.project, serializeProjectConfig(normalized));
        });
        return;
      } catch (error: unknown) {
        if (!isLockContention(error)) {
          throw error;
        }
        hasContended = true;

        const completed = await readExistingProject(paths.project);
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
    const project = workspacePaths(this.projectRoot).project;
    const projectFile = await readWorkspaceText(project, "workspace project");
    if (!projectFile.exists) {
      throw new WorkspaceNotInitializedError(`workspace is not initialized: ${project}`, {
        cause: projectFile.cause,
      });
    }

    try {
      return parseProjectConfig(projectFile.contents);
    } catch (error: unknown) {
      throw new WorkspaceCorruptError(`workspace project is unreadable or corrupt: ${project}`, { cause: error });
    }
  }

  async readState(): Promise<WorkspaceState> {
    await this.readProject();
    const state = workspacePaths(this.projectRoot).state;
    const stateFile = await readWorkspaceText(state, "workspace state");
    if (!stateFile.exists) {
      throw new WorkspaceCorruptError(`workspace state is unreadable or corrupt: ${state}`, {
        cause: stateFile.cause,
      });
    }

    try {
      const value: unknown = JSON.parse(stateFile.contents);
      return parseWorkspaceState(value);
    } catch (error: unknown) {
      throw new WorkspaceCorruptError(`workspace state is unreadable or corrupt: ${state}`, { cause: error });
    }
  }
}
