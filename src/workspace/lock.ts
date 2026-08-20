import { mkdir, open, readFile, rm, stat } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import type { Stats } from "node:fs";
import { dirname } from "node:path";

import { WorkspaceLockedError } from "./errors.js";
import { workspacePaths } from "./layout.js";

const STALE_LOCK_MS = 30_000;
const MAX_ACQUISITION_ATTEMPTS = 3;

interface LockMetadata {
  readonly token: string;
  readonly pid: number;
  readonly createdAt: string;
}

interface FileFingerprint {
  readonly dev: number;
  readonly ino: number;
  readonly size: number;
  readonly mtimeMs: number;
  readonly ctimeMs: number;
}

function parseLockMetadata(contents: string): LockMetadata | undefined {
  try {
    const parsed: unknown = JSON.parse(contents);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return undefined;
    }
    const value = parsed as Record<string, unknown>;
    const { token, pid, createdAt } = value;
    if (
      typeof token !== "string" || token.length === 0
      || typeof pid !== "number"
      || typeof createdAt !== "string" || Number.isNaN(Date.parse(createdAt))
    ) {
      return undefined;
    }
    return { token, pid, createdAt };
  } catch {
    return undefined;
  }
}

function fingerprint(fileStat: Stats): FileFingerprint {
  return {
    dev: fileStat.dev,
    ino: fileStat.ino,
    size: fileStat.size,
    mtimeMs: fileStat.mtimeMs,
    ctimeMs: fileStat.ctimeMs,
  };
}

function sameFingerprint(left: FileFingerprint, right: FileFingerprint): boolean {
  return left.dev === right.dev
    && left.ino === right.ino
    && left.size === right.size
    && left.mtimeMs === right.mtimeMs
    && left.ctimeMs === right.ctimeMs;
}

function ownerIsAlive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) {
    return false;
  }

  try {
    process.kill(pid, 0);
    return true;
  } catch (error: unknown) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

async function readMetadata(lock: string): Promise<LockMetadata | undefined> {
  try {
    return parseLockMetadata(await readFile(lock, "utf8"));
  } catch {
    return undefined;
  }
}

async function releaseOwnedLock(lock: string, token: string): Promise<void> {
  const metadata = await readMetadata(lock);
  if (metadata?.token === token) {
    await rm(lock, { force: true });
  }
}

async function recoverStaleLock(lock: string): Promise<boolean> {
  let observedStat: Stats;
  try {
    observedStat = await stat(lock);
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return true;
    }
    return false;
  }

  if (Date.now() - observedStat.mtimeMs < STALE_LOCK_MS) {
    return false;
  }

  const observedFingerprint = fingerprint(observedStat);
  const metadata = await readMetadata(lock);
  if (metadata !== undefined) {
    if (ownerIsAlive(metadata.pid)) {
      return false;
    }
    const currentMetadata = await readMetadata(lock);
    if (currentMetadata?.token !== metadata.token) {
      return false;
    }
    await rm(lock, { force: true });
    return true;
  }

  try {
    if (!sameFingerprint(observedFingerprint, fingerprint(await stat(lock)))) {
      return false;
    }
    await rm(lock, { force: true });
    return true;
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return true;
    }
    return false;
  }
}

export async function withWorkspaceLock<T>(projectRoot: string, operation: () => Promise<T>): Promise<T> {
  const lock = workspacePaths(projectRoot).lock;
  await mkdir(dirname(lock), { recursive: true });

  for (let attempt = 0; attempt < MAX_ACQUISITION_ATTEMPTS; attempt += 1) {
    const token = randomUUID();
    const metadata: LockMetadata = { token, pid: process.pid, createdAt: new Date().toISOString() };
    let handle: Awaited<ReturnType<typeof open>> | undefined;

    try {
      handle = await open(lock, "wx", 0o600);
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
        throw error;
      }
      if (await recoverStaleLock(lock)) {
        continue;
      }
      throw new WorkspaceLockedError("Workspace is locked");
    }

    try {
      await handle.writeFile(JSON.stringify(metadata), "utf8");
      await handle.sync();
    } catch (error: unknown) {
      try {
        await handle.close();
      } catch {
        // Preserve the write or sync failure while still attempting to close the handle.
      }
      handle = undefined;
      await releaseOwnedLock(lock, token);
      throw error;
    }

    try {
      await handle.close();
    } catch (error: unknown) {
      handle = undefined;
      await releaseOwnedLock(lock, token);
      throw error;
    }
    handle = undefined;
    try {
      return await operation();
    } finally {
      await releaseOwnedLock(lock, token);
    }
  }

  throw new WorkspaceLockedError("Workspace is locked");
}
