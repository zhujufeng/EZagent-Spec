import { createHash } from "node:crypto";
import { lstat, mkdir, mkdtemp, readFile, readdir, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi, type TestContext } from "vitest";

import {
  importExpertCatalog,
  indexMarkdownFiles,
  nodeMarkdownIndexRuntime,
  normalizeExpertFile,
  parseSourceLockJson,
  parseTaxonomyYaml,
  readBoundedTextFile,
  serializeNormalizedCatalog,
  writeNormalizedCatalog,
  type MarkdownManifestEntry,
  type SourceBase,
  type TaxonomyMeta,
} from "../../src/experts/importer.js";

const roots: string[] = [];
const REPOSITORIES = {
  english: "https://github.com/msitarzewski/agency-agents",
  chinese: "https://github.com/jnMetaCode/agency-agents-zh",
} as const;
const COMMITS = { english: "2".repeat(40), chinese: "1".repeat(40) } as const;
const translatedTaxonomy: TaxonomyMeta = {
  origin: "upstream_translation",
  upstreamPath: "engineering/engineering-frontend-developer.md",
  domains: ["engineering", "frontend"],
  capabilities: ["frontend-architecture"],
  projectSignals: ["react"],
  activationConditions: ["跨组件行为变化"],
  exclusionConditions: ["纯后端数据迁移"],
  preferredTasks: ["design", "review"],
  qualityGates: ["引用实际文件", "覆盖错误状态"],
};
const chineseMarkdown = "\uFEFF---\r\nname: 前端开发工程师\r\ndescription: 负责前端结构。\r\nemoji: \"🖥️\"\r\ncolor: blue\r\n---\r\n# 前端开发工程师\r\n\r\n分析组件边界。\r\n";

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "ezagent-importer-"));
  roots.push(root);
  return root;
}

async function symlinkOrSkip(context: TestContext, target: string, path: string, type: "file" | "dir"): Promise<void> {
  try {
    await symlink(target, path, type);
  } catch (error: unknown) {
    const code = (error as NodeJS.ErrnoException).code;
    if (process.platform === "win32" && code && ["EACCES", "ENOSYS", "ENOTSUP", "EPERM"].includes(code)) {
      context.skip(`Windows symbolic links unavailable: ${code}`);
    }
    throw error;
  }
}

function blobOid(bytes: Buffer): string {
  return createHash("sha1").update(Buffer.from(`blob ${bytes.length}\0`)).update(bytes).digest("hex");
}

function normalizedMarkdownBytes(bytes: Buffer): Buffer {
  let text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  if (text.startsWith("\uFEFF")) text = text.slice(1);
  text = text.replace(/\r\n/gu, "\n");
  return Buffer.from(text, "utf8");
}

async function markdownManifest(root: string): Promise<readonly MarkdownManifestEntry[]> {
  const result: MarkdownManifestEntry[] = [];
  async function visit(directory: string, prefix: string): Promise<void> {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
      const absolute = join(directory, entry.name);
      if (entry.isDirectory()) await visit(absolute, path);
      else if (entry.isFile() && entry.name.endsWith(".md")) {
        const bytes = await readFile(absolute);
        const normalized = normalizedMarkdownBytes(bytes);
        result.push({
          path,
          oid: blobOid(bytes),
          size: bytes.length,
          sha256: `sha256:${createHash("sha256").update(bytes).digest("hex")}`,
          normalizedSize: normalized.length,
          normalizedSha256: `sha256:${createHash("sha256").update(normalized).digest("hex")}`,
        });
      }
    }
  }
  await visit(root, "");
  return result.sort((left, right) => Buffer.compare(Buffer.from(left.path), Buffer.from(right.path)));
}

async function lockedSource(root: string, kind: keyof typeof COMMITS): Promise<SourceBase> {
  return {
    repository: REPOSITORIES[kind],
    commit: COMMITS[kind],
    license: "MIT",
    tree: (kind === "english" ? "a" : "b").repeat(40),
    objectFormat: "sha1",
    markdown: await markdownManifest(root),
  };
}

async function fixtureInputs() {
  const projectRoot = join(import.meta.dirname, "..", "fixtures", "source-repos");
  const englishRoot = join(projectRoot, "agency-agents");
  const chineseRoot = join(projectRoot, "agency-agents-zh");
  const [english, chinese, taxonomyText] = await Promise.all([
    lockedSource(englishRoot, "english"),
    lockedSource(chineseRoot, "chinese"),
    readFile(new URL("../../catalog/taxonomy.yaml", import.meta.url), "utf8"),
  ]);
  return {
    projectRoot,
    englishRoot,
    chineseRoot,
    sourceLockText: JSON.stringify({ schemaVersion: 2, sources: [
      { id: "agency-agents", ...english },
      { id: "agency-agents-zh", ...chinese },
    ] }),
    taxonomyText,
  };
}

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map(async (root) => rm(root, { force: true, recursive: true })));
});

describe("normalizeExpertFile", () => {
  const source = { repository: REPOSITORIES.chinese, path: "engineering/frontend-developer.md", commit: COMMITS.chinese, license: "MIT" as const };
  const upstreamSource = { repository: REPOSITORIES.english, path: translatedTaxonomy.upstreamPath!, commit: COMMITS.english, license: "MIT" as const };

  it("accepts reviewed emoji/color, discards them, and hashes canonical UTF-8 bytes", () => {
    const expert = normalizeExpertFile({ division: "engineering", relativePath: source.path, markdown: chineseMarkdown, source, upstreamSource, taxonomy: translatedTaxonomy });
    expect(expert).toMatchObject({ id: "ezagent.engineering.frontend-developer", origin: "upstream_translation", nameZh: "前端开发工程师" });
    expect(expert).not.toHaveProperty("emoji");
    expect(expert).not.toHaveProperty("color");
    expect(expert.contentHash).toBe("sha256:7b258bf5bf3de2e36b53133661396d63890aaf84f114f432cda1c5adf5892765");
  });

  it.each(["💻", "🇨🇳", "1️⃣", "desktop assistant"])('accepts bounded visible reviewed emoji text %j', (emoji) => {
    const markdown = `---\nname: 前端开发工程师\ndescription: 负责前端结构。\nemoji: "${emoji}"\ncolor: "warm blue"\n---\n正文中文。\n`;
    const expert = normalizeExpertFile({ division: "engineering", relativePath: source.path, markdown, source, upstreamSource, taxonomy: translatedTaxonomy });
    expect(expert.nameZh).toBe("前端开发工程师");
    expect(expert).not.toHaveProperty("emoji");
    expect(expert).not.toHaveProperty("color");
  });

  it.each([
    ["unknown", "role: admin"],
    ["emoji type", "emoji: [x]"],
    ["color type", "color: 42"],
    ["emoji control", 'emoji: "x\\u0007"'],
    ["color control", 'color: "blue\\u0007"'],
    ["emoji empty", 'emoji: ""'],
    ["color empty", 'color: "   "'],
    ["emoji huge", `emoji: "${"x".repeat(257)}"`],
    ["color huge", `color: "${"x".repeat(257)}"`],
  ])("rejects unreviewed or invalid frontmatter: %s", (_label, extra) => {
    const markdown = `---\nname: 前端开发工程师\ndescription: 负责前端结构。\n${extra}\n---\n正文中文。\n`;
    expect(() => normalizeExpertFile({ division: "engineering", relativePath: source.path, markdown, source, upstreamSource, taxonomy: translatedTaxonomy })).toThrow();
  });

  it.each([
    ["directive", "---\n%YAML 1.2\nname: 前端\ndescription: 负责前端。\n---\n正文中文。\n"],
    ["tag directive", "---\n%TAG !e! tag:example.invalid,2026:\nname: 前端\ndescription: 负责前端。\n---\n正文中文。\n"],
    ["unterminated comment", "---\nname: 前端\ndescription: 负责前端。\n---\n正文中文。<!-- hidden\n"],
    ["heading/comment only", "---\nname: 前端\ndescription: 负责前端。\n---\n# 只有标题\n<!-- 没有指令 -->\n"],
    ["Setext only", "---\nname: 前端\ndescription: 负责前端。\n---\n只有标题\n========\n"],
  ])("rejects ambiguous or non-substantive Markdown: %s", (_label, markdown) => {
    expect(() => normalizeExpertFile({ division: "engineering", relativePath: source.path, markdown, source, upstreamSource, taxonomy: translatedTaxonomy })).toThrow();
  });

  it.each([
    "---\nname: {zh: 前端}\ndescription: 负责前端。\n---\n正文中文。\n",
    "---\nname: 前端\nname: 后端\ndescription: 负责前端。\n---\n正文中文。\n",
    "---\nname: &name 前端\ndescription: *name\n---\n正文中文。\n",
    "---\nname: !unsafe 前端\ndescription: 负责前端。\n---\n正文中文。\n",
    "---\nname: 前端\ndescription: 负责前端。\n<<: {role: admin}\n---\n正文中文。\n",
    "---\nname: 前端\ndescription: 负责前端。\n__proto__: polluted\n---\n正文中文。\n",
  ])("rejects duplicate keys, aliases, tags, and merge keys", (markdown) => {
    expect(() => normalizeExpertFile({ division: "engineering", relativePath: source.path, markdown, source, upstreamSource, taxonomy: translatedTaxonomy })).toThrow();
  });

  it("never infers China-original from an absent upstream", () => {
    expect(() => normalizeExpertFile({ division: "engineering", relativePath: source.path, markdown: chineseMarkdown, source, taxonomy: translatedTaxonomy })).toThrow("requires");
  });

  it("rejects extra, accessor, and Proxy inputs and fails fast on oversized Markdown", () => {
    expect(() => normalizeExpertFile({
      division: "engineering",
      relativePath: source.path,
      markdown: chineseMarkdown,
      source,
      upstreamSource,
      taxonomy: translatedTaxonomy,
      extra: true,
    } as never)).toThrow("unsupported");

    const proxy = new Proxy({}, { ownKeys: () => { throw new Error("trap must not run"); } });
    expect(() => normalizeExpertFile(proxy as never)).toThrow("Proxy");

    const accessor = {} as Record<string, unknown>;
    Object.defineProperty(accessor, "division", { enumerable: true, get: () => "engineering" });
    expect(() => normalizeExpertFile(accessor as never)).toThrow("accessor");

    expect(() => normalizeExpertFile({
      division: "engineering",
      relativePath: source.path,
      markdown: " ".repeat(1_048_577),
      source,
      upstreamSource,
      taxonomy: translatedTaxonomy,
    })).toThrow("too large");
  });

  it("rejects deeply nested frontmatter before recursive YAML conversion", () => {
    const nested = `${"- ".repeat(24)}中文`;
    expect(() => normalizeExpertFile({
      division: "engineering",
      relativePath: source.path,
      markdown: `---\nname: 前端\ndescription:\n  ${nested}\n---\n正文中文。\n`,
      source,
      upstreamSource,
      taxonomy: translatedTaxonomy,
    })).toThrow("nesting");
  });

  it.each([
    "Engineering/frontend-developer.md",
    "engineering/../frontend-developer.md",
    "engineering/front%2fend.md",
    "engineering/frontend-developer.MD",
    "design/frontend-developer.md",
  ])("rejects a non-canonical or mismatched source path %s", (relativePath) => {
    expect(() => normalizeExpertFile({
      division: "engineering",
      relativePath,
      markdown: chineseMarkdown,
      source: { ...source, path: relativePath },
      upstreamSource,
      taxonomy: translatedTaxonomy,
    })).toThrow();
  });

  it("enforces Chinese source and English upstream roles", () => {
    expect(() => normalizeExpertFile({
      division: "engineering",
      relativePath: source.path,
      markdown: chineseMarkdown,
      source: { ...upstreamSource, path: source.path },
      upstreamSource: { ...source, path: upstreamSource.path },
      taxonomy: translatedTaxonomy,
    })).toThrow("Chinese repository");
  });

  it("accepts thematic breaks and Setext headings after closed frontmatter when substantive instructions remain", () => {
    const markdown = [
      "---",
      "name: 前端开发工程师",
      "description: 负责前端结构。",
      "---",
      "职责说明",
      "========",
      "分析组件边界。",
      "---",
      "验证跨组件行为。",
      "",
    ].join("\n");
    expect(normalizeExpertFile({ division: "engineering", relativePath: source.path, markdown, source, upstreamSource, taxonomy: translatedTaxonomy }).instructionsZh)
      .toContain("验证跨组件行为");
  });
});

describe("explicit taxonomy and attested source inventory", () => {
  it("parses origins, different upstream paths, and per-source ignored Markdown", async () => {
    const parsed = parseTaxonomyYaml(await readFile(new URL("../../catalog/taxonomy.yaml", import.meta.url), "utf8"));
    expect(parsed.experts["engineering/frontend-developer.md"]).toMatchObject({ origin: "upstream_translation", upstreamPath: "engineering/engineering-frontend-developer.md" });
    expect(parsed.experts["engineering/frontend-developer.md"]?.capabilities)
      .toEqual(["frontend-architecture", "state-design"]);
    expect(parsed.experts["design/product-designer.md"]?.origin).toBe("china_original");
    expect(parsed.ignoredMarkdown["agency-agents"]).toContain("strategy/strategy-advisor.md");
  });

  it("rejects missing/forbidden upstreamPath and unknown inventory keys", async () => {
    const text = await readFile(new URL("../../catalog/taxonomy.yaml", import.meta.url), "utf8");
    expect(() => parseTaxonomyYaml(text.replace("    upstreamPath: engineering/engineering-frontend-developer.md\n", ""))).toThrow("upstreamPath");
    expect(() => parseTaxonomyYaml(text.replace("    origin: china_original\n", "    origin: china_original\n    upstreamPath: design/nope.md\n"))).toThrow("unsupported");
    expect(() => parseTaxonomyYaml(text.replace("ignoredMarkdown:\n", "ignoredMarkdown:\n  unknown-source: [README.md]\n"))).toThrow("unsupported");
  });

  it.each([
    "schemaVersion: 1\nschemaVersion: 1\ndivisions: {}\nexperts: {}\nignoredMarkdown: {}\n",
    "schemaVersion: 1\ndivisions: &d {}\nexperts: *d\nignoredMarkdown: {}\n",
    "---\nschemaVersion: 1\ndivisions: {}\nexperts: {}\nignoredMarkdown: {}\n---\nschemaVersion: 1\n",
    "schemaVersion: 1\ndivisions: {}\nexperts: {}\nignoredMarkdown: {}\nextra: true\n",
  ])("rejects ambiguous or non-strict taxonomy YAML %#", (text) => {
    expect(() => parseTaxonomyYaml(text)).toThrow();
  });

  it("rejects a taxonomy BOM, including BOM-prefixed YAML directives", async () => {
    const valid = await readFile(new URL("../../catalog/taxonomy.yaml", import.meta.url), "utf8");
    expect(() => parseTaxonomyYaml(`\uFEFF${valid}`)).toThrow("BOM");
    expect(() => parseTaxonomyYaml(`\uFEFF%YAML 1.2\n---\n${valid}`)).toThrow();
    expect(() => parseTaxonomyYaml(`\uFEFF%TAG !e! tag:example.invalid,2026:\n---\n${valid}`)).toThrow();
    const root = await temporaryRoot();
    const path = join(root, "taxonomy.yaml");
    await writeFile(path, `\uFEFF${valid}`, "utf8");
    const handleBound = await readBoundedTextFile(path);
    expect(handleBound.startsWith("\uFEFF")).toBe(true);
    expect(() => parseTaxonomyYaml(handleBound)).toThrow("BOM");
  });

  it("rejects a lock without commit-bound Markdown attestations", () => {
    expect(() => parseSourceLockJson(JSON.stringify({ schemaVersion: 2, sources: [
      { id: "agency-agents", repository: REPOSITORIES.english, license: "MIT", commit: COMMITS.english },
      { id: "agency-agents-zh", repository: REPOSITORIES.chinese, license: "MIT", commit: COMMITS.chinese },
    ] }))).toThrow("reviewed v2");
  });

  it("requires strict JSON and exactly the reviewed source roles", async () => {
    const inputs = await fixtureInputs();
    expect(Object.keys(parseSourceLockJson(inputs.sourceLockText).sourcesById))
      .toEqual(["agency-agents", "agency-agents-zh"]);
    expect(() => parseSourceLockJson("schemaVersion: 2\nsources: []\n")).toThrow("JSON");
    expect(() => parseSourceLockJson('{"schemaVersion":2,"schemaVersion":2,"sources":[]}')).toThrow();
    const parsed = JSON.parse(inputs.sourceLockText) as { sources: unknown[] };
    expect(() => parseSourceLockJson(JSON.stringify({ schemaVersion: 2, sources: parsed.sources.slice(0, 1) }))).toThrow("exactly");
    expect(() => parseSourceLockJson(JSON.stringify({ schemaVersion: 2, sources: [...parsed.sources, { ...parsed.sources[0] as object, id: "evil" }] }))).toThrow("exactly");
  });

  it("rejects non-UTF-8 release input bytes", async () => {
    const root = await temporaryRoot();
    const path = join(root, "taxonomy.yaml");
    await writeFile(path, Buffer.from([0xff, 0xfe]));
    await expect(readBoundedTextFile(path)).rejects.toThrow("UTF-8");
  });

  it("imports byte-identically with explicit translated and original provenance", async () => {
    const inputs = await fixtureInputs();
    const first = await importExpertCatalog(inputs);
    const second = await importExpertCatalog(inputs);
    expect(serializeNormalizedCatalog(first)).toBe(serializeNormalizedCatalog(second));
    expect(first.map((expert) => [expert.id, expert.origin, "upstreamSource" in expert ? expert.upstreamSource.path : null])).toEqual([
      ["ezagent.design.product-designer", "china_original", null],
      ["ezagent.design.ux-researcher", "upstream_translation", "design/design-ux-researcher.md"],
      ["ezagent.engineering.frontend-developer", "upstream_translation", "engineering/engineering-frontend-developer.md"],
    ]);
  });

  it("fails closed on lock-after modification, added Markdown, and absent mapped upstream", async () => {
    const inputs = await fixtureInputs();
    const root = await temporaryRoot();
    await mkdir(join(root, "engineering"));
    const file = join(root, "engineering", "expert.md");
    await writeFile(file, "original\n");
    const source = await lockedSource(root, "chinese");
    await writeFile(file, "tampered\n");
    await expect(indexMarkdownFiles(root, source)).rejects.toThrow("locked");
    await writeFile(file, "original\n");
    await writeFile(join(root, "engineering", "new.md"), "new\n");
    await expect(indexMarkdownFiles(root, source)).rejects.toThrow("not attested");

    const taxonomyText = inputs.taxonomyText.replace("engineering/engineering-frontend-developer.md", "engineering/missing-upstream.md");
    await expect(importExpertCatalog({ ...inputs, taxonomyText })).rejects.toMatchObject({ missingUpstreamPaths: ["engineering/missing-upstream.md"] });
  });

  it("accepts a clean CRLF checkout when its reviewed Git blob canonicalizes to the same Markdown", async () => {
    const root = await temporaryRoot();
    await mkdir(join(root, "engineering"));
    const path = join(root, "engineering", "expert.md");
    const committed = Buffer.from("---\nname: 专家\ndescription: 负责验证。\n---\n执行验证。\n");
    const checkout = Buffer.from(committed.toString("utf8").replace(/\n/gu, "\r\n"));
    await writeFile(path, checkout);
    const normalized = normalizedMarkdownBytes(committed);
    const source: SourceBase = {
      repository: REPOSITORIES.chinese,
      commit: COMMITS.chinese,
      license: "MIT",
      tree: "b".repeat(40),
      objectFormat: "sha1",
      markdown: [{
        path: "engineering/expert.md",
        oid: blobOid(committed),
        size: committed.length,
        sha256: `sha256:${createHash("sha256").update(committed).digest("hex")}`,
        normalizedSize: normalized.length,
        normalizedSha256: `sha256:${createHash("sha256").update(normalized).digest("hex")}`,
      }],
    };
    const indexed = await indexMarkdownFiles(root, source);
    expect(indexed.get("engineering/expert.md")?.markdown).toContain("\n执行验证。\n");
    expect(indexed.get("engineering/expert.md")?.markdown).not.toContain("\r");
  });

  it("allows bounded CRLF expansion above the raw blob byte limit before canonical comparison", async () => {
    const root = await temporaryRoot();
    await mkdir(join(root, "engineering"));
    const path = join(root, "engineering", "large.md");
    const committed = Buffer.from("x\n".repeat(500_000));
    const checkout = Buffer.from("x\r\n".repeat(500_000));
    expect(committed.length).toBeLessThan(1_048_576);
    expect(checkout.length).toBeGreaterThan(1_048_576);
    await writeFile(path, checkout);
    const normalized = normalizedMarkdownBytes(committed);
    const source: SourceBase = {
      repository: REPOSITORIES.chinese,
      commit: COMMITS.chinese,
      license: "MIT",
      tree: "b".repeat(40),
      objectFormat: "sha1",
      markdown: [{
        path: "engineering/large.md",
        oid: blobOid(committed),
        size: committed.length,
        sha256: `sha256:${createHash("sha256").update(committed).digest("hex")}`,
        normalizedSize: normalized.length,
        normalizedSha256: `sha256:${createHash("sha256").update(normalized).digest("hex")}`,
      }],
    };
    await expect(indexMarkdownFiles(root, source)).resolves.toHaveProperty("size", 1);
  });

  it("reports missing and unclassified inventories deterministically", async () => {
    const inputs = await fixtureInputs();
    const taxonomyText = inputs.taxonomyText
      .replace("  design:\n    defaultDomains: [design]\n", "")
      .replace("  design/product-designer.md:\n", "  design/missing-product-designer.md:\n")
      .replace("strategy/strategy-advisor.md]", "strategy/strategy-advisor.md, extra.md]");
    await expect(importExpertCatalog({ ...inputs, taxonomyText })).rejects.toMatchObject({
      missingDivisions: ["design"],
      missingExpertPaths: ["design/product-designer.md"],
      extraExpertPaths: ["design/missing-product-designer.md"],
      unclassifiedMarkdownPaths: ["agency-agents-zh:design/product-designer.md"],
      extraIgnoredPaths: ["agency-agents:extra.md"],
    });
  });

  it("classifies missing metadata, undeclared divisions, and stale taxonomy paths without conflating groups", async () => {
    const projectRoot = await temporaryRoot();
    const englishRoot = join(projectRoot, "agency-agents");
    const chineseRoot = join(projectRoot, "agency-agents-zh");
    await mkdir(englishRoot);
    await mkdir(join(chineseRoot, "engineering"), { recursive: true });
    await mkdir(join(chineseRoot, "newdivision"), { recursive: true });
    await writeFile(join(englishRoot, "README.md"), "English inventory.\n");
    const expertMarkdown = "---\nname: 已映射专家\ndescription: 负责映射。\n---\n执行已映射任务。\n";
    await writeFile(join(chineseRoot, "engineering", "mapped.md"), expertMarkdown);
    await writeFile(join(chineseRoot, "engineering", "missing-meta.md"), expertMarkdown.replaceAll("已映射", "缺少元数据"));
    await writeFile(join(chineseRoot, "newdivision", "missing-meta.md"), expertMarkdown.replaceAll("已映射", "新领域"));
    const [english, chinese] = await Promise.all([lockedSource(englishRoot, "english"), lockedSource(chineseRoot, "chinese")]);
    const sourceLockText = JSON.stringify({ schemaVersion: 2, sources: [
      { id: "agency-agents", ...english },
      { id: "agency-agents-zh", ...chinese },
    ] });
    const meta = [
      "    origin: china_original",
      "    domains: [engineering]",
      "    capabilities: [mapping]",
      "    projectSignals: [mapping]",
      "    activationConditions: [需要映射]",
      "    exclusionConditions: []",
      "    preferredTasks: [review]",
      "    qualityGates: [验证映射]",
    ].join("\n");
    const taxonomyText = [
      "schemaVersion: 1",
      "divisions:",
      "  engineering:",
      "    defaultDomains: [engineering]",
      "experts:",
      "  engineering/mapped.md:",
      meta,
      "  engineering/stale.md:",
      meta,
      "ignoredMarkdown:",
      "  agency-agents: [README.md]",
      "  agency-agents-zh: []",
      "",
    ].join("\n");

    await expect(importExpertCatalog({ projectRoot, englishRoot, chineseRoot, sourceLockText, taxonomyText })).rejects.toMatchObject({
      missingDivisions: ["newdivision"],
      missingExpertPaths: ["engineering/missing-meta.md", "newdivision/missing-meta.md"],
      extraExpertPaths: ["engineering/stale.md"],
    });
  });

  it("rejects cross-classified expert/upstream paths and cross-file byte mixing", async () => {
    const inputs = await fixtureInputs();
    const chineseOverlap = inputs.taxonomyText.replace(
      "agency-agents-zh: [README.md,",
      "agency-agents-zh: [engineering/frontend-developer.md, README.md,",
    );
    await expect(importExpertCatalog({ ...inputs, taxonomyText: chineseOverlap })).rejects.toThrow("both expert and ignored");
    const englishOverlap = inputs.taxonomyText.replace(
      "agency-agents: [README.md,",
      "agency-agents: [engineering/engineering-frontend-developer.md, README.md,",
    );
    await expect(importExpertCatalog({ ...inputs, taxonomyText: englishOverlap })).rejects.toThrow("both upstream and ignored");

    const root = await temporaryRoot();
    await writeFile(join(root, "a.md"), "alpha\n");
    await writeFile(join(root, "b.md"), "bravo\n");
    const source = await lockedSource(root, "chinese");
    await writeFile(join(root, "a.md"), "bravo\n");
    await writeFile(join(root, "b.md"), "alpha\n");
    await expect(indexMarkdownFiles(root, source)).rejects.toThrow("locked normalized bytes");
  });

  it("rejects duplicate normalized ids before publication", () => {
    const source = { repository: REPOSITORIES.chinese, path: "engineering/frontend-developer.md", commit: COMMITS.chinese, license: "MIT" as const };
    const upstreamSource = { repository: REPOSITORIES.english, path: translatedTaxonomy.upstreamPath!, commit: COMMITS.english, license: "MIT" as const };
    const expert = normalizeExpertFile({ division: "engineering", relativePath: source.path, markdown: chineseMarkdown, source, upstreamSource, taxonomy: translatedTaxonomy });
    expect(() => serializeNormalizedCatalog([expert, expert])).toThrow("duplicate expert id");
  });
});

describe("filesystem and publication boundaries", () => {
  it("indexes attested regular files in portable deterministic order", async () => {
    const root = await temporaryRoot();
    await mkdir(join(root, "engineering"));
    await writeFile(join(root, "engineering", "z.md"), chineseMarkdown);
    await writeFile(join(root, "engineering", "a.md"), chineseMarkdown);
    await writeFile(join(root, "engineering", "README.txt"), "ignored");
    const source = await lockedSource(root, "chinese");
    const files = await indexMarkdownFiles(root, source);
    expect([...files.keys()]).toEqual(["engineering/a.md", "engineering/z.md"]);
  });

  it("counts the skipped .git entry when rejecting portable case collisions", async () => {
    const root = await temporaryRoot();
    await mkdir(join(root, ".git"));
    const source: SourceBase = {
      repository: REPOSITORIES.chinese,
      commit: COMMITS.chinese,
      license: "MIT",
      tree: "b".repeat(40),
      objectFormat: "sha1",
      markdown: [],
    };
    const gitUpper = join(root, ".GIT");
    await expect(indexMarkdownFiles(root, source, {
      ...nodeMarkdownIndexRuntime,
      lstat: async (path) => nodeMarkdownIndexRuntime.lstat(path === gitUpper ? join(root, ".git") : path),
      readdir: async (path) => path === root
        ? [
            { name: ".git", isDirectory: () => true, isFile: () => false },
            { name: ".GIT", isDirectory: () => true, isFile: () => false },
          ]
        : [],
    })).rejects.toThrow(/collision/iu);
  });

  it("rejects file symlinks from the attested inventory", async (context) => {
    const root = await temporaryRoot();
    const external = await temporaryRoot();
    await mkdir(join(root, "engineering"));
    await writeFile(join(external, "outside.md"), chineseMarkdown);
    await symlinkOrSkip(context, join(external, "outside.md"), join(root, "engineering", "linked.md"), "file");
    const bytes = Buffer.from(chineseMarkdown);
    const normalized = normalizedMarkdownBytes(bytes);
    const source: SourceBase = {
      repository: REPOSITORIES.chinese,
      commit: COMMITS.chinese,
      license: "MIT",
      tree: "b".repeat(40),
      objectFormat: "sha1",
      markdown: [{
        path: "engineering/linked.md",
        oid: blobOid(bytes),
        size: bytes.length,
        sha256: `sha256:${createHash("sha256").update(bytes).digest("hex")}`,
        normalizedSize: normalized.length,
        normalizedSha256: `sha256:${createHash("sha256").update(normalized).digest("hex")}`,
      }],
    };
    await expect(indexMarkdownFiles(root, source)).rejects.toThrow("symlink");
  });

  it("binds reads to file identity and rejects mutation after the handle-bound read", async () => {
    const root = await temporaryRoot();
    await mkdir(join(root, "engineering"));
    const path = join(root, "engineering", "expert.md");
    await writeFile(path, chineseMarkdown);
    const source = await lockedSource(root, "chinese");
    await expect(indexMarkdownFiles(root, source, {
      ...nodeMarkdownIndexRuntime,
      openNoFollow: async (target) => {
        const handle = await nodeMarkdownIndexRuntime.openNoFollow(target);
        return {
          ...handle,
          readBytes: async () => {
            const bytes = await handle.readBytes();
            await writeFile(target, `${chineseMarkdown}变更。\n`);
            return bytes;
          },
        };
      },
    })).rejects.toThrow("changed during read");
  });

  it("rejects invalid UTF-8 and whitespace-only attested Markdown", async () => {
    const invalidRoot = await temporaryRoot();
    await mkdir(join(invalidRoot, "engineering"));
    const invalid = Buffer.from([0xff, 0xfe]);
    await writeFile(join(invalidRoot, "engineering", "invalid.md"), invalid);
    const invalidSource: SourceBase = {
      repository: REPOSITORIES.chinese,
      commit: COMMITS.chinese,
      license: "MIT",
      tree: "b".repeat(40),
      objectFormat: "sha1",
      markdown: [{
        path: "engineering/invalid.md",
        oid: blobOid(invalid),
        size: invalid.length,
        sha256: `sha256:${createHash("sha256").update(invalid).digest("hex")}`,
        normalizedSize: 1,
        normalizedSha256: `sha256:${createHash("sha256").update("x").digest("hex")}`,
      }],
    };
    await expect(indexMarkdownFiles(invalidRoot, invalidSource)).rejects.toThrow("UTF-8");

    const blankRoot = await temporaryRoot();
    await mkdir(join(blankRoot, "engineering"));
    await writeFile(join(blankRoot, "engineering", "blank.md"), " \n\t");
    const blankSource = await lockedSource(blankRoot, "chinese");
    await expect(indexMarkdownFiles(blankRoot, blankSource)).rejects.toThrow("empty");
  });

  it("detects directory replacement without assuming Windows O_NOFOLLOW", async () => {
    const root = await temporaryRoot();
    const directory = join(root, "engineering");
    const file = join(directory, "expert.md");
    await mkdir(directory);
    await writeFile(file, "original\n");
    const source = await lockedSource(root, "chinese");
    let replaced = false;
    await expect(indexMarkdownFiles(root, source, {
      ...nodeMarkdownIndexRuntime,
      readdir: async (path) => {
        const entries = await nodeMarkdownIndexRuntime.readdir(path);
        if (path === directory && !replaced) {
          replaced = true;
          await rename(directory, join(root, "old-engineering"));
          await mkdir(directory);
          await writeFile(file, "original\n");
        }
        return entries;
      },
    })).rejects.toThrow("directory changed");
  });

  it("rejects source symlinks and paths outside the canonical project", async (context) => {
    const project = await temporaryRoot();
    const outside = await temporaryRoot();
    await writeFile(join(outside, "README.md"), "outside\n");
    const source = await lockedSource(outside, "chinese");
    const linked = join(project, "linked");
    await symlinkOrSkip(context, outside, linked, "dir");
    await expect(indexMarkdownFiles(linked, source, nodeMarkdownIndexRuntime, project)).rejects.toThrow();
    await expect(indexMarkdownFiles(outside, source, nodeMarkdownIndexRuntime, project)).rejects.toThrow("inside");
  });

  it("uses no-clobber publication: identical output is idempotent and differing output requires manual removal", async () => {
    const root = await temporaryRoot();
    const output = join(root, "catalog", "normalized", "experts.json");
    await writeNormalizedCatalog(output, [], { projectRoot: root } as never);
    const generated = await readFile(output, "utf8");
    await expect(writeNormalizedCatalog(output, [], { projectRoot: root } as never)).resolves.toBeUndefined();
    expect(await readFile(output, "utf8")).toBe(generated);
    await writeFile(output, "different\n");
    await expect(writeNormalizedCatalog(output, [], { projectRoot: root } as never)).rejects.toThrow(/exists|remove/iu);
    expect(await readFile(output, "utf8")).toBe("different\n");
  });

  it("rejects symlink directory chains under the supported static-parent threat model", async (context) => {
    const root = await temporaryRoot();
    const outside = await temporaryRoot();
    const output = join(root, "catalog", "normalized", "experts.json");
    await symlinkOrSkip(context, outside, join(root, "catalog"), "dir");
    await expect(writeNormalizedCatalog(output, [], { projectRoot: root } as never)).rejects.toThrow("symlink");
    await expect(lstat(join(outside, "normalized", "experts.json"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects an existing output symlink without changing its target", async (context) => {
    const root = await temporaryRoot();
    const parent = join(root, "catalog", "normalized");
    const output = join(parent, "experts.json");
    await mkdir(parent, { recursive: true });
    const outside = join(root, "outside.json");
    await writeFile(outside, "outside\n");
    await symlinkOrSkip(context, outside, output, "file");
    await expect(writeNormalizedCatalog(output, [], { projectRoot: root } as never)).rejects.toThrow("symlink");
    expect(await readFile(outside, "utf8")).toBe("outside\n");
  });
});

describe("release-only capability boundary", () => {
  it("has no process/network capability, imports safely, and fixes the production output path", async () => {
    const importer = await readFile(new URL("../../src/experts/importer.ts", import.meta.url), "utf8");
    const contract = await readFile(new URL("../../src/experts/attested-source-contract.ts", import.meta.url), "utf8");
    const command = await readFile(new URL("../../scripts/import-experts.ts", import.meta.url), "utf8");
    expect(`${importer}\n${contract}\n${command}`).not.toMatch(/node:(?:child_process|http|https|net|tls)|\bfetch\s*\(/u);
    expect(importer).not.toContain("./source-lock");
    const packageJson = JSON.parse(await readFile(new URL("../../package.json", import.meta.url), "utf8")) as { files: string[] };
    expect(packageJson.files).toContain("!dist/src/experts/attested-source-contract.js");
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const { main } = await import("../../scripts/import-experts.js");
    expect(stdout).not.toHaveBeenCalled();
    expect(stderr).not.toHaveBeenCalled();
    const root = await temporaryRoot();
    const writes: string[] = [];
    const messages: string[] = [];
    expect(await main({ projectRoot: root }, {
      readText: async (path) => path.endsWith("taxonomy.yaml") ? "taxonomy" : "lock",
      importCatalog: async (options) => { expect(options.projectRoot).toBe(root); return []; },
      writeCatalog: async (_experts, projectRoot) => { writes.push(join(projectRoot, "catalog", "normalized", "experts.json")); },
      writeStdout: () => undefined,
      writeStderr: (message) => { messages.push(message); },
    })).toBe(0);
    expect(writes).toEqual([join(root, "catalog", "normalized", "experts.json")]);
    expect(messages[0]).toContain("do not concurrently replace");
  });
});
