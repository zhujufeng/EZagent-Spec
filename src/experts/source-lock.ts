import { createHash, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { constants as fsConstants, type Stats } from "node:fs";
import {
  link,
  lstat,
  open,
  readdir,
  realpath,
  rm,
} from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { devNull } from "node:os";
import { types as nodeTypes } from "node:util";

import { parseDocument } from "yaml";

import {
  assertAttestedSourceLockTextBudget,
  attestedPathCollisionKey,
  createAttestedLicenseEntry,
  createAttestedMarkdownEntry,
  MAX_ATTESTED_LICENSE_BYTES,
  MAX_ATTESTED_MARKDOWN_BYTES,
  MAX_ATTESTED_MARKDOWN_FILES,
  MAX_ATTESTED_SOURCE_LOCK_BYTES,
  MAX_ATTESTED_TOTAL_BYTES,
  REVIEWED_CATALOG_SOURCES,
  snapshotReviewedSourceLockV2,
  validateAttestedMarkdownPath,
  type AttestedMarkdownEntry,
  type AttestedLicenseEntry,
} from "./attested-source-contract.js";
import { readBoundedFileHandle } from "./bounded-read.js";

const CONFIG_KEYS = ["schemaVersion", "sources"] as const;
const CANDIDATE_KEYS = ["id", "repository", "ref", "checkout", "license"] as const;
const LOCK_KEYS = ["schemaVersion", "sources"] as const;
const MAX_SOURCES = 64;
const MAX_CONFIG_BYTES = 1_048_576;
const MAX_GIT_OUTPUT = 1_048_576;
const MAX_MARKDOWN_FILES = MAX_ATTESTED_MARKDOWN_FILES;
const MAX_MARKDOWN_BYTES = MAX_ATTESTED_MARKDOWN_BYTES;
const MAX_TOTAL_MARKDOWN_BYTES = MAX_ATTESTED_TOTAL_BYTES;
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
const FULL_BRANCH_REF = /^refs\/heads\/[A-Za-z0-9][A-Za-z0-9._/-]*$/u;
const COMMIT_PREFIX = /^[0-9a-f]{7,40}$/u;
const FULL_COMMIT_SHA = /^[0-9a-f]{40}$/u;

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

export type MarkdownAttestation = AttestedMarkdownEntry;

export interface LegacySourceLock {
  readonly schemaVersion: 1;
  readonly sources: readonly LockedSource[];
}

export interface AttestedLockedSource extends LockedSource {
  readonly tree: string;
  readonly objectFormat: "sha1";
  readonly licenseFile: AttestedLicenseEntry;
  readonly markdown: readonly MarkdownAttestation[];
}

export interface AttestedSourceLock {
  readonly schemaVersion: 2;
  readonly sources: readonly AttestedLockedSource[];
}

export type SourceLock = LegacySourceLock | AttestedSourceLock;

export type SourceCommitResolver = (
  checkout: string,
  candidate: Readonly<SourceCandidate>,
) => Promise<string>;

export type GitRunner = (args: readonly string[]) => Promise<string>;
export type GitBinaryRunner = (args: readonly string[]) => Promise<Buffer>;

export interface SourceConfigReadHandle {
  readonly stat: () => Promise<Stats>;
  readonly readText: () => Promise<string>;
  readonly close: () => Promise<void>;
}

export interface SourceConfigReadRuntime {
  readonly lstat: (path: string) => Promise<Stats>;
  readonly openNoFollow: (path: string) => Promise<SourceConfigReadHandle>;
}

export interface SourceLockTemporaryHandle {
  readonly writeText: (content: string) => Promise<void>;
  readonly sync: () => Promise<void>;
  readonly stat: () => Promise<Stats>;
  readonly close: () => Promise<void>;
}

export interface SourceLockPublishRuntime {
  readonly lstat: (path: string) => Promise<Stats>;
  readonly inspectFileNoFollow: (
    path: string,
    maxBytes: number,
  ) => Promise<{ readonly stat: Stats; readonly content: string }>;
  readonly openTemporary: (path: string) => Promise<SourceLockTemporaryHandle>;
  readonly link: (existingPath: string, newPath: string) => Promise<void>;
  readonly remove: (path: string, options: { readonly force: boolean }) => Promise<void>;
  readonly syncDirectory: (path: string) => Promise<"synced" | "unsupported">;
}

export type SourceLockPublishWarningCode =
  | "TEMPORARY_RETAINED"
  | "DIRECTORY_SYNC_FAILED"
  | "DIRECTORY_SYNC_UNSUPPORTED";

export interface SourceLockPublishWarning {
  readonly code: SourceLockPublishWarningCode;
  readonly message: string;
}

export interface SourceLockPublishResult {
  readonly published: true;
  readonly warnings: readonly SourceLockPublishWarning[];
}

export interface LockCatalogSourcesOptions {
  readonly configReadRuntime?: SourceConfigReadRuntime;
  readonly gitRunner?: GitRunner;
  readonly gitBinaryRunner?: GitBinaryRunner;
  readonly publishRuntime?: SourceLockPublishRuntime;
  readonly onPublishWarning?: (warning: SourceLockPublishWarning) => void;
}

export type SourceConfigErrorCode =
  | "SOURCE_CONFIG_INVALID"
  | "SOURCE_CONFIG_UNREADABLE"
  | "SOURCE_CONFIG_CHANGED";

export type LocalCheckoutErrorCode =
  | "PROJECT_ROOT_UNREADABLE"
  | "CHECKOUT_MISSING"
  | "CHECKOUT_SYMLINK"
  | "CHECKOUT_NOT_DIRECTORY"
  | "CHECKOUT_CHANGED"
  | "NOT_GIT_WORKTREE"
  | "WORKTREE_ROOT_MISMATCH"
  | "GIT_COMMAND_FAILED"
  | "GIT_OUTPUT_INVALID"
  | "CONFIG_UNSAFE"
  | "CONFIG_CHANGED"
  | "GIT_METADATA_UNSAFE"
  | "REPLACE_REFS_UNSUPPORTED"
  | "GRAFTS_UNSUPPORTED"
  | "ORIGIN_MISMATCH"
  | "WORKTREE_DIRTY"
  | "INDEX_FLAGS_UNSAFE"
  | "TRACKED_SYMLINK_UNSUPPORTED"
  | "GITLINK_UNSUPPORTED"
  | "SPARSE_CHECKOUT_UNSUPPORTED"
  | "PARTIAL_CLONE_UNSUPPORTED"
  | "HEAD_UNRESOLVED"
  | "REF_UNRESOLVED"
  | "REF_MISMATCH"
  | "OBJECTS_INCOMPLETE";

export class SourceConfigError extends Error {
  override readonly name = "SourceConfigError";

  constructor(
    readonly code: SourceConfigErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
  }
}

export class SourceLockError extends Error {
  override readonly name = "SourceLockError";

  constructor(
    readonly code: "RESOLVER_FAILED" | "INVALID_RESOLVED_COMMIT",
    readonly sourceId: string,
    options?: ErrorOptions,
  ) {
    super(code === "RESOLVER_FAILED"
      ? `Source ${sourceId} could not be resolved from its local checkout`
      : `Source ${sourceId} did not resolve to a 40-character lowercase commit SHA`, options);
  }
}

export class LocalCheckoutError extends Error {
  override readonly name = "LocalCheckoutError";

  constructor(
    readonly code: LocalCheckoutErrorCode,
    readonly sourceId: string,
    options?: ErrorOptions,
  ) {
    super(localCheckoutErrorMessage(code, sourceId), options);
  }
}

export class SourceLockWriteError extends Error {
  override readonly name = "SourceLockWriteError";

  constructor(
    readonly code:
      | "LOCK_PARENT_INVALID"
      | "LOCK_PARENT_CHANGED"
      | "LOCK_STAGING_CHANGED"
      | "LOCK_EXISTS"
      | "LOCK_PUBLISH_FAILED",
    readonly publicationState: "not-published" | "published" | "unknown",
    options?: ErrorOptions & { readonly temporaryState?: "none" | "retained" },
  ) {
    const temporaryState = options?.temporaryState ?? "none";
    super(sourceLockWriteErrorMessage(code, publicationState, temporaryState), options);
    this.temporaryState = temporaryState;
  }

  readonly temporaryState: "none" | "retained";
}

function configFail(message: string): never {
  throw new SourceConfigError("SOURCE_CONFIG_INVALID", `Invalid catalog sources: ${message}`);
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
  if (COMMIT_PREFIX.test(value)) return;
  const branch = value.slice("refs/heads/".length);
  const components = branch.split("/");
  if (!FULL_BRANCH_REF.test(value)
    || value.endsWith(".")
    || value.endsWith("/")
    || value.includes("..")
    || value.includes("//")
    || value.includes("@{")
    || components.some((component) => component.startsWith(".") || component.endsWith(".lock"))) {
    configFail(`${path}.ref must be a full refs/heads/<safe> ref or a lowercase 7-40 hex object prefix`);
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
    } catch (error: unknown) {
      if (error instanceof LocalCheckoutError) throw error;
      throw new SourceLockError("RESOLVER_FAILED", candidate.id, { cause: error });
    }
    if (typeof rawCommit !== "string" || rawCommit.length > 256) {
      throw new SourceLockError("INVALID_RESOLVED_COMMIT", candidate.id);
    }
    const match = /^([0-9a-f]{40})(?:\r?\n)?$/u.exec(rawCommit);
    if (match === null) {
      throw new SourceLockError("INVALID_RESOLVED_COMMIT", candidate.id);
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

class GitCommandExecutionError extends Error {
  override readonly name = "GitCommandExecutionError";
}

function isolatedGitEnvironment(): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (!key.toUpperCase().startsWith("GIT_") && value !== undefined) {
      environment[key] = value;
    }
  }
  environment.GIT_CONFIG_NOSYSTEM = "1";
  // Git for Windows rejects Node's extended-device spelling (`\\.\nul`) here;
  // its native NUL alias is the portable way to disable the global config.
  environment.GIT_CONFIG_GLOBAL = process.platform === "win32" ? "NUL" : devNull;
  environment.GIT_TERMINAL_PROMPT = "0";
  environment.GIT_NO_LAZY_FETCH = "1";
  environment.GIT_NO_REPLACE_OBJECTS = "1";
  environment.GCM_INTERACTIVE = "Never";
  return environment;
}

const nodeGitRunner: GitRunner = async (args) => {
  const { stdout } = await new Promise<{ stdout: string }>((resolvePromise, rejectPromise) => {
    execFile("git", [...args], {
      encoding: "utf8",
      env: isolatedGitEnvironment(),
      maxBuffer: MAX_GIT_OUTPUT,
      windowsHide: true,
    }, (error, stdout) => {
      if (error !== null) {
        rejectPromise(new GitCommandExecutionError("Local Git command failed", { cause: error }));
        return;
      }
      resolvePromise({ stdout });
    });
  });
  return stdout;
};

const nodeGitBinaryRunner: GitBinaryRunner = async (args) => new Promise<Buffer>((resolvePromise, rejectPromise) => {
  execFile("git", [...args], {
    encoding: "buffer",
    env: isolatedGitEnvironment(),
    maxBuffer: MAX_ATTESTED_SOURCE_LOCK_BYTES + 1,
    windowsHide: true,
  }, (error, stdout) => {
    if (error !== null) {
      rejectPromise(new GitCommandExecutionError("Local Git object read failed", { cause: error }));
      return;
    }
    resolvePromise(Buffer.isBuffer(stdout) ? stdout : Buffer.from(stdout));
  });
});

function localCheckoutErrorMessage(code: LocalCheckoutErrorCode, sourceId: string): string {
  const prefix = `Source ${sourceId}`;
  switch (code) {
    case "PROJECT_ROOT_UNREADABLE": return `${prefix} project root is missing or unreadable`;
    case "CHECKOUT_MISSING": return `${prefix} checkout is missing; place the reviewed local checkout under vendor-sources and retry`;
    case "CHECKOUT_SYMLINK": return `${prefix} checkout path cannot contain a symbolic link`;
    case "CHECKOUT_NOT_DIRECTORY": return `${prefix} checkout path must be a real directory`;
    case "CHECKOUT_CHANGED": return `${prefix} checkout changed during verification; keep it static and retry`;
    case "NOT_GIT_WORKTREE": return `${prefix} checkout is not a Git worktree`;
    case "WORKTREE_ROOT_MISMATCH": return `${prefix} checkout must be the Git worktree root`;
    case "GIT_COMMAND_FAILED": return `${prefix} local Git verification command failed; inspect the checkout and retry`;
    case "GIT_OUTPUT_INVALID": return `${prefix} local Git verification returned invalid output`;
    case "CONFIG_UNSAFE": return `${prefix} local Git configuration can alter or execute release verification`;
    case "CONFIG_CHANGED": return `${prefix} local Git configuration changed during verification; keep it static and retry`;
    case "GIT_METADATA_UNSAFE": return `${prefix} Git metadata directory is not a stable real directory`;
    case "REPLACE_REFS_UNSUPPORTED": return `${prefix} contains replacement refs; remove them before release locking`;
    case "GRAFTS_UNSUPPORTED": return `${prefix} contains legacy grafts; remove them before release locking`;
    case "ORIGIN_MISMATCH": return `${prefix} origin does not match the reviewed repository`;
    case "WORKTREE_DIRTY": return `${prefix} checkout must be clean, including tracked, untracked, and ignored files`;
    case "INDEX_FLAGS_UNSAFE": return `${prefix} index uses assume-unchanged, skip-worktree, or an unsupported stage`;
    case "TRACKED_SYMLINK_UNSUPPORTED": return `${prefix} contains a tracked symbolic link, which release import does not follow`;
    case "GITLINK_UNSUPPORTED": return `${prefix} contains a gitlink/submodule, which release import does not follow`;
    case "SPARSE_CHECKOUT_UNSUPPORTED": return `${prefix} uses sparse checkout; disable it and restore the full tree`;
    case "PARTIAL_CLONE_UNSUPPORTED": return `${prefix} uses partial/promisor clone configuration; use a complete local checkout`;
    case "HEAD_UNRESOLVED": return `${prefix} HEAD could not be resolved to a full local commit`;
    case "REF_UNRESOLVED": return `${prefix} reviewed ref could not be resolved unambiguously from local objects`;
    case "REF_MISMATCH": return `${prefix} reviewed ref does not equal HEAD`;
    case "OBJECTS_INCOMPLETE": return `${prefix} locked commit has missing or corrupt reachable local objects`;
  }
}

interface DirectoryIdentity {
  readonly dev: number;
  readonly ino: number;
}

function sameIdentity(left: DirectoryIdentity, right: DirectoryIdentity): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

async function requireRealDirectory(
  path: string,
  sourceId: string,
): Promise<DirectoryIdentity> {
  let observed: Awaited<ReturnType<typeof lstat>>;
  try {
    observed = await lstat(path);
  } catch (error: unknown) {
    throw new LocalCheckoutError("CHECKOUT_MISSING", sourceId, { cause: error });
  }
  if (observed.isSymbolicLink()) {
    throw new LocalCheckoutError("CHECKOUT_SYMLINK", sourceId);
  }
  if (!observed.isDirectory()) {
    throw new LocalCheckoutError("CHECKOUT_NOT_DIRECTORY", sourceId);
  }
  return { dev: observed.dev, ino: observed.ino };
}

async function runCheckoutGit(
  runner: GitRunner,
  checkoutPath: string,
  args: readonly string[],
  sourceId: string,
  failureCode: LocalCheckoutErrorCode,
): Promise<string> {
  try {
    const output = await runner([
      "-C",
      checkoutPath,
      "--no-optional-locks",
      "--no-replace-objects",
      "-c",
      "core.fsmonitor=false",
      "-c",
      "protocol.allow=never",
      "-c",
      "gc.auto=0",
      "-c",
      "maintenance.auto=false",
      ...args,
    ]);
    if (typeof output !== "string" || output.length > MAX_GIT_OUTPUT) {
      throw new LocalCheckoutError("GIT_OUTPUT_INVALID", sourceId);
    }
    return output;
  } catch (error: unknown) {
    if (error instanceof LocalCheckoutError) throw error;
    if (error instanceof GitCommandExecutionError) {
      throw new LocalCheckoutError(failureCode, sourceId, { cause: error.cause });
    }
    throw new LocalCheckoutError("GIT_COMMAND_FAILED", sourceId, { cause: error });
  }
}

function singleGitOutputLine(output: string, sourceId: string, label: string): string {
  const match = /^([^\r\n]*)(?:\r?\n)?$/u.exec(output);
  if (match === null) {
    throw new LocalCheckoutError("GIT_OUTPUT_INVALID", sourceId, {
      cause: new Error(`${label} returned ambiguous output`),
    });
  }
  return match[1]!;
}

interface LocalConfigSnapshot {
  readonly fingerprint: string;
  readonly entries: ReadonlyMap<string, readonly string[]>;
}

function parseScopedLocalConfig(output: string, sourceId: string): LocalConfigSnapshot {
  const entries = new Map<string, string[]>();
  const records = output.split("\0");
  if (records.at(-1) !== "") throw new LocalCheckoutError("GIT_OUTPUT_INVALID", sourceId);
  records.pop();
  if (records.length % 2 !== 0) throw new LocalCheckoutError("GIT_OUTPUT_INVALID", sourceId);
  const localRecords: string[] = [];
  for (let index = 0; index < records.length; index += 2) {
    const scope = records[index]!;
    const record = records[index + 1]!;
    if (!["system", "global", "local", "worktree", "command"].includes(scope)) {
      throw new LocalCheckoutError("GIT_OUTPUT_INVALID", sourceId);
    }
    if (scope !== "local" && scope !== "worktree") continue;
    const separator = record.indexOf("\n");
    if (separator <= 0) throw new LocalCheckoutError("GIT_OUTPUT_INVALID", sourceId);
    const key = record.slice(0, separator).toLowerCase();
    const value = record.slice(separator + 1);
    const values = entries.get(key) ?? [];
    values.push(value);
    entries.set(key, values);
    localRecords.push(scope, record);
  }
  return Object.freeze({
    fingerprint: localRecords.join("\0"),
    entries,
  });
}

function enabledConfigValue(value: string): boolean {
  return !/^(?:false|no|off|0)$/iu.test(value);
}

function isUnsafeLocalConfigKey(key: string): boolean {
  return /^filter\..+\.(?:clean|smudge|process|required)$/u.test(key)
    || /^diff\..+\.(?:command|textconv)$/u.test(key)
    || key === "diff.external"
    || key === "core.fsmonitor"
    || key === "core.fsmonitorhookversion"
    || key === "core.alternaterefscommand"
    || key === "core.hookspath"
    || key === "core.attributesfile"
    || key === "include.path"
    || /^includeif\..+\.path$/u.test(key)
    || key.startsWith("fsck.")
    || key.startsWith("protocol.")
    || key.startsWith("maintenance.")
    || key.startsWith("gc.");
}

function assertRepositoryConfig(
  config: LocalConfigSnapshot,
  candidate: SourceCandidate,
): void {
  for (const key of config.entries.keys()) {
    if (isUnsafeLocalConfigKey(key)) {
      throw new LocalCheckoutError("CONFIG_UNSAFE", candidate.id);
    }
  }
  const origins = config.entries.get("remote.origin.url") ?? [];
  if (origins.length !== 1 || origins[0] !== candidate.repository) {
    throw new LocalCheckoutError("ORIGIN_MISMATCH", candidate.id);
  }
  if ((config.entries.get("core.sparsecheckout") ?? []).some(enabledConfigValue)
    || (config.entries.get("core.sparsecheckoutcone") ?? []).some(enabledConfigValue)) {
    throw new LocalCheckoutError("SPARSE_CHECKOUT_UNSUPPORTED", candidate.id);
  }
  for (const [key, values] of config.entries) {
    if (key === "extensions.partialclone"
      || key.endsWith(".promisor")
      || key.endsWith(".partialclonefilter")) {
      if (values.length > 0) {
        throw new LocalCheckoutError("PARTIAL_CLONE_UNSUPPORTED", candidate.id);
      }
    }
  }
}

async function readAndValidateLocalConfig(
  runner: GitRunner,
  checkoutPath: string,
  candidate: SourceCandidate,
): Promise<LocalConfigSnapshot> {
  const output = await runCheckoutGit(
    runner,
    checkoutPath,
    ["config", "--null", "--list", "--show-scope", "--no-includes"],
    candidate.id,
    "GIT_COMMAND_FAILED",
  );
  const snapshot = parseScopedLocalConfig(output, candidate.id);
  assertRepositoryConfig(snapshot, candidate);
  return snapshot;
}

function assertSafeIndexFlags(output: string, sourceId: string): void {
  for (const entry of output.split("\0")) {
    if (entry === "") continue;
    if (!entry.startsWith("H ")) {
      throw new LocalCheckoutError("INDEX_FLAGS_UNSAFE", sourceId);
    }
  }
}

function assertSafeTrackedEntries(output: string, sourceId: string): void {
  for (const entry of output.split("\0")) {
    if (entry === "") continue;
    const match = /^(\d{6}) [0-9a-f]{40} ([0-3])\t/u.exec(entry);
    if (match === null || match[2] !== "0") {
      throw new LocalCheckoutError("INDEX_FLAGS_UNSAFE", sourceId);
    }
    if (match[1] === "120000") {
      throw new LocalCheckoutError("TRACKED_SYMLINK_UNSUPPORTED", sourceId);
    }
    if (match[1] === "160000") {
      throw new LocalCheckoutError("GITLINK_UNSUPPORTED", sourceId);
    }
    if (match[1] !== "100644" && match[1] !== "100755") {
      throw new LocalCheckoutError("INDEX_FLAGS_UNSAFE", sourceId);
    }
  }
}

interface GitMetadataSnapshot {
  readonly gitDirectoryPath: string;
  readonly gitDirectoryIdentity: DirectoryIdentity;
  readonly commonDirectoryPath: string;
  readonly commonDirectoryIdentity: DirectoryIdentity;
}

function sameCanonicalPath(left: string, right: string): boolean {
  return process.platform === "win32"
    ? left.toLowerCase() === right.toLowerCase()
    : left === right;
}

async function observeGitMetadataDirectory(
  checkoutPath: string,
  output: string,
  sourceId: string,
  label: string,
): Promise<{ readonly path: string; readonly identity: DirectoryIdentity }> {
  const untrustedPath = singleGitOutputLine(output, sourceId, label);
  const resolvedPath = resolve(checkoutPath, untrustedPath);
  let observed: Stats;
  let canonicalPath: string;
  try {
    [observed, canonicalPath] = await Promise.all([
      lstat(resolvedPath),
      realpath(resolvedPath),
    ]);
  } catch (error: unknown) {
    throw new LocalCheckoutError("GIT_METADATA_UNSAFE", sourceId, { cause: error });
  }
  if (observed.isSymbolicLink()
    || !observed.isDirectory()
    || !sameCanonicalPath(canonicalPath, resolvedPath)) {
    throw new LocalCheckoutError("GIT_METADATA_UNSAFE", sourceId);
  }
  return Object.freeze({ path: canonicalPath, identity: observed });
}

async function observeGitMetadata(
  runner: GitRunner,
  checkoutPath: string,
  sourceId: string,
): Promise<GitMetadataSnapshot> {
  const gitDirectory = await observeGitMetadataDirectory(
    checkoutPath,
    await runCheckoutGit(
      runner,
      checkoutPath,
      ["rev-parse", "--absolute-git-dir"],
      sourceId,
      "GIT_METADATA_UNSAFE",
    ),
    sourceId,
    "Git directory",
  );
  const commonDirectory = await observeGitMetadataDirectory(
    checkoutPath,
    await runCheckoutGit(
      runner,
      checkoutPath,
      ["rev-parse", "--git-common-dir"],
      sourceId,
      "GIT_METADATA_UNSAFE",
    ),
    sourceId,
    "Git common directory",
  );
  if (!sameCanonicalPath(gitDirectory.path, commonDirectory.path)) {
    const nestedPath = relative(commonDirectory.path, gitDirectory.path);
    if (nestedPath === ""
      || isAbsolute(nestedPath)
      || nestedPath === ".."
      || nestedPath.startsWith(`..${sep}`)
      || !nestedPath.startsWith(`worktrees${sep}`)) {
      throw new LocalCheckoutError("GIT_METADATA_UNSAFE", sourceId);
    }
  }
  return Object.freeze({
    gitDirectoryPath: gitDirectory.path,
    gitDirectoryIdentity: gitDirectory.identity,
    commonDirectoryPath: commonDirectory.path,
    commonDirectoryIdentity: commonDirectory.identity,
  });
}

function sameGitMetadata(left: GitMetadataSnapshot, right: GitMetadataSnapshot): boolean {
  return sameCanonicalPath(left.gitDirectoryPath, right.gitDirectoryPath)
    && sameIdentity(left.gitDirectoryIdentity, right.gitDirectoryIdentity)
    && sameCanonicalPath(left.commonDirectoryPath, right.commonDirectoryPath)
    && sameIdentity(left.commonDirectoryIdentity, right.commonDirectoryIdentity);
}

async function assertNoGrafts(metadata: GitMetadataSnapshot, sourceId: string): Promise<void> {
  const infoPath = join(metadata.commonDirectoryPath, "info");
  let info: Stats;
  try {
    info = await lstat(infoPath);
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw new LocalCheckoutError("GIT_METADATA_UNSAFE", sourceId, { cause: error });
  }
  if (info.isSymbolicLink() || !info.isDirectory()) {
    throw new LocalCheckoutError("GIT_METADATA_UNSAFE", sourceId);
  }
  try {
    await lstat(join(infoPath, "grafts"));
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw new LocalCheckoutError("GIT_METADATA_UNSAFE", sourceId, { cause: error });
  }
  throw new LocalCheckoutError("GRAFTS_UNSUPPORTED", sourceId);
}

async function assertNoReplacementRefs(
  runner: GitRunner,
  checkoutPath: string,
  sourceId: string,
): Promise<void> {
  const refs = await runCheckoutGit(
    runner,
    checkoutPath,
    ["for-each-ref", "--format=%(refname)", "--", "refs/replace/"],
    sourceId,
    "GIT_COMMAND_FAILED",
  );
  if (refs !== "") throw new LocalCheckoutError("REPLACE_REFS_UNSUPPORTED", sourceId);
}

async function assertNoPromisorMarkers(
  commonDirectory: string,
  sourceId: string,
): Promise<void> {
  let entries: readonly string[];
  try {
    entries = await readdir(join(commonDirectory, "objects", "pack"));
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw new LocalCheckoutError("GIT_COMMAND_FAILED", sourceId, { cause: error });
  }
  if (entries.some((name) => name.endsWith(".promisor"))) {
    throw new LocalCheckoutError("PARTIAL_CLONE_UNSUPPORTED", sourceId);
  }
}

async function assertSafeGitProvenance(
  runner: GitRunner,
  checkoutPath: string,
  metadata: GitMetadataSnapshot,
  sourceId: string,
): Promise<void> {
  await assertNoGrafts(metadata, sourceId);
  await assertNoReplacementRefs(runner, checkoutPath, sourceId);
  await assertNoPromisorMarkers(metadata.commonDirectoryPath, sourceId);
}

async function assertSafeIndex(
  runner: GitRunner,
  checkoutPath: string,
  sourceId: string,
): Promise<void> {
  assertSafeIndexFlags(await runCheckoutGit(
    runner,
    checkoutPath,
    ["ls-files", "-v", "-z"],
    sourceId,
    "INDEX_FLAGS_UNSAFE",
  ), sourceId);
  assertSafeTrackedEntries(await runCheckoutGit(
    runner,
    checkoutPath,
    ["ls-files", "--stage", "-z"],
    sourceId,
    "INDEX_FLAGS_UNSAFE",
  ), sourceId);
}

async function resolveVerifiedHead(
  runner: GitRunner,
  checkoutPath: string,
  candidate: SourceCandidate,
): Promise<string> {
  const { id } = candidate;
  const head = singleGitOutputLine(await runCheckoutGit(
    runner,
    checkoutPath,
    ["rev-parse", "--verify", "--end-of-options", "HEAD^{commit}"],
    id,
    "HEAD_UNRESOLVED",
  ), id, "HEAD");
  if (!FULL_COMMIT_SHA.test(head)) throw new LocalCheckoutError("HEAD_UNRESOLVED", id);

  const reviewedCommit = singleGitOutputLine(await runCheckoutGit(
    runner,
    checkoutPath,
    ["rev-parse", "--verify", "--end-of-options", `${candidate.ref}^{commit}`],
    id,
    "REF_UNRESOLVED",
  ), id, "reviewed ref");
  if (!FULL_COMMIT_SHA.test(reviewedCommit)
    || (COMMIT_PREFIX.test(candidate.ref) && !reviewedCommit.startsWith(candidate.ref))) {
    throw new LocalCheckoutError("REF_UNRESOLVED", id);
  }
  if (reviewedCommit !== head) throw new LocalCheckoutError("REF_MISMATCH", id);
  return head;
}

async function assertCleanWorktree(
  runner: GitRunner,
  checkoutPath: string,
  sourceId: string,
): Promise<void> {
  const dirt = await runCheckoutGit(
    runner,
    checkoutPath,
    ["status", "--porcelain=v1", "--untracked-files=all", "--ignored=matching"],
    sourceId,
    "WORKTREE_DIRTY",
  );
  if (dirt.length > 0) throw new LocalCheckoutError("WORKTREE_DIRTY", sourceId);
}

interface CheckoutVerification {
  readonly commit: string;
  readonly configFingerprint: string;
  readonly metadata: GitMetadataSnapshot;
}

async function verifyCheckoutSnapshot(
  runner: GitRunner,
  checkoutPath: string,
  candidate: SourceCandidate,
): Promise<CheckoutVerification> {
  const { id } = candidate;
  const inside = singleGitOutputLine(await runCheckoutGit(
    runner,
    checkoutPath,
    ["rev-parse", "--is-inside-work-tree"],
    id,
    "NOT_GIT_WORKTREE",
  ), id, "Git worktree check");
  if (inside !== "true") throw new LocalCheckoutError("NOT_GIT_WORKTREE", id);

  const topLevelOutput = await runCheckoutGit(
    runner,
    checkoutPath,
    ["rev-parse", "--show-toplevel"],
    id,
    "WORKTREE_ROOT_MISMATCH",
  );
  let topLevel: string;
  try {
    topLevel = await realpath(singleGitOutputLine(topLevelOutput, id, "Git worktree root"));
  } catch (error: unknown) {
    if (error instanceof LocalCheckoutError) throw error;
    throw new LocalCheckoutError("WORKTREE_ROOT_MISMATCH", id, { cause: error });
  }
  if (topLevel !== await realpath(checkoutPath)) {
    throw new LocalCheckoutError("WORKTREE_ROOT_MISMATCH", id);
  }

  const initialConfig = await readAndValidateLocalConfig(runner, checkoutPath, candidate);
  const initialMetadata = await observeGitMetadata(runner, checkoutPath, id);
  await assertSafeGitProvenance(runner, checkoutPath, initialMetadata, id);
  await assertSafeIndex(runner, checkoutPath, id);
  const head = await resolveVerifiedHead(runner, checkoutPath, candidate);

  await runCheckoutGit(
    runner,
    checkoutPath,
    ["fsck", "--full", "--no-dangling", "--no-reflogs", head],
    id,
    "OBJECTS_INCOMPLETE",
  );

  const finalConfig = await readAndValidateLocalConfig(runner, checkoutPath, candidate);
  if (initialConfig.fingerprint !== finalConfig.fingerprint) {
    throw new LocalCheckoutError("CONFIG_CHANGED", id);
  }
  const finalMetadata = await observeGitMetadata(runner, checkoutPath, id);
  if (!sameGitMetadata(initialMetadata, finalMetadata)) {
    throw new LocalCheckoutError("CHECKOUT_CHANGED", id);
  }
  await assertSafeGitProvenance(runner, checkoutPath, finalMetadata, id);
  await assertSafeIndex(runner, checkoutPath, id);
  const finalHead = await resolveVerifiedHead(runner, checkoutPath, candidate);
  if (head !== finalHead) throw new LocalCheckoutError("CHECKOUT_CHANGED", id);

  // This is intentionally the final Git semantic check. The importer does not run Git:
  // it validates the lock-bound normalized bytes and exact Markdown path inventory.
  // Keep the release checkout static during import; rerun catalog:lock whenever Git
  // commit, tree, configuration, or worktree state must be proven again.
  await assertCleanWorktree(runner, checkoutPath, id);
  return Object.freeze({
    commit: finalHead,
    configFingerprint: finalConfig.fingerprint,
    metadata: finalMetadata,
  });
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
  } catch (error: unknown) {
    throw new LocalCheckoutError("PROJECT_ROOT_UNREADABLE", candidate.id, { cause: error });
  }
  const vendorDirectory = join(root, "vendor-sources");
  const checkoutPath = resolve(root, candidate.checkout);
  const rootPrefix = root.endsWith(sep) ? root : `${root}${sep}`;
  if (!checkoutPath.startsWith(rootPrefix)) {
    throw new LocalCheckoutError("CHECKOUT_CHANGED", candidate.id);
  }
  await requireRealDirectory(vendorDirectory, candidate.id);
  const before = await requireRealDirectory(checkoutPath, candidate.id);
  const first = await verifyCheckoutSnapshot(runner, checkoutPath, candidate);
  const second = await verifyCheckoutSnapshot(runner, checkoutPath, candidate);
  const after = await requireRealDirectory(checkoutPath, candidate.id);
  if (!sameIdentity(before, after)
    || first.commit !== second.commit
    || first.configFingerprint !== second.configFingerprint
    || !sameGitMetadata(first.metadata, second.metadata)) {
    throw new LocalCheckoutError("CHECKOUT_CHANGED", candidate.id);
  }
  return second.commit;
}

function safeManifestPath(value: string, sourceId: string): string {
  try {
    return validateAttestedMarkdownPath(value, `source ${sourceId} manifest path`);
  } catch (error: unknown) {
    throw new LocalCheckoutError("GIT_OUTPUT_INVALID", sourceId);
  }
}

async function runCheckoutGitBytes(
  runner: GitBinaryRunner,
  checkoutPath: string,
  args: readonly string[],
  sourceId: string,
  maximumBytes = MAX_MARKDOWN_BYTES,
): Promise<Buffer> {
  try {
    const bytes = await runner([
      "-C",
      checkoutPath,
      "--no-optional-locks",
      "--no-replace-objects",
      "-c",
      "core.fsmonitor=false",
      "-c",
      "protocol.allow=never",
      "-c",
      "gc.auto=0",
      "-c",
      "maintenance.auto=false",
      ...args,
    ]);
    if (!Buffer.isBuffer(bytes) || bytes.length > maximumBytes) {
      throw new LocalCheckoutError("GIT_OUTPUT_INVALID", sourceId);
    }
    return bytes;
  } catch (error: unknown) {
    if (error instanceof LocalCheckoutError) throw error;
    if (error instanceof GitCommandExecutionError) {
      throw new LocalCheckoutError("OBJECTS_INCOMPLETE", sourceId, { cause: error.cause });
    }
    throw new LocalCheckoutError("GIT_COMMAND_FAILED", sourceId, { cause: error });
  }
}

async function attestCommittedMarkdown(
  checkoutPath: string,
  candidate: SourceCandidate,
  commit: string,
  runner: GitRunner,
  binaryRunner: GitBinaryRunner,
): Promise<Pick<AttestedLockedSource, "tree" | "objectFormat" | "licenseFile" | "markdown">> {
  const objectFormat = singleGitOutputLine(await runCheckoutGit(
    runner,
    checkoutPath,
    ["rev-parse", "--show-object-format"],
    candidate.id,
    "GIT_OUTPUT_INVALID",
  ), candidate.id, "object format");
  if (objectFormat !== "sha1") throw new LocalCheckoutError("GIT_OUTPUT_INVALID", candidate.id);
  const tree = singleGitOutputLine(await runCheckoutGit(
    runner,
    checkoutPath,
    ["rev-parse", "--verify", "--end-of-options", `${commit}^{tree}`],
    candidate.id,
    "GIT_OUTPUT_INVALID",
  ), candidate.id, "commit tree");
  if (!FULL_COMMIT_SHA.test(tree)) throw new LocalCheckoutError("GIT_OUTPUT_INVALID", candidate.id);
  const listing = await runCheckoutGitBytes(
    binaryRunner,
    checkoutPath,
    ["ls-tree", "-r", "-z", "--full-tree", commit],
    candidate.id,
    MAX_ATTESTED_SOURCE_LOCK_BYTES,
  );
  const manifest: MarkdownAttestation[] = [];
  let licenseFile: AttestedLicenseEntry | undefined;
  let totalBytes = 0;
  const seen = new Set<string>();
  if (listing.length > 0 && listing.at(-1) !== 0) throw new LocalCheckoutError("GIT_OUTPUT_INVALID", candidate.id);
  let start = 0;
  while (start < listing.length) {
    const end = listing.indexOf(0, start);
    if (end < 0 || end === start) throw new LocalCheckoutError("GIT_OUTPUT_INVALID", candidate.id);
    let record: string;
    try {
      record = new TextDecoder("utf-8", { fatal: true }).decode(listing.subarray(start, end));
    } catch (error: unknown) {
      throw new LocalCheckoutError("GIT_OUTPUT_INVALID", candidate.id, { cause: error });
    }
    start = end + 1;
    const match = /^(100644|100755) blob ([0-9a-f]{40})\t([^\r\n\0]+)$/u.exec(record);
    if (match === null) throw new LocalCheckoutError("GIT_OUTPUT_INVALID", candidate.id);
    const path = match[3]!;
    if (path === "LICENSE") {
      if (match[1] !== "100644" || licenseFile !== undefined) {
        throw new LocalCheckoutError("GIT_OUTPUT_INVALID", candidate.id);
      }
      const oid = match[2]!;
      const bytes = await runCheckoutGitBytes(
        binaryRunner,
        checkoutPath,
        ["cat-file", "blob", oid],
        candidate.id,
        MAX_ATTESTED_LICENSE_BYTES,
      );
      try {
        licenseFile = createAttestedLicenseEntry(path, oid, bytes);
      } catch (error: unknown) {
        throw new LocalCheckoutError("GIT_OUTPUT_INVALID", candidate.id, { cause: error });
      }
      continue;
    }
    if (/\.md$/iu.test(path) && !path.endsWith(".md")) throw new LocalCheckoutError("GIT_OUTPUT_INVALID", candidate.id);
    if (!path.endsWith(".md")) continue;
    safeManifestPath(path, candidate.id);
    const collision = attestedPathCollisionKey(path);
    if (seen.has(collision)) throw new LocalCheckoutError("GIT_OUTPUT_INVALID", candidate.id);
    seen.add(collision);
    if (manifest.length >= MAX_MARKDOWN_FILES) throw new LocalCheckoutError("GIT_OUTPUT_INVALID", candidate.id);
    const oid = match[2]!;
    const bytes = await runCheckoutGitBytes(binaryRunner, checkoutPath, ["cat-file", "blob", oid], candidate.id);
    totalBytes += bytes.length;
    if (totalBytes > MAX_TOTAL_MARKDOWN_BYTES) throw new LocalCheckoutError("GIT_OUTPUT_INVALID", candidate.id);
    const calculatedOid = createHash("sha1")
      .update(Buffer.from(`blob ${bytes.length}\0`, "utf8"))
      .update(bytes)
      .digest("hex");
    if (calculatedOid !== oid) throw new LocalCheckoutError("OBJECTS_INCOMPLETE", candidate.id);
    try {
      manifest.push(createAttestedMarkdownEntry(path, oid, bytes));
    } catch (error: unknown) {
      throw new LocalCheckoutError("GIT_OUTPUT_INVALID", candidate.id, { cause: error });
    }
  }
  if (licenseFile === undefined) throw new LocalCheckoutError("GIT_OUTPUT_INVALID", candidate.id);
  manifest.sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0);
  return Object.freeze({
    tree,
    objectFormat: "sha1",
    licenseFile,
    markdown: Object.freeze(manifest),
  });
}

export async function resolveLocalCheckoutAttestation(
  projectRoot: string,
  untrustedCandidate: SourceCandidate,
  runner: GitRunner = nodeGitRunner,
  binaryRunner: GitBinaryRunner = nodeGitBinaryRunner,
): Promise<AttestedLockedSource> {
  const candidate = parseSourceCandidatesConfig({ schemaVersion: 1, sources: [untrustedCandidate] }).sources[0]!;
  const root = await realpath(projectRoot).catch((error: unknown) => {
    throw new LocalCheckoutError("PROJECT_ROOT_UNREADABLE", candidate.id, { cause: error });
  });
  const checkoutPath = resolve(root, candidate.checkout);
  const commit = await resolveLocalCheckoutCommit(root, candidate, runner);
  const attestation = await attestCommittedMarkdown(checkoutPath, candidate, commit, runner, binaryRunner);
  const finalCommit = await resolveLocalCheckoutCommit(root, candidate, runner);
  if (finalCommit !== commit) throw new LocalCheckoutError("CHECKOUT_CHANGED", candidate.id);
  return Object.freeze({
    id: candidate.id,
    repository: candidate.repository,
    license: "MIT",
    commit,
    ...attestation,
  });
}

function snapshotLockedSource(value: unknown, path: string): LockedSource {
  const object = ownDataObject(value, path, ["id", "repository", "license", "commit"]);
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
  if (object.schemaVersion !== 1 && object.schemaVersion !== 2) configFail("lock.schemaVersion must be 1 or 2");
  if (object.schemaVersion === 2) {
    try {
      return snapshotReviewedSourceLockV2(lock) as SourceLock;
    } catch (error: unknown) {
      configFail(`lock does not match the shared reviewed v2 contract: ${(error as Error).message}`);
    }
  }
  const sources = snapshotDenseArray(object.sources, "lock.sources")
    .map((source, index) => snapshotLockedSource(source, `lock.sources.${index}`))
    .sort(compareAsciiIds);
  assertUnique(sources.map((source) => ({ ...source, ref: "main", checkout: `vendor-sources/${source.id}` })));
  return Object.freeze({ schemaVersion: 1, sources: Object.freeze(sources) });
}

export function serializeSourceLock(lock: SourceLock): string {
  const serialized = `${JSON.stringify(snapshotSourceLock(lock), null, 2)}\n`;
  try {
    assertAttestedSourceLockTextBudget(serialized);
  } catch (error: unknown) {
    configFail(`lock exceeds the shared serialized byte budget: ${(error as Error).message}`);
  }
  return serialized;
}

function sourceLockWriteErrorMessage(
  code:
    | "LOCK_PARENT_INVALID"
    | "LOCK_PARENT_CHANGED"
    | "LOCK_STAGING_CHANGED"
    | "LOCK_EXISTS"
    | "LOCK_PUBLISH_FAILED",
  publicationState: "not-published" | "published" | "unknown",
  temporaryState: "none" | "retained",
): string {
  let message: string;
  switch (code) {
    case "LOCK_PARENT_INVALID":
      message = "Source lock parent directory must be a stable real directory";
      break;
    case "LOCK_PARENT_CHANGED":
      message = publicationState === "unknown"
        ? "Source lock parent changed after link-time publication"
        : "Source lock parent changed before publication; keep catalog static and retry";
      break;
    case "LOCK_STAGING_CHANGED":
      message = publicationState === "unknown"
        ? "Source lock staging or target changed after link-time publication"
        : "Source lock staging changed before publication and was rejected";
      break;
    case "LOCK_EXISTS":
      message = "Source lock already exists; remove it explicitly after review to relock";
      break;
    case "LOCK_PUBLISH_FAILED":
      message = "Source lock could not be published atomically";
      break;
  }
  if (publicationState === "unknown") {
    message += "; publication state unknown; inspect lock path and do not rerun or overwrite blindly";
  }
  if (temporaryState === "retained") {
    message += "; a staging name was conservatively retained and requires manual inspection";
  }
  return message;
}

const UNSUPPORTED_DIRECTORY_SYNC_CODES = new Set(["EINVAL", "ENOTSUP", "ENOSYS"]);
const WINDOWS_UNSUPPORTED_DIRECTORY_SYNC_CODES = new Set(["EACCES", "EBADF", "EISDIR", "EPERM"]);

function isUnsupportedDirectorySync(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException).code;
  return code !== undefined && (
    UNSUPPORTED_DIRECTORY_SYNC_CODES.has(code)
    || (process.platform === "win32" && WINDOWS_UNSUPPORTED_DIRECTORY_SYNC_CODES.has(code))
  );
}

export const nodeSourceLockPublishRuntime: SourceLockPublishRuntime = {
  lstat,
  inspectFileNoFollow: async (path, maxBytes) => {
    let handle: Awaited<ReturnType<typeof open>> | undefined;
    try {
      const noFollow = process.platform === "win32" || typeof fsConstants.O_NOFOLLOW !== "number"
        ? 0
        : fsConstants.O_NOFOLLOW;
      handle = await open(path, fsConstants.O_RDONLY | noFollow);
      const stat = await handle.stat();
      if (!stat.isFile() || stat.size < 0 || stat.size > maxBytes) {
        throw new Error("Published source lock is not a bounded regular file");
      }
      const bytes = await readBoundedFileHandle(handle, stat, maxBytes);
      const content = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      await handle.close();
      handle = undefined;
      return { stat, content };
    } finally {
      if (handle !== undefined) {
        try { await handle.close(); } catch { /* preserve the primary inspection error */ }
      }
    }
  },
  openTemporary: async (path) => {
    const handle = await open(path, "wx");
    return {
      writeText: async (content) => handle.writeFile(content, "utf8"),
      sync: async () => handle.sync(),
      stat: async () => handle.stat(),
      close: async () => handle.close(),
    };
  },
  link,
  remove: async (path, options) => rm(path, { force: options.force }),
  syncDirectory: async (path) => {
    let handle: Awaited<ReturnType<typeof open>> | undefined;
    try {
      handle = await open(path, fsConstants.O_RDONLY);
      await handle.sync();
      await handle.close();
      handle = undefined;
      return "synced";
    } catch (error: unknown) {
      if (handle !== undefined) {
        try { await handle.close(); } catch { /* preserve the primary sync/open error */ }
      }
      if (isUnsupportedDirectorySync(error)) return "unsupported";
      throw error;
    }
  },
};

async function observeLockParent(
  runtime: SourceLockPublishRuntime,
  parentPath: string,
): Promise<Stats> {
  let observed: Stats;
  try {
    observed = await runtime.lstat(parentPath);
  } catch (error: unknown) {
    throw new SourceLockWriteError("LOCK_PARENT_INVALID", "not-published", { cause: error });
  }
  if (observed.isSymbolicLink() || !observed.isDirectory()) {
    throw new SourceLockWriteError("LOCK_PARENT_INVALID", "not-published");
  }
  return observed;
}

function samePublishedFile(left: Stats, right: Stats): boolean {
  return left.isFile()
    && right.isFile()
    && sameIdentity(left, right)
    && left.size === right.size;
}

export async function writeSourceLockFile(
  target: string,
  lock: SourceLock,
  runtime: SourceLockPublishRuntime = nodeSourceLockPublishRuntime,
): Promise<SourceLockPublishResult> {
  const content = serializeSourceLock(lock);
  const parentPath = dirname(target);
  const parentBefore = await observeLockParent(runtime, parentPath);
  const temporary = join(parentPath, `.ezagent-source-lock.${process.pid}.${randomUUID()}.tmp`);
  const warnings: SourceLockPublishWarning[] = [];
  let file: SourceLockTemporaryHandle | undefined;
  let temporaryCreated = false;
  let linkSucceeded = false;
  let targetLinkAttempted = false;

  try {
    file = await runtime.openTemporary(temporary);
    temporaryCreated = true;
    await file.writeText(content);
    await file.sync();
    const temporaryIdentity = await file.stat();
    await file.close();
    file = undefined;

    const parentBeforeLink = await observeLockParent(runtime, parentPath);
    if (!sameIdentity(parentBefore, parentBeforeLink)) {
      throw new SourceLockWriteError("LOCK_PARENT_CHANGED", "not-published");
    }

    let temporaryBeforeLink: Stats;
    try {
      temporaryBeforeLink = await runtime.lstat(temporary);
    } catch (error: unknown) {
      throw new SourceLockWriteError("LOCK_STAGING_CHANGED", "not-published", { cause: error });
    }
    if (!samePublishedFile(temporaryIdentity, temporaryBeforeLink)
      || temporaryIdentity.size !== Buffer.byteLength(content, "utf8")) {
      throw new SourceLockWriteError("LOCK_STAGING_CHANGED", "not-published");
    }

    targetLinkAttempted = true;
    await runtime.link(temporary, target);
    targetLinkAttempted = false;
    linkSucceeded = true;
    let targetAfterLink: Stats | undefined;
    let targetInspection: Awaited<ReturnType<SourceLockPublishRuntime["inspectFileNoFollow"]>> | undefined;
    try {
      targetAfterLink = await runtime.lstat(target);
      targetInspection = await runtime.inspectFileNoFollow(
        target,
        Buffer.byteLength(content, "utf8"),
      );
    } catch (error: unknown) {
      throw new SourceLockWriteError("LOCK_STAGING_CHANGED", "unknown", { cause: error });
    }
    if (targetAfterLink === undefined
      || targetInspection === undefined
      || !samePublishedFile(temporaryIdentity, targetAfterLink)
      || !samePublishedFile(targetAfterLink, targetInspection.stat)
      || targetInspection.content !== content) {
      throw new SourceLockWriteError("LOCK_STAGING_CHANGED", "unknown");
    }
    let parentAfterLink: Stats;
    try {
      parentAfterLink = await observeLockParent(runtime, parentPath);
    } catch (error: unknown) {
      throw new SourceLockWriteError("LOCK_PARENT_CHANGED", "unknown", {
        cause: error instanceof SourceLockWriteError ? error.cause : error,
      });
    }
    if (!sameIdentity(parentBefore, parentAfterLink)) {
      throw new SourceLockWriteError("LOCK_PARENT_CHANGED", "unknown");
    }

    try {
      const directorySync = await runtime.syncDirectory(parentPath);
      if (directorySync === "unsupported") {
        warnings.push({
          code: "DIRECTORY_SYNC_UNSUPPORTED",
          message: "Source lock was published, but parent-directory sync is not supported on this platform",
        });
      }
    } catch {
      warnings.push({
        code: "DIRECTORY_SYNC_FAILED",
        message: "Source lock was published, but parent-directory durability could not be confirmed",
      });
    }

    warnings.push({
      code: "TEMPORARY_RETAINED",
      message: "Source lock was published; its staging hard-link name was conservatively retained for manual inspection",
    });

    return Object.freeze({ published: true, warnings: Object.freeze(warnings) });
  } catch (error: unknown) {
    if (file !== undefined) {
      try { await file.close(); } catch { /* best-effort cleanup */ }
    }
    const temporaryState = temporaryCreated ? "retained" : "none";
    if (error instanceof SourceLockWriteError) {
      throw new SourceLockWriteError(error.code, error.publicationState, {
        cause: error.cause,
        temporaryState,
      });
    }
    if (targetLinkAttempted && (error as NodeJS.ErrnoException).code === "EEXIST") {
      throw new SourceLockWriteError("LOCK_EXISTS", "not-published", {
        cause: error,
        temporaryState,
      });
    }
    throw new SourceLockWriteError(
      "LOCK_PUBLISH_FAILED",
      targetLinkAttempted || linkSucceeded ? "unknown" : "not-published",
      { cause: error, temporaryState },
    );
  }
}

export const nodeSourceConfigReadRuntime: SourceConfigReadRuntime = {
  lstat,
  openNoFollow: async (path) => {
    // Windows may not expose O_NOFOLLOW; readStableSourceConfig binds the fallback
    // handle to pre/post lstat identity under the same static release-input model.
    const noFollow = process.platform === "win32" || typeof fsConstants.O_NOFOLLOW !== "number"
      ? 0
      : fsConstants.O_NOFOLLOW;
    const handle = await open(path, fsConstants.O_RDONLY | noFollow);
    return {
      stat: async () => handle.stat(),
      readText: async () => {
        const expected = await handle.stat();
        const bytes = await readBoundedFileHandle(handle, expected, MAX_CONFIG_BYTES);
        return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      },
      close: async () => handle.close(),
    };
  },
};

function sourceConfigError(
  code: SourceConfigErrorCode,
  options?: ErrorOptions,
): SourceConfigError {
  switch (code) {
    case "SOURCE_CONFIG_INVALID":
      return new SourceConfigError(code, "Catalog sources YAML is invalid", options);
    case "SOURCE_CONFIG_UNREADABLE":
      return new SourceConfigError(code, "Catalog sources YAML must be a readable real file", options);
    case "SOURCE_CONFIG_CHANGED":
      return new SourceConfigError(
        code,
        "Catalog sources YAML or its parent changed during verification; keep release inputs static and retry",
        options,
      );
  }
}

function sameStableFile(left: Stats, right: Stats): boolean {
  return sameIdentity(left, right)
    && left.size === right.size
    && left.mtimeMs === right.mtimeMs
    && left.ctimeMs === right.ctimeMs;
}

async function readStableSourceConfig(
  configPath: string,
  runtime: SourceConfigReadRuntime,
): Promise<string> {
  let pathBefore: Stats;
  let parentBefore: Stats;
  try {
    [pathBefore, parentBefore] = await Promise.all([
      runtime.lstat(configPath),
      runtime.lstat(dirname(configPath)),
    ]);
  } catch (error: unknown) {
    throw sourceConfigError("SOURCE_CONFIG_UNREADABLE", { cause: error });
  }
  if (pathBefore.isSymbolicLink() || !pathBefore.isFile()
    || parentBefore.isSymbolicLink() || !parentBefore.isDirectory()
    || pathBefore.size < 1 || pathBefore.size > MAX_CONFIG_BYTES) {
    throw sourceConfigError("SOURCE_CONFIG_UNREADABLE");
  }

  let handle: SourceConfigReadHandle | undefined;
  let text: string | undefined;
  let failure: unknown;
  try {
    handle = await runtime.openNoFollow(configPath);
    const openedBefore = await handle.stat();
    if (!sameStableFile(pathBefore, openedBefore) || !openedBefore.isFile()) {
      throw sourceConfigError("SOURCE_CONFIG_CHANGED");
    }
    text = await handle.readText();
    const [openedAfter, pathAfter, parentAfter] = await Promise.all([
      handle.stat(),
      runtime.lstat(configPath),
      runtime.lstat(dirname(configPath)),
    ]);
    if (!sameStableFile(openedBefore, openedAfter)
      || !sameStableFile(openedAfter, pathAfter)
      || !sameIdentity(parentBefore, parentAfter)
      || pathAfter.isSymbolicLink()
      || parentAfter.isSymbolicLink()) {
      throw sourceConfigError("SOURCE_CONFIG_CHANGED");
    }
  } catch (error: unknown) {
    failure = error instanceof SourceConfigError
      ? error
      : sourceConfigError("SOURCE_CONFIG_UNREADABLE", { cause: error });
  }
  if (handle !== undefined) {
    try {
      await handle.close();
    } catch (error: unknown) {
      failure ??= sourceConfigError("SOURCE_CONFIG_UNREADABLE", { cause: error });
    }
  }
  if (failure !== undefined) throw failure;
  if (text === undefined) throw sourceConfigError("SOURCE_CONFIG_UNREADABLE");
  return text;
}

export async function lockCatalogSources(
  projectRoot: string = process.cwd(),
  options: LockCatalogSourcesOptions = {},
): Promise<AttestedSourceLock> {
  const configPath = resolve(projectRoot, "catalog", "sources.yaml");
  const configText = await readStableSourceConfig(
    configPath,
    options.configReadRuntime ?? nodeSourceConfigReadRuntime,
  );
  const config = parseSourceCandidatesYaml(configText);
  if (config.sources.length !== 2) configFail("catalog lock requires exactly the two reviewed source roles");
  const reviewed = new Map(config.sources.map((candidate) => [candidate.id, candidate]));
  for (const [id, repository] of Object.entries(REVIEWED_CATALOG_SOURCES)) {
    const candidate = reviewed.get(id);
    if (!candidate || candidate.repository !== repository || candidate.checkout !== `vendor-sources/${id}`) {
      configFail("catalog lock requires exactly the two reviewed source ids, repositories, and checkouts");
    }
  }
  const lockedSources: AttestedLockedSource[] = [];
  for (const candidate of [...config.sources].sort(compareAsciiIds)) {
    lockedSources.push(await resolveLocalCheckoutAttestation(
      projectRoot,
      candidate,
      options.gitRunner,
      options.gitBinaryRunner,
    ));
  }
  const lock: SourceLock = Object.freeze({
    schemaVersion: 2,
    sources: Object.freeze(lockedSources),
  });
  const publication = await writeSourceLockFile(
    resolve(projectRoot, "catalog", "sources.lock.json"),
    lock,
    options.publishRuntime,
  );
  for (const warning of publication.warnings) {
    options.onPublishWarning?.(warning);
  }
  return lock;
}
