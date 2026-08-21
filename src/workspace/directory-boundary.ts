import { mkdir } from "node:fs/promises";
import { join } from "node:path";

import { lstatBigint, type PortableStats } from "../filesystem/stats.js";
import { WorkspaceCorruptError } from "./errors.js";

export interface WorkspaceDirectoryRuntime {
  readonly lstat: (path: string) => Promise<PortableStats>;
  readonly mkdir: (path: string) => Promise<void>;
}

function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === "ENOENT";
}

function invalidDirectory(path: string): WorkspaceCorruptError {
  const cause = new Error("expected real workspace directory");
  return new WorkspaceCorruptError(`workspace directory boundary is invalid: ${path}`, { cause });
}

async function observeDirectory(runtime: WorkspaceDirectoryRuntime, path: string): Promise<PortableStats | undefined> {
  try {
    return await runtime.lstat(path);
  } catch (error: unknown) {
    if (isMissing(error)) {
      return undefined;
    }
    throw new WorkspaceCorruptError(`workspace directory boundary is unreadable: ${path}`, { cause: error });
  }
}

async function ensureRealDirectory(runtime: WorkspaceDirectoryRuntime, path: string): Promise<void> {
  let observed = await observeDirectory(runtime, path);
  if (observed === undefined) {
    try {
      await runtime.mkdir(path);
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
        throw new WorkspaceCorruptError(`workspace directory boundary could not be created: ${path}`, {
          cause: error,
        });
      }
    }
    observed = await observeDirectory(runtime, path);
  }
  if (observed === undefined || !observed.isDirectory()) {
    throw invalidDirectory(path);
  }
}

function components(relativeDirectory: string): readonly string[] {
  const parts = relativeDirectory.split(/[\\/]+/);
  if (parts.some((component) => component === "" || component === "." || component === "..")) {
    throw new Error(`invalid reserved workspace directory: ${relativeDirectory}`);
  }
  return parts;
}

async function validateExistingDirectory(runtime: WorkspaceDirectoryRuntime, path: string): Promise<boolean> {
  const observed = await observeDirectory(runtime, path);
  if (observed === undefined) {
    return false;
  }
  if (!observed.isDirectory()) {
    throw invalidDirectory(path);
  }
  return true;
}

export async function validateExistingWorkspaceDirectoryChains(
  runtime: WorkspaceDirectoryRuntime,
  workspaceRoot: string,
  relativeDirectories: readonly string[],
): Promise<void> {
  const existence = new Map<string, boolean>();
  existence.set(workspaceRoot, await validateExistingDirectory(runtime, workspaceRoot));

  for (const relativeDirectory of relativeDirectories) {
    let current = workspaceRoot;
    let parentExists = existence.get(workspaceRoot)!;
    for (const component of components(relativeDirectory)) {
      current = join(current, component);
      const cached = existence.get(current);
      if (cached !== undefined) {
        parentExists = cached;
      } else if (!parentExists) {
        existence.set(current, false);
      } else {
        parentExists = await validateExistingDirectory(runtime, current);
        existence.set(current, parentExists);
      }
    }
  }
}

export async function ensureWorkspaceDirectoryChains(
  runtime: WorkspaceDirectoryRuntime,
  workspaceRoot: string,
  relativeDirectories: readonly string[],
): Promise<void> {
  // Each creation is revalidated, but callers assume no adversarial replacement after this function returns.
  const ensured = new Set<string>();

  await ensureRealDirectory(runtime, workspaceRoot);
  ensured.add(workspaceRoot);

  for (const relativeDirectory of relativeDirectories) {
    let current = workspaceRoot;
    for (const component of components(relativeDirectory)) {
      current = join(current, component);
      if (!ensured.has(current)) {
        await ensureRealDirectory(runtime, current);
        ensured.add(current);
      }
    }
  }
}

export const nodeWorkspaceDirectoryRuntime: WorkspaceDirectoryRuntime = {
  lstat: lstatBigint,
  mkdir: async (path) => { await mkdir(path); },
};
