import { constants, lstatSync, realpathSync, type Stats } from "node:fs";
import { lstat, open } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { types as nodeTypes } from "node:util";

import {
  isAlias,
  isMap,
  isScalar,
  isSeq,
  parseAllDocuments,
  type Node,
} from "yaml";

import { isWorkItemId } from "../domain/id.js";
import { unicodeDefaultCaseFold } from "../text/unicode-case-fold.js";
import { isWellFormedUnicode } from "../text/unicode.js";
import { atomicWriteText } from "../workspace/atomic-write.js";
import {
  ensureWorkspaceDirectoryChains,
  nodeWorkspaceDirectoryRuntime,
  validateExistingWorkspaceDirectoryChains,
} from "../workspace/directory-boundary.js";
import { workspacePaths, type WorkspacePaths } from "../workspace/layout.js";
import { withWorkspaceLock } from "../workspace/lock.js";

import {
  BoundedFileReadError,
  readBoundedFileHandle,
} from "./bounded-read.js";

export const ACTIVE_EXPERT_FILE_MAX_BYTES = 1_048_576;

const MAX_REASON_LENGTH = 4_096;
const MAX_EXPERT_ID_LENGTH = 160;
const MAX_TASK_ID_LENGTH = 64;
const MIN_TASK_SEQUENCE_ITEM_BYTES = 26;
// These parser limits are resource boundaries, not product limits on selected experts.
const MAX_YAML_NODES = ACTIVE_EXPERT_FILE_MAX_BYTES;
const MAX_YAML_DEPTH = 12;
const ACTIVE_KEYS = ["revision", "experts"] as const;
const ACTIVE_EXPERT_KEYS = ["id", "reason", "taskIds"] as const;
const EXPERT_ID = /^ezagent\.[a-z0-9]+(?:-[a-z0-9]+)*(?:\.[a-z0-9]+(?:-[a-z0-9]+)*)*$/;
const CONTROL_CHARACTER = /\p{Cc}/u;
const PROTOTYPE_KEYS = new Set(["__proto__", "prototype", "constructor", "<<"]);

export interface ActiveExpert {
  readonly id: string;
  readonly reason: string;
  readonly taskIds: readonly string[];
}

export interface ActiveExperts {
  readonly revision: number;
  readonly experts: readonly ActiveExpert[];
}

export type ActiveExpertValidationErrorCode =
  | "ACTIVE_EXPERT_INVALID_INPUT"
  | "ACTIVE_EXPERT_REVISION_INVALID"
  | "ACTIVE_EXPERT_FILE_INVALID"
  | "ACTIVE_EXPERT_FILE_CHANGED"
  | "ACTIVE_EXPERT_PROJECT_INVALID";

const VALIDATION_MESSAGES: Readonly<Record<ActiveExpertValidationErrorCode, string>> = Object.freeze({
  ACTIVE_EXPERT_INVALID_INPUT: "Active expert state is invalid",
  ACTIVE_EXPERT_REVISION_INVALID: "Active expert revision must increment by exactly one",
  ACTIVE_EXPERT_FILE_INVALID: "Active expert file is invalid",
  ACTIVE_EXPERT_FILE_CHANGED: "Active expert file changed during read",
  ACTIVE_EXPERT_PROJECT_INVALID: "Active expert project root is invalid",
});

export class ActiveExpertValidationError extends Error {
  override readonly name = "ActiveExpertValidationError";

  constructor(readonly code: ActiveExpertValidationErrorCode) {
    super(VALIDATION_MESSAGES[code]);
  }
}

export class ActiveExpertConflictError extends Error {
  override readonly name = "ActiveExpertConflictError";
  readonly code = "ACTIVE_EXPERT_REVISION_CONFLICT" as const;

  constructor(
    readonly expectedRevision: number,
    readonly actualRevision: number,
  ) {
    super("Active expert revision conflict");
  }
}

function fail(code: ActiveExpertValidationErrorCode): never {
  throw new ActiveExpertValidationError(code);
}

function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === "ENOENT";
}

function portableCompare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function collisionKey(value: string): string {
  return unicodeDefaultCaseFold(value);
}

function canonicalProjectRoot(projectRoot: string): string {
  if (typeof projectRoot !== "string"
    || projectRoot.length === 0
    || projectRoot.includes("\0")
    || !isAbsolute(projectRoot)) {
    fail("ACTIVE_EXPERT_PROJECT_INVALID");
  }

  try {
    const lexical = resolve(projectRoot);
    // Ancestor aliases are canonicalized below, but the project root supplied
    // by the caller must itself be a real directory rather than a symlink.
    if (!lstatSync(lexical).isDirectory()) {
      fail("ACTIVE_EXPERT_PROJECT_INVALID");
    }
    // Resolve platform aliases such as macOS /var -> /private/var once. All
    // later paths are joined below this real directory rather than traversing
    // a caller-provided symlink chain on every operation.
    const canonical = realpathSync.native(resolve(projectRoot));
    if (!lstatSync(canonical).isDirectory()) {
      fail("ACTIVE_EXPERT_PROJECT_INVALID");
    }
    return canonical;
  } catch (error: unknown) {
    if (error instanceof ActiveExpertValidationError) throw error;
    fail("ACTIVE_EXPERT_PROJECT_INVALID");
  }
}

interface InputBudget {
  readonly code: ActiveExpertValidationErrorCode;
  nodes: number;
  rawCodeUnits: number;
  estimatedBytes: number;
  actualBytes: number;
}

type InputBudgetCounter = "nodes" | "rawCodeUnits" | "estimatedBytes" | "actualBytes";

function createInputBudget(code: ActiveExpertValidationErrorCode): InputBudget {
  return { code, nodes: 0, rawCodeUnits: 0, estimatedBytes: 0, actualBytes: 0 };
}

function chargeBudget(budget: InputBudget, counter: InputBudgetCounter, amount: number): void {
  if (!Number.isSafeInteger(amount)
    || amount < 0
    || amount > ACTIVE_EXPERT_FILE_MAX_BYTES - budget[counter]) {
    fail(budget.code);
  }
  budget[counter] += amount;
}

function chargeRepeatedBudget(
  budget: InputBudget,
  counter: InputBudgetCounter,
  count: number,
  perItem: number,
): void {
  if (count > Math.floor((ACTIVE_EXPERT_FILE_MAX_BYTES - budget[counter]) / perItem)) {
    fail(budget.code);
  }
  chargeBudget(budget, counter, count * perItem);
}

function chargeRawString(value: unknown, budget: InputBudget): value is string {
  if (typeof value !== "string") return false;
  // String length is constant-time; charge it before trim, normalization,
  // regexp, UTF-8 sizing, or any other content scan.
  chargeBudget(budget, "rawCodeUnits", value.length);
  return true;
}

function chargeActualText(budget: InputBudget, text: string): void {
  chargeBudget(budget, "actualBytes", Buffer.byteLength(text, "utf8"));
}

function snapshotDataObject(
  value: unknown,
  allowedKeys: readonly string[],
  budget: InputBudget,
): Record<string, unknown> {
  const { code } = budget;
  if (value === null || typeof value !== "object" || Array.isArray(value) || nodeTypes.isProxy(value)) {
    fail(code);
  }
  chargeBudget(budget, "nodes", 1);
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    fail(code);
  }

  const allowed = new Set(allowedKeys);
  const snapshot: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string" || !allowed.has(key)) fail(code);
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || !descriptor.enumerable || !("value" in descriptor)) fail(code);
    Object.defineProperty(snapshot, key, {
      value: descriptor.value,
      enumerable: true,
      writable: true,
      configurable: true,
    });
  }
  return snapshot;
}

function snapshotDenseArray(
  value: unknown,
  budget: InputBudget,
  minimumSerializedBytesPerItem: number,
): readonly unknown[] {
  const { code } = budget;
  if (nodeTypes.isProxy(value) || !Array.isArray(value)) fail(code);
  const lengthDescriptor = Object.getOwnPropertyDescriptor(value, "length");
  if (lengthDescriptor === undefined || !("value" in lengthDescriptor)) fail(code);
  const length: unknown = lengthDescriptor.value;
  if (!Number.isSafeInteger(length)
    || (length as number) < 0) {
    fail(code);
  }
  // Reserve the whole logical expansion before Reflect.ownKeys, element
  // descriptor inspection, copying, or sorting. Shared arrays are therefore
  // charged again each time they appear in the logical projection.
  chargeBudget(budget, "nodes", 1);
  chargeRepeatedBudget(budget, "nodes", length as number, 1);
  chargeRepeatedBudget(
    budget,
    "estimatedBytes",
    length as number,
    minimumSerializedBytesPerItem,
  );

  for (const key of Reflect.ownKeys(value)) {
    if (key === "length") continue;
    if (typeof key !== "string"
      || !/^(?:0|[1-9]\d*)$/.test(key)
      || Number(key) >= (length as number)) {
      fail(code);
    }
  }

  const snapshot: unknown[] = [];
  for (let index = 0; index < (length as number); index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (descriptor === undefined || !descriptor.enumerable || !("value" in descriptor)) fail(code);
    snapshot.push(descriptor.value);
  }
  return snapshot;
}

function validReason(value: unknown, budget: InputBudget): value is string {
  return chargeRawString(value, budget)
    && value.length >= 1
    && value.length <= MAX_REASON_LENGTH
    && value.trim() === value
    && value.normalize("NFC") === value
    && isWellFormedUnicode(value)
    && !CONTROL_CHARACTER.test(value);
}

function validExpertId(value: unknown, budget: InputBudget): value is string {
  return chargeRawString(value, budget)
    && value.length <= MAX_EXPERT_ID_LENGTH
    && value.normalize("NFC") === value
    && EXPERT_ID.test(value);
}

function validTaskId(value: unknown, budget: InputBudget): value is string {
  return chargeRawString(value, budget)
    && value.length <= MAX_TASK_ID_LENGTH
    && value.startsWith("TASK-")
    && isWorkItemId(value);
}

function normalizeActiveState(
  value: unknown,
  code: ActiveExpertValidationErrorCode,
): ActiveExperts {
  const budget = createInputBudget(code);
  let top: Record<string, unknown>;
  try {
    top = snapshotDataObject(value, ACTIVE_KEYS, budget);
  } catch (error: unknown) {
    if (error instanceof ActiveExpertValidationError) throw error;
    fail(code);
  }
  if (!Object.prototype.hasOwnProperty.call(top, "revision")
    || !Object.prototype.hasOwnProperty.call(top, "experts")
    || !Number.isSafeInteger(top.revision)
    || (top.revision as number) < 0) {
    fail(code);
  }

  let rawExperts: readonly unknown[];
  try {
    rawExperts = snapshotDenseArray(top.experts, budget, 1);
  } catch (error: unknown) {
    if (error instanceof ActiveExpertValidationError) throw error;
    fail(code);
  }

  const revision = top.revision as number;
  chargeActualText(
    budget,
    rawExperts.length === 0
      ? `revision: ${revision}\nexperts: []\n`
      : `revision: ${revision}\nexperts:\n`,
  );

  const expertIds = new Set<string>();
  const experts: ActiveExpert[] = [];
  for (const rawExpert of rawExperts) {
    let expert: Record<string, unknown>;
    try {
      expert = snapshotDataObject(rawExpert, ACTIVE_EXPERT_KEYS, budget);
    } catch (error: unknown) {
      if (error instanceof ActiveExpertValidationError) throw error;
      fail(code);
    }
    if (!Object.prototype.hasOwnProperty.call(expert, "id")
      || !Object.prototype.hasOwnProperty.call(expert, "reason")
      || !Object.prototype.hasOwnProperty.call(expert, "taskIds")
      || !validExpertId(expert.id, budget)
      || !validReason(expert.reason, budget)) {
      fail(code);
    }
    const idKey = collisionKey(expert.id);
    if (expertIds.has(idKey)) fail(code);
    expertIds.add(idKey);

    let rawTaskIds: readonly unknown[];
    try {
      rawTaskIds = snapshotDenseArray(
        expert.taskIds,
        budget,
        MIN_TASK_SEQUENCE_ITEM_BYTES,
      );
    } catch (error: unknown) {
      if (error instanceof ActiveExpertValidationError) throw error;
      fail(code);
    }
    if (rawTaskIds.length < 1) fail(code);
    chargeActualText(
      budget,
      `  - id: ${expert.id}\n    reason: ${JSON.stringify(expert.reason)}\n    taskIds:\n`,
    );
    const taskIds: string[] = [];
    const seenTaskIds = new Set<string>();
    for (const taskId of rawTaskIds) {
      if (!validTaskId(taskId, budget) || seenTaskIds.has(taskId)) fail(code);
      chargeActualText(budget, `      - ${taskId}\n`);
      seenTaskIds.add(taskId);
      taskIds.push(taskId);
    }
    taskIds.sort(portableCompare);
    experts.push({ id: expert.id, reason: expert.reason, taskIds });
  }
  experts.sort((left, right) => portableCompare(left.id, right.id));
  return { revision, experts };
}

function serializeActiveState(value: ActiveExperts): string {
  if (value.experts.length === 0) {
    return `revision: ${value.revision}\nexperts: []\n`;
  }
  const lines = [`revision: ${value.revision}`, "experts:"];
  for (const expert of value.experts) {
    lines.push(`  - id: ${expert.id}`);
    lines.push(`    reason: ${JSON.stringify(expert.reason)}`);
    lines.push("    taskIds:");
    for (const taskId of expert.taskIds) lines.push(`      - ${taskId}`);
  }
  return `${lines.join("\n")}\n`;
}

interface OpenFlagConstants {
  readonly O_RDONLY: number;
  readonly O_CLOEXEC?: number | undefined;
  readonly O_NOFOLLOW?: number | undefined;
}

/** Pure seam used to prove the Windows O_NOFOLLOW fallback. */
export function activeExpertOpenFlags(
  platform: NodeJS.Platform,
  values: OpenFlagConstants,
): number {
  let flags = values.O_RDONLY;
  if (typeof values.O_CLOEXEC === "number") flags |= values.O_CLOEXEC;
  if (platform !== "win32" && typeof values.O_NOFOLLOW === "number") flags |= values.O_NOFOLLOW;
  return flags;
}

function sameFileIdentity(left: Stats, right: Stats): boolean {
  return left.isFile()
    && right.isFile()
    && left.dev === right.dev
    && left.ino === right.ino
    && left.size === right.size
    && left.mtimeMs === right.mtimeMs
    && left.ctimeMs === right.ctimeMs;
}

async function readActiveFileBytes(path: string): Promise<Buffer | undefined> {
  let expected: Stats;
  try {
    expected = await lstat(path);
  } catch (error: unknown) {
    if (isMissing(error)) return undefined;
    fail("ACTIVE_EXPERT_FILE_INVALID");
  }
  if (!expected.isFile()
    || !Number.isSafeInteger(expected.size)
    || expected.size < 1
    || expected.size > ACTIVE_EXPERT_FILE_MAX_BYTES) {
    fail("ACTIVE_EXPERT_FILE_INVALID");
  }

  let handle: Awaited<ReturnType<typeof open>>;
  try {
    handle = await open(path, activeExpertOpenFlags(process.platform, constants));
  } catch (error: unknown) {
    const code = (error as NodeJS.ErrnoException).code;
    fail(code === "ENOENT" || code === "ELOOP"
      ? "ACTIVE_EXPERT_FILE_CHANGED"
      : "ACTIVE_EXPERT_FILE_INVALID");
  }

  let bytes: Buffer;
  let readFailure: unknown;
  try {
    bytes = await readBoundedFileHandle(handle, expected, ACTIVE_EXPERT_FILE_MAX_BYTES);
  } catch (error: unknown) {
    readFailure = error;
    bytes = Buffer.alloc(0);
  }
  try {
    await handle.close();
  } catch {
    if (readFailure === undefined) fail("ACTIVE_EXPERT_FILE_INVALID");
  }
  if (readFailure !== undefined) {
    if (readFailure instanceof BoundedFileReadError && readFailure.code === "BOUNDED_FILE_CHANGED") {
      fail("ACTIVE_EXPERT_FILE_CHANGED");
    }
    fail("ACTIVE_EXPERT_FILE_INVALID");
  }

  let after: Stats;
  try {
    after = await lstat(path);
  } catch {
    fail("ACTIVE_EXPERT_FILE_CHANGED");
  }
  if (!sameFileIdentity(expected, after)) fail("ACTIVE_EXPERT_FILE_CHANGED");
  return bytes;
}

interface YamlBudget {
  nodes: number;
}

function convertYamlNode(node: Node | null, depth: number, budget: YamlBudget): unknown {
  budget.nodes += 1;
  if (depth > MAX_YAML_DEPTH || budget.nodes > MAX_YAML_NODES || node === null) {
    fail("ACTIVE_EXPERT_FILE_INVALID");
  }
  if (isAlias(node) || node.tag !== undefined || ("anchor" in node && node.anchor !== undefined)) {
    fail("ACTIVE_EXPERT_FILE_INVALID");
  }
  if (isScalar(node)) {
    return node.value;
  }
  if (isSeq(node)) {
    if (node.items.length > ACTIVE_EXPERT_FILE_MAX_BYTES) fail("ACTIVE_EXPERT_FILE_INVALID");
    return node.items.map((item) => {
      if (item === null || !(isScalar(item) || isMap(item) || isSeq(item) || isAlias(item))) {
        fail("ACTIVE_EXPERT_FILE_INVALID");
      }
      return convertYamlNode(item, depth + 1, budget);
    });
  }
  if (isMap(node)) {
    if (node.items.length > ACTIVE_EXPERT_FILE_MAX_BYTES) fail("ACTIVE_EXPERT_FILE_INVALID");
    const result: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
    const keys = new Set<string>();
    for (const pair of node.items) {
      budget.nodes += 1;
      if (budget.nodes > MAX_YAML_NODES
        || !isScalar(pair.key)
        || typeof pair.key.value !== "string"
        || pair.key.tag !== undefined
        || pair.key.anchor !== undefined
        || PROTOTYPE_KEYS.has(pair.key.value)
        || keys.has(pair.key.value)
        || pair.value === null
        || !(isScalar(pair.value) || isMap(pair.value) || isSeq(pair.value) || isAlias(pair.value))) {
        fail("ACTIVE_EXPERT_FILE_INVALID");
      }
      keys.add(pair.key.value);
      Object.defineProperty(result, pair.key.value, {
        value: convertYamlNode(pair.value, depth + 1, budget),
        enumerable: true,
        writable: true,
        configurable: true,
      });
    }
    return result;
  }
  fail("ACTIVE_EXPERT_FILE_INVALID");
}

function parseActiveYaml(bytes: Buffer): ActiveExperts {
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    fail("ACTIVE_EXPERT_FILE_INVALID");
  }
  let source: string;
  try {
    source = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    fail("ACTIVE_EXPERT_FILE_INVALID");
  }
  if (source.length === 0 || /\r(?!\n)/u.test(source) || /^%/mu.test(source)) {
    fail("ACTIVE_EXPERT_FILE_INVALID");
  }

  try {
    const documents = parseAllDocuments(source, {
      strict: true,
      uniqueKeys: true,
      version: "1.2",
      schema: "core",
      merge: false,
    });
    if (documents.length !== 1) fail("ACTIVE_EXPERT_FILE_INVALID");
    const document = documents[0]!;
    if (document.errors.length !== 0
      || document.warnings.length !== 0
      || document.directives.docStart === true
      || document.directives.docEnd
      || document.directives.yaml.explicit === true) {
      fail("ACTIVE_EXPERT_FILE_INVALID");
    }
    return normalizeActiveState(
      convertYamlNode(document.contents, 0, { nodes: 0 }),
      "ACTIVE_EXPERT_FILE_INVALID",
    );
  } catch (error: unknown) {
    if (error instanceof ActiveExpertValidationError) throw error;
    fail("ACTIVE_EXPERT_FILE_INVALID");
  }
}

async function readProjection(paths: Readonly<WorkspacePaths>): Promise<ActiveExperts> {
  await validateExistingWorkspaceDirectoryChains(
    nodeWorkspaceDirectoryRuntime,
    paths.root,
    ["experts"],
  );
  const bytes = await readActiveFileBytes(join(paths.root, "experts", "active.yaml"));
  return bytes === undefined ? { revision: 0, experts: [] } : parseActiveYaml(bytes);
}

/**
 * Low-level store for only the structural expert selection projection. It can
 * create its own workspace boundaries below an existing real project root and
 * does not require a complete WorkspaceRepository initialization. Task 8's
 * workflow service is responsible for requiring full initialization and for
 * proving that referenced expert and task IDs exist.
 *
 * Boundary model: paths and identities are revalidated around reads and before
 * writes. As elsewhere in the local workspace core, a same-user process that
 * replaces directories after validation is outside the static threat model.
 */
export class ActiveExpertRepository {
  readonly projectRoot: string;

  constructor(projectRoot: string) {
    this.projectRoot = canonicalProjectRoot(projectRoot);
  }

  private get paths(): Readonly<WorkspacePaths> {
    return workspacePaths(this.projectRoot);
  }

  private get path(): string {
    return join(this.paths.root, "experts", "active.yaml");
  }

  async read(): Promise<ActiveExperts> {
    return readProjection(this.paths);
  }

  async write(next: ActiveExperts, expectedRevision: number): Promise<void> {
    const normalized = normalizeActiveState(next, "ACTIVE_EXPERT_INVALID_INPUT");
    const contents = serializeActiveState(normalized);
    if (!Number.isSafeInteger(expectedRevision)
      || expectedRevision < 0
      || expectedRevision === Number.MAX_SAFE_INTEGER) {
      fail("ACTIVE_EXPERT_REVISION_INVALID");
    }

    const paths = this.paths;
    // Validate existing boundaries before lock acquisition so a linked or
    // non-directory .ezagent/experts path cannot receive lock side effects.
    await validateExistingWorkspaceDirectoryChains(
      nodeWorkspaceDirectoryRuntime,
      paths.root,
      ["experts"],
    );
    const observed = await readProjection(paths);
    if (observed.revision !== expectedRevision) {
      throw new ActiveExpertConflictError(expectedRevision, observed.revision);
    }
    if (normalized.revision !== expectedRevision + 1) {
      fail("ACTIVE_EXPERT_REVISION_INVALID");
    }

    await withWorkspaceLock(this.projectRoot, async () => {
      const current = await readProjection(paths);
      if (current.revision !== expectedRevision) {
        throw new ActiveExpertConflictError(expectedRevision, current.revision);
      }
      // Creation is delayed until input validation and CAS both succeed.
      await ensureWorkspaceDirectoryChains(
        nodeWorkspaceDirectoryRuntime,
        paths.root,
        ["experts"],
      );
      await atomicWriteText(this.path, contents);
    });
  }
}
