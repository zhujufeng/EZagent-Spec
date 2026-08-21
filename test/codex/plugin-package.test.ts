import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  appendFile,
  cp,
  lstat,
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, relative, resolve, sep } from "node:path";

import type { Metafile } from "esbuild";
import { afterEach, describe, expect, test } from "vitest";

import {
  ALLOWED_BUNDLE_IMPORTS,
  auditBundleMetafile,
  buildPlugin,
  checkPlugin,
  PluginPublicationError,
} from "../../scripts/build-plugin.js";
import {
  collectRuntimeLicenses,
  readStableRelativeFile,
} from "../../scripts/collect-runtime-licenses.js";

const REPOSITORY_ROOT = resolve(import.meta.dirname, "../..");
const SOURCE_PLUGIN_ROOT = join(REPOSITORY_ROOT, "plugins", "ezagent-spec");
const temporaryRoots: string[] = [];

interface TreeEntry {
  readonly path: string;
  readonly mode: number;
  readonly size: number;
  readonly sha256: string;
}

interface FakePackage {
  readonly key: string;
  readonly name: string;
  readonly version: string;
  readonly license?: string;
  readonly dependencies?: Readonly<Record<string, string>>;
}

function compareStable(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

async function temporaryDirectory(prefix: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  temporaryRoots.push(root);
  return root;
}

async function treeSnapshot(root: string): Promise<readonly TreeEntry[]> {
  const entries: TreeEntry[] = [];

  async function visit(directory: string): Promise<void> {
    for (const name of (await readdir(directory)).sort(compareStable)) {
      const path = join(directory, name);
      const metadata = await lstat(path);
      expect(metadata.isSymbolicLink(), `generated symlink: ${path}`).toBe(false);
      if (metadata.isDirectory()) {
        await visit(path);
        continue;
      }
      expect(metadata.isFile(), `generated non-file: ${path}`).toBe(true);
      const contents = await readFile(path);
      entries.push({
        path: relative(root, path).split(sep).join("/"),
        mode: metadata.mode & 0o777,
        size: contents.byteLength,
        sha256: createHash("sha256").update(contents).digest("hex"),
      });
    }
  }

  await visit(root);
  return entries.sort((left, right) => compareStable(left.path, right.path));
}

function syntheticMetafile(inputs: readonly string[]): Metafile {
  return {
    inputs: Object.fromEntries(inputs.map((path) => [path, { bytes: 1, imports: [] }])),
    outputs: {},
  };
}

function importMetafile(
  imports: readonly { readonly path: string; readonly kind: string; readonly external: boolean }[],
): Metafile {
  return {
    inputs: {},
    outputs: {
      "dist/ezagent-cli.mjs": {
        bytes: 1,
        inputs: {},
        imports: imports as never,
        exports: [],
        entryPoint: "src/cli/main.ts",
      },
    },
  };
}

async function writeRelative(root: string, path: string, contents: string): Promise<void> {
  const absolute = join(root, path);
  await mkdir(resolve(absolute, ".."), { recursive: true });
  await writeFile(absolute, contents, "utf8");
}

async function createFakeRepository(
  packages: readonly FakePackage[],
  rootDependencies: Readonly<Record<string, string>>,
): Promise<string> {
  const root = await temporaryDirectory("ezagent-plugin-license-repo-");
  await writeRelative(root, "THIRD_PARTY_NOTICES.md", "third party notices\n");
  await writeRelative(root, "licenses/agency-agents-MIT.txt", "agency license\n");
  await writeRelative(root, "licenses/agency-agents-zh-MIT.txt", "agency zh license\n");
  await writeRelative(root, "licenses/UNICODE-LICENSE.txt", "unicode license\n");
  const lockPackages: Record<string, unknown> = {
    "": { dependencies: rootDependencies },
  };
  for (const entry of packages) {
    const license = entry.license ?? "MIT";
    lockPackages[entry.key] = {
      version: entry.version,
      license,
      ...(entry.dependencies === undefined ? {} : { dependencies: entry.dependencies }),
    };
    await writeRelative(root, `${entry.key}/package.json`, `${JSON.stringify({
      name: entry.name,
      version: entry.version,
      license,
    })}\n`);
    await writeRelative(root, `${entry.key}/LICENSE`, `${entry.name} license\n`);
  }
  await writeRelative(root, "package-lock.json", `${JSON.stringify({
    lockfileVersion: 3,
    packages: lockPackages,
  })}\n`);
  await mkdir(join(root, "node_modules"), { recursive: true });
  return root;
}

async function runNode(
  script: string,
  args: readonly string[],
): Promise<{ readonly code: number | null; readonly stdout: string; readonly stderr: string }> {
  return new Promise((fulfill, reject) => {
    const child = spawn(process.execPath, [script, ...args], {
      cwd: REPOSITORY_ROOT,
      env: process.env,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => { stdout += chunk; });
    child.stderr.on("data", (chunk: string) => { stderr += chunk; });
    child.once("error", reject);
    child.once("close", (code) => fulfill({ code, stdout, stderr }));
  });
}

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe.sequential("self-contained Codex plugin package", () => {
  test("builds the complete verified distribution twice with byte-for-byte stable output", async () => {
    const first = await temporaryDirectory("ezagent-plugin-first-");
    const second = await temporaryDirectory("ezagent-plugin-second-");

    await buildPlugin(first);
    await buildPlugin(second);

    const firstTree = await treeSnapshot(first);
    const secondTree = await treeSnapshot(second);
    expect(secondTree).toEqual(firstTree);
    expect(await treeSnapshot(SOURCE_PLUGIN_ROOT)).toEqual(firstTree);

    const paths = firstTree.map((entry) => entry.path);
    expect(paths).toHaveLength(16);
    expect(paths).toContain(".codex-plugin/plugin.json");
    expect(paths.filter((path) => /^skills\/[^/]+\/SKILL\.md$/u.test(path))).toHaveLength(5);
    expect(paths).toContain("dist/ezagent-cli.mjs");
    expect(paths).toContain("catalog/experts.json");
    expect(paths).toContain("catalog/catalog.lock.json");
    expect(paths).toContain("THIRD_PARTY_NOTICES.md");
    expect(paths).toContain("RUNTIME_DEPENDENCIES.md");
    expect(paths).toContain("licenses/agency-agents-MIT.txt");
    expect(paths).toContain("licenses/agency-agents-zh-MIT.txt");
    expect(paths).toContain("licenses/UNICODE-LICENSE.txt");
    expect(paths).toContain("licenses/npm/yaml@2.9.0/LICENSE");
    expect(paths).toContain("licenses/npm/zod@4.4.3/LICENSE");

    expect(await readFile(join(first, ".codex-plugin", "plugin.json"))).toEqual(
      await readFile(join(SOURCE_PLUGIN_ROOT, ".codex-plugin", "plugin.json")),
    );
    for (const skill of [
      "ezagent-router",
      "ezagent-initialize",
      "ezagent-spec",
      "ezagent-implement",
      "ezagent-review",
    ]) {
      expect(await readFile(join(first, "skills", skill, "SKILL.md"))).toEqual(
        await readFile(join(SOURCE_PLUGIN_ROOT, "skills", skill, "SKILL.md")),
      );
    }

    expect(await readFile(join(first, "catalog", "experts.json"))).toEqual(
      await readFile(join(REPOSITORY_ROOT, "catalog", "normalized", "experts.json")),
    );
    expect(await readFile(join(first, "catalog", "catalog.lock.json"))).toEqual(
      await readFile(join(REPOSITORY_ROOT, "catalog", "normalized", "catalog.lock.json")),
    );
    for (const filename of [
      "agency-agents-MIT.txt",
      "agency-agents-zh-MIT.txt",
      "UNICODE-LICENSE.txt",
    ]) {
      expect(await readFile(join(first, "licenses", filename))).toEqual(
        await readFile(join(REPOSITORY_ROOT, "licenses", filename)),
      );
    }
    expect(await readFile(join(first, "THIRD_PARTY_NOTICES.md"))).toEqual(
      await readFile(join(REPOSITORY_ROOT, "THIRD_PARTY_NOTICES.md")),
    );
    expect(await readFile(join(first, "licenses", "npm", "yaml@2.9.0", "LICENSE"))).toEqual(
      await readFile(join(REPOSITORY_ROOT, "node_modules", "yaml", "LICENSE")),
    );
    expect(await readFile(join(first, "licenses", "npm", "zod@4.4.3", "LICENSE"))).toEqual(
      await readFile(join(REPOSITORY_ROOT, "node_modules", "zod", "LICENSE")),
    );

    const runtimeDependencies = await readFile(join(first, "RUNTIME_DEPENDENCIES.md"), "utf8");
    expect(runtimeDependencies).toContain("yaml@2.9.0");
    expect(runtimeDependencies).toContain("ISC");
    expect(runtimeDependencies).toContain("zod@4.4.3");
    expect(runtimeDependencies).toContain("MIT");
    expect(runtimeDependencies).not.toMatch(/\r/u);

    expect(paths.some((path) => /(?:^|\/)(?:source-lock|taxonomy|importer)(?:\.|\/)/iu.test(path))).toBe(false);
    expect(paths.some((path) => /(?:^|\/)(?:vendor-sources|test|tests|\.git|trellis)(?:\/|$)/iu.test(path))).toBe(false);
    expect(paths.some((path) => path.endsWith(".map"))).toBe(false);

    const bundlePath = join(first, "dist", "ezagent-cli.mjs");
    const bundle = await readFile(bundlePath, "utf8");
    expect(bundle.startsWith("#!/usr/bin/env node\n")).toBe(true);
    expect(bundle).not.toMatch(/[ \t]+$/mu);
    expect(bundle).not.toMatch(/\bfetch\s*\(/u);
    expect(bundle).not.toMatch(/(?:opentelemetry|sentry|telemetry sdk)/iu);
    expect(bundle).not.toMatch(/\bgit\s+(?:commit|push)\b/iu);
    expect(bundle).not.toContain("Trellis");
    const importSpecifiers = [...bundle.matchAll(
      /\b(?:import|export)(?:[^"'`;]*?\bfrom)?\s*["']([^"']+)["']/gu,
    )]
      .map((match) => match[1]);
    expect(importSpecifiers.length).toBeGreaterThan(0);
    expect(importSpecifiers.every((specifier) => specifier?.startsWith("node:"))).toBe(true);
    const requiredSpecifiers = [...bundle.matchAll(/\brequire\s*\(\s*["']([^"']+)["']/gu)]
      .map((match) => match[1]);
    expect(requiredSpecifiers.every((specifier) => specifier?.startsWith("node:"))).toBe(true);
    if (process.platform !== "win32") {
      expect((await stat(bundlePath)).mode & 0o777).toBe(0o755);
    }
  }, 15_000);

  test("passes hostile roots and names as argv without shell execution", async () => {
    const pluginRoot = await temporaryDirectory("ezagent-plugin-argv-");
    const projectsParent = await temporaryDirectory("ezagent-plugin-projects-");
    const marker = join(projectsParent, "must-not-exist");
    const projectRoot = join(projectsParent, `project;touch ${basename(marker)}`);
    await mkdir(projectRoot);
    await buildPlugin(pluginRoot);
    const cli = join(pluginRoot, "dist", "ezagent-cli.mjs");

    const preview = await runNode(cli, ["integration-preview", "--root", projectRoot]);
    expect(preview).toMatchObject({ code: 0, stderr: "" });
    const previewJson = JSON.parse(preview.stdout) as { readonly agentsToken: string };

    const hostileName = `Demo; touch ${marker}`;
    const initialized = await runNode(cli, [
      "integration-init",
      "--root",
      projectRoot,
      "--name",
      hostileName,
      "--agents-token",
      previewJson.agentsToken,
    ]);
    expect(initialized).toMatchObject({ code: 0, stderr: "" });
    await expect(lstat(marker)).rejects.toMatchObject({ code: "ENOENT" });
    expect((await readdir(projectRoot)).sort(compareStable)).toEqual([".ezagent", "AGENTS.md"]);
    expect((await readdir(projectsParent)).sort(compareStable)).toEqual([basename(projectRoot)]);
  }, 30_000);

  test("checks the committed package read-only and rejects generated CLI, catalog, or license drift", async () => {
    const committedBefore = await treeSnapshot(SOURCE_PLUGIN_ROOT);
    await expect(checkPlugin()).resolves.toBeUndefined();
    expect(await treeSnapshot(SOURCE_PLUGIN_ROOT)).toEqual(committedBefore);
    const packageJson = JSON.parse(await readFile(join(REPOSITORY_ROOT, "package.json"), "utf8")) as {
      readonly scripts: Readonly<Record<string, string>>;
    };
    expect(packageJson.scripts["plugin:build"]).not.toBe(packageJson.scripts["plugin:check"]);
    expect(packageJson.scripts["plugin:verify"]).toContain("plugin:check");
    expect(packageJson.scripts["plugin:verify"]).not.toContain("plugin:build");
    for (const tamperedPath of [
      "dist/ezagent-cli.mjs",
      "catalog/experts.json",
      "licenses/npm/yaml@2.9.0/LICENSE",
    ]) {
      const parent = await temporaryDirectory("ezagent-plugin-drift-");
      const candidate = join(parent, "plugin");
      await cp(SOURCE_PLUGIN_ROOT, candidate, { recursive: true });
      await appendFile(join(candidate, tamperedPath), "tampered\n", "utf8");
      const before = await treeSnapshot(candidate);
      await expect(checkPlugin(candidate)).rejects.toThrow(/plugin package drift/u);
      expect(await treeSnapshot(candidate)).toEqual(before);
    }
  });

  test("rejects equal-size in-place changes through stable bigint file identities", async () => {
    const root = await temporaryDirectory("ezagent-plugin-stable-read-");
    await writeRelative(root, "catalog/input.json", "AAAA");
    let changed = false;
    await expect(readStableRelativeFile(root, "catalog/input.json", 64, {
      afterDataRead: async ({ absolutePath }) => {
        changed = true;
        await writeFile(absolutePath, "BBBB", "utf8");
      },
    })).rejects.toThrow(/identity changed/u);
    expect(changed).toBe(true);
  });

  test("collects scoped and transitive production packages reachable from package-lock", async () => {
    const repository = await createFakeRepository([
      {
        key: "node_modules/@scope/direct",
        name: "@scope/direct",
        version: "1.0.0",
        dependencies: { transitive: "2.0.0" },
      },
      {
        key: "node_modules/@scope/direct/node_modules/transitive",
        name: "transitive",
        version: "2.0.0",
      },
    ], { "@scope/direct": "1.0.0" });
    const output = await temporaryDirectory("ezagent-plugin-license-output-");
    await collectRuntimeLicenses(output, syntheticMetafile([
      "node_modules/@scope/direct/index.js",
      "node_modules/@scope/direct/node_modules/transitive/index.js",
    ]), repository);

    expect(await readFile(join(output, "licenses/npm/@scope/direct@1.0.0/LICENSE"), "utf8"))
      .toBe("@scope/direct license\n");
    expect(await readFile(join(output, "licenses/npm/transitive@2.0.0/LICENSE"), "utf8"))
      .toBe("transitive license\n");
    expect(await readFile(join(output, "RUNTIME_DEPENDENCIES.md"), "utf8"))
      .toContain("@scope/direct@1.0.0");
  });

  test("rejects unreachable packages and duplicate normalized transitive license outputs", async () => {
    const unreachableRepository = await createFakeRepository([
      { key: "node_modules/direct", name: "direct", version: "1.0.0" },
      { key: "node_modules/rogue", name: "rogue", version: "1.0.0" },
    ], { direct: "1.0.0" });
    const unreachableOutput = await temporaryDirectory("ezagent-plugin-unreachable-output-");
    await expect(collectRuntimeLicenses(
      unreachableOutput,
      syntheticMetafile(["node_modules/rogue/index.js"]),
      unreachableRepository,
    )).rejects.toThrow(/unexpected bundled production package/u);

    const duplicateRepository = await createFakeRepository([
      { key: "node_modules/a", name: "a", version: "1.0.0", dependencies: { shared: "1.0.0-A" } },
      { key: "node_modules/b", name: "b", version: "1.0.0", dependencies: { shared: "1.0.0-a" } },
      { key: "node_modules/a/node_modules/shared", name: "shared", version: "1.0.0-A" },
      { key: "node_modules/b/node_modules/shared", name: "shared", version: "1.0.0-a" },
    ], { a: "1.0.0", b: "1.0.0" });
    const duplicateOutput = await temporaryDirectory("ezagent-plugin-duplicate-output-");
    await expect(collectRuntimeLicenses(
      duplicateOutput,
      syntheticMetafile([
        "node_modules/a/node_modules/shared/index.js",
        "node_modules/b/node_modules/shared/index.js",
      ]),
      duplicateRepository,
    )).rejects.toThrow(/duplicate normalized license output/u);
  });

  test("rejects symlinked license and installed-package ancestors without copying their bytes", async () => {
    if (process.platform === "win32") return;
    const licenseRepository = await createFakeRepository([
      { key: "node_modules/direct", name: "direct", version: "1.0.0" },
    ], { direct: "1.0.0" });
    const external = await temporaryDirectory("ezagent-plugin-external-input-");
    const externalLicenses = join(external, "licenses");
    await rename(join(licenseRepository, "licenses"), externalLicenses);
    await symlink(externalLicenses, join(licenseRepository, "licenses"), "dir");
    const licenseOutput = await temporaryDirectory("ezagent-plugin-license-symlink-output-");
    await expect(collectRuntimeLicenses(
      licenseOutput,
      syntheticMetafile(["node_modules/direct/index.js"]),
      licenseRepository,
    )).rejects.toThrow(/symlink|ancestor|directory/iu);
    await expect(lstat(join(licenseOutput, "licenses/agency-agents-MIT.txt")))
      .rejects.toMatchObject({ code: "ENOENT" });

    const packageRepository = await createFakeRepository([
      { key: "node_modules/@scope/direct", name: "@scope/direct", version: "1.0.0" },
    ], { "@scope/direct": "1.0.0" });
    const externalScope = join(external, "scope");
    await rename(join(packageRepository, "node_modules/@scope"), externalScope);
    await symlink(externalScope, join(packageRepository, "node_modules/@scope"), "dir");
    const packageOutput = await temporaryDirectory("ezagent-plugin-package-symlink-output-");
    await expect(collectRuntimeLicenses(
      packageOutput,
      syntheticMetafile(["node_modules/@scope/direct/index.js"]),
      packageRepository,
    )).rejects.toThrow(/symlink|ancestor|directory/iu);
    await expect(lstat(join(packageOutput, "licenses/npm/@scope/direct@1.0.0/LICENSE")))
      .rejects.toMatchObject({ code: "ENOENT" });
  });

  test("rejects an equal-size package license rewrite before copying it", async () => {
    const repository = await createFakeRepository([
      { key: "node_modules/direct", name: "direct", version: "1.0.0" },
    ], { direct: "1.0.0" });
    const output = await temporaryDirectory("ezagent-plugin-license-race-output-");
    let changed = false;
    await expect(collectRuntimeLicenses(
      output,
      syntheticMetafile(["node_modules/direct/index.js"]),
      repository,
      {
        stableReadHooks: {
          afterDataRead: async ({ absolutePath, relativePath }) => {
            if (relativePath !== "node_modules/direct/LICENSE") return;
            const contents = await readFile(absolutePath);
            await writeFile(absolutePath, Buffer.alloc(contents.byteLength, 0x58));
            changed = true;
          },
        },
      },
    )).rejects.toThrow(/identity changed/u);
    expect(changed).toBe(true);
    await expect(lstat(join(output, "licenses/npm/direct@1.0.0/LICENSE")))
      .rejects.toMatchObject({ code: "ENOENT" });
  });

  test("audits metafile imports against the exact non-network Node builtin allowlist", () => {
    expect(ALLOWED_BUNDLE_IMPORTS).toEqual([
      "node:crypto",
      "node:fs",
      "node:fs/promises",
      "node:path",
      "node:perf_hooks",
      "node:timers/promises",
      "node:url",
      "node:util",
    ]);
    expect(() => auditBundleMetafile(importMetafile([
      { path: "node:fs", kind: "import-statement", external: true },
      { path: "node:path", kind: "import-statement", external: true },
    ]))).not.toThrow();
    for (const forbidden of [
      { path: "external-package", kind: "dynamic-import", external: true },
      { path: "node:http", kind: "import-statement", external: true },
      { path: "node:https", kind: "import-statement", external: true },
      { path: "node:net", kind: "import-statement", external: true },
      { path: "node:tls", kind: "import-statement", external: true },
      { path: "node:dns", kind: "import-statement", external: true },
      { path: "node:dgram", kind: "import-statement", external: true },
      { path: "node:child_process", kind: "import-statement", external: true },
    ]) {
      expect(() => auditBundleMetafile(importMetafile([forbidden])))
        .toThrow(/forbidden bundle import/u);
    }
  });

  test("cleans its stage on repeated pre-publication root swaps", async () => {
    const parent = await temporaryDirectory("ezagent-plugin-prepublish-");
    const output = join(parent, "output");
    await mkdir(output);
    const baseline = (await readdir(parent)).length;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const displaced = join(parent, `displaced-${attempt}`);
      await expect(buildPlugin(output, {
        publicationHooks: {
          beforePublication: async () => {
            await rename(output, displaced);
            await mkdir(output);
          },
        },
      })).rejects.toThrow(/identity changed before publication/u);
      await rm(output, { recursive: true, force: true });
      await rename(displaced, output);
      expect((await readdir(parent)).filter((name) => name.startsWith(".ezagent-plugin-stage-")))
        .toEqual([]);
      expect((await readdir(parent)).length).toBe(baseline);
    }
  });

  test("retains explicit recovery paths after a post-change publication failure", async () => {
    const parent = await temporaryDirectory("ezagent-plugin-postpublish-");
    const output = join(parent, "output");
    await mkdir(output);
    let observed: unknown;
    try {
      await buildPlugin(output, {
        publicationHooks: {
          afterPublishedEntry: async () => { throw new Error("injected post-change failure"); },
        },
      });
    } catch (error: unknown) {
      observed = error;
    }
    expect(observed).toBeInstanceOf(PluginPublicationError);
    const publicationError = observed as PluginPublicationError;
    expect(publicationError.message).toContain(publicationError.stagePath);
    expect(publicationError.message).toContain(publicationError.recoveryPath);
    expect(publicationError.message).toContain(publicationError.backupPath);
    expect(await readdir(output)).toEqual([]);
    await expect(lstat(publicationError.stagePath)).resolves.toMatchObject({
      isDirectory: expect.any(Function),
    });
    await expect(lstat(publicationError.recoveryPath)).resolves.toMatchObject({
      isDirectory: expect.any(Function),
    });
  });
});
