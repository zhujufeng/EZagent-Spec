import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { z } from "zod";

import { unicodeDefaultCaseFold } from "../text/unicode-case-fold.js";
import { isWellFormedUnicode } from "../text/unicode.js";

export const PROJECT_CONTEXT_PATH = "knowledge/project.yaml";
export const PROJECT_CONTEXT_MAX_BYTES = 64 * 1024;

export interface ProjectTerm {
  readonly name: string;
  readonly meaning: string;
}

export interface ProjectSource {
  readonly path: string;
  readonly purpose: string;
}

export interface ProjectContext {
  readonly schemaVersion: 1;
  readonly summary: string;
  readonly terms: readonly ProjectTerm[];
  readonly constraints: readonly string[];
  readonly sources: readonly ProjectSource[];
}

const CONTROL = /[\u0000-\u001f\u007f]/u;
const WINDOWS_DEVICE = /^(?:con|prn|aux|nul|clock\$|conin\$|conout\$|com[1-9]|lpt[1-9])(?:\..*)?$/iu;
const RAW_PADDING = 256;
const MAX_ITEMS = 32;

function textSchema(label: string, maximum: number) {
  return z.string().max(maximum + RAW_PADDING)
    .transform((value) => value.trim().normalize("NFC"))
    .pipe(z.string()
      .min(1, `${label} must not be blank`)
      .max(maximum, `${label} is too long`)
      .refine(isWellFormedUnicode, `${label} must be well-formed Unicode`)
      .refine((value) => !CONTROL.test(value), `${label} contains control characters`));
}

function duplicateKey(value: string): string {
  return unicodeDefaultCaseFold(value.normalize("NFKC")).normalize("NFKC");
}

function uniqueTextList(label: string) {
  return z.array(textSchema(label, 4_096)).max(MAX_ITEMS).superRefine((values, context) => {
    const seen = new Set<string>();
    for (const [index, value] of values.entries()) {
      const key = duplicateKey(value);
      if (seen.has(key)) {
        context.addIssue({ code: "custom", path: [index], message: `${label} contains a duplicate` });
      }
      seen.add(key);
    }
  });
}

const portablePathSchema = textSchema("project source path", 1_024).superRefine((value, context) => {
  if (value.startsWith("/") || /^[A-Za-z]:/u.test(value) || value.includes("\\")) {
    context.addIssue({ code: "custom", message: "project source path must be portable and relative" });
    return;
  }
  const components = value.split("/");
  if (components.some((component) => component.length === 0
    || component === "."
    || component === ".."
    || component.endsWith(".")
    || component.endsWith(" ")
    || WINDOWS_DEVICE.test(component))) {
    context.addIssue({ code: "custom", message: "project source path contains an unsafe component" });
  }
});

const termSchema = z.object({
  name: textSchema("project term name", 256),
  meaning: textSchema("project term meaning", 4_096),
}).strict();

const sourceSchema = z.object({
  path: portablePathSchema,
  purpose: textSchema("project source purpose", 4_096),
}).strict();

const projectContextSchema = z.object({
  schemaVersion: z.literal(1),
  summary: textSchema("project summary", 4_096),
  terms: z.array(termSchema).max(MAX_ITEMS).superRefine((values, context) => {
    const seen = new Set<string>();
    for (const [index, term] of values.entries()) {
      const key = duplicateKey(term.name);
      if (seen.has(key)) {
        context.addIssue({ code: "custom", path: [index, "name"], message: "project terms contain a duplicate name" });
      }
      seen.add(key);
    }
  }),
  constraints: uniqueTextList("project constraints"),
  sources: z.array(sourceSchema).max(MAX_ITEMS).superRefine((values, context) => {
    const seen = new Set<string>();
    for (const [index, source] of values.entries()) {
      const key = duplicateKey(source.path);
      if (seen.has(key)) {
        context.addIssue({ code: "custom", path: [index, "path"], message: "project sources contain a duplicate path" });
      }
      seen.add(key);
    }
  }),
}).strict();

function freezeProjectContext(value: z.infer<typeof projectContextSchema>): ProjectContext {
  return Object.freeze({
    ...value,
    terms: Object.freeze(value.terms.map((term) => Object.freeze({ ...term }))),
    constraints: Object.freeze([...value.constraints]),
    sources: Object.freeze(value.sources.map((source) => Object.freeze({ ...source }))),
  });
}

function serializeParsedProjectContext(value: ProjectContext): string {
  return stringifyYaml(value, { lineWidth: 0 });
}

export function parseProjectContext(value: unknown): ProjectContext {
  const parsed = freezeProjectContext(projectContextSchema.parse(value));
  if (Buffer.byteLength(serializeParsedProjectContext(parsed), "utf8") > PROJECT_CONTEXT_MAX_BYTES) {
    throw new TypeError(`ProjectContext exceeds ${PROJECT_CONTEXT_MAX_BYTES} bytes`);
  }
  return parsed;
}

export function parseProjectContextYaml(contents: string): ProjectContext {
  if (typeof contents !== "string"
    || contents.length === 0
    || Buffer.byteLength(contents, "utf8") > PROJECT_CONTEXT_MAX_BYTES
    || contents.startsWith("\uFEFF")
    || contents.includes("\0")
    || !isWellFormedUnicode(contents)) {
    throw new TypeError("ProjectContext YAML must be bounded well-formed text");
  }
  return parseProjectContext(parseYaml(contents));
}

export function serializeProjectContext(value: ProjectContext): string {
  return serializeParsedProjectContext(parseProjectContext(value));
}
