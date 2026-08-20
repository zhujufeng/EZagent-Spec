import { types as nodeTypes } from "node:util";

import { unicodeDefaultCaseFold } from "../text/unicode-case-fold.js";
import { parseExpert, type Expert, type SourceRef } from "./expert.js";

const MAX_CATALOG_EXPERTS = 4_096;
const MAX_LICENSE_NOTICES = 64;

export type CatalogValidationErrorCode =
  | "CATALOG_INPUT_INVALID"
  | "NOTICE_REGISTRY_INVALID"
  | "EXPERT_INVALID"
  | "DUPLICATE_EXPERT_ID"
  | "DUPLICATE_SOURCE_IDENTITY"
  | "CANONICAL_SOURCE_COLLISION"
  | "MISSING_LICENSE_NOTICE";

const ERROR_MESSAGES: Readonly<Record<CatalogValidationErrorCode, string>> = Object.freeze({
  CATALOG_INPUT_INVALID: "Expert catalog input is invalid",
  NOTICE_REGISTRY_INVALID: "Expert catalog license notice registry is invalid",
  EXPERT_INVALID: "Expert catalog contains an invalid expert record",
  DUPLICATE_EXPERT_ID: "Expert catalog contains a duplicate expert id",
  DUPLICATE_SOURCE_IDENTITY: "Expert catalog contains a duplicate source identity",
  CANONICAL_SOURCE_COLLISION: "Expert catalog contains a canonical source collision",
  MISSING_LICENSE_NOTICE: "Expert catalog provenance is missing a license notice",
});

export class CatalogValidationError extends Error {
  override readonly name = "CatalogValidationError";

  constructor(readonly code: CatalogValidationErrorCode) {
    super(ERROR_MESSAGES[code]);
  }
}

function catalogFail(code: CatalogValidationErrorCode): never {
  throw new CatalogValidationError(code);
}

function snapshotCatalogArray(value: unknown): readonly unknown[] {
  if (nodeTypes.isProxy(value) || !Array.isArray(value)) {
    catalogFail("CATALOG_INPUT_INVALID");
  }
  if (Object.getPrototypeOf(value) !== Array.prototype) {
    catalogFail("CATALOG_INPUT_INVALID");
  }
  const lengthDescriptor = Object.getOwnPropertyDescriptor(value, "length");
  if (lengthDescriptor === undefined
    || !("value" in lengthDescriptor)
    || !Number.isSafeInteger(lengthDescriptor.value)
    || lengthDescriptor.value < 0
    || lengthDescriptor.value > MAX_CATALOG_EXPERTS) {
    catalogFail("CATALOG_INPUT_INVALID");
  }
  const length = lengthDescriptor.value as number;
  const result: unknown[] = [];
  for (const key of Reflect.ownKeys(value)) {
    if (key === "length") continue;
    if (typeof key !== "string"
      || !/^(?:0|[1-9]\d*)$/u.test(key)
      || Number(key) >= length) {
      catalogFail("CATALOG_INPUT_INVALID");
    }
  }
  for (let index = 0; index < length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (descriptor === undefined || !descriptor.enumerable || !("value" in descriptor)) {
      catalogFail("CATALOG_INPUT_INVALID");
    }
    result.push(descriptor.value);
  }
  return Object.freeze(result);
}

function snapshotLicenseNoticeIds(value: unknown): ReadonlySet<string> {
  if (nodeTypes.isProxy(value)
    || !nodeTypes.isSet(value)
    || Object.getPrototypeOf(value) !== Set.prototype
    || Reflect.ownKeys(value).length !== 0
    || value.size > MAX_LICENSE_NOTICES) {
    catalogFail("NOTICE_REGISTRY_INVALID");
  }
  const notices = new Set<string>();
  try {
    for (const item of Set.prototype.values.call(value) as SetIterator<unknown>) {
      if (typeof item !== "string" || item.length === 0 || item.length > 2_048) {
        catalogFail("NOTICE_REGISTRY_INVALID");
      }
      notices.add(item);
    }
  } catch (error: unknown) {
    if (error instanceof CatalogValidationError) throw error;
    catalogFail("NOTICE_REGISTRY_INVALID");
  }
  return notices;
}

function codepointCompare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function canonicalRepository(repository: string): string {
  try {
    const url = new URL(repository);
    if (url.hostname === "github.com") {
      return `https://github.com${url.pathname.toLowerCase()}`;
    }
  } catch {
    // parseExpert already validates repository URLs; keep this helper total.
  }
  return repository;
}

function sourceIdentity(source: SourceRef): string {
  return `${canonicalRepository(source.repository)}\0${source.commit}\0${source.path}`;
}

function canonicalSourceIdentity(source: SourceRef): string {
  return [
    canonicalRepository(source.repository),
    source.commit,
    unicodeDefaultCaseFold(source.path.normalize("NFC")),
  ].join("\0");
}

function freezeExpert(expert: Expert): Expert {
  Object.freeze(expert.source);
  if (expert.origin === "upstream_translation") Object.freeze(expert.upstreamSource);
  Object.freeze(expert.capabilities);
  Object.freeze(expert.domains);
  Object.freeze(expert.projectSignals);
  Object.freeze(expert.activationConditions);
  Object.freeze(expert.exclusionConditions);
  Object.freeze(expert.preferredTasks);
  Object.freeze(expert.qualityGates);
  return Object.freeze(expert);
}

/**
 * Validates an already-loaded offline expert array. This runtime module deliberately
 * has no filesystem, Git, process, or network capability; release provenance checks
 * live in scripts/verify-catalog.ts.
 */
export function validateCatalog(
  values: unknown,
  availableLicenseIds: ReadonlySet<string>,
): readonly Expert[] {
  const snapshot = snapshotCatalogArray(values);
  const notices = snapshotLicenseNoticeIds(availableLicenseIds);
  const experts = snapshot.map((value) => {
    try {
      return freezeExpert(parseExpert(value));
    } catch {
      catalogFail("EXPERT_INVALID");
    }
  });

  const ids = new Set<string>();
  const exactSources = new Set<string>();
  const canonicalSources = new Set<string>();
  for (const expert of experts) {
    if (ids.has(expert.id)) catalogFail("DUPLICATE_EXPERT_ID");
    ids.add(expert.id);
    const sources = expert.origin === "upstream_translation"
      ? [expert.source, expert.upstreamSource]
      : [expert.source];
    for (const source of sources) {
      if (!notices.has(source.repository)) catalogFail("MISSING_LICENSE_NOTICE");
      const exact = sourceIdentity(source);
      if (exactSources.has(exact)) catalogFail("DUPLICATE_SOURCE_IDENTITY");
      exactSources.add(exact);
      const canonical = canonicalSourceIdentity(source);
      if (canonicalSources.has(canonical)) catalogFail("CANONICAL_SOURCE_COLLISION");
      canonicalSources.add(canonical);
    }
  }

  experts.sort((left, right) => codepointCompare(left.id, right.id));
  return Object.freeze(experts);
}
