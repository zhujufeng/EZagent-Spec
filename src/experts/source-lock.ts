import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import {
  link,
  lstat,
  open,
  readFile,
  realpath,
  rm,
} from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import { types as nodeTypes } from "node:util";

import { parseDocument } from "yaml";

const CONFIG_KEYS = ["schemaVersion", "sources"] as const;
const CANDIDATE_KEYS = ["id", "repository", "ref", "checkout", "license"] as const;
const LOCK_KEYS = ["schemaVersion", "sources"] as const;
const LOCKED_SOURCE_KEYS = ["id", "repository", "license", "commit"] as const;
const MAX_SOURCES = 64;
const MAX_CONFIG_BYTES = 1_048_576;
const MAX_GIT_OUTPUT = 1_048_576;
const MAX_LENGTHS = {
  id: 64,
  repository: 256,
  ref: 255,
  checkout: 96,
  license: 32,
  commit: 40,
} as const;

const PORTABLE_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;
const PORTABLE_CHECKOUT = /^vendor-sources\/[a-z0-9]+(?:-[a-z0-9]+)*$/u;
const WINDOWS_RESERVED_BASENAME = /^(?:CON|PRN|AUX|NUL|CLOCK\$|CONIN\$|CONOUT\$|COM[1-9]|LPT[1-9])$/u;
const OWNER = "(?:[A-Za-z0-9]|[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9]))";
const REPOSITORY_NAME = "(?:[A-Za-z0-9]|[A-Za-z0-9](?:[A-Za-z0-9._-]{0,98}[A-Za-z0-9]))";
const CANONICAL_GITHUB_REPOSITORY = new RegExp(
  `^https://github\\.com/${OWNER}/${REPOSITORY_NAME}$`,
  "u",
);
const SAFE_REF_CHARACTERS = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/u;
const FULL_COMMIT_SHA = /^[0-9a-f]{40}$/u;
const PSEUDO_REFS = new Set([
  "HEAD",
  "ORIG_HEAD",
  "FETCH_HEAD",
  "MERGE_HEAD",
  "CHERRY_PICK_HEAD",
  "REVERT_HEAD",
  "BISECT_HEAD",
  "AUTO_MERGE",
]);

export interface SourceCandidate {
  readonly id: string;
  readonly repository: string;
  readonly ref: string;
  readonly checkout: string;
  readonly license: "MIT";
}

export interface SourceCandidatesConfig {
  readonly schemaVersion: 1;
  readonly sources: readonly SourceCandidate[];
}

export interface LockedSource {
  readonly id: string;
  readonly repository: string;
  readonly license: "MIT";
  readonly commit: string;
}

export interface SourceLock {
  readonly schemaVersion: 1;
  readonly sources: readonly LockedSource[];
}

export type SourceCommitResolver = (
  checkout: string,
  candidate: Readonly<SourceCandidate>,
) => Promise<string>;

export type GitRunner = (args: readonly string[]) => Promise<string>;

export class SourceConfigError extends Error {
  override readonly name = "SourceConfigError";
}

export class SourceLockError extends Error {
  override readonly name = "SourceLockError";
}

export class LocalCheckoutError extends Error {
  override readonly name = "LocalCheckoutError";
}

export class SourceLockWriteError extends Error {
  override readonly name = "SourceLockWriteError";
}

function configFail(message: string): never {
  throw new SourceConfigError(`Invalid catalog sources: ${message}`);
}

function ownDataObject(
  value: unknown,
  path: string,
  allowedKeys: readonly string[],
): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    configFail(`${path} must be a plain object`);
  }
  if (nodeTypes.isProxy(value)) {
    configFail(`${path} cannot be a Proxy`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    configFail(`${path} must be a plain object`);
  }

  const allowed = new Set(allowedKeys);
  const snapshot: Record<string, unknown> = {};
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string" || !allowed.has(key)) {
      configFail(`${path} contains an unsupported key`);
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || !descriptor.enumerable || !("value" in descriptor)) {
      configFail(`${path}.${key} cannot be an accessor or non-enumerable property`);
    }
    snapshot[key] = descriptor.value;
  }
  return snapshot;
}

function requiredString(
  object: Readonly<Record<string, unknown>>,
  key: keyof typeof MAX_LENGTHS,
  path: string,
): string {
  const value = object[key];
  if (typeof value !== "string") {
    configFail(`${path}.${key} must be a string`);
  }
  if (value.length === 0 || value.length > MAX_LENGTHS[key]) {
    configFail(`${path}.${key} length must be between 1 and ${MAX_LENGTHS[key]}`);
  }
  if (value.trim() !== value) {
    configFail(`${path}.${key} must not contain surrounding whitespace`);
  }
  return value;
}

function validateRepository(value: string, path: string): void {
  if (
    value.includes("%")
    || value.endsWith(".git")
    || !CANONICAL_GITHUB_REPOSITORY.test(value)
  ) {
    configFail(`${path}.repository must be a canonical HTTPS GitHub repository URL`);
  }
}

function validateRef(value: string, path: string): void {
  const components = value.split("/");
  if (
    PSEUDO_REFS.has(value)
    || !SAFE_REF_CHARACTERS.test(value)
    || value.endsWith(".")
    || value.endsWith("/")
    || value.includes("..")
    || value.includes("//")
    || value.includes("@{")
    || components.some((component) => component.startsWith(".") || component.endsWith(".lock"))
  ) {
    configFail(`${path}.ref is not a safe local Git ref or commit prefix`);
  }
}

function snapshotCandidate(value: unknown, path: string): SourceCandidate {
  const object = ownDataObject(value, path, CANDIDATE_KEYS);
  const id = requiredString(object, "id", path);
  const repository = requiredString(object, "repository", path);
  const ref = requiredString(object, "ref", path);
  const checkout = requiredString(object, "checkout", path);
  const license = requiredString(object, "license", path);

  if (!PORTABLE_ID.test(id)) {
    configFail(`${path}.id must be a portable lowercase kebab-case identifier`);
  }
  validateRepository(repository, path);
  validateRef(ref, path);
  if (!PORTABLE_CHECKOUT.test(checkout)) {
    configFail(`${path}.checkout must be vendor-sources/<single-safe-name>`);
  }
  const checkoutBasename = checkout.slice("vendor-sources/".length).toUpperCase();
  if (WINDOWS_RESERVED_BASENAME.test(checkoutBasename)) {
    configFail(`${path}.checkout cannot use a Windows reserved device name`);
  }
  if (license !== "MIT") {
    configFail(`${path}.license must be MIT`);
  }

  return Object.freeze({ id, repository, ref, checkout, license: "MIT" });
}

function snapshotDenseArray(value: unknown, path: string): readonly unknown[] {
  if (nodeTypes.isProxy(value)) {
    configFail(`${path} cannot be a Proxy`);
  }
  if (!Array.isArray(value)) {
    configFail(`${path} must be an array`);
  }
  const lengthDescriptor = Object.getOwnPropertyDescriptor(value, "length");
  if (lengthDescriptor === undefined || !("value" in lengthDescriptor)) {
    configFail(`${path}.length must be an own data property`);
  }
  const length = lengthDescriptor.value as unknown;
  if (!Number.isSafeInteger(length) || (length as number) < 1 || (length as number) > MAX_SOURCES) {
    configFail(`${path} must contain at least one and at most ${MAX_SOURCES} sources`);
  }
  for (const key of Reflect.ownKeys(value)) {
    if (key === "length") continue;
    if (typeof key !== "string" || !/^(?:0|[1-9]\d*)$/u.test(key) || Number(key) >= (length as number)) {
      configFail(`${path} contains an unsupported array key`);
    }
  }

  const snapshot: unknown[] = [];
  for (let index = 0; index < (length as number); index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (descriptor === undefined) {
      configFail(`${path} must be dense; index ${index} is missing`);
    }
    if (!descriptor.enumerable || !("value" in descriptor)) {
      configFail(`${path}.${index} cannot be an accessor or non-enumerable property`);
    }
    snapshot.push(descriptor.value);
  }
  return snapshot;
}

function assertUnique(candidates: readonly SourceCandidate[]): void {
  for (const key of ["id", "repository", "checkout"] as const) {
    const seen = new Set<string>();
    for (const candidate of candidates) {
      const value = candidate[key];
      const collisionKey = key === "repository" ? value.toLowerCase() : value;
      if (seen.has(collisionKey)) {
        configFail(`sources contain a duplicate ${key}: ${value}`);
      }
      seen.add(collisionKey);
    }
  }
}

function compareAsciiIds(left: { readonly id: string }, right: { readonly id: string }): number {
  if (left.id < right.id) return -1;
  if (left.id > right.id) return 1;
  return 0;
}

export function parseSourceCandidatesConfig(value: unknown): SourceCandidatesConfig {
  const object = ownDataObject(value, "config", CONFIG_KEYS);
  if (object.schemaVersion !== 1) {
    configFail("config.schemaVersion must be exactly 1");
  }
  const rawSources = snapshotDenseArray(object.sources, "config.sources");
  const sources = rawSources.map((candidate, index) => snapshotCandidate(candidate, `config.sources.${index}`));
  assertUnique(sources);
  return Object.freeze({ schemaVersion: 1, sources: Object.freeze(sources) });
}

export function parseSourceCandidatesYaml(text: string): SourceCandidatesConfig {
  if (typeof text !== "string" || text.length === 0 || Buffer.byteLength(text, "utf8") > MAX_CONFIG_BYTES) {
    configFail(`sources YAML must contain between 1 and ${MAX_CONFIG_BYTES} UTF-8 bytes`);
  }
  let value: unknown;
  try {
    const document = parseDocument(text, { uniqueKeys: true });
    if (document.errors.length > 0 || document.warnings.length > 0) {
      configFail("sources YAML is ambiguous or malformed");
    }
    value = document.toJS({ maxAliasCount: 0 });
  } catch (error: unknown) {
    if (error instanceof SourceConfigError) throw error;
    configFail("sources YAML is ambiguous or malformed");
  }
  return parseSourceCandidatesConfig(value);
}

export async function createSourceLock(
  candidates: readonly SourceCandidate[],
  resolveCommit: SourceCommitResolver,
): Promise<SourceLock> {
  const validated = parseSourceCandidatesConfig({ schemaVersion: 1, sources: candidates });
  const ordered = [...validated.sources].sort(compareAsciiIds);
  const sources: LockedSource[] = [];

  for (const candidate of ordered) {
    let rawCommit: unknown;
    try {
      rawCommit = await resolveCommit(candidate.checkout, candidate);
    } catch {
      throw new SourceLockError(`Source ${candidate.id} could not be resolved from its local checkout`);
    }
    if (typeof rawCommit !== "string" || rawCommit.length > 256) {
      throw new SourceLockError(`Source ${candidate.id} did not resolve to a 40-character lowercase commit SHA`);
    }
    const match = /^([0-9a-f]{40})(?:\r?\n)?$/u.exec(rawCommit);
    if (match === null) {
      throw new SourceLockError(`Source ${candidate.id} did not resolve to a 40-character lowercase commit SHA`);
    }
    const commit = match[1]!;
    sources.push(Object.freeze({
      id: candidate.id,
      repository: candidate.repository,
      license: "MIT",
      commit,
    }));
  }

  return Object.freeze({ schemaVersion: 1, sources: Object.freeze(sources) });
}

const nodeGitRunner: GitRunner = async (args) => {
  const { stdout } = await new Promise<{ stdout: string }>((resolvePromise, rejectPromise) => {
    execFile("git", [...args], {
      encoding: "utf8",
      maxBuffer: MAX_GIT_OUTPUT,
      windowsHide: true,
    }, (error, stdout) => {
      if (error !== null) {
        rejectPromise(error);
        return;
      }
      resolvePromise({ stdout });
    });
  });
  return stdout;
};

async function requireRealDirectory(path: string, label: string): Promise<void> {
  let observed: Awaited<ReturnType<typeof lstat>>;
  try {
    observed = await lstat(path);
  } catch {
    throw new LocalCheckoutError(`${label} is missing or unreadable`);
  }
  if (observed.isSymbolicLink()) {
    throw new LocalCheckoutError(`${label} cannot be a symbolic link`);
  }
  if (!observed.isDirectory()) {
    throw new LocalCheckoutError(`${label} must be a directory`);
  }
}

async function runCheckoutGit(
  runner: GitRunner,
  checkoutPath: string,
  args: readonly string[],
  sourceId: string,
  failure: string,
): Promise<string> {
  try {
    const output = await runner([
      "-C",
      checkoutPath,
      "--no-optional-locks",
      "-c",
      "core.fsmonitor=false",
      "-c",
      "protocol.allow=never",
      ...args,
    ]);
    if (typeof output !== "string" || output.length > MAX_GIT_OUTPUT) {
      throw new Error("invalid Git output");
    }
    return output;
  } catch {
    throw new LocalCheckoutError(`Source ${sourceId} ${failure}`);
  }
}

function singleGitOutputLine(output: string, sourceId: string, label: string): string {
  const match = /^([^\r\n]*)(?:\r?\n)?$/u.exec(output);
  if (match === null) {
    throw new LocalCheckoutError(`Source ${sourceId} ${label} returned ambiguous output`);
  }
  return match[1]!;
}

export async function resolveLocalCheckoutCommit(
  projectRoot: string,
  untrustedCandidate: SourceCandidate,
  runner: GitRunner = nodeGitRunner,
): Promise<string> {
  const candidate = parseSourceCandidatesConfig({ schemaVersion: 1, sources: [untrustedCandidate] }).sources[0]!;
  let root: string;
  try {
    root = await realpath(projectRoot);
  } catch {
    throw new LocalCheckoutError("Project root is missing or unreadable");
  }
  const vendorDirectory = join(root, "vendor-sources");
  const checkoutPath = resolve(root, candidate.checkout);
  const rootPrefix = root.endsWith(sep) ? root : `${root}${sep}`;
  if (!checkoutPath.startsWith(rootPrefix)) {
    throw new LocalCheckoutError(`Source ${candidate.id} checkout escapes the project root`);
  }
  await requireRealDirectory(vendorDirectory, "vendor-sources directory");
  await requireRealDirectory(checkoutPath, `Source ${candidate.id} checkout`);

  const inside = singleGitOutputLine(await runCheckoutGit(
    runner,
    checkoutPath,
    ["rev-parse", "--is-inside-work-tree"],
    candidate.id,
    "is not a Git worktree",
  ), candidate.id, "Git worktree check");
  if (inside !== "true") {
    throw new LocalCheckoutError(`Source ${candidate.id} is not a Git worktree`);
  }

  const topLevelOutput = await runCheckoutGit(
    runner,
    checkoutPath,
    ["rev-parse", "--show-toplevel"],
    candidate.id,
    "Git worktree root could not be verified",
  );
  let topLevel: string;
  try {
    topLevel = await realpath(singleGitOutputLine(topLevelOutput, candidate.id, "Git worktree root"));
  } catch {
    throw new LocalCheckoutError(`Source ${candidate.id} Git worktree root could not be verified`);
  }
  const canonicalCheckout = await realpath(checkoutPath);
  if (topLevel !== canonicalCheckout) {
    throw new LocalCheckoutError(`Source ${candidate.id} checkout must be the Git worktree root`);
  }

  const origin = singleGitOutputLine(await runCheckoutGit(
    runner,
    checkoutPath,
    ["config", "--get", "remote.origin.url"],
    candidate.id,
    "origin could not be read",
  ), candidate.id, "origin");
  if (origin !== candidate.repository) {
    throw new LocalCheckoutError(`Source ${candidate.id} origin does not match the reviewed repository`);
  }

  const dirt = await runCheckoutGit(
    runner,
    checkoutPath,
    ["status", "--porcelain=v1", "--untracked-files=all", "--ignored=matching"],
    candidate.id,
    "clean state could not be verified",
  );
  if (dirt.length > 0) {
    throw new LocalCheckoutError(`Source ${candidate.id} checkout must be clean, including untracked files`);
  }

  const head = singleGitOutputLine(await runCheckoutGit(
    runner,
    checkoutPath,
    ["rev-parse", "--verify", "HEAD^{commit}"],
    candidate.id,
    "HEAD commit could not be resolved",
  ), candidate.id, "HEAD");
  if (!FULL_COMMIT_SHA.test(head)) {
    throw new LocalCheckoutError(`Source ${candidate.id} HEAD is not a full lowercase commit SHA`);
  }

  const reviewedCommit = singleGitOutputLine(await runCheckoutGit(
    runner,
    checkoutPath,
    ["rev-parse", "--verify", `${candidate.ref}^{commit}`],
    candidate.id,
    "reviewed ref could not be resolved locally",
  ), candidate.id, "reviewed ref");
  if (!FULL_COMMIT_SHA.test(reviewedCommit)) {
    throw new LocalCheckoutError(`Source ${candidate.id} reviewed ref is not a full lowercase commit SHA`);
  }
  if (reviewedCommit !== head) {
    throw new LocalCheckoutError(`Source ${candidate.id} reviewed ref does not equal HEAD`);
  }
  return head;
}

function snapshotLockedSource(value: unknown, path: string): LockedSource {
  const object = ownDataObject(value, path, LOCKED_SOURCE_KEYS);
  const id = requiredString(object, "id", path);
  const repository = requiredString(object, "repository", path);
  const license = requiredString(object, "license", path);
  const commit = requiredString(object, "commit", path);
  if (!PORTABLE_ID.test(id)) configFail(`${path}.id is invalid`);
  validateRepository(repository, path);
  if (license !== "MIT") configFail(`${path}.license must be MIT`);
  if (!FULL_COMMIT_SHA.test(commit)) configFail(`${path}.commit must be a full lowercase commit SHA`);
  return Object.freeze({ id, repository, license: "MIT", commit });
}

function snapshotSourceLock(lock: SourceLock): SourceLock {
  const object = ownDataObject(lock, "lock", LOCK_KEYS);
  if (object.schemaVersion !== 1) configFail("lock.schemaVersion must be exactly 1");
  const sources = snapshotDenseArray(object.sources, "lock.sources")
    .map((source, index) => snapshotLockedSource(source, `lock.sources.${index}`))
    .sort(compareAsciiIds);
  assertUnique(sources.map((source) => ({ ...source, ref: "main", checkout: `vendor-sources/${source.id}` })));
  return Object.freeze({ schemaVersion: 1, sources: Object.freeze(sources) });
}

export function serializeSourceLock(lock: SourceLock): string {
  return `${JSON.stringify(snapshotSourceLock(lock), null, 2)}\n`;
}

async function ensureLockParent(target: string): Promise<void> {
  let parent: Awaited<ReturnType<typeof lstat>>;
  try {
    parent = await lstat(dirname(target));
  } catch {
    throw new SourceLockWriteError("Source lock parent directory is missing or unreadable");
  }
  if (parent.isSymbolicLink() || !parent.isDirectory()) {
    throw new SourceLockWriteError("Source lock parent directory must be a real directory");
  }
}

export async function writeSourceLockFile(target: string, lock: SourceLock): Promise<void> {
  const content = serializeSourceLock(lock);
  await ensureLockParent(target);
  const temporary = join(dirname(target), `.ezagent-source-lock.${process.pid}.${randomUUID()}.tmp`);
  let file: Awaited<ReturnType<typeof open>> | undefined;
  let ownsTemporary = false;
  try {
    file = await open(temporary, "wx");
    ownsTemporary = true;
    await file.writeFile(content, "utf8");
    await file.sync();
    await file.close();
    file = undefined;
    await link(temporary, target);
    await rm(temporary);
    ownsTemporary = false;
  } catch (error: unknown) {
    if (file !== undefined) {
      try { await file.close(); } catch { /* best-effort cleanup */ }
    }
    if (ownsTemporary) {
      try { await rm(temporary, { force: true }); } catch { /* best-effort cleanup */ }
    }
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      throw new SourceLockWriteError("Source lock already exists; remove it explicitly after review to relock");
    }
    if (error instanceof SourceLockWriteError) throw error;
    throw new SourceLockWriteError("Source lock could not be created atomically");
  }
}

export async function lockCatalogSources(projectRoot: string = process.cwd()): Promise<SourceLock> {
  const configPath = resolve(projectRoot, "catalog", "sources.yaml");
  let observed: Awaited<ReturnType<typeof lstat>>;
  try {
    observed = await lstat(configPath);
  } catch {
    throw new SourceConfigError("Catalog sources YAML is missing or unreadable");
  }
  if (observed.isSymbolicLink() || !observed.isFile()) {
    throw new SourceConfigError("Catalog sources YAML must be a real file");
  }
  if (observed.size < 1 || observed.size > MAX_CONFIG_BYTES) {
    throw new SourceConfigError(`Catalog sources YAML must contain between 1 and ${MAX_CONFIG_BYTES} bytes`);
  }
  let configText: string;
  try {
    configText = await readFile(configPath, "utf8");
  } catch {
    throw new SourceConfigError("Catalog sources YAML could not be read");
  }
  const config = parseSourceCandidatesYaml(configText);
  const lock = await createSourceLock(config.sources, async (_checkout, candidate) =>
    resolveLocalCheckoutCommit(projectRoot, candidate));
  await writeSourceLockFile(resolve(projectRoot, "catalog", "sources.lock.json"), lock);
  return lock;
}
