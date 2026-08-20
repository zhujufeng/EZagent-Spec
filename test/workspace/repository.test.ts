import {
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rm,
  stat,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";

import { afterEach, describe, expect, test } from "vitest";

import {
  WorkspaceCorruptError,
  WorkspaceNotInitializedError,
} from "../../src/workspace/errors.js";
import { WORKSPACE_DIRECTORIES, workspacePaths } from "../../src/workspace/layout.js";
import { WorkspaceRepository } from "../../src/workspace/repository.js";
import type { ProjectConfig } from "../../src/workspace/schema.js";

const temporaryRoots: string[] = [];
const demoConfig: ProjectConfig = { schemaVersion: 1, name: "Demo", gitTracking: "none" };
const initialState = {
  schemaVersion: 1,
  revision: 0,
  activeWorkItem: null,
  safeMode: false,
};

async function temporaryProject(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "ezagent-repository-"));
  temporaryRoots.push(root);
  return root;
}

async function treeEntries(root: string): Promise<{ directories: string[]; files: string[] }> {
  const directories: string[] = [];
  const files: string[] = [];

  async function visit(current: string): Promise<void> {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const path = join(current, entry.name);
      const name = relative(root, path);
      if (entry.isDirectory()) {
        directories.push(name);
        await visit(path);
      } else {
        files.push(name);
      }
    }
  }

  await visit(root);
  return { directories: directories.sort(), files: files.sort() };
}

async function rejected(operation: Promise<unknown>): Promise<Error> {
  try {
    await operation;
  } catch (error: unknown) {
    expect(error).toBeInstanceOf(Error);
    return error as Error;
  }
  throw new Error("Expected operation to reject");
}

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("WorkspaceRepository.initialize", () => {
  test("creates the exact workspace tree and canonical initial files", async () => {
    const root = await temporaryProject();
    const repository = new WorkspaceRepository(root);

    await repository.initialize(demoConfig);

    const paths = workspacePaths(root);
    const tree = await treeEntries(paths.root);
    expect(tree.directories).toEqual([
      "audit",
      "backups",
      "experts",
      "knowledge",
      "knowledge/decisions",
      "knowledge/patterns",
      "quality",
      "quality/authorizations",
      "quality/runs",
      "requirements",
      "specs",
      "state",
      "tasks",
    ]);
    expect(tree.files).toEqual(["audit/events.jsonl", "project.yaml", "state/workspace.json"]);
    expect(WORKSPACE_DIRECTORIES.every((directory) => tree.directories.includes(directory))).toBe(true);
    await expect(readFile(paths.project, "utf8")).resolves.toBe(
      "schemaVersion: 1\nname: Demo\ngitTracking: none\n",
    );
    await expect(readFile(paths.state, "utf8")).resolves.toBe(`${JSON.stringify(initialState, null, 2)}\n`);
    await expect(readFile(paths.audit, "utf8")).resolves.toBe("");
    await expect(repository.readProject()).resolves.toEqual(demoConfig);
    await expect(repository.readState()).resolves.toEqual(initialState);
  });

  test("normalizes input before any filesystem side effect", async () => {
    const root = await temporaryProject();
    const repository = new WorkspaceRepository(root);

    await expect(repository.initialize({
      schemaVersion: 1,
      name: "   ",
      gitTracking: "none",
    })).rejects.toThrow();

    expect(await readdir(root)).toEqual([]);

    await repository.initialize({ schemaVersion: 1, name: "  Demo  " } as ProjectConfig);
    await expect(repository.readProject()).resolves.toEqual(demoConfig);
  });

  test("rejects unsupported input keys before any filesystem side effect", async () => {
    const root = await temporaryProject();
    const repository = new WorkspaceRepository(root);
    const config = JSON.parse(
      '{"schemaVersion":1,"name":"Demo","gitTracking":"none","__proto__":true}',
    ) as ProjectConfig;

    await expect(repository.initialize(config)).rejects.toThrow("unsupported key");
    expect(await readdir(root)).toEqual([]);
  });

  test("is a semantic no-op for an already initialized equivalent config", async () => {
    const root = await temporaryProject();
    const repository = new WorkspaceRepository(root);
    const paths = workspacePaths(root);
    await repository.initialize(demoConfig);

    const state = `${JSON.stringify({ ...initialState, revision: 7 }, null, 2)}\n`;
    const audit = '{"sequence":1}\n';
    const reorderedProject = "gitTracking: none\nname: '  Demo  '\nschemaVersion: 1\n";
    await writeFile(paths.project, reorderedProject, "utf8");
    await writeFile(paths.state, state, "utf8");
    await writeFile(paths.audit, audit, "utf8");
    const fixedTime = new Date("2025-01-02T03:04:05.000Z");
    await Promise.all([
      utimes(paths.project, fixedTime, fixedTime),
      utimes(paths.state, fixedTime, fixedTime),
      utimes(paths.audit, fixedTime, fixedTime),
    ]);
    const before = await Promise.all([stat(paths.project), stat(paths.state), stat(paths.audit)]);

    await repository.initialize({ ...demoConfig });

    expect(await Promise.all([
      readFile(paths.project, "utf8"),
      readFile(paths.state, "utf8"),
      readFile(paths.audit, "utf8"),
    ])).toEqual([reorderedProject, state, audit]);
    const after = await Promise.all([stat(paths.project), stat(paths.state), stat(paths.audit)]);
    expect(after.map(({ mtimeMs }) => mtimeMs)).toEqual(before.map(({ mtimeMs }) => mtimeMs));
  });

  test.each([
    { schemaVersion: 1, name: "Other", gitTracking: "none" },
    { schemaVersion: 1, name: "Demo", gitTracking: "artifacts" },
  ] as const)("refuses different initialized configuration %#", async (differentConfig) => {
    const root = await temporaryProject();
    const repository = new WorkspaceRepository(root);
    const paths = workspacePaths(root);
    await repository.initialize(demoConfig);
    const before = await Promise.all([
      readFile(paths.project, "utf8"),
      readFile(paths.state, "utf8"),
      readFile(paths.audit, "utf8"),
    ]);

    await expect(repository.initialize(differentConfig)).rejects.toThrow("already initialized");

    expect(await Promise.all([
      readFile(paths.project, "utf8"),
      readFile(paths.state, "utf8"),
      readFile(paths.audit, "utf8"),
    ])).toEqual(before);
  });

  test("retries an uncommitted partial initialization safely", async () => {
    const root = await temporaryProject();
    const repository = new WorkspaceRepository(root);
    const paths = workspacePaths(root);
    await mkdir(join(paths.root, "state"), { recursive: true });
    await mkdir(join(paths.root, "audit"), { recursive: true });
    await writeFile(paths.state, "partial state", "utf8");
    await writeFile(paths.audit, "partial audit", "utf8");

    await repository.initialize(demoConfig);

    await expect(readFile(paths.state, "utf8")).resolves.toBe(`${JSON.stringify(initialState, null, 2)}\n`);
    await expect(readFile(paths.audit, "utf8")).resolves.toBe("");
    await expect(repository.readProject()).resolves.toEqual(demoConfig);
  });

  test("writes the project completion marker last and can retry after a failed commit", async () => {
    const root = await temporaryProject();
    const repository = new WorkspaceRepository(root);
    const paths = workspacePaths(root);
    await mkdir(paths.audit, { recursive: true });

    await expect(repository.initialize(demoConfig)).rejects.toBeInstanceOf(Error);
    await expect(readFile(paths.project, "utf8")).rejects.toMatchObject({ code: "ENOENT" });

    await rm(paths.audit, { recursive: true });
    await repository.initialize(demoConfig);
    await expect(repository.readProject()).resolves.toEqual(demoConfig);
    await expect(repository.readState()).resolves.toEqual(initialState);
  });

  test("never repairs user files once the project completion marker exists", async () => {
    const root = await temporaryProject();
    const repository = new WorkspaceRepository(root);
    const paths = workspacePaths(root);
    await mkdir(join(paths.root, "audit"), { recursive: true });
    await writeFile(paths.project, "schemaVersion: 1\nname: Demo\ngitTracking: none\n", "utf8");
    await writeFile(paths.audit, "user audit\n", "utf8");

    await repository.initialize(demoConfig);

    await expect(readFile(paths.audit, "utf8")).resolves.toBe("user audit\n");
    await expect(readFile(paths.state, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    await expect(repository.readState()).rejects.toBeInstanceOf(WorkspaceCorruptError);
  });

  test("allows concurrent equivalent initialization to converge", async () => {
    const root = await temporaryProject();
    const first = new WorkspaceRepository(root);
    const second = new WorkspaceRepository(root);

    await expect(Promise.all([first.initialize(demoConfig), second.initialize({ ...demoConfig })])).resolves.toEqual([
      undefined,
      undefined,
    ]);
    await expect(first.readProject()).resolves.toEqual(demoConfig);
    await expect(first.readState()).resolves.toEqual(initialState);
  });

  test("allows only one of two different concurrent configurations to win", async () => {
    const root = await temporaryProject();
    const repository = new WorkspaceRepository(root);
    const otherConfig: ProjectConfig = { schemaVersion: 1, name: "Other", gitTracking: "all" };

    const results = await Promise.allSettled([
      repository.initialize(demoConfig),
      repository.initialize(otherConfig),
    ]);

    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const rejectedResult = results.find((result) => result.status === "rejected");
    expect(rejectedResult).toMatchObject({
      status: "rejected",
      reason: expect.objectContaining({ message: expect.stringContaining("already initialized") }),
    });
    const winner = await repository.readProject();
    expect([demoConfig, otherConfig]).toContainEqual(winner);
  });

  test("refuses to overwrite a corrupt project completion marker", async () => {
    const root = await temporaryProject();
    const repository = new WorkspaceRepository(root);
    const paths = workspacePaths(root);
    await mkdir(paths.root, { recursive: true });
    await writeFile(paths.project, "broken: [", "utf8");

    const error = await rejected(repository.initialize(demoConfig));

    expect(error).toBeInstanceOf(WorkspaceCorruptError);
    expect(error.message).toContain(paths.project);
    expect(error.cause).toBeInstanceOf(Error);
    await expect(readFile(paths.project, "utf8")).resolves.toBe("broken: [");
  });
});

describe("WorkspaceRepository reads", () => {
  test.each(["readProject", "readState"] as const)(
    "%s reports an uninitialized workspace with path and cause",
    async (method) => {
      const root = await temporaryProject();
      const repository = new WorkspaceRepository(root);
      const project = workspacePaths(root).project;

      const error = await rejected(repository[method]());

      expect(error).toBeInstanceOf(WorkspaceNotInitializedError);
      expect(error.message).toContain(project);
      expect(error.cause).toMatchObject({ code: "ENOENT" });
    },
  );

  test("reports corrupt project YAML with path and cause", async () => {
    const root = await temporaryProject();
    const repository = new WorkspaceRepository(root);
    const paths = workspacePaths(root);
    await mkdir(paths.root, { recursive: true });
    await writeFile(paths.project, "schemaVersion: [", "utf8");

    const error = await rejected(repository.readProject());

    expect(error).toBeInstanceOf(WorkspaceCorruptError);
    expect(error.message).toContain(paths.project);
    expect(error.cause).toBeInstanceOf(Error);
  });

  test.each([
    { label: "missing", contents: undefined },
    { label: "invalid JSON", contents: "{" },
    { label: "invalid schema", contents: '{"schemaVersion":1,"revision":-1,"activeWorkItem":null,"safeMode":false}' },
  ])("reports a $label state as corrupt with path and cause", async ({ contents }) => {
    const root = await temporaryProject();
    const repository = new WorkspaceRepository(root);
    const paths = workspacePaths(root);
    await mkdir(paths.root, { recursive: true });
    await writeFile(paths.project, "schemaVersion: 1\nname: Demo\ngitTracking: none\n", "utf8");
    if (contents !== undefined) {
      await mkdir(join(paths.root, "state"), { recursive: true });
      await writeFile(paths.state, contents, "utf8");
    }

    const error = await rejected(repository.readState());

    expect(error).toBeInstanceOf(WorkspaceCorruptError);
    expect(error.message).toContain(paths.state);
    expect(error.cause).toBeDefined();
  });
});
