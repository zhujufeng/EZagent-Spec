import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open } from "node:fs/promises";
import { isAbsolute } from "node:path";

import { unicodeDefaultCaseFold } from "../text/unicode-case-fold.js";
import { readBoundedFileHandle } from "./bounded-read.js";
import { parseExpert, type Expert } from "./expert.js";

export const RUNTIME_CATALOG_MAX_BYTES = 16 * 1024 * 1024;

export interface RuntimeCatalog {
  readonly experts: readonly Expert[];
  readonly byId: ReadonlyMap<string, Expert>;
  readonly capabilities: ReadonlySet<string>;
  readonly domains: ReadonlySet<string>;
  readonly projectSignals: ReadonlySet<string>;
  readonly fingerprint: `sha256:${string}`;
}

function fail(message: string, cause?: unknown): never {
  throw new TypeError(
    `Invalid runtime expert catalog: ${message}`,
    cause === undefined ? undefined : { cause },
  );
}

function portableCompare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function freezeExpert(expert: Expert): Expert {
  const source = Object.freeze({ ...expert.source });
  const upstreamSource = "upstreamSource" in expert
    ? Object.freeze({ ...expert.upstreamSource })
    : undefined;
  return Object.freeze({
    ...expert,
    capabilities: Object.freeze([...expert.capabilities]),
    domains: Object.freeze([...expert.domains]),
    projectSignals: Object.freeze([...expert.projectSignals]),
    activationConditions: Object.freeze([...expert.activationConditions]),
    exclusionConditions: Object.freeze([...expert.exclusionConditions]),
    preferredTasks: Object.freeze([...expert.preferredTasks]),
    qualityGates: Object.freeze([...expert.qualityGates]),
    source,
    ...(upstreamSource === undefined ? {} : { upstreamSource }),
  }) as Expert;
}

export async function loadRuntimeCatalogBytes(path: string): Promise<Buffer> {
  if (typeof path !== "string" || path.includes("\0") || !isAbsolute(path)) {
    fail("path must be an absolute local file path");
  }

  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    const observed = await lstat(path);
    if (!observed.isFile() || observed.isSymbolicLink()) fail("path must be a regular non-symlink file");
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    return await readBoundedFileHandle(handle, observed, RUNTIME_CATALOG_MAX_BYTES);
  } catch (error: unknown) {
    if (error instanceof TypeError && error.message.startsWith("Invalid runtime expert catalog:")) {
      throw error;
    }
    fail("local catalog could not be read safely", error);
  } finally {
    await handle?.close();
  }
  fail("local catalog read ended unexpectedly");
}

export function parseRuntimeCatalog(bytes: Uint8Array): RuntimeCatalog {
  if (!(bytes instanceof Uint8Array)
    || bytes.byteLength === 0
    || bytes.byteLength > RUNTIME_CATALOG_MAX_BYTES) {
    fail(`catalog must contain 1-${RUNTIME_CATALOG_MAX_BYTES} bytes`);
  }

  const reviewedBytes = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (reviewedBytes[0] === 0xef && reviewedBytes[1] === 0xbb && reviewedBytes[2] === 0xbf) {
    fail("UTF-8 BOM is not allowed");
  }

  let parsed: unknown;
  try {
    const source = new TextDecoder("utf-8", { fatal: true }).decode(reviewedBytes);
    if (source.includes("\0")) fail("NUL is not allowed");
    parsed = JSON.parse(source) as unknown;
  } catch (error: unknown) {
    if (error instanceof TypeError && error.message.startsWith("Invalid runtime expert catalog:")) {
      throw error;
    }
    fail("catalog must be one valid UTF-8 JSON document", error);
  }

  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    fail("top level must be an object");
  }
  const record = parsed as Record<string, unknown>;
  const keys = Object.keys(record).sort(portableCompare);
  if (keys.length !== 2 || keys[0] !== "experts" || keys[1] !== "schemaVersion") {
    fail("top level must contain exactly schemaVersion and experts");
  }
  if (record.schemaVersion !== 1 || !Array.isArray(record.experts) || record.experts.length === 0) {
    fail("schemaVersion must be 1 and experts must be a non-empty array");
  }
  for (let index = 0; index < record.experts.length; index += 1) {
    if (!Object.hasOwn(record.experts, index)) fail(`experts must be dense at index ${index}`);
  }

  const seen = new Set<string>();
  const experts = record.experts.map((value, index) => {
    let expert: Expert;
    try {
      expert = parseExpert(value);
    } catch (error: unknown) {
      fail(`experts.${index} is invalid`, error);
    }
    const key = unicodeDefaultCaseFold(expert.id.normalize("NFKC")).normalize("NFKC");
    if (seen.has(key)) fail(`duplicate expert id: ${expert.id}`);
    seen.add(key);
    return freezeExpert(expert);
  }).sort((left, right) => portableCompare(left.id, right.id));

  const byId = new Map(experts.map((expert) => [expert.id, expert] as const));
  const capabilities = new Set(experts.flatMap((expert) => expert.capabilities));
  const domains = new Set(experts.flatMap((expert) => expert.domains));
  const projectSignals = new Set(experts.flatMap((expert) => expert.projectSignals));
  const sortedSet = (values: Set<string>): ReadonlySet<string> => Object.freeze(
    new Set([...values].sort(portableCompare)),
  );

  return Object.freeze({
    experts: Object.freeze(experts),
    byId: Object.freeze(byId),
    capabilities: sortedSet(capabilities),
    domains: sortedSet(domains),
    projectSignals: sortedSet(projectSignals),
    fingerprint: `sha256:${createHash("sha256").update(reviewedBytes).digest("hex")}`,
  });
}
