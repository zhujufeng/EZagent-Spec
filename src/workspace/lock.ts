import { copyFile, link, mkdir, readFile, rename, rm } from "node:fs/promises";
import { randomUUID, createHash } from "node:crypto";
import { constants } from "node:fs";
import { basename, dirname, join } from "node:path";

import {
  boundedStatSize,
  lstatBigint,
  openBigint,
  stableFileIdentity,
  statBigint,
  statMtimeMilliseconds,
  statMtimeNanoseconds,
  type PortableStats,
} from "../filesystem/stats.js";
import { WorkspaceLockedError } from "./errors.js";
import { ensureWorkspaceDirectoryChains, type WorkspaceDirectoryRuntime } from "./directory-boundary.js";
import { workspacePaths } from "./layout.js";

const STALE_LOCK_MS = 30_000;
const MAX_ACQUISITION_ATTEMPTS = 3;
const MAX_PORTABLE_PID = 2_147_483_647;

interface LockFileHandle {
  readonly writeFile: (contents: string, encoding: "utf8") => Promise<void>;
  readonly sync: () => Promise<void>;
  readonly close: () => Promise<void>;
  readonly stat: () => Promise<PortableStats>;
}

export interface WorkspaceLockRuntime extends WorkspaceDirectoryRuntime {
  readonly copyFile: (source: string, destination: string, mode: number) => Promise<void>;
  readonly link: (existingPath: string, newPath: string) => Promise<void>;
  readonly open: (path: string, flags: string, mode?: number) => Promise<LockFileHandle>;
  readonly readFile: (path: string, encoding: "utf8") => Promise<string>;
  readonly rename: (oldPath: string, newPath: string) => Promise<void>;
  readonly rm: (path: string, options: { readonly force: true }) => Promise<void>;
  readonly stat: (path: string) => Promise<PortableStats>;
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
  readonly dev: bigint | undefined;
  readonly ino: bigint | undefined;
  readonly size: number | undefined;
  readonly mtimeMs: number | undefined;
  readonly mtimeNs: bigint | undefined;
  readonly contentHash: string;
}

interface LockObservation {
  readonly metadata: LockMetadata | undefined;
  readonly fingerprint: FileFingerprint;
}

class LockPublicationCleanupError extends Error {
  readonly primaryError: unknown;
  readonly cleanupError: unknown;

  constructor(canonical: string, pending: string, primaryError: unknown, cleanupError: unknown) {
    const primary = primaryError instanceof Error ? primaryError.message : String(primaryError);
    const cleanup = cleanupError instanceof Error ? cleanupError.message : String(cleanupError);
    super(
      `Workspace lock publication failed; canonical ${canonical}; pending ${pending}; primary ${primary}; pending cleanup failed: ${cleanup}`,
      { cause: primaryError },
    );
    this.name = "LockPublicationCleanupError";
    this.primaryError = primaryError;
    this.cleanupError = cleanupError;
  }
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

function fingerprint(fileStat: PortableStats, contents: string): FileFingerprint {
  const identity = stableFileIdentity(fileStat);
  return {
    dev: identity?.dev,
    ino: identity?.ino,
    size: boundedStatSize(fileStat, Buffer.byteLength(contents, "utf8")),
    mtimeMs: statMtimeMilliseconds(fileStat),
    mtimeNs: statMtimeNanoseconds(fileStat),
    contentHash: contentHash(contents),
  };
}

function hasStableIdentity(fingerprint: FileFingerprint): boolean {
  return fingerprint.dev !== undefined
    && fingerprint.ino !== undefined
    && fingerprint.size !== undefined
    && fingerprint.mtimeNs !== undefined;
}

function sameFingerprint(left: FileFingerprint, right: FileFingerprint): boolean {
  return hasStableIdentity(left) && hasStableIdentity(right)
    && left.dev === right.dev
    && left.ino === right.ino
    && left.size === right.size
    && left.mtimeNs !== undefined
    && left.mtimeNs === right.mtimeNs
    && left.contentHash === right.contentHash;
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

  function pendingPath(lock: string): string {
    return join(dirname(lock), `.${basename(lock)}.${runtime.pid}.${runtime.randomUUID()}.pending`);
  }

  async function publishLock(lock: string, contents: string): Promise<LockObservation> {
    const pending = pendingPath(lock);
    let handle: LockFileHandle | undefined;
    let created = false;
    let cleaned = false;
    let linked = false;
    let failed = false;
    let failure: unknown;
    let published: LockObservation | undefined;

    try {
      handle = await runtime.open(pending, "wx", 0o600);
      created = true;
      await handle.writeFile(contents, "utf8");
      await handle.sync();
      const staged = fingerprint(await handle.stat(), contents);
      if (!hasStableIdentity(staged)) {
        throw new WorkspaceLockedError("Workspace lock publication requires stable file identity");
      }
      published = { metadata: parseLockMetadata(contents), fingerprint: staged };
      await handle.close();
      handle = undefined;
      await runtime.link(pending, lock);
      linked = true;
    } catch (error: unknown) {
      failed = true;
      failure = error;
    }

    let cleanupFailure: unknown;
    if (handle !== undefined) {
      try {
        await handle.close();
      } catch (error: unknown) {
        cleanupFailure = error;
      }
    }
    if (created && !cleaned) {
      try {
        await runtime.rm(pending, { force: true });
        cleaned = true;
      } catch (error: unknown) {
        cleanupFailure ??= error;
      }
    }
    if (linked) {
      if (cleanupFailure !== undefined) {
        try {
          await runtime.rm(pending, { force: true });
        } catch {
          // A pending orphan is safe evidence and must not downgrade successful publication.
        }
      }
      return published!;
    }
    if (failed) {
      if (cleanupFailure !== undefined) {
        throw new LockPublicationCleanupError(lock, pending, failure, cleanupFailure);
      }
      throw failure;
    }
    if (cleanupFailure !== undefined) {
      throw cleanupFailure;
    }
    return published!;
  }

  async function tryPublishLock(lock: string, contents: string): Promise<LockObservation | undefined> {
    try {
      return await publishLock(lock, contents);
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") {
        return undefined;
      }
      throw error;
    }
  }

  async function recoverStaleLock(lock: string, contents: string): Promise<LockObservation | undefined> {
    let observed: LockObservation;
    try {
      const inspection = await inspectLock(lock);
      if (inspection === undefined) {
        return tryPublishLock(lock, contents);
      }
      observed = inspection;
    } catch {
      return undefined;
    }

    if (
      !hasStableIdentity(observed.fingerprint)
      || observed.fingerprint.mtimeMs === undefined
      || Date.now() - observed.fingerprint.mtimeMs < STALE_LOCK_MS
    ) {
      return undefined;
    }
    if (observed.metadata !== undefined && ownerIsAlive(runtime, observed.metadata.pid)) {
      return undefined;
    }

    const current = await inspectLock(lock);
    if (current === undefined) {
      return tryPublishLock(lock, contents);
    }
    if (!sameObservation(current, observed)) {
      return undefined;
    }

    const quarantine = await moveToQuarantine(lock);
    if (quarantine === undefined) {
      return tryPublishLock(lock, contents);
    }
    const quarantined = await inspectLock(quarantine);
    if (quarantined === undefined || !sameObservation(quarantined, observed)) {
      await retainConflictingQuarantine(quarantine, lock);
    }

    const published = await tryPublishLock(lock, contents);
    if (published === undefined) {
      throw new WorkspaceLockedError(`Workspace lock recovery conflict; canonical ${lock}; quarantine ${quarantine}`);
    }
    const finalQuarantine = await inspectLock(quarantine);
    if (finalQuarantine === undefined || !sameObservation(finalQuarantine, observed)) {
      throw new WorkspaceLockedError(`Workspace lock recovery conflict; canonical ${lock}; quarantine ${quarantine}`);
    }
    try {
      await runtime.rm(quarantine, { force: true });
    } catch (error: unknown) {
      throw new WorkspaceLockedError(`Workspace stale lock cleanup failed; canonical ${lock}; quarantine ${quarantine}`, { cause: error });
    }
    return published;
  }

  return async function withWorkspaceLock<T>(projectRoot: string, operation: () => Promise<T>): Promise<T> {
    const paths = workspacePaths(projectRoot);
    await ensureWorkspaceDirectoryChains(runtime, paths.root, ["state"]);
    const lock = paths.lock;

    for (let attempt = 0; attempt < MAX_ACQUISITION_ATTEMPTS; attempt += 1) {
      const token = runtime.randomUUID();
      const metadata: LockMetadata = { token, pid: runtime.pid, createdAt: new Date().toISOString() };
      const contents = JSON.stringify(metadata);
      let published = await tryPublishLock(lock, contents);
      if (published === undefined) {
        published = await recoverStaleLock(lock, contents);
      }
      if (published === undefined) {
        throw new WorkspaceLockedError("Workspace is locked", { code: "LOCK_CONTENDED" });
      }

      let canonical: LockObservation | undefined;
      try {
        canonical = await inspectLock(lock);
      } catch (error: unknown) {
        throw new WorkspaceLockedError("Workspace lock ownership was lost before operation", { cause: error });
      }
      if (canonical === undefined || canonical.metadata?.token !== token || !sameObservation(canonical, published)) {
        throw new WorkspaceLockedError("Workspace lock ownership was lost before operation");
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

    throw new WorkspaceLockedError("Workspace is locked", { code: "LOCK_CONTENDED" });
  };
}

const nodeRuntime: WorkspaceLockRuntime = {
  copyFile,
  link,
  lstat: lstatBigint,
  mkdir: async (path) => { await mkdir(path); },
  open: openBigint,
  readFile,
  rename,
  rm,
  stat: statBigint,
  randomUUID,
  pid: process.pid,
  kill: (pid) => { process.kill(pid, 0); },
};

export const withWorkspaceLock = createWorkspaceLock(nodeRuntime);
