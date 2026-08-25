import { createHash } from "node:crypto";
import { types as nodeTypes } from "node:util";

import { isWorkItemId } from "../../domain/id.js";
import { parseExpert, type Expert } from "../../experts/expert.js";
import { unicodeDefaultCaseFold } from "../../text/unicode-case-fold.js";
import { isWellFormedUnicode } from "../../text/unicode.js";
import { chargeByteBudget } from "./safe-fs.js";

export const MAX_PROJECT_AGENT_FILE_BYTES = 1_048_576;
const MAX_ASSIGNMENT_UTF8_BYTES = MAX_PROJECT_AGENT_FILE_BYTES;
export const MAX_PROJECT_AGENTS = 512;
const MAX_ASSIGNMENT_ITEMS = 128;
const MAX_TASK_ID_LENGTH = 64;
const MAX_TEXT_LENGTH = 4_096;
export const PROJECT_AGENT_FILE = /^ezagent-[a-z0-9]+(?:-[a-z0-9]+)*\.toml$/u;
export const PROJECT_AGENT_HASH = /^sha256:[0-9a-f]{64}$/u;
const ASSIGNMENT_KEYS = [
  "taskIds",
  "workSpecIds",
  "sliceIds",
  "delegationIds",
  "mode",
  "reason",
  "scope",
  "deliverables",
  "qualityGates",
  "evidenceRequirements",
] as const;
const RENDERED_KEYS = ["expertId", "fileName", "content", "sha256", "assignment"] as const;
const CONTROL = /\p{Cc}/u;

type ProjectAgentMode = "analysis" | "review" | "implement";

export interface ProjectAgentAssignment {
  readonly taskIds: readonly string[];
  readonly workSpecIds?: readonly string[];
  readonly sliceIds?: readonly string[];
  readonly delegationIds?: readonly string[];
  readonly mode: ProjectAgentMode;
  readonly reason: string;
  readonly scope?: readonly string[];
  readonly deliverables?: readonly string[];
  readonly qualityGates?: readonly string[];
  readonly evidenceRequirements?: readonly string[];
}

export interface NormalizedAssignment {
  readonly taskIds: readonly string[];
  readonly workSpecIds: readonly string[];
  readonly sliceIds: readonly string[];
  readonly delegationIds: readonly string[];
  readonly mode: ProjectAgentMode;
  readonly reason: string;
  readonly scope: readonly string[];
  readonly deliverables: readonly string[];
  readonly qualityGates: readonly string[];
  readonly evidenceRequirements: readonly string[];
}

export interface RenderedProjectAgent {
  readonly expertId: string;
  readonly fileName: string;
  readonly content: string;
  readonly sha256: `sha256:${string}`;
  readonly assignment: NormalizedAssignment;
}

export function projectAgentOwnDataObject(
  value: unknown,
  label: string,
  allowedKeys: readonly string[],
): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value) || nodeTypes.isProxy(value)) {
    throw new Error(`${label} must be a plain object and cannot be a Proxy`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new Error(`${label} must be a plain object`);
  }
  const allowed = new Set(allowedKeys);
  const result: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string" || !allowed.has(key)) throw new Error(`${label} contains an unsupported key`);
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || !descriptor.enumerable || !("value" in descriptor)) {
      throw new Error(`${label}.${key} must be an enumerable data property`);
    }
    result[key] = descriptor.value;
  }
  return result;
}

export function projectAgentDenseArray(
  value: unknown,
  label: string,
  maximum: number,
): readonly unknown[] {
  if (!Array.isArray(value) || nodeTypes.isProxy(value)) throw new Error(`${label} must be an array`);
  if (!Number.isSafeInteger(value.length) || value.length > maximum) throw new Error(`${label} is too large`);
  for (const key of Reflect.ownKeys(value)) {
    if (key === "length") continue;
    if (typeof key !== "string" || !/^(?:0|[1-9]\d*)$/u.test(key) || Number(key) >= value.length) {
      throw new Error(`${label} contains an unsupported array key`);
    }
  }
  const result: unknown[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (descriptor === undefined || !descriptor.enumerable || !("value" in descriptor)) {
      throw new Error(`${label} must be a dense data array`);
    }
    result.push(descriptor.value);
  }
  return result;
}

function boundedText(value: unknown, label: string): string {
  if (
    typeof value !== "string"
    || value.length === 0
    || value.length > MAX_TEXT_LENGTH
    || value.trim() !== value
    || value.normalize("NFC") !== value
    || !isWellFormedUnicode(value)
    || CONTROL.test(value)
  ) {
    throw new Error(`${label} must be bounded normalized text`);
  }
  return value;
}

function chargeAssignmentBytes(budget: { bytes: number }, value: string): void {
  chargeByteBudget(
    budget,
    Buffer.byteLength(value, "utf8"),
    MAX_ASSIGNMENT_UTF8_BYTES,
    "assignment aggregate UTF-8 byte budget exceeded",
  );
}

function textArray(
  value: unknown,
  label: string,
  defaults: readonly string[],
  budget: { bytes: number },
): readonly string[] {
  if (value === undefined) {
    for (const item of defaults) chargeAssignmentBytes(budget, item);
    return Object.freeze([...defaults]);
  }
  const raw = projectAgentDenseArray(value, label, MAX_ASSIGNMENT_ITEMS);
  if (raw.length === 0) throw new Error(`${label} cannot be empty`);
  const seen = new Set<string>();
  const result = raw.map((item, index) => {
    const text = boundedText(item, `${label}.${index}`);
    chargeAssignmentBytes(budget, text);
    const key = unicodeDefaultCaseFold(text);
    if (seen.has(key)) throw new Error(`${label} contains a duplicate`);
    seen.add(key);
    return text;
  });
  return Object.freeze(result);
}

function optionalTextArray(
  value: unknown,
  label: string,
  budget: { bytes: number },
): readonly string[] {
  if (value === undefined) return Object.freeze([]);
  const raw = projectAgentDenseArray(value, label, MAX_ASSIGNMENT_ITEMS);
  const seen = new Set<string>();
  const result = raw.map((item, index) => {
    const text = boundedText(item, `${label}.${index}`);
    chargeAssignmentBytes(budget, text);
    const key = unicodeDefaultCaseFold(text);
    if (seen.has(key)) throw new Error(`${label} contains a duplicate`);
    seen.add(key);
    return text;
  });
  return Object.freeze(result);
}

export function normalizeProjectAgentAssignment(value: unknown): NormalizedAssignment {
  const input = projectAgentOwnDataObject(value, "assignment", ASSIGNMENT_KEYS);
  const budget = { bytes: 0 };
  const rawTaskIds = projectAgentDenseArray(input.taskIds, "assignment.taskIds", MAX_ASSIGNMENT_ITEMS);
  if (rawTaskIds.length === 0) throw new Error("assignment.taskIds cannot be empty");
  const taskIds = rawTaskIds.map((value, index) => {
    if (
      typeof value !== "string"
      || value.length > MAX_TASK_ID_LENGTH
      || !value.startsWith("TASK-")
      || !isWorkItemId(value)
    ) {
      throw new Error(`assignment.taskIds.${index} is invalid`);
    }
    chargeAssignmentBytes(budget, value);
    return value;
  });
  if (new Set(taskIds).size !== taskIds.length) throw new Error("assignment.taskIds contains duplicates");
  const workSpecIds = optionalTextArray(input.workSpecIds, "assignment.workSpecIds", budget);
  if (workSpecIds.some((value) => !value.startsWith("SPEC-") || !isWorkItemId(value))) {
    throw new Error("assignment.workSpecIds contains an invalid Work Spec ID");
  }
  const identifier = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u;
  const sliceIds = optionalTextArray(input.sliceIds, "assignment.sliceIds", budget);
  if (sliceIds.some((value) => !identifier.test(value))) {
    throw new Error("assignment.sliceIds contains an invalid Slice ID");
  }
  const delegationIds = optionalTextArray(input.delegationIds, "assignment.delegationIds", budget);
  if (delegationIds.some((value) => !identifier.test(value))) {
    throw new Error("assignment.delegationIds contains an invalid Delegation ID");
  }
  if (input.mode !== "analysis" && input.mode !== "review" && input.mode !== "implement") {
    throw new Error("assignment.mode is invalid");
  }
  chargeAssignmentBytes(budget, input.mode);
  const reason = boundedText(input.reason, "assignment.reason");
  chargeAssignmentBytes(budget, reason);
  return Object.freeze({
    taskIds: Object.freeze([...taskIds].sort()),
    workSpecIds: Object.freeze([...workSpecIds].sort()),
    sliceIds: Object.freeze([...sliceIds].sort()),
    delegationIds: Object.freeze([...delegationIds].sort()),
    mode: input.mode,
    reason,
    scope: textArray(input.scope, "assignment.scope", ["仅限指定 Task IDs 与专家职责范围"], budget),
    deliverables: textArray(
      input.deliverables,
      "assignment.deliverables",
      ["按任务验收条件提交可核验结果"],
      budget,
    ),
    qualityGates: textArray(input.qualityGates, "assignment.qualityGates", ["满足项目质量门"], budget),
    evidenceRequirements: optionalTextArray(
      input.evidenceRequirements,
      "assignment.evidenceRequirements",
      budget,
    ),
  });
}

export function digestProjectAgent(bytes: Uint8Array | string): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

export function portableProjectAgentCompare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

class RenderByteBuilder {
  private readonly parts: string[] = [];
  private bytes = 0;

  append(value: string): void {
    const bytes = Buffer.byteLength(value, "utf8");
    if (bytes > MAX_PROJECT_AGENT_FILE_BYTES - this.bytes) {
      throw new Error("rendered project agent exceeds its UTF-8 byte limit");
    }
    this.bytes += bytes;
    this.parts.push(value);
  }

  finish(): string {
    return this.parts.join("");
  }
}

function escapeTomlBasicFragment(value: string): string {
  return value
    .replaceAll("\\", "\\\\")
    .replaceAll('"', '\\"')
    .replaceAll("\b", "\\b")
    .replaceAll("\t", "\\t")
    .replaceAll("\n", "\\n")
    .replaceAll("\f", "\\f")
    .replaceAll("\r", "\\r")
    .replace(/[\u0000-\u001f\u007f]/gu, (character) => (
      `\\u${character.codePointAt(0)!.toString(16).padStart(4, "0")}`
    ));
}

function appendTomlString(builder: RenderByteBuilder, value: string): void {
  builder.append('"');
  builder.append(escapeTomlBasicFragment(value));
  builder.append('"');
}

export function renderProjectAgent(
  expertValue: unknown,
  assignmentValue: ProjectAgentAssignment,
): RenderedProjectAgent {
  const expert: Expert = parseExpert(expertValue);
  const assignment = normalizeProjectAgentAssignment(assignmentValue);
  const slug = expert.id.slice("ezagent.".length).replaceAll(".", "-");
  const fileName = `ezagent-${slug}.toml`;
  if (!PROJECT_AGENT_FILE.test(fileName)) throw new Error("expert produced an invalid portable filename");
  const sandbox = assignment.mode === "implement" ? "workspace-write" : "read-only";
  const builder = new RenderByteBuilder();
  builder.append("name = ");
  appendTomlString(builder, expert.nameZh);
  builder.append("\ndescription = ");
  appendTomlString(builder, expert.summaryZh);
  builder.append("\nsandbox_mode = ");
  appendTomlString(builder, sandbox);
  builder.append('\ndeveloper_instructions = "');
  let paragraphCount = 0;
  const startParagraph = (): void => {
    if (paragraphCount > 0) builder.append("\\n\\n");
    paragraphCount += 1;
  };
  const appendParagraph = (value: string): void => {
    startParagraph();
    builder.append(escapeTomlBasicFragment(value));
  };
  const appendSection = (title: string, values: readonly string[]): void => {
    startParagraph();
    builder.append(escapeTomlBasicFragment(`${title}：`));
    for (const value of values) {
      builder.append("\\n- ");
      builder.append(escapeTomlBasicFragment(value));
    }
  };
  appendParagraph(`你是项目级专家「${expert.nameZh}」。`);
  appendParagraph(expert.summaryZh);
  appendParagraph(expert.instructionsZh);
  appendSection("绑定 Task IDs", assignment.taskIds);
  if (assignment.workSpecIds.length > 0) appendSection("绑定 Work Spec IDs", assignment.workSpecIds);
  if (assignment.sliceIds.length > 0) appendSection("绑定 Slice IDs", assignment.sliceIds);
  if (assignment.delegationIds.length > 0) appendSection("Delegation IDs", assignment.delegationIds);
  appendParagraph(`启用模式：${assignment.mode}`);
  appendParagraph(`选择原因：${assignment.reason}`);
  appendSection("工作范围", assignment.scope);
  appendSection("交付物", assignment.deliverables);
  appendSection("专家质量门", expert.qualityGates);
  appendSection("本次质量门", assignment.qualityGates);
  if (assignment.evidenceRequirements.length > 0) {
    appendSection("Evidence requirements", assignment.evidenceRequirements);
  }
  appendParagraph("只能在上述任务、范围与权限内工作；必须基于项目证据输出。不得自行推进 EZagent 状态，任何状态迁移只能由结构化工作流执行。");
  builder.append('"\n');
  const content = builder.finish();
  return Object.freeze({
    expertId: expert.id,
    fileName,
    content,
    sha256: digestProjectAgent(content),
    assignment,
  });
}

export function snapshotRenderedProjectAgents(value: unknown): readonly RenderedProjectAgent[] {
  const raw = projectAgentDenseArray(value, "rendered agents", MAX_PROJECT_AGENTS);
  const result: RenderedProjectAgent[] = [];
  const collisions = new Set<string>();
  for (const [index, item] of raw.entries()) {
    const input = projectAgentOwnDataObject(item, `rendered agents.${index}`, RENDERED_KEYS);
    if (typeof input.fileName !== "string") throw new Error("rendered agent filename is invalid");
    const folded = unicodeDefaultCaseFold(input.fileName);
    if (collisions.has(folded)) throw new Error("rendered agent filename has a portable case-fold collision");
    collisions.add(folded);
    if (!PROJECT_AGENT_FILE.test(input.fileName)) throw new Error("rendered agent filename is invalid and non-portable");
    if (typeof input.expertId !== "string" || !/^ezagent\.[a-z0-9.-]+$/u.test(input.expertId)) {
      throw new Error("rendered agent expertId is invalid");
    }
    if (
      typeof input.content !== "string"
      || Buffer.byteLength(input.content, "utf8") > MAX_PROJECT_AGENT_FILE_BYTES
      || !isWellFormedUnicode(input.content)
    ) {
      throw new Error("rendered agent content is invalid or too large");
    }
    if (
      typeof input.sha256 !== "string"
      || !PROJECT_AGENT_HASH.test(input.sha256)
      || digestProjectAgent(input.content) !== input.sha256
    ) {
      throw new Error("rendered agent hash does not match its content");
    }
    result.push(Object.freeze({
      expertId: input.expertId,
      fileName: input.fileName,
      content: input.content,
      sha256: input.sha256 as `sha256:${string}`,
      assignment: normalizeProjectAgentAssignment(input.assignment),
    }));
  }
  return Object.freeze(result.sort((left, right) => (
    portableProjectAgentCompare(left.fileName, right.fileName)
  )));
}
