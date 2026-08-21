import { constants, type Stats } from "node:fs";

const UNSUPPORTED_DIRECTORY_SYNC = new Set([
  "EACCES",
  "EBADF",
  "EINVAL",
  "EISDIR",
  "ENOTSUP",
  "EPERM",
]);

export interface FileIdentity {
  // Node Stats currently exposes number-valued dev/ino in both injected adapters.
  // Task 7 must validate this identity contract on Windows before support is declared;
  // migrate to bigint stats there if number precision or uniqueness is not stable.
  readonly dev: number;
  readonly ino: number;
  readonly mode: number;
  readonly nlink: number;
  readonly size: number;
}

export interface SafeFsFileHandle {
  readonly stat: () => Promise<Stats>;
  readonly read: (
    buffer: Buffer,
    offset: number,
    length: number,
    position: number | null,
  ) => Promise<{ readonly bytesRead: number }>;
  readonly sync: () => Promise<void>;
  readonly close: () => Promise<void>;
}

export interface SafeFsRuntime<Handle extends SafeFsFileHandle = SafeFsFileHandle> {
  readonly lstat: (path: string) => Promise<Stats>;
  readonly open: (path: string, flags: string | number, mode?: number) => Promise<Handle>;
}

export interface BoundedReadPolicy {
  readonly maximumBytes: number;
  readonly invalidMessage: string;
  readonly changedMessage: string;
  readonly exceedsMessage: string;
  readonly mapOpenError?: (error: unknown) => unknown;
}

export interface BoundedReadResult {
  readonly bytes: Buffer;
  readonly identity: FileIdentity;
}

export function identity(stat: Stats): FileIdentity {
  return {
    dev: stat.dev,
    ino: stat.ino,
    mode: stat.mode,
    nlink: stat.nlink,
    size: stat.size,
  };
}

export function sameNode(left: FileIdentity, right: FileIdentity): boolean {
  return left.dev === right.dev && left.ino === right.ino && left.mode === right.mode;
}

export function sameFile(left: FileIdentity, right: FileIdentity): boolean {
  return sameNode(left, right) && left.nlink === right.nlink && left.size === right.size;
}

export async function observedLstat(
  runtime: Pick<SafeFsRuntime, "lstat">,
  path: string,
): Promise<Stats | undefined> {
  try {
    return await runtime.lstat(path);
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

export function assertRealDirectory(stat: Stats, label: string): void {
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error(`${label} must be a real directory`);
  }
}

export function assertBoundedRegularFile(stat: Stats, policy: BoundedReadPolicy): void {
  if (
    !stat.isFile()
    || stat.isSymbolicLink()
    || stat.nlink !== 1
    || stat.size < 0
    || stat.size > policy.maximumBytes
  ) {
    throw new Error(policy.invalidMessage);
  }
}

export function noFollowReadFlags(writable = false): number {
  const noFollow = "O_NOFOLLOW" in constants ? constants.O_NOFOLLOW : 0;
  return (writable ? constants.O_RDWR : constants.O_RDONLY) | noFollow;
}

export async function readHandleBounded(
  handle: SafeFsFileHandle,
  policy: BoundedReadPolicy,
  expected?: FileIdentity,
): Promise<BoundedReadResult> {
  const before = await handle.stat();
  assertBoundedRegularFile(before, policy);
  const beforeIdentity = identity(before);
  if (expected !== undefined && !sameFile(beforeIdentity, expected)) {
    throw new Error(policy.changedMessage);
  }

  const allocation = Buffer.alloc(before.size + 1);
  let length = 0;
  for (;;) {
    const result = await handle.read(allocation, length, allocation.length - length, length);
    if (result.bytesRead === 0) break;
    length += result.bytesRead;
    if (length > policy.maximumBytes) throw new Error(policy.exceedsMessage);
  }
  const after = await handle.stat();
  if (!sameFile(beforeIdentity, identity(after)) || after.size !== length) {
    throw new Error(policy.changedMessage);
  }
  return {
    bytes: Buffer.from(allocation.subarray(0, length)),
    identity: identity(after),
  };
}

export async function readNoFollowHandleBounded<Handle extends SafeFsFileHandle>(
  runtime: SafeFsRuntime<Handle>,
  path: string,
  before: Stats,
  policy: BoundedReadPolicy,
): Promise<BoundedReadResult> {
  assertBoundedRegularFile(before, policy);
  let handle: Handle;
  try {
    handle = await runtime.open(path, noFollowReadFlags());
  } catch (error: unknown) {
    throw policy.mapOpenError?.(error) ?? error;
  }
  let failure: unknown;
  try {
    return await readHandleBounded(handle, policy, identity(before));
  } catch (error: unknown) {
    failure = error;
    throw error;
  } finally {
    try {
      await handle.close();
    } catch (error: unknown) {
      if (failure === undefined) throw error;
    }
  }
}

export async function readNoFollowPathBounded<Handle extends SafeFsFileHandle>(
  runtime: SafeFsRuntime<Handle>,
  path: string,
  before: Stats,
  policy: BoundedReadPolicy,
): Promise<BoundedReadResult> {
  const result = await readNoFollowHandleBounded(runtime, path, before, policy);
  const after = await observedLstat(runtime, path);
  if (after === undefined || !sameFile(result.identity, identity(after))) {
    throw new Error(policy.changedMessage);
  }
  return result;
}

export async function assertRealDirectoryIdentity(
  runtime: Pick<SafeFsRuntime, "lstat">,
  path: string,
  expected: FileIdentity,
  label: string,
  changedMessage: string,
): Promise<void> {
  const current = await runtime.lstat(path);
  assertRealDirectory(current, label);
  if (!sameNode(identity(current), expected)) throw new Error(changedMessage);
}

export function chargeByteBudget(
  budget: { bytes: number },
  amount: number,
  maximumBytes: number,
  errorMessage: string,
): void {
  if (
    !Number.isSafeInteger(budget.bytes)
    || budget.bytes < 0
    || !Number.isSafeInteger(amount)
    || amount < 0
    || !Number.isSafeInteger(maximumBytes)
    || maximumBytes < 0
    || amount > maximumBytes - budget.bytes
  ) {
    throw new Error(errorMessage);
  }
  budget.bytes += amount;
}

export async function syncDirectoryBestEffort<Handle extends SafeFsFileHandle>(
  runtime: SafeFsRuntime<Handle>,
  path: string,
  identityChecks: {
    readonly before?: () => Promise<void>;
    readonly after?: () => Promise<void>;
  } = {},
): Promise<void> {
  let hasFailure = false;
  let firstFailure: unknown;
  const recordFailure = (error: unknown): void => {
    if (hasFailure) return;
    hasFailure = true;
    firstFailure = error;
  };
  let handle: Handle | undefined;
  try {
    try {
      await identityChecks.before?.();
    } catch (error: unknown) {
      recordFailure(error);
    }
    if (!hasFailure) {
      try {
        handle = await runtime.open(path, constants.O_RDONLY);
        await handle.sync();
      } catch (error: unknown) {
        const code = (error as NodeJS.ErrnoException | null | undefined)?.code ?? "";
        if (!UNSUPPORTED_DIRECTORY_SYNC.has(code)) recordFailure(error);
      }
    }
  } finally {
    if (handle !== undefined) {
      try {
        await handle.close();
      } catch (error: unknown) {
        recordFailure(error);
      }
    }
    try {
      await identityChecks.after?.();
    } catch (error: unknown) {
      recordFailure(error);
    }
  }
  if (hasFailure) throw firstFailure;
}
