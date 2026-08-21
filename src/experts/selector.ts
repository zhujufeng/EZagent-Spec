import { createHash } from "node:crypto";
import { types as nodeTypes } from "node:util";

import type { RiskLevel } from "../domain/work-item.js";
import { unicodeDefaultCaseFold } from "../text/unicode-case-fold.js";
import { parseExpert, type Expert } from "./expert.js";

const REQUEST_KEYS = ["capabilities", "domains", "projectSignals", "risk", "reviewAfter"] as const;
const RESULT_KEYS = ["selected", "uncoveredCapabilities", "requiresPlanReview", "audit"] as const;
const AUDIT_KEYS = ["schemaVersion", "requests", "catalogDeltas", "fingerprint"] as const;
const CATALOG_AUDIT_ENTRY_KEYS = ["id", "expertFingerprint"] as const;
const SELECTED_EXPERT_KEYS = ["expert", "score", "reasons"] as const;

const MAX_CATALOG_EXPERTS = 4_096;
const MAX_REQUEST_TOKENS = 512;
const MAX_HISTORY_STAGES = 64;
const MAX_HISTORY_TOKENS = 32_768;
const MAX_HISTORY_UTF16_UNITS = 1_048_576;
const MAX_HISTORY_SERIALIZED_BYTES = 1_048_576;
const MAX_CUMULATIVE_CAPABILITIES = 16_384;
const MAX_REASONS = 512;
const MAX_TOKEN_LENGTH = 64;
const MAX_REASON_LENGTH = 96;
const RAW_LENGTH_PADDING = 256;
const PORTABLE_TOKEN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;
const AUDIT_REASON = /^(covers|domain|signal):([a-z0-9]+(?:-[a-z0-9]+)*)$/u;
const AUDIT_FINGERPRINT = /^sha256:[0-9a-f]{64}$/u;
const EXPERT_ID = /^ezagent\.[a-z0-9]+(?:-[a-z0-9]+)*(?:\.[a-z0-9]+(?:-[a-z0-9]+)*)*$/u;
const RISK_LEVELS = new Set<RiskLevel>(["consult", "light", "standard", "high"]);

/**
 * A rejection-only resource bound for a local catalog input. It is not a
 * selection quota: selection has no maxExperts option and never truncates a
 * valid result to a fixed total.
 */
export const SELECTOR_CATALOG_SAFETY_LIMIT = MAX_CATALOG_EXPERTS;

export class ExpertSelectionValidationError extends Error {
  override readonly name = "ExpertSelectionValidationError";
}

export interface SelectionRequest {
  capabilities: string[];
  domains: string[];
  projectSignals: string[];
  risk: RiskLevel;
  reviewAfter: number;
}

export interface SelectedExpert {
  expert: Expert;
  score: number;
  reasons: string[];
}

export interface SelectionAudit {
  schemaVersion: 1;
  requests: SelectionRequest[];
  catalogDeltas: CatalogAuditEntry[][];
  fingerprint: string;
}

export interface CatalogAuditEntry {
  id: string;
  expertFingerprint: string;
}

export interface SelectionResult {
  selected: SelectedExpert[];
  uncoveredCapabilities: string[];
  requiresPlanReview: boolean;
  audit: SelectionAudit;
}

type SelectionCore = Omit<SelectionResult, "audit">;

interface Candidate {
  expert: Expert;
  coveredCapabilities: string[];
  domainHits: string[];
  projectSignalHits: string[];
  reviewBonus: boolean;
  remainingCoverage: number;
  selected: boolean;
}

function fail(message: string): never {
  throw new ExpertSelectionValidationError(`Invalid expert selection: ${message}`);
}

function isProxy(value: unknown): boolean {
  return value !== null &&
    (typeof value === "object" || typeof value === "function") &&
    nodeTypes.isProxy(value);
}

function snapshotPlainObject(
  value: unknown,
  path: string,
  allowedKeys: readonly string[],
): Record<string, unknown> {
  if (isProxy(value)) fail(`${path} cannot be a Proxy`);
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    fail(`${path} must be a plain object`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    fail(`${path} must be a plain object`);
  }

  const allowed = new Set(allowedKeys);
  const snapshot: Record<string, unknown> = {};
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string") fail(`${path} contains an unsupported symbol key`);
    if (!allowed.has(key)) fail(`${path}.${key} is unsupported`);
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || !descriptor.enumerable) {
      fail(`${path}.${key} must be an enumerable own data property`);
    }
    if (!("value" in descriptor)) fail(`${path}.${key} cannot be an accessor property`);
    snapshot[key] = descriptor.value;
  }
  return snapshot;
}

function snapshotArray(value: unknown, path: string, maximumItems: number): unknown[] {
  if (isProxy(value)) fail(`${path} cannot be a Proxy`);
  if (!Array.isArray(value)) fail(`${path} must be an array`);

  const lengthDescriptor = Object.getOwnPropertyDescriptor(value, "length");
  if (lengthDescriptor === undefined || !("value" in lengthDescriptor)) {
    fail(`${path}.length must be an own data property`);
  }
  const length = lengthDescriptor.value;
  if (!Number.isSafeInteger(length) || length < 0) {
    fail(`${path}.length must be a non-negative safe integer`);
  }
  if (length > maximumItems) fail(`${path} cannot contain more than ${maximumItems} items`);

  for (const key of Reflect.ownKeys(value)) {
    if (key === "length") continue;
    if (typeof key !== "string" || !/^(0|[1-9]\d*)$/u.test(key) || Number(key) >= length) {
      fail(`${path} contains an unsupported array key`);
    }
  }

  const snapshot: unknown[] = [];
  for (let index = 0; index < length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (descriptor === undefined) fail(`${path} must be dense; index ${index} is missing`);
    if (!descriptor.enumerable || !("value" in descriptor)) {
      fail(`${path}.${index} cannot be a non-enumerable or accessor property`);
    }
    snapshot.push(descriptor.value);
  }
  return snapshot;
}

function requireOwn(snapshot: Record<string, unknown>, path: string, keys: readonly string[]): void {
  for (const key of keys) {
    if (!Object.prototype.hasOwnProperty.call(snapshot, key)) fail(`${path}.${key} is required`);
  }
}

function collisionKey(value: string): string {
  return unicodeDefaultCaseFold(value.normalize("NFKC")).normalize("NFKC");
}

function portableCompare(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function normalizeToken(value: unknown, path: string, requireCanonical: boolean): string {
  if (typeof value !== "string") fail(`${path} must be a string`);
  if (value.length > MAX_TOKEN_LENGTH + RAW_LENGTH_PADDING) {
    fail(`${path} raw length exceeds ${MAX_TOKEN_LENGTH + RAW_LENGTH_PADDING}`);
  }
  const normalized = value.trim();
  if (
    normalized.length === 0 ||
    normalized.length > MAX_TOKEN_LENGTH ||
    !PORTABLE_TOKEN.test(normalized)
  ) {
    fail(`${path} must be a lowercase portable token of at most ${MAX_TOKEN_LENGTH} characters`);
  }
  if (requireCanonical && normalized !== value) fail(`${path} must already be canonical`);
  return normalized;
}

function snapshotTokens(
  value: unknown,
  path: string,
  requireCanonical: boolean,
  maximumItems = MAX_REQUEST_TOKENS,
): string[] {
  const raw = snapshotArray(value, path, maximumItems);
  const tokens: string[] = [];
  const seen = new Set<string>();
  for (const [index, item] of raw.entries()) {
    const token = normalizeToken(item, `${path}.${index}`, requireCanonical);
    const key = collisionKey(token);
    if (seen.has(key)) fail(`${path} contains a duplicate canonical token at index ${index}`);
    seen.add(key);
    tokens.push(token);
  }
  return tokens;
}

function snapshotRequest(
  value: unknown,
  path = "request",
  requireCanonical = false,
): SelectionRequest {
  const snapshot = snapshotPlainObject(value, path, REQUEST_KEYS);
  requireOwn(snapshot, path, REQUEST_KEYS);
  const risk = snapshot.risk;
  if (typeof risk !== "string" || !RISK_LEVELS.has(risk as RiskLevel)) {
    fail(`${path}.risk must be consult, light, standard, or high`);
  }
  const reviewAfter = snapshot.reviewAfter;
  if (!Number.isSafeInteger(reviewAfter) || (reviewAfter as number) < 0) {
    fail(`${path}.reviewAfter must be a non-negative safe integer`);
  }
  return {
    capabilities: snapshotTokens(snapshot.capabilities, `${path}.capabilities`, requireCanonical),
    domains: snapshotTokens(snapshot.domains, `${path}.domains`, requireCanonical),
    projectSignals: snapshotTokens(
      snapshot.projectSignals,
      `${path}.projectSignals`,
      requireCanonical,
    ),
    risk: risk as RiskLevel,
    reviewAfter: reviewAfter as number,
  };
}

function snapshotCatalog(value: unknown): Expert[] {
  const raw = snapshotArray(value, "catalog", MAX_CATALOG_EXPERTS);
  const experts: Expert[] = [];
  const ids = new Set<string>();
  for (const [index, item] of raw.entries()) {
    let parsed: Expert;
    try {
      parsed = parseExpert(item);
    } catch (error) {
      const detail = error instanceof Error ? `: ${error.message}` : "";
      fail(`catalog.${index} is not a valid expert${detail}`);
    }
    const key = collisionKey(parsed.id);
    if (ids.has(key)) fail(`catalog contains duplicate expert id ${parsed.id}`);
    ids.add(key);
    experts.push(parsed);
  }
  return experts;
}

function expertFingerprint(expert: Expert): string {
  return `sha256:${createHash("sha256").update(JSON.stringify(expert)).digest("hex")}`;
}

function catalogAuditEntries(experts: Expert[]): CatalogAuditEntry[] {
  return experts
    .map((expert) => ({ id: expert.id, expertFingerprint: expertFingerprint(expert) }))
    .sort((left, right) => portableCompare(left.id, right.id));
}

function reasonWeight(reason: string): number {
  if (reason.startsWith("covers:")) return 6;
  if (reason.startsWith("domain:")) return 4;
  return 2;
}

function validateReason(reason: unknown, expert: Expert, path: string): string {
  if (typeof reason !== "string") fail(`${path} must be a string`);
  if (reason.length > MAX_REASON_LENGTH + RAW_LENGTH_PADDING) {
    fail(`${path} raw length exceeds ${MAX_REASON_LENGTH + RAW_LENGTH_PADDING}`);
  }
  if (reason === "risk:review") {
    if (!expert.preferredTasks.includes("review")) {
      fail(`${path} claims a review bonus for an expert that does not review`);
    }
    return reason;
  }
  const match = AUDIT_REASON.exec(reason);
  if (match === null || reason.length > MAX_REASON_LENGTH) fail(`${path} is not auditable`);
  const category = match[1]!;
  const token = match[2]!;
  const source = category === "covers"
    ? expert.capabilities
    : category === "domain"
      ? expert.domains
      : expert.projectSignals;
  if (!source.includes(token)) fail(`${path} is inconsistent with expert ${expert.id}`);
  return reason;
}

function snapshotSelected(value: unknown, path: string): SelectedExpert {
  const snapshot = snapshotPlainObject(value, path, SELECTED_EXPERT_KEYS);
  requireOwn(snapshot, path, SELECTED_EXPERT_KEYS);
  let expert: Expert;
  try {
    expert = parseExpert(snapshot.expert);
  } catch (error) {
    const detail = error instanceof Error ? `: ${error.message}` : "";
    fail(`${path}.expert is invalid${detail}`);
  }
  if (!Number.isSafeInteger(snapshot.score) || (snapshot.score as number) < 0) {
    fail(`${path}.score must be a non-negative safe integer`);
  }

  const rawReasons = snapshotArray(snapshot.reasons, `${path}.reasons`, MAX_REASONS);
  if (rawReasons.length === 0) fail(`${path}.reasons must not be empty`);
  const reasons: string[] = [];
  const seen = new Set<string>();
  for (const [index, item] of rawReasons.entries()) {
    const reason = validateReason(item, expert, `${path}.reasons.${index}`);
    const key = collisionKey(reason);
    if (seen.has(key)) fail(`${path}.reasons contains a duplicate`);
    seen.add(key);
    reasons.push(reason);
  }
  if ([...reasons].sort(portableCompare).some((reason, index) => reason !== reasons[index])) {
    fail(`${path}.reasons must use stable code-unit order`);
  }
  if (!reasons.some((reason) => reason.startsWith("covers:"))) {
    fail(`${path}.reasons must contain a coverage reason`);
  }
  const expectedScore = reasons.reduce((sum, reason) => sum + reasonWeight(reason), 0);
  if (snapshot.score !== expectedScore) fail(`${path}.score does not match its reasons`);
  return { expert, score: snapshot.score as number, reasons };
}

function snapshotSelectedList(value: unknown, maximumItems: number): SelectedExpert[] {
  const raw = snapshotArray(value, "current.selected", maximumItems);
  const selected: SelectedExpert[] = [];
  const ids = new Set<string>();
  for (const [index, item] of raw.entries()) {
    const parsed = snapshotSelected(item, `current.selected.${index}`);
    const key = collisionKey(parsed.expert.id);
    if (ids.has(key)) fail(`current.selected contains duplicate expert id ${parsed.expert.id}`);
    ids.add(key);
    selected.push(parsed);
  }
  return selected;
}

function snapshotCatalogAuditEntry(value: unknown, path: string): CatalogAuditEntry {
  const snapshot = snapshotPlainObject(value, path, CATALOG_AUDIT_ENTRY_KEYS);
  requireOwn(snapshot, path, CATALOG_AUDIT_ENTRY_KEYS);
  if (
    typeof snapshot.id !== "string" ||
    snapshot.id.length > 416 ||
    !EXPERT_ID.test(snapshot.id)
  ) {
    fail(`${path}.id must be a canonical expert id`);
  }
  if (
    typeof snapshot.expertFingerprint !== "string" ||
    !AUDIT_FINGERPRINT.test(snapshot.expertFingerprint)
  ) {
    fail(`${path}.expertFingerprint must be a lowercase SHA-256 digest`);
  }
  return { id: snapshot.id, expertFingerprint: snapshot.expertFingerprint };
}

function snapshotCatalogDeltas(value: unknown, stageCount: number): CatalogAuditEntry[][] {
  const rawDeltas = snapshotArray(value, "current.audit.catalogDeltas", MAX_HISTORY_STAGES);
  if (rawDeltas.length !== stageCount) {
    fail("current.audit.catalogDeltas must have one entry per request stage");
  }
  const deltas: CatalogAuditEntry[][] = [];
  const seen = new Set<string>();
  let remainingEntries = MAX_CATALOG_EXPERTS;
  for (const [stageIndex, rawDelta] of rawDeltas.entries()) {
    const path = `current.audit.catalogDeltas.${stageIndex}`;
    const rawEntries = snapshotArray(rawDelta, path, remainingEntries);
    remainingEntries -= rawEntries.length;
    const delta = rawEntries.map((entry, entryIndex) =>
      snapshotCatalogAuditEntry(entry, `${path}.${entryIndex}`));
    if ([...delta].sort((left, right) => portableCompare(left.id, right.id))
      .some((entry, index) => entry.id !== delta[index]?.id)) {
      fail(`${path} must use stable expert-id order`);
    }
    for (const entry of delta) {
      if (seen.has(entry.id)) fail(`current.audit catalog repeats expert id ${entry.id}`);
      seen.add(entry.id);
    }
    deltas.push(delta);
  }
  return deltas;
}

function assertHistoryBudget(
  requests: SelectionRequest[],
  catalogDeltas: CatalogAuditEntry[][],
): void {
  if (requests.length === 0 || requests.length > MAX_HISTORY_STAGES) {
    fail(`audit history cannot contain more than ${MAX_HISTORY_STAGES} stages`);
  }
  if (catalogDeltas.length !== requests.length) {
    fail("audit history must have one catalog delta per request stage");
  }
  const catalogEntryCount = catalogDeltas.reduce((sum, delta) => sum + delta.length, 0);
  if (catalogEntryCount > MAX_CATALOG_EXPERTS) {
    fail(`audit history catalog entries exceed ${MAX_CATALOG_EXPERTS}`);
  }

  let tokenCount = 0;
  let utf16Units = 0;
  for (const request of requests) {
    for (const token of [...request.capabilities, ...request.domains, ...request.projectSignals]) {
      tokenCount += 1;
      utf16Units += token.length;
      if (tokenCount > MAX_HISTORY_TOKENS) {
        fail(`audit history token budget exceeds ${MAX_HISTORY_TOKENS}`);
      }
      if (utf16Units > MAX_HISTORY_UTF16_UNITS) {
        fail(`audit history UTF-16 budget exceeds ${MAX_HISTORY_UTF16_UNITS}`);
      }
    }
  }
  const serialized = JSON.stringify({ schemaVersion: 1, requests, catalogDeltas });
  if (Buffer.byteLength(serialized, "utf8") > MAX_HISTORY_SERIALIZED_BYTES) {
    fail(`audit history byte budget exceeds ${MAX_HISTORY_SERIALIZED_BYTES}`);
  }
}

function snapshotAudit(value: unknown): SelectionAudit {
  const snapshot = snapshotPlainObject(value, "current.audit", AUDIT_KEYS);
  requireOwn(snapshot, "current.audit", AUDIT_KEYS);
  if (snapshot.schemaVersion !== 1) fail("current.audit.schemaVersion must be 1");
  const rawRequests = snapshotArray(
    snapshot.requests,
    "current.audit.requests",
    MAX_HISTORY_STAGES,
  );
  if (rawRequests.length === 0) fail("current.audit.requests must not be empty");
  const requests = rawRequests.map((item, index) =>
    snapshotRequest(item, `current.audit.requests.${index}`, true));
  const catalogDeltas = snapshotCatalogDeltas(snapshot.catalogDeltas, requests.length);
  assertHistoryBudget(requests, catalogDeltas);
  if (typeof snapshot.fingerprint !== "string" || !AUDIT_FINGERPRINT.test(snapshot.fingerprint)) {
    fail("current.audit.fingerprint must be a lowercase SHA-256 digest");
  }
  return { schemaVersion: 1, requests, catalogDeltas, fingerprint: snapshot.fingerprint };
}

function snapshotResult(value: unknown, catalogSize: number): SelectionResult {
  const snapshot = snapshotPlainObject(value, "current", RESULT_KEYS);
  requireOwn(snapshot, "current", RESULT_KEYS);
  const selected = snapshotSelectedList(snapshot.selected, catalogSize);
  const uncoveredCapabilities = snapshotTokens(
    snapshot.uncoveredCapabilities,
    "current.uncoveredCapabilities",
    true,
    MAX_CUMULATIVE_CAPABILITIES,
  );
  if (
    [...uncoveredCapabilities].sort(portableCompare)
      .some((capability, index) => capability !== uncoveredCapabilities[index])
  ) {
    fail("current.uncoveredCapabilities must use stable code-unit order");
  }
  if (typeof snapshot.requiresPlanReview !== "boolean") {
    fail("current.requiresPlanReview must be a boolean");
  }
  return {
    selected,
    uncoveredCapabilities,
    requiresPlanReview: snapshot.requiresPlanReview,
    audit: snapshotAudit(snapshot.audit),
  };
}

function candidateScore(candidate: Candidate): number {
  return candidate.remainingCoverage * 6 +
    candidate.domainHits.length * 4 +
    candidate.projectSignalHits.length * 2 +
    (candidate.reviewBonus ? 2 : 0);
}

function candidateIsBetter(candidate: Candidate, current: Candidate | undefined): boolean {
  if (current === undefined) return true;
  if (candidate.remainingCoverage !== current.remainingCoverage) {
    return candidate.remainingCoverage > current.remainingCoverage;
  }
  const scoreDifference = candidateScore(candidate) - candidateScore(current);
  if (scoreDifference !== 0) return scoreDifference > 0;
  return portableCompare(candidate.expert.id, current.expert.id) < 0;
}

function runCoverageSelection(experts: Expert[], request: SelectionRequest): SelectionCore {
  const uncovered = new Set(request.capabilities);
  const requestedDomains = new Set(request.domains);
  const requestedSignals = new Set(request.projectSignals);
  const candidates: Candidate[] = [];
  const byCapability = new Map<string, number[]>();

  for (const expert of experts) {
    const coveredCapabilities = expert.capabilities.filter((capability) => uncovered.has(capability));
    if (coveredCapabilities.length === 0) continue;
    const candidateIndex = candidates.length;
    const candidate: Candidate = {
      expert,
      coveredCapabilities,
      domainHits: expert.domains.filter((domain) => requestedDomains.has(domain)),
      projectSignalHits: expert.projectSignals.filter((signal) => requestedSignals.has(signal)),
      reviewBonus: request.risk === "high" && expert.preferredTasks.includes("review"),
      remainingCoverage: coveredCapabilities.length,
      selected: false,
    };
    candidates.push(candidate);
    for (const capability of coveredCapabilities) {
      const indexes = byCapability.get(capability);
      if (indexes === undefined) byCapability.set(capability, [candidateIndex]);
      else indexes.push(candidateIndex);
    }
  }

  const selected: SelectedExpert[] = [];
  while (uncovered.size > 0) {
    let best: Candidate | undefined;
    for (const candidate of candidates) {
      if (!candidate.selected && candidate.remainingCoverage > 0 && candidateIsBetter(candidate, best)) {
        best = candidate;
      }
    }
    if (best === undefined) break;

    const newlyCovered = best.coveredCapabilities.filter((capability) => uncovered.has(capability));
    const reasons = [
      ...newlyCovered.map((capability) => `covers:${capability}`),
      ...best.domainHits.map((domain) => `domain:${domain}`),
      ...(best.reviewBonus ? ["risk:review"] : []),
      ...best.projectSignalHits.map((signal) => `signal:${signal}`),
    ].sort(portableCompare);
    selected.push({ expert: best.expert, score: candidateScore(best), reasons });
    best.selected = true;

    for (const capability of newlyCovered) {
      if (!uncovered.delete(capability)) continue;
      for (const candidateIndex of byCapability.get(capability) ?? []) {
        const affected = candidates[candidateIndex]!;
        if (!affected.selected) affected.remainingCoverage -= 1;
      }
    }
  }

  return {
    selected,
    uncoveredCapabilities: [...uncovered].sort(portableCompare),
    requiresPlanReview: selected.length > request.reviewAfter,
  };
}

function runExpansion(current: SelectionCore, catalog: Expert[], request: SelectionRequest): SelectionCore {
  const currentIds = new Set(current.selected.map((item) => item.expert.id));
  const covered = new Set(current.selected.flatMap((item) => item.expert.capabilities));
  const needed = [...new Set([...current.uncoveredCapabilities, ...request.capabilities])]
    .filter((capability) => !covered.has(capability));
  const expansion = runCoverageSelection(
    catalog.filter((expert) => !currentIds.has(expert.id)),
    { ...request, capabilities: needed },
  );
  const selected = [...current.selected, ...expansion.selected];
  if (expansion.uncoveredCapabilities.length > MAX_CUMULATIVE_CAPABILITIES) {
    fail(`cumulative uncovered capabilities exceed ${MAX_CUMULATIVE_CAPABILITIES}`);
  }
  return {
    selected,
    uncoveredCapabilities: expansion.uncoveredCapabilities,
    requiresPlanReview: selected.length > request.reviewAfter,
  };
}

interface ResolvedAuditCatalog {
  catalogById: Map<string, Expert>;
  historicalIds: Set<string>;
  newExperts: Expert[];
}

function resolveAuditCatalog(catalog: Expert[], audit: SelectionAudit): ResolvedAuditCatalog {
  const catalogById = new Map(catalog.map((expert) => [expert.id, expert]));
  const historicalIds = new Set<string>();
  for (const delta of audit.catalogDeltas) {
    for (const entry of delta) {
      const expert = catalogById.get(entry.id);
      if (expert === undefined) {
        fail(`historically reviewed expert ${entry.id} is absent from the current catalog`);
      }
      if (expertFingerprint(expert) !== entry.expertFingerprint) {
        fail(`catalog changed historically reviewed expert ${entry.id}`);
      }
      historicalIds.add(entry.id);
    }
  }
  return {
    catalogById,
    historicalIds,
    newExperts: catalog.filter((expert) => !historicalIds.has(expert.id)),
  };
}

function replay(
  catalogById: Map<string, Expert>,
  requests: SelectionRequest[],
  catalogDeltas: CatalogAuditEntry[][],
): SelectionCore {
  const stagedCatalog: Expert[] = [];
  let result: SelectionCore | undefined;
  for (let index = 0; index < requests.length; index += 1) {
    for (const entry of catalogDeltas[index]!) {
      stagedCatalog.push(catalogById.get(entry.id)!);
    }
    result = index === 0
      ? runCoverageSelection(stagedCatalog, requests[index]!)
      : runExpansion(result!, stagedCatalog, requests[index]!);
  }
  return result!;
}

function updateHashRecord(hash: ReturnType<typeof createHash>, value: unknown): void {
  const json = JSON.stringify(value);
  hash.update(String(Buffer.byteLength(json, "utf8")));
  hash.update(":");
  hash.update(json);
}

function fingerprint(
  requests: SelectionRequest[],
  catalogDeltas: CatalogAuditEntry[][],
  result: SelectionCore,
): string {
  const hash = createHash("sha256");
  hash.update("ezagent-selection-audit-v1\0");
  updateHashRecord(hash, requests);
  updateHashRecord(hash, catalogDeltas);
  updateHashRecord(hash, result);
  return `sha256:${hash.digest("hex")}`;
}

/**
 * The unkeyed digest is a replay-coherence checksum, not a signature or a
 * tamper-proof audit anchor. Trellis audit/catalog revisions provide that
 * durable anchor in the later workflow milestone.
 */
function withAudit(
  result: SelectionCore,
  requests: SelectionRequest[],
  catalogDeltas: CatalogAuditEntry[][],
): SelectionResult {
  const requestSnapshots = requests.map((request) => structuredClone(request));
  const deltaSnapshots = catalogDeltas.map((delta) => structuredClone(delta));
  assertHistoryBudget(requestSnapshots, deltaSnapshots);
  if (result.uncoveredCapabilities.length > MAX_CUMULATIVE_CAPABILITIES) {
    fail(`cumulative uncovered capabilities exceed ${MAX_CUMULATIVE_CAPABILITIES}`);
  }
  return {
    ...result,
    audit: {
      schemaVersion: 1,
      requests: requestSnapshots,
      catalogDeltas: deltaSnapshots,
      fingerprint: fingerprint(requestSnapshots, deltaSnapshots, result),
    },
  };
}

function coreOf(result: SelectionResult): SelectionCore {
  return {
    selected: result.selected,
    uncoveredCapabilities: result.uncoveredCapabilities,
    requiresPlanReview: result.requiresPlanReview,
  };
}

function sameCore(left: SelectionCore, right: SelectionCore): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function validateCatalogMembership(
  current: SelectionResult,
  resolved: ResolvedAuditCatalog,
): void {
  for (const item of current.selected) {
    if (!resolved.historicalIds.has(item.expert.id)) {
      fail(`current expert ${item.expert.id} is an outsider to the audited catalog history`);
    }
    const reviewed = resolved.catalogById.get(item.expert.id)!;
    if (JSON.stringify(reviewed) !== JSON.stringify(item.expert)) {
      fail(`catalog changed expert ${item.expert.id} since current selection`);
    }
  }
}

export function selectExperts(values: unknown[], request: SelectionRequest): SelectionResult {
  const catalog = snapshotCatalog(values);
  const normalizedRequest = snapshotRequest(request);
  return withAudit(
    runCoverageSelection(catalog, normalizedRequest),
    [normalizedRequest],
    [catalogAuditEntries(catalog)],
  );
}

export function expandExpertSelection(
  current: SelectionResult,
  values: unknown[],
  request: SelectionRequest,
): SelectionResult {
  const catalog = snapshotCatalog(values);
  const currentSnapshot = snapshotResult(current, catalog.length);
  const resolvedCatalog = resolveAuditCatalog(catalog, currentSnapshot.audit);
  validateCatalogMembership(currentSnapshot, resolvedCatalog);

  const currentCore = coreOf(currentSnapshot);
  if (
    fingerprint(
      currentSnapshot.audit.requests,
      currentSnapshot.audit.catalogDeltas,
      currentCore,
    ) !== currentSnapshot.audit.fingerprint
  ) {
    fail("current audit fingerprint does not match its request history and result");
  }
  const replayed = replay(
    resolvedCatalog.catalogById,
    currentSnapshot.audit.requests,
    currentSnapshot.audit.catalogDeltas,
  );
  if (!sameCore(replayed, currentCore)) {
    fail("current audit replay does not reproduce the selection from the reviewed catalog");
  }

  const normalizedRequest = snapshotRequest(request);
  const requests = [...currentSnapshot.audit.requests, normalizedRequest];
  const catalogDeltas = [
    ...currentSnapshot.audit.catalogDeltas,
    catalogAuditEntries(resolvedCatalog.newExperts),
  ];
  assertHistoryBudget(requests, catalogDeltas);
  return withAudit(
    runExpansion(currentCore, catalog, normalizedRequest),
    requests,
    catalogDeltas,
  );
}

/**
 * Typed internal scheduling primitive. Selection validation happens at
 * selectExperts/expandExpertSelection; batching only limits simultaneous work
 * and preserves every selected entry and its original order.
 */
export function batchExpertSelection(
  selected: SelectedExpert[],
  concurrencyLimit: number,
): SelectedExpert[][] {
  if (!Number.isSafeInteger(concurrencyLimit) || concurrencyLimit < 1) {
    fail("concurrencyLimit must be a positive safe integer");
  }
  const batches: SelectedExpert[][] = [];
  for (let index = 0; index < selected.length; index += concurrencyLimit) {
    batches.push(selected.slice(index, index + concurrencyLimit));
  }
  return batches;
}
