import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, posix, relative, resolve, win32 } from "node:path";

import { afterEach, describe, expect, test } from "vitest";

import { workspacePaths } from "../../src/workspace/layout.js";
import {
  targetPath,
  validateArtifactRelativePath,
  type WorkspaceMutationWrite,
} from "../../src/workspace/mutation.js";
import { WorkspaceRepository } from "../../src/workspace/repository.js";
import type { WorkspaceState } from "../../src/workspace/schema.js";

const REPOSITORY_ROOT = resolve(import.meta.dirname, "../..");
const temporaryRoots: string[] = [];
const initialState: WorkspaceState = {
  schemaVersion: 1,
  revision: 0,
  activeWorkItem: null,
  safeMode: false,
};
const nextState: WorkspaceState = { ...initialState, revision: 1 };

async function temporaryProject(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "ezagent-cross-platform-"));
  temporaryRoots.push(root);
  return root;
}

async function treeSnapshot(root: string): Promise<readonly string[]> {
  const snapshot: string[] = [];

  async function visit(current: string): Promise<void> {
    const entries = await readdir(current, { withFileTypes: true });
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name, "en"))) {
      const path = join(current, entry.name);
      const relativePath = relative(root, path);
      if (entry.isDirectory()) {
        snapshot.push(`directory:${relativePath}`);
        await visit(path);
      } else {
        snapshot.push(`file:${relativePath}:${(await readFile(path)).toString("base64")}`);
      }
    }
  }

  await visit(root);
  return snapshot;
}

async function expectRejectedWithoutMutation(
  repository: WorkspaceRepository,
  workspaceRoot: string,
  writes: readonly WorkspaceMutationWrite[],
): Promise<void> {
  const before = await treeSnapshot(workspaceRoot);
  await expect(repository.commitMutation(nextState, 0, "workspace-updated", writes)).rejects.toThrow();
  await expect(treeSnapshot(workspaceRoot)).resolves.toEqual(before);
}

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("cross-platform workspace contracts", () => {
  test("derives every workspace path through the selected platform path API", () => {
    expect(workspacePaths("project", posix)).toEqual({
      root: "project/.ezagent",
      project: "project/.ezagent/project.yaml",
      state: "project/.ezagent/state/workspace.json",
      lock: "project/.ezagent/state/write.lock",
      audit: "project/.ezagent/audit/events.jsonl",
      pendingMutation: "project/.ezagent/state/pending-mutation.json",
    });
    expect(workspacePaths("C:\\project", win32)).toEqual({
      root: "C:\\project\\.ezagent",
      project: "C:\\project\\.ezagent\\project.yaml",
      state: "C:\\project\\.ezagent\\state\\workspace.json",
      lock: "C:\\project\\.ezagent\\state\\write.lock",
      audit: "C:\\project\\.ezagent\\audit\\events.jsonl",
      pendingMutation: "C:\\project\\.ezagent\\state\\pending-mutation.json",
    });
    expect(workspacePaths("\\\\server\\share\\project", win32).state).toBe(
      "\\\\server\\share\\project\\.ezagent\\state\\workspace.json",
    );
  });

  test("rejects Windows escape forms and reserved names before filesystem side effects", async () => {
    const root = await temporaryProject();
    const repository = new WorkspaceRepository(root);
    await repository.initialize({ schemaVersion: 1, name: "跨平台项目", gitTracking: "none" });
    const paths = workspacePaths(root);

    for (const relativePath of [
      "C:/outside/spec.md",
      "//server/share/spec.md",
      "requirements\\outside.md",
      "requirements/CON.md",
    ]) {
      await expectRejectedWithoutMutation(repository, paths.root, [{ relativePath, content: "blocked" }]);
    }
  });

  test("rejects portable Unicode filename collisions before filesystem side effects", async () => {
    const root = await temporaryProject();
    const repository = new WorkspaceRepository(root);
    await repository.initialize({ schemaVersion: 1, name: "Unicode", gitTracking: "none" });

    await expectRejectedWithoutMutation(repository, workspacePaths(root).root, [
      { relativePath: "requirements/Ａ.md", content: "full width" },
      { relativePath: "requirements/A.md", content: "ascii" },
    ]);
  });

  test("maps a valid forward-slash artifact path to the host filesystem target", async () => {
    const root = await temporaryProject();
    const repository = new WorkspaceRepository(root);
    await repository.initialize({ schemaVersion: 1, name: "Artifacts", gitTracking: "none" });
    const paths = workspacePaths(root);
    const relativePath = validateArtifactRelativePath("knowledge/decisions/ADR-0001.md");
    const expectedTarget = join(paths.root, "knowledge", "decisions", "ADR-0001.md");

    expect(relativePath).toBe("knowledge/decisions/ADR-0001.md");
    expect(targetPath(paths.root, relativePath)).toBe(expectedTarget);
    await repository.commitMutation(nextState, 0, "workspace-updated", [
      { relativePath, content: "# Decision\n" },
    ]);
    await expect(readFile(expectedTarget, "utf8")).resolves.toBe("# Decision\n");
  });

  test("uses npm bin metadata and Node scripts instead of POSIX-only package commands", async () => {
    const packageJson = JSON.parse(await readFile(join(REPOSITORY_ROOT, "package.json"), "utf8")) as {
      readonly bin: Readonly<Record<string, string>>;
      readonly engines: Readonly<Record<string, string>>;
      readonly scripts: Readonly<Record<string, string>>;
    };
    const cliSource = await readFile(join(REPOSITORY_ROOT, "src", "cli", "main.ts"), "utf8");

    expect(packageJson.engines.node).toBe(">=22");
    expect(packageJson.bin).toEqual({ ezagent: "./dist/src/cli/main.js" });
    expect(packageJson.scripts.build).toBe("tsc -p tsconfig.json");
    expect(packageJson.scripts.postbuild).toBe("node scripts/set-cli-executable.mjs");
    expect(Object.values(packageJson.scripts).join("\n")).not.toMatch(/(?:^|[;&|])\s*chmod\b/mu);
    expect(cliSource.startsWith("#!/usr/bin/env node\n")).toBe(true);
  });
});
