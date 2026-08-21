import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import {
  CatalogValidationError,
  validateCatalog,
} from "../../src/experts/catalog.js";
import {
  createCatalogArtifactLock,
  serializeCatalogArtifactLock,
} from "../../src/experts/importer.js";
import {
  EXPECTED_THIRD_PARTY_NOTICE,
  main as verifyCatalogMain,
  readCatalogVerificationInputs,
  verifyCatalogProvenance,
  type CatalogVerificationInput,
} from "../../scripts/verify-catalog.js";

async function fixture(name: "translated" | "china-original"): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(
    new URL(`../fixtures/experts/${name}.json`, import.meta.url),
    "utf8",
  )) as Record<string, unknown>;
}

const NOTICES = new Set([
  "https://github.com/msitarzewski/agency-agents",
  "https://github.com/jnMetaCode/agency-agents-zh",
]);

const ENGLISH_LICENSE = `MIT License

Copyright (c) 2025 AgentLand Contributors

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
`;

const CHINESE_LICENSE = `MIT License

Copyright (c) 2025 Michael Sitarzewski (original English version)
Copyright (c) 2026 jnMetaCode (Chinese translation and localization)

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
`;

const REVIEWED_NOTICE = `# Third-Party Notices

EZagent Spec includes normalized expert definitions derived from the following MIT-licensed projects.

## Agency Agents

- Repository: https://github.com/msitarzewski/agency-agents
- Copyright: Copyright (c) 2025 AgentLand Contributors
- Included material: source taxonomy and English expert definitions used to trace translated records
- License: \`licenses/agency-agents-MIT.txt\`

## Agency Agents 中文项目

- Repository: https://github.com/jnMetaCode/agency-agents-zh
- Copyright: Copyright (c) 2025 Michael Sitarzewski (original English version); Copyright (c) 2026 jnMetaCode (Chinese translation and localization)
- Included material: Chinese expert translations and China-original expert definitions
- License: \`licenses/agency-agents-zh-MIT.txt\`

No orchestration scripts, service integrations, advertisements, or runtime update code from either project are included.
`;

function blobOid(bytes: Uint8Array): string {
  return createHash("sha1")
    .update(Buffer.from(`blob ${bytes.byteLength}\0`, "utf8"))
    .update(bytes)
    .digest("hex");
}

function licenseFile(text: string) {
  const bytes = Buffer.from(text, "utf8");
  return {
    path: "LICENSE",
    oid: blobOid(bytes),
    size: bytes.length,
    sha256: `sha256:${createHash("sha256").update(bytes).digest("hex")}`,
  };
}

function markdownFile(path: string, normalizedSha256: string) {
  return {
    path,
    oid: "a".repeat(40),
    size: 100,
    sha256: `sha256:${"b".repeat(64)}`,
    normalizedSize: 100,
    normalizedSha256,
  };
}

async function verificationFixture(): Promise<CatalogVerificationInput> {
  const expert = await fixture("translated");
  const normalizedCatalogText = `${JSON.stringify({ schemaVersion: 1, experts: [expert] }, null, 2)}\n`;
  const sourceLockText = `${JSON.stringify({
      schemaVersion: 2,
      sources: [
        {
          id: "agency-agents",
          repository: "https://github.com/msitarzewski/agency-agents",
          license: "MIT",
          commit: "2".repeat(40),
          tree: "3".repeat(40),
          objectFormat: "sha1",
          licenseFile: licenseFile(ENGLISH_LICENSE),
          markdown: [markdownFile(
            "engineering/frontend-architect.md",
            `sha256:${"c".repeat(64)}`,
          )],
        },
        {
          id: "agency-agents-zh",
          repository: "https://github.com/jnMetaCode/agency-agents-zh",
          license: "MIT",
          commit: "1".repeat(40),
          tree: "4".repeat(40),
          objectFormat: "sha1",
          licenseFile: licenseFile(CHINESE_LICENSE),
          markdown: [markdownFile(
            "engineering/frontend-architect.md",
            `sha256:${"a".repeat(64)}`,
          )],
        },
      ],
    }, null, 2)}\n`;
  const taxonomyText = [
      "schemaVersion: 1",
      "divisions:",
      "  engineering:",
      "    defaultDomains: [engineering]",
      "experts:",
      "  engineering/frontend-architect.md:",
      "    origin: upstream_translation",
      "    upstreamPath: engineering/frontend-architect.md",
      "    domains: [engineering, frontend]",
      "    capabilities: [frontend-architecture, state-design]",
      "    projectSignals: [react, vue, web-ui]",
      "    activationConditions: [跨组件行为变化]",
      "    exclusionConditions: [纯后端数据迁移]",
      "    preferredTasks: [design, review]",
      "    qualityGates: [引用实际文件, 覆盖错误状态]",
      "ignoredMarkdown:",
      "  agency-agents: []",
      "  agency-agents-zh: []",
      "",
    ].join("\n");
  return {
    normalizedCatalogText,
    sourceLockText,
    taxonomyText,
    catalogArtifactLockText: serializeCatalogArtifactLock(createCatalogArtifactLock({
      expertsJsonText: normalizedCatalogText,
      sourceLockJsonText: sourceLockText,
      taxonomyYamlText: taxonomyText,
      expertCount: 1,
    })),
    thirdPartyNoticeText: EXPECTED_THIRD_PARTY_NOTICE,
    licenseFiles: {
      "agency-agents": Buffer.from(ENGLISH_LICENSE, "utf8"),
      "agency-agents-zh": Buffer.from(CHINESE_LICENSE, "utf8"),
    },
  };
}

describe("validateCatalog", () => {
  it("snapshots, validates, freezes, and codepoint-sorts experts", async () => {
    const translated = await fixture("translated");
    const original = await fixture("china-original");
    const input = [translated, original];

    const result = validateCatalog(input, NOTICES);
    input.reverse();
    translated.id = "ezagent.changed";

    expect(result.map(({ id }) => id)).toEqual([
      "ezagent.china.private-domain-product-specialist",
      "ezagent.engineering.frontend-architect",
    ]);
    expect(Object.isFrozen(result)).toBe(true);
    expect(result[1]?.id).toBe("ezagent.engineering.frontend-architect");
  });

  it("requires notices for both Chinese and English provenance", async () => {
    const translated = await fixture("translated");

    expect(() => validateCatalog([translated], new Set([
      "https://github.com/jnMetaCode/agency-agents-zh",
    ]))).toThrowError(expect.objectContaining({
      name: "CatalogValidationError",
      code: "MISSING_LICENSE_NOTICE",
    }));
  });

  it("rejects duplicate ids, source identities, and canonical source collisions", async () => {
    const translated = await fixture("translated");
    const duplicateId = structuredClone(translated);
    expect(() => validateCatalog([translated, duplicateId], NOTICES))
      .toThrowError(expect.objectContaining({ code: "DUPLICATE_EXPERT_ID" }));

    const duplicateSource = structuredClone(translated);
    duplicateSource.id = "ezagent.engineering.other-architect";
    expect(() => validateCatalog([translated, duplicateSource], NOTICES))
      .toThrowError(expect.objectContaining({ code: "DUPLICATE_SOURCE_IDENTITY" }));

    const canonicalCollision = structuredClone(translated);
    canonicalCollision.id = "ezagent.engineering.case-collision";
    (canonicalCollision.source as { path: string }).path = "engineering/FRONTEND-ARCHITECT.md";
    (canonicalCollision.upstreamSource as { path: string }).path = "engineering/other.md";
    expect(() => validateCatalog([translated, canonicalCollision], NOTICES))
      .toThrowError(expect.objectContaining({ code: "CANONICAL_SOURCE_COLLISION" }));
  });

  it("allows distinct Chinese records to share one reviewed upstream source", async () => {
    const translated = await fixture("translated");
    const legacyTranslation = structuredClone(translated);
    legacyTranslation.id = "ezagent.engineering.legacy-security-engineer";
    (legacyTranslation.source as { path: string }).path = "engineering/legacy-security-engineer.md";

    const catalog = validateCatalog([translated, legacyTranslation], NOTICES);
    expect(catalog).toHaveLength(2);
    const first = catalog[0]!;
    const second = catalog[1]!;
    expect(first.source.path).not.toBe(second.source.path);
    expect(first.origin).toBe("upstream_translation");
    expect(second.origin).toBe("upstream_translation");
    if (first.origin !== "upstream_translation" || second.origin !== "upstream_translation") {
      throw new Error("fixture must remain translated");
    }
    expect(first.upstreamSource.path).toBe(second.upstreamSource.path);
  });

  it("fails closed before traversing Proxy, accessor, sparse, extra, prototype, or huge arrays", async () => {
    const translated = await fixture("translated");
    const proxy = new Proxy([translated], {
      ownKeys: () => { throw new Error("SECRET PROXY TRAP"); },
    });
    expect(() => validateCatalog(proxy, NOTICES)).toThrowError(expect.objectContaining({
      code: "CATALOG_INPUT_INVALID",
      message: expect.not.stringContaining("SECRET"),
    }));

    const accessor = [translated];
    Object.defineProperty(accessor, "0", { enumerable: true, get: () => translated });
    expect(() => validateCatalog(accessor, NOTICES)).toThrowError(expect.objectContaining({ code: "CATALOG_INPUT_INVALID" }));

    const sparse = new Array(1);
    expect(() => validateCatalog(sparse, NOTICES)).toThrowError(expect.objectContaining({ code: "CATALOG_INPUT_INVALID" }));

    const extra = [translated] as unknown[] & { extra?: boolean };
    extra.extra = true;
    expect(() => validateCatalog(extra, NOTICES)).toThrowError(expect.objectContaining({ code: "CATALOG_INPUT_INVALID" }));

    const inherited = [translated];
    Object.setPrototypeOf(inherited, Object.create(Array.prototype));
    expect(() => validateCatalog(inherited, NOTICES)).toThrowError(expect.objectContaining({ code: "CATALOG_INPUT_INVALID" }));

    const huge = [] as unknown[];
    Object.defineProperty(huge, "length", { value: 4_097 });
    expect(() => validateCatalog(huge, NOTICES)).toThrowError(expect.objectContaining({ code: "CATALOG_INPUT_INVALID" }));
  });

  it("uses stable catalog errors without leaking arbitrary expert validator detail", async () => {
    const translated = await fixture("translated");
    translated.instructionsZh = "not Chinese";

    let captured: unknown;
    try {
      validateCatalog([translated], NOTICES);
    } catch (error: unknown) {
      captured = error;
    }
    expect(captured).toSatisfy((error: unknown) =>
      error instanceof CatalogValidationError
        && error.code === "EXPERT_INVALID"
        && !error.message.includes("instructionsZh")
        && error.cause === undefined);
  });

  it("rejects a non-ordinary or oversized notice registry", async () => {
    const translated = await fixture("translated");
    expect(() => validateCatalog([translated], new Proxy(NOTICES, {})))
      .toThrowError(expect.objectContaining({ code: "NOTICE_REGISTRY_INVALID" }));
    expect(() => validateCatalog([translated], new Set(Array.from(
      { length: 65 },
      (_, index) => `https://example.invalid/${index}`,
    )))).toThrowError(expect.objectContaining({ code: "NOTICE_REGISTRY_INVALID" }));

    const forgedSet = Object.create(Set.prototype) as Set<string>;
    let captured: unknown;
    try {
      validateCatalog([translated], forgedSet);
    } catch (error: unknown) {
      captured = error;
    }
    expect(captured).toSatisfy((error: unknown) =>
      error instanceof CatalogValidationError
        && error.code === "NOTICE_REGISTRY_INVALID"
        && error.cause === undefined
        && !/incompatible|receiver|Set/u.test(error.message));
  });
});

describe("verifyCatalogProvenance", () => {
  it("cross-verifies the snapshot, lock, taxonomy, notices, and exact license bytes", async () => {
    const report = verifyCatalogProvenance(await verificationFixture());
    expect(report).toEqual({
      expertCount: 1,
      provenanceErrors: [],
      message: "catalog valid: 1 experts, 0 provenance errors",
    });
  });

  it.each(["nameZh", "summaryZh", "instructionsZh"] as const)(
    "rejects %s-only snapshot tampering before trusting parsed provenance",
    async (field) => {
      const input = await verificationFixture();
      const parsed = JSON.parse(input.normalizedCatalogText) as { experts: Array<Record<string, string>> };
      parsed.experts[0]![field] += "篡改";
      input.normalizedCatalogText = `${JSON.stringify(parsed, null, 2)}\n`;
      expect(() => verifyCatalogProvenance(input)).toThrowError(expect.objectContaining({
        code: "CATALOG_PROVENANCE_INVALID",
        groups: expect.objectContaining({ artifacts: expect.any(Array) }),
      }));
    },
  );

  it.each([
    ["English tree", (input: CatalogVerificationInput) => {
      input.sourceLockText = input.sourceLockText.replace("3".repeat(40), "6".repeat(40));
    }],
    ["Chinese manifest field", (input: CatalogVerificationInput) => {
      input.sourceLockText = input.sourceLockText.replace(`sha256:${"a".repeat(64)}`, `sha256:${"e".repeat(64)}`);
    }],
    ["license evidence", (input: CatalogVerificationInput) => {
      input.sourceLockText = input.sourceLockText.replace(licenseFile(ENGLISH_LICENSE).oid, "7".repeat(40));
    }],
    ["taxonomy bytes", (input: CatalogVerificationInput) => {
      input.taxonomyText += "# changed\n";
    }],
  ] as const)("rejects %s tampering through the independent artifact attestation", async (_name, mutate) => {
    const input = await verificationFixture();
    mutate(input);
    expect(() => verifyCatalogProvenance(input)).toThrowError(expect.objectContaining({
      code: "CATALOG_PROVENANCE_INVALID",
      groups: expect.objectContaining({ artifacts: expect.any(Array) }),
    }));
  });

  it.each([
    ["content hash", (input: CatalogVerificationInput) => {
      input.normalizedCatalogText = input.normalizedCatalogText.replace(`sha256:${"a".repeat(64)}`, `sha256:${"d".repeat(64)}`);
    }],
    ["source commit", (input: CatalogVerificationInput) => {
      input.normalizedCatalogText = input.normalizedCatalogText.replace("1".repeat(40), "5".repeat(40));
    }],
    ["source path", (input: CatalogVerificationInput) => {
      input.normalizedCatalogText = input.normalizedCatalogText.replaceAll("engineering/frontend-architect.md", "engineering/missing.md");
    }],
    ["taxonomy origin", (input: CatalogVerificationInput) => {
      input.taxonomyText = input.taxonomyText.replace("origin: upstream_translation", "origin: china_original").replace("    upstreamPath: engineering/frontend-architect.md\n", "");
    }],
    ["taxonomy metadata", (input: CatalogVerificationInput) => {
      input.taxonomyText = input.taxonomyText.replace("frontend-architecture, state-design", "frontend-architecture");
    }],
    ["license bytes", (input: CatalogVerificationInput) => {
      input.licenseFiles["agency-agents"] = Buffer.from(`${ENGLISH_LICENSE}changed\n`, "utf8");
    }],
    ["license hash", (input: CatalogVerificationInput) => {
      input.sourceLockText = input.sourceLockText.replace(
        licenseFile(ENGLISH_LICENSE).sha256,
        `sha256:${"f".repeat(64)}`,
      );
    }],
    ["missing notice", (input: CatalogVerificationInput) => {
      input.thirdPartyNoticeText = input.thirdPartyNoticeText.replace(
        "https://github.com/msitarzewski/agency-agents",
        "https://example.invalid/missing",
      );
    }],
    ["duplicate notice mapping", (input: CatalogVerificationInput) => {
      input.thirdPartyNoticeText += "\n- License: `licenses/agency-agents-MIT.txt`\n";
    }],
  ] as const)("rejects a %s mismatch with grouped actionable diagnostics", async (_name, mutate) => {
    const input = await verificationFixture();
    mutate(input);
    expect(() => verifyCatalogProvenance(input)).toThrowError(expect.objectContaining({
      name: "CatalogVerificationError",
      code: "CATALOG_PROVENANCE_INVALID",
      groups: expect.any(Object),
    }));
  });

  it("rejects unsorted, duplicate, wrong-count, and malformed normalized JSON", async () => {
    const valid = await verificationFixture();
    const parsed = JSON.parse(valid.normalizedCatalogText) as { experts: Array<Record<string, unknown>> };
    const second = structuredClone(parsed.experts[0]!);
    second.id = "ezagent.aaa.first";
    (second.source as { path: string }).path = "engineering/second.md";
    (second.upstreamSource as { path: string }).path = "engineering/second.md";
    parsed.experts.push(second);
    const unsorted = { ...valid, normalizedCatalogText: JSON.stringify(parsed) };
    expect(() => verifyCatalogProvenance(unsorted)).toThrowError(expect.objectContaining({ code: "CATALOG_PROVENANCE_INVALID" }));

    const duplicateJson = { ...valid, normalizedCatalogText: '{"schemaVersion":1,"schemaVersion":1,"experts":[]}' };
    expect(() => verifyCatalogProvenance(duplicateJson)).toThrowError(expect.objectContaining({
      code: "CATALOG_PROVENANCE_INVALID",
      groups: expect.objectContaining({ artifacts: expect.any(Array) }),
    }));

    const oversized = { ...valid, normalizedCatalogText: " ".repeat(16 * 1_048_576 + 1) };
    expect(() => verifyCatalogProvenance(oversized)).toThrowError(expect.objectContaining({ code: "CATALOG_INPUT_INVALID" }));
  });

  it("rejects Proxy and accessor verification inputs before reading their values", async () => {
    const valid = await verificationFixture();
    const proxy = new Proxy(valid, { ownKeys: () => { throw new Error("SECRET INPUT TRAP"); } });
    expect(() => verifyCatalogProvenance(proxy)).toThrowError(expect.objectContaining({
      code: "CATALOG_INPUT_INVALID",
      message: expect.not.stringContaining("SECRET"),
    }));
    const accessor = { ...valid } as unknown as Record<string, unknown>;
    Object.defineProperty(accessor, "normalizedCatalogText", { enumerable: true, get: () => valid.normalizedCatalogText });
    expect(() => verifyCatalogProvenance(accessor as unknown as CatalogVerificationInput))
      .toThrowError(expect.objectContaining({ code: "CATALOG_INPUT_INVALID" }));

    const forgedBytes = Object.create(Uint8Array.prototype) as Uint8Array;
    const forgedInput = {
      ...valid,
      licenseFiles: { ...valid.licenseFiles, "agency-agents": forgedBytes },
    };
    let captured: unknown;
    try {
      verifyCatalogProvenance(forgedInput);
    } catch (error: unknown) {
      captured = error;
    }
    expect(captured).toSatisfy((error: unknown) =>
      error instanceof Error
        && error.name === "CatalogVerificationError"
        && (error as Error & { code?: string }).code === "CATALOG_INPUT_INVALID"
        && error.cause === undefined
        && !/incompatible|receiver|typed array/u.test(error.message));

    const proxyBytes = new Proxy(Buffer.from(ENGLISH_LICENSE, "utf8"), {});
    expect(() => verifyCatalogProvenance({
      ...valid,
      licenseFiles: { ...valid.licenseFiles, "agency-agents": proxyBytes },
    })).toThrowError(expect.objectContaining({ code: "CATALOG_INPUT_INVALID" }));
  });
});

describe("verify-catalog command boundary", () => {
  it("is import-safe and contains no Git, vendor, or network capability", async () => {
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const source = await readFile(new URL("../../scripts/verify-catalog.ts", import.meta.url), "utf8");
    expect(source).not.toMatch(/node:(?:child_process|http|https|net|tls)|\bfetch\s*\(|vendor-sources/u);
    const moduleUrl = new URL("../../scripts/verify-catalog.ts", import.meta.url);
    moduleUrl.searchParams.set("safe-import", randomUUID());
    const imported = await import(moduleUrl.href);
    expect(imported.main).toBeTypeOf("function");
    expect(stdout).not.toHaveBeenCalled();
    expect(stderr).not.toHaveBeenCalled();
  });

  it("prints the precise success line and gives actionable missing-snapshot advice", async () => {
    const valid = await verificationFixture();
    const stdout: string[] = [];
    const stderr: string[] = [];
    expect(await verifyCatalogMain({ projectRoot: "/fixed/project" }, {
      readInputs: async () => valid,
      writeStdout: (message) => stdout.push(message),
      writeStderr: (message) => stderr.push(message),
    })).toBe(0);
    expect(stdout).toEqual(["catalog valid: 1 experts, 0 provenance errors\n"]);
    expect(stderr).toEqual([]);

    expect(await verifyCatalogMain({ projectRoot: "/fixed/project" }, {
      readInputs: async () => { throw Object.assign(new Error("secret path"), { code: "ENOENT" }); },
      writeStdout: () => undefined,
      writeStderr: (message) => stderr.push(message),
    })).toBe(1);
    expect(stderr.at(-1)).toContain("run catalog:lock and catalog:import first");
    expect(stderr.at(-1)).not.toContain("secret path");
  });

  it("reads only fixed bounded real files and refuses a symlinked checked-in input", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "ezagent-catalog-verify-")));
    const outside = await mkdtemp(join(tmpdir(), "ezagent-catalog-outside-"));
    try {
      const input = await verificationFixture();
      await mkdir(join(root, "catalog", "normalized"), { recursive: true });
      await mkdir(join(root, "licenses"));
      await writeFile(join(root, "catalog", "normalized", "experts.json"), input.normalizedCatalogText);
      await writeFile(join(root, "catalog", "normalized", "catalog.lock.json"), input.catalogArtifactLockText);
      await writeFile(join(root, "catalog", "sources.lock.json"), input.sourceLockText);
      await writeFile(join(root, "catalog", "taxonomy.yaml"), input.taxonomyText);
      await writeFile(join(root, "THIRD_PARTY_NOTICES.md"), input.thirdPartyNoticeText);
      await writeFile(join(root, "licenses", "agency-agents-MIT.txt"), input.licenseFiles["agency-agents"]);
      await writeFile(join(root, "licenses", "agency-agents-zh-MIT.txt"), input.licenseFiles["agency-agents-zh"]);

      await expect(readCatalogVerificationInputs(root)).resolves.toMatchObject({
        normalizedCatalogText: input.normalizedCatalogText,
        thirdPartyNoticeText: input.thirdPartyNoticeText,
      });

      await writeFile(join(outside, "notice.md"), input.thirdPartyNoticeText);
      await rm(join(root, "THIRD_PARTY_NOTICES.md"));
      await symlink(join(outside, "notice.md"), join(root, "THIRD_PARTY_NOTICES.md"));
      await expect(readCatalogVerificationInputs(root)).rejects.toThrow("safely");
    } finally {
      await Promise.all([
        rm(root, { recursive: true, force: true }),
        rm(outside, { recursive: true, force: true }),
      ]);
    }
  });

  it("checks in exact reviewed notice/license text and packages only the runtime catalog boundary", async () => {
    const [notice, english, chinese, packageText, runtimeSource] = await Promise.all([
      readFile(new URL("../../THIRD_PARTY_NOTICES.md", import.meta.url), "utf8"),
      readFile(new URL("../../licenses/agency-agents-MIT.txt", import.meta.url), "utf8"),
      readFile(new URL("../../licenses/agency-agents-zh-MIT.txt", import.meta.url), "utf8"),
      readFile(new URL("../../package.json", import.meta.url), "utf8"),
      readFile(new URL("../../src/experts/catalog.ts", import.meta.url), "utf8"),
    ]);
    expect(EXPECTED_THIRD_PARTY_NOTICE).toBe(REVIEWED_NOTICE);
    expect(notice).toBe(REVIEWED_NOTICE);
    expect(english).toBe(ENGLISH_LICENSE);
    expect(chinese).toBe(CHINESE_LICENSE);
    expect(Buffer.byteLength(english, "utf8")).toBe(1_079);
    expect(createHash("sha256").update(english, "utf8").digest("hex"))
      .toBe("9a45258434d5cedf0af73c9ad4771373701225038d246c49219026c33677f66f");
    expect(Buffer.byteLength(chinese, "utf8")).toBe(1_172);
    expect(createHash("sha256").update(chinese, "utf8").digest("hex"))
      .toBe("ef7c745c2d79e873d6553fc35c92ecbcf43804a1f1fd1aa47e23d0da2afb1b63");
    const packageJson = JSON.parse(packageText) as { files: string[]; scripts: Record<string, string> };
    const files = packageJson.files;
    expect(files).toEqual(expect.arrayContaining([
      "dist/src/**/*.js",
      "THIRD_PARTY_NOTICES.md",
      "licenses/**",
      "catalog/normalized/experts.json",
      "catalog/normalized/catalog.lock.json",
    ]));
    expect(files).toEqual(expect.arrayContaining([
      "!dist/src/experts/source-lock.js",
      "!dist/src/experts/importer.js",
      "!dist/src/experts/attested-source-contract.js",
    ]));
    expect(files).not.toContain("!dist/src/experts/bounded-read.js");
    expect(runtimeSource).not.toMatch(/node:(?:fs|child_process|http|https|net|tls)|\.\/source-lock|\.\/importer|\bfetch\s*\(/u);
    expect(packageJson.scripts).toMatchObject({
      "catalog:lock": "node --import tsx scripts/lock-catalog-sources.ts",
      "catalog:import": "node --import tsx scripts/import-experts.ts",
      "catalog:verify": "node --import tsx scripts/verify-catalog.ts",
      prepack: "npm run catalog:verify && npm run build",
      prepublishOnly: "npm run catalog:verify && npm run build",
    });
  });
});
