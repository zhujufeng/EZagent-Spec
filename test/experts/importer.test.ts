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

async function markdownManifest(root: string): Promise<readonly MarkdownManifestEntry[]> {
  const result: MarkdownManifestEntry[] = [];
  async function visit(directory: string, prefix: string): Promise<void> {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
      const absolute = join(directory, entry.name);
      if (entry.isDirectory()) await visit(absolute, path);
      else if (entry.isFile() && entry.name.endsWith(".md")) {
        const bytes = await readFile(absolute);
        result.push({
          path,
          oid: blobOid(bytes),
          size: bytes.length,
          sha256: `sha256:${createHash("sha256").update(bytes).digest("hex")}`,
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
    expect(expert.contentHash).toMatch(/^sha256:[0-9a-f]{64}$/u);
  });

  it.each([
    ["unknown", "role: admin"],
    ["emoji type", "emoji: [x]"],
    ["emoji format", "emoji: desktop"],
    ["color type", "color: 42"],
    ["color format", "color: Blue Color"],
  ])("rejects unreviewed or invalid frontmatter: %s", (_label, extra) => {
    const markdown = `---\nname: 前端开发工程师\ndescription: 负责前端结构。\n${extra}\n---\n正文中文。\n`;
    expect(() => normalizeExpertFile({ division: "engineering", relativePath: source.path, markdown, source, upstreamSource, taxonomy: translatedTaxonomy })).toThrow();
  });

  it.each([
    ["directive", "---\n%YAML 1.2\nname: 前端\ndescription: 负责前端。\n---\n正文中文。\n"],
    ["unterminated comment", "---\nname: 前端\ndescription: 负责前端。\n---\n正文中文。<!-- hidden\n"],
    ["Setext only", "---\nname: 前端\ndescription: 负责前端。\n---\n只有标题\n========\n"],
    ["document markers", "---\nname: 前端\ndescription: 负责前端。\n---\n---\n仅有文档标记\n---\n"],
  ])("rejects ambiguous or non-substantive Markdown: %s", (_label, markdown) => {
    expect(() => normalizeExpertFile({ division: "engineering", relativePath: source.path, markdown, source, upstreamSource, taxonomy: translatedTaxonomy })).toThrow();
  });

  it.each([
    "---\nname: 前端\nname: 后端\ndescription: 负责前端。\n---\n正文中文。\n",
    "---\nname: &name 前端\ndescription: *name\n---\n正文中文。\n",
    "---\nname: !unsafe 前端\ndescription: 负责前端。\n---\n正文中文。\n",
    "---\nname: 前端\ndescription: 负责前端。\n<<: {role: admin}\n---\n正文中文。\n",
  ])("rejects duplicate keys, aliases, tags, and merge keys", (markdown) => {
    expect(() => normalizeExpertFile({ division: "engineering", relativePath: source.path, markdown, source, upstreamSource, taxonomy: translatedTaxonomy })).toThrow();
  });

  it("never infers China-original from an absent upstream", () => {
    expect(() => normalizeExpertFile({ division: "engineering", relativePath: source.path, markdown: chineseMarkdown, source, taxonomy: translatedTaxonomy })).toThrow("requires");
  });
});

describe("explicit taxonomy and attested source inventory", () => {
  it("parses origins, different upstream paths, and per-source ignored Markdown", async () => {
    const parsed = parseTaxonomyYaml(await readFile(new URL("../../catalog/taxonomy.yaml", import.meta.url), "utf8"));
    expect(parsed.experts["engineering/frontend-developer.md"]).toMatchObject({ origin: "upstream_translation", upstreamPath: "engineering/engineering-frontend-developer.md" });
    expect(parsed.experts["design/product-designer.md"]?.origin).toBe("china_original");
    expect(parsed.ignoredMarkdown["agency-agents"]).toContain("strategy/strategy-advisor.md");
  });

  it("rejects missing/forbidden upstreamPath and unknown inventory keys", async () => {
    const text = await readFile(new URL("../../catalog/taxonomy.yaml", import.meta.url), "utf8");
    expect(() => parseTaxonomyYaml(text.replace("    upstreamPath: engineering/engineering-frontend-developer.md\n", ""))).toThrow("upstreamPath");
    expect(() => parseTaxonomyYaml(text.replace("    origin: china_original\n", "    origin: china_original\n    upstreamPath: design/nope.md\n"))).toThrow("unsupported");
    expect(() => parseTaxonomyYaml(text.replace("ignoredMarkdown:\n", "ignoredMarkdown:\n  unknown-source: [README.md]\n"))).toThrow("unsupported");
  });

  it("rejects a lock without commit-bound Markdown attestations", () => {
    expect(() => parseSourceLockJson(JSON.stringify({ schemaVersion: 2, sources: [
      { id: "agency-agents", repository: REPOSITORIES.english, license: "MIT", commit: COMMITS.english },
      { id: "agency-agents-zh", repository: REPOSITORIES.chinese, license: "MIT", commit: COMMITS.chinese },
    ] }))).toThrow("tree");
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

  it("reports missing and unclassified inventories deterministically", async () => {
    const inputs = await fixtureInputs();
    const taxonomyText = inputs.taxonomyText
      .replace("  design:\n    defaultDomains: [design]\n", "")
      .replace("  design/product-designer.md:\n", "  design/missing-product-designer.md:\n")
      .replace("strategy/strategy-advisor.md]", "strategy/strategy-advisor.md, extra.md]");
    await expect(importExpertCatalog({ ...inputs, taxonomyText })).rejects.toMatchObject({
      missingDivisions: ["design"],
      missingExpertPaths: ["design/missing-product-designer.md"],
      unclassifiedMarkdownPaths: ["agency-agents-zh:design/product-designer.md"],
      extraIgnoredPaths: ["agency-agents:extra.md"],
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
    await expect(indexMarkdownFiles(root, source)).rejects.toThrow("locked bytes");
  });
});

describe("filesystem and publication boundaries", () => {
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

  it("preserves old output on failure and rejects symlink chains", async (context) => {
    const root = await temporaryRoot();
    const outside = await temporaryRoot();
    const output = join(root, "catalog", "normalized", "experts.json");
    await mkdir(join(root, "catalog", "normalized"), { recursive: true });
    await writeFile(output, "old\n");
    await expect(writeNormalizedCatalog(output, [], { projectRoot: root, atomicWriteText: async () => { throw new Error("write failed"); } })).rejects.toThrow("write failed");
    expect(await readFile(output, "utf8")).toBe("old\n");
    await rm(join(root, "catalog"), { recursive: true });
    await symlinkOrSkip(context, outside, join(root, "catalog"), "dir");
    await expect(writeNormalizedCatalog(output, [], { projectRoot: root, atomicWriteText: async (path, content) => writeFile(path, content) })).rejects.toThrow("symlink");
    await expect(lstat(join(outside, "normalized", "experts.json"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("fails a parent-symlink race before the writer can touch the external directory", async (context) => {
    const root = await temporaryRoot();
    const outside = await temporaryRoot();
    const parent = join(root, "catalog", "normalized");
    const output = join(parent, "experts.json");
    await mkdir(parent, { recursive: true });
    const writer = vi.fn(async (path: string, content: string) => writeFile(path, content));
    await expect(writeNormalizedCatalog(output, [], {
      projectRoot: root,
      beforePublish: async () => {
        await rename(parent, join(root, "catalog", "normalized-before"));
        await symlinkOrSkip(context, outside, parent, "dir");
      },
      atomicWriteText: writer,
    })).rejects.toThrow("changed before publication");
    expect(writer).not.toHaveBeenCalled();
    await expect(lstat(join(outside, "experts.json"))).rejects.toMatchObject({ code: "ENOENT" });
  });
});

describe("release-only capability boundary", () => {
  it("has no process/network capability, imports safely, and fixes the production output path", async () => {
    const importer = await readFile(new URL("../../src/experts/importer.ts", import.meta.url), "utf8");
    const command = await readFile(new URL("../../scripts/import-experts.ts", import.meta.url), "utf8");
    expect(`${importer}\n${command}`).not.toMatch(/node:(?:child_process|http|https|net|tls)|\bfetch\s*\(/u);
    expect(importer).not.toContain("./source-lock");
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const { main } = await import("../../scripts/import-experts.js");
    expect(stdout).not.toHaveBeenCalled();
    expect(stderr).not.toHaveBeenCalled();
    const root = await temporaryRoot();
    const writes: string[] = [];
    expect(await main({ projectRoot: root }, {
      readText: async (path) => path.endsWith("taxonomy.yaml") ? "taxonomy" : "lock",
      importCatalog: async (options) => { expect(options.projectRoot).toBe(root); return []; },
      writeCatalog: async (path) => { writes.push(path); },
      writeStdout: () => undefined,
      writeStderr: () => undefined,
    })).toBe(0);
    expect(writes).toEqual([join(root, "catalog", "normalized", "experts.json")]);
  });
});
