import type { Stats } from "node:fs";

export type BoundedFileReadErrorCode =
  | "BOUNDED_FILE_INVALID"
  | "BOUNDED_FILE_CHANGED";

const MESSAGES: Readonly<Record<BoundedFileReadErrorCode, string>> = Object.freeze({
  BOUNDED_FILE_INVALID: "Bounded file read input is invalid",
  BOUNDED_FILE_CHANGED: "Bounded file changed during read",
});

export class BoundedFileReadError extends Error {
  override readonly name = "BoundedFileReadError";

  constructor(readonly code: BoundedFileReadErrorCode) {
    super(MESSAGES[code]);
  }
}

export interface BoundedReadableFileHandle {
  readonly stat: () => Promise<Stats>;
  readonly read: (
    buffer: Buffer,
    offset: number,
    length: number,
    position: number,
  ) => Promise<{ readonly bytesRead: number; readonly buffer: Buffer }>;
}

function fail(code: BoundedFileReadErrorCode): never {
  throw new BoundedFileReadError(code);
}

function sameOpenedFile(left: Stats, right: Stats): boolean {
  return left.isFile()
    && right.isFile()
    && left.dev === right.dev
    && left.ino === right.ino
    && left.size === right.size
    && left.mtimeMs === right.mtimeMs
    && left.ctimeMs === right.ctimeMs;
}

/**
 * Reads exactly the already-attested file size into one bounded buffer, then
 * probes one byte past that size. A zero-length early read detects shrinkage;
 * a successful probe detects growth without ever allocating above the limit.
 */
export async function readBoundedFileHandle(
  handle: BoundedReadableFileHandle,
  expected: Stats,
  maximumBytes: number,
): Promise<Buffer> {
  if (!Number.isSafeInteger(maximumBytes)
    || maximumBytes < 1
    || !expected.isFile()
    || !Number.isSafeInteger(expected.size)
    || expected.size < 1
    || expected.size > maximumBytes) {
    fail("BOUNDED_FILE_INVALID");
  }

  try {
    const openedBefore = await handle.stat();
    if (!sameOpenedFile(expected, openedBefore)) fail("BOUNDED_FILE_CHANGED");

    const bytes = Buffer.alloc(expected.size);
    let offset = 0;
    while (offset < expected.size) {
      const requested = expected.size - offset;
      const result = await handle.read(bytes, offset, requested, offset);
      if (!Number.isSafeInteger(result.bytesRead)
        || result.bytesRead < 0
        || result.bytesRead > requested) {
        fail("BOUNDED_FILE_INVALID");
      }
      if (result.bytesRead === 0) fail("BOUNDED_FILE_CHANGED");
      offset += result.bytesRead;
    }

    const probe = Buffer.alloc(1);
    const probeResult = await handle.read(probe, 0, 1, expected.size);
    if (!Number.isSafeInteger(probeResult.bytesRead)
      || probeResult.bytesRead < 0
      || probeResult.bytesRead > 1) {
      fail("BOUNDED_FILE_INVALID");
    }
    if (probeResult.bytesRead !== 0) fail("BOUNDED_FILE_CHANGED");

    const openedAfter = await handle.stat();
    if (!sameOpenedFile(openedBefore, openedAfter)) fail("BOUNDED_FILE_CHANGED");
    return bytes;
  } catch (error: unknown) {
    if (error instanceof BoundedFileReadError) throw error;
    fail("BOUNDED_FILE_INVALID");
  }
}
