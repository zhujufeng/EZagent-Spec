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

Copyright (c) 2025 Michael Sitarzewski

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

Copyright (c) 2025 Michael Sitarzewski
Copyright (c) 2026 jnMetaCode

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
  return {
    normalizedCatalogText: `${JSON.stringify({ schemaVersion: 1, experts: [expert] }, null, 2)}\n`,
    sourceLockText: `${JSON.stringify({
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
    }, null, 2)}\n`,
    taxonomyText: [
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
    ].join("\n"),
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
    expect(() => verifyCatalogProvenance(duplicateJson)).toThrowError(expect.objectContaining({ code: "CATALOG_INPUT_INVALID" }));

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
    expect(notice).toBe(EXPECTED_THIRD_PARTY_NOTICE);
    expect(english).toBe(ENGLISH_LICENSE);
    expect(chinese).toBe(CHINESE_LICENSE);
    const packageJson = JSON.parse(packageText) as { files: string[]; scripts: Record<string, string> };
    const files = packageJson.files;
    expect(files).toEqual(expect.arrayContaining([
      "dist/src/**/*.js",
      "THIRD_PARTY_NOTICES.md",
      "licenses/**",
      "catalog/normalized/experts.json",
    ]));
    expect(files).toEqual(expect.arrayContaining([
      "!dist/src/experts/source-lock.js",
      "!dist/src/experts/importer.js",
      "!dist/src/experts/attested-source-contract.js",
    ]));
    expect(runtimeSource).not.toMatch(/node:(?:fs|child_process|http|https|net|tls)|\.\/source-lock|\.\/importer|\bfetch\s*\(/u);
    expect(packageJson.scripts).toMatchObject({
      "catalog:lock": "node --import tsx scripts/lock-catalog-sources.ts",
      "catalog:import": "node --import tsx scripts/import-experts.ts",
      "catalog:verify": "node --import tsx scripts/verify-catalog.ts",
    });
  });
});
