import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { z } from "zod";

import { isWorkItemId } from "../domain/id.js";
import type { WorkItemStatus } from "../domain/work-item.js";
import { unicodeDefaultCaseFold } from "../text/unicode-case-fold.js";
import { isWellFormedUnicode } from "../text/unicode.js";

export type PlanRisk = "light" | "standard" | "high";

export interface PlanDraft {
  readonly schemaVersion: 1;
  readonly requirement: { readonly title: string; readonly summary: string };
  readonly spec: {
    readonly goal: string;
    readonly scope: readonly string[];
    readonly nonGoals: readonly string[];
    readonly acceptance: readonly string[];
    readonly verification: readonly string[];
  };
  readonly task: {
    readonly title: string;
    readonly risk: PlanRisk;
    readonly allowedPaths: readonly string[];
    readonly deliverables: readonly string[];
    readonly qualityGates: readonly string[];
  };
  readonly selection: {
    readonly capabilities: readonly string[];
    readonly domains: readonly string[];
    readonly projectSignals: readonly string[];
    readonly reviewAfter: number;
  };
}

export interface RequirementArtifact {
  readonly schemaVersion: 1;
  readonly id: string;
  readonly status: "specified";
  readonly revision: number;
  readonly title: string;
  readonly summary: string;
}

export interface SpecArtifact {
  readonly schemaVersion: 1;
  readonly id: string;
  readonly requirementId: string;
  readonly status: "approved";
  readonly revision: number;
  readonly goal: string;
  readonly scope: readonly string[];
  readonly nonGoals: readonly string[];
  readonly acceptance: readonly string[];
  readonly verification: readonly string[];
}

export interface TaskArtifact {
  readonly schemaVersion: 1;
  readonly id: string;
  readonly requirementId: string;
  readonly specId: string;
  readonly status: WorkItemStatus;
  readonly revision: number;
  readonly title: string;
  readonly risk: PlanRisk;
  readonly allowedPaths: readonly string[];
  readonly deliverables: readonly string[];
  readonly qualityGates: readonly string[];
}

const RAW_PADDING = 256;
const PORTABLE_TOKEN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;
const CONTROL = /[\u0000-\u001f\u007f]/u;
const WINDOWS_DEVICE = /^(?:con|prn|aux|nul|clock\$|conin\$|conout\$|com[1-9]|lpt[1-9])(?:\..*)?$/iu;
const STATUSES = [
  "captured", "clarifying", "specified", "approved", "planned", "implementing",
  "verifying", "completed", "cancelled",
] as const;

function textSchema(label: string, maximum: number) {
  return z.string().max(maximum + RAW_PADDING)
    .transform((value) => value.trim().normalize("NFC"))
    .pipe(z.string()
      .min(1, `${label} must not be blank`)
      .max(maximum, `${label} is too long`)
      .refine(isWellFormedUnicode, `${label} must be well-formed Unicode`)
      .refine((value) => !CONTROL.test(value), `${label} contains control characters`));
}

function uniqueList<T extends z.ZodType<string>>(item: T, label: string, maximum = 64) {
  return z.array(item).min(1).max(maximum).superRefine((values, context) => {
    const seen = new Set<string>();
    for (const [index, value] of values.entries()) {
      const key = unicodeDefaultCaseFold(value.normalize("NFKC")).normalize("NFKC");
      if (seen.has(key)) {
        context.addIssue({ code: "custom", path: [index], message: `${label} contains a duplicate` });
      }
      seen.add(key);
    }
  });
}

const tokenSchema = z.string().min(1).max(64).regex(PORTABLE_TOKEN);

const allowedPathSchema = z.string().min(1).max(1_024).superRefine((value, context) => {
  if (value !== value.normalize("NFC")
    || value.startsWith("/")
    || /^[A-Za-z]:/u.test(value)
    || value.includes("\\")
    || CONTROL.test(value)) {
    context.addIssue({ code: "custom", message: "allowed path must be a portable relative glob" });
    return;
  }
  const components = value.split("/");
  if (components.some((component) => component.length === 0
    || component === "."
    || component === ".."
    || component.endsWith(".")
    || component.endsWith(" ")
    || WINDOWS_DEVICE.test(component.replace(/[?*{}[\]]/gu, "")))) {
    context.addIssue({ code: "custom", message: "allowed path contains an unsafe component" });
  }
});

const textList = (label: string) => uniqueList(textSchema(label, 4_096), label);
const tokenList = (label: string) => uniqueList(tokenSchema, label, 512);

const planDraftSchema = z.object({
  schemaVersion: z.literal(1),
  requirement: z.object({
    title: textSchema("requirement title", 256),
    summary: textSchema("requirement summary", 4_096),
  }).strict(),
  spec: z.object({
    goal: textSchema("spec goal", 4_096),
    scope: textList("spec scope"),
    nonGoals: textList("spec non-goals"),
    acceptance: textList("spec acceptance"),
    verification: textList("spec verification"),
  }).strict(),
  task: z.object({
    title: textSchema("task title", 256),
    risk: z.enum(["light", "standard", "high"]),
    allowedPaths: uniqueList(allowedPathSchema, "allowed paths"),
    deliverables: textList("task deliverables"),
    qualityGates: textList("task quality gates"),
  }).strict(),
  selection: z.object({
    capabilities: tokenList("selection capabilities"),
    domains: tokenList("selection domains"),
    projectSignals: tokenList("selection project signals"),
    reviewAfter: z.number().int().nonnegative().max(4_096),
  }).strict(),
}).strict();

function workItemId(prefix: "REQ" | "SPEC" | "TASK") {
  return z.string().refine(
    (value) => value.startsWith(`${prefix}-`) && isWorkItemId(value),
    `invalid ${prefix} ID`,
  );
}

const requirementArtifactSchema = z.object({
  schemaVersion: z.literal(1),
  id: workItemId("REQ"),
  status: z.literal("specified"),
  revision: z.number().int().nonnegative(),
  title: textSchema("requirement title", 256),
  summary: textSchema("requirement summary", 4_096),
}).strict();

const specArtifactSchema = z.object({
  schemaVersion: z.literal(1),
  id: workItemId("SPEC"),
  requirementId: workItemId("REQ"),
  status: z.literal("approved"),
  revision: z.number().int().nonnegative(),
  goal: textSchema("spec goal", 4_096),
  scope: textList("spec scope"),
  nonGoals: textList("spec non-goals"),
  acceptance: textList("spec acceptance"),
  verification: textList("spec verification"),
}).strict();

const taskArtifactSchema = z.object({
  schemaVersion: z.literal(1),
  id: workItemId("TASK"),
  requirementId: workItemId("REQ"),
  specId: workItemId("SPEC"),
  status: z.enum(STATUSES),
  revision: z.number().int().nonnegative(),
  title: textSchema("task title", 256),
  risk: z.enum(["light", "standard", "high"]),
  allowedPaths: uniqueList(allowedPathSchema, "allowed paths"),
  deliverables: textList("task deliverables"),
  qualityGates: textList("task quality gates"),
}).strict();

function freezeList(values: readonly string[]): readonly string[] {
  return Object.freeze([...values]);
}

function freezePlan(value: z.infer<typeof planDraftSchema>): PlanDraft {
  return Object.freeze({
    ...value,
    requirement: Object.freeze({ ...value.requirement }),
    spec: Object.freeze({
      ...value.spec,
      scope: freezeList(value.spec.scope),
      nonGoals: freezeList(value.spec.nonGoals),
      acceptance: freezeList(value.spec.acceptance),
      verification: freezeList(value.spec.verification),
    }),
    task: Object.freeze({
      ...value.task,
      allowedPaths: freezeList(value.task.allowedPaths),
      deliverables: freezeList(value.task.deliverables),
      qualityGates: freezeList(value.task.qualityGates),
    }),
    selection: Object.freeze({
      ...value.selection,
      capabilities: freezeList(value.selection.capabilities),
      domains: freezeList(value.selection.domains),
      projectSignals: freezeList(value.selection.projectSignals),
    }),
  });
}

export function parsePlanDraft(value: unknown): PlanDraft {
  return freezePlan(planDraftSchema.parse(value));
}

export function parseRequirementArtifact(value: unknown): RequirementArtifact {
  return Object.freeze(requirementArtifactSchema.parse(value));
}

export function parseSpecArtifact(value: unknown): SpecArtifact {
  const parsed = specArtifactSchema.parse(value);
  return Object.freeze({
    ...parsed,
    scope: freezeList(parsed.scope),
    nonGoals: freezeList(parsed.nonGoals),
    acceptance: freezeList(parsed.acceptance),
    verification: freezeList(parsed.verification),
  });
}

export function parseTaskArtifact(value: unknown): TaskArtifact {
  const parsed = taskArtifactSchema.parse(value);
  return Object.freeze({
    ...parsed,
    allowedPaths: freezeList(parsed.allowedPaths),
    deliverables: freezeList(parsed.deliverables),
    qualityGates: freezeList(parsed.qualityGates),
  });
}

function yamlValue(text: string): unknown {
  if (typeof text !== "string" || text.length === 0 || text.length > 1_048_576) {
    throw new TypeError("artifact YAML must be bounded non-empty text");
  }
  return parseYaml(text);
}

export const parseRequirementArtifactYaml = (text: string): RequirementArtifact => (
  parseRequirementArtifact(yamlValue(text))
);
export const parseSpecArtifactYaml = (text: string): SpecArtifact => parseSpecArtifact(yamlValue(text));
export const parseTaskArtifactYaml = (text: string): TaskArtifact => parseTaskArtifact(yamlValue(text));

function serializeYaml(value: unknown): string {
  return stringifyYaml(value, { lineWidth: 0 });
}

export const serializeRequirementArtifact = (value: RequirementArtifact): string => (
  serializeYaml(parseRequirementArtifact(value))
);
export const serializeSpecArtifact = (value: SpecArtifact): string => serializeYaml(parseSpecArtifact(value));
export const serializeTaskArtifact = (value: TaskArtifact): string => serializeYaml(parseTaskArtifact(value));
