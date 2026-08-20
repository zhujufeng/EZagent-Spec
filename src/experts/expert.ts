import { z } from "zod";

import { isWellFormedUnicode } from "../text/unicode.js";

const EXPERT_KEYS = [
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
  "upstreamSource",
  "contentHash",
] as const;
const SOURCE_REF_KEYS = ["repository", "path", "commit", "license"] as const;
const LIST_KEYS = [
  "capabilities",
  "domains",
  "projectSignals",
  "activationConditions",
  "exclusionConditions",
  "preferredTasks",
  "qualityGates",
] as const;

const HAN_CHARACTER = /\p{Script=Han}/u;
const EXPERT_ID = /^ezagent\.[a-z0-9]+(?:-[a-z0-9]+)*(?:\.[a-z0-9]+(?:-[a-z0-9]+)*)*$/;
const PORTABLE_SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const FULL_COMMIT_SHA = /^[0-9a-f]{40}$/;
const CONTENT_HASH = /^sha256:[0-9a-f]{64}$/;

export class ExpertValidationError extends Error {
  override readonly name = "ExpertValidationError";

  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
  }
}

function fail(message: string, cause?: unknown): never {
  throw new ExpertValidationError(`Invalid expert: ${message}`, cause === undefined ? undefined : { cause });
}

function assertExactPlainObject(
  value: unknown,
  path: string,
  allowedKeys: readonly string[],
): void {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return;
  }

  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    fail(`${path} must be a plain object`);
  }

  const allowed = new Set(allowedKeys);
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string") {
      fail(`${path} contains an unsupported symbol key`);
    }
    if (!allowed.has(key)) {
      fail(`${path}.${key} is unsupported`);
    }
  }
}

function assertDenseArray(value: unknown, path: string): void {
  if (!Array.isArray(value)) {
    return;
  }

  for (let index = 0; index < value.length; index += 1) {
    if (!Object.prototype.hasOwnProperty.call(value, index)) {
      fail(`${path} must be dense; index ${index} is missing`);
    }
  }

  for (const key of Reflect.ownKeys(value)) {
    if (key === "length") continue;
    if (typeof key !== "string" || !/^(0|[1-9]\d*)$/.test(key) || Number(key) >= value.length) {
      fail(`${path} contains an unsupported array key`);
    }
  }
}

function assertInputShape(value: unknown): void {
  assertExactPlainObject(value, "expert", EXPERT_KEYS);
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return;
  }

  const record = value as Record<string, unknown>;
  assertExactPlainObject(record.source, "expert.source", SOURCE_REF_KEYS);
  assertExactPlainObject(record.upstreamSource, "expert.upstreamSource", SOURCE_REF_KEYS);
  for (const key of LIST_KEYS) {
    assertDenseArray(record[key], `expert.${key}`);
  }
}

function boundedText(label: string, maxLength: number) {
  return z.string()
    .trim()
    .min(1, `${label} must not be blank`)
    .max(maxLength, `${label} is too long`)
    .refine(isWellFormedUnicode, `${label} must contain well-formed Unicode`);
}

function localizedText(label: string, maxLength: number) {
  return boundedText(label, maxLength)
    .refine((value) => HAN_CHARACTER.test(value), `${label} must contain Chinese text`);
}

function collisionKey(value: string): string {
  return value.normalize("NFKC").toLowerCase();
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
    const url = new URL(value);
    if (
      url.protocol !== "https:" ||
      url.username !== "" ||
      url.password !== "" ||
      url.search !== "" ||
      url.hash !== "" ||
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
    Buffer.byteLength(value, "utf8") > 1_024 ||
    value.startsWith("/") ||
    value.includes("\\") ||
    value.includes("\0") ||
    !value.endsWith(".md")
  ) {
    return false;
  }

  const components = value.split("/");
  return components.every((component) => (
    component !== "" &&
    component !== "." &&
    component !== ".." &&
    Buffer.byteLength(component, "utf8") <= 255
  ));
}

const expertIdSchema = boundedText("expert.id", 160)
  .regex(EXPERT_ID, "expert.id must use segmented lowercase portable slugs");
const slugSchema = boundedText("taxonomy slug", 64)
  .regex(PORTABLE_SLUG, "taxonomy slug must be lowercase and portable");
const conditionSchema = boundedText("condition", 4_096);
const preferredTaskSchema = z.string().trim().pipe(
  z.enum(["clarify", "design", "implement", "verify", "review"]),
);

const sourceRefSchema = z.object({
  repository: boundedText("repository", 2_048)
    .refine(isCanonicalHttpsRepository, "repository must be a canonical HTTPS URL"),
  path: boundedText("source path", 1_024)
    .refine(isSafeMarkdownPath, "source path must be a safe POSIX-relative Markdown path"),
  commit: boundedText("source commit", 40)
    .regex(FULL_COMMIT_SHA, "source commit must be a lowercase full 40-character SHA"),
  license: z.string().trim()
    .refine((value) => value === "MIT", "source license must be MIT")
    .transform((): "MIT" => "MIT"),
}).strict();

export const expertSchema = z.object({
  id: expertIdSchema,
  nameZh: localizedText("nameZh", 128),
  summaryZh: localizedText("summaryZh", 2_048),
  instructionsZh: localizedText("instructionsZh", 65_536),
  capabilities: uniqueStringArray(slugSchema, "capabilities", 1, 128),
  domains: uniqueStringArray(slugSchema, "domains", 1, 64),
  projectSignals: uniqueStringArray(slugSchema, "projectSignals", 0, 128),
  activationConditions: uniqueStringArray(conditionSchema, "activationConditions", 1, 128),
  exclusionConditions: uniqueStringArray(conditionSchema, "exclusionConditions", 0, 128),
  preferredTasks: uniqueStringArray(preferredTaskSchema, "preferredTasks", 1, 5),
  qualityGates: uniqueStringArray(conditionSchema, "qualityGates", 1, 128),
  origin: z.string().trim().pipe(z.enum(["upstream_translation", "china_original"])),
  source: sourceRefSchema,
  upstreamSource: sourceRefSchema.optional(),
  contentHash: boundedText("contentHash", 71)
    .regex(CONTENT_HASH, "contentHash must be a lowercase SHA-256 digest"),
}).strict().superRefine((expert, context) => {
  if (expert.origin === "upstream_translation" && expert.upstreamSource === undefined) {
    context.addIssue({
      code: "custom",
      path: ["upstreamSource"],
      message: "translated experts require upstreamSource",
    });
  }
  if (expert.origin === "china_original" && expert.upstreamSource !== undefined) {
    context.addIssue({
      code: "custom",
      path: ["upstreamSource"],
      message: "China-original experts cannot declare upstreamSource",
    });
  }
  if (
    expert.origin === "upstream_translation" &&
    expert.upstreamSource !== undefined &&
    expert.source.repository === expert.upstreamSource.repository
  ) {
    context.addIssue({
      code: "custom",
      path: ["upstreamSource", "repository"],
      message: "translated source and upstreamSource must use different repositories",
    });
  }
});

export type Expert = z.infer<typeof expertSchema>;
export type SourceRef = z.infer<typeof sourceRefSchema>;

function formatIssue(issue: z.core.$ZodIssue): string {
  const path = issue.path.length === 0
    ? "expert"
    : `expert.${issue.path.map(String).join(".")}`;
  return `${path}: ${issue.message}`;
}

export function parseExpert(value: unknown): Expert {
  assertInputShape(value);
  const result = expertSchema.safeParse(value);
  if (!result.success) {
    fail(formatIssue(result.error.issues[0]!), result.error);
  }
  return result.data;
}
