import { createHash } from "node:crypto";
import { constants as fsConstants, type Stats } from "node:fs";
import {
  lstat,
  mkdir,
  open,
  opendir,
  realpath,
} from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { types as nodeTypes } from "node:util";

import {
  isAlias,
  isMap,
  isScalar,
  isSeq,
  parseAllDocuments,
  type Document,
  type Node,
} from "yaml";

import { unicodeDefaultCaseFold } from "../text/unicode-case-fold.js";
import { isWellFormedUnicode } from "../text/unicode.js";
import { parseExpert, type Expert, type SourceRef } from "./expert.js";

const NORMALIZE_KEYS = [
  "division",
  "relativePath",
  "markdown",
  "source",
  "upstreamSource",
  "taxonomy",
] as const;
const TAXONOMY_KEYS = ["schemaVersion", "divisions", "experts", "ignoredMarkdown"] as const;
const DIVISION_KEYS = ["defaultDomains"] as const;
const META_KEYS = [
  "domains",
  "capabilities",
  "projectSignals",
  "activationConditions",
  "exclusionConditions",
  "preferredTasks",
  "qualityGates",
  "origin",
  "upstreamPath",
] as const;
const SOURCE_BASE_KEYS = ["repository", "commit", "license", "tree", "objectFormat", "markdown"] as const;
const LOCK_KEYS = ["schemaVersion", "sources"] as const;
const LOCKED_SOURCE_KEYS = ["id", "repository", "license", "commit", "tree", "objectFormat", "markdown"] as const;
const MANIFEST_KEYS = ["path", "oid", "size", "sha256"] as const;
const FRONTMATTER_KEYS = ["name", "description", "emoji", "color"] as const;
const MAX_MARKDOWN_BYTES = 1_048_576;
const MAX_CONFIG_BYTES = 1_048_576;
const MAX_FILES = 4_096;
const MAX_DIRECTORIES = 4_096;
const MAX_DEPTH = 12;
const MAX_TOTAL_BYTES = 64 * 1_048_576;
const MAX_ENTRIES = 16_384;
const MAX_TAXONOMY_EXPERTS = 4_096;
const MAX_DIVISIONS = 128;
const MAX_TEXT = 4_096;
const MAX_SLUG = 64;
const MAX_LISTS = {
  domains: 64,
  capabilities: 128,
  projectSignals: 128,
  activationConditions: 128,
  exclusionConditions: 128,
  preferredTasks: 5,
  qualityGates: 128,
  defaultDomains: 64,
} as const;
const PORTABLE_SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;
const PORTABLE_PATH_COMPONENT = /^[\p{L}\p{N}._-]+$/u;
const FULL_SHA = /^[0-9a-f]{40}$/u;
const HAN = /\p{Script=Han}/u;
const WINDOWS_RESERVED = /^(?:CON|PRN|AUX|NUL|CLOCK\$|CONIN\$|CONOUT\$|COM[1-9]|LPT[1-9])$/u;
const EXPECTED_SOURCES = Object.freeze({
  "agency-agents": "https://github.com/msitarzewski/agency-agents",
  "agency-agents-zh": "https://github.com/jnMetaCode/agency-agents-zh",
} as const);

export type PreferredTask = "clarify" | "design" | "implement" | "verify" | "review";

export interface TaxonomyMeta {
  readonly origin: "upstream_translation" | "china_original";
  readonly upstreamPath?: string;
  readonly domains: readonly string[];
  readonly capabilities: readonly string[];
  readonly projectSignals: readonly string[];
  readonly activationConditions: readonly string[];
  readonly exclusionConditions: readonly string[];
  readonly preferredTasks: readonly PreferredTask[];
  readonly qualityGates: readonly string[];
}

export interface Taxonomy {
  readonly schemaVersion: 1;
  readonly divisions: Readonly<Record<string, { readonly defaultDomains: readonly string[] }>>;
  readonly experts: Readonly<Record<string, TaxonomyMeta>>;
  readonly ignoredMarkdown: Readonly<Record<keyof typeof EXPECTED_SOURCES, readonly string[]>>;
}

export interface SourceBase {
  readonly repository: string;
  readonly commit: string;
  readonly license: "MIT";
  readonly tree: string;
  readonly objectFormat: "sha1";
  readonly markdown: readonly MarkdownManifestEntry[];
}

export interface MarkdownManifestEntry {
  readonly path: string;
  readonly oid: string;
  readonly size: number;
  readonly sha256: string;
}

export interface IndexedMarkdownFile {
  readonly division: string;
  readonly relativePath: string;
  readonly markdown: string;
  readonly source: SourceRef;
}

export interface MarkdownDirectoryEntry {
  readonly name: string;
  readonly isDirectory: () => boolean;
  readonly isFile: () => boolean;
}

export interface MarkdownReadHandle {
  readonly stat: () => Promise<Stats>;
  readonly readBytes: () => Promise<Buffer>;
  readonly close: () => Promise<void>;
}

export interface MarkdownIndexRuntime {
  readonly lstat: (path: string) => Promise<Stats>;
  readonly readdir: (path: string) => Promise<readonly MarkdownDirectoryEntry[]>;
  readonly openNoFollow: (path: string) => Promise<MarkdownReadHandle>;
}

export interface NormalizeInput {
  readonly division: string;
  readonly relativePath: string;
  readonly markdown: string;
  readonly source: SourceRef;
  readonly upstreamSource?: SourceRef;
  readonly taxonomy: TaxonomyMeta;
}

export interface ParsedSourceLock {
  readonly schemaVersion: 2;
  readonly sourcesById: Readonly<Record<keyof typeof EXPECTED_SOURCES, SourceBase>>;
}

export interface ImportExpertCatalogOptions {
  readonly projectRoot: string;
  readonly englishRoot: string;
  readonly chineseRoot: string;
  readonly sourceLockText: string;
  readonly taxonomyText: string;
}

export interface NormalizedCatalogWriteRuntime {
  readonly atomicWriteText: (target: string, content: string) => Promise<void>;
  readonly projectRoot: string;
  readonly beforePublish?: () => Promise<void>;
}

export class CatalogImportError extends Error {
  override readonly name = "CatalogImportError";

  constructor(
    message: string,
    readonly missingDivisions: readonly string[] = [],
    readonly missingExpertPaths: readonly string[] = [],
    readonly extraExpertPaths: readonly string[] = [],
    readonly unclassifiedMarkdownPaths: readonly string[] = [],
    readonly missingUpstreamPaths: readonly string[] = [],
    readonly extraIgnoredPaths: readonly string[] = [],
    options?: ErrorOptions,
  ) {
    super(message, options);
  }
}

export const nodeMarkdownIndexRuntime: MarkdownIndexRuntime = Object.freeze<MarkdownIndexRuntime>({
  lstat,
  readdir: async (path) => {
    const directory = await opendir(path);
    const entries: MarkdownDirectoryEntry[] = [];
    try {
      for await (const entry of directory) {
        if (entries.length >= MAX_ENTRIES) fail("source directory contains too many entries");
        entries.push(entry);
      }
    } finally {
      try { await directory.close(); } catch (error: unknown) {
        if ((error as NodeJS.ErrnoException).code !== "ERR_DIR_CLOSED") throw error;
      }
    }
    return entries;
  },
  openNoFollow: async (path) => {
    // Windows does not reliably expose O_NOFOLLOW. The release tool therefore uses
    // a static-input threat model plus pre-lstat, handle-bound read/stat, post-lstat,
    // canonical realpath checks, and the locked byte manifest as the final backstop.
    const noFollow = process.platform === "win32" || typeof fsConstants.O_NOFOLLOW !== "number"
      ? 0
      : fsConstants.O_NOFOLLOW;
    const handle = await open(path, fsConstants.O_RDONLY | noFollow);
    return {
      stat: async () => handle.stat(),
      readBytes: async () => handle.readFile(),
      close: async () => handle.close(),
    };
  },
});

function fail(message: string, cause?: unknown): never {
  throw new CatalogImportError(
    `Invalid expert catalog input: ${message}`,
    [],
    [],
    [],
    [],
    [],
    [],
    cause === undefined ? undefined : { cause },
  );
}

function collisionKey(value: string): string {
  return unicodeDefaultCaseFold(value.normalize("NFC"));
}

function comparePortable(left: string, right: string): number {
  const leftBytes = Buffer.from(left, "utf8");
  const rightBytes = Buffer.from(right, "utf8");
  return Buffer.compare(leftBytes, rightBytes);
}

function snapshotObject(
  value: unknown,
  path: string,
  allowedKeys: readonly string[],
): Readonly<Record<string, unknown>> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    fail(`${path} must be a plain object`);
  }
  if (nodeTypes.isProxy(value)) fail(`${path} cannot be a Proxy`);
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) fail(`${path} must be a plain object`);
  const allowed = new Set(allowedKeys);
  const result: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string" || !allowed.has(key)) fail(`${path} contains an unsupported key`);
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor?.enumerable || !("value" in descriptor)) fail(`${path}.${key} cannot be an accessor or non-enumerable property`);
    result[key] = descriptor.value;
  }
  return result;
}

function snapshotDictionary(value: unknown, path: string, maximumKeys: number): Readonly<Record<string, unknown>> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) fail(`${path} must be a plain object`);
  if (nodeTypes.isProxy(value)) fail(`${path} cannot be a Proxy`);
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) fail(`${path} must be a plain object`);
  const keys = Reflect.ownKeys(value);
  if (keys.length > maximumKeys) fail(`${path} contains too many keys`);
  const result: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const key of keys) {
    if (typeof key !== "string" || ["__proto__", "prototype", "constructor"].includes(key)) fail(`${path} contains an unsafe key`);
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor?.enumerable || !("value" in descriptor)) fail(`${path}.${key} cannot be an accessor or non-enumerable property`);
    result[key] = descriptor.value;
  }
  return result;
}

function requiredString(
  object: Readonly<Record<string, unknown>>,
  key: string,
  path: string,
  maximum: number,
): string {
  const value = object[key];
  if (typeof value !== "string") fail(`${path}.${key} must be a string`);
  if (value.length === 0 || value.length > maximum) fail(`${path}.${key} length is invalid`);
  if (value !== value.trim() || value.normalize("NFC") !== value || !isWellFormedUnicode(value)) {
    fail(`${path}.${key} must be trimmed canonical Unicode`);
  }
  return value;
}

function snapshotArray(value: unknown, path: string, maximum: number): readonly unknown[] {
  if (nodeTypes.isProxy(value)) fail(`${path} cannot be a Proxy`);
  if (!Array.isArray(value)) fail(`${path} must be an array`);
  const lengthDescriptor = Object.getOwnPropertyDescriptor(value, "length");
  const length = lengthDescriptor && "value" in lengthDescriptor ? lengthDescriptor.value : undefined;
  if (!Number.isSafeInteger(length) || (length as number) < 0 || (length as number) > maximum) {
    fail(`${path} cannot contain more than ${maximum} items`);
  }
  for (const key of Reflect.ownKeys(value)) {
    if (key === "length") continue;
    if (typeof key !== "string" || !/^(?:0|[1-9]\d*)$/u.test(key) || Number(key) >= (length as number)) {
      fail(`${path} contains an unsupported array key`);
    }
  }
  const result: unknown[] = [];
  for (let index = 0; index < (length as number); index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!descriptor?.enumerable || !("value" in descriptor)) fail(`${path} must be a dense data array`);
    result.push(descriptor.value);
  }
  return Object.freeze(result);
}

function stringList(
  value: unknown,
  path: string,
  maximum: number,
  options: { readonly minimum?: number; readonly slug?: boolean; readonly preferred?: boolean } = {},
): readonly string[] {
  const array = snapshotArray(value, path, maximum);
  if (array.length < (options.minimum ?? 0)) fail(`${path} must contain at least ${options.minimum} item(s)`);
  const seen = new Set<string>();
  return Object.freeze(array.map((item, index) => {
    if (typeof item !== "string" || item.length === 0 || item.length > (options.slug ? MAX_SLUG : MAX_TEXT)) {
      fail(`${path}.${index} must be a bounded non-empty string`);
    }
    if (item.trim() !== item || item.normalize("NFC") !== item || !isWellFormedUnicode(item)) {
      fail(`${path}.${index} must be trimmed canonical Unicode`);
    }
    if (options.slug && !PORTABLE_SLUG.test(item)) fail(`${path}.${index} must be a portable slug`);
    if (options.preferred && !["clarify", "design", "implement", "verify", "review"].includes(item)) {
      fail(`${path}.${index} is not a supported task`);
    }
    const key = collisionKey(item);
    if (seen.has(key)) fail(`${path} contains a canonical duplicate`);
    seen.add(key);
    return item;
  }));
}

function snapshotTaxonomyMeta(value: unknown, path: string): TaxonomyMeta {
  const object = snapshotObject(value, path, META_KEYS);
  for (const key of [
    "domains", "capabilities", "projectSignals", "activationConditions",
    "exclusionConditions", "preferredTasks", "qualityGates", "origin",
  ] as const) {
    if (!Object.hasOwn(object, key)) fail(`${path}.${key} is required`);
  }
  const origin = requiredString(object, "origin", path, 32);
  if (origin !== "upstream_translation" && origin !== "china_original") fail(`${path}.origin is invalid`);
  const shared = {
    domains: stringList(object.domains, `${path}.domains`, MAX_LISTS.domains, { minimum: 1, slug: true }),
    capabilities: stringList(object.capabilities, `${path}.capabilities`, MAX_LISTS.capabilities, { minimum: 1, slug: true }),
    projectSignals: stringList(object.projectSignals, `${path}.projectSignals`, MAX_LISTS.projectSignals, { slug: true }),
    activationConditions: stringList(object.activationConditions, `${path}.activationConditions`, MAX_LISTS.activationConditions, { minimum: 1 }),
    exclusionConditions: stringList(object.exclusionConditions, `${path}.exclusionConditions`, MAX_LISTS.exclusionConditions),
    preferredTasks: stringList(object.preferredTasks, `${path}.preferredTasks`, MAX_LISTS.preferredTasks, { minimum: 1, preferred: true }) as readonly PreferredTask[],
    qualityGates: stringList(object.qualityGates, `${path}.qualityGates`, MAX_LISTS.qualityGates, { minimum: 1 }),
  };
  if (origin === "upstream_translation") {
    if (!Object.hasOwn(object, "upstreamPath")) fail(`${path}.upstreamPath is required for translated experts`);
    const upstreamPath = requiredString(object, "upstreamPath", path, 1_024);
    validatePath(upstreamPath, `${path}.upstreamPath`);
    return Object.freeze({ origin, upstreamPath, ...shared });
  }
  if (Object.hasOwn(object, "upstreamPath")) fail(`${path}.upstreamPath is unsupported for China-original experts`);
  return Object.freeze({ origin, ...shared });
}

function yamlNodeToPlain(node: unknown, path: string, depth = 0): unknown {
  if (depth > 16) fail(`${path} exceeds maximum YAML nesting depth`);
  if (node === null) return null;
  const candidate = node as { readonly tag?: string; readonly anchor?: string };
  if (candidate.tag || candidate.anchor || isAlias(node)) fail(`${path} contains an alias, anchor, or custom tag`);
  if (isScalar(node)) return node.value;
  if (isSeq(node)) {
    if (node.items.length > MAX_TAXONOMY_EXPERTS) fail(`${path} is too large`);
    return node.items.map((item, index) => yamlNodeToPlain(item, `${path}.${index}`, depth + 1));
  }
  if (isMap(node)) {
    if (node.items.length > MAX_TAXONOMY_EXPERTS) fail(`${path} is too large`);
    const result: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
    for (const pair of node.items) {
      if (!isScalar(pair.key) || typeof pair.key.value !== "string") fail(`${path} keys must be strings`);
      const key = pair.key.value;
      if (["__proto__", "prototype", "constructor", "<<"].includes(key)) fail(`${path}.${key} is unsafe`);
      if (Object.hasOwn(result, key)) fail(`${path}.${key} is duplicated`);
      result[key] = yamlNodeToPlain(pair.value, `${path}.${key}`, depth + 1);
    }
    return result;
  }
  fail(`${path} contains an unsupported YAML node`);
}

function parseOneYamlDocument(text: string, label: string): unknown {
  if (Buffer.byteLength(text, "utf8") > MAX_CONFIG_BYTES || !isWellFormedUnicode(text)) {
    fail(`${label} is too large or invalid Unicode`);
  }
  if (/^(?:%YAML|%TAG)\b/mu.test(text)) fail(`${label} cannot contain YAML directives`);
  let documents: Document.Parsed[];
  try {
    documents = parseAllDocuments(text, {
      merge: false,
      prettyErrors: false,
      strict: true,
      uniqueKeys: true,
    }) as Document.Parsed[];
  } catch (error: unknown) {
    fail(`${label} is ambiguous YAML`, error);
  }
  if (documents.length !== 1 || documents[0]!.errors.length > 0 || documents[0]!.warnings.length > 0) {
    fail(`${label} must contain exactly one unambiguous YAML document`);
  }
  return yamlNodeToPlain(documents[0]!.contents as Node, label);
}

function validatePath(value: string, label: string, allowHiddenComponents = false): readonly string[] {
  if (
    value.length === 0
    || value.length > 1_024
    || Buffer.byteLength(value, "utf8") > 1_024
    || value.normalize("NFC") !== value
    || !isWellFormedUnicode(value)
    || value.startsWith("/")
    || value.includes("\\")
    || value.includes("%")
    || !value.endsWith(".md")
  ) fail(`${label} must be a canonical portable relative Markdown path`);
  const components = value.split("/");
  for (const component of components) {
    const compatibility = component.normalize("NFKC");
    const basename = compatibility.split(".", 1)[0]!.toUpperCase();
    if (
      component === ""
      || component === "."
      || component === ".."
      || (!allowHiddenComponents && component.startsWith("."))
      || component.endsWith(".")
      || component.endsWith(" ")
      || Buffer.byteLength(component, "utf8") > 255
      || !PORTABLE_PATH_COMPONENT.test(component)
      || WINDOWS_RESERVED.test(basename)
    ) fail(`${label} contains a non-portable component`);
  }
  return components;
}

function sourceReferenceBase(value: unknown, path: string): Omit<SourceRef, "path"> {
  const object = snapshotObject(value, path, ["repository", "commit", "license"]);
  const repository = requiredString(object, "repository", path, 256);
  const commit = requiredString(object, "commit", path, 40);
  const license = requiredString(object, "license", path, 3);
  if (!FULL_SHA.test(commit)) fail(`${path}.commit must be a full lowercase SHA`);
  if (license !== "MIT") fail(`${path}.license must be MIT`);
  if (!Object.values(EXPECTED_SOURCES).includes(repository as never)) fail(`${path}.repository is not reviewed`);
  return Object.freeze({ repository, commit, license: "MIT" });
}

function lockedSourceBase(value: unknown, path: string): SourceBase {
  const object = snapshotObject(value, path, SOURCE_BASE_KEYS);
  const repository = requiredString(object, "repository", path, 256);
  const commit = requiredString(object, "commit", path, 40);
  const license = requiredString(object, "license", path, 3);
  const tree = requiredString(object, "tree", path, 40);
  const objectFormat = requiredString(object, "objectFormat", path, 8);
  if (!FULL_SHA.test(commit)) fail(`${path}.commit must be a full lowercase SHA`);
  if (license !== "MIT") fail(`${path}.license must be MIT`);
  if (!FULL_SHA.test(tree)) fail(`${path}.tree must be a full lowercase SHA`);
  if (objectFormat !== "sha1") fail(`${path}.objectFormat must be sha1`);
  if (!Object.values(EXPECTED_SOURCES).includes(repository as never)) fail(`${path}.repository is not reviewed`);
  const entries = snapshotArray(object.markdown, `${path}.markdown`, MAX_FILES);
  const markdown: MarkdownManifestEntry[] = [];
  const seen = new Set<string>();
  let total = 0;
  for (const [index, rawEntry] of entries.entries()) {
    const entry = snapshotObject(rawEntry, `${path}.markdown.${index}`, MANIFEST_KEYS);
    const manifestPath = requiredString(entry, "path", `${path}.markdown.${index}`, 1_024);
    validatePath(manifestPath, `${path}.markdown.${index}.path`, true);
    const oid = requiredString(entry, "oid", `${path}.markdown.${index}`, 40);
    const sha256 = requiredString(entry, "sha256", `${path}.markdown.${index}`, 71);
    if (!FULL_SHA.test(oid)) fail(`${path}.markdown.${index}.oid is invalid`);
    if (!/^sha256:[0-9a-f]{64}$/u.test(sha256)) fail(`${path}.markdown.${index}.sha256 is invalid`);
    if (!Number.isSafeInteger(entry.size) || (entry.size as number) < 0 || (entry.size as number) > MAX_MARKDOWN_BYTES) {
      fail(`${path}.markdown.${index}.size is invalid`);
    }
    const key = collisionKey(manifestPath);
    if (seen.has(key)) fail(`${path}.markdown contains duplicate paths`);
    seen.add(key);
    total += entry.size as number;
    if (total > MAX_TOTAL_BYTES) fail(`${path}.markdown total bytes are too large`);
    markdown.push(Object.freeze({ path: manifestPath, oid, size: entry.size as number, sha256 }));
  }
  markdown.sort((left, right) => comparePortable(left.path, right.path));
  return Object.freeze({ repository, commit, license: "MIT", tree, objectFormat: "sha1", markdown: Object.freeze(markdown) });
}

function canonicalizeMarkdown(markdown: unknown): string {
  if (typeof markdown !== "string") fail("markdown must be a string");
  if (markdown.length > MAX_MARKDOWN_BYTES + 1 || Buffer.byteLength(markdown, "utf8") > MAX_MARKDOWN_BYTES + 3) {
    fail("markdown is too large");
  }
  let normalized = markdown.startsWith("\uFEFF") ? markdown.slice(1) : markdown;
  normalized = normalized.replaceAll("\r\n", "\n");
  if (normalized.includes("\r") || normalized.includes("\uFEFF") || !isWellFormedUnicode(normalized)) {
    fail("markdown must use well-formed UTF-8 text and CRLF or LF line endings");
  }
  normalized = `${normalized.replace(/\n*$/u, "")}\n`;
  if (Buffer.byteLength(normalized, "utf8") > MAX_MARKDOWN_BYTES) fail("markdown is too large");
  return normalized;
}

function splitFrontmatter(markdown: string): { readonly metadata: Readonly<Record<string, unknown>>; readonly body: string } {
  if (!markdown.startsWith("---\n")) fail("expert file requires YAML frontmatter at byte zero");
  const end = markdown.indexOf("\n---\n", 4);
  if (end < 0) fail("expert file requires a closing frontmatter delimiter");
  const frontmatter = markdown.slice(4, end);
  const raw = parseOneYamlDocument(frontmatter, "frontmatter");
  const metadata = snapshotObject(raw, "frontmatter", FRONTMATTER_KEYS);
  for (const key of ["name", "description"] as const) if (!Object.hasOwn(metadata, key)) fail(`frontmatter.${key} is required`);
  for (const key of ["emoji", "color"] as const) {
    if (!Object.hasOwn(metadata, key)) continue;
    if (typeof metadata[key] !== "string" || metadata[key].length === 0 || metadata[key].length > 32
      || metadata[key].trim() !== metadata[key] || metadata[key].normalize("NFC") !== metadata[key]
      || !isWellFormedUnicode(metadata[key])) {
      fail(`frontmatter.${key} must be a bounded canonical string`);
    }
  }
  if (typeof metadata.emoji === "string" && !/\p{Extended_Pictographic}/u.test(metadata.emoji)) {
    fail("frontmatter.emoji must contain an emoji pictograph");
  }
  if (typeof metadata.color === "string" && !/^[a-z]+(?:-[a-z]+)*$/u.test(metadata.color)) {
    fail("frontmatter.color must be a lowercase portable color token");
  }
  const body = markdown.slice(end + 5).trim();
  if (/^---\s*$/mu.test(body) || /^\.\.\.\s*$/mu.test(body)) {
    fail("expert instructions cannot contain YAML document markers");
  }
  const lastCommentOpen = body.lastIndexOf("<!--");
  const lastCommentClose = body.lastIndexOf("-->");
  if (lastCommentOpen > lastCommentClose) fail("expert instructions contain an unterminated HTML comment");
  const meaningful = body
    .replace(/<!--[^]*?-->/gu, "")
    .replace(/^\s{0,3}#{1,6}\s+.*$/gmu, "")
    .replace(/^.*\n\s{0,3}(?:=+|-+)\s*$/gmu, "")
    .trim();
  if (body.length === 0 || meaningful.length === 0 || !HAN.test(meaningful)) {
    fail("expert instructions must contain substantive Chinese body text beyond headings and comments");
  }
  return { metadata, body };
}

export function normalizeExpertFile(value: NormalizeInput): Expert {
  const input = snapshotObject(value, "normalize input", NORMALIZE_KEYS);
  for (const key of ["division", "relativePath", "markdown", "source", "taxonomy"] as const) {
    if (!Object.hasOwn(input, key)) fail(`normalize input.${key} is required`);
  }
  const division = requiredString(input, "division", "normalize input", MAX_SLUG);
  if (!PORTABLE_SLUG.test(division)) fail("division must be a portable slug");
  const relativePath = requiredString(input, "relativePath", "normalize input", 1_024);
  const components = validatePath(relativePath, "relativePath");
  if (components.length < 2 || components[0] !== division) fail("relativePath division must match division");
  const markdown = canonicalizeMarkdown(input.markdown);
  const sourceObject = snapshotObject(input.source, "source", ["repository", "path", "commit", "license"]);
  if (sourceObject.path !== relativePath) fail("source.path must exactly match relativePath");
  const source = Object.freeze({
    ...sourceReferenceBase({ repository: sourceObject.repository, commit: sourceObject.commit, license: sourceObject.license }, "source"),
    path: relativePath,
  });
  if (source.repository !== EXPECTED_SOURCES["agency-agents-zh"]) {
    fail("source must identify the reviewed Chinese repository");
  }
  let upstreamSource: SourceRef | undefined;
  if (Object.hasOwn(input, "upstreamSource")) {
    const upstreamObject = snapshotObject(input.upstreamSource, "upstreamSource", ["repository", "path", "commit", "license"]);
    if (typeof upstreamObject.path !== "string") fail("upstreamSource.path must be a string");
    validatePath(upstreamObject.path, "upstreamSource.path");
    upstreamSource = Object.freeze({
      ...sourceReferenceBase({ repository: upstreamObject.repository, commit: upstreamObject.commit, license: upstreamObject.license }, "upstreamSource"),
      path: upstreamObject.path,
    });
    if (upstreamSource.repository !== EXPECTED_SOURCES["agency-agents"]) {
      fail("upstreamSource must identify the reviewed English repository");
    }
  }
  const taxonomy = snapshotTaxonomyMeta(input.taxonomy, "taxonomy");
  if (taxonomy.origin === "upstream_translation") {
    if (!upstreamSource) fail("translated expert requires an attested upstreamSource");
    if (upstreamSource.path !== taxonomy.upstreamPath) fail("upstreamSource.path must match taxonomy.upstreamPath");
  } else if (upstreamSource) {
    fail("China-original expert cannot include upstreamSource");
  }
  const { metadata, body } = splitFrontmatter(markdown);
  const nameZh = requiredString(metadata, "name", "frontmatter", 128);
  const summaryZh = requiredString(metadata, "description", "frontmatter", 2_048);
  if (!HAN.test(nameZh) || !HAN.test(summaryZh)) fail("frontmatter name and description must contain Chinese Han text");
  const filename = components.at(-1)!;
  const slug = filename.slice(0, -3);
  if (!PORTABLE_SLUG.test(slug)) fail("expert filename must be a lowercase portable slug");
  const contentHash = `sha256:${createHash("sha256").update(Buffer.from(markdown, "utf8")).digest("hex")}`;
  return parseExpert({
    id: `ezagent.${division}.${slug}`,
    nameZh,
    summaryZh,
    instructionsZh: body,
    capabilities: taxonomy.capabilities,
    domains: taxonomy.domains,
    projectSignals: taxonomy.projectSignals,
    activationConditions: taxonomy.activationConditions,
    exclusionConditions: taxonomy.exclusionConditions,
    preferredTasks: taxonomy.preferredTasks,
    qualityGates: taxonomy.qualityGates,
    origin: taxonomy.origin,
    source,
    ...(upstreamSource ? { upstreamSource } : {}),
    contentHash,
  });
}

export function parseTaxonomyYaml(text: string): Taxonomy {
  const root = snapshotObject(parseOneYamlDocument(text, "taxonomy"), "taxonomy", TAXONOMY_KEYS);
  if (root.schemaVersion !== 1) fail("taxonomy.schemaVersion must be exactly 1");
  const divisionsObject = snapshotDictionary(root.divisions, "taxonomy.divisions", MAX_DIVISIONS);
  const divisionKeys = Reflect.ownKeys(divisionsObject) as string[];
  if (divisionKeys.length === 0 || divisionKeys.length > MAX_DIVISIONS) fail("taxonomy.divisions count is invalid");
  const divisions: Record<string, { readonly defaultDomains: readonly string[] }> = Object.create(null) as Record<string, { readonly defaultDomains: readonly string[] }>;
  for (const division of divisionKeys.sort(comparePortable)) {
    if (!PORTABLE_SLUG.test(division)) fail(`taxonomy.divisions.${division} is not portable`);
    const object = snapshotObject(divisionsObject[division], `taxonomy.divisions.${division}`, DIVISION_KEYS);
    if (!Object.hasOwn(object, "defaultDomains")) fail(`taxonomy.divisions.${division}.defaultDomains is required`);
    divisions[division] = Object.freeze({
      defaultDomains: stringList(object.defaultDomains, `taxonomy.divisions.${division}.defaultDomains`, MAX_LISTS.defaultDomains, { minimum: 1, slug: true }),
    });
  }
  const expertsObject = snapshotDictionary(root.experts, "taxonomy.experts", MAX_TAXONOMY_EXPERTS);
  const expertKeys = Reflect.ownKeys(expertsObject) as string[];
  if (expertKeys.length === 0 || expertKeys.length > MAX_TAXONOMY_EXPERTS) fail("taxonomy.experts count is invalid");
  const experts: Record<string, TaxonomyMeta> = Object.create(null) as Record<string, TaxonomyMeta>;
  const pathCollisions = new Set<string>();
  for (const path of expertKeys.sort(comparePortable)) {
    validatePath(path, `taxonomy.experts.${path}`);
    const key = collisionKey(path);
    if (pathCollisions.has(key)) fail("taxonomy expert paths contain a canonical collision");
    pathCollisions.add(key);
    experts[path] = snapshotTaxonomyMeta(expertsObject[path], `taxonomy.experts.${path}`);
  }
  const ignoredObject = snapshotObject(
    root.ignoredMarkdown,
    "taxonomy.ignoredMarkdown",
    Object.keys(EXPECTED_SOURCES),
  );
  const ignoredMarkdown = Object.create(null) as Record<keyof typeof EXPECTED_SOURCES, readonly string[]>;
  for (const sourceId of Object.keys(EXPECTED_SOURCES) as Array<keyof typeof EXPECTED_SOURCES>) {
    if (!Object.hasOwn(ignoredObject, sourceId)) fail(`taxonomy.ignoredMarkdown.${sourceId} is required`);
    const values = snapshotArray(ignoredObject[sourceId], `taxonomy.ignoredMarkdown.${sourceId}`, MAX_FILES);
    const seen = new Set<string>();
    ignoredMarkdown[sourceId] = Object.freeze(values.map((value, index) => {
      if (typeof value !== "string") fail(`taxonomy.ignoredMarkdown.${sourceId}.${index} must be a string`);
      validatePath(value, `taxonomy.ignoredMarkdown.${sourceId}.${index}`, true);
      const key = collisionKey(value);
      if (seen.has(key)) fail(`taxonomy.ignoredMarkdown.${sourceId} contains duplicate paths`);
      seen.add(key);
      return value;
    }).sort(comparePortable));
  }
  return Object.freeze({
    schemaVersion: 1,
    divisions: Object.freeze(divisions),
    experts: Object.freeze(experts),
    ignoredMarkdown: Object.freeze(ignoredMarkdown),
  });
}

export function parseSourceLockJson(text: string): ParsedSourceLock {
  if (typeof text !== "string" || Buffer.byteLength(text, "utf8") > MAX_CONFIG_BYTES) fail("source lock JSON is too large");
  try {
    JSON.parse(text);
  } catch (error: unknown) {
    fail("source lock must be strict JSON", error);
  }
  const root = snapshotObject(parseOneYamlDocument(text, "source lock"), "source lock", LOCK_KEYS);
  if (root.schemaVersion !== 2) fail("source lock schemaVersion must be exactly 2 with byte attestations");
  const sourcesValue = root.sources;
  if (Array.isArray(sourcesValue) && sourcesValue.length !== 2) fail("source lock must contain exactly the two reviewed sources");
  const sources = snapshotArray(sourcesValue, "source lock.sources", 2);
  if (sources.length !== 2) fail("source lock must contain exactly the two reviewed sources");
  const found = new Map<string, SourceBase>();
  for (const [index, value] of sources.entries()) {
    const object = snapshotObject(value, `source lock.sources.${index}`, LOCKED_SOURCE_KEYS);
    const id = requiredString(object, "id", `source lock.sources.${index}`, 64);
    if (!Object.hasOwn(EXPECTED_SOURCES, id)) fail("source lock must contain exactly the two reviewed source ids");
    if (found.has(id)) fail("source lock source ids must be unique");
    const parsed = lockedSourceBase({
      repository: object.repository,
      commit: object.commit,
      license: object.license,
      tree: object.tree,
      objectFormat: object.objectFormat,
      markdown: object.markdown,
    }, `source lock.sources.${index}`);
    if (parsed.repository !== EXPECTED_SOURCES[id as keyof typeof EXPECTED_SOURCES]) fail(`source lock repository does not match ${id}`);
    found.set(id, parsed);
  }
  for (const id of Object.keys(EXPECTED_SOURCES)) if (!found.has(id)) fail("source lock must contain exactly the two reviewed sources");
  const sourcesById = Object.freeze({
    "agency-agents": found.get("agency-agents")!,
    "agency-agents-zh": found.get("agency-agents-zh")!,
  });
  return Object.freeze({ schemaVersion: 2, sourcesById });
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

function sameDirectory(left: Stats, right: Stats): boolean {
  return left.isDirectory()
    && right.isDirectory()
    && left.dev === right.dev
    && left.ino === right.ino
    && left.mtimeMs === right.mtimeMs
    && left.ctimeMs === right.ctimeMs;
}

function safeJoinedPath(root: string, relativePath: string): string {
  const path = resolve(root, ...relativePath.split("/"));
  const delta = relative(root, path);
  if (delta === "" || delta === ".." || delta.startsWith(`..${sep}`) || isAbsolute(delta)) fail("indexed path escaped its source root");
  return path;
}

async function readMarkdownHandleBound(
  path: string,
  relativePath: string,
  expected: MarkdownManifestEntry,
  runtime: MarkdownIndexRuntime,
  expectedCanonicalPath: string,
): Promise<string> {
  const before = await runtime.lstat(path);
  if (before.isSymbolicLink()) fail(`source file ${relativePath} is a symlink`);
  if (!before.isFile()) fail(`source entry ${relativePath} is not a regular file`);
  if (before.size < 1 || before.size > MAX_MARKDOWN_BYTES) fail(`source file ${relativePath} is empty or too large`);
  if (await realpath(path) !== expectedCanonicalPath) fail(`source file ${relativePath} escaped its canonical root`);
  let handle: MarkdownReadHandle | undefined;
  try {
    handle = await runtime.openNoFollow(path);
    const opened = await handle.stat();
    if (!sameFile(before, opened)) fail(`source file ${relativePath} changed before read`);
    const bytes = await handle.readBytes();
    if (bytes.length !== opened.size || bytes.length > MAX_MARKDOWN_BYTES) fail(`source file ${relativePath} changed during read`);
    const afterHandle = await handle.stat();
    const afterPath = await runtime.lstat(path);
    if (!sameFile(opened, afterHandle) || !sameFile(opened, afterPath)
      || await realpath(path) !== expectedCanonicalPath) fail(`source file ${relativePath} changed during read`);
    if (bytes.length !== expected.size) fail(`source file ${relativePath} does not match locked size`);
    const sha256 = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
    if (sha256 !== expected.sha256) fail(`source file ${relativePath} does not match locked bytes`);
    const oid = createHash("sha1")
      .update(Buffer.from(`blob ${bytes.length}\0`, "utf8"))
      .update(bytes)
      .digest("hex");
    if (oid !== expected.oid) fail(`source file ${relativePath} does not match locked object id`);
    let text: string;
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch (error: unknown) {
      fail(`source file ${relativePath} is not valid UTF-8`, error);
    }
    if (text.trim().length === 0) fail(`source file ${relativePath} is empty Markdown`);
    await handle.close();
    handle = undefined;
    return text;
  } catch (error: unknown) {
    if (error instanceof CatalogImportError) throw error;
    fail(`source file ${relativePath} could not be read safely`, error);
  } finally {
    if (handle) {
      try { await handle.close(); } catch { /* preserve primary failure */ }
    }
  }
  throw new Error("unreachable safe Markdown read");
}

export async function indexMarkdownFiles(
  rootInput: string,
  sourceInput: SourceBase,
  runtime: MarkdownIndexRuntime = nodeMarkdownIndexRuntime,
  projectRootInput: string = rootInput,
): Promise<ReadonlyMap<string, IndexedMarkdownFile>> {
  if (typeof rootInput !== "string" || !isAbsolute(rootInput) || rootInput !== resolve(rootInput)) fail("source root must be an absolute normalized path");
  if (typeof projectRootInput !== "string" || !isAbsolute(projectRootInput) || projectRootInput !== resolve(projectRootInput)) {
    fail("project root must be an absolute normalized path");
  }
  const [canonicalProjectRoot, canonicalSourceRoot] = await Promise.all([
    realpath(projectRootInput),
    realpath(rootInput),
  ]).catch((error: unknown) => fail("source or project root is unreadable", error));
  const sourceDelta = relative(canonicalProjectRoot, canonicalSourceRoot);
  if (sourceDelta === ".." || sourceDelta.startsWith(`..${sep}`) || isAbsolute(sourceDelta)) {
    fail("source root must stay inside the canonical project root");
  }
  const inputDelta = relative(resolve(projectRootInput), resolve(rootInput));
  if (inputDelta === ".." || inputDelta.startsWith(`..${sep}`) || isAbsolute(inputDelta)) {
    fail("source root input must stay inside the project root");
  }
  let inputBoundary = resolve(projectRootInput);
  for (const component of inputDelta === "" ? [] : inputDelta.split(sep)) {
    inputBoundary = join(inputBoundary, component);
    const observed = await runtime.lstat(inputBoundary);
    if (observed.isSymbolicLink() || !observed.isDirectory()) fail("source root input path contains a symlink or non-directory");
  }
  let boundary = canonicalProjectRoot;
  for (const component of sourceDelta === "" ? [] : sourceDelta.split(sep)) {
    boundary = join(boundary, component);
    const observed = await runtime.lstat(boundary);
    if (observed.isSymbolicLink() || !observed.isDirectory()) fail("source root path contains a symlink or non-directory");
  }
  const source = lockedSourceBase(sourceInput, "indexed source");
  const rootBefore = await runtime.lstat(rootInput).catch((error: unknown) => fail("source root is unreadable", error));
  if (rootBefore.isSymbolicLink()) fail("source root is a symlink");
  if (!rootBefore.isDirectory()) fail("source root is not a directory");
  const indexed = new Map<string, IndexedMarkdownFile>();
  const manifestByPath = new Map(source.markdown.map((entry) => [entry.path, entry]));
  const pathKeys = new Map<string, string>();
  let directories = 0;
  let totalBytes = 0;
  let entriesSeen = 0;
  let filesSeen = 0;
  let treeBytes = 0;

  async function visit(relativeDirectory: string, depth: number): Promise<void> {
    if (depth > MAX_DEPTH) fail("source tree exceeds maximum depth");
    directories += 1;
    if (directories > MAX_DIRECTORIES) fail("source tree contains too many directories");
    const directoryPath = relativeDirectory === "" ? rootInput : safeJoinedPath(rootInput, relativeDirectory);
    const directoryBefore = await runtime.lstat(directoryPath);
    if (directoryBefore.isSymbolicLink() || !directoryBefore.isDirectory()) fail(`source directory ${relativeDirectory || "."} is unsafe`);
    const entries = [...await runtime.readdir(directoryPath)];
    entries.sort((left, right) => comparePortable(left.name, right.name));
    const entryNames = new Set<string>();
    for (const entry of entries) {
      entriesSeen += 1;
      if (entriesSeen > MAX_ENTRIES) fail("source tree contains too many entries");
      if (entry.name === ".git") continue;
      if (entry.name.normalize("NFC") !== entry.name || !isWellFormedUnicode(entry.name)) fail("source entry name is not canonical Unicode");
      const entryKey = collisionKey(entry.name);
      if (entryNames.has(entryKey)) fail("source directory contains a case or Unicode canonical collision");
      entryNames.add(entryKey);
      const relativePath = relativeDirectory === "" ? entry.name : `${relativeDirectory}/${entry.name}`;
      const absolutePath = safeJoinedPath(rootInput, relativePath);
      const stat = await runtime.lstat(absolutePath);
      if (stat.isSymbolicLink()) fail(`source entry ${relativePath} is a symlink`);
      if (stat.isDirectory()) {
        await visit(relativePath, depth + 1);
        continue;
      }
      if (!stat.isFile()) fail(`source entry ${relativePath} is not a regular file`);
      filesSeen += 1;
      treeBytes += stat.size;
      if (filesSeen > MAX_ENTRIES || treeBytes > MAX_TOTAL_BYTES * 2) fail("source tree exceeds bounded file inventory");
      if (/\.md$/iu.test(entry.name) && !entry.name.endsWith(".md")) fail(`source path uses a non-canonical Markdown extension: ${relativePath}`);
      if (!entry.name.endsWith(".md")) continue;
      validatePath(relativePath, `source path ${relativePath}`, true);
      const pathKey = collisionKey(relativePath);
      const collision = pathKeys.get(pathKey);
      if (collision) fail(`source paths ${collision} and ${relativePath} collide canonically`);
      pathKeys.set(pathKey, relativePath);
      if (indexed.size >= MAX_FILES) fail("source tree contains too many Markdown files");
      const expected = manifestByPath.get(relativePath);
      if (!expected) fail(`source Markdown path is not attested: ${relativePath}`);
      const canonicalFile = resolve(canonicalSourceRoot, ...relativePath.split("/"));
      const markdown = await readMarkdownHandleBound(absolutePath, relativePath, expected, runtime, canonicalFile);
      totalBytes += Buffer.byteLength(markdown, "utf8");
      if (totalBytes > MAX_TOTAL_BYTES) fail("source tree exceeds total Markdown byte limit");
      indexed.set(relativePath, Object.freeze({
        division: relativePath.split("/", 1)[0]!,
        relativePath,
        markdown,
        source: Object.freeze({
          repository: source.repository,
          commit: source.commit,
          license: source.license,
          path: relativePath,
        }),
      }));
    }
    const directoryAfter = await runtime.lstat(directoryPath);
    if (!sameDirectory(directoryBefore, directoryAfter)) fail(`source directory changed during indexing: ${relativeDirectory || "."}`);
  }

  await visit("", 0);
  const rootAfter = await runtime.lstat(rootInput);
  if (!sameDirectory(rootBefore, rootAfter)) fail("source root changed during indexing");
  for (const entry of source.markdown) {
    if (!indexed.has(entry.path)) fail(`locked Markdown path is missing: ${entry.path}`);
  }
  return new Map([...indexed.entries()].sort(([left], [right]) => comparePortable(left, right)));
}

export async function importExpertCatalog(options: ImportExpertCatalogOptions): Promise<readonly Expert[]> {
  const lock = parseSourceLockJson(options.sourceLockText);
  const taxonomy = parseTaxonomyYaml(options.taxonomyText);
  const english = await indexMarkdownFiles(options.englishRoot, lock.sourcesById["agency-agents"], nodeMarkdownIndexRuntime, options.projectRoot);
  const chinese = await indexMarkdownFiles(options.chineseRoot, lock.sourcesById["agency-agents-zh"], nodeMarkdownIndexRuntime, options.projectRoot);
  const chineseIgnored = new Set(taxonomy.ignoredMarkdown["agency-agents-zh"]);
  const englishIgnored = new Set(taxonomy.ignoredMarkdown["agency-agents"]);
  const upstreamOwners = new Map<string, string>();
  for (const [path, metadata] of Object.entries(taxonomy.experts)) {
    if (chineseIgnored.has(path)) fail(`Chinese Markdown path is classified as both expert and ignored: ${path}`);
    if (metadata.origin === "upstream_translation") {
      if (englishIgnored.has(metadata.upstreamPath!)) fail(`English Markdown path is classified as both upstream and ignored: ${metadata.upstreamPath}`);
      const owner = upstreamOwners.get(metadata.upstreamPath!);
      if (owner) fail(`English upstream path is mapped by both ${owner} and ${path}`);
      upstreamOwners.set(metadata.upstreamPath!, path);
    }
  }
  const missingDivisions = new Set<string>();
  const missingExpertPaths: string[] = [];
  for (const [path] of Object.entries(taxonomy.experts)) {
    const division = path.split("/", 1)[0]!;
    if (!Object.hasOwn(taxonomy.divisions, division)) missingDivisions.add(division);
    if (!chinese.has(path)) missingExpertPaths.push(path);
  }
  const extraExpertPaths = Object.keys(taxonomy.experts).filter((path) => !chinese.has(path));
  const unclassifiedMarkdownPaths = [
    ...[...chinese.keys()]
      .filter((path) => !Object.hasOwn(taxonomy.experts, path) && !chineseIgnored.has(path))
      .map((path) => `agency-agents-zh:${path}`),
    ...[...english.keys()]
      .filter((path) => !upstreamOwners.has(path) && !englishIgnored.has(path))
      .map((path) => `agency-agents:${path}`),
  ].sort(comparePortable);
  const missingUpstreamPaths = [...upstreamOwners.keys()].filter((path) => !english.has(path)).sort(comparePortable);
  const extraIgnoredPaths = [
    ...[...chineseIgnored].filter((path) => !chinese.has(path)).map((path) => `agency-agents-zh:${path}`),
    ...[...englishIgnored].filter((path) => !english.has(path)).map((path) => `agency-agents:${path}`),
  ].sort(comparePortable);
  const sortedMissingDivisions = [...missingDivisions].sort(comparePortable);
  missingExpertPaths.sort(comparePortable);
  extraExpertPaths.sort(comparePortable);
  if (sortedMissingDivisions.length || missingExpertPaths.length || extraExpertPaths.length
    || unclassifiedMarkdownPaths.length || missingUpstreamPaths.length || extraIgnoredPaths.length) {
    throw new CatalogImportError(
      [
        `missing divisions: ${sortedMissingDivisions.join(", ") || "none"}`,
        `missing expert paths: ${missingExpertPaths.join(", ") || "none"}`,
        `extra taxonomy paths: ${extraExpertPaths.join(", ") || "none"}`,
        `unclassified Markdown paths: ${unclassifiedMarkdownPaths.join(", ") || "none"}`,
        `missing upstream paths: ${missingUpstreamPaths.join(", ") || "none"}`,
        `missing ignored paths: ${extraIgnoredPaths.join(", ") || "none"}`,
      ].join("; "),
      Object.freeze(sortedMissingDivisions),
      Object.freeze(missingExpertPaths),
      Object.freeze(extraExpertPaths),
      Object.freeze(unclassifiedMarkdownPaths),
      Object.freeze(missingUpstreamPaths),
      Object.freeze(extraIgnoredPaths),
    );
  }
  const experts = Object.keys(taxonomy.experts).sort(comparePortable).map((path) => {
    const file = chinese.get(path)!;
    const metadata = taxonomy.experts[path]!;
    return normalizeExpertFile({
      ...file,
      taxonomy: metadata,
      ...(metadata.origin === "upstream_translation"
        ? { upstreamSource: english.get(metadata.upstreamPath!)!.source }
        : {}),
    });
  });
  serializeNormalizedCatalog(experts);
  return Object.freeze(experts.sort((left, right) => comparePortable(left.id, right.id)));
}

export function serializeNormalizedCatalog(expertsInput: readonly Expert[]): string {
  const experts = snapshotArray(expertsInput, "normalized experts", MAX_FILES).map((expert) => parseExpert(expert));
  const ids = new Set<string>();
  for (const expert of experts) {
    const key = collisionKey(expert.id);
    if (ids.has(key)) fail(`duplicate expert id ${expert.id}`);
    ids.add(key);
  }
  experts.sort((left, right) => comparePortable(left.id, right.id));
  return `${JSON.stringify({ schemaVersion: 1, experts }, null, 2)}\n`;
}

export async function writeNormalizedCatalog(
  target: string,
  experts: readonly Expert[],
  runtime: NormalizedCatalogWriteRuntime,
): Promise<void> {
  const content = serializeNormalizedCatalog(experts);
  const parent = dirname(target);
  const projectRoot = runtime.projectRoot;
  if (!isAbsolute(projectRoot) || projectRoot !== resolve(projectRoot) || !isAbsolute(target) || target !== resolve(target)) {
    fail("normalized catalog project root and target must be absolute normalized paths");
  }
  const delta = relative(projectRoot, target);
  if (delta === "" || delta === ".." || delta.startsWith(`..${sep}`) || isAbsolute(delta)) {
    fail("normalized catalog target must stay inside the project root");
  }
  const rootStat = await lstat(projectRoot);
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) fail("normalized catalog project root must be a real directory");
  const directoryComponents = delta.split(sep).slice(0, -1);
  let current = projectRoot;
  for (const component of directoryComponents) {
    current = join(current, component);
    try {
      const stat = await lstat(current);
      if (stat.isSymbolicLink()) fail("normalized catalog directory chain contains a symlink");
      if (!stat.isDirectory()) fail("normalized catalog directory chain contains a non-directory");
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      await mkdir(current);
      const created = await lstat(current);
      if (created.isSymbolicLink() || !created.isDirectory()) fail("normalized catalog directory creation was replaced");
    }
  }
  const parentStat = await lstat(parent);
  if (parentStat.isSymbolicLink() || !parentStat.isDirectory()) fail("normalized catalog parent must be a real directory");
  const [canonicalParentBefore, canonicalProjectBefore] = await Promise.all([
    realpath(parent),
    realpath(runtime.projectRoot),
  ]);
  const parentDelta = relative(canonicalProjectBefore, canonicalParentBefore);
  if (parentDelta === ".." || parentDelta.startsWith(`..${sep}`) || isAbsolute(parentDelta)) {
    fail("normalized catalog parent escaped the canonical project root");
  }
  try {
    const targetStat = await lstat(target);
    if (targetStat.isSymbolicLink()) fail("normalized catalog target is a symlink");
    if (!targetStat.isFile()) fail("normalized catalog target is not a regular file");
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  await runtime.beforePublish?.();
  const [parentImmediatelyBefore, canonicalParentImmediatelyBefore] = await Promise.all([
    lstat(parent),
    realpath(parent),
  ]);
  if (!sameDirectory(parentStat, parentImmediatelyBefore)
    || canonicalParentImmediatelyBefore !== canonicalParentBefore) {
    fail("normalized catalog parent changed before publication");
  }
  await runtime.atomicWriteText(target, content);
  const [parentAfter, canonicalParentAfter] = await Promise.all([lstat(parent), realpath(parent)]);
  if (!sameDirectory(parentStat, parentAfter) || canonicalParentAfter !== canonicalParentBefore) {
    fail("normalized catalog parent changed during publication");
  }
  const targetAfter = await lstat(target);
  if (targetAfter.isSymbolicLink() || !targetAfter.isFile()) fail("normalized catalog publication is not a regular file");
}

export async function readBoundedTextFile(path: string, maximumBytes = MAX_CONFIG_BYTES): Promise<string> {
  const before = await lstat(path);
  if (before.isSymbolicLink() || !before.isFile() || before.size < 1 || before.size > maximumBytes) fail("release input must be a bounded regular file");
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    const noFollow = process.platform === "win32" || typeof fsConstants.O_NOFOLLOW !== "number"
      ? 0
      : fsConstants.O_NOFOLLOW;
    handle = await open(path, fsConstants.O_RDONLY | noFollow);
    const opened = await handle.stat();
    if (!sameFile(before, opened)) fail("release input changed before read");
    const bytes = await handle.readFile();
    const after = await handle.stat();
    const pathAfter = await lstat(path);
    if (bytes.length !== opened.size || !sameFile(opened, after) || !sameFile(opened, pathAfter)) fail("release input changed during read");
    let text: string;
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch (error: unknown) {
      fail("release input is not valid UTF-8", error);
    }
    await handle.close();
    handle = undefined;
    return text;
  } finally {
    if (handle) {
      try { await handle.close(); } catch { /* preserve primary failure */ }
    }
  }
}
