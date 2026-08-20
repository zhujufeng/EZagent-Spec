import { mkdir, readFile } from "node:fs/promises";
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

function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === "ENOENT";
}

function isLockContention(error: unknown): error is WorkspaceLockedError {
  return error instanceof WorkspaceLockedError && error.message === "Workspace is locked";
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

async function readExistingProject(path: string): Promise<ProjectConfig | undefined> {
  let contents: string;
  try {
    contents = await readFile(path, "utf8");
  } catch (error: unknown) {
    if (isMissing(error)) {
      return undefined;
    }
    throw new WorkspaceCorruptError(`workspace project is unreadable or corrupt: ${path}`, { cause: error });
  }

  try {
    return parseProjectConfig(contents);
  } catch (error: unknown) {
    throw new WorkspaceCorruptError(`workspace project is unreadable or corrupt: ${path}`, { cause: error });
  }
}

export class WorkspaceRepository {
  constructor(readonly projectRoot: string) {}

  async initialize(config: ProjectConfig): Promise<void> {
    const normalized = normalizeProjectConfig(config);
    const paths = workspacePaths(this.projectRoot);
    let retryDelay = INITIALIZE_LOCK_RETRY_INITIAL_MS;

    for (;;) {
      try {
        await withWorkspaceLock(this.projectRoot, async () => {
          const existing = await readExistingProject(paths.project);
          if (existing !== undefined) {
            assertSameProjectConfig(existing, normalized);
            return;
          }

          for (const directory of WORKSPACE_DIRECTORIES) {
            await mkdir(join(paths.root, directory), { recursive: true });
          }
          await atomicWriteText(paths.state, `${JSON.stringify(INITIAL_STATE, null, 2)}\n`);
          await atomicWriteText(paths.audit, "");
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
        await delay(retryDelay);
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
