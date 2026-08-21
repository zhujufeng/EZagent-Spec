import { constants, type Stats } from "node:fs";
import { lstat, mkdtemp, open, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  assertBoundedRegularFile,
  assertRealDirectory,
  chargeByteBudget,
  identity,
  observedLstat,
  readHandleBounded,
  readNoFollowPathBounded,
  sameFile,
  sameNode,
  syncDirectoryBestEffort,
  type BoundedReadPolicy,
  type SafeFsFileHandle,
  type SafeFsRuntime,
} from "../../src/adapters/codex/safe-fs.js";

const roots: string[] = [];
const policy: BoundedReadPolicy = {
  maximumBytes: 1_024,
  invalidMessage: "fixture must be regular",
  changedMessage: "fixture changed",
  exceedsMessage: "fixture exceeds limit",
};

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "ezagent-safe-fs-"));
  roots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function runtime(overrides: Partial<SafeFsRuntime> = {}): SafeFsRuntime {
  return {
    lstat,
    open: async (path, flags, mode) => open(path, flags, mode),
    ...overrides,
  };
}

function proxyHandle(
  handle: SafeFsFileHandle,
  overrides: Partial<SafeFsFileHandle>,
): SafeFsFileHandle {
  return new Proxy(handle, {
    get(target, property, receiver) {
      if (property in overrides) {
        const value: unknown = Reflect.get(overrides, property);
        return typeof value === "function" ? value.bind(overrides) : value;
      }
      const value: unknown = Reflect.get(target, property, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

function directoryHandle(
  sync: () => Promise<void>,
  close: () => Promise<void>,
): SafeFsFileHandle {
  return {
    stat: async () => { throw new Error("directory stat is unused"); },
    read: async () => { throw new Error("directory read is unused"); },
    sync,
    close,
  };
}

describe("shared Codex safe filesystem primitives", () => {
  it("captures number-valued inode identity and treats ENOENT as an optional observation", async () => {
    const root = await temporaryRoot();
    const file = join(root, "fixture.txt");
    await writeFile(file, "same bytes", "utf8");
    const stat = await lstat(file);
    const captured = identity(stat);

    expect(captured).toEqual({
      dev: stat.dev,
      ino: stat.ino,
      mode: stat.mode,
      nlink: stat.nlink,
      size: stat.size,
    });
    expect(sameNode(captured, captured)).toBe(true);
    expect(sameFile(captured, { ...captured, size: captured.size + 1 })).toBe(false);
    await expect(observedLstat(runtime(), join(root, "missing"))).resolves.toBeUndefined();
    expect(() => assertRealDirectory(stat, "fixture")).toThrow("fixture must be a real directory");
    expect(() => assertBoundedRegularFile(stat, policy)).not.toThrow();
  });

  it("uses O_NOFOLLOW and rejects a same-byte path replacement after a bounded handle read", async () => {
    const root = await temporaryRoot();
    const target = join(root, "target.txt");
    const replacement = join(root, "replacement.txt");
    await writeFile(target, "same bytes", "utf8");
    await writeFile(replacement, "same bytes", "utf8");
    const [targetStat, replacementStat] = await Promise.all([lstat(target), lstat(replacement)]);
    let openedFlags: string | number | undefined;
    const injected = runtime({
      lstat: async (path) => {
        if (path === target) return replacementStat;
        return lstat(path);
      },
      open: async (path, flags, mode) => {
        openedFlags = flags;
        return open(path, flags, mode);
      },
    });

    await expect(readNoFollowPathBounded(injected, target, targetStat, policy))
      .rejects.toThrow("fixture changed");
    expect(typeof openedFlags).toBe("number");
    if ("O_NOFOLLOW" in constants) {
      expect((openedFlags as number) & constants.O_NOFOLLOW).toBe(constants.O_NOFOLLOW);
    }
  });

  it.each([
    ["growth", 11],
    ["shrink", 1],
  ])("rejects handle %s while reading", async (_case, finalSize) => {
    const root = await temporaryRoot();
    const path = join(root, "fixture.txt");
    await writeFile(path, "1234567890", "utf8");
    const handle = await open(path, constants.O_RDONLY);
    const before = await handle.stat();
    let stats = 0;
    const injected = proxyHandle(handle, {
      stat: async (): Promise<Stats> => (
        ++stats === 1 ? before : ({ ...before, size: finalSize } as Stats)
      ),
    });

    await expect(readHandleBounded(injected, policy)).rejects.toThrow("fixture changed");
    await handle.close();
  });

  it("propagates close failure after success but preserves an earlier read failure", async () => {
    const root = await temporaryRoot();
    const path = join(root, "fixture.txt");
    await writeFile(path, "content", "utf8");
    const closeFailure = new Error("close failed");
    const successRuntime = runtime({
      open: async (target, flags, mode) => {
        const handle = await open(target, flags, mode);
        return proxyHandle(handle, {
          close: async () => {
            await handle.close();
            throw closeFailure;
          },
        });
      },
    });
    const stat = await lstat(path);
    await expect(readNoFollowPathBounded(successRuntime, path, stat, policy)).rejects.toBe(closeFailure);

    const readFailure = new Error("read failed");
    const failingRuntime = runtime({
      open: async (target, flags, mode) => {
        const handle = await open(target, flags, mode);
        return proxyHandle(handle, {
          read: async () => { throw readFailure; },
          close: async () => {
            await handle.close();
            throw closeFailure;
          },
        });
      },
    });
    await expect(readNoFollowPathBounded(failingRuntime, path, stat, policy)).rejects.toBe(readFailure);
  });

  it("charges bounded byte totals without unsafe arithmetic", () => {
    const budget = { bytes: 4 };
    chargeByteBudget(budget, 6, 10, "budget exceeded");
    expect(budget.bytes).toBe(10);
    expect(() => chargeByteBudget(budget, 1, 10, "budget exceeded")).toThrow("budget exceeded");
    expect(() => chargeByteBudget({ bytes: 0 }, -1, 10, "budget exceeded")).toThrow("budget exceeded");
  });

  it("best-effort directory sync ignores supported portability errors and still closes handles", async () => {
    const root = await temporaryRoot();
    const handle = await open(root, constants.O_RDONLY);
    let closed = false;
    const unsupported = Object.assign(new Error("unsupported"), { code: "EPERM" });
    const injected = runtime({
      open: async () => proxyHandle(handle, {
        sync: async () => { throw unsupported; },
        close: async () => {
          closed = true;
          await handle.close();
        },
      }),
    });

    await expect(syncDirectoryBestEffort(injected, root)).resolves.toBeUndefined();
    expect(closed).toBe(true);
  });

  it("runs both identity checks when a portability error prevents opening the directory", async () => {
    const unsupported = Object.assign(new Error("unsupported open"), { code: "EPERM" });
    const injected = runtime({
      open: async () => { throw unsupported; },
    });
    let before = 0;
    let after = 0;

    await expect(syncDirectoryBestEffort(injected, "/virtual-directory", {
      before: async () => { before += 1; },
      after: async () => { after += 1; },
    })).resolves.toBeUndefined();

    expect({ before, after }).toEqual({ before: 1, after: 1 });
    const afterFailure = new Error("after identity changed");
    await expect(syncDirectoryBestEffort(injected, "/virtual-directory", {
      after: async () => { throw afterFailure; },
    })).rejects.toBe(afterFailure);
  });

  it("preserves a primary sync failure over a secondary close failure and still runs after", async () => {
    const primary = new Error("primary sync failure");
    const secondary = new Error("secondary close failure");
    let closes = 0;
    let after = 0;
    const injected = runtime({
      open: async () => directoryHandle(
        async () => { throw primary; },
        async () => {
          closes += 1;
          throw secondary;
        },
      ),
    });

    await expect(syncDirectoryBestEffort(injected, "/virtual-directory", {
      after: async () => { after += 1; },
    })).rejects.toBe(primary);
    expect(primary.message).toBe("primary sync failure");
    expect({ closes, after }).toEqual({ closes: 1, after: 1 });
  });

  it("preserves a primary sync failure over a secondary after failure and closes once", async () => {
    const primary = new Error("primary sync failure");
    const secondary = new Error("secondary after failure");
    let closes = 0;
    let after = 0;
    const injected = runtime({
      open: async () => directoryHandle(
        async () => { throw primary; },
        async () => { closes += 1; },
      ),
    });

    await expect(syncDirectoryBestEffort(injected, "/virtual-directory", {
      after: async () => {
        after += 1;
        throw secondary;
      },
    })).rejects.toBe(primary);
    expect(primary.message).toBe("primary sync failure");
    expect({ closes, after }).toEqual({ closes: 1, after: 1 });
  });

  it("uses close as the primary failure after an ignored unsupported sync and still runs after", async () => {
    const ignored = Object.assign(new Error("ignored unsupported sync"), { code: "EPERM" });
    const closeFailure = new Error("primary close failure");
    let closes = 0;
    let after = 0;
    const injected = runtime({
      open: async () => directoryHandle(
        async () => { throw ignored; },
        async () => {
          closes += 1;
          throw closeFailure;
        },
      ),
    });

    await expect(syncDirectoryBestEffort(injected, "/virtual-directory", {
      after: async () => { after += 1; },
    })).rejects.toBe(closeFailure);
    expect(closeFailure.message).toBe("primary close failure");
    expect({ closes, after }).toEqual({ closes: 1, after: 1 });
  });

  it("preserves close over an after failure when sync succeeds", async () => {
    const closeFailure = new Error("primary close failure");
    const afterFailure = new Error("secondary after failure");
    let closes = 0;
    let after = 0;
    const injected = runtime({
      open: async () => directoryHandle(
        async () => undefined,
        async () => {
          closes += 1;
          throw closeFailure;
        },
      ),
    });

    await expect(syncDirectoryBestEffort(injected, "/virtual-directory", {
      after: async () => {
        after += 1;
        throw afterFailure;
      },
    })).rejects.toBe(closeFailure);
    expect(closeFailure.message).toBe("primary close failure");
    expect({ closes, after }).toEqual({ closes: 1, after: 1 });
  });

  it("preserves an explicit undefined throw while still closing and running after", async () => {
    let closes = 0;
    let after = 0;
    const injected = runtime({
      open: async () => directoryHandle(
        async () => { throw undefined; },
        async () => { closes += 1; },
      ),
    });

    await expect(syncDirectoryBestEffort(injected, "/virtual-directory", {
      after: async () => { after += 1; },
    })).rejects.toBeUndefined();
    expect({ closes, after }).toEqual({ closes: 1, after: 1 });
  });
});
