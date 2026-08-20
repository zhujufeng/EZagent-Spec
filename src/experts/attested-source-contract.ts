import { createHash } from "node:crypto";
import { types as nodeTypes } from "node:util";

import { unicodeDefaultCaseFold } from "../text/unicode-case-fold.js";
import { isWellFormedUnicode } from "../text/unicode.js";

export const ATTESTED_SOURCE_LOCK_SCHEMA_VERSION = 2 as const;
export const MAX_ATTESTED_MARKDOWN_BYTES = 1_048_576;
export const MAX_ATTESTED_CHECKOUT_MARKDOWN_BYTES = 2 * MAX_ATTESTED_MARKDOWN_BYTES;
export const MAX_ATTESTED_MARKDOWN_FILES = 4_096;
export const MAX_ATTESTED_TOTAL_BYTES = 64 * 1_048_576;
export const MAX_ATTESTED_SOURCE_LOCK_BYTES = 2 * 1_048_576;
export const MAX_ATTESTED_PATH_BYTES = 1_024;

export const REVIEWED_CATALOG_SOURCES = Object.freeze({
  "agency-agents": "https://github.com/msitarzewski/agency-agents",
  "agency-agents-zh": "https://github.com/jnMetaCode/agency-agents-zh",
} as const);

const MANIFEST_KEYS = [
  "path",
  "oid",
  "size",
  "sha256",
  "normalizedSize",
  "normalizedSha256",
] as const;
const SOURCE_KEYS = ["id", "repository", "license", "commit", "tree", "objectFormat", "markdown"] as const;
const SOURCE_BASE_KEYS = ["repository", "license", "commit", "tree", "objectFormat", "markdown"] as const;
const LOCK_KEYS = ["schemaVersion", "sources"] as const;
const FULL_SHA1 = /^[0-9a-f]{40}$/u;
const SHA256 = /^sha256:[0-9a-f]{64}$/u;
const PORTABLE_COMPONENT = /^[\p{L}\p{N}._-]+$/u;
const WINDOWS_RESERVED = /^(?:CON|PRN|AUX|NUL|CLOCK\$|CONIN\$|CONOUT\$|COM[1-9]|LPT[1-9])$/u;

export type ReviewedCatalogSourceId = keyof typeof REVIEWED_CATALOG_SOURCES;

export interface AttestedMarkdownEntry {
  readonly path: string;
  readonly oid: string;
  readonly size: number;
  readonly sha256: string;
  readonly normalizedSize: number;
  readonly normalizedSha256: string;
}

export interface AttestedCatalogSource {
  readonly id: ReviewedCatalogSourceId;
  readonly repository: (typeof REVIEWED_CATALOG_SOURCES)[ReviewedCatalogSourceId];
  readonly license: "MIT";
  readonly commit: string;
  readonly tree: string;
  readonly objectFormat: "sha1";
  readonly markdown: readonly AttestedMarkdownEntry[];
}

export interface AttestedSourceBase {
  readonly repository: (typeof REVIEWED_CATALOG_SOURCES)[ReviewedCatalogSourceId];
  readonly license: "MIT";
  readonly commit: string;
  readonly tree: string;
  readonly objectFormat: "sha1";
  readonly markdown: readonly AttestedMarkdownEntry[];
}

export interface AttestedSourceLockV2 {
  readonly schemaVersion: typeof ATTESTED_SOURCE_LOCK_SCHEMA_VERSION;
  readonly sources: readonly AttestedCatalogSource[];
}

export interface CanonicalMarkdown {
  readonly text: string;
  readonly bytes: Buffer;
  readonly size: number;
  readonly sha256: string;
}

export class AttestedSourceContractError extends Error {
  override readonly name = "AttestedSourceContractError";
}

function contractFail(message: string, cause?: unknown): never {
  throw new AttestedSourceContractError(`Invalid attested source contract: ${message}`, { cause });
}

function ownDataObject(value: unknown, path: string, allowed: readonly string[]): Record<string, unknown> {
  if (value === null || typeof value !== "object" || nodeTypes.isProxy(value) || Array.isArray(value)) {
    contractFail(`${path} must be an ordinary object`);
  }
  const prototype = Object.getPrototypeOf(value) as unknown;
  if (prototype !== Object.prototype && prototype !== null) contractFail(`${path} must have a plain prototype`);
  const result: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string" || !allowed.includes(key)) contractFail(`${path} contains an unsupported key`);
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor?.enumerable || !("value" in descriptor)) contractFail(`${path}.${key} must be enumerable data`);
    result[key] = descriptor.value;
  }
  return result;
}

function denseArray(value: unknown, path: string, maximum: number): readonly unknown[] {
  if (nodeTypes.isProxy(value) || !Array.isArray(value)) contractFail(`${path} must be an array`);
  if (value.length > maximum) contractFail(`${path} exceeds the manifest entry budget`);
  for (const key of Reflect.ownKeys(value)) {
    if (key === "length") continue;
    if (typeof key !== "string" || !/^(?:0|[1-9]\d*)$/u.test(key) || Number(key) >= value.length) {
      contractFail(`${path} contains an unsupported array key`);
    }
  }
  const result: unknown[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!descriptor?.enumerable || !("value" in descriptor)) contractFail(`${path} must be dense data`);
    result.push(descriptor.value);
  }
  return result;
}

export function attestedPathCollisionKey(path: string): string {
  return unicodeDefaultCaseFold(path);
}

export function validateAttestedMarkdownPath(value: unknown, path = "manifest.path"): string {
  if (typeof value !== "string"
    || value.length === 0
    || Buffer.byteLength(value, "utf8") > MAX_ATTESTED_PATH_BYTES
    || !isWellFormedUnicode(value)
    || value.normalize("NFC") !== value
    || value.startsWith("/")
    || value.includes("\\")
    || value.includes("%")
    || value.includes(":")
    || /[\u0000-\u001f\u007f]/u.test(value)
    || !value.endsWith(".md")) {
    contractFail(`${path} is not portable NFC Markdown`);
  }
  for (const component of value.split("/")) {
    const compatibility = component.normalize("NFKC");
    const basename = compatibility.split(".", 1)[0]!.toUpperCase();
    if (component === "" || component === "." || component === ".."
      || !PORTABLE_COMPONENT.test(component)
      || compatibility.endsWith(".") || compatibility.endsWith(" ")
      || WINDOWS_RESERVED.test(basename)
      || Buffer.byteLength(component, "utf8") > 255) {
      contractFail(`${path} contains an unsafe component`);
    }
  }
  return value;
}

export function canonicalizeAttestedMarkdownBytes(
  raw: Uint8Array,
  maximumInputBytes = MAX_ATTESTED_MARKDOWN_BYTES,
): CanonicalMarkdown {
  if (!(raw instanceof Uint8Array) || raw.byteLength < 1 || raw.byteLength > maximumInputBytes) {
    contractFail("Markdown blob is empty or too large");
  }
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(raw);
  } catch (error: unknown) {
    contractFail("Markdown blob is not strict UTF-8", error);
  }
  if (text.startsWith("\uFEFF")) text = text.slice(1);
  if (text.includes("\uFEFF")) contractFail("Markdown blob contains an unsupported BOM");
  text = text.replace(/\r\n/gu, "\n");
  if (text.includes("\r")) contractFail("Markdown blob contains a bare carriage return");
  const bytes = Buffer.from(text, "utf8");
  if (bytes.length < 1 || bytes.length > MAX_ATTESTED_MARKDOWN_BYTES) {
    contractFail("normalized Markdown is empty or too large");
  }
  return Object.freeze({
    text,
    bytes,
    size: bytes.length,
    sha256: `sha256:${createHash("sha256").update(bytes).digest("hex")}`,
  });
}

export function createAttestedMarkdownEntry(path: string, oid: string, raw: Uint8Array): AttestedMarkdownEntry {
  const portablePath = validateAttestedMarkdownPath(path);
  const bytes = Buffer.from(raw);
  if (bytes.length < 1 || bytes.length > MAX_ATTESTED_MARKDOWN_BYTES) contractFail("raw Markdown blob is empty or too large");
  if (!FULL_SHA1.test(oid)) contractFail("manifest.oid must be a full lowercase SHA-1");
  const calculatedOid = createHash("sha1")
    .update(Buffer.from(`blob ${bytes.length}\0`, "utf8"))
    .update(bytes)
    .digest("hex");
  if (calculatedOid !== oid) contractFail("manifest.oid does not authenticate the raw Git blob bytes");
  const normalized = canonicalizeAttestedMarkdownBytes(bytes);
  return Object.freeze({
    path: portablePath,
    oid,
    size: bytes.length,
    sha256: `sha256:${createHash("sha256").update(bytes).digest("hex")}`,
    normalizedSize: normalized.size,
    normalizedSha256: normalized.sha256,
  });
}

export function snapshotAttestedManifest(value: unknown, path: string): readonly AttestedMarkdownEntry[] {
  const entries = denseArray(value, path, MAX_ATTESTED_MARKDOWN_FILES);
  const result: AttestedMarkdownEntry[] = [];
  const collisions = new Set<string>();
  let rawTotal = 0;
  let normalizedTotal = 0;
  for (const [index, item] of entries.entries()) {
    const entryPath = `${path}.${index}`;
    const object = ownDataObject(item, entryPath, MANIFEST_KEYS);
    const portablePath = validateAttestedMarkdownPath(object.path, `${entryPath}.path`);
    if (typeof object.oid !== "string" || !FULL_SHA1.test(object.oid)) contractFail(`${entryPath}.oid is invalid`);
    if (!Number.isSafeInteger(object.size) || (object.size as number) < 1 || (object.size as number) > MAX_ATTESTED_MARKDOWN_BYTES) {
      contractFail(`${entryPath}.size is invalid`);
    }
    if (typeof object.sha256 !== "string" || !SHA256.test(object.sha256)) contractFail(`${entryPath}.sha256 is invalid`);
    if (!Number.isSafeInteger(object.normalizedSize)
      || (object.normalizedSize as number) < 1
      || (object.normalizedSize as number) > MAX_ATTESTED_MARKDOWN_BYTES) {
      contractFail(`${entryPath}.normalizedSize is invalid`);
    }
    if (typeof object.normalizedSha256 !== "string" || !SHA256.test(object.normalizedSha256)) {
      contractFail(`${entryPath}.normalizedSha256 is invalid`);
    }
    const collision = attestedPathCollisionKey(portablePath);
    if (collisions.has(collision)) contractFail(`${path} contains a duplicate or Unicode collision`);
    collisions.add(collision);
    rawTotal += object.size as number;
    normalizedTotal += object.normalizedSize as number;
    if (rawTotal > MAX_ATTESTED_TOTAL_BYTES || normalizedTotal > MAX_ATTESTED_TOTAL_BYTES) {
      contractFail(`${path} exceeds the total Markdown byte budget`);
    }
    result.push(Object.freeze({
      path: portablePath,
      oid: object.oid,
      size: object.size as number,
      sha256: object.sha256,
      normalizedSize: object.normalizedSize as number,
      normalizedSha256: object.normalizedSha256,
    }));
  }
  result.sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0);
  return Object.freeze(result);
}

function snapshotAttestedSource(value: unknown, path: string): AttestedCatalogSource {
  const object = ownDataObject(value, path, SOURCE_KEYS);
  if (typeof object.id !== "string" || !Object.hasOwn(REVIEWED_CATALOG_SOURCES, object.id)) {
    contractFail(`${path}.id is not a reviewed catalog source`);
  }
  const id = object.id as ReviewedCatalogSourceId;
  if (object.repository !== REVIEWED_CATALOG_SOURCES[id]) contractFail(`${path}.repository does not match ${id}`);
  if (object.license !== "MIT") contractFail(`${path}.license must be MIT`);
  if (typeof object.commit !== "string" || !FULL_SHA1.test(object.commit)) contractFail(`${path}.commit is invalid`);
  if (typeof object.tree !== "string" || !FULL_SHA1.test(object.tree)) contractFail(`${path}.tree is invalid`);
  if (object.objectFormat !== "sha1") contractFail(`${path}.objectFormat must be sha1`);
  return Object.freeze({
    id,
    repository: REVIEWED_CATALOG_SOURCES[id],
    license: "MIT",
    commit: object.commit,
    tree: object.tree,
    objectFormat: "sha1",
    markdown: snapshotAttestedManifest(object.markdown, `${path}.markdown`),
  });
}

export function snapshotAttestedSourceBase(value: unknown, path = "attested source"): AttestedSourceBase {
  const object = ownDataObject(value, path, SOURCE_BASE_KEYS);
  if (typeof object.repository !== "string"
    || !Object.values(REVIEWED_CATALOG_SOURCES).includes(object.repository as never)) {
    contractFail(`${path}.repository is not reviewed`);
  }
  if (object.license !== "MIT") contractFail(`${path}.license must be MIT`);
  if (typeof object.commit !== "string" || !FULL_SHA1.test(object.commit)) contractFail(`${path}.commit is invalid`);
  if (typeof object.tree !== "string" || !FULL_SHA1.test(object.tree)) contractFail(`${path}.tree is invalid`);
  if (object.objectFormat !== "sha1") contractFail(`${path}.objectFormat must be sha1`);
  return Object.freeze({
    repository: object.repository as AttestedSourceBase["repository"],
    license: "MIT",
    commit: object.commit,
    tree: object.tree,
    objectFormat: "sha1",
    markdown: snapshotAttestedManifest(object.markdown, `${path}.markdown`),
  });
}

export function snapshotReviewedSourceLockV2(value: unknown, path = "source lock"): AttestedSourceLockV2 {
  const object = ownDataObject(value, path, LOCK_KEYS);
  if (object.schemaVersion !== ATTESTED_SOURCE_LOCK_SCHEMA_VERSION) contractFail(`${path}.schemaVersion must be exactly 2`);
  const values = denseArray(object.sources, `${path}.sources`, 2);
  if (values.length !== 2) contractFail(`${path} must contain exactly the two reviewed sources`);
  const sources = values.map((source, index) => snapshotAttestedSource(source, `${path}.sources.${index}`));
  const found = new Set(sources.map((source) => source.id));
  if (found.size !== 2 || !Object.keys(REVIEWED_CATALOG_SOURCES).every((id) => found.has(id as ReviewedCatalogSourceId))) {
    contractFail(`${path} must contain exactly the two reviewed sources`);
  }
  sources.sort((left, right) => left.id < right.id ? -1 : left.id > right.id ? 1 : 0);
  return Object.freeze({ schemaVersion: 2, sources: Object.freeze(sources) });
}

export function assertAttestedSourceLockTextBudget(text: string): void {
  if (typeof text !== "string" || Buffer.byteLength(text, "utf8") > MAX_ATTESTED_SOURCE_LOCK_BYTES) {
    contractFail("source lock exceeds the serialized byte budget");
  }
}
