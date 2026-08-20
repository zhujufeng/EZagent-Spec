import { createHash } from "node:crypto";
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readlink,
  readdir,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, describe, expect, test, vi } from "vitest";

import {
  appendAuditEvent,
  createAuditStore,
  readAuditEvents,
  type AuditEvent,
  type AuditFileRuntime,
} from "../../src/audit/events.js";
import { recoverState } from "../../src/audit/recovery.js";
import { WorkspaceCorruptError } from "../../src/workspace/errors.js";
import { workspacePaths } from "../../src/workspace/layout.js";
import { WorkspaceRepository } from "../../src/workspace/repository.js";
import { parsePendingMutation } from "../../src/workspace/mutation.js";
import type { WorkspaceState } from "../../src/workspace/schema.js";

const roots: string[] = [];
const config = { schemaVersion: 1 as const, name: "Demo", gitTracking: "none" as const };
const initialState: WorkspaceState = {
  schemaVersion: 1,
  revision: 0,
  activeWorkItem: null,
  safeMode: false,
};

function state(revision: number, safeMode = false): WorkspaceState {
  return { ...initialState, revision, safeMode };
}

function event(sequence: number, overrides: Partial<AuditEvent> = {}): AuditEvent {
  return {
    sequence,
    at: "2026-08-20T08:00:00.000Z",
    type: "workspace-updated",
    state: state(sequence),
    metadata: {},
    ...overrides,
  };
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

async function temporaryWorkspace(): Promise<{
  root: string;
  repository: WorkspaceRepository;
  paths: ReturnType<typeof workspacePaths>;
}> {
  const root = await mkdtemp(join(tmpdir(), "ezagent-recovery-"));
  roots.push(root);
  const repository = new WorkspaceRepository(root);
  await repository.initialize(config);
  return { root, repository, paths: workspacePaths(root) };
}

async function createFileSymlink(target: string, path: string): Promise<boolean> {
  try {
    await symlink(target, path, "file");
    return true;
  } catch (error: unknown) {
    if (["EACCES", "ENOSYS", "ENOTSUP", "EPERM"].includes((error as NodeJS.ErrnoException).code ?? "")) {
      return false;
    }
    throw error;
  }
}

async function createDirectorySymlink(target: string, path: string): Promise<boolean> {
  try {
    await symlink(target, path, "dir");
    return true;
  } catch (error: unknown) {
    if (["EACCES", "ENOSYS", "ENOTSUP", "EPERM"].includes((error as NodeJS.ErrnoException).code ?? "")) {
      return false;
    }
    throw error;
  }
}

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("audit events", () => {
  test("appends durable JSONL and reads events in original sequence", async () => {
    const { paths } = await temporaryWorkspace();
    await appendAuditEvent(paths.audit, event(1));
    await appendAuditEvent(paths.audit, event(2));

    expect(await readAuditEvents(paths.audit)).toEqual([event(1), event(2)]);
    expect(await readFile(paths.audit, "utf8")).toBe(`${JSON.stringify(event(1))}\n${JSON.stringify(event(2))}\n`);
  });

  test.each([
    ["unknown event key", { ...event(1), extra: true }],
    ["zero sequence", { ...event(1), sequence: 0, state: state(0) }],
    ["non-canonical timestamp", { ...event(1), at: "2026-08-20" }],
    ["blank type", { ...event(1), type: "   " }],
    ["overlong type", { ...event(1), type: "x".repeat(129) }],
    ["sequence/state mismatch", { ...event(1), state: state(2) }],
    ["unknown state key", { ...event(1), state: { ...state(1), extra: true } }],
    ["non-finite metadata", { ...event(1), metadata: { score: Number.POSITIVE_INFINITY } }],
    ["overlong metadata string", { ...event(1), metadata: { note: "x".repeat(257) } }],
    ["overlong metadata array", { ...event(1), metadata: { tags: Array.from({ length: 33 }, () => "x") } }],
    ["sparse metadata array", { ...event(1), metadata: { tags: Array(1) } }],
    ["too many metadata keys", {
      ...event(1),
      metadata: Object.fromEntries(Array.from({ length: 33 }, (_, index) => [`key${index}`, true])),
    }],
    ["dangerous metadata key", {
      ...event(1),
      metadata: JSON.parse('{"__proto__":"bad"}') as AuditEvent["metadata"],
    }],
  ])("rejects %s before append", async (_label, invalid) => {
    const { paths } = await temporaryWorkspace();

    await expect(appendAuditEvent(paths.audit, invalid as AuditEvent)).rejects.toThrow();
    await expect(readFile(paths.audit, "utf8")).resolves.toBe("");
  });

  test.each([
    ["out of order", `${JSON.stringify(event(2))}\n${JSON.stringify(event(1))}\n`],
    ["duplicate", `${JSON.stringify(event(1))}\n${JSON.stringify(event(1))}\n`],
    ["gap", `${JSON.stringify(event(1))}\n${JSON.stringify(event(3))}\n`],
    ["internal empty line", `${JSON.stringify(event(1))}\n\n${JSON.stringify(event(2))}\n`],
    ["torn tail", JSON.stringify(event(1))],
    ["invalid JSON", "not-json\n"],
  ])("rejects %s with audit path, line and cause", async (_label, contents) => {
    const { paths } = await temporaryWorkspace();
    await writeFile(paths.audit, contents, "utf8");

    await expect(readAuditEvents(paths.audit)).rejects.toMatchObject({
      name: "WorkspaceCorruptError",
      message: expect.stringContaining(paths.audit),
      cause: expect.any(Error),
    });
  });

  test("rejects malformed UTF-8", async () => {
    const { paths } = await temporaryWorkspace();
    await writeFile(paths.audit, Buffer.from([0xff, 0x0a]));
    await expect(readAuditEvents(paths.audit)).rejects.toBeInstanceOf(WorkspaceCorruptError);
  });

  test("rejects symlinked audit files without modifying their targets", async ({ skip }) => {
    const { root, paths } = await temporaryWorkspace();
    const external = join(root, "external-audit.jsonl");
    await writeFile(external, "sentinel\n", "utf8");
    await rm(paths.audit);
    if (!await createFileSymlink(external, paths.audit)) {
      skip();
      return;
    }

    await expect(appendAuditEvent(paths.audit, event(1))).rejects.toBeInstanceOf(WorkspaceCorruptError);
    await expect(readFile(external, "utf8")).resolves.toBe("sentinel\n");
    await expect(readlink(paths.audit)).resolves.toBe(external);
  });

  test.each(["write", "sync", "close"] as const)(
    "closes the append handle and preserves the primary %s failure",
    async (failurePoint) => {
      const writeError = new Error("write failed");
      const syncError = new Error("sync failed");
      const closeError = new Error("close failed");
      const close = vi.fn(async () => {
        if (failurePoint === "close" || failurePoint === "write" || failurePoint === "sync") throw closeError;
      });
      const runtime = {
        lstat: vi.fn(async (path: string) => {
          if (path === "/audit") return { isDirectory: () => true, isFile: () => false };
          const error = Object.assign(new Error("missing"), { code: "ENOENT" });
          throw error;
        }),
        readFile: vi.fn(),
        open: vi.fn(async () => ({
          writeFile: async () => {
            if (failurePoint === "write") throw writeError;
          },
          sync: async () => {
            if (failurePoint === "sync") throw syncError;
          },
          close,
        })),
      } as unknown as AuditFileRuntime;
      const store = createAuditStore(runtime);
      const expected = failurePoint === "write" ? writeError : failurePoint === "sync" ? syncError : closeError;

      await expect(store.appendAuditEvent("/audit/events.jsonl", event(1))).rejects.toBe(expected);
      expect(close).toHaveBeenCalledOnce();
    },
  );
});

describe("recoverState", () => {
  test("returns the canonical initial state for an empty audit", () => {
    expect(recoverState([])).toEqual(initialState);
  });

  test("returns the final state from contiguous events", () => {
    expect(recoverState([event(1), event(2)])).toEqual(state(2));
  });

  test("does not sort away sequence corruption", () => {
    expect(() => recoverState([event(2), event(1)])).toThrow("sequence");
  });
});

describe("WorkspaceRepository recovery and mutations", () => {
  test("records state and rebuilds a damaged state projection from audit", async () => {
    const { repository, paths } = await temporaryWorkspace();
    await repository.recordState(state(1), 0, "work-item-captured");
    await writeFile(paths.state, "broken", "utf8");

    await expect(repository.readContext()).resolves.toEqual({
      project: config,
      state: state(1),
      recovered: true,
    });
  });

  test("enters safe mode when audit is invalid even if state is valid", async () => {
    const { repository, paths } = await temporaryWorkspace();
    await writeFile(paths.audit, "broken", "utf8");

    await expect(repository.readContext()).resolves.toEqual({
      project: config,
      state: { ...initialState, safeMode: true },
      recovered: false,
    });
  });

  test("recovers initial state from an empty audit when state is damaged", async () => {
    const { repository, paths } = await temporaryWorkspace();
    await writeFile(paths.state, "broken", "utf8");

    await expect(repository.readContext()).resolves.toEqual({ project: config, state: initialState, recovered: true });
  });

  test("recovers from audit when state has the same revision but different content", async () => {
    const { repository, paths } = await temporaryWorkspace();
    await repository.recordState(state(1), 0, "first");
    await writeFile(paths.state, `${JSON.stringify(state(1, true))}\n`, "utf8");

    await expect(repository.readContext()).resolves.toMatchObject({ state: state(1), recovered: true });
  });

  test("rejects revision conflicts and non-incrementing next state without changing files", async () => {
    const { repository, paths } = await temporaryWorkspace();
    const before = await Promise.all([readFile(paths.state, "utf8"), readFile(paths.audit, "utf8")]);

    await expect(repository.recordState(state(1), 9, "conflict")).rejects.toThrow("revision conflict");
    await expect(repository.recordState(state(2), 0, "skip")).rejects.toThrow("increment");
    expect(await Promise.all([readFile(paths.state, "utf8"), readFile(paths.audit, "utf8")])).toEqual(before);
  });

  test("rejects mutation from corrupt audit and from matching safe mode", async () => {
    const first = await temporaryWorkspace();
    await writeFile(first.paths.audit, "broken\n", "utf8");
    await expect(first.repository.recordState(state(1), 0, "blocked")).rejects.toThrow();

    const second = await temporaryWorkspace();
    const safe = state(1, true);
    await second.repository.recordState(safe, 0, "safe-entered");
    await expect(second.repository.recordState(state(2), 1, "blocked")).rejects.toThrow("safe mode");
  });

  test.each([
    "",
    ".",
    "../AGENTS.md",
    "/tmp/outside",
    "C:/outside.txt",
    "C:\\outside.txt",
    "\\\\server\\share\\file.txt",
    "requirements/../../outside.txt",
    "requirements\\..\\outside.txt",
    "requirements/\0bad.md",
    "requirements",
    "project.yaml",
    "state/workspace.json",
    "audit/events.jsonl",
    "requirements/con.txt",
    "requirements/bad:name.md",
  ])("rejects unsafe or control mutation path %j before side effects", async (relativePath) => {
    const { repository, root, paths } = await temporaryWorkspace();
    const before = await Promise.all([readFile(paths.state, "utf8"), readFile(paths.audit, "utf8")]);

    await expect(repository.commitMutation(
      state(1),
      0,
      "invalid-write",
      [{ relativePath, content: "should not write" }],
    )).rejects.toThrow();

    expect(await Promise.all([readFile(paths.state, "utf8"), readFile(paths.audit, "utf8")])).toEqual(before);
    await expect(readFile(join(root, "AGENTS.md"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  test("rejects case-insensitive duplicate targets before side effects", async () => {
    const { repository } = await temporaryWorkspace();
    await expect(repository.commitMutation(state(1), 0, "duplicate", [
      { relativePath: "specs/Foo.md", content: "one" },
      { relativePath: "specs/foo.md", content: "two" },
    ])).rejects.toThrow("duplicate");
  });

  test.each([
    ["Greek final sigma", "specs/Σ.md", "specs/ς.md"],
    ["canonical Unicode equivalence", "specs/é.md", "specs/e\u0301.md"],
  ])("rejects %s path collisions before any filesystem side effect", async (_label, first, second) => {
    const root = await mkdtemp(join(tmpdir(), "ezagent-collision-"));
    roots.push(root);
    const repository = new WorkspaceRepository(root);

    await expect(repository.commitMutation(state(1), 0, "duplicate", [
      { relativePath: first, content: "one" },
      { relativePath: second, content: "two" },
    ])).rejects.toThrow("duplicate");
    expect(await readdir(root)).toEqual([]);
  });

  test("rejects a sparse write list before publishing transaction evidence", async () => {
    const root = await mkdtemp(join(tmpdir(), "ezagent-sparse-"));
    roots.push(root);
    const repository = new WorkspaceRepository(root);

    await expect(repository.commitMutation(
      state(1), 0, "sparse", Array(1) as unknown as readonly { relativePath: string; content: string }[],
    )).rejects.toBeInstanceOf(TypeError);

    expect(await readdir(root)).toEqual([]);
  });

  test("rejects sparse pending marker writes", () => {
    expect(() => parsePendingMutation({
      schemaVersion: 1,
      token: "token",
      createdAt: "2026-08-20T08:00:00.000Z",
      fromRevision: 0,
      toRevision: 1,
      stateHash: "0".repeat(64),
      eventHash: "1".repeat(64),
      writes: Array(1),
    })).toThrow(TypeError);
  });

  test("commits a long portable basename without leaving transaction or temporary files", async () => {
    const { repository, paths } = await temporaryWorkspace();
    const basename = `${"a".repeat(220)}.md`;
    await repository.commitMutation(
      state(1), 0, "long-name", [{ relativePath: `specs/${basename}`, content: "portable" }],
    );

    expect(await readdir(join(paths.root, "specs"))).toEqual([basename]);
    await expect(readFile(join(paths.root, "specs", basename), "utf8")).resolves.toBe("portable");
    await expect(lstat(paths.pendingMutation)).rejects.toMatchObject({ code: "ENOENT" });
  });

  test.each([
    ["overlong ASCII", `specs/${"a".repeat(256)}.md`],
    ["overlong UTF-8", `specs/${"中".repeat(86)}.md`],
  ])("rejects %s path components before any filesystem side effect", async (_label, relativePath) => {
    const root = await mkdtemp(join(tmpdir(), "ezagent-overlong-"));
    roots.push(root);
    const repository = new WorkspaceRepository(root);

    await expect(repository.commitMutation(
      state(1), 0, "overlong", [{ relativePath, content: "blocked" }],
    )).rejects.toBeInstanceOf(TypeError);
    expect(await readdir(root)).toEqual([]);
  });

  test.each([
    ["isolated high surrogates", "specs/\uD800.md", "specs/\uD801.md"],
    ["isolated low surrogates", "specs/\uDC00.md", "specs/\uDC01.md"],
  ])("rejects double writes with %s before any filesystem side effect", async (_label, first, second) => {
    const root = await mkdtemp(join(tmpdir(), "ezagent-surrogate-"));
    roots.push(root);
    const repository = new WorkspaceRepository(root);

    await expect(repository.commitMutation(state(1), 0, "malformed-unicode", [
      { relativePath: first, content: "one" },
      { relativePath: second, content: "two" },
    ])).rejects.toBeInstanceOf(TypeError);
    expect(await readdir(root)).toEqual([]);
  });

  test.each(["specs/\uD800.md", "specs/\uDC00.md", "specs/end\uD800"])(
    "rejects malformed Unicode in pending marker path %j",
    (relativePath) => {
      expect(() => parsePendingMutation({
        schemaVersion: 1,
        token: "token",
        createdAt: "2026-08-20T08:00:00.000Z",
        fromRevision: 0,
        toRevision: 1,
        stateHash: "0".repeat(64),
        eventHash: "1".repeat(64),
        writes: [{ relativePath, contentHash: "2".repeat(64) }],
      })).toThrow(TypeError);
    },
  );

  test("commits a well-formed non-BMP artifact path", async () => {
    const { repository, paths } = await temporaryWorkspace();
    const relativePath = "specs/😀.md";

    await repository.commitMutation(
      state(1), 0, "emoji-path", [{ relativePath, content: "valid pair" }],
    );

    await expect(readFile(join(paths.root, relativePath), "utf8")).resolves.toBe("valid pair");
    await expect(lstat(paths.pendingMutation)).rejects.toMatchObject({ code: "ENOENT" });
  });

  test("commits artifact writes, audit and state and leaves no transaction marker", async () => {
    const { repository, paths } = await temporaryWorkspace();
    await repository.commitMutation(
      state(1),
      0,
      "spec-created",
      [
        { relativePath: "specs/demo/spec.md", content: "# Spec\n" },
        { relativePath: "knowledge/decisions/first.md", content: "# Decision\n" },
      ],
      { source: "test", tags: ["local", "spec"] },
    );

    await expect(readFile(join(paths.root, "specs/demo/spec.md"), "utf8")).resolves.toBe("# Spec\n");
    await expect(readFile(join(paths.root, "knowledge/decisions/first.md"), "utf8")).resolves.toBe("# Decision\n");
    await expect(readAuditEvents(paths.audit)).resolves.toMatchObject([
      { sequence: 1, type: "spec-created", state: state(1), metadata: { source: "test", tags: ["local", "spec"] } },
    ]);
    await expect(readFile(paths.state, "utf8")).resolves.toBe(`${JSON.stringify(state(1), null, 2)}\n`);
    await expect(lstat(join(paths.root, "state/pending-mutation.json"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  test("rejects a symlinked artifact parent without modifying the external directory", async ({ skip }) => {
    const { repository, root, paths } = await temporaryWorkspace();
    const external = join(root, "external-parent");
    await mkdir(external);
    await rm(join(paths.root, "specs"), { recursive: true });
    if (!await createDirectorySymlink(external, join(paths.root, "specs"))) {
      skip();
      return;
    }

    await expect(repository.commitMutation(
      state(1), 0, "blocked", [{ relativePath: "specs/outside.md", content: "bad" }],
    )).rejects.toBeInstanceOf(WorkspaceCorruptError);
    await expect(readFile(join(external, "outside.md"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  test("rejects a symlinked artifact target without modifying the external file", async ({ skip }) => {
    const { repository, root, paths } = await temporaryWorkspace();
    const external = join(root, "external-target.md");
    const target = join(paths.root, "specs/target.md");
    await writeFile(external, "keep", "utf8");
    if (!await createFileSymlink(external, target)) {
      skip();
      return;
    }

    await expect(repository.commitMutation(
      state(1), 0, "blocked", [{ relativePath: "specs/target.md", content: "bad" }],
    )).rejects.toBeInstanceOf(WorkspaceCorruptError);
    await expect(readFile(external, "utf8")).resolves.toBe("keep");
  });

  test("allows at most one concurrent mutation at the same expected revision", async () => {
    const { repository } = await temporaryWorkspace();
    const results = await Promise.allSettled([
      repository.recordState(state(1), 0, "first"),
      repository.recordState(state(1), 0, "second"),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
  });

  test("enters safe mode for an incomplete pending mutation and refuses to continue", async () => {
    const { repository, paths } = await temporaryWorkspace();
    const pending = join(paths.root, "state/pending-mutation.json");
    await writeFile(join(paths.root, "specs/partial.md"), "written-before-crash", "utf8");
    await writeFile(pending, `${JSON.stringify({
      schemaVersion: 1,
      token: "incomplete-token",
      createdAt: "2026-08-20T08:00:00.000Z",
      fromRevision: 0,
      toRevision: 1,
      stateHash: "0".repeat(64),
      eventHash: "1".repeat(64),
      writes: [
        { relativePath: "specs/partial.md", contentHash: sha256("written-before-crash") },
        { relativePath: "tasks/missing.md", contentHash: "2".repeat(64) },
      ],
    })}\n`, "utf8");

    await expect(repository.readContext()).resolves.toMatchObject({
      state: { revision: 0, safeMode: true },
      recovered: false,
    });
    await expect(repository.recordState(state(1), 0, "blocked")).rejects.toThrow("pending mutation");
    await expect(readFile(pending, "utf8")).resolves.toContain("incomplete-token");
  });

  test("accepts a provably committed orphan marker and clears it before the next mutation", async () => {
    const { repository, paths } = await temporaryWorkspace();
    const target = join(paths.root, "specs/committed.md");
    await repository.commitMutation(
      state(1), 0, "committed", [{ relativePath: "specs/committed.md", content: "done" }],
    );
    const auditEvent = (await readAuditEvents(paths.audit))[0]!;
    const pending = join(paths.root, "state/pending-mutation.json");
    await writeFile(pending, `${JSON.stringify({
      schemaVersion: 1,
      token: "orphan-token",
      createdAt: "2026-08-20T08:00:00.000Z",
      fromRevision: 0,
      toRevision: 1,
      stateHash: sha256(JSON.stringify(state(1))),
      eventHash: sha256(JSON.stringify(auditEvent)),
      writes: [{ relativePath: "specs/committed.md", contentHash: sha256("done") }],
    })}\n`, "utf8");

    await expect(repository.readContext()).resolves.toEqual({ project: config, state: state(1), recovered: false });
    await repository.recordState(state(2), 1, "continued");
    await expect(readFile(target, "utf8")).resolves.toBe("done");
    await expect(lstat(pending)).rejects.toMatchObject({ code: "ENOENT" });
  });

  test("does not swallow project boundary errors while producing safe mode", async ({ skip }) => {
    const { repository, root, paths } = await temporaryWorkspace();
    const external = join(root, "external-root");
    await mkdir(external);
    await rm(paths.root, { recursive: true });
    if (!await createDirectorySymlink(external, paths.root)) {
      skip();
      return;
    }

    await expect(repository.readContext()).rejects.toBeInstanceOf(WorkspaceCorruptError);
  });

  test("fails closed when a required workspace directory is missing", async () => {
    const { repository, paths } = await temporaryWorkspace();
    await rm(join(paths.root, "specs"), { recursive: true });

    await expect(repository.readContext()).rejects.toBeInstanceOf(WorkspaceCorruptError);
    await expect(repository.recordState(state(1), 0, "blocked")).rejects.toBeInstanceOf(WorkspaceCorruptError);
  });
});
