import { createHash } from "node:crypto";
import { constants, type BigIntStats } from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readdir,
  realpath,
  rename,
  rm,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";

import { build, type Metafile } from "esbuild";

import {
  collectRuntimeLicenses,
  readStableRelativeFile,
  type StableReadHooks,
} from "./collect-runtime-licenses.js";

const REPOSITORY_ROOT = resolve(import.meta.dirname, "..");
const SOURCE_PLUGIN_ROOT = join(REPOSITORY_ROOT, "plugins", "ezagent-spec");
const SKILLS = [
  "ezagent-router",
  "ezagent-initialize",
  "ezagent-light",
  "ezagent-context",
  "ezagent-spec",
  "ezagent-execute",
  "ezagent-implement",
  "ezagent-review",
] as const;
const SKILL_REFERENCES = [
  "skills/ezagent-initialize/references/node-bootstrap.md",
  "skills/ezagent-spec/references/planning-first.md",
  "skills/ezagent-spec/references/work-contract-v2.md",
] as const;
const GENERATED_ENTRIES = [
  "dist",
  "catalog",
  "hooks",
  "licenses",
  "LICENSE",
  "THIRD_PARTY_NOTICES.md",
  "RUNTIME_DEPENDENCIES.md",
] as const;
const ALL_ENTRIES = [".claude-plugin", ".codex-plugin", "skills", ...GENERATED_ENTRIES] as const;
const PLUGIN_FILES = [
  ".claude-plugin/plugin.json",
  ".codex-plugin/plugin.json",
  "LICENSE",
  "RUNTIME_DEPENDENCIES.md",
  "THIRD_PARTY_NOTICES.md",
  "catalog/catalog.lock.json",
  "catalog/experts.json",
  "dist/ezagent-cli.mjs",
  "hooks/ezagent-hooks.json",
  "hooks/ezagent-router-prompt.mjs",
  "licenses/UNICODE-LICENSE.txt",
  "licenses/agency-agents-MIT.txt",
  "licenses/agency-agents-zh-MIT.txt",
  "licenses/npm/yaml@2.9.0/LICENSE",
  "licenses/npm/zod@4.4.3/LICENSE",
  ...SKILLS.map((skill) => `skills/${skill}/SKILL.md`),
  ...SKILL_REFERENCES,
] as const;
const ALLOWED_PLUGIN_DIRECTORIES = new Set([
  ".claude-plugin",
  ".codex-plugin",
  "catalog",
  "dist",
  "hooks",
  "licenses",
  "licenses/npm",
  "licenses/npm/yaml@2.9.0",
  "licenses/npm/zod@4.4.3",
  "skills",
  ...SKILLS.map((skill) => `skills/${skill}`),
  "skills/ezagent-initialize/references",
  "skills/ezagent-spec/references",
]);
const MAX_SMALL_SOURCE_BYTES = 4 * 1_048_576;
const MAX_PLUGIN_FILE_BYTES = 32 * 1_048_576;
const MAX_CATALOG_BYTES = 16 * 1_048_576;

export const ALLOWED_BUNDLE_IMPORTS = Object.freeze([
  "node:crypto",
  "node:fs",
  "node:fs/promises",
  "node:path",
  "node:perf_hooks",
  "node:timers/promises",
  "node:url",
  "node:util",
] as const);

export interface PublicationContext {
  readonly stagePath: string;
  readonly outputRoot: string;
}

export interface PublishedEntryContext extends PublicationContext {
  readonly entry: string;
  readonly index: number;
}

export interface BuildPluginOptions {
  readonly stableReadHooks?: StableReadHooks;
  readonly publicationHooks?: {
    readonly beforePublication?: (context: PublicationContext) => Promise<void>;
    readonly afterPublishedEntry?: (context: PublishedEntryContext) => Promise<void>;
  };
}

interface PublicationState {
  started: boolean;
}

interface PluginTreeEntry {
  readonly path: string;
  readonly mode: number;
  readonly size: number;
  readonly sha256: string;
}

export class PluginPublicationError extends Error {
  override readonly name = "PluginPublicationError";

  constructor(
    message: string,
    readonly stagePath: string,
    readonly recoveryPath: string,
    readonly backupPath: string,
    options?: ErrorOptions,
  ) {
    super(
      `${message}; inspect stage=${stagePath}, recovery=${recoveryPath}, backup=${backupPath}`,
      options,
    );
  }
}

function compareStable(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function within(root: string, candidate: string): boolean {
  const path = relative(root, candidate);
  return path === "" || (!path.startsWith(`..${sep}`) && path !== ".." && !isAbsolute(path));
}

function sameDirectoryIdentity(left: BigIntStats, right: BigIntStats): boolean {
  return left.dev === right.dev && left.ino === right.ino && left.mode === right.mode;
}

async function writeExclusive(path: string, contents: Uint8Array, mode = 0o644): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o755 });
  const handle = await open(path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, mode);
  try {
    await handle.writeFile(contents);
  } finally {
    await handle.close();
  }
  await chmod(path, mode);
}

async function copyStableFile(
  sourceRoot: string,
  relativePath: string,
  destination: string,
  maximumBytes: number,
  hooks: StableReadHooks,
): Promise<void> {
  await writeExclusive(
    destination,
    await readStableRelativeFile(sourceRoot, relativePath, maximumBytes, hooks),
  );
}

async function assertDirectory(path: string, label: string): Promise<BigIntStats> {
  const metadata = await lstat(path, { bigint: true });
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new Error(`${label} must be a real directory: ${path}`);
  }
  return metadata;
}

async function collectSafeTreePaths(root: string): Promise<readonly string[]> {
  const realRoot = await realpath(root);
  const files: string[] = [];
  async function visit(directory: string, directoryRelative: string): Promise<void> {
    for (const name of (await readdir(directory)).sort(compareStable)) {
      if (name === "." || name === ".." || name.includes("/") || name.includes("\\")) {
        throw new Error(`unsafe package entry: ${name}`);
      }
      const path = join(directory, name);
      const metadata = await lstat(path, { bigint: true });
      if (metadata.isSymbolicLink()) throw new Error(`generated package contains symlink: ${path}`);
      const resolved = resolve(path);
      if (!within(realRoot, resolved)) throw new Error(`generated package entry escapes root: ${path}`);
      const pathRelative = directoryRelative === "" ? name : `${directoryRelative}/${name}`;
      if (metadata.isDirectory()) {
        await visit(path, pathRelative);
      } else if (metadata.isFile()) {
        files.push(pathRelative);
      } else {
        throw new Error(`generated package entry is not a regular file: ${path}`);
      }
    }
  }
  await visit(realRoot, "");
  return files.sort(compareStable);
}

async function assertSafeTree(root: string): Promise<void> {
  await collectSafeTreePaths(root);
}

async function targetRoot(outputRoot: string, isDefault: boolean): Promise<{
  readonly path: string;
  readonly identity: BigIntStats;
}> {
  const requested = resolve(outputRoot);
  const sourceReal = await realpath(SOURCE_PLUGIN_ROOT);
  const identity = await assertDirectory(requested, "plugin output root");
  const requestedReal = await realpath(requested);
  if (requestedReal === sourceReal) return { path: requestedReal, identity };
  if (isDefault) throw new Error("default plugin output did not resolve to the source plugin root");

  const temporaryReal = await realpath(tmpdir());
  if (!within(temporaryReal, requestedReal)) {
    throw new Error("explicit plugin package output must be an existing temporary directory");
  }
  if ((await readdir(requestedReal)).length !== 0) {
    throw new Error("explicit plugin package output must be empty");
  }
  return { path: requestedReal, identity };
}

export function auditBundleMetafile(metafile: Metafile): void {
  const outputs = Object.entries(metafile.outputs);
  if (outputs.length !== 1) throw new Error("bundle metafile must contain exactly one output");
  const allowed = new Set<string>(ALLOWED_BUNDLE_IMPORTS);
  for (const [outputPath, output] of outputs) {
    for (const imported of output.imports) {
      if (
        imported.external !== true
        || imported.kind !== "import-statement"
        || !allowed.has(imported.path)
      ) {
        throw new Error(
          `forbidden bundle import in ${outputPath}: ${imported.kind} ${imported.path}`,
        );
      }
    }
  }
}

async function assembleStage(stage: string, options: BuildPluginOptions): Promise<void> {
  const hooks = options.stableReadHooks ?? {};
  await copyStableFile(
    SOURCE_PLUGIN_ROOT,
    ".claude-plugin/plugin.json",
    join(stage, ".claude-plugin", "plugin.json"),
    MAX_SMALL_SOURCE_BYTES,
    hooks,
  );
  await copyStableFile(
    SOURCE_PLUGIN_ROOT,
    ".codex-plugin/plugin.json",
    join(stage, ".codex-plugin", "plugin.json"),
    MAX_SMALL_SOURCE_BYTES,
    hooks,
  );
  await copyStableFile(
    SOURCE_PLUGIN_ROOT,
    "hooks/ezagent-hooks.json",
    join(stage, "hooks", "ezagent-hooks.json"),
    MAX_SMALL_SOURCE_BYTES,
    hooks,
  );
  await copyStableFile(
    SOURCE_PLUGIN_ROOT,
    "hooks/ezagent-router-prompt.mjs",
    join(stage, "hooks", "ezagent-router-prompt.mjs"),
    MAX_SMALL_SOURCE_BYTES,
    hooks,
  );
  await copyStableFile(
    REPOSITORY_ROOT,
    "LICENSE",
    join(stage, "LICENSE"),
    MAX_SMALL_SOURCE_BYTES,
    hooks,
  );
  for (const skill of SKILLS) {
    await copyStableFile(
      SOURCE_PLUGIN_ROOT,
      `skills/${skill}/SKILL.md`,
      join(stage, "skills", skill, "SKILL.md"),
      MAX_SMALL_SOURCE_BYTES,
      hooks,
    );
  }
  for (const reference of SKILL_REFERENCES) {
    await copyStableFile(
      SOURCE_PLUGIN_ROOT,
      reference,
      join(stage, reference),
      MAX_SMALL_SOURCE_BYTES,
      hooks,
    );
  }

  await mkdir(join(stage, "dist"), { recursive: true, mode: 0o755 });
  const cliPath = join(stage, "dist", "ezagent-cli.mjs");
  const buildResult = await build({
    absWorkingDir: REPOSITORY_ROOT,
    entryPoints: ["src/cli/main.ts"],
    outfile: cliPath,
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node22",
    alias: { yaml: join(REPOSITORY_ROOT, "node_modules", "yaml", "browser", "index.js") },
    sourcemap: false,
    metafile: true,
    legalComments: "none",
    minifyWhitespace: true,
    charset: "utf8",
    logLevel: "silent",
    write: false,
  });
  if (buildResult.metafile === undefined) throw new Error("esbuild did not return a metafile");
  auditBundleMetafile(buildResult.metafile);
  if (buildResult.outputFiles?.length !== 1) throw new Error("esbuild did not return exactly one CLI output");
  const bundledCli = buildResult.outputFiles[0]!.text.replace(/^[ \t]+$/gmu, "");
  await writeExclusive(cliPath, Buffer.from(bundledCli, "utf8"), 0o755);

  await copyStableFile(
    REPOSITORY_ROOT,
    "catalog/normalized/experts.json",
    join(stage, "catalog", "experts.json"),
    MAX_CATALOG_BYTES,
    hooks,
  );
  await copyStableFile(
    REPOSITORY_ROOT,
    "catalog/normalized/catalog.lock.json",
    join(stage, "catalog", "catalog.lock.json"),
    MAX_SMALL_SOURCE_BYTES,
    hooks,
  );
  await collectRuntimeLicenses(stage, buildResult.metafile, REPOSITORY_ROOT, {
    stableReadHooks: hooks,
  });
  await assertSafeTree(stage);
}

function publicationError(
  message: string,
  stage: string,
  cause: unknown,
): PluginPublicationError {
  return new PluginPublicationError(
    message,
    stage,
    join(stage, ".failed-publication"),
    join(stage, ".publication-backup"),
    { cause },
  );
}

async function publishStage(
  stage: string,
  outputRoot: string,
  outputIdentity: BigIntStats,
  entries: readonly string[],
  state: PublicationState,
  options: BuildPluginOptions,
): Promise<void> {
  const backup = join(stage, ".publication-backup");
  const recovery = join(stage, ".failed-publication");
  const backedUp: string[] = [];
  const installed: string[] = [];
  try {
    await options.publicationHooks?.beforePublication?.({ stagePath: stage, outputRoot });
    const currentIdentity = await lstat(outputRoot, { bigint: true });
    if (
      !currentIdentity.isDirectory()
      || currentIdentity.isSymbolicLink()
      || !sameDirectoryIdentity(outputIdentity, currentIdentity)
    ) {
      throw new Error("plugin output root identity changed before publication");
    }
    for (const [index, entry] of entries.entries()) {
      const staged = join(stage, entry);
      await lstat(staged, { bigint: true });
      const destination = join(outputRoot, entry);
      try {
        const existing = await lstat(destination, { bigint: true });
        if (existing.isSymbolicLink()) throw new Error(`refusing to replace symlinked output: ${destination}`);
        if (existing.isDirectory()) {
          await assertSafeTree(destination);
        } else if (!existing.isFile()) {
          throw new Error(`refusing to replace non-regular output: ${destination}`);
        }
        if (backedUp.length === 0) await mkdir(backup, { mode: 0o700 });
        state.started = true;
        await rename(destination, join(backup, entry));
        backedUp.push(entry);
      } catch (error: unknown) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      state.started = true;
      await rename(staged, destination);
      installed.push(entry);
      await options.publicationHooks?.afterPublishedEntry?.({
        stagePath: stage,
        outputRoot,
        entry,
        index,
      });
    }
    await assertSafeTree(outputRoot);
    const finalIdentity = await lstat(outputRoot, { bigint: true });
    if (!sameDirectoryIdentity(outputIdentity, finalIdentity)) {
      throw new Error("plugin output root identity changed during publication");
    }
  } catch (error: unknown) {
    if (!state.started) throw error;
    const rollbackErrors: unknown[] = [];
    await mkdir(recovery, { mode: 0o700 }).catch(
      (rollbackError: unknown) => rollbackErrors.push(rollbackError),
    );
    for (const entry of [...installed].reverse()) {
      await rename(join(outputRoot, entry), join(recovery, entry)).catch(
        (rollbackError: unknown) => rollbackErrors.push(rollbackError),
      );
    }
    for (const entry of [...backedUp].reverse()) {
      await rename(join(backup, entry), join(outputRoot, entry)).catch(
        (rollbackError: unknown) => rollbackErrors.push(rollbackError),
      );
    }
    const cause = rollbackErrors.length === 0 ? error : new AggregateError([error, ...rollbackErrors]);
    throw publicationError("plugin publication failed and retained recovery evidence", stage, cause);
  }
}

export async function buildPlugin(
  outputRoot?: string,
  options: BuildPluginOptions = {},
): Promise<void> {
  await assertDirectory(REPOSITORY_ROOT, "repository root");
  await assertDirectory(SOURCE_PLUGIN_ROOT, "source plugin root");
  const requested = outputRoot ?? SOURCE_PLUGIN_ROOT;
  const output = await targetRoot(requested, outputRoot === undefined);
  const stage = await mkdtemp(join(dirname(output.path), ".ezagent-plugin-stage-"));
  const publicationState: PublicationState = { started: false };
  try {
    await assembleStage(stage, options);
    await publishStage(
      stage,
      output.path,
      output.identity,
      output.path === await realpath(SOURCE_PLUGIN_ROOT) ? GENERATED_ENTRIES : ALL_ENTRIES,
      publicationState,
      options,
    );
  } catch (error: unknown) {
    if (publicationState.started) throw error;
    try {
      await rm(stage, { recursive: true, force: true });
    } catch (cleanupError: unknown) {
      throw publicationError(
        "pre-publication failure could not clean its stage",
        stage,
        new AggregateError([error, cleanupError]),
      );
    }
    throw error;
  }
  try {
    await rm(stage, { recursive: true, force: true });
  } catch (cleanupError: unknown) {
    throw publicationError("published plugin but could not clean its stage", stage, cleanupError);
  }
}

async function pluginTree(root: string): Promise<readonly PluginTreeEntry[]> {
  const canonical = await realpath(root);
  await assertDirectory(canonical, "plugin package candidate");
  const paths = await collectSafeTreePaths(canonical);
  if (
    paths.length !== PLUGIN_FILES.length
    || paths.some((path, index) => path !== [...PLUGIN_FILES].sort(compareStable)[index])
  ) {
    throw new Error(`plugin package drift: unexpected file tree at ${canonical}`);
  }
  const directories = new Set<string>();
  async function collectDirectories(directory: string, prefix: string): Promise<void> {
    for (const name of (await readdir(directory)).sort(compareStable)) {
      const absolute = join(directory, name);
      const metadata = await lstat(absolute, { bigint: true });
      if (!metadata.isDirectory() || metadata.isSymbolicLink()) continue;
      const path = prefix === "" ? name : `${prefix}/${name}`;
      directories.add(path);
      await collectDirectories(absolute, path);
    }
  }
  await collectDirectories(canonical, "");
  if ([...directories].some((directory) => !ALLOWED_PLUGIN_DIRECTORIES.has(directory))) {
    throw new Error(`plugin package drift: unexpected directory tree at ${canonical}`);
  }
  const result: PluginTreeEntry[] = [];
  for (const path of paths) {
    const contents = await readStableRelativeFile(canonical, path, MAX_PLUGIN_FILE_BYTES);
    const metadata = await lstat(join(canonical, path), { bigint: true });
    result.push({
      path,
      mode: Number(metadata.mode & 0o777n),
      size: contents.byteLength,
      sha256: createHash("sha256").update(contents).digest("hex"),
    });
  }
  return result;
}

export async function checkPlugin(candidateRoot = SOURCE_PLUGIN_ROOT): Promise<void> {
  const expectedRoot = await mkdtemp(join(tmpdir(), "ezagent-plugin-check-"));
  try {
    await buildPlugin(expectedRoot);
    const [expected, candidate] = await Promise.all([
      pluginTree(expectedRoot),
      pluginTree(candidateRoot),
    ]);
    if (JSON.stringify(candidate) !== JSON.stringify(expected)) {
      throw new Error(`plugin package drift: ${resolve(candidateRoot)} differs from a fresh build`);
    }
  } finally {
    await rm(expectedRoot, { recursive: true, force: true });
  }
}

function invokedDirectly(): boolean {
  const entry = process.argv[1];
  return entry !== undefined && pathToFileURL(resolve(entry)).href === import.meta.url;
}

if (invokedDirectly()) {
  const args = process.argv.slice(2);
  let operation: Promise<void>;
  if (args.length === 0) {
    operation = buildPlugin();
  } else if (args.length === 1 && args[0] === "--check") {
    operation = checkPlugin();
  } else if (args.length === 1) {
    operation = buildPlugin(args[0]);
  } else {
    operation = Promise.reject(new Error("usage: build-plugin.ts [--check|temporary-output-directory]"));
  }
  operation.catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : "plugin build failed"}\n`);
    process.exitCode = 1;
  });
}
