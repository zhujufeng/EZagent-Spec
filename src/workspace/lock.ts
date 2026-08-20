import { copyFile, mkdir, open, readFile, rename, rm, stat } from "node:fs/promises";
import { randomUUID, createHash } from "node:crypto";
import { constants, type Stats } from "node:fs";
import { dirname, join } from "node:path";

import { WorkspaceLockedError } from "./errors.js";
import { workspacePaths } from "./layout.js";

const STALE_LOCK_MS = 30_000;
const MAX_ACQUISITION_ATTEMPTS = 3;
const MAX_PORTABLE_PID = 2_147_483_647;

type LockFileHandle = Awaited<ReturnType<typeof open>>;

export interface WorkspaceLockRuntime {
  readonly copyFile: (source: string, destination: string, mode: number) => Promise<void>;
  readonly mkdir: (path: string, options: { readonly recursive: true }) => Promise<string | undefined>;
  readonly open: (path: string, flags: string, mode?: number) => Promise<LockFileHandle>;
  readonly readFile: (path: string, encoding: "utf8") => Promise<string>;
  readonly rename: (oldPath: string, newPath: string) => Promise<void>;
  readonly rm: (path: string, options: { readonly force: true }) => Promise<void>;
  readonly stat: (path: string) => Promise<Stats>;
  readonly randomUUID: () => string;
  readonly pid: number;
  readonly kill: (pid: number) => void;
}

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
  readonly contentHash: string;
}

interface LockObservation {
  readonly metadata: LockMetadata | undefined;
  readonly fingerprint: FileFingerprint;
}

function parseLockMetadata(contents: string): LockMetadata | undefined {
  try {
    const parsed: unknown = JSON.parse(contents);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return undefined;
    }
    const { token, pid, createdAt } = parsed as Record<string, unknown>;
    if (
      typeof token !== "string" || token.length === 0
      || typeof pid !== "number" || !Number.isSafeInteger(pid) || pid <= 0 || pid > MAX_PORTABLE_PID
      || typeof createdAt !== "string" || Number.isNaN(Date.parse(createdAt))
    ) {
      return undefined;
    }
    return { token, pid, createdAt };
  } catch {
    return undefined;
  }
}

function contentHash(contents: string): string {
  return createHash("sha256").update(contents, "utf8").digest("hex");
}

function fingerprint(fileStat: Stats, contents: string): FileFingerprint {
  return {
    dev: fileStat.dev,
    ino: fileStat.ino,
    size: fileStat.size,
    mtimeMs: fileStat.mtimeMs,
    contentHash: contentHash(contents),
  };
}

function hasStableIdentity(fingerprint: FileFingerprint): boolean {
  return Number.isSafeInteger(fingerprint.dev) && fingerprint.dev > 0
    && Number.isSafeInteger(fingerprint.ino) && fingerprint.ino > 0;
}

function sameFingerprint(left: FileFingerprint, right: FileFingerprint): boolean {
  return hasStableIdentity(left) && hasStableIdentity(right)
    && left.dev === right.dev
    && left.ino === right.ino
    && left.size === right.size
    && left.mtimeMs === right.mtimeMs
    && left.contentHash === right.contentHash;
}

function sameIdentity(left: FileFingerprint, right: FileFingerprint): boolean {
  return hasStableIdentity(left) && hasStableIdentity(right)
    && left.dev === right.dev && left.ino === right.ino;
}

function sameObservation(left: LockObservation, right: LockObservation): boolean {
  if (!sameFingerprint(left.fingerprint, right.fingerprint)) {
    return false;
  }
  if (left.metadata === undefined || right.metadata === undefined) {
    return left.metadata === right.metadata;
  }
  return left.metadata.token === right.metadata.token;
}

function ownerIsAlive(runtime: WorkspaceLockRuntime, pid: number): boolean {
  try {
    runtime.kill(pid);
    return true;
  } catch (error: unknown) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

function quarantinePath(runtime: WorkspaceLockRuntime, lock: string): string {
  return join(dirname(lock), `.${runtime.pid}.${runtime.randomUUID()}.quarantine`);
}

export function createWorkspaceLock(runtime: WorkspaceLockRuntime) {
  async function inspectLock(path: string): Promise<LockObservation | undefined> {
    try {
      const contents = await runtime.readFile(path, "utf8");
      const fileStat = await runtime.stat(path);
      return { metadata: parseLockMetadata(contents), fingerprint: fingerprint(fileStat, contents) };
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return undefined;
      }
      throw error;
    }
  }

  async function moveToQuarantine(lock: string): Promise<string | undefined> {
    const quarantine = quarantinePath(runtime, lock);
    try {
      await runtime.rename(lock, quarantine);
      return quarantine;
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return undefined;
      }
      throw error;
    }
  }

  async function retainConflictingQuarantine(quarantine: string, lock: string): Promise<never> {
    const paths = `canonical ${lock}; quarantine ${quarantine}`;
    try {
      await runtime.copyFile(quarantine, lock, constants.COPYFILE_EXCL);
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") {
        throw new WorkspaceLockedError(`Workspace lock conflict; evidence retained at ${paths}`, { cause: error });
      }
      throw new WorkspaceLockedError(`Workspace lock restore failed; evidence retained at ${paths}`, { cause: error });
    }
    throw new WorkspaceLockedError(`Workspace lock conflict; evidence retained at ${paths}`);
  }

  async function discardOrRetain(
    lock: string,
    quarantine: string,
    expected: LockObservation,
  ): Promise<void> {
    const observed = await inspectLock(quarantine);
    if (observed !== undefined && sameObservation(observed, expected)) {
      await runtime.rm(quarantine, { force: true });
      return;
    }
    await retainConflictingQuarantine(quarantine, lock);
  }

  async function releaseOwnedLock(lock: string, token: string): Promise<void> {
    const expected = await inspectLock(lock);
    if (expected?.metadata?.token !== token) {
      return;
    }
    const quarantine = await moveToQuarantine(lock);
    if (quarantine === undefined) {
      return;
    }
    await discardOrRetain(lock, quarantine, expected);
  }

  async function removeFailedAcquisition(lock: string, expected: LockObservation): Promise<void> {
    const quarantine = await moveToQuarantine(lock);
    if (quarantine === undefined) {
      return;
    }
    await discardOrRetain(lock, quarantine, expected);
  }

  async function recoverStaleLock(lock: string): Promise<boolean> {
    let observed: LockObservation;
    try {
      const inspection = await inspectLock(lock);
      if (inspection === undefined) {
        return true;
      }
      observed = inspection;
    } catch {
      return false;
    }

    if (!hasStableIdentity(observed.fingerprint) || Date.now() - observed.fingerprint.mtimeMs < STALE_LOCK_MS) {
      return false;
    }
    if (observed.metadata !== undefined && ownerIsAlive(runtime, observed.metadata.pid)) {
      return false;
    }

    const current = await inspectLock(lock);
    if (current === undefined) {
      return true;
    }
    if (!sameObservation(current, observed)) {
      return false;
    }

    const quarantine = await moveToQuarantine(lock);
    if (quarantine === undefined) {
      return true;
    }
    await discardOrRetain(lock, quarantine, observed);
    return true;
  }

  return async function withWorkspaceLock<T>(projectRoot: string, operation: () => Promise<T>): Promise<T> {
    const lock = workspacePaths(projectRoot).lock;
    await runtime.mkdir(dirname(lock), { recursive: true });

    for (let attempt = 0; attempt < MAX_ACQUISITION_ATTEMPTS; attempt += 1) {
      const token = runtime.randomUUID();
      const metadata: LockMetadata = { token, pid: runtime.pid, createdAt: new Date().toISOString() };
      let handle: LockFileHandle | undefined;
      let acquiredIdentity: FileFingerprint | undefined;

      try {
        handle = await runtime.open(lock, "wx", 0o600);
        acquiredIdentity = fingerprint(await handle.stat(), "");
        await handle.writeFile(JSON.stringify(metadata), "utf8");
        await handle.sync();
        await handle.close();
        handle = undefined;
      } catch (error: unknown) {
        if ((error as NodeJS.ErrnoException).code === "EEXIST" && handle === undefined) {
          if (await recoverStaleLock(lock)) {
            continue;
          }
          throw new WorkspaceLockedError("Workspace is locked");
        }

        if (handle !== undefined) {
          try {
            await handle.close();
          } catch {
            // Preserve the acquisition failure while still attempting handle cleanup.
          }
        }
        if (acquiredIdentity !== undefined && hasStableIdentity(acquiredIdentity)) {
          try {
            const failed = await inspectLock(lock);
            if (failed !== undefined && sameIdentity(failed.fingerprint, acquiredIdentity)) {
              await removeFailedAcquisition(lock, failed);
            }
          } catch {
            // A failed cleanup must not mask the original acquisition failure.
          }
        }
        throw error;
      }

      let operationFailed = false;
      let operationFailure: unknown;
      let result: T | undefined;
      try {
        result = await operation();
      } catch (error: unknown) {
        operationFailed = true;
        operationFailure = error;
      }

      try {
        await releaseOwnedLock(lock, token);
      } catch (releaseFailure: unknown) {
        if (operationFailed) {
          throw operationFailure;
        }
        throw releaseFailure;
      }

      if (operationFailed) {
        throw operationFailure;
      }
      return result as T;
    }

    throw new WorkspaceLockedError("Workspace is locked");
  };
}

const nodeRuntime: WorkspaceLockRuntime = {
  copyFile,
  mkdir,
  open,
  readFile,
  rename,
  rm,
  stat,
  randomUUID,
  pid: process.pid,
  kill: (pid) => { process.kill(pid, 0); },
};

export const withWorkspaceLock = createWorkspaceLock(nodeRuntime);
