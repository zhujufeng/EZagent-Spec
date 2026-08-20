import { types as nodeTypes } from "node:util";

import { z } from "zod";

import { unicodeDefaultCaseFold } from "../text/unicode-case-fold.js";
import { isWellFormedUnicode } from "../text/unicode.js";

const BASE_EXPERT_KEYS = [
  "id",
  "nameZh",
  "summaryZh",
  "instructionsZh",
  "capabilities",
  "domains",
  "projectSignals",
  "activationConditions",
  "exclusionConditions",
  "preferredTasks",
  "qualityGates",
  "origin",
  "source",
  "contentHash",
] as const;
const TRANSLATED_EXPERT_KEYS = [...BASE_EXPERT_KEYS, "upstreamSource"] as const;
const SOURCE_REF_KEYS = ["repository", "path", "commit", "license"] as const;
const RAW_LENGTH_PADDING = 256;
const LENGTH_LIMITS = {
  id: 160,
  nameZh: 128,
  summaryZh: 2_048,
  instructionsZh: 65_536,
  slug: 64,
  condition: 4_096,
  preferredTask: 16,
  origin: 32,
  contentHash: 71,
  repository: 2_048,
  path: 1_024,
  commit: 40,
  license: 3,
} as const;
const TOP_LEVEL_STRING_LIMITS = [
  ["id", LENGTH_LIMITS.id],
  ["nameZh", LENGTH_LIMITS.nameZh],
  ["summaryZh", LENGTH_LIMITS.summaryZh],
  ["instructionsZh", LENGTH_LIMITS.instructionsZh],
  ["origin", LENGTH_LIMITS.origin],
  ["contentHash", LENGTH_LIMITS.contentHash],
] as const;
const SOURCE_STRING_LIMITS = [
  ["repository", LENGTH_LIMITS.repository],
  ["path", LENGTH_LIMITS.path],
  ["commit", LENGTH_LIMITS.commit],
  ["license", LENGTH_LIMITS.license],
] as const;
const LIST_MAXIMUMS = {
  capabilities: 128,
  domains: 64,
  projectSignals: 128,
  activationConditions: 128,
  exclusionConditions: 128,
  preferredTasks: 5,
  qualityGates: 128,
} as const;
const LIST_LIMITS = [
  ["capabilities", LIST_MAXIMUMS.capabilities, LENGTH_LIMITS.slug],
  ["domains", LIST_MAXIMUMS.domains, LENGTH_LIMITS.slug],
  ["projectSignals", LIST_MAXIMUMS.projectSignals, LENGTH_LIMITS.slug],
  ["activationConditions", LIST_MAXIMUMS.activationConditions, LENGTH_LIMITS.condition],
  ["exclusionConditions", LIST_MAXIMUMS.exclusionConditions, LENGTH_LIMITS.condition],
  ["preferredTasks", LIST_MAXIMUMS.preferredTasks, LENGTH_LIMITS.preferredTask],
  ["qualityGates", LIST_MAXIMUMS.qualityGates, LENGTH_LIMITS.condition],
] as const;

const HAN_CHARACTER = /\p{Script=Han}/u;
const EXPERT_ID = /^ezagent\.[a-z0-9]+(?:-[a-z0-9]+)*(?:\.[a-z0-9]+(?:-[a-z0-9]+)*)*$/;
const PORTABLE_SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const FULL_COMMIT_SHA = /^[0-9a-f]{40}$/;
const CONTENT_HASH = /^sha256:[0-9a-f]{64}$/;
const NON_PORTABLE_PATH_CHARACTER = /[\u0000-\u001f\u007f<>:"\\|?*]/u;
const WINDOWS_RESERVED_BASENAME = /^(?:CON|PRN|AUX|NUL|CLOCK\$|CONIN\$|CONOUT\$|COM[1-9]|LPT[1-9])$/u;

export class ExpertValidationError extends Error {
  override readonly name = "ExpertValidationError";

  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
  }
}

function fail(message: string, cause?: unknown): never {
  throw new ExpertValidationError(`Invalid expert: ${message}`, cause === undefined ? undefined : { cause });
}

function snapshotDataObject(
  value: unknown,
  path: string,
  allowedKeys: readonly string[],
): Record<string, unknown> | undefined {
  if (value === null || typeof value !== "object") {
    return undefined;
  }
  if (nodeTypes.isProxy(value)) {
    fail(`${path} cannot be a Proxy`);
  }
  if (Array.isArray(value)) {
    return undefined;
  }

  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    fail(`${path} must be a plain object`);
  }

  const allowed = new Set(allowedKeys);
  const keys = Reflect.ownKeys(value);
  const snapshot: Record<string, unknown> = {};
  for (const key of keys) {
    if (typeof key !== "string") {
      fail(`${path} contains an unsupported symbol key`);
    }
    if (!allowed.has(key)) {
      fail(`${path}.${key} is unsupported`);
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || !descriptor.enumerable) {
      fail(`${path}.${key} must be an enumerable own data property`);
    }
    if (!("value" in descriptor)) {
      fail(`${path}.${key} cannot be an accessor property`);
    }
    snapshot[key] = descriptor.value;
  }
  return snapshot;
}

function assertRawStringLength(value: unknown, path: string, normalizedLimit: number): void {
  if (typeof value === "string" && value.length > normalizedLimit + RAW_LENGTH_PADDING) {
    fail(`${path} raw length exceeds ${normalizedLimit + RAW_LENGTH_PADDING}`);
  }
}

function validateArrayLength(value: unknown, path: string, maximumItems: number): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    fail(`${path}.length must be a non-negative safe integer`);
  }
  if (value > maximumItems) {
    fail(`${path} cannot contain more than ${maximumItems} items`);
  }
  return value;
}

function snapshotBoundedStringArray(
  value: unknown,
  path: string,
  maximumItems: number,
  maximumItemLength: number,
): unknown {
  if (!Array.isArray(value)) {
    if (nodeTypes.isProxy(value)) {
      fail(`${path} cannot be a Proxy`);
    }
    return value;
  }

  if (nodeTypes.isProxy(value)) {
    const length = validateArrayLength(value.length, path, maximumItems);
    fail(`${path} cannot snapshot a Proxy array of length ${length}`);
  }

  const lengthDescriptor = Object.getOwnPropertyDescriptor(value, "length");
  if (lengthDescriptor === undefined || !("value" in lengthDescriptor)) {
    fail(`${path}.length must be an own data property`);
  }
  const length = validateArrayLength(lengthDescriptor.value, path, maximumItems);

  for (const key of Reflect.ownKeys(value)) {
    if (key === "length") continue;
    if (typeof key !== "string" || !/^(0|[1-9]\d*)$/.test(key) || Number(key) >= length) {
      fail(`${path} contains an unsupported array key`);
    }
  }

  const snapshot: unknown[] = [];
  for (let index = 0; index < length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (descriptor === undefined) {
      fail(`${path} must be dense; index ${index} is missing`);
    }
    if (!descriptor.enumerable || !("value" in descriptor)) {
      fail(`${path}.${index} cannot be a non-enumerable or accessor property`);
    }
    assertRawStringLength(descriptor.value, `${path}.${index}`, maximumItemLength);
    snapshot.push(descriptor.value);
  }
  return snapshot;
}

function snapshotSource(value: unknown, path: string): unknown {
  const snapshot = snapshotDataObject(value, path, SOURCE_REF_KEYS);
  if (snapshot === undefined) {
    return value;
  }
  for (const [key, maximumLength] of SOURCE_STRING_LIMITS) {
    assertRawStringLength(snapshot[key], `${path}.${key}`, maximumLength);
  }
  return snapshot;
}

function snapshotExpertInput(value: unknown): unknown {
  if (nodeTypes.isProxy(value)) {
    fail("expert cannot be a Proxy");
  }
  const snapshot = snapshotDataObject(value, "expert", TRANSLATED_EXPERT_KEYS);
  if (snapshot === undefined) {
    return value;
  }
  for (const [key, maximumLength] of TOP_LEVEL_STRING_LIMITS) {
    assertRawStringLength(snapshot[key], `expert.${key}`, maximumLength);
  }
  if (Object.prototype.hasOwnProperty.call(snapshot, "source")) {
    snapshot.source = snapshotSource(snapshot.source, "expert.source");
  }
  if (Object.prototype.hasOwnProperty.call(snapshot, "upstreamSource")) {
    snapshot.upstreamSource = snapshotSource(snapshot.upstreamSource, "expert.upstreamSource");
  }
  for (const [key, maximumItems, maximumItemLength] of LIST_LIMITS) {
    if (Object.prototype.hasOwnProperty.call(snapshot, key)) {
      snapshot[key] = snapshotBoundedStringArray(
        snapshot[key],
        `expert.${key}`,
        maximumItems,
        maximumItemLength,
      );
    }
  }
  const origin = typeof snapshot.origin === "string" ? snapshot.origin.trim() : undefined;
  if (origin === "china_original") {
    if (Object.prototype.hasOwnProperty.call(snapshot, "upstreamSource")) {
      fail("expert.upstreamSource is unsupported for china_original");
    }
  }
  if (origin !== undefined) {
    snapshot.origin = origin;
  }
  return snapshot;
}

function boundedText(label: string, maxLength: number) {
  return z.string()
    .trim()
    .min(1, `${label} must not be blank`)
    .max(maxLength, `${label} is too long`)
    .refine(isWellFormedUnicode, `${label} must contain well-formed Unicode`);
}

function hanBearingText(label: string, maxLength: number) {
  return boundedText(label, maxLength)
    .refine(
      (value) => HAN_CHARACTER.test(value),
      `${label} must contain at least one Han character`,
    );
}

function collisionKey(value: string): string {
  return unicodeDefaultCaseFold(value);
}

function uniqueStringArray<T extends z.ZodType<string>>(
  itemSchema: T,
  label: string,
  minimum: number,
  maximum: number,
) {
  return z.array(itemSchema)
    .min(minimum, `${label} must contain at least ${minimum} item(s)`)
    .max(maximum, `${label} cannot contain more than ${maximum} items`)
    .superRefine((items, context) => {
      const seen = new Map<string, number>();
      for (const [index, item] of items.entries()) {
        const key = collisionKey(item);
        const firstIndex = seen.get(key);
        if (firstIndex !== undefined) {
          context.addIssue({
            code: "custom",
            path: [index],
            message: `${label} contains a duplicate of item ${firstIndex}`,
          });
        } else {
          seen.set(key, index);
        }
      }
    });
}

function isCanonicalHttpsRepository(value: string): boolean {
  try {
    if (value.includes("%")) {
      return false;
    }
    const url = new URL(value);
    if (
      url.protocol !== "https:" ||
      url.username !== "" ||
      url.password !== "" ||
      url.search !== "" ||
      url.hash !== "" ||
      url.hostname.endsWith(".") ||
      url.pathname === "/" ||
      url.pathname.endsWith("/") ||
      url.pathname.includes("//")
    ) {
      return false;
    }
    return url.href === value;
  } catch {
    return false;
  }
}

function isSafeMarkdownPath(value: string): boolean {
  if (
    value.length === 0 ||
    Buffer.byteLength(value, "utf8") > LENGTH_LIMITS.path ||
    value.normalize("NFC") !== value ||
    value.startsWith("/") ||
    value.includes("%") ||
    NON_PORTABLE_PATH_CHARACTER.test(value) ||
    !value.endsWith(".md")
  ) {
    return false;
  }

  const components = value.split("/");
  return components.every((component) => {
    const compatibilityForm = component.normalize("NFKC");
    const basename = compatibilityForm.split(".", 1)[0]!.toUpperCase();
    return (
      component !== "" &&
      component !== "." &&
      component !== ".." &&
      !compatibilityForm.endsWith(".") &&
      !compatibilityForm.endsWith(" ") &&
      !WINDOWS_RESERVED_BASENAME.test(basename) &&
      Buffer.byteLength(component, "utf8") <= 255
    );
  });
}

function asciiLowercase(value: string): string {
  return value.replace(/[A-Z]/g, (character) => character.toLowerCase());
}

function repositoryIdentity(repository: string): string {
  const url = new URL(repository);
  if (url.hostname === "github.com") {
    const components = url.pathname.slice(1).split("/");
    if (components.length === 2) {
      const owner = asciiLowercase(components[0]!);
      const repositoryName = asciiLowercase(components[1]!).replace(/\.git$/i, "");
      return `github:${owner}/${repositoryName}`;
    }
  }
  return repository;
}

const expertIdSchema = boundedText("expert.id", LENGTH_LIMITS.id)
  .regex(EXPERT_ID, "expert.id must use segmented lowercase portable slugs");
const slugSchema = boundedText("taxonomy slug", LENGTH_LIMITS.slug)
  .regex(PORTABLE_SLUG, "taxonomy slug must be lowercase and portable");
const conditionSchema = boundedText("condition", LENGTH_LIMITS.condition);
const preferredTaskSchema = z.string().trim().pipe(
  z.enum(["clarify", "design", "implement", "verify", "review"]),
);
const sourcePathSchema = z.string()
  .refine(isWellFormedUnicode, "source path must contain well-formed Unicode")
  .refine(
    (value) => !NON_PORTABLE_PATH_CHARACTER.test(value),
    "source path contains a non-portable character",
  )
  .transform((value) => value.trim())
  .pipe(
    z.string()
      .min(1, "source path must not be blank")
      .max(LENGTH_LIMITS.path, "source path is too long"),
  )
  .refine(isSafeMarkdownPath, "source path must be a safe POSIX-relative Markdown path");

const sourceRefSchema = z.object({
  repository: boundedText("repository", LENGTH_LIMITS.repository)
    .refine(isCanonicalHttpsRepository, "repository must be a canonical HTTPS URL"),
  path: sourcePathSchema,
  commit: boundedText("source commit", LENGTH_LIMITS.commit)
    .regex(FULL_COMMIT_SHA, "source commit must be a lowercase full 40-character SHA"),
  license: z.string().trim()
    .refine((value) => value === "MIT", "source license must be MIT")
    .transform((): "MIT" => "MIT"),
}).strict();

const sharedExpertShape = {
  id: expertIdSchema,
  nameZh: hanBearingText("nameZh", LENGTH_LIMITS.nameZh),
  summaryZh: hanBearingText("summaryZh", LENGTH_LIMITS.summaryZh),
  instructionsZh: hanBearingText("instructionsZh", LENGTH_LIMITS.instructionsZh),
  capabilities: uniqueStringArray(slugSchema, "capabilities", 1, LIST_MAXIMUMS.capabilities),
  domains: uniqueStringArray(slugSchema, "domains", 1, LIST_MAXIMUMS.domains),
  projectSignals: uniqueStringArray(slugSchema, "projectSignals", 0, LIST_MAXIMUMS.projectSignals),
  activationConditions: uniqueStringArray(
    conditionSchema,
    "activationConditions",
    1,
    LIST_MAXIMUMS.activationConditions,
  ),
  exclusionConditions: uniqueStringArray(
    conditionSchema,
    "exclusionConditions",
    0,
    LIST_MAXIMUMS.exclusionConditions,
  ),
  preferredTasks: uniqueStringArray(
    preferredTaskSchema,
    "preferredTasks",
    1,
    LIST_MAXIMUMS.preferredTasks,
  ),
  qualityGates: uniqueStringArray(
    conditionSchema,
    "qualityGates",
    1,
    LIST_MAXIMUMS.qualityGates,
  ),
  source: sourceRefSchema,
  contentHash: boundedText("contentHash", LENGTH_LIMITS.contentHash)
    .regex(CONTENT_HASH, "contentHash must be a lowercase SHA-256 digest"),
} as const;

const translatedExpertSchema = z.object({
  ...sharedExpertShape,
  origin: z.literal("upstream_translation"),
  upstreamSource: sourceRefSchema,
}).strict().superRefine((expert, context) => {
  if (
    repositoryIdentity(expert.source.repository) === repositoryIdentity(expert.upstreamSource.repository) &&
    expert.source.path.normalize("NFC") === expert.upstreamSource.path.normalize("NFC") &&
    expert.source.commit === expert.upstreamSource.commit
  ) {
    context.addIssue({
      code: "custom",
      path: ["upstreamSource"],
      message: "translated source and upstreamSource cannot identify the same source file revision",
    });
  }
});

const chinaOriginalExpertSchema = z.object({
  ...sharedExpertShape,
  origin: z.literal("china_original"),
}).strict();

const normalizedExpertSchema = z.discriminatedUnion("origin", [
  translatedExpertSchema,
  chinaOriginalExpertSchema,
]);

type ParsedExpert = z.infer<typeof normalizedExpertSchema>;
type ChinaOriginalExpert = Extract<ParsedExpert, { origin: "china_original" }> & {
  upstreamSource?: never;
};
export type Expert =
  | Extract<ParsedExpert, { origin: "upstream_translation" }>
  | ChinaOriginalExpert;
export type SourceRef = z.infer<typeof sourceRefSchema>;

function formatIssue(issue: z.core.$ZodIssue): string {
  const path = issue.path.length === 0
    ? "expert"
    : `expert.${issue.path.map(String).join(".")}`;
  return `${path}: ${issue.message}`;
}

function parseStrictExpert(value: unknown): Expert {
  const snapshot = snapshotExpertInput(value);
  const result = normalizedExpertSchema.safeParse(snapshot);
  if (!result.success) {
    fail(formatIssue(result.error.issues[0]!), result.error);
  }
  return result.data;
}

export interface ExpertSchema {
  parse(value: unknown): Expert;
}

export const expertSchema: Readonly<ExpertSchema> = Object.freeze({
  parse: parseStrictExpert,
});

export function parseExpert(value: unknown): Expert {
  return expertSchema.parse(value);
}
