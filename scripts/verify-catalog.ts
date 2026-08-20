import { createHash } from "node:crypto";
import { constants as fsConstants, type Stats } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { types as nodeTypes } from "node:util";

import { parseDocument } from "yaml";

import { validateCatalog, type CatalogValidationError } from "../src/experts/catalog.js";
import { parseSourceLockJson, parseTaxonomyYaml, type TaxonomyMeta } from "../src/experts/importer.js";
import {
  MAX_ATTESTED_LICENSE_BYTES,
  MAX_ATTESTED_SOURCE_LOCK_BYTES,
  REVIEWED_CATALOG_SOURCES,
  type AttestedLicenseEntry,
  type AttestedSourceBase,
  type ReviewedCatalogSourceId,
} from "../src/experts/attested-source-contract.js";
import type { Expert } from "../src/experts/expert.js";

const MAX_NORMALIZED_CATALOG_BYTES = 16 * 1_048_576;
const MAX_TAXONOMY_BYTES = 4 * 1_048_576;
const MAX_NOTICE_BYTES = 64 * 1_024;
const INPUT_KEYS = [
  "normalizedCatalogText",
  "sourceLockText",
  "taxonomyText",
  "thirdPartyNoticeText",
  "licenseFiles",
] as const;
const NORMALIZED_KEYS = ["schemaVersion", "experts"] as const;
const LICENSE_SOURCE_IDS = ["agency-agents", "agency-agents-zh"] as const;

const LICENSE_PATHS: Readonly<Record<ReviewedCatalogSourceId, string>> = Object.freeze({
  "agency-agents": "licenses/agency-agents-MIT.txt",
  "agency-agents-zh": "licenses/agency-agents-zh-MIT.txt",
});
const COPYRIGHT_LINES: Readonly<Record<ReviewedCatalogSourceId, readonly string[]>> = Object.freeze({
  "agency-agents": Object.freeze(["Copyright (c) 2025 Michael Sitarzewski"]),
  "agency-agents-zh": Object.freeze([
    "Copyright (c) 2025 Michael Sitarzewski",
    "Copyright (c) 2026 jnMetaCode",
  ]),
});

export const EXPECTED_THIRD_PARTY_NOTICE = `# Third-Party Notices

EZagent Spec contains normalized Chinese expert definitions and provenance metadata derived from the following MIT-licensed projects.

## Agency Agents

- Repository: https://github.com/msitarzewski/agency-agents
- Copyright: \`Copyright (c) 2025 Michael Sitarzewski\`
- Included material: normalized expert definitions and provenance metadata derived from reviewed English expert definitions
- License: \`licenses/agency-agents-MIT.txt\`

## Agency Agents 中文项目

- Repository: https://github.com/jnMetaCode/agency-agents-zh
- Copyright: \`Copyright (c) 2025 Michael Sitarzewski\`; \`Copyright (c) 2026 jnMetaCode\`
- Included material: normalized Chinese translations, China-original expert definitions, and provenance metadata
- License: \`licenses/agency-agents-zh-MIT.txt\`

No upstream orchestration scripts, service integrations, advertisements, update mechanisms, or runtime code from either project are included.
`;

export interface CatalogVerificationInput {
  normalizedCatalogText: string;
  sourceLockText: string;
  taxonomyText: string;
  thirdPartyNoticeText: string;
  licenseFiles: Record<ReviewedCatalogSourceId, Uint8Array>;
}

export interface CatalogVerificationReport {
  readonly expertCount: number;
  readonly provenanceErrors: readonly string[];
  readonly message: string;
}

export type CatalogVerificationErrorCode =
  | "CATALOG_INPUT_INVALID"
  | "CATALOG_PROVENANCE_INVALID";

export type VerificationErrorGroups = Readonly<Record<string, readonly string[]>>;

export class CatalogVerificationError extends Error {
  override readonly name = "CatalogVerificationError";

  constructor(
    readonly code: CatalogVerificationErrorCode,
    readonly groups: VerificationErrorGroups = Object.freeze({}),
    options?: ErrorOptions,
  ) {
    super(code === "CATALOG_INPUT_INVALID"
      ? "Catalog verification input is invalid"
      : "Catalog provenance verification failed", options);
  }
}

class CatalogVerificationReadError extends Error {
  override readonly name = "CatalogVerificationReadError";

  constructor(
    readonly code: "MISSING_INPUT" | "UNSAFE_INPUT",
    options?: ErrorOptions,
  ) {
    super(code === "MISSING_INPUT"
      ? "Required generated catalog inputs are missing"
      : "Catalog verification files could not be read safely", options);
  }
}

function inputFail(cause?: unknown): never {
  throw new CatalogVerificationError(
    "CATALOG_INPUT_INVALID",
    Object.freeze({}),
    cause === undefined ? undefined : { cause },
  );
}

function ownDataObject(
  value: unknown,
  allowedKeys: readonly string[],
): Record<string, unknown> {
  if (value === null
    || typeof value !== "object"
    || nodeTypes.isProxy(value)
    || Array.isArray(value)) {
    inputFail();
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) inputFail();
  const allowed = new Set(allowedKeys);
  const result: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  try {
    for (const key of Reflect.ownKeys(value)) {
      if (typeof key !== "string" || !allowed.has(key)) inputFail();
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (descriptor === undefined || !descriptor.enumerable || !("value" in descriptor)) inputFail();
      result[key] = descriptor.value;
    }
  } catch (error: unknown) {
    if (error instanceof CatalogVerificationError) throw error;
    inputFail(error);
  }
  return result;
}

function boundedText(value: unknown, maximumBytes: number): string {
  if (typeof value !== "string"
    || value.length === 0
    || value.length > maximumBytes
    || Buffer.byteLength(value, "utf8") > maximumBytes) {
    inputFail();
  }
  return value;
}

function boundedBytes(value: unknown): Buffer {
  if (nodeTypes.isProxy(value)
    || !(value instanceof Uint8Array)
    || value.byteLength < 1
    || value.byteLength > MAX_ATTESTED_LICENSE_BYTES) {
    inputFail();
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Uint8Array.prototype && prototype !== Buffer.prototype) inputFail();
  return Buffer.from(value);
}

function snapshotInput(value: unknown): CatalogVerificationInput {
  const input = ownDataObject(value, INPUT_KEYS);
  for (const key of INPUT_KEYS) {
    if (!Object.hasOwn(input, key)) inputFail();
  }
  const licenses = ownDataObject(input.licenseFiles, LICENSE_SOURCE_IDS);
  if (!LICENSE_SOURCE_IDS.every((id) => Object.hasOwn(licenses, id))) inputFail();
  return Object.freeze({
    normalizedCatalogText: boundedText(input.normalizedCatalogText, MAX_NORMALIZED_CATALOG_BYTES),
    sourceLockText: boundedText(input.sourceLockText, MAX_ATTESTED_SOURCE_LOCK_BYTES),
    taxonomyText: boundedText(input.taxonomyText, MAX_TAXONOMY_BYTES),
    thirdPartyNoticeText: boundedText(input.thirdPartyNoticeText, MAX_NOTICE_BYTES),
    licenseFiles: Object.freeze({
      "agency-agents": boundedBytes(licenses["agency-agents"]),
      "agency-agents-zh": boundedBytes(licenses["agency-agents-zh"]),
    }),
  });
}

function strictJson(text: string): unknown {
  try {
    JSON.parse(text);
    const document = parseDocument(text, { uniqueKeys: true });
    if (document.errors.length > 0 || document.warnings.length > 0) inputFail();
    return document.toJS({ maxAliasCount: 0 });
  } catch (error: unknown) {
    if (error instanceof CatalogVerificationError) throw error;
    inputFail(error);
  }
}

function denseArray(value: unknown, maximum: number): readonly unknown[] {
  if (nodeTypes.isProxy(value) || !Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) inputFail();
  if (value.length > maximum) inputFail();
  for (const key of Reflect.ownKeys(value)) {
    if (key === "length") continue;
    if (typeof key !== "string" || !/^(?:0|[1-9]\d*)$/u.test(key) || Number(key) >= value.length) inputFail();
  }
  const result: unknown[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (descriptor === undefined || !descriptor.enumerable || !("value" in descriptor)) inputFail();
    result.push(descriptor.value);
  }
  return Object.freeze(result);
}

function parseNormalizedCatalog(text: string): {
  readonly experts: readonly Expert[];
  readonly originalIds: readonly string[];
} {
  const root = ownDataObject(strictJson(text), NORMALIZED_KEYS);
  if (root.schemaVersion !== 1 || !Object.hasOwn(root, "experts")) inputFail();
  const rawExperts = denseArray(root.experts, 4_096);
  const originalIds = rawExperts.map((value) => {
    const object = ownDataObject(value, [
      "id", "nameZh", "summaryZh", "instructionsZh", "capabilities", "domains",
      "projectSignals", "activationConditions", "exclusionConditions", "preferredTasks",
      "qualityGates", "origin", "source", "upstreamSource", "contentHash",
    ]);
    return typeof object.id === "string" ? object.id : "";
  });
  let experts: readonly Expert[];
  try {
    experts = validateCatalog(rawExperts, new Set(Object.values(REVIEWED_CATALOG_SOURCES)));
  } catch (error: unknown) {
    inputFail(error as CatalogValidationError);
  }
  return Object.freeze({ experts, originalIds: Object.freeze(originalIds) });
}

function compareCodepoint(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function equalStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function expectedExpertId(path: string): string {
  const parts = path.split("/");
  const filename = parts.at(-1)!;
  return `ezagent.${parts[0]}.${filename.slice(0, -3)}`;
}

function metadataMatches(expert: Expert, metadata: TaxonomyMeta): boolean {
  return expert.origin === metadata.origin
    && (expert.origin === "upstream_translation"
      ? expert.upstreamSource.path === metadata.upstreamPath
      : metadata.upstreamPath === undefined)
    && equalStrings(expert.domains, metadata.domains)
    && equalStrings(expert.capabilities, metadata.capabilities)
    && equalStrings(expert.projectSignals, metadata.projectSignals)
    && equalStrings(expert.activationConditions, metadata.activationConditions)
    && equalStrings(expert.exclusionConditions, metadata.exclusionConditions)
    && equalStrings(expert.preferredTasks, metadata.preferredTasks)
    && equalStrings(expert.qualityGates, metadata.qualityGates);
}

function pushGroup(groups: Map<string, string[]>, group: string, message: string): void {
  const values = groups.get(group) ?? [];
  if (!values.includes(message)) values.push(message);
  groups.set(group, values);
}

function checkInventory(
  groups: Map<string, string[]>,
  sourceId: ReviewedCatalogSourceId,
  source: AttestedSourceBase,
  usedPaths: ReadonlySet<string>,
  ignoredPaths: readonly string[],
): void {
  const ignored = new Set(ignoredPaths);
  for (const path of usedPaths) {
    if (ignored.has(path)) pushGroup(groups, "taxonomy", `${sourceId} path is both used and ignored`);
  }
  const classified = new Set([...usedPaths, ...ignored]);
  const manifest = new Set(source.markdown.map(({ path }) => path));
  if (!equalStrings([...classified].sort(compareCodepoint), [...manifest].sort(compareCodepoint))) {
    pushGroup(groups, "taxonomy", `${sourceId} Markdown inventory is not classified exactly once`);
  }
}

function checkLicense(
  groups: Map<string, string[]>,
  sourceId: ReviewedCatalogSourceId,
  evidence: AttestedLicenseEntry,
  bytes: Uint8Array,
): void {
  const buffer = Buffer.from(bytes);
  const digest = `sha256:${createHash("sha256").update(buffer).digest("hex")}`;
  const oid = createHash("sha1")
    .update(Buffer.from(`blob ${buffer.length}\0`, "utf8"))
    .update(buffer)
    .digest("hex");
  if (evidence.path !== "LICENSE"
    || evidence.size !== buffer.length
    || evidence.sha256 !== digest
    || evidence.oid !== oid) {
    pushGroup(groups, "licenses", `${sourceId} checked-in license bytes do not match the locked Git blob`);
  }
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(buffer);
  } catch {
    pushGroup(groups, "licenses", `${sourceId} license is not strict UTF-8`);
    return;
  }
  if (text.startsWith("\uFEFF") || text.includes("\r") || !text.endsWith("\n") || text.endsWith("\n\n")) {
    pushGroup(groups, "licenses", `${sourceId} license must use exact LF text with one terminal LF`);
  }
  if (!text.startsWith("MIT License\n")
    || !text.includes("Permission is hereby granted, free of charge")
    || !text.includes('THE SOFTWARE IS PROVIDED "AS IS"')) {
    pushGroup(groups, "licenses", `${sourceId} license does not contain the reviewed MIT grant`);
  }
  for (const copyright of COPYRIGHT_LINES[sourceId]) {
    if (!text.split("\n").includes(copyright)) {
      pushGroup(groups, "licenses", `${sourceId} license copyright does not match the notice`);
    }
  }
}

function checkNotice(groups: Map<string, string[]>, text: string): void {
  if (text !== EXPECTED_THIRD_PARTY_NOTICE) {
    pushGroup(groups, "notices", "THIRD_PARTY_NOTICES.md does not match the reviewed fixed mapping");
  }
  for (const sourceId of LICENSE_SOURCE_IDS) {
    const repository = REVIEWED_CATALOG_SOURCES[sourceId];
    const licensePath = LICENSE_PATHS[sourceId];
    if (text.split(repository).length !== 2 || text.split(licensePath).length !== 2) {
      pushGroup(groups, "notices", `${sourceId} repository/license mapping is missing or duplicated`);
    }
    for (const copyright of COPYRIGHT_LINES[sourceId]) {
      if (!text.includes(copyright)) pushGroup(groups, "notices", `${sourceId} copyright is missing`);
    }
  }
}

/** Pure verification: consumes only already-loaded, bounded offline bytes. */
export function verifyCatalogProvenance(untrustedInput: unknown): CatalogVerificationReport {
  const input = snapshotInput(untrustedInput);
  const normalized = parseNormalizedCatalog(input.normalizedCatalogText);
  let sourceLock: ReturnType<typeof parseSourceLockJson>;
  let taxonomy: ReturnType<typeof parseTaxonomyYaml>;
  try {
    sourceLock = parseSourceLockJson(input.sourceLockText);
    taxonomy = parseTaxonomyYaml(input.taxonomyText);
  } catch (error: unknown) {
    inputFail(error);
  }

  const groups = new Map<string, string[]>();
  const sortedIds = [...normalized.originalIds].sort(compareCodepoint);
  if (!equalStrings(normalized.originalIds, sortedIds)) {
    pushGroup(groups, "snapshot", "normalized expert records are not sorted by id");
  }
  if (normalized.originalIds.length !== normalized.experts.length) {
    pushGroup(groups, "snapshot", "normalized expert count changed during validation");
  }

  const english = sourceLock.sourcesById["agency-agents"];
  const chinese = sourceLock.sourcesById["agency-agents-zh"];
  const chineseManifest = new Map(chinese.markdown.map((entry) => [entry.path, entry]));
  const englishManifest = new Map(english.markdown.map((entry) => [entry.path, entry]));
  const chineseUsed = new Set<string>();
  const englishUsed = new Set<string>();

  for (const expert of normalized.experts) {
    const metadata = taxonomy.experts[expert.source.path];
    chineseUsed.add(expert.source.path);
    if (expert.source.repository !== chinese.repository
      || expert.source.commit !== chinese.commit
      || expert.source.license !== chinese.license) {
      pushGroup(groups, "provenance", `${expert.id} Chinese source does not match its locked role`);
    }
    const chineseEntry = chineseManifest.get(expert.source.path);
    if (chineseEntry === undefined || expert.contentHash !== chineseEntry.normalizedSha256) {
      pushGroup(groups, "provenance", `${expert.id} content hash does not match the Chinese manifest`);
    }
    if (metadata === undefined) {
      pushGroup(groups, "taxonomy", `${expert.id} has no explicit taxonomy record`);
    } else {
      if (expert.id !== expectedExpertId(expert.source.path)) {
        pushGroup(groups, "taxonomy", `${expert.id} does not match its source division and filename`);
      }
      if (!metadataMatches(expert, metadata)) {
        pushGroup(groups, "taxonomy", `${expert.id} does not match its explicit taxonomy metadata`);
      }
    }
    if (expert.origin === "upstream_translation") {
      englishUsed.add(expert.upstreamSource.path);
      if (expert.upstreamSource.repository !== english.repository
        || expert.upstreamSource.commit !== english.commit
        || expert.upstreamSource.license !== english.license
        || !englishManifest.has(expert.upstreamSource.path)) {
        pushGroup(groups, "provenance", `${expert.id} English upstream does not match its locked manifest`);
      }
    }
  }

  const taxonomyPaths = Object.keys(taxonomy.experts).sort(compareCodepoint);
  const expertPaths = normalized.experts.map(({ source }) => source.path).sort(compareCodepoint);
  if (!equalStrings(taxonomyPaths, expertPaths)) {
    pushGroup(groups, "taxonomy", "taxonomy expert coverage does not exactly match the snapshot");
  }
  checkInventory(groups, "agency-agents", english, englishUsed, taxonomy.ignoredMarkdown["agency-agents"]);
  checkInventory(groups, "agency-agents-zh", chinese, chineseUsed, taxonomy.ignoredMarkdown["agency-agents-zh"]);
  checkLicense(groups, "agency-agents", english.licenseFile, input.licenseFiles["agency-agents"]);
  checkLicense(groups, "agency-agents-zh", chinese.licenseFile, input.licenseFiles["agency-agents-zh"]);
  checkNotice(groups, input.thirdPartyNoticeText);

  if (groups.size > 0) {
    const stableGroups: Record<string, readonly string[]> = Object.create(null) as Record<string, readonly string[]>;
    for (const [group, messages] of [...groups].sort(([left], [right]) => compareCodepoint(left, right))) {
      stableGroups[group] = Object.freeze([...messages].sort(compareCodepoint));
    }
    throw new CatalogVerificationError(
      "CATALOG_PROVENANCE_INVALID",
      Object.freeze(stableGroups),
    );
  }

  const message = `catalog valid: ${normalized.experts.length} experts, 0 provenance errors`;
  return Object.freeze({
    expertCount: normalized.experts.length,
    provenanceErrors: Object.freeze([]),
    message,
  });
}

function sameFile(left: Stats, right: Stats): boolean {
  return left.isFile()
    && right.isFile()
    && left.dev === right.dev
    && left.ino === right.ino
    && left.size === right.size
    && left.mtimeMs === right.mtimeMs
    && left.ctimeMs === right.ctimeMs;
}

async function safeReadFixedFile(
  projectRoot: string,
  relativePath: string,
  maximumBytes: number,
): Promise<Buffer> {
  // Cross-platform Node has no openat-style ancestor handles. The release command
  // therefore uses a documented static-ancestor model: fixed paths, no symlink
  // ancestors, no-follow where available, and pre/open/post file identity checks.
  // Cryptographic lock/manifest comparisons remain the content-integrity backstop.
  const absolute = join(projectRoot, ...relativePath.split("/"));
  const delta = relative(projectRoot, absolute);
  if (delta === "" || delta === ".." || delta.startsWith(`..${sep}`) || isAbsolute(delta)) {
    throw new CatalogVerificationReadError("UNSAFE_INPUT");
  }
  let current = projectRoot;
  for (const component of delta.split(sep).slice(0, -1)) {
    current = join(current, component);
    let observed: Stats;
    try {
      observed = await lstat(current);
    } catch (error: unknown) {
      throw new CatalogVerificationReadError(
        (error as NodeJS.ErrnoException).code === "ENOENT" ? "MISSING_INPUT" : "UNSAFE_INPUT",
        { cause: error },
      );
    }
    if (observed.isSymbolicLink() || !observed.isDirectory()) {
      throw new CatalogVerificationReadError("UNSAFE_INPUT");
    }
  }
  let before: Stats;
  try {
    before = await lstat(absolute);
  } catch (error: unknown) {
    throw new CatalogVerificationReadError(
      (error as NodeJS.ErrnoException).code === "ENOENT" ? "MISSING_INPUT" : "UNSAFE_INPUT",
      { cause: error },
    );
  }
  if (before.isSymbolicLink() || !before.isFile() || before.size < 1 || before.size > maximumBytes) {
    throw new CatalogVerificationReadError("UNSAFE_INPUT");
  }
  const noFollow = process.platform === "win32" || typeof fsConstants.O_NOFOLLOW !== "number"
    ? 0
    : fsConstants.O_NOFOLLOW;
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(absolute, fsConstants.O_RDONLY | noFollow);
    const openedBefore = await handle.stat();
    if (!sameFile(before, openedBefore)) throw new CatalogVerificationReadError("UNSAFE_INPUT");
    const bytes = await handle.readFile();
    if (bytes.length < 1 || bytes.length > maximumBytes) throw new CatalogVerificationReadError("UNSAFE_INPUT");
    const [openedAfter, pathAfter] = await Promise.all([handle.stat(), lstat(absolute)]);
    if (!sameFile(openedBefore, openedAfter) || !sameFile(openedAfter, pathAfter)) {
      throw new CatalogVerificationReadError("UNSAFE_INPUT");
    }
    return bytes;
  } catch (error: unknown) {
    if (error instanceof CatalogVerificationReadError) throw error;
    throw new CatalogVerificationReadError("UNSAFE_INPUT", { cause: error });
  } finally {
    if (handle !== undefined) {
      try { await handle.close(); } catch { /* preserve read outcome */ }
    }
  }
}

function decodeUtf8(bytes: Buffer): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch (error: unknown) {
    throw new CatalogVerificationReadError("UNSAFE_INPUT", { cause: error });
  }
}

export async function readCatalogVerificationInputs(projectRootInput: string): Promise<CatalogVerificationInput> {
  if (!isAbsolute(projectRootInput) || resolve(projectRootInput) !== projectRootInput) {
    throw new CatalogVerificationReadError("UNSAFE_INPUT");
  }
  let projectRoot: string;
  try {
    projectRoot = await realpath(projectRootInput);
  } catch (error: unknown) {
    throw new CatalogVerificationReadError("UNSAFE_INPUT", { cause: error });
  }
  if (projectRoot !== projectRootInput || !(await lstat(projectRoot)).isDirectory()) {
    throw new CatalogVerificationReadError("UNSAFE_INPUT");
  }
  const [normalized, lock, taxonomy, notice, englishLicense, chineseLicense] = await Promise.all([
    safeReadFixedFile(projectRoot, "catalog/normalized/experts.json", MAX_NORMALIZED_CATALOG_BYTES),
    safeReadFixedFile(projectRoot, "catalog/sources.lock.json", MAX_ATTESTED_SOURCE_LOCK_BYTES),
    safeReadFixedFile(projectRoot, "catalog/taxonomy.yaml", MAX_TAXONOMY_BYTES),
    safeReadFixedFile(projectRoot, "THIRD_PARTY_NOTICES.md", MAX_NOTICE_BYTES),
    safeReadFixedFile(projectRoot, LICENSE_PATHS["agency-agents"], MAX_ATTESTED_LICENSE_BYTES),
    safeReadFixedFile(projectRoot, LICENSE_PATHS["agency-agents-zh"], MAX_ATTESTED_LICENSE_BYTES),
  ]);
  return {
    normalizedCatalogText: decodeUtf8(normalized),
    sourceLockText: decodeUtf8(lock),
    taxonomyText: decodeUtf8(taxonomy),
    thirdPartyNoticeText: decodeUtf8(notice),
    licenseFiles: {
      "agency-agents": englishLicense,
      "agency-agents-zh": chineseLicense,
    },
  };
}

export interface VerifyCatalogCommandOptions {
  readonly projectRoot?: string;
}

export interface VerifyCatalogCommandRuntime {
  readonly readInputs: (projectRoot: string) => Promise<CatalogVerificationInput>;
  readonly writeStdout: (message: string) => void;
  readonly writeStderr: (message: string) => void;
}

const nodeRuntime: VerifyCatalogCommandRuntime = Object.freeze({
  readInputs: readCatalogVerificationInputs,
  writeStdout: (message: string) => { process.stdout.write(message); },
  writeStderr: (message: string) => { process.stderr.write(message); },
});

export async function main(
  options: VerifyCatalogCommandOptions = {},
  runtime: VerifyCatalogCommandRuntime = nodeRuntime,
): Promise<number> {
  const projectRoot = resolve(options.projectRoot ?? process.cwd());
  try {
    const report = verifyCatalogProvenance(await runtime.readInputs(projectRoot));
    runtime.writeStdout(`${report.message}\n`);
    return 0;
  } catch (error: unknown) {
    if ((error instanceof CatalogVerificationReadError && error.code === "MISSING_INPUT")
      || (error as NodeJS.ErrnoException).code === "ENOENT") {
      runtime.writeStderr("catalog verification prerequisites are missing; run catalog:lock and catalog:import first\n");
      return 1;
    }
    if (error instanceof CatalogVerificationError && error.code === "CATALOG_PROVENANCE_INVALID") {
      for (const [group, messages] of Object.entries(error.groups)) {
        runtime.writeStderr(`catalog verification failed [${group}]: ${messages.join("; ")}\n`);
      }
      return 1;
    }
    runtime.writeStderr("catalog verification failed [CATALOG_INPUT_INVALID]: checked-in catalog inputs are invalid\n");
    return 1;
  }
}

const entryPath = process.argv[1];
if (entryPath !== undefined && pathToFileURL(resolve(entryPath)).href === import.meta.url) {
  process.exitCode = await main();
}
