import { readFile } from "node:fs/promises";

import { beforeAll, describe, expect, test } from "vitest";

import { parseExpert, type Expert } from "../../src/experts/expert.js";

type MutableExpert = Record<string, unknown> & {
  id: string;
  nameZh: string;
  summaryZh: string;
  instructionsZh: string;
  capabilities: string[];
  domains: string[];
  projectSignals: string[];
  activationConditions: string[];
  exclusionConditions: string[];
  preferredTasks: string[];
  qualityGates: string[];
  origin: string;
  source: Record<string, unknown>;
  upstreamSource?: Record<string, unknown>;
  contentHash: string;
};

async function loadFixture(name: "translated" | "china-original"): Promise<MutableExpert> {
  const text = await readFile(new URL(`../fixtures/experts/${name}.json`, import.meta.url), "utf8");
  return JSON.parse(text) as MutableExpert;
}

function clone(value: MutableExpert): MutableExpert {
  return structuredClone(value);
}

describe("normalized expert schema", () => {
  let translated: MutableExpert;
  let chinaOriginal: MutableExpert;

  beforeAll(async () => {
    translated = await loadFixture("translated");
    chinaOriginal = await loadFixture("china-original");
  });

  test.each(["translated", "china-original"] as const)("accepts the %s fixture", async (name) => {
    const fixture = await loadFixture(name);
    expect(parseExpert(fixture).id).toMatch(/^ezagent\./);
  });

  test("returns normalized strings without mutating the input", () => {
    const input = clone(translated);
    input.id = `  ${input.id}  `;
    input.nameZh = `  ${input.nameZh}  `;
    input.summaryZh = `  ${input.summaryZh}  `;
    input.instructionsZh = `  ${input.instructionsZh}  `;
    input.capabilities[0] = `  ${input.capabilities[0]}  `;
    input.activationConditions[0] = `  ${input.activationConditions[0]}  `;
    input.source.repository = `  ${String(input.source.repository)}  `;
    input.source.path = `  ${String(input.source.path)}  `;
    input.source.commit = `  ${String(input.source.commit)}  `;
    input.source.license = "  MIT  ";
    const original = structuredClone(input);

    const parsed = parseExpert(input);

    expect(input).toEqual(original);
    expect(parsed.id).toBe(translated.id);
    expect(parsed.nameZh).toBe(translated.nameZh);
    expect(parsed.capabilities[0]).toBe(translated.capabilities[0]);
    expect(parsed.activationConditions[0]).toBe(translated.activationConditions[0]);
    expect(parsed.source).toEqual(translated.source);
    expect(parsed).not.toBe(input);
  });

  test("requires complete immutable provenance", () => {
    const missingCommit = clone(translated);
    delete missingCommit.source.commit;
    expect(() => parseExpert(missingCommit)).toThrow(/source\.commit/i);

    const shortCommit = clone(translated);
    shortCommit.source.commit = "abc123";
    expect(() => parseExpert(shortCommit)).toThrow(/source\.commit/i);

    const uppercaseCommit = clone(translated);
    uppercaseCommit.source.commit = "A".repeat(40);
    expect(() => parseExpert(uppercaseCommit)).toThrow(/source\.commit/i);

    const wrongLicense = clone(translated);
    wrongLicense.source.license = "Apache-2.0";
    expect(() => parseExpert(wrongLicense)).toThrow(/source\.license/i);
  });

  test("enforces the origin and upstream-source relationship", () => {
    const translationWithoutUpstream = clone(translated);
    delete translationWithoutUpstream.upstreamSource;
    expect(() => parseExpert(translationWithoutUpstream)).toThrow(/upstreamSource/);

    const originalWithUpstream = clone(chinaOriginal);
    originalWithUpstream.upstreamSource = clone(translated).upstreamSource!;
    expect(() => parseExpert(originalWithUpstream)).toThrow(/upstreamSource/);

    const sameRepository = clone(translated);
    sameRepository.upstreamSource!.repository = sameRepository.source.repository;
    expect(() => parseExpert(sameRepository)).toThrow(/repository/i);
  });

  test("rejects unknown and prototype keys at every object boundary", () => {
    const topLevelUnknown = clone(translated);
    topLevelUnknown.extra = true;
    expect(() => parseExpert(topLevelUnknown)).toThrow(/extra/);

    const sourceUnknown = clone(translated);
    sourceUnknown.source.extra = true;
    expect(() => parseExpert(sourceUnknown)).toThrow(/source\.extra/);

    const topLevelProto = JSON.parse(JSON.stringify(translated).replace(/}$/, ',"__proto__":true}')) as unknown;
    expect(() => parseExpert(topLevelProto)).toThrow(/__proto__/);

    const sourceProto = clone(translated);
    sourceProto.source = JSON.parse(`${JSON.stringify(sourceProto.source).slice(0, -1)},"__proto__":true}`) as Record<string, unknown>;
    expect(() => parseExpert(sourceProto)).toThrow(/source\.__proto__/);

    const pollutedPrototype = clone(translated);
    Object.setPrototypeOf(pollutedPrototype.source, { polluted: true });
    expect(() => parseExpert(pollutedPrototype)).toThrow(/source/i);
  });

  test.each([
    "http://github.com/jnMetaCode/agency-agents-zh",
    "https://user:secret@github.com/jnMetaCode/agency-agents-zh",
    "https://github.com/jnMetaCode/agency-agents-zh?ref=main",
    "https://github.com/jnMetaCode/agency-agents-zh#readme",
    "https://github.com/jnMetaCode/agency-agents-zh/",
    "https://GitHub.com/jnMetaCode/agency-agents-zh",
  ])("rejects non-canonical repository URL %s", (repository) => {
    const input = clone(translated);
    input.source.repository = repository;
    expect(() => parseExpert(input)).toThrow(/source\.repository/i);
  });

  test.each([
    "/engineering/frontend.md",
    "../engineering/frontend.md",
    "engineering/../frontend.md",
    "engineering/./frontend.md",
    "engineering\\frontend.md",
    "engineering/frontend.txt",
    "engineering//frontend.md",
    "engineering/frontend.md\0ignored",
    `engineering/bad\ud800.md`,
  ])("rejects unsafe source path %s", (path) => {
    const input = clone(translated);
    input.source.path = path;
    expect(() => parseExpert(input)).toThrow(/source\.path/i);
  });

  test("rejects duplicate and sparse list values", () => {
    const duplicateSlug = clone(translated);
    duplicateSlug.capabilities.push(duplicateSlug.capabilities[0]!);
    expect(() => parseExpert(duplicateSlug)).toThrow(/capabilities/i);

    const duplicateCondition = clone(translated);
    duplicateCondition.qualityGates = ["Review", " review "];
    expect(() => parseExpert(duplicateCondition)).toThrow(/qualityGates/i);

    const duplicateTask = clone(translated);
    duplicateTask.preferredTasks.push("review");
    expect(() => parseExpert(duplicateTask)).toThrow(/preferredTasks/i);

    const sparse = clone(translated);
    sparse.capabilities = new Array<string>(2);
    sparse.capabilities[1] = "frontend-architecture";
    expect(() => parseExpert(sparse)).toThrow(/capabilities/i);
  });

  test("requires Chinese content in the three core localized fields", () => {
    for (const field of ["nameZh", "summaryZh", "instructionsZh"] as const) {
      const input = clone(translated);
      input[field] = "English only";
      expect(() => parseExpert(input)).toThrow(new RegExp(field, "i"));
    }
  });

  test("rejects blank, malformed, and unreasonably large text", () => {
    const blankCondition = clone(translated);
    blankCondition.activationConditions = ["   "];
    expect(() => parseExpert(blankCondition)).toThrow(/activationConditions/i);

    const malformed = clone(translated);
    malformed.summaryZh = "错误\ud800文本";
    expect(() => parseExpert(malformed)).toThrow(/summaryZh/i);

    const oversizedInstructions = clone(translated);
    oversizedInstructions.instructionsZh = `中${"a".repeat(65_536)}`;
    expect(() => parseExpert(oversizedInstructions)).toThrow(/instructionsZh/i);
  });

  test.each([
    "ezagent.",
    "ezagent..architect",
    "ezagent.Engineering.architect",
    "ezagent.engineering.-architect",
    "ezagent.engineering.architect-",
    "ezagent.engineering.frontend_architect",
    "other.engineering.architect",
  ])("rejects invalid expert ID %s", (id) => {
    const input = clone(translated);
    input.id = id;
    expect(() => parseExpert(input)).toThrow(/expert\.id/i);
  });

  test.each(["Frontend", "front_end", "frontend.architecture", "中文"])(
    "rejects non-portable taxonomy slug %s",
    (slug) => {
      const input = clone(translated);
      input.domains = [slug];
      expect(() => parseExpert(input)).toThrow(/domains/i);
    },
  );

  test.each([
    "sha256:abc",
    `sha256:${"A".repeat(64)}`,
    `sha512:${"a".repeat(64)}`,
    `sha256:${"g".repeat(64)}`,
  ])("rejects invalid content hash %s", (contentHash) => {
    const input = clone(translated);
    input.contentHash = contentHash;
    expect(() => parseExpert(input)).toThrow(/contentHash/i);
  });

  test("requires non-empty activation conditions and quality gates", () => {
    for (const field of ["activationConditions", "qualityGates"] as const) {
      const input = clone(translated);
      input[field] = [];
      expect(() => parseExpert(input)).toThrow(new RegExp(field, "i"));
    }
  });

  test("exposes a stable readable validation error", () => {
    let error: unknown;
    try {
      parseExpert({ id: "ezagent.bad" });
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(Error);
    expect(error).toMatchObject({ name: "ExpertValidationError" });
    expect((error as Error).message).toMatch(/^Invalid expert: /);
  });

  test("returns the public Expert contract", () => {
    const expert: Expert = parseExpert(translated);
    expect(expert.origin).toBe("upstream_translation");
  });
});
