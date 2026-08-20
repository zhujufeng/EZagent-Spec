import { lstat, mkdir, readFile } from "node:fs/promises";
import { performance } from "node:perf_hooks";
import { setTimeout as delay } from "node:timers/promises";
import { join } from "node:path";

import { atomicWriteText } from "./atomic-write.js";
import {
  WorkspaceCorruptError,
  WorkspaceLockedError,
  WorkspaceNotInitializedError,
} from "./errors.js";
import { WORKSPACE_DIRECTORIES, workspacePaths } from "./layout.js";
import { withWorkspaceLock } from "./lock.js";
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

async function readOptionalText(path: string, label: string): Promise<string | undefined> {
  try {
    await lstat(path);
  } catch (error: unknown) {
    if (isMissing(error)) {
      return undefined;
    }
    throw new WorkspaceCorruptError(`${label} is unreadable or corrupt: ${path}`, { cause: error });
  }

  try {
    return await readFile(path, "utf8");
  } catch (error: unknown) {
    throw new WorkspaceCorruptError(`${label} is unreadable or corrupt: ${path}`, { cause: error });
  }
}

async function readExistingProject(path: string): Promise<ProjectConfig | undefined> {
  const contents = await readOptionalText(path, "workspace project");
  if (contents === undefined) {
    return undefined;
  }

  try {
    return parseProjectConfig(contents);
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
  const contents = await readOptionalText(path, "workspace state");
  if (contents === undefined) {
    return false;
  }

  let state: WorkspaceState;
  try {
    const value: unknown = JSON.parse(contents);
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
  const contents = await readOptionalText(path, "workspace audit");
  if (contents === undefined) {
    return false;
  }
  if (contents !== "") {
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
    const startedAt = performance.now();
    let retryDelay = INITIALIZE_LOCK_RETRY_INITIAL_MS;

    for (;;) {
      normalizedOptions.signal?.throwIfAborted();
      try {
        await withWorkspaceLock(this.projectRoot, async () => {
          const existing = await readExistingProject(paths.project);
          if (existing !== undefined) {
            assertSameProjectConfig(existing, normalized);
            return;
          }

          const stateExists = await inspectInitialState(paths.state);
          const auditExists = await inspectEmptyAudit(paths.audit);
          for (const directory of WORKSPACE_DIRECTORIES) {
            await mkdir(join(paths.root, directory), { recursive: true });
          }
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

        const completed = await readExistingProject(paths.project);
        if (completed !== undefined) {
          assertSameProjectConfig(completed, normalized);
          return;
        }
        normalizedOptions.signal?.throwIfAborted();
        const remaining = normalizedOptions.timeoutMs - (performance.now() - startedAt);
        if (remaining <= 0) {
          throw lockWaitTimeout(paths.lock, normalizedOptions.timeoutMs);
        }
        const wait = Math.min(retryDelay, remaining);
        if (normalizedOptions.signal === undefined) {
          await delay(wait);
        } else {
          await delay(wait, undefined, { signal: normalizedOptions.signal });
        }
        retryDelay = Math.min(retryDelay * 2, INITIALIZE_LOCK_RETRY_MAX_MS);
      }
    }
  }

  async readProject(): Promise<ProjectConfig> {
    const project = workspacePaths(this.projectRoot).project;
    let contents: string;
    try {
      contents = await readFile(project, "utf8");
    } catch (error: unknown) {
      if (isMissing(error)) {
        throw new WorkspaceNotInitializedError(`workspace is not initialized: ${project}`, { cause: error });
      }
      throw new WorkspaceCorruptError(`workspace project is unreadable or corrupt: ${project}`, { cause: error });
    }

    try {
      return parseProjectConfig(contents);
    } catch (error: unknown) {
      throw new WorkspaceCorruptError(`workspace project is unreadable or corrupt: ${project}`, { cause: error });
    }
  }

  async readState(): Promise<WorkspaceState> {
    await this.readProject();
    const state = workspacePaths(this.projectRoot).state;
    let contents: string;
    try {
      contents = await readFile(state, "utf8");
    } catch (error: unknown) {
      throw new WorkspaceCorruptError(`workspace state is unreadable or corrupt: ${state}`, { cause: error });
    }

    try {
      const value: unknown = JSON.parse(contents);
      return parseWorkspaceState(value);
    } catch (error: unknown) {
      throw new WorkspaceCorruptError(`workspace state is unreadable or corrupt: ${state}`, { cause: error });
    }
  }
}
