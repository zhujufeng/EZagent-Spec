import { copyFile, mkdtemp, mkdir, open, readFile, readdir, rename, rm, stat, utimes, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";

import { afterEach, describe, expect, test } from "vitest";

import { atomicWriteText } from "../../src/workspace/atomic-write.js";
import { WorkspaceLockedError } from "../../src/workspace/errors.js";
import { workspacePaths } from "../../src/workspace/layout.js";
import { createWorkspaceLock, type WorkspaceLockRuntime, withWorkspaceLock } from "../../src/workspace/lock.js";

const temporaryRoots: string[] = [];

async function temporaryProject(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "ezagent-persistence-"));
  temporaryRoots.push(root);
  return root;
}

async function writeLock(projectRoot: string, contents: string): Promise<string> {
  const lock = workspacePaths(projectRoot).lock;
  await mkdir(dirname(lock), { recursive: true });
  await writeFile(lock, contents, "utf8");
  return lock;
}

function oldDate(): Date {
  return new Date(Date.now() - 60_000);
}

function lockRuntime(overrides: Partial<WorkspaceLockRuntime> = {}): WorkspaceLockRuntime {
  return {
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
    ...overrides,
  };
}

async function exitedChildPid(): Promise<number> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const child = spawn(process.execPath, ["-e", ""], { stdio: "ignore" });
    if (child.pid === undefined) {
      throw new Error("Could not determine child PID");
    }
    const pid = child.pid;
    await once(child, "exit");
    try {
      process.kill(pid, 0);
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code === "ESRCH") {
        return pid;
      }
    }
  }
  throw new Error("Exited child PID was unexpectedly reused");
}

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("atomicWriteText", () => {
  test("replaces prior content completely", async () => {
    const root = await temporaryProject();
    const target = join(root, "state.txt");

    await atomicWriteText(target, "first");
    await atomicWriteText(target, "second");

    await expect(readFile(target, "utf8")).resolves.toBe("second");
  });

  test("creates missing parent directories", async () => {
    const root = await temporaryProject();
    const target = join(root, "nested", "missing", "state.txt");

    await atomicWriteText(target, "created");

    await expect(readFile(target, "utf8")).resolves.toBe("created");
  });

  test("leaves no adjacent temporary files after success", async () => {
    const root = await temporaryProject();
    const target = join(root, "state", "state.txt");

    await atomicWriteText(target, "complete");

    expect((await readdir(dirname(target))).filter((name) => name.endsWith(".tmp"))).toEqual([]);
  });
});

describe("withWorkspaceLock", () => {
  test("rejects a concurrent writer deterministically", async () => {
    const root = await temporaryProject();
    let markEntered!: () => void;
    let releaseOperation!: () => void;
    const entered = new Promise<void>((resolve) => { markEntered = resolve; });
    const release = new Promise<void>((resolve) => { releaseOperation = resolve; });

    const first = withWorkspaceLock(root, async () => {
      markEntered();
      await release;
    });
    await entered;

    await expect(withWorkspaceLock(root, async () => undefined)).rejects.toMatchObject({
      name: "WorkspaceLockedError",
      message: expect.stringContaining("locked"),
    });

    releaseOperation();
    await first;
  });

  test("returns the operation result and releases its lock", async () => {
    const root = await temporaryProject();

    await expect(withWorkspaceLock(root, async () => "done")).resolves.toBe("done");
    await expect(readFile(workspacePaths(root).lock)).rejects.toMatchObject({ code: "ENOENT" });
  });

  test("preserves operation errors and releases the lock", async () => {
    const root = await temporaryProject();
    const failure = new Error("operation failed");

    await expect(withWorkspaceLock(root, async () => { throw failure; })).rejects.toBe(failure);
    await expect(withWorkspaceLock(root, async () => "reacquired")).resolves.toBe("reacquired");
  });

  test("recovers an old lock held by an exited process", async () => {
    const root = await temporaryProject();
    const pid = await exitedChildPid();
    const lock = await writeLock(root, JSON.stringify({
      token: randomUUID(),
      pid,
      createdAt: oldDate().toISOString(),
    }));
    await utimes(lock, oldDate(), oldDate());

    await expect(withWorkspaceLock(root, async () => "recovered")).resolves.toBe("recovered");
  });

  test.each([0, -1, Number.MAX_SAFE_INTEGER + 1, 1.5])(
    "treats old metadata with pid %s as corrupt and recovers it",
    async (pid) => {
      const root = await temporaryProject();
      const lock = await writeLock(root, JSON.stringify({
        token: randomUUID(),
        pid,
        createdAt: oldDate().toISOString(),
      }));
      await utimes(lock, oldDate(), oldDate());

      await expect(withWorkspaceLock(root, async () => "recovered")).resolves.toBe("recovered");
    },
  );

  test.each([0, -1, Number.MAX_SAFE_INTEGER + 1, 1.5])(
    "treats fresh metadata with pid %s as corrupt and keeps it locked",
    async (pid) => {
      const root = await temporaryProject();
      await writeLock(root, JSON.stringify({ token: randomUUID(), pid, createdAt: new Date().toISOString() }));

      await expect(withWorkspaceLock(root, async () => undefined)).rejects.toBeInstanceOf(WorkspaceLockedError);
    },
  );

  test("does not steal an old lock held by the current process", async () => {
    const root = await temporaryProject();
    const lock = await writeLock(root, JSON.stringify({
      token: randomUUID(),
      pid: process.pid,
      createdAt: oldDate().toISOString(),
    }));
    await utimes(lock, oldDate(), oldDate());

    await expect(withWorkspaceLock(root, async () => undefined)).rejects.toBeInstanceOf(WorkspaceLockedError);
  });

  test("does not steal a fresh corrupt lock", async () => {
    const root = await temporaryProject();
    await writeLock(root, "{");

    await expect(withWorkspaceLock(root, async () => undefined)).rejects.toBeInstanceOf(WorkspaceLockedError);
  });

  test("recovers an old corrupt lock", async () => {
    const root = await temporaryProject();
    const lock = await writeLock(root, "not metadata");
    await utimes(lock, oldDate(), oldDate());

    await expect(withWorkspaceLock(root, async () => "recovered")).resolves.toBe("recovered");
  });

  test("does not quarantine a replacement lock written during the operation", async () => {
    const root = await temporaryProject();
    const lock = workspacePaths(root).lock;
    const replacement = JSON.stringify({
      token: randomUUID(),
      pid: process.pid,
      createdAt: new Date().toISOString(),
    });
    let replacementStat!: Awaited<ReturnType<typeof stat>>;

    await withWorkspaceLock(root, async () => {
      await writeFile(lock, replacement, "utf8");
      replacementStat = await stat(lock);
    });

    await expect(readFile(lock, "utf8")).resolves.toBe(replacement);
    const after = await stat(lock);
    expect(after.size).toBe(replacementStat.size);
    expect(after.mtimeMs).toBe(replacementStat.mtimeMs);
    if (replacementStat.ino !== 0 && after.ino !== 0) {
      expect(after.dev).toBe(replacementStat.dev);
      expect(after.ino).toBe(replacementStat.ino);
    }
    expect((await readdir(dirname(lock))).filter((entry) => entry.includes("quarantine"))).toEqual([]);
    await rm(lock, { force: true });
  });

  test("preserves a non-Error operation value by identity", async () => {
    const root = await temporaryProject();
    const sentinel = { reason: "stop" };

    await expect(withWorkspaceLock(root, async () => { throw sentinel; })).rejects.toBe(sentinel);
  });

  test("leaves no quarantine artifacts after releasing a lock", async () => {
    const root = await temporaryProject();
    const lockDirectory = dirname(workspacePaths(root).lock);

    await withWorkspaceLock(root, async () => undefined);

    expect((await readdir(lockDirectory)).filter((entry) => entry.includes("quarantine"))).toEqual([]);
  });

  test.each([2_147_483_648])(
    "treats old metadata with PID above the portable maximum as corrupt",
    async (pid) => {
      const root = await temporaryProject();
      const lock = await writeLock(root, JSON.stringify({ token: randomUUID(), pid, createdAt: oldDate().toISOString() }));
      await utimes(lock, oldDate(), oldDate());

      await expect(withWorkspaceLock(root, async () => "recovered")).resolves.toBe("recovered");
    },
  );

  test.each([2_147_483_648])(
    "keeps fresh metadata with PID above the portable maximum locked",
    async (pid) => {
      const root = await temporaryProject();
      await writeLock(root, JSON.stringify({ token: randomUUID(), pid, createdAt: new Date().toISOString() }));

      await expect(withWorkspaceLock(root, async () => undefined)).rejects.toBeInstanceOf(WorkspaceLockedError);
    },
  );

  test("retains an acquisition lock when its identity is unavailable", async () => {
    const root = await temporaryProject();
    const lock = workspacePaths(root).lock;
    const replacement = "replacement lock";
    const lockWithUnavailableIdentity = createWorkspaceLock(lockRuntime({
      stat: async (path) => ({ ...(await stat(path)), dev: 0, ino: 0 }),
      open: async (...args) => {
        const handle = await open(...args);
        return new Proxy(handle, {
          get(target, property, receiver) {
            if (property === "stat") {
              return async () => ({ ...(await target.stat()), dev: 0, ino: 0 });
            }
            if (property === "writeFile") {
              return async () => {
                await target.writeFile(replacement, "utf8");
                throw new Error("write failed");
              };
            }
            return Reflect.get(target, property, receiver);
          },
        }) as Awaited<ReturnType<typeof open>>;
      },
    }));

    await expect(lockWithUnavailableIdentity(root, async () => undefined)).rejects.toThrow("write failed");
    await expect(readFile(lock, "utf8")).resolves.toBe(replacement);
    expect((await readdir(dirname(lock))).filter((entry) => entry.includes("quarantine"))).toEqual([]);
  });

  test("retains canonical and quarantine evidence when release changes after prevalidation", async () => {
    const root = await temporaryProject();
    const lock = workspacePaths(root).lock;
    const replacement = JSON.stringify({ token: randomUUID(), pid: process.pid, createdAt: new Date().toISOString() });
    const lockWithReleaseRace = createWorkspaceLock(lockRuntime({
      rename: async (source, destination) => {
        if (source === lock) {
          await writeFile(lock, replacement, "utf8");
        }
        await rename(source, destination);
      },
    }));

    let failure: unknown;
    try {
      await lockWithReleaseRace(root, async () => "done");
    } catch (error: unknown) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(WorkspaceLockedError);
    await expect(readFile(lock, "utf8")).resolves.toBe(replacement);
    const quarantines = (await readdir(dirname(lock))).filter((entry) => entry.includes("quarantine"));
    expect(quarantines).toHaveLength(1);
    const quarantine = join(dirname(lock), quarantines[0]!);
    expect((failure as Error).message).toContain(lock);
    expect((failure as Error).message).toContain(quarantine);
  });

  test("does not recover a stale lock whose content changes between observations", async () => {
    const root = await temporaryProject();
    const token = randomUUID();
    const createdAt = oldDate().toISOString();
    const original = JSON.stringify({ token, pid: 2_147_483_647, createdAt });
    const lock = await writeLock(root, original);
    const replacement = JSON.stringify({ pid: 2_147_483_647, token, createdAt });
    expect(replacement.length).toBe(original.length);
    const originalMtime = oldDate();
    await utimes(lock, originalMtime, originalMtime);
    let canonicalReads = 0;
    const lockWithStaleRace = createWorkspaceLock(lockRuntime({
      readFile: async (path, options) => {
        if (path === lock && ++canonicalReads === 2) {
          await writeFile(lock, replacement, "utf8");
          await utimes(lock, originalMtime, originalMtime);
        }
        return readFile(path, options);
      },
    }));

    await expect(lockWithStaleRace(root, async () => undefined)).rejects.toBeInstanceOf(WorkspaceLockedError);
    await expect(readFile(lock, "utf8")).resolves.toBe(replacement);
    expect((await readdir(dirname(lock))).filter((entry) => entry.includes("quarantine"))).toEqual([]);
  });

  test("preserves a thrown sentinel when release fails", async () => {
    const root = await temporaryProject();
    const lock = workspacePaths(root).lock;
    const sentinel = { reason: "operation" };
    const lockWithReleaseFailure = createWorkspaceLock(lockRuntime({
      rename: async (source, destination) => {
        if (source === lock) {
          throw new Error("release failed");
        }
        await rename(source, destination);
      },
    }));

    await expect(lockWithReleaseFailure(root, async () => { throw sentinel; })).rejects.toBe(sentinel);
  });
});
