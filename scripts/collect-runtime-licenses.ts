import { constants, type BigIntStats } from "node:fs";
import { chmod, lstat, mkdir, open, readdir, realpath } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

import type { Metafile } from "esbuild";

const MAX_PACKAGE_JSON_BYTES = 1_048_576;
const MAX_PACKAGE_LOCK_BYTES = 32 * 1_048_576;
const MAX_LICENSE_BYTES = 4 * 1_048_576;
const LICENSE_FILENAME = /^licen[cs]e(?:[._-].*)?$/iu;

interface PackageLockEntry {
  readonly version?: unknown;
  readonly dev?: unknown;
  readonly license?: unknown;
}

interface RuntimeLicenseFile {
  readonly name: string;
  readonly contents: Buffer;
}

interface RuntimePackage {
  readonly name: string;
  readonly version: string;
  readonly license: string;
  readonly packageKey: string;
  readonly licenseFiles: readonly RuntimeLicenseFile[];
}

interface PendingOutput {
  readonly relativePath: string;
  readonly contents: Buffer;
}

export interface StableReadContext {
  readonly root: string;
  readonly relativePath: string;
  readonly absolutePath: string;
}

export interface StableReadHooks {
  readonly afterDataRead?: (context: StableReadContext) => Promise<void>;
}

export interface RuntimeLicenseCollectionOptions {
  readonly stableReadHooks?: StableReadHooks;
}

function compareStable(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function within(root: string, candidate: string): boolean {
  const path = relative(root, candidate);
  return path === "" || (!path.startsWith(`..${sep}`) && path !== ".." && !isAbsolute(path));
}

function assertPlainRecord(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new Error(`${label} must be a plain object`);
  }
  return value as Record<string, unknown>;
}

function optionalPlainRecord(value: unknown, label: string): Record<string, unknown> {
  return value === undefined ? {} : assertPlainRecord(value, label);
}

function sameDirectoryIdentity(left: BigIntStats, right: BigIntStats): boolean {
  return left.dev === right.dev && left.ino === right.ino && left.mode === right.mode;
}

function sameFileIdentity(left: BigIntStats, right: BigIntStats): boolean {
  return sameDirectoryIdentity(left, right)
    && left.size === right.size
    && left.mtimeNs === right.mtimeNs
    && left.ctimeNs === right.ctimeNs;
}

function safeRelativePath(relativePath: string, label: string): readonly string[] {
  if (relativePath.includes("\\") || isAbsolute(relativePath)) {
    throw new Error(`${label} must be a canonical relative path: ${relativePath}`);
  }
  const segments = relativePath.split("/");
  if (segments.some((segment) => segment === "" || segment === "." || segment === "..")) {
    throw new Error(`${label} must be a canonical relative path: ${relativePath}`);
  }
  return segments;
}

async function canonicalTrustedRoot(root: string, label: string): Promise<string> {
  const requested = resolve(root);
  const metadata = await lstat(requested, { bigint: true });
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new Error(`${label} must be a real directory`);
  }
  return realpath(requested);
}

async function stableDirectoryPath(
  trustedRoot: string,
  relativePath: string,
): Promise<{ readonly absolutePath: string; readonly identities: readonly [string, BigIntStats][] }> {
  const segments = safeRelativePath(relativePath, "directory path");
  const identities: [string, BigIntStats][] = [];
  let current = trustedRoot;
  const rootMetadata = await lstat(current, { bigint: true });
  if (!rootMetadata.isDirectory() || rootMetadata.isSymbolicLink()) {
    throw new Error(`unsafe trusted directory ancestor: ${current}`);
  }
  identities.push([current, rootMetadata]);
  for (const segment of segments) {
    current = join(current, segment);
    if (!within(trustedRoot, current)) throw new Error(`directory path escapes trusted root: ${relativePath}`);
    const metadata = await lstat(current, { bigint: true });
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
      throw new Error(`unsafe symlinked or non-directory ancestor: ${current}`);
    }
    identities.push([current, metadata]);
  }
  return { absolutePath: current, identities };
}

async function verifyDirectoryIdentities(
  identities: readonly (readonly [string, BigIntStats])[],
): Promise<void> {
  for (const [path, before] of identities) {
    const after = await lstat(path, { bigint: true });
    if (!after.isDirectory() || after.isSymbolicLink() || !sameDirectoryIdentity(before, after)) {
      throw new Error(`directory identity changed during stable read: ${path}`);
    }
  }
}

export async function readStableRelativeFile(
  root: string,
  relativePath: string,
  maximumBytes: number,
  hooks: StableReadHooks = {},
): Promise<Buffer> {
  const trustedRoot = await canonicalTrustedRoot(root, "stable-read root");
  const segments = safeRelativePath(relativePath, "file path");
  const filename = segments.at(-1)!;
  const parentRelative = segments.slice(0, -1).join("/");
  const parent = parentRelative === ""
    ? {
      absolutePath: trustedRoot,
      identities: [[trustedRoot, await lstat(trustedRoot, { bigint: true })]] as const,
    }
    : await stableDirectoryPath(trustedRoot, parentRelative);
  const absolutePath = join(parent.absolutePath, filename);
  if (!within(trustedRoot, absolutePath)) throw new Error(`file path escapes trusted root: ${relativePath}`);
  const before = await lstat(absolutePath, { bigint: true });
  if (
    !before.isFile()
    || before.isSymbolicLink()
    || before.size < 1n
    || before.size > BigInt(maximumBytes)
  ) {
    throw new Error(`unsafe or empty regular file: ${absolutePath}`);
  }
  const noFollow = typeof constants.O_NOFOLLOW === "number" ? constants.O_NOFOLLOW : 0;
  const handle = await open(absolutePath, constants.O_RDONLY | noFollow);
  try {
    const opened = await handle.stat({ bigint: true });
    if (!opened.isFile() || !sameFileIdentity(before, opened)) {
      throw new Error(`file identity changed before stable read: ${absolutePath}`);
    }
    const length = Number(opened.size);
    if (!Number.isSafeInteger(length)) throw new Error(`file is too large to read safely: ${absolutePath}`);
    const contents = Buffer.alloc(length);
    let offset = 0;
    while (offset < contents.byteLength) {
      const { bytesRead } = await handle.read(contents, offset, contents.byteLength - offset, offset);
      if (bytesRead === 0) throw new Error(`short stable read: ${absolutePath}`);
      offset += bytesRead;
    }
    await hooks.afterDataRead?.({ root: trustedRoot, relativePath, absolutePath });
    const afterHandle = await handle.stat({ bigint: true });
    if (!sameFileIdentity(opened, afterHandle)) {
      throw new Error(`file identity changed during stable read: ${absolutePath}`);
    }
    const afterPath = await lstat(absolutePath, { bigint: true });
    if (!afterPath.isFile() || afterPath.isSymbolicLink() || !sameFileIdentity(opened, afterPath)) {
      throw new Error(`file path identity changed during stable read: ${absolutePath}`);
    }
    await verifyDirectoryIdentities(parent.identities);
    return contents;
  } finally {
    await handle.close();
  }
}

async function writeDeterministicFile(path: string, contents: Uint8Array): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o755 });
  const handle = await open(path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o644);
  try {
    await handle.writeFile(contents);
  } finally {
    await handle.close();
  }
  await chmod(path, 0o644);
}

function packageKeyForInput(input: string): string | null {
  const segments = safeRelativePath(input, "metafile input");
  let nodeModules = -1;
  for (let index = 0; index < segments.length; index += 1) {
    if (segments[index] === "node_modules") nodeModules = index;
  }
  if (nodeModules === -1) return null;
  const first = segments[nodeModules + 1];
  if (first === undefined) throw new Error(`invalid package input: ${input}`);
  const packageEnd = first.startsWith("@") ? nodeModules + 3 : nodeModules + 2;
  if (segments.length <= packageEnd) throw new Error(`invalid package input: ${input}`);
  return segments.slice(0, packageEnd).join("/");
}

function packageNameForKey(packageKey: string): string {
  const marker = "/node_modules/";
  const start = packageKey.lastIndexOf(marker);
  const suffix = start === -1
    ? packageKey.slice("node_modules/".length)
    : packageKey.slice(start + marker.length);
  const segment = "[a-z0-9](?:[a-z0-9._-]{0,212}[a-z0-9])?";
  if (new RegExp(`^(?:@${segment}/${segment}|${segment})$`, "u").test(suffix)) return suffix;
  throw new Error(`invalid package key: ${packageKey}`);
}

function safePackageField(value: string, label: string): string {
  const normalized = value.trim();
  if (
    normalized.length === 0
    || normalized.length > 256
    || /[\u0000-\u001f\u007f/\\|`]/u.test(normalized)
    || normalized === "."
    || normalized === ".."
  ) {
    throw new Error(`unsafe ${label}: ${value}`);
  }
  return normalized;
}

function safeOutputPath(relativePath: string, seen: Set<string>): string {
  const segments = safeRelativePath(relativePath, "license output path");
  const normalized = segments.map((segment) => segment.normalize("NFC")).join("/").toLowerCase();
  if (seen.has(normalized)) throw new Error(`duplicate normalized license output: ${relativePath}`);
  seen.add(normalized);
  return segments.join("/");
}

function dependencyNames(entry: Record<string, unknown>, label: string): readonly string[] {
  const dependencies = optionalPlainRecord(entry.dependencies, `${label} dependencies`);
  const optionalDependencies = optionalPlainRecord(entry.optionalDependencies, `${label} optionalDependencies`);
  return [...new Set([...Object.keys(dependencies), ...Object.keys(optionalDependencies)])].sort(compareStable);
}

function resolveDependencyKey(
  packages: Record<string, unknown>,
  fromPackageKey: string,
  dependencyName: string,
): string {
  packageNameForKey(`node_modules/${dependencyName}`);
  let current = fromPackageKey;
  while (true) {
    const candidate = current === ""
      ? `node_modules/${dependencyName}`
      : `${current}/node_modules/${dependencyName}`;
    if (Object.hasOwn(packages, candidate)) return candidate;
    if (current === "") break;
    const marker = current.lastIndexOf("/node_modules/");
    current = marker === -1 ? "" : current.slice(0, marker);
  }
  throw new Error(`package-lock dependency is unresolved: ${fromPackageKey || "<root>"} -> ${dependencyName}`);
}

function reachableProductionPackageKeys(packages: Record<string, unknown>): ReadonlySet<string> {
  const rootEntry = assertPlainRecord(packages[""], "package-lock root package");
  const queue = dependencyNames(rootEntry, "root package")
    .map((name) => resolveDependencyKey(packages, "", name));
  const reachable = new Set<string>();
  while (queue.length > 0) {
    const packageKey = queue.shift()!;
    if (reachable.has(packageKey)) continue;
    const entry = assertPlainRecord(packages[packageKey], `package-lock entry ${packageKey}`);
    if (entry.dev === true) throw new Error(`production dependency graph reaches dev package: ${packageKey}`);
    reachable.add(packageKey);
    for (const name of dependencyNames(entry, packageKey)) {
      const dependency = resolveDependencyKey(packages, packageKey, name);
      if (!reachable.has(dependency)) queue.push(dependency);
    }
    queue.sort(compareStable);
  }
  return reachable;
}

async function runtimePackages(
  repositoryRoot: string,
  metafile: Metafile,
  hooks: StableReadHooks,
): Promise<readonly RuntimePackage[]> {
  const packageLock = assertPlainRecord(
    JSON.parse((await readStableRelativeFile(
      repositoryRoot,
      "package-lock.json",
      MAX_PACKAGE_LOCK_BYTES,
      hooks,
    )).toString("utf8")),
    "package-lock.json",
  );
  if (packageLock.lockfileVersion !== 3) throw new Error("package-lock.json must use lockfileVersion 3");
  const packages = assertPlainRecord(packageLock.packages, "package-lock packages");
  const reachable = reachableProductionPackageKeys(packages);
  const packageKeys = new Set<string>();
  for (const input of Object.keys(metafile.inputs)) {
    const packageKey = packageKeyForInput(input);
    if (packageKey !== null) packageKeys.add(packageKey);
  }
  if (packageKeys.size === 0) throw new Error("bundle metafile contains no runtime packages");

  const result: RuntimePackage[] = [];
  for (const packageKey of [...packageKeys].sort(compareStable)) {
    const name = packageNameForKey(packageKey);
    if (!reachable.has(packageKey)) throw new Error(`unexpected bundled production package: ${packageKey}`);
    const lockEntry = assertPlainRecord(packages[packageKey], `package-lock entry ${packageKey}`) as PackageLockEntry;
    if (lockEntry.dev === true) throw new Error(`bundled package is development-only: ${name}`);
    if (typeof lockEntry.version !== "string" || lockEntry.version.length === 0) {
      throw new Error(`bundled package has no locked version: ${name}`);
    }
    if (typeof lockEntry.license !== "string" || lockEntry.license.trim().length === 0) {
      throw new Error(`bundled package has no locked license: ${name}`);
    }
    const packageDirectory = await stableDirectoryPath(repositoryRoot, packageKey);
    const metadata = assertPlainRecord(
      JSON.parse((await readStableRelativeFile(
        repositoryRoot,
        `${packageKey}/package.json`,
        MAX_PACKAGE_JSON_BYTES,
        hooks,
      )).toString("utf8")),
      `${name} package.json`,
    );
    if (metadata.name !== name || metadata.version !== lockEntry.version) {
      throw new Error(`installed package identity differs from package-lock: ${name}`);
    }
    if (typeof metadata.license !== "string" || metadata.license.trim() !== lockEntry.license.trim()) {
      throw new Error(`installed package license differs from package-lock: ${name}`);
    }
    const licenseNames = (await readdir(packageDirectory.absolutePath))
      .filter((licenseName) => LICENSE_FILENAME.test(licenseName))
      .sort(compareStable);
    if (licenseNames.length === 0) throw new Error(`installed package has no license text: ${name}`);
    const licenseFiles: RuntimeLicenseFile[] = [];
    for (const licenseName of licenseNames) {
      safeRelativePath(licenseName, "package license filename");
      licenseFiles.push({
        name: licenseName,
        contents: await readStableRelativeFile(
          repositoryRoot,
          `${packageKey}/${licenseName}`,
          MAX_LICENSE_BYTES,
          hooks,
        ),
      });
    }
    await verifyDirectoryIdentities(packageDirectory.identities);
    result.push({
      name,
      version: safePackageField(lockEntry.version, `version for ${name}`),
      license: safePackageField(lockEntry.license, `license for ${name}`),
      packageKey,
      licenseFiles,
    });
  }
  return result;
}

export async function collectRuntimeLicenses(
  pluginRoot: string,
  metafile: Metafile,
  repositoryRoot = resolve(import.meta.dirname, ".."),
  options: RuntimeLicenseCollectionOptions = {},
): Promise<void> {
  const resolvedPluginRoot = await canonicalTrustedRoot(pluginRoot, "plugin license output root");
  const resolvedRepositoryRoot = await canonicalTrustedRoot(repositoryRoot, "license repository root");
  const hooks = options.stableReadHooks ?? {};
  const rootCopies = [
    ["THIRD_PARTY_NOTICES.md", "THIRD_PARTY_NOTICES.md"],
    ["licenses/agency-agents-MIT.txt", "licenses/agency-agents-MIT.txt"],
    ["licenses/agency-agents-zh-MIT.txt", "licenses/agency-agents-zh-MIT.txt"],
    ["licenses/UNICODE-LICENSE.txt", "licenses/UNICODE-LICENSE.txt"],
  ] as const;
  const pending: PendingOutput[] = [];
  const seen = new Set<string>();
  for (const [sourceRelative, outputRelative] of rootCopies) {
    pending.push({
      relativePath: safeOutputPath(outputRelative, seen),
      contents: await readStableRelativeFile(
        resolvedRepositoryRoot,
        sourceRelative,
        MAX_LICENSE_BYTES,
        hooks,
      ),
    });
  }

  const packages = await runtimePackages(resolvedRepositoryRoot, metafile, hooks);
  const rows: string[] = [];
  for (const runtimePackage of packages) {
    for (const licenseFile of runtimePackage.licenseFiles) {
      pending.push({
        relativePath: safeOutputPath(
          `licenses/npm/${runtimePackage.name}@${runtimePackage.version}/${licenseFile.name}`,
          seen,
        ),
        contents: licenseFile.contents,
      });
    }
    rows.push(
      `| \`${runtimePackage.name}@${runtimePackage.version}\` | \`${runtimePackage.license}\` | `
      + `\`licenses/npm/${runtimePackage.name}@${runtimePackage.version}/\` |`,
    );
  }
  const runtimeNotice = [
    "# Bundled npm Runtime Dependencies",
    "",
    "This file is generated offline from package-lock.json, the esbuild metafile, and installed package license files.",
    "",
    "| Package | License | License files |",
    "| --- | --- | --- |",
    ...rows,
    "",
  ].join("\n");
  pending.push({
    relativePath: safeOutputPath("RUNTIME_DEPENDENCIES.md", seen),
    contents: Buffer.from(runtimeNotice, "utf8"),
  });

  for (const output of pending) {
    const destination = resolve(resolvedPluginRoot, output.relativePath);
    if (!within(resolvedPluginRoot, destination)) {
      throw new Error(`license output escapes plugin root: ${output.relativePath}`);
    }
  }
  for (const output of pending) {
    await writeDeterministicFile(join(resolvedPluginRoot, output.relativePath), output.contents);
  }
}
