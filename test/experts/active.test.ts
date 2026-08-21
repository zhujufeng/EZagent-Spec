import { constants } from "node:fs";
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { types as nodeTypes } from "node:util";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  ACTIVE_EXPERT_FILE_MAX_BYTES,
  ActiveExpertConflictError,
  ActiveExpertRepository,
  ActiveExpertValidationError,
  activeExpertOpenFlags,
  type ActiveExperts,
} from "../../src/experts/active.js";
import { WorkspaceCorruptError, WorkspaceLockedError } from "../../src/workspace/errors.js";
import { workspacePaths } from "../../src/workspace/layout.js";
import { withWorkspaceLock } from "../../src/workspace/lock.js";

const roots: string[] = [];
const EXTERNAL_SENTINEL = "external bytes stay unchanged\n";

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "ezagent-active-"));
  roots.push(root);
  return root;
}

async function projectionRoot(): Promise<string> {
  const root = await temporaryRoot();
  await mkdir(dirname(await activePath(root)), { recursive: true });
  return root;
}

async function activePath(root: string): Promise<string> {
  return join(await realpath(root), ".ezagent", "experts", "active.yaml");
}

function entry(
  id = "ezagent.engineering.frontend-architect",
  reason = "覆盖前端架构与状态边界",
  taskIds = ["TASK-20260820-001"],
) {
  return { id, reason, taskIds };
}

function state(revision: number, experts = [entry()]): ActiveExperts {
  return { revision, experts };
}

function canonicalText(value: ActiveExperts): string {
  const experts = [...value.experts]
    .map((expert) => ({ ...expert, taskIds: [...expert.taskIds].sort() }))
    .sort((left, right) => left.id < right.id ? -1 : left.id > right.id ? 1 : 0);
  if (experts.length === 0) return `revision: ${value.revision}\nexperts: []\n`;
  const lines = [`revision: ${value.revision}`, "experts:"];
  for (const expert of experts) {
    lines.push(`  - id: ${expert.id}`);
    lines.push(`    reason: ${JSON.stringify(expert.reason)}`);
    lines.push("    taskIds:");
    lines.push(...expert.taskIds.map((taskId) => `      - ${taskId}`));
  }
  return `${lines.join("\n")}\n`;
}

async function createDirectorySymlink(target: string, path: string): Promise<boolean> {
  try {
    await symlink(target, path, "dir");
    return true;
  } catch (error: unknown) {
    if (["EACCES", "ENOSYS", "ENOTSUP", "EPERM"].includes(
      (error as NodeJS.ErrnoException).code ?? "",
    )) {
      return false;
    }
    throw error;
  }
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("ActiveExpertRepository", () => {
  it("reads a missing projection as revision zero without creating directories", async () => {
    const root = await temporaryRoot();
    const repository = new ActiveExpertRepository(root);

    await expect(repository.read()).resolves.toEqual({ revision: 0, experts: [] });
    await expect(readdir(root)).resolves.toEqual([]);
  });

  it("persists the first revision in a new project without full workspace initialization", async () => {
    const root = await temporaryRoot();
    const repository = new ActiveExpertRepository(root);

    await repository.write(state(1), 0);

    await expect(repository.read()).resolves.toEqual(state(1));
    await expect(readFile(workspacePaths(await realpath(root)).project)).rejects.toMatchObject({ code: "ENOENT" });
    expect((await lstat(dirname(await activePath(root)))).isDirectory()).toBe(true);
  });

  it("rejects non-real project roots", async ({ skip }) => {
    const container = await temporaryRoot();
    const file = join(container, "project-file");
    const missing = join(container, "missing-project");
    const real = join(container, "real-project");
    const linked = join(container, "linked-project");
    await writeFile(file, "not a directory", "utf8");
    await mkdir(real);
    try {
      await symlink(real, linked, "dir");
    } catch (error: unknown) {
      if (["EACCES", "ENOSYS", "ENOTSUP", "EPERM"].includes(
        (error as NodeJS.ErrnoException).code ?? "",
      )) {
        skip();
        return;
      }
      throw error;
    }

    for (const invalid of ["relative-project", file, missing, linked]) {
      expect(() => new ActiveExpertRepository(invalid)).toThrow(expect.objectContaining({
        name: "ActiveExpertValidationError",
        code: "ACTIVE_EXPERT_PROJECT_INVALID",
      }));
    }
  });

  it("fails closed on existing non-directory projection boundaries before creating lock state", async () => {
    const rootWithBadWorkspace = await temporaryRoot();
    const workspaceBoundary = join(await realpath(rootWithBadWorkspace), ".ezagent");
    await writeFile(workspaceBoundary, "keep workspace boundary", "utf8");
    const workspaceRepository = new ActiveExpertRepository(rootWithBadWorkspace);

    await expect(workspaceRepository.read()).rejects.toBeInstanceOf(WorkspaceCorruptError);
    await expect(workspaceRepository.write(state(1), 0)).rejects.toBeInstanceOf(WorkspaceCorruptError);
    await expect(readFile(workspaceBoundary, "utf8")).resolves.toBe("keep workspace boundary");

    const rootWithBadExperts = await temporaryRoot();
    const workspace = join(await realpath(rootWithBadExperts), ".ezagent");
    await mkdir(workspace);
    await writeFile(join(workspace, "experts"), "keep experts boundary", "utf8");
    const expertsRepository = new ActiveExpertRepository(rootWithBadExperts);

    await expect(expertsRepository.read()).rejects.toBeInstanceOf(WorkspaceCorruptError);
    await expect(expertsRepository.write(state(1), 0)).rejects.toBeInstanceOf(WorkspaceCorruptError);
    await expect(readdir(workspace)).resolves.toEqual(["experts"]);
    await expect(readFile(join(workspace, "experts"), "utf8")).resolves.toBe("keep experts boundary");
  });

  it("rejects a linked .ezagent boundary without writing into its target", async ({ skip }) => {
    const root = await temporaryRoot();
    const canonicalRoot = await realpath(root);
    const external = join(canonicalRoot, "external-workspace");
    const boundary = join(canonicalRoot, ".ezagent");
    await mkdir(external);
    await writeFile(join(external, "sentinel.txt"), EXTERNAL_SENTINEL, "utf8");
    if (!await createDirectorySymlink(external, boundary)) {
      skip();
      return;
    }
    const repository = new ActiveExpertRepository(root);

    await expect(repository.read()).rejects.toBeInstanceOf(WorkspaceCorruptError);
    await expect(repository.write(state(1), 0)).rejects.toBeInstanceOf(WorkspaceCorruptError);
    await expect(readdir(external)).resolves.toEqual(["sentinel.txt"]);
    await expect(readFile(join(external, "sentinel.txt"), "utf8")).resolves.toBe(EXTERNAL_SENTINEL);
  });

  it("round-trips state and writes canonical deterministic LF-only YAML", async () => {
    const root = await projectionRoot();
    const repository = new ActiveExpertRepository(root);
    const next: ActiveExperts = {
      revision: 1,
      experts: [
        entry("ezagent.product.manager", "保留原始选择原因：产品范围", [
          "TASK-20260820-010",
          "TASK-20260820-002",
        ]),
        entry("ezagent.engineering.backend-architect", "覆盖后端接口边界"),
      ],
    };

    await repository.write(next, 0);

    await expect(repository.read()).resolves.toEqual({
      revision: 1,
      experts: [
        entry("ezagent.engineering.backend-architect", "覆盖后端接口边界"),
        entry("ezagent.product.manager", "保留原始选择原因：产品范围", [
          "TASK-20260820-002",
          "TASK-20260820-010",
        ]),
      ],
    });
    const bytes = await readFile(await activePath(root), "utf8");
    expect(bytes).toBe([
      "revision: 1",
      "experts:",
      "  - id: ezagent.engineering.backend-architect",
      "    reason: \"覆盖后端接口边界\"",
      "    taskIds:",
      "      - TASK-20260820-001",
      "  - id: ezagent.product.manager",
      "    reason: \"保留原始选择原因：产品范围\"",
      "    taskIds:",
      "      - TASK-20260820-002",
      "      - TASK-20260820-010",
      "",
    ].join("\n"));
    expect(bytes).not.toContain("\r");
    expect((await readdir(dirname(await activePath(root))))
      .filter((name) => name.endsWith(".tmp"))).toEqual([]);
  });

  it("rejects a stale update and preserves the original bytes", async () => {
    const root = await projectionRoot();
    const repository = new ActiveExpertRepository(root);
    await repository.write(state(1), 0);
    const path = await activePath(root);
    const before = await readFile(path);

    const attempt = repository.write({ revision: 2, experts: [] }, 0);
    await expect(attempt).rejects.toBeInstanceOf(ActiveExpertConflictError);
    await expect(attempt).rejects.toMatchObject({
      code: "ACTIVE_EXPERT_REVISION_CONFLICT",
      expectedRevision: 0,
      actualRevision: 1,
      message: "Active expert revision conflict",
    });
    await expect(readFile(path)).resolves.toEqual(before);
  });

  it("rejects a pre-existing stale projection without creating lock directories", async () => {
    const root = await projectionRoot();
    const path = await activePath(root);
    const original = canonicalText(state(1));
    await writeFile(path, original, "utf8");

    await expect(new ActiveExpertRepository(root).write({ revision: 2, experts: [] }, 0))
      .rejects.toMatchObject({ code: "ACTIVE_EXPERT_REVISION_CONFLICT" });
    await expect(readdir(join(await realpath(root), ".ezagent"))).resolves.toEqual(["experts"]);
    await expect(readFile(path, "utf8")).resolves.toBe(original);
  });

  it("rejects a nonincrementing next revision before changing the file", async () => {
    const root = await projectionRoot();
    const repository = new ActiveExpertRepository(root);
    await repository.write(state(1), 0);
    const path = await activePath(root);
    const before = await readFile(path);

    await expect(repository.write(state(3), 1)).rejects.toMatchObject({
      name: "ActiveExpertValidationError",
      code: "ACTIVE_EXPERT_REVISION_INVALID",
      message: "Active expert revision must increment by exactly one",
    });
    await expect(readFile(path)).resolves.toEqual(before);
  });

  it("rejects an invalid first revision without creating workspace structure", async () => {
    const root = await temporaryRoot();

    await expect(new ActiveExpertRepository(root).write(state(2), 0)).rejects.toMatchObject({
      code: "ACTIVE_EXPERT_REVISION_INVALID",
    });
    await expect(readdir(root)).resolves.toEqual([]);
  });

  it("rejects revision overflow without modifying the existing projection", async () => {
    const root = await projectionRoot();
    const path = await activePath(root);
    const original = "revision: 9007199254740991\nexperts: []\n";
    await writeFile(path, original, "utf8");

    await expect(new ActiveExpertRepository(root).write(
      { revision: Number.MAX_SAFE_INTEGER, experts: [] },
      Number.MAX_SAFE_INTEGER,
    )).rejects.toMatchObject({ code: "ACTIVE_EXPERT_REVISION_INVALID" });
    await expect(readFile(path, "utf8")).resolves.toBe(original);
  });

  it("allows exactly one of two concurrent expected-zero writers to succeed", async () => {
    const root = await temporaryRoot();
    const first = new ActiveExpertRepository(root);
    const second = new ActiveExpertRepository(root);

    const results = await Promise.allSettled([
      first.write(state(1, [entry("ezagent.engineering.frontend")]), 0),
      second.write(state(1, [entry("ezagent.engineering.backend")]), 0),
    ]);

    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
    await expect(first.read()).resolves.toMatchObject({ revision: 1 });
  });

  it("does not impose a small product-level expert count limit", async () => {
    const root = await projectionRoot();
    const experts = Array.from({ length: 128 }, (_, index) => entry(
      `ezagent.test.expert${index + 1}`,
      `覆盖能力 ${index + 1}`,
      [`TASK-20260820-${String(index + 1).padStart(3, "0")}`],
    ));
    const repository = new ActiveExpertRepository(root);

    await repository.write(state(1, experts), 0);
    expect((await repository.read()).experts).toHaveLength(128);
  });

  it("propagates stable workspace lock contention and does not write", async () => {
    const root = await projectionRoot();
    let entered!: () => void;
    let release!: () => void;
    const inside = new Promise<void>((resolve) => { entered = resolve; });
    const wait = new Promise<void>((resolve) => { release = resolve; });
    const holder = withWorkspaceLock(await realpath(root), async () => {
      entered();
      await wait;
    });
    await inside;

    const attempt = new ActiveExpertRepository(root).write(state(1), 0);
    await expect(attempt).rejects.toBeInstanceOf(WorkspaceLockedError);
    await expect(attempt).rejects.toMatchObject({ code: "LOCK_CONTENDED" });
    await expect(readFile(await activePath(root))).rejects.toMatchObject({ code: "ENOENT" });
    release();
    await holder;
  });

  it("rejects duplicate expert IDs and duplicate task IDs", async () => {
    const root = await projectionRoot();
    const repository = new ActiveExpertRepository(root);

    await expect(repository.write(state(1, [entry(), entry()]), 0)).rejects.toMatchObject({
      code: "ACTIVE_EXPERT_INVALID_INPUT",
    });
    await expect(repository.write(state(1, [entry(undefined, undefined, [
      "TASK-20260820-001",
      "TASK-20260820-001",
    ])]), 0)).rejects.toMatchObject({ code: "ACTIVE_EXPERT_INVALID_INPUT" });
    await expect(readFile(await activePath(root))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it.each([
    ["bad expert id", entry("ezagent.bad..id")],
    ["noncanonical expert id", entry("EZAGENT.engineering.frontend")],
    ["blank reason", entry(undefined, " ")],
    ["surrounding reason whitespace", entry(undefined, " 覆盖前端")],
    ["non-NFC reason", entry(undefined, "Cafe\u0301 覆盖")],
    ["control in reason", entry(undefined, "覆盖\u0000前端")],
    ["wrong task prefix", entry(undefined, undefined, ["SPEC-20260820-001"])],
    ["empty task list", entry(undefined, undefined, [])],
    ["impossible task date", entry(undefined, undefined, ["TASK-20260230-001"])],
    ["noncanonical task sequence", entry(undefined, undefined, ["TASK-20260820-0001"])],
  ])("rejects %s", async (_label, invalidEntry) => {
    const root = await projectionRoot();
    await expect(new ActiveExpertRepository(root).write(
      { revision: 1, experts: [invalidEntry] } as ActiveExperts,
      0,
    )).rejects.toMatchObject({ code: "ACTIVE_EXPERT_INVALID_INPUT" });
  });

  it("rejects extra keys, prototype objects, accessors, sparse arrays, and Proxies", async () => {
    const root = await projectionRoot();
    const repository = new ActiveExpertRepository(root);
    const withExtra = { revision: 1, experts: [], schemaVersion: 1 };
    const inherited = Object.create({ revision: 1 }) as Record<string, unknown>;
    inherited.experts = [];
    const accessor = { revision: 1 } as Record<string, unknown>;
    Object.defineProperty(accessor, "experts", { enumerable: true, get: () => [] });
    const sparse = { revision: 1, experts: new Array(2) };
    const proxy = new Proxy({ revision: 1, experts: [] }, {});
    expect(nodeTypes.isProxy(proxy)).toBe(true);

    for (const value of [withExtra, inherited, accessor, sparse, proxy]) {
      await expect(repository.write(value as ActiveExperts, 0)).rejects.toMatchObject({
        name: "ActiveExpertValidationError",
        code: "ACTIVE_EXPERT_INVALID_INPUT",
      });
    }
  });

  it.each([-1, 1.5, Number.MAX_SAFE_INTEGER + 1])(
    "rejects invalid revision %s",
    async (revision) => {
      const root = await projectionRoot();
      await expect(new ActiveExpertRepository(root).write(
        { revision, experts: [] },
        0,
      )).rejects.toMatchObject({ code: "ACTIVE_EXPERT_INVALID_INPUT" });
    },
  );

  it("fails fast on impossible array lengths and huge raw strings", async () => {
    const root = await projectionRoot();
    const repository = new ActiveExpertRepository(root);
    const experts = new Array(ACTIVE_EXPERT_FILE_MAX_BYTES + 1);
    Object.defineProperty(experts, "0", {
      enumerable: true,
      get: () => { throw new Error("must not inspect elements"); },
    });

    await expect(repository.write({ revision: 1, experts } as ActiveExperts, 0)).rejects.toMatchObject({
      code: "ACTIVE_EXPERT_INVALID_INPUT",
    });
    await expect(repository.write(state(1, [entry(undefined, " ".repeat(5_000) + "中")]), 0))
      .rejects.toMatchObject({ code: "ACTIVE_EXPERT_INVALID_INPUT" });
  });

  it("enforces the serialized byte boundary before touching an uninitialized workspace", async () => {
    const root = await temporaryRoot();
    const experts = Array.from({ length: 300 }, (_, index) => entry(
      `ezagent.test.large${index + 1}`,
      "中".repeat(4_096),
      [`TASK-20260820-${String(index + 1).padStart(3, "0")}`],
    ));

    await expect(new ActiveExpertRepository(root).write(state(1, experts), 0)).rejects.toMatchObject({
      code: "ACTIVE_EXPERT_INVALID_INPUT",
    });
    await expect(readdir(root)).resolves.toEqual([]);
  });

  it("charges a shared large task array on every logical expansion before re-reading elements", async () => {
    const root = await temporaryRoot();
    const sharedTaskIds = Array.from({ length: 11_000 }, (_, index) =>
      `TASK-20260820-${String(index + 1).padStart(3, "0")}`);
    const experts = Array.from({ length: 5 }, (_, index) =>
      entry(`ezagent.test.shared${index + 1}`, `覆盖共享能力 ${index + 1}`, sharedTaskIds));
    const descriptor = vi.spyOn(Object, "getOwnPropertyDescriptor");

    try {
      await expect(new ActiveExpertRepository(root).write(state(1, experts), 0)).rejects.toMatchObject({
        code: "ACTIVE_EXPERT_INVALID_INPUT",
      });
      const elementReads = descriptor.mock.calls.filter(([target, key]) =>
        target === sharedTaskIds && key !== "length").length;
      expect(elementReads).toBeGreaterThan(0);
      expect(elementReads).toBeLessThanOrEqual(33_001);
      await expect(readdir(root)).resolves.toEqual([]);
    } finally {
      descriptor.mockRestore();
    }
  });

  it("accepts the largest canonical projection at the byte boundary and rejects one byte more", async () => {
    const experts: ReturnType<typeof entry>[] = [];
    let sequence = 1;
    for (;;) {
      const candidate = entry(
        `ezagent.limit.expert${sequence}`,
        "x".repeat(4_096),
        [`TASK-20260820-${String(sequence).padStart(3, "0")}`],
      );
      if (Buffer.byteLength(canonicalText(state(1, [...experts, candidate])), "utf8")
        > ACTIVE_EXPERT_FILE_MAX_BYTES) break;
      experts.push(candidate);
      sequence += 1;
    }
    const filler = entry(
      `ezagent.limit.expert${sequence}`,
      "x",
      [`TASK-20260820-${String(sequence).padStart(3, "0")}`],
    );
    const minimum = Buffer.byteLength(canonicalText(state(1, [...experts, filler])), "utf8");
    const fillerLength = 1 + ACTIVE_EXPERT_FILE_MAX_BYTES - minimum;
    expect(fillerLength).toBeGreaterThan(0);
    expect(fillerLength).toBeLessThan(4_096);
    const exactExperts = [...experts, { ...filler, reason: "x".repeat(fillerLength) }];
    expect(Buffer.byteLength(canonicalText(state(1, exactExperts)), "utf8"))
      .toBe(ACTIVE_EXPERT_FILE_MAX_BYTES);

    const exactRoot = await temporaryRoot();
    const exactRepository = new ActiveExpertRepository(exactRoot);
    await exactRepository.write(state(1, exactExperts), 0);
    expect((await lstat(await activePath(exactRoot))).size).toBe(ACTIVE_EXPERT_FILE_MAX_BYTES);
    expect((await exactRepository.read()).experts).toHaveLength(exactExperts.length);

    const overRoot = await temporaryRoot();
    const overExperts = exactExperts.map((expert, index) => index === exactExperts.length - 1
      ? { ...expert, reason: `${expert.reason}x` }
      : expert);
    await expect(new ActiveExpertRepository(overRoot).write(state(1, overExperts), 0))
      .rejects.toMatchObject({ code: "ACTIVE_EXPERT_INVALID_INPUT" });
    await expect(readdir(overRoot)).resolves.toEqual([]);
  });

  it("reads ordinary CRLF YAML and canonicalizes it on the next write", async () => {
    const root = await projectionRoot();
    const path = await activePath(root);
    await writeFile(path, [
      "revision: 1",
      "experts:",
      "  - id: ezagent.engineering.frontend",
      "    reason: 覆盖前端",
      "    taskIds: [TASK-20260820-001]",
      "",
    ].join("\r\n"), "utf8");
    const repository = new ActiveExpertRepository(root);

    await expect(repository.read()).resolves.toEqual(state(1, [
      entry("ezagent.engineering.frontend", "覆盖前端"),
    ]));
    await repository.write(state(2, [entry("ezagent.engineering.frontend", "覆盖前端")]), 1);
    expect(await readFile(path, "utf8")).not.toContain("\r");
  });

  it.each([
    ["empty YAML", ""],
    ["extra top-level key", "revision: 0\nexperts: []\nschemaVersion: 1\n"],
    ["duplicate key", "revision: 0\nrevision: 1\nexperts: []\n"],
    ["alias", "revision: &revision 0\nexperts: []\ncopy: *revision\n"],
    ["explicit tag", "revision: !!int 0\nexperts: []\n"],
    ["merge key", "revision: 0\nexperts:\n  - <<: {id: ezagent.bad}\n"],
    ["prototype key", "revision: 0\nexperts: []\n__proto__: true\n"],
    ["multiple documents", "revision: 0\nexperts: []\n---\nrevision: 1\nexperts: []\n"],
    ["YAML directive", "%YAML 1.2\n---\nrevision: 0\nexperts: []\n"],
    ["document marker", "---\nrevision: 0\nexperts: []\n"],
    ["lone carriage return", "revision: 0\rexperts: []\n"],
    ["too deep", `revision: 0\nexperts: ${"[".repeat(40)}${"]".repeat(40)}\n`],
  ])("fails closed on %s", async (_label, yaml) => {
    const root = await projectionRoot();
    const path = await activePath(root);
    await writeFile(path, yaml, "utf8");

    await expect(new ActiveExpertRepository(root).read()).rejects.toMatchObject({
      name: "ActiveExpertValidationError",
      code: "ACTIVE_EXPERT_FILE_INVALID",
      message: "Active expert file is invalid",
    });
  });

  it("rejects an oversized file, a BOM, and invalid UTF-8", async () => {
    const root = await projectionRoot();
    const path = await activePath(root);
    const repository = new ActiveExpertRepository(root);

    for (const bytes of [
      Buffer.alloc(ACTIVE_EXPERT_FILE_MAX_BYTES + 1, 0x20),
      Buffer.from([0xef, 0xbb, 0xbf, ...Buffer.from("revision: 0\nexperts: []\n")]),
      Buffer.from([0xc3, 0x28]),
    ]) {
      await writeFile(path, bytes);
      await expect(repository.read()).rejects.toMatchObject({ code: "ACTIVE_EXPERT_FILE_INVALID" });
    }
  });

  it("does not treat a corrupt projection as missing or reset it during write", async () => {
    const root = await projectionRoot();
    const path = await activePath(root);
    const corrupt = "revision: [not valid state]\nexperts: []\n";
    await writeFile(path, corrupt, "utf8");

    await expect(new ActiveExpertRepository(root).write(state(1), 0)).rejects.toMatchObject({
      code: "ACTIVE_EXPERT_FILE_INVALID",
    });
    await expect(readFile(path, "utf8")).resolves.toBe(corrupt);
  });

  it("rejects a structurally wide YAML document within the byte limit", async () => {
    const root = await projectionRoot();
    const path = await activePath(root);
    const yaml = `revision: 0\nexperts: [${"0,".repeat(70_000)}0]\n`;
    expect(Buffer.byteLength(yaml, "utf8")).toBeLessThan(ACTIVE_EXPERT_FILE_MAX_BYTES);
    await writeFile(path, yaml, "utf8");

    await expect(new ActiveExpertRepository(root).read()).rejects.toMatchObject({
      code: "ACTIVE_EXPERT_FILE_INVALID",
    });
  });

  it("rejects an active-file symlink without following or replacing it", async ({ skip }) => {
    const root = await projectionRoot();
    const path = await activePath(root);
    const external = join(await realpath(root), "external-active.yaml");
    await writeFile(external, EXTERNAL_SENTINEL, "utf8");
    try {
      await symlink(external, path, "file");
    } catch (error: unknown) {
      if (["EACCES", "ENOSYS", "ENOTSUP", "EPERM"].includes(
        (error as NodeJS.ErrnoException).code ?? "",
      )) {
        skip();
        return;
      }
      throw error;
    }
    const repository = new ActiveExpertRepository(root);

    await expect(repository.read()).rejects.toMatchObject({ code: "ACTIVE_EXPERT_FILE_INVALID" });
    await expect(repository.write(state(1), 0)).rejects.toMatchObject({
      code: "ACTIVE_EXPERT_FILE_INVALID",
    });
    await expect(readFile(external, "utf8")).resolves.toBe(EXTERNAL_SENTINEL);
    expect((await lstat(path)).isSymbolicLink()).toBe(true);
  });

  it("rejects a linked experts directory and never writes outside the workspace", async ({ skip }) => {
    const root = await projectionRoot();
    const canonicalRoot = await realpath(root);
    const experts = dirname(await activePath(root));
    const external = join(canonicalRoot, "external-experts");
    await rm(experts, { recursive: true });
    await mkdir(external);
    await writeFile(join(external, "sentinel.txt"), EXTERNAL_SENTINEL, "utf8");
    if (!await createDirectorySymlink(external, experts)) {
      skip();
      return;
    }
    const repository = new ActiveExpertRepository(root);

    await expect(repository.read()).rejects.toBeInstanceOf(WorkspaceCorruptError);
    await expect(repository.write(state(1), 0)).rejects.toBeInstanceOf(WorkspaceCorruptError);
    await expect(readdir(external)).resolves.toEqual(["sentinel.txt"]);
    await expect(readFile(join(external, "sentinel.txt"), "utf8")).resolves.toBe(EXTERNAL_SENTINEL);
  });
});

describe("active file open flags", () => {
  it("uses O_NOFOLLOW on POSIX when available and omits it on Windows", () => {
    const fake = { O_RDONLY: 1, O_CLOEXEC: 2, O_NOFOLLOW: 4 };
    expect(activeExpertOpenFlags("darwin", fake)).toBe(7);
    expect(activeExpertOpenFlags("win32", fake)).toBe(3);
    expect(activeExpertOpenFlags("linux", { ...fake, O_NOFOLLOW: undefined })).toBe(3);
    expect(activeExpertOpenFlags(process.platform, constants)).toBeGreaterThanOrEqual(0);
  });
});
