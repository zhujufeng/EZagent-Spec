import { constants, type Stats } from "node:fs";
import {
  access,
  appendFile,
  chmod,
  link as hardLink,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  symlink,
  stat,
  truncate,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  initializeCodexIntegration,
  nodeCodexIntegrationRuntime,
  previewCodexIntegration,
  type CodexIntegrationRuntime,
} from "../../src/adapters/codex/integration.js";
import { WorkspaceRepository } from "../../src/workspace/repository.js";
import { mergeEzagentAgentsBlock } from "../../src/adapters/codex/agents-md.js";
import * as integrationApi from "../../src/adapters/codex/integration.js";

const temporaryPaths: string[] = [];

async function temporaryRoot(label: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), label));
  temporaryPaths.push(root);
  return root;
}

function registerTemporaryPath(path: string): void {
  temporaryPaths.push(path);
}

afterEach(async () => {
  await Promise.all(temporaryPaths.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

function injectedRuntime(
  overrides: Partial<CodexIntegrationRuntime>,
): CodexIntegrationRuntime {
  return { ...nodeCodexIntegrationRuntime, ...overrides };
}

async function expectMissing(path: string): Promise<void> {
  await expect(access(path)).rejects.toMatchObject({ code: "ENOENT" });
}

function proxyHandle(
  handle: Awaited<ReturnType<CodexIntegrationRuntime["open"]>>,
  overrides: Readonly<Record<string, (...args: readonly unknown[]) => unknown>>,
): Awaited<ReturnType<CodexIntegrationRuntime["open"]>> {
  return new Proxy(handle, {
    get(target, property, receiver) {
      if (typeof property === "string" && Object.hasOwn(overrides, property)) {
        return overrides[property];
      }
      const value: unknown = Reflect.get(target, property, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

async function completeWorkspace(root: string): Promise<void> {
  await new WorkspaceRepository(root).initialize({ schemaVersion: 1, name: "Demo", gitTracking: "none" });
}

describe("Codex integration initialization", () => {
  it("keeps the public runtime API surface stable", () => {
    expect(Object.keys(integrationApi).sort()).toEqual([
      "InspectionRequiredError",
      "initializeCodexIntegration",
      "nodeCodexIntegrationRuntime",
      "previewCodexIntegration",
    ]);
  });

  it("previews managed paths without creating project state", async () => {
    const root = await temporaryRoot("ezagent-integration-preview-");

    const preview = await previewCodexIntegration(root);

    expect(preview.paths).toEqual([
      ".ezagent/**",
      "AGENTS.md#EZAGENT",
      ".codex/agents/ezagent-*.toml",
    ]);
    expect(preview.agentsToken).toBe("missing");
    await expectMissing(join(root, ".ezagent"));
    expect(await readFile(root).catch((error: unknown) => (error as NodeJS.ErrnoException).code)).toBe("EISDIR");
  });

  it("preserves user AGENTS content and rejects a stale preview token", async () => {
    const root = await temporaryRoot("ezagent-integration-cas-");
    await writeFile(join(root, "AGENTS.md"), "# User\n", "utf8");
    const preview = await previewCodexIntegration(root);
    await writeFile(join(root, "AGENTS.md"), "# Concurrent edit\n", "utf8");

    await expect(
      initializeCodexIntegration(root, "Demo", preview.agentsToken),
    ).rejects.toThrow(/preview is stale/iu);

    expect(await readFile(join(root, "AGENTS.md"), "utf8")).toBe("# Concurrent edit\n");
    await expectMissing(join(root, ".ezagent"));
  });

  it("validates a direct API project name before any integration write", async () => {
    const root = await temporaryRoot("ezagent-integration-invalid-name-");
    const preview = await previewCodexIntegration(root);

    await expect(
      initializeCodexIntegration(root, "   ", preview.agentsToken),
    ).rejects.toThrow(/too_small|project|name|validation/iu);

    await expectMissing(join(root, ".ezagent"));
    await expectMissing(join(root, "AGENTS.md"));
  });

  it("initializes once and remains byte-identical when repeated", async () => {
    const root = await temporaryRoot("ezagent-integration-repeat-");
    await writeFile(join(root, "AGENTS.md"), "# User\n", "utf8");
    const preview = await previewCodexIntegration(root);
    await initializeCodexIntegration(root, "Demo", preview.agentsToken);
    const once = await readFile(join(root, "AGENTS.md"));
    const backupDirectory = join(root, ".ezagent", "backups", "agents-md");
    const backups = await readdir(backupDirectory);
    expect(backups).toHaveLength(2);
    const oldBackup = backups.find((entry) => entry.endsWith(".bak"));
    const nextRecovery = backups.find((entry) => entry.endsWith(".next"));
    expect(await readFile(join(backupDirectory, oldBackup!), "utf8")).toBe("# User\n");
    expect(await readFile(join(backupDirectory, nextRecovery!))).toEqual(once);

    const secondPreview = await previewCodexIntegration(root);
    await initializeCodexIntegration(root, "Demo", secondPreview.agentsToken);

    expect(await readFile(join(root, "AGENTS.md"))).toEqual(once);
    await expect(readdir(backupDirectory)).resolves.toEqual(backups);
    expect(once.toString("utf8").match(/EZAGENT:START/gu)).toHaveLength(1);
    await expect(access(join(root, ".ezagent", "project.yaml"), constants.R_OK)).resolves.toBeUndefined();
  });

  it("keeps an existing private AGENTS and its independent recovery copies at mode 0600", async () => {
    const root = await temporaryRoot("ezagent-integration-private-mode-");
    const agentsPath = join(root, "AGENTS.md");
    await writeFile(agentsPath, "# User\n", "utf8");
    if (process.platform !== "win32") await chmod(agentsPath, 0o600);
    const preview = await previewCodexIntegration(root);

    await initializeCodexIntegration(root, "Demo", preview.agentsToken);

    const recoveryDirectory = join(root, ".ezagent", "backups", "agents-md");
    const entries = await readdir(recoveryDirectory);
    const backupPath = join(recoveryDirectory, entries.find((entry) => entry.endsWith(".bak"))!);
    const nextPath = join(recoveryDirectory, entries.find((entry) => entry.endsWith(".next"))!);
    const [targetStat, backupStat, nextStat] = await Promise.all([
      stat(agentsPath),
      stat(backupPath),
      stat(nextPath),
    ]);
    expect(new Set([
      `${targetStat.dev}:${targetStat.ino}`,
      `${backupStat.dev}:${backupStat.ino}`,
      `${nextStat.dev}:${nextStat.ino}`,
    ]).size).toBe(3);
    if (process.platform !== "win32") {
      expect(targetStat.mode & 0o777).toBe(0o600);
      expect(backupStat.mode & 0o777).toBe(0o600);
      expect(nextStat.mode & 0o777).toBe(0o600);
    }
  });

  it.each([
    ["UTF-8 BOM", Buffer.from([0xef, 0xbb, 0xbf, 0x23])],
    ["invalid UTF-8", Buffer.from([0xc3, 0x28])],
  ])("rejects %s without creating workspace state", async (_case, contents) => {
    const root = await temporaryRoot("ezagent-integration-encoding-");
    await writeFile(join(root, "AGENTS.md"), contents);

    await expect(previewCodexIntegration(root)).rejects.toThrow(/AGENTS\.md/iu);
    await expectMissing(join(root, ".ezagent"));
  });

  it("rejects an AGENTS symlink without following it", async () => {
    const root = await temporaryRoot("ezagent-integration-symlink-");
    const outside = join(root, "outside.md");
    await writeFile(outside, "# Outside\n", "utf8");
    await symlink(outside, join(root, "AGENTS.md"));

    await expect(previewCodexIntegration(root)).rejects.toThrow(/bounded regular file/iu);
    expect(await readFile(outside, "utf8")).toBe("# Outside\n");
    await expectMissing(join(root, ".ezagent"));
  });

  it("rejects an AGENTS hard link so an in-place update cannot mutate an alias", async () => {
    const root = await temporaryRoot("ezagent-integration-hardlink-");
    const outside = join(root, "outside.md");
    await writeFile(outside, "# Outside\n", "utf8");
    await hardLink(outside, join(root, "AGENTS.md"));

    await expect(previewCodexIntegration(root)).rejects.toThrow(/uniquely linked|bounded regular file/iu);
    expect(await readFile(outside, "utf8")).toBe("# Outside\n");
    await expectMissing(join(root, ".ezagent"));
  });

  it.each([
    ["growth", async (path: string) => appendFile(path, "grow", "utf8")],
    ["shrink", async (path: string) => truncate(path, 1)],
  ])("detects AGENTS %s between lstat and no-follow open", async (_case, mutate) => {
    const root = await temporaryRoot("ezagent-integration-size-race-");
    const agentsPath = join(root, "AGENTS.md");
    await writeFile(agentsPath, "# User\n", "utf8");
    let targetStats = 0;
    const runtime = injectedRuntime({
      lstat: async (path) => {
        const observed = await nodeCodexIntegrationRuntime.lstat(path);
        if (path === agentsPath && ++targetStats === 1) await mutate(path);
        return observed;
      },
    });

    await expect(previewCodexIntegration(root, runtime)).rejects.toThrow(/changed during read/iu);
    await expectMissing(join(root, ".ezagent"));
  });

  it("rejects a same-byte inode replacement after the public preview closes its read handle", async () => {
    const root = await temporaryRoot("ezagent-integration-same-byte-replacement-");
    const agentsPath = join(root, "AGENTS.md");
    const displaced = join(root, "AGENTS.displaced.md");
    await writeFile(agentsPath, "# User\n", "utf8");
    let replaced = false;
    const runtime = injectedRuntime({
      open: async (path, flags, mode) => {
        const handle = await nodeCodexIntegrationRuntime.open(path, flags, mode);
        if (path !== agentsPath || typeof flags !== "number") return handle;
        return proxyHandle(handle, {
          close: async () => {
            await handle.close();
            if (!replaced) {
              replaced = true;
              const bytes = await readFile(agentsPath);
              await rename(agentsPath, displaced);
              await writeFile(agentsPath, bytes);
            }
          },
        });
      },
    });

    await expect(previewCodexIntegration(root, runtime)).rejects.toThrow(/AGENTS\.md changed during read/iu);

    expect(await readFile(agentsPath)).toEqual(await readFile(displaced));
    const [current, original] = await Promise.all([lstat(agentsPath), lstat(displaced)]);
    expect(`${current.dev}:${current.ino}`).not.toBe(`${original.dev}:${original.ino}`);
    await expectMissing(join(root, ".ezagent"));
  });

  it("detects project-root ancestor replacement during a guarded read", async () => {
    const root = await temporaryRoot("ezagent-integration-root-race-");
    const other = await temporaryRoot("ezagent-integration-other-root-");
    await writeFile(join(root, "AGENTS.md"), "# User\n", "utf8");
    const otherStat = await lstat(other);
    let rootStats = 0;
    const runtime = injectedRuntime({
      lstat: async (path): Promise<Stats> => {
        if (path === root && ++rootStats > 1) return otherStat;
        return nodeCodexIntegrationRuntime.lstat(path);
      },
    });

    await expect(previewCodexIntegration(root, runtime)).rejects.toThrow(/project root changed/iu);
    await expectMissing(join(root, ".ezagent"));
  });

  it("rejects a project-root replacement between preview validation and publication", async () => {
    const root = await temporaryRoot("ezagent-integration-init-root-race-");
    const other = await temporaryRoot("ezagent-integration-init-other-root-");
    await writeFile(join(root, "AGENTS.md"), "# User\n", "utf8");
    const preview = await previewCodexIntegration(root);
    const otherStat = await lstat(other);
    let rootStats = 0;
    const runtime = injectedRuntime({
      lstat: async (path): Promise<Stats> => {
        if (path === root && ++rootStats > 2) return otherStat;
        return nodeCodexIntegrationRuntime.lstat(path);
      },
    });

    await expect(
      initializeCodexIntegration(root, "Demo", preview.agentsToken, runtime),
    ).rejects.toThrow(/project root changed|AGENTS\.md changed before publication/iu);

    expect(await readFile(join(root, "AGENTS.md"), "utf8")).toBe("# User\n");
    await expectMissing(join(root, ".ezagent"));
  });

  it("never succeeds when the root is replaced during exclusive workspace creation", async () => {
    const root = await temporaryRoot("ezagent-integration-workspace-root-swap-");
    const displaced = `${root}.displaced`;
    registerTemporaryPath(displaced);
    const agentsPath = join(root, "AGENTS.md");
    const managedAgents = mergeEzagentAgentsBlock("# User\n");
    await writeFile(agentsPath, managedAgents, "utf8");
    const preview = await previewCodexIntegration(root);
    const workspacePath = join(root, ".ezagent");
    let injected = false;
    const runtime = injectedRuntime({
      mkdir: async (path) => {
        if (!injected && path === workspacePath) {
          injected = true;
          await rename(root, displaced);
          await mkdir(root);
          await writeFile(join(root, "AGENTS.md"), managedAgents, "utf8");
        }
        await nodeCodexIntegrationRuntime.mkdir(path);
      },
    });

    let result: unknown;
    let failure: unknown;
    try {
      result = await initializeCodexIntegration(root, "Demo", preview.agentsToken, runtime);
    } catch (error: unknown) {
      failure = error;
    }

    expect(result).toBeUndefined();
    expect(failure).toMatchObject({
      name: "InspectionRequiredError",
      code: "INSPECTION_REQUIRED",
      recoveryPath: workspacePath,
      paths: [workspacePath],
    });
    expect((failure as Error).message).toMatch(/requires inspection.*recovery:/iu);
    expect(await readFile(join(displaced, "AGENTS.md"), "utf8")).toBe(managedAgents);
    await expect(access(workspacePath)).resolves.toBeUndefined();
  });

  it("keeps file-sync durability when directory handles cannot be opened", async () => {
    const root = await temporaryRoot("ezagent-integration-directory-sync-");
    const preview = await previewCodexIntegration(root);
    const unsupported = Object.assign(new Error("directory sync unsupported"), { code: "EPERM" });
    const runtime = injectedRuntime({
      open: async (path, flags) => {
        if (path === root) throw unsupported;
        return nodeCodexIntegrationRuntime.open(path, flags);
      },
    });

    await expect(
      initializeCodexIntegration(root, "Demo", preview.agentsToken, runtime),
    ).resolves.toEqual({ initialized: true, root });
    await expect(access(join(root, ".ezagent", "project.yaml"))).resolves.toBeUndefined();
  });

  it("publishes a missing AGENTS as an independent copy of its durable recovery file", async () => {
    const root = await temporaryRoot("ezagent-integration-missing-copy-");
    const preview = await previewCodexIntegration(root);
    await initializeCodexIntegration(root, "Demo", preview.agentsToken);
    const agentsPath = join(root, "AGENTS.md");
    const recoveryDirectory = join(root, ".ezagent", "backups", "agents-md");
    const nextName = (await readdir(recoveryDirectory)).find((entry) => entry.endsWith(".next"));
    const nextPath = join(recoveryDirectory, nextName!);
    const originalRecovery = await readFile(nextPath);
    const [targetStat, nextStat] = await Promise.all([stat(agentsPath), stat(nextPath)]);
    expect(`${targetStat.dev}:${targetStat.ino}`).not.toBe(`${nextStat.dev}:${nextStat.ino}`);
    if (process.platform !== "win32") {
      expect(targetStat.mode & 0o777).toBe(0o600);
      expect(nextStat.mode & 0o777).toBe(0o600);
    }

    await writeFile(agentsPath, "# Later user edit\n", "utf8");

    expect(await readFile(nextPath)).toEqual(originalRecovery);
  });

  it("keeps an independent backup when an in-place AGENTS write partially succeeds then throws", async () => {
    const root = await temporaryRoot("ezagent-integration-partial-write-");
    await completeWorkspace(root);
    const agentsPath = join(root, "AGENTS.md");
    await writeFile(agentsPath, "# User\n", "utf8");
    const preview = await previewCodexIntegration(root);
    const injectedFailure = Object.assign(new Error("injected target write failure"), { code: "EIO" });
    const runtime = injectedRuntime({
      open: async (path, flags) => {
        const handle = await nodeCodexIntegrationRuntime.open(path, flags);
        if (path !== agentsPath || typeof flags !== "number" || (flags & constants.O_RDWR) === 0) {
          return handle;
        }
        return proxyHandle(handle, {
          write: async (...args) => {
            const [buffer, offset, length, position] = args as [Buffer, number, number, number];
            const partial = Math.max(1, Math.floor(length / 2));
            await handle.write(buffer, offset, partial, position);
            throw injectedFailure;
          },
        });
      },
    });

    let failure: unknown;
    try {
      await initializeCodexIntegration(root, "Demo", preview.agentsToken, runtime);
    } catch (error: unknown) {
      failure = error;
    }

    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toMatch(/requires inspection/iu);
    const backupPath = /backup: (.+)$/u.exec((failure as Error).message)?.[1];
    expect(backupPath).toBeTruthy();
    expect(await readFile(backupPath!, "utf8")).toBe("# User\n");
    expect((await readFile(agentsPath)).length).toBeGreaterThan(0);
    const recoveryEntries = await readdir(join(root, ".ezagent", "backups", "agents-md"));
    expect(recoveryEntries.some((entry) => entry.endsWith(".next"))).toBe(true);
  });

  it("reports typed recovery evidence when the public integration target close fails", async () => {
    const root = await temporaryRoot("ezagent-integration-close-failure-");
    await completeWorkspace(root);
    const agentsPath = join(root, "AGENTS.md");
    await writeFile(agentsPath, "# User\n", "utf8");
    const preview = await previewCodexIntegration(root);
    const closeFailure = Object.assign(new Error("injected AGENTS close failure"), { code: "EIO" });
    const runtime = injectedRuntime({
      open: async (path, flags, mode) => {
        const handle = await nodeCodexIntegrationRuntime.open(path, flags, mode);
        if (path !== agentsPath || typeof flags !== "number" || (flags & constants.O_RDWR) === 0) {
          return handle;
        }
        return proxyHandle(handle, {
          close: async () => {
            await handle.close();
            throw closeFailure;
          },
        });
      },
    });

    let failure: unknown;
    try {
      await initializeCodexIntegration(root, "Demo", preview.agentsToken, runtime);
    } catch (error: unknown) {
      failure = error;
    }

    expect(failure).toMatchObject({
      name: "InspectionRequiredError",
      code: "INSPECTION_REQUIRED",
      operation: "AGENTS publication close",
      cause: closeFailure,
      recoveryPath: expect.stringMatching(/AGENTS\.md\.[0-9a-f]{32}\.next$/u),
      backupPath: expect.stringMatching(/AGENTS\.md\.[0-9a-f]{32}\.bak$/u),
    });
    const evidence = failure as {
      readonly recoveryPath: string;
      readonly backupPath: string;
      readonly paths: readonly string[];
    };
    expect(evidence.paths).toEqual([evidence.recoveryPath, evidence.backupPath]);
    const targetBytes = await readFile(agentsPath);
    expect(targetBytes.toString("utf8")).toContain("EZAGENT:START");
    expect(await readFile(evidence.recoveryPath)).toEqual(targetBytes);
    expect(await readFile(evidence.backupPath, "utf8")).toBe("# User\n");
  });

  it("does not mistake an ordinary error message for an inspection error type", async () => {
    const root = await temporaryRoot("requires inspection random-id-");
    await completeWorkspace(root);
    const agentsPath = join(root, "AGENTS.md");
    await writeFile(agentsPath, "# User\n", "utf8");
    const preview = await previewCodexIntegration(root);
    const injected = new Error("requires inspection");
    const runtime = injectedRuntime({ randomId: () => { throw injected; } });

    let failure: unknown;
    try {
      await initializeCodexIntegration(root, "Demo", preview.agentsToken, runtime);
    } catch (error: unknown) {
      failure = error;
    }

    expect(failure).toMatchObject({
      name: "InspectionRequiredError",
      code: "INSPECTION_REQUIRED",
      recoveryPath: join(root, ".ezagent", "backups", "agents-md"),
      backupPath: undefined,
      paths: [join(root, ".ezagent", "backups", "agents-md")],
      cause: injected,
    });
    expect(failure).not.toBe(injected);
  });

  it("preserves the filesystem cause when recovery-file verification fails", async () => {
    const root = await temporaryRoot("ezagent-integration-recovery-cause-");
    await completeWorkspace(root);
    const agentsPath = join(root, "AGENTS.md");
    await writeFile(agentsPath, "# User\n", "utf8");
    const preview = await previewCodexIntegration(root);
    const injected = Object.assign(new Error("injected recovery read failure"), { code: "EIO" });
    let failed = false;
    const runtime = injectedRuntime({
      open: async (path, flags, mode) => {
        if (!failed && path.endsWith(".bak") && typeof flags === "number") {
          failed = true;
          throw injected;
        }
        return nodeCodexIntegrationRuntime.open(path, flags, mode);
      },
    });

    let failure: unknown;
    try {
      await initializeCodexIntegration(root, "Demo", preview.agentsToken, runtime);
    } catch (error: unknown) {
      failure = error;
    }

    expect(failure).toMatchObject({
      name: "InspectionRequiredError",
      code: "INSPECTION_REQUIRED",
      cause: injected,
    });
  });

  it("never deletes or overwrites a competitor that replaces AGENTS after its handle is opened", async () => {
    const root = await temporaryRoot("ezagent-integration-handle-race-");
    await completeWorkspace(root);
    const agentsPath = join(root, "AGENTS.md");
    await writeFile(agentsPath, "# User\n", "utf8");
    const preview = await previewCodexIntegration(root);
    let injected = false;
    const runtime = injectedRuntime({
      open: async (path, flags) => {
        const handle = await nodeCodexIntegrationRuntime.open(path, flags);
        if (path !== agentsPath || typeof flags !== "number" || (flags & constants.O_RDWR) === 0) {
          return handle;
        }
        return proxyHandle(handle, {
          write: async (...args) => {
            if (!injected) {
              injected = true;
              await rename(agentsPath, join(root, "original-open-handle.md"));
              await writeFile(agentsPath, "# Competitor\n", "utf8");
            }
            const [buffer, offset, length, position] = args as [Buffer, number, number, number];
            return handle.write(buffer, offset, length, position);
          },
        });
      },
    });

    await expect(
      initializeCodexIntegration(root, "Demo", preview.agentsToken, runtime),
    ).rejects.toThrow(/requires inspection/iu);

    expect(await readFile(agentsPath, "utf8")).toBe("# Competitor\n");
    const backups = await readdir(join(root, ".ezagent", "backups", "agents-md"));
    expect(backups.some((entry) => entry.endsWith(".bak"))).toBe(true);
    expect(backups.some((entry) => entry.endsWith(".next"))).toBe(true);
  });

  it("fails before writing when AGENTS gains a hard-link alias after handle read but before final lstat", async () => {
    const root = await temporaryRoot("ezagent-integration-late-hardlink-");
    await completeWorkspace(root);
    const agentsPath = join(root, "AGENTS.md");
    const aliasPath = join(root, "late-alias.md");
    await writeFile(agentsPath, "# User\n", "utf8");
    const preview = await previewCodexIntegration(root);
    let handleReadComplete = false;
    let injected = false;
    const runtime = injectedRuntime({
      lstat: async (path) => {
        if (!injected && path === agentsPath && handleReadComplete) {
          injected = true;
          await hardLink(agentsPath, aliasPath);
        }
        return nodeCodexIntegrationRuntime.lstat(path);
      },
      open: async (path, flags) => {
        const handle = await nodeCodexIntegrationRuntime.open(path, flags);
        if (
          path === agentsPath
          && typeof flags === "number"
          && (flags & constants.O_RDWR) !== 0
        ) {
          return proxyHandle(handle, {
            read: async (...args) => {
              const [buffer, offset, length, position] = args as [Buffer, number, number, number];
              const result = await handle.read(buffer, offset, length, position);
              if (result.bytesRead === 0) handleReadComplete = true;
              return result;
            },
          });
        }
        return handle;
      },
    });

    let failure: unknown;
    try {
      await initializeCodexIntegration(root, "Demo", preview.agentsToken, runtime);
    } catch (error: unknown) {
      failure = error;
    }

    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toMatch(/requires inspection.*recovery:.*backup:/iu);
    const recoveryDirectory = join(root, ".ezagent", "backups", "agents-md");
    const entries = await readdir(recoveryDirectory);
    const backup = entries.find((entry) => entry.endsWith(".bak"));
    const next = entries.find((entry) => entry.endsWith(".next"));
    expect(await readFile(join(recoveryDirectory, backup!), "utf8")).toBe("# User\n");
    expect(await readFile(join(recoveryDirectory, next!), "utf8")).toContain("EZAGENT:START");
    expect(await readFile(agentsPath, "utf8")).toBe("# User\n");
    expect(await readFile(aliasPath, "utf8")).toBe("# User\n");
  });

  it("detects but cannot prevent an alias created inside the first target write", async () => {
    const root = await temporaryRoot("ezagent-integration-write-hardlink-");
    await completeWorkspace(root);
    const agentsPath = join(root, "AGENTS.md");
    const aliasPath = join(root, "write-time-alias.md");
    await writeFile(agentsPath, "# User\n", "utf8");
    const preview = await previewCodexIntegration(root);
    let injected = false;
    const runtime = injectedRuntime({
      open: async (path, flags) => {
        const handle = await nodeCodexIntegrationRuntime.open(path, flags);
        if (path !== agentsPath || typeof flags !== "number" || (flags & constants.O_RDWR) === 0) {
          return handle;
        }
        return proxyHandle(handle, {
          write: async (...args) => {
            if (!injected) {
              injected = true;
              await hardLink(agentsPath, aliasPath);
            }
            const [buffer, offset, length, position] = args as [Buffer, number, number, number];
            return handle.write(buffer, offset, length, position);
          },
        });
      },
    });

    await expect(
      initializeCodexIntegration(root, "Demo", preview.agentsToken, runtime),
    ).rejects.toThrow(/requires inspection.*recovery:.*backup:/iu);

    const recoveryDirectory = join(root, ".ezagent", "backups", "agents-md");
    const entries = await readdir(recoveryDirectory);
    const backup = entries.find((entry) => entry.endsWith(".bak"));
    const next = entries.find((entry) => entry.endsWith(".next"));
    expect(await readFile(join(recoveryDirectory, backup!), "utf8")).toBe("# User\n");
    expect(await readFile(join(recoveryDirectory, next!), "utf8")).toContain("EZAGENT:START");
    expect(await readFile(aliasPath, "utf8")).toContain("EZAGENT:START");
  });

  it("reports durable recovery after AGENTS publication when project-root sync fails", async () => {
    const root = await temporaryRoot("ezagent-integration-agent-sync-");
    await completeWorkspace(root);
    const agentsPath = join(root, "AGENTS.md");
    await writeFile(agentsPath, "# User\n", "utf8");
    const preview = await previewCodexIntegration(root);
    let targetSynced = false;
    const syncFailure = Object.assign(new Error("injected project sync failure"), { code: "EIO" });
    const runtime = injectedRuntime({
      open: async (path, flags) => {
        if (path === root && targetSynced) throw syncFailure;
        const handle = await nodeCodexIntegrationRuntime.open(path, flags);
        if (path === agentsPath && typeof flags === "number" && (flags & constants.O_RDWR) !== 0) {
          return proxyHandle(handle, {
            sync: async () => {
              await handle.sync();
              targetSynced = true;
            },
          });
        }
        return handle;
      },
    });

    let failure: unknown;
    try {
      await initializeCodexIntegration(root, "Demo", preview.agentsToken, runtime);
    } catch (error: unknown) {
      failure = error;
    }

    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toMatch(/requires inspection.*backup:/iu);
    expect(await readFile(agentsPath, "utf8")).toContain("EZAGENT:START");
    const backups = await readdir(join(root, ".ezagent", "backups", "agents-md"));
    expect(backups.some((entry) => entry.endsWith(".bak"))).toBe(true);
  });

  it("reports recovery paths when final AGENTS verification becomes unreadable", async () => {
    const root = await temporaryRoot("ezagent-integration-final-read-");
    await completeWorkspace(root);
    const agentsPath = join(root, "AGENTS.md");
    await writeFile(agentsPath, "# User\n", "utf8");
    const preview = await previewCodexIntegration(root);
    let targetSynced = false;
    let rootSynced = false;
    const readFailure = Object.assign(new Error("injected final read failure"), { code: "EIO" });
    const runtime = injectedRuntime({
      lstat: async (path) => {
        if (path === agentsPath && rootSynced) throw readFailure;
        return nodeCodexIntegrationRuntime.lstat(path);
      },
      open: async (path, flags) => {
        const handle = await nodeCodexIntegrationRuntime.open(path, flags);
        if (path === agentsPath && typeof flags === "number" && (flags & constants.O_RDWR) !== 0) {
          return proxyHandle(handle, {
            sync: async () => {
              await handle.sync();
              targetSynced = true;
            },
          });
        }
        if (path === root && targetSynced) {
          return proxyHandle(handle, {
            sync: async () => {
              await handle.sync();
              rootSynced = true;
            },
          });
        }
        return handle;
      },
    });

    await expect(
      initializeCodexIntegration(root, "Demo", preview.agentsToken, runtime),
    ).rejects.toThrow(/requires inspection.*backup:/iu);

    const backups = await readdir(join(root, ".ezagent", "backups", "agents-md"));
    expect(backups.some((entry) => entry.endsWith(".bak"))).toBe(true);
    expect(backups.some((entry) => entry.endsWith(".next"))).toBe(true);
  });

  it("preserves AGENTS and reports the final workspace after workspace-root sync fails", async () => {
    const root = await temporaryRoot("ezagent-integration-workspace-sync-");
    const agentsPath = join(root, "AGENTS.md");
    await writeFile(agentsPath, "# User\n", "utf8");
    const preview = await previewCodexIntegration(root);
    const syncFailure = Object.assign(new Error("injected workspace root sync failure"), { code: "EIO" });
    const runtime = injectedRuntime({
      open: async (path, flags) => {
        if (path === root) {
          await access(join(root, ".ezagent", "project.yaml"));
          throw syncFailure;
        }
        return nodeCodexIntegrationRuntime.open(path, flags);
      },
    });

    await expect(
      initializeCodexIntegration(root, "Demo", preview.agentsToken, runtime),
    ).rejects.toThrow(/requires inspection.*\.ezagent/iu);

    expect(await readFile(agentsPath, "utf8")).toBe("# User\n");
    await expect(access(join(root, ".ezagent", "project.yaml"))).resolves.toBeUndefined();
  });

  it("reports the final workspace path when post-write workspace verification fails", async () => {
    const root = await temporaryRoot("ezagent-integration-workspace-verify-");
    const agentsPath = join(root, "AGENTS.md");
    await writeFile(agentsPath, "# User\n", "utf8");
    const preview = await previewCodexIntegration(root);
    const verificationFailure = Object.assign(new Error("injected workspace verification failure"), { code: "EIO" });
    const runtime = injectedRuntime({
      createRepository: () => ({ readContext: async () => { throw verificationFailure; } }),
    });

    await expect(
      initializeCodexIntegration(root, "Demo", preview.agentsToken, runtime),
    ).rejects.toThrow(/requires inspection.*recovery:.*\.ezagent/iu);

    expect(await readFile(agentsPath, "utf8")).toBe("# User\n");
    await expect(access(join(root, ".ezagent", "project.yaml"))).resolves.toBeUndefined();
  });

  it("does not replace a concurrently created empty .ezagent directory", async () => {
    const root = await temporaryRoot("ezagent-integration-workspace-race-");
    const agentsPath = join(root, "AGENTS.md");
    await writeFile(agentsPath, "# User\n", "utf8");
    const preview = await previewCodexIntegration(root);
    const workspacePath = join(root, ".ezagent");
    let injected = false;
    const runtime = injectedRuntime({
      mkdir: async (path) => {
        if (!injected && path === workspacePath) {
          injected = true;
          await mkdir(path);
        }
        await nodeCodexIntegrationRuntime.mkdir(path);
      },
    });

    await expect(
      initializeCodexIntegration(root, "Demo", preview.agentsToken, runtime),
    ).rejects.toThrow(/workspace changed before publication|requires inspection/iu);

    expect(await readdir(workspacePath)).toEqual([]);
    expect(await readFile(agentsPath, "utf8")).toBe("# User\n");
  });

  it("rejects backup-directory ancestor replacement before touching AGENTS", async () => {
    const root = await temporaryRoot("ezagent-integration-backup-ancestor-");
    await completeWorkspace(root);
    const agentsPath = join(root, "AGENTS.md");
    await writeFile(agentsPath, "# User\n", "utf8");
    const preview = await previewCodexIntegration(root);
    const backupsPath = join(root, ".ezagent", "backups");
    const displaced = join(root, "displaced-backups");
    const agentsBackupPath = join(backupsPath, "agents-md");
    let injected = false;
    const runtime = injectedRuntime({
      mkdir: async (path) => {
        if (!injected && path === agentsBackupPath) {
          injected = true;
          await rename(backupsPath, displaced);
          await symlink(displaced, backupsPath, "dir");
        }
        await nodeCodexIntegrationRuntime.mkdir(path);
      },
    });

    let failure: unknown;
    try {
      await initializeCodexIntegration(root, "Demo", preview.agentsToken, runtime);
    } catch (error: unknown) {
      failure = error;
    }

    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toMatch(/requires inspection.*recovery:.*agents-md.*backup:/iu);
    expect(await readFile(agentsPath, "utf8")).toBe("# User\n");
    expect((await lstat(backupsPath)).isSymbolicLink()).toBe(true);
  });

  it("does not overwrite a missing-target competitor that appears immediately before open(wx)", async () => {
    const root = await temporaryRoot("ezagent-integration-missing-open-race-");
    const agentsPath = join(root, "AGENTS.md");
    const preview = await previewCodexIntegration(root);
    let injected = false;
    const runtime = injectedRuntime({
      open: async (path, flags) => {
        if (!injected && path === agentsPath && flags === "wx") {
          injected = true;
          await writeFile(agentsPath, "# Competitor\n", "utf8");
        }
        return nodeCodexIntegrationRuntime.open(path, flags);
      },
    });

    let failure: unknown;
    try {
      await initializeCodexIntegration(root, "Demo", preview.agentsToken, runtime);
    } catch (error: unknown) {
      failure = error;
    }

    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toMatch(/requires inspection.*recovery:.*\.next/iu);
    expect(await readFile(agentsPath, "utf8")).toBe("# Competitor\n");
    const recoveryDirectory = join(root, ".ezagent", "backups", "agents-md");
    const next = (await readdir(recoveryDirectory)).find((entry) => entry.endsWith(".next"));
    expect(await readFile(join(recoveryDirectory, next!), "utf8")).toContain("EZAGENT:START");
  });

  it("syncs the independent backup directory before opening AGENTS for update", async () => {
    const root = await temporaryRoot("ezagent-integration-backup-sync-order-");
    await completeWorkspace(root);
    const agentsPath = join(root, "AGENTS.md");
    await writeFile(agentsPath, "# User\n", "utf8");
    const preview = await previewCodexIntegration(root);
    const backupDirectory = join(root, ".ezagent", "backups", "agents-md");
    const events: string[] = [];
    const runtime = injectedRuntime({
      open: async (path, flags) => {
        if (path === backupDirectory && flags === constants.O_RDONLY) events.push("backup-directory-sync");
        if (path === agentsPath && typeof flags === "number" && (flags & constants.O_RDWR) !== 0) {
          events.push("target-open");
        }
        return nodeCodexIntegrationRuntime.open(path, flags);
      },
    });

    await initializeCodexIntegration(root, "Demo", preview.agentsToken, runtime);

    expect(events).toContain("backup-directory-sync");
    expect(events).toContain("target-open");
    expect(events.indexOf("backup-directory-sync")).toBeLessThan(events.indexOf("target-open"));
  });

  it("reports the durable backup path when backup-directory sync fails before AGENTS is opened", async () => {
    const root = await temporaryRoot("ezagent-integration-backup-sync-failure-");
    await completeWorkspace(root);
    const agentsPath = join(root, "AGENTS.md");
    await writeFile(agentsPath, "# User\n", "utf8");
    const preview = await previewCodexIntegration(root);
    const backupDirectory = join(root, ".ezagent", "backups", "agents-md");
    const syncFailure = Object.assign(new Error("injected backup sync failure"), { code: "EIO" });
    let targetOpened = false;
    const runtime = injectedRuntime({
      open: async (path, flags) => {
        const handle = await nodeCodexIntegrationRuntime.open(path, flags);
        if (path === agentsPath && typeof flags === "number" && (flags & constants.O_RDWR) !== 0) {
          targetOpened = true;
        }
        if (path === backupDirectory && flags === constants.O_RDONLY) {
          return proxyHandle(handle, { sync: async () => { throw syncFailure; } });
        }
        return handle;
      },
    });

    await expect(
      initializeCodexIntegration(root, "Demo", preview.agentsToken, runtime),
    ).rejects.toThrow(/requires inspection.*backup:/iu);

    expect(targetOpened).toBe(false);
    expect(await readFile(agentsPath, "utf8")).toBe("# User\n");
    expect((await readdir(backupDirectory)).some((entry) => entry.endsWith(".bak"))).toBe(true);
  });

  it("fails closed on an existing incomplete .ezagent without initializing it in place", async () => {
    const root = await temporaryRoot("ezagent-integration-incomplete-workspace-");
    const agentsPath = join(root, "AGENTS.md");
    await writeFile(agentsPath, "# User\n", "utf8");
    await mkdir(join(root, ".ezagent"));
    const preview = await previewCodexIntegration(root);

    await expect(
      initializeCodexIntegration(root, "Demo", preview.agentsToken),
    ).rejects.toThrow(/not initialized|incomplete|corrupt/iu);

    expect(await readdir(join(root, ".ezagent"))).toEqual([]);
    expect(await readFile(agentsPath, "utf8")).toBe("# User\n");
  });
});
