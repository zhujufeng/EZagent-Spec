import { mkdtemp, mkdir, readFile, readdir, rm, utimes, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";

import { afterEach, describe, expect, test } from "vitest";

import { atomicWriteText } from "../../src/workspace/atomic-write.js";
import { WorkspaceLockedError } from "../../src/workspace/errors.js";
import { workspacePaths } from "../../src/workspace/layout.js";
import { withWorkspaceLock } from "../../src/workspace/lock.js";

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

  test("leaves a replacement lock written during the operation in place", async () => {
    const root = await temporaryProject();
    const lock = workspacePaths(root).lock;
    const replacement = JSON.stringify({
      token: randomUUID(),
      pid: process.pid,
      createdAt: new Date().toISOString(),
    });

    await withWorkspaceLock(root, async () => {
      await writeFile(lock, replacement, "utf8");
    });

    await expect(readFile(lock, "utf8")).resolves.toBe(replacement);
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
});
