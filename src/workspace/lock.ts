import { copyFile, mkdir, open, readFile, rename, rm, stat } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { constants, type Stats } from "node:fs";
import { dirname, join } from "node:path";

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
}

interface QuarantineInspection {
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
      || typeof pid !== "number" || !Number.isSafeInteger(pid) || pid <= 0
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
  };
}

function sameFingerprint(left: FileFingerprint, right: FileFingerprint): boolean {
  return left.dev === right.dev
    && left.ino === right.ino
    && left.size === right.size
    && left.mtimeMs === right.mtimeMs;
}

function sameFile(left: FileFingerprint, right: FileFingerprint): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function ownerIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error: unknown) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

function quarantinePath(lock: string): string {
  return join(dirname(lock), `.${process.pid}.${randomUUID()}.quarantine`);
}

async function moveToQuarantine(lock: string): Promise<string | undefined> {
  const quarantine = quarantinePath(lock);
  try {
    await rename(lock, quarantine);
    return quarantine;
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return undefined;
    }
    throw error;
  }
}

async function restoreQuarantine(quarantine: string, lock: string): Promise<boolean> {
  try {
    await copyFile(quarantine, lock, constants.COPYFILE_EXCL);
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      return false;
    }
    throw error;
  }
  await rm(quarantine, { force: true });
  return true;
}

async function inspectLock(path: string): Promise<QuarantineInspection | undefined> {
  try {
    const [contents, fileStat] = await Promise.all([readFile(path, "utf8"), stat(path)]);
    return { metadata: parseLockMetadata(contents), fingerprint: fingerprint(fileStat) };
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return undefined;
    }
    throw error;
  }
}

async function inspectQuarantine(quarantine: string): Promise<QuarantineInspection | undefined> {
  return inspectLock(quarantine);
}

async function discardOrRestore(
  lock: string,
  quarantine: string,
  matches: (inspection: QuarantineInspection) => boolean,
): Promise<boolean> {
  const inspection = await inspectQuarantine(quarantine);
  if (inspection !== undefined && matches(inspection)) {
    await rm(quarantine, { force: true });
    return true;
  }
  if (await restoreQuarantine(quarantine, lock)) {
    return false;
  }
  throw new WorkspaceLockedError("Workspace is locked and lock cleanup could not be completed");
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
  await discardOrRestore(lock, quarantine, (inspection) => (
    inspection.metadata?.token === token && sameFingerprint(inspection.fingerprint, expected.fingerprint)
  ));
}

async function removeFailedAcquisition(lock: string, expected: FileFingerprint): Promise<void> {
  const quarantine = await moveToQuarantine(lock);
  if (quarantine === undefined) {
    return;
  }
  await discardOrRestore(lock, quarantine, (inspection) => sameFingerprint(inspection.fingerprint, expected));
}

async function recoverStaleLock(lock: string): Promise<boolean> {
  let observed: QuarantineInspection;
  try {
    const inspection = await inspectLock(lock);
    if (inspection === undefined) {
      return true;
    }
    observed = inspection;
  } catch {
    return false;
  }

  if (Date.now() - observed.fingerprint.mtimeMs < STALE_LOCK_MS) {
    return false;
  }
  if (observed.metadata !== undefined && ownerIsAlive(observed.metadata.pid)) {
    return false;
  }

  const current = await inspectLock(lock);
  if (current === undefined) {
    return true;
  }
  if (
    !sameFingerprint(current.fingerprint, observed.fingerprint)
    || (observed.metadata !== undefined && current.metadata?.token !== observed.metadata.token)
  ) {
    return false;
  }

  const quarantine = await moveToQuarantine(lock);
  if (quarantine === undefined) {
    return true;
  }
  return discardOrRestore(lock, quarantine, (inspection) => (
    sameFingerprint(inspection.fingerprint, observed.fingerprint)
    && (observed.metadata === undefined || inspection.metadata?.token === observed.metadata.token)
  ));
}

export async function withWorkspaceLock<T>(projectRoot: string, operation: () => Promise<T>): Promise<T> {
  const lock = workspacePaths(projectRoot).lock;
  await mkdir(dirname(lock), { recursive: true });

  for (let attempt = 0; attempt < MAX_ACQUISITION_ATTEMPTS; attempt += 1) {
    const token = randomUUID();
    const metadata: LockMetadata = { token, pid: process.pid, createdAt: new Date().toISOString() };
    let handle: Awaited<ReturnType<typeof open>> | undefined;
    let acquired: FileFingerprint | undefined;

    try {
      handle = await open(lock, "wx", 0o600);
      acquired = fingerprint(await handle.stat());
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
      if (acquired !== undefined) {
        try {
          const failedStat = fingerprint(await stat(lock));
          if (sameFile(failedStat, acquired)) {
            await removeFailedAcquisition(lock, failedStat);
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
}
