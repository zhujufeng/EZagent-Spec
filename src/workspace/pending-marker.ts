import { randomUUID } from "node:crypto";
import type { Stats } from "node:fs";
import { link, lstat, readFile, rename, rm } from "node:fs/promises";
import { dirname, join } from "node:path";

import { WorkspaceCorruptError } from "./errors.js";
import { hashBytes, parsePendingMutation, type PendingMutation } from "./mutation.js";

const MAX_PENDING_MARKER_BYTES = 1024 * 1024;

interface PendingFingerprint {
  readonly dev: number;
  readonly ino: number;
  readonly nlink: number;
  readonly size: number;
  readonly mtimeMs: number;
  readonly contentHash: string;
}

export interface PendingMarkerObservation {
  readonly marker: PendingMutation;
  readonly fingerprint: PendingFingerprint;
}

export interface PendingMarkerRuntime {
  readonly lstat: (path: string) => Promise<Stats>;
  readonly readFile: (path: string) => Promise<Buffer>;
  readonly rename: (source: string, destination: string) => Promise<void>;
  readonly link: (existingPath: string, newPath: string) => Promise<void>;
  readonly rm: (path: string, options: { readonly force: true }) => Promise<void>;
  readonly randomUUID: () => string;
  readonly pid: number;
}

function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === "ENOENT";
}

function stableUniqueFile(path: string, observed: Stats): void {
  if (
    !observed.isFile()
    || observed.nlink !== 1
    || !Number.isSafeInteger(observed.dev) || observed.dev <= 0
    || !Number.isSafeInteger(observed.ino) || observed.ino <= 0
    || !Number.isSafeInteger(observed.size) || observed.size < 0 || observed.size > MAX_PENDING_MARKER_BYTES
  ) {
    throw new WorkspaceCorruptError(`pending mutation requires unique stable file identity: ${path}`, {
      cause: new Error("pending marker must be a bounded regular file with nlink=1 and stable dev/ino"),
    });
  }
}

function sameFingerprint(left: PendingFingerprint, right: PendingFingerprint): boolean {
  return left.dev === right.dev
    && left.ino === right.ino
    && left.nlink === 1
    && right.nlink === 1
    && left.size === right.size
    && left.mtimeMs === right.mtimeMs
    && left.contentHash === right.contentHash;
}

function sameObservation(left: PendingMarkerObservation, right: PendingMarkerObservation): boolean {
  return left.marker.token === right.marker.token && sameFingerprint(left.fingerprint, right.fingerprint);
}

function conflictError(canonical: string, quarantine: string, cause: unknown): WorkspaceCorruptError {
  return new WorkspaceCorruptError(
    `pending mutation ownership conflict; canonical ${canonical}; quarantine ${quarantine}`,
    { cause },
  );
}

export function createPendingMarkerStore(runtime: PendingMarkerRuntime) {
  async function observe(path: string): Promise<PendingMarkerObservation | undefined> {
    let before: Stats;
    try {
      before = await runtime.lstat(path);
    } catch (error: unknown) {
      if (isMissing(error)) return undefined;
      throw new WorkspaceCorruptError(`pending mutation boundary is unreadable: ${path}`, { cause: error });
    }
    stableUniqueFile(path, before);

    let bytes: Buffer;
    try {
      bytes = await runtime.readFile(path);
    } catch (error: unknown) {
      throw new WorkspaceCorruptError(`pending mutation is unreadable: ${path}`, { cause: error });
    }

    let after: Stats;
    try {
      after = await runtime.lstat(path);
    } catch (error: unknown) {
      throw new WorkspaceCorruptError(`pending mutation identity changed while reading: ${path}`, { cause: error });
    }
    stableUniqueFile(path, after);
    if (
      before.dev !== after.dev
      || before.ino !== after.ino
      || before.size !== after.size
      || before.mtimeMs !== after.mtimeMs
      || bytes.byteLength !== after.size
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
      fingerprint: {
        dev: after.dev,
        ino: after.ino,
        nlink: after.nlink,
        size: after.size,
        mtimeMs: after.mtimeMs,
        contentHash: hashBytes(bytes),
      },
    };
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

    try {
      await runtime.rm(quarantine, { force: true });
    } catch (error: unknown) {
      await retainConflict(path, quarantine, error);
    }
  }

  return { readPendingMarker: observe, removePendingMarker: removeOwned };
}

export const nodePendingMarkerStore = createPendingMarkerStore({
  lstat,
  readFile,
  rename,
  link,
  rm,
  randomUUID,
  pid: process.pid,
});
