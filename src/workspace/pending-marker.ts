import { randomUUID } from "node:crypto";
import { link, readFile, rename, rm } from "node:fs/promises";
import { dirname, join } from "node:path";

import {
  boundedStatSize,
  exactInteger,
  lstatBigint,
  openBigint,
  stableFileIdentity,
  statMtimeNanoseconds,
  type PortableStats,
} from "../filesystem/stats.js";
import { WorkspaceCorruptError } from "./errors.js";
import { hashBytes, parsePendingMutation, type PendingMutation } from "./mutation.js";

const MAX_PENDING_MARKER_BYTES = 1024 * 1024;

interface PendingFingerprint {
  readonly dev: bigint;
  readonly ino: bigint;
  readonly nlink: bigint;
  readonly size: number;
  readonly mtimeNs: bigint;
  readonly contentHash: string;
}

type PendingFileSnapshot = Omit<PendingFingerprint, "contentHash">;

export interface PendingMarkerObservation {
  readonly marker: PendingMutation;
  readonly fingerprint: PendingFingerprint;
}

export interface PendingMarkerFileHandle {
  readonly writeFile: (contents: string, encoding: "utf8") => Promise<void>;
  readonly sync: () => Promise<void>;
  readonly close: () => Promise<void>;
  readonly stat: () => Promise<PortableStats>;
}

export interface PendingMarkerRuntime {
  readonly lstat: (path: string) => Promise<PortableStats>;
  readonly readFile: (path: string) => Promise<Buffer>;
  readonly rename: (source: string, destination: string) => Promise<void>;
  readonly link: (existingPath: string, newPath: string) => Promise<void>;
  readonly rm: (path: string, options: { readonly force: true }) => Promise<void>;
  readonly open: (path: string, flags: "wx", mode: number) => Promise<PendingMarkerFileHandle>;
  readonly randomUUID: () => string;
  readonly pid: number;
}

function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === "ENOENT";
}

function stableUniqueFile(
  path: string,
  observed: PortableStats,
  expectedLinks: 1n | 2n = 1n,
): PendingFileSnapshot {
  const identity = stableFileIdentity(observed);
  const nlink = exactInteger(observed.nlink);
  const size = boundedStatSize(observed, MAX_PENDING_MARKER_BYTES);
  const mtimeNs = statMtimeNanoseconds(observed);
  if (
    !observed.isFile()
    || identity === undefined
    || nlink !== expectedLinks
    || size === undefined
    || mtimeNs === undefined
  ) {
    throw new WorkspaceCorruptError(`pending mutation requires unique stable file identity: ${path}`, {
      cause: new Error("pending marker must be a bounded regular file with nlink=1 and stable dev/ino"),
    });
  }
  return { ...identity, nlink, size, mtimeNs };
}

function sameFingerprint(left: PendingFingerprint, right: PendingFingerprint): boolean {
  return left.dev === right.dev
    && left.ino === right.ino
    && left.nlink === 1n
    && right.nlink === 1n
    && left.size === right.size
    && left.mtimeNs === right.mtimeNs
    && left.contentHash === right.contentHash;
}

function sameObservation(left: PendingMarkerObservation, right: PendingMarkerObservation): boolean {
  return left.marker.token === right.marker.token && sameFingerprint(left.fingerprint, right.fingerprint);
}

function sameFileIdentity(left: PortableStats, right: PortableStats): boolean {
  const leftIdentity = stableFileIdentity(left);
  const rightIdentity = stableFileIdentity(right);
  return leftIdentity !== undefined
    && rightIdentity !== undefined
    && leftIdentity.dev === rightIdentity.dev
    && leftIdentity.ino === rightIdentity.ino;
}

function conflictError(canonical: string, quarantine: string, cause: unknown): WorkspaceCorruptError {
  return new WorkspaceCorruptError(
    `pending mutation ownership conflict; canonical ${canonical}; quarantine ${quarantine}`,
    { cause },
  );
}

export function createPendingMarkerStore(runtime: PendingMarkerRuntime) {
  async function observe(path: string): Promise<PendingMarkerObservation | undefined> {
    let before: PortableStats;
    try {
      before = await runtime.lstat(path);
    } catch (error: unknown) {
      if (isMissing(error)) return undefined;
      throw new WorkspaceCorruptError(`pending mutation boundary is unreadable: ${path}`, { cause: error });
    }
    const beforeSnapshot = stableUniqueFile(path, before);

    let bytes: Buffer;
    try {
      bytes = await runtime.readFile(path);
    } catch (error: unknown) {
      throw new WorkspaceCorruptError(`pending mutation is unreadable: ${path}`, { cause: error });
    }

    let after: PortableStats;
    try {
      after = await runtime.lstat(path);
    } catch (error: unknown) {
      throw new WorkspaceCorruptError(`pending mutation identity changed while reading: ${path}`, { cause: error });
    }
    const afterSnapshot = stableUniqueFile(path, after);
    if (
      beforeSnapshot.dev !== afterSnapshot.dev
      || beforeSnapshot.ino !== afterSnapshot.ino
      || beforeSnapshot.size !== afterSnapshot.size
      || beforeSnapshot.mtimeNs !== afterSnapshot.mtimeNs
      || bytes.byteLength !== afterSnapshot.size
    ) {
      throw new WorkspaceCorruptError(`pending mutation identity changed while reading: ${path}`, {
        cause: new Error("pending marker pre/post read identity differs"),
      });
    }

    let contents: string;
    try {
      contents = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch (error: unknown) {
      throw new WorkspaceCorruptError(`pending mutation has invalid UTF-8: ${path}`, { cause: error });
    }
    let marker: PendingMutation;
    try {
      marker = parsePendingMutation(JSON.parse(contents) as unknown);
    } catch (error: unknown) {
      throw new WorkspaceCorruptError(`pending mutation is unreadable or corrupt: ${path}`, { cause: error });
    }
    return {
      marker,
      fingerprint: { ...afterSnapshot, contentHash: hashBytes(bytes) },
    };
  }

  async function removeOwnedStage(stage: string, expected: PendingMarkerObservation): Promise<void> {
    const current = await observe(stage);
    if (current === undefined || !sameObservation(current, expected)) {
      throw conflictError(stage, stage, new Error("pending marker stage ownership was lost before cleanup"));
    }
    const cleanup = join(dirname(stage), `.${runtime.pid}.${runtime.randomUUID()}.pending-stage-cleanup`);
    try {
      await runtime.rename(stage, cleanup);
    } catch (error: unknown) {
      throw conflictError(stage, cleanup, error);
    }
    const quarantined = await observe(cleanup);
    if (quarantined === undefined || !sameObservation(quarantined, expected)) {
      throw conflictError(stage, cleanup, new Error("pending marker cleanup stage identity changed"));
    }
    await runtime.rm(cleanup, { force: true });
  }

  async function cleanupUnpublishedStage(stage: string, expected: PortableStats): Promise<void> {
    const cleanup = join(dirname(stage), `.${runtime.pid}.${runtime.randomUUID()}.pending-stage-cleanup`);
    await runtime.rename(stage, cleanup);
    const quarantined = await runtime.lstat(cleanup);
    if (!quarantined.isFile() || exactInteger(quarantined.nlink) !== 1n || !sameFileIdentity(quarantined, expected)) {
      throw conflictError(stage, cleanup, new Error("pending marker stage ownership changed during cleanup"));
    }
    await runtime.rm(cleanup, { force: true });
  }

  async function publish(path: string, rawMarker: PendingMutation): Promise<PendingMarkerObservation> {
    const marker = parsePendingMutation(rawMarker);
    const contents = `${JSON.stringify(marker, null, 2)}\n`;
    const contentsBytes = Buffer.from(contents, "utf8");
    if (contentsBytes.byteLength > MAX_PENDING_MARKER_BYTES) {
      throw new TypeError(`pending mutation exceeds size limit: ${path}`);
    }
    const stage = join(dirname(path), `.${runtime.pid}.${runtime.randomUUID()}.pending-stage`);
    let handle: PendingMarkerFileHandle | undefined;
    let owned: PortableStats | undefined;
    let opened: PortableStats | undefined;
    let openedSnapshot: PendingFileSnapshot | undefined;
    let failure: unknown;
    try {
      handle = await runtime.open(stage, "wx", 0o600);
      owned = await handle.stat();
      stableUniqueFile(stage, owned);
      await handle.writeFile(contents, "utf8");
      await handle.sync();
      opened = await handle.stat();
      openedSnapshot = stableUniqueFile(stage, opened);
      if (openedSnapshot.size !== contentsBytes.byteLength) {
        throw new WorkspaceCorruptError(`pending marker stage was not durably written: ${stage}`, {
          cause: new Error("pending marker stage size differs from serialized bytes"),
        });
      }
    } catch (error: unknown) {
      failure = error;
    }
    if (handle !== undefined) {
      try {
        await handle.close();
      } catch (error: unknown) {
        failure ??= error;
      }
    }
    if (failure !== undefined || opened === undefined || openedSnapshot === undefined) {
      if (owned !== undefined) {
        try {
          await cleanupUnpublishedStage(stage, owned);
        } catch {
          // Preserve the operation/close failure; uncertain stage evidence remains fail-closed.
        }
      }
      throw failure ?? new WorkspaceCorruptError(`pending marker stage identity is unavailable: ${stage}`);
    }

    const staged = await observe(stage);
    const expected: PendingMarkerObservation = {
      marker,
      fingerprint: { ...openedSnapshot, contentHash: hashBytes(contentsBytes) },
    };
    if (staged === undefined || !sameObservation(staged, expected)) {
      throw conflictError(path, stage, new Error("pending marker stage identity changed before publication"));
    }

    try {
      await runtime.link(stage, path);
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") {
        try {
          await removeOwnedStage(stage, staged);
        } catch {
          // Preserve the exclusive-publication conflict as the primary error;
          // uncertain stage/quarantine evidence remains for inspection.
        }
        throw conflictError(path, stage, error);
      }
      try {
        await removeOwnedStage(stage, staged);
      } catch {
        // Preserve the publication error; uncertain stage evidence remains for recovery.
      }
      throw conflictError(path, stage, error);
    }

    // Rename the linked stage to a second unique quarantine before unlinking it.
    // If either path changes, retain both paths as recovery evidence.
    const publishedQuarantine = join(
      dirname(stage),
      `.${runtime.pid}.${runtime.randomUUID()}.pending-stage-published`,
    );
    try {
      await runtime.rename(stage, publishedQuarantine);
    } catch (error: unknown) {
      throw conflictError(path, publishedQuarantine, error);
    }
    let linkedStage: PortableStats;
    let linkedCanonical: PortableStats;
    try {
      [linkedStage, linkedCanonical] = await Promise.all([
        runtime.lstat(publishedQuarantine),
        runtime.lstat(path),
      ]);
    } catch (error: unknown) {
      throw conflictError(path, publishedQuarantine, error);
    }
    const linkedStageSnapshot = stableUniqueFile(publishedQuarantine, linkedStage, 2n);
    const linkedCanonicalSnapshot = stableUniqueFile(path, linkedCanonical, 2n);
    if (
      !linkedStage.isFile()
      || !linkedCanonical.isFile()
      || linkedStageSnapshot.dev !== openedSnapshot.dev
      || linkedStageSnapshot.ino !== openedSnapshot.ino
      || linkedCanonicalSnapshot.dev !== openedSnapshot.dev
      || linkedCanonicalSnapshot.ino !== openedSnapshot.ino
      || exactInteger(linkedStage.nlink) !== 2n
      || exactInteger(linkedCanonical.nlink) !== 2n
      || linkedStageSnapshot.size !== openedSnapshot.size
      || linkedCanonicalSnapshot.size !== openedSnapshot.size
      || linkedStageSnapshot.mtimeNs !== openedSnapshot.mtimeNs
      || linkedCanonicalSnapshot.mtimeNs !== openedSnapshot.mtimeNs
    ) {
      throw conflictError(path, publishedQuarantine, new Error("published pending marker identity changed"));
    }
    try {
      await runtime.rm(publishedQuarantine, { force: true });
    } catch (error: unknown) {
      throw conflictError(path, publishedQuarantine, error);
    }
    const published = await observe(path);
    if (published === undefined || !sameObservation(published, expected)) {
      throw conflictError(path, publishedQuarantine, new Error("canonical pending marker differs from published stage"));
    }
    return published;
  }

  async function retainConflict(canonical: string, quarantine: string, cause: unknown): Promise<never> {
    let restoreCause = cause;
    try {
      await runtime.link(quarantine, canonical);
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") restoreCause = error;
    }
    throw conflictError(canonical, quarantine, restoreCause);
  }

  async function removeOwned(path: string, expected: PendingMarkerObservation): Promise<void> {
    const current = await observe(path);
    if (current === undefined || !sameObservation(current, expected)) {
      throw new WorkspaceCorruptError(`pending mutation ownership was lost before cleanup: ${path}`, {
        cause: new Error("canonical pending marker no longer matches the observed marker"),
      });
    }

    const quarantine = join(
      dirname(path),
      `.${runtime.pid}.${runtime.randomUUID()}.pending-cleanup`,
    );
    try {
      await runtime.rename(path, quarantine);
    } catch (error: unknown) {
      throw conflictError(path, quarantine, error);
    }

    let quarantined: PendingMarkerObservation | undefined;
    try {
      quarantined = await observe(quarantine);
    } catch (error: unknown) {
      await retainConflict(path, quarantine, error);
    }
    if (quarantined === undefined || !sameObservation(quarantined, expected)) {
      await retainConflict(
        path,
        quarantine,
        new Error("quarantined pending marker does not match the observed marker"),
      );
    }

    let canonicalReplacement: PendingMarkerObservation | undefined;
    try {
      canonicalReplacement = await observe(path);
    } catch (error: unknown) {
      await retainConflict(path, quarantine, error);
    }
    if (canonicalReplacement !== undefined) {
      await retainConflict(
        path,
        quarantine,
        new Error("canonical pending marker appeared while cleanup retained the original in quarantine"),
      );
    }

    try {
      await runtime.rm(quarantine, { force: true });
    } catch (error: unknown) {
      await retainConflict(path, quarantine, error);
    }
  }

  return { publishPendingMarker: publish, readPendingMarker: observe, removePendingMarker: removeOwned };
}

export const nodePendingMarkerStore = createPendingMarkerStore({
  lstat: lstatBigint,
  readFile,
  rename,
  link,
  rm,
  open: openBigint,
  randomUUID,
  pid: process.pid,
});
