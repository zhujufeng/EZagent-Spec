import { constants as fsConstants } from "node:fs";
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi, type TestContext } from "vitest";

import {
  importExpertCatalog,
  indexMarkdownFiles,
  normalizeExpertFile,
  nodeMarkdownIndexRuntime,
  parseSourceLockJson,
  parseTaxonomyYaml,
  readBoundedTextFile,
  serializeNormalizedCatalog,
  writeNormalizedCatalog,
  type TaxonomyMeta,
} from "../../src/experts/importer.js";

const roots: string[] = [];
const translatedSource = {
  repository: "https://github.com/jnMetaCode/agency-agents-zh",
  path: "engineering/frontend-architect.md",
  commit: "1".repeat(40),
  license: "MIT" as const,
};
const upstreamSource = {
  repository: "https://github.com/msitarzewski/agency-agents",
  path: "engineering/frontend-architect.md",
  commit: "2".repeat(40),
  license: "MIT" as const,
};
const taxonomy: TaxonomyMeta = {
  domains: ["engineering", "frontend"],
  capabilities: ["frontend-architecture"],
  projectSignals: ["react"],
  activationConditions: ["跨组件行为变化"],
  exclusionConditions: ["纯后端数据迁移"],
  preferredTasks: ["design", "review"],
  qualityGates: ["引用实际文件", "覆盖错误状态"],
};
const chineseMarkdown = "---\r\nname: 前端架构师\r\ndescription: 负责前端结构。\r\n---\r\n# 前端架构师\r\n\r\n分析组件边界。\r\n";

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "ezagent-importer-"));
  roots.push(root);
  return root;
}

async function symlinkOrSkip(
  context: TestContext,
  target: string,
  path: string,
  type: "file" | "dir",
): Promise<void> {
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

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map(async (root) => rm(root, { force: true, recursive: true })));
});

describe("normalizeExpertFile", () => {
  it("produces stable provenance and hashes canonical UTF-8 bytes", () => {
    const expert = normalizeExpertFile({
      division: "engineering",
      relativePath: "engineering/frontend-architect.md",
      markdown: `\uFEFF${chineseMarkdown}`,
      source: translatedSource,
      upstreamSource,
      taxonomy,
    });

    expect(expert).toMatchObject({
      id: "ezagent.engineering.frontend-architect",
      origin: "upstream_translation",
      nameZh: "前端架构师",
      instructionsZh: "# 前端架构师\n\n分析组件边界。",
    });
    expect(expert.contentHash).toBe("sha256:25709ce84dcd6f881cb054aed1dc61ab34698b9b792d3425d3d815d23e90dff8");
  });

  it("marks a file without an exact English path as a China-original expert", () => {
    const expert = normalizeExpertFile({
      division: "design",
      relativePath: "design/product-designer.md",
      markdown: "---\nname: 产品设计师\ndescription: 负责产品体验。\n---\n# 产品设计师\n\n验证用户旅程。\n",
      source: { ...translatedSource, path: "design/product-designer.md" },
      taxonomy: { ...taxonomy, domains: ["design"] },
    });

    expect(expert.origin).toBe("china_original");
    expect("upstreamSource" in expert).toBe(false);
  });

  it.each([
    ["metadata object", "---\nname: {zh: 前端}\ndescription: 负责前端结构。\n---\n正文中文。\n"],
    ["duplicate key", "---\nname: 前端\nname: 后端\ndescription: 负责前端结构。\n---\n正文中文。\n"],
    ["alias", "---\nname: &n 前端\ndescription: *n\n---\n正文中文。\n"],
    ["tag", "---\nname: !foo 前端\ndescription: 负责前端结构。\n---\n正文中文。\n"],
    ["merge", "---\nname: 前端\ndescription: 负责前端结构。\n<<: {x: y}\n---\n正文中文。\n"],
    ["prototype key", "---\nname: 前端\ndescription: 负责前端结构。\n__proto__: polluted\n---\n正文中文。\n"],
    ["extra metadata", "---\nname: 前端\ndescription: 负责前端结构。\nrole: admin\n---\n正文中文。\n"],
    ["heading only", "---\nname: 前端\ndescription: 负责前端结构。\n---\n# 前端\n<!-- no instructions -->\n"],
  ])("rejects hostile or incomplete Markdown metadata: %s", (_label, markdown) => {
    expect(() => normalizeExpertFile({
      division: "engineering",
      relativePath: "engineering/frontend-architect.md",
      markdown,
      source: translatedSource,
      upstreamSource,
      taxonomy,
    })).toThrow();
  });

  it("rejects extra/accessor/proxy inputs and fails fast on oversized Markdown", () => {
    expect(() => normalizeExpertFile({
      division: "engineering",
      relativePath: "engineering/frontend-architect.md",
      markdown: chineseMarkdown,
      source: translatedSource,
      upstreamSource,
      taxonomy,
      extra: true,
    } as never)).toThrow("unsupported");

    const proxy = new Proxy({}, { ownKeys: () => { throw new Error("trap"); } });
    expect(() => normalizeExpertFile(proxy as never)).toThrow("Proxy");

    const input = {} as Record<string, unknown>;
    Object.defineProperty(input, "division", { enumerable: true, get: () => "engineering" });
    expect(() => normalizeExpertFile(input as never)).toThrow("accessor");

    expect(() => normalizeExpertFile({
      division: "engineering",
      relativePath: "engineering/frontend-architect.md",
      markdown: " ".repeat(1_048_577),
      source: translatedSource,
      upstreamSource,
      taxonomy,
    })).toThrow("too large");
  });

  it("rejects deeply nested YAML before recursive conversion can exhaust the stack", () => {
    const nested = `${"- ".repeat(24)}中文`;
    expect(() => normalizeExpertFile({
      division: "engineering",
      relativePath: "engineering/frontend-architect.md",
      markdown: `---\nname: 前端\ndescription:\n  ${nested}\n---\n正文中文。\n`,
      source: translatedSource,
      upstreamSource,
      taxonomy,
    })).toThrow("nesting");
  });

  it.each([
    "Engineering/frontend-architect.md",
    "engineering/../frontend-architect.md",
    "engineering/front%2fend.md",
    "engineering/frontend-architect.MD",
    "design/frontend-architect.md",
  ])("rejects a non-canonical or mismatched source path %s", (relativePath) => {
    expect(() => normalizeExpertFile({
      division: "engineering",
      relativePath,
      markdown: chineseMarkdown,
      source: { ...translatedSource, path: relativePath },
      upstreamSource,
      taxonomy,
    })).toThrow();
  });

  it("enforces the Chinese source and English upstream roles", () => {
    expect(() => normalizeExpertFile({
      division: "engineering",
      relativePath: "engineering/frontend-architect.md",
      markdown: chineseMarkdown,
      source: upstreamSource,
      upstreamSource: translatedSource,
      taxonomy,
    })).toThrow("Chinese repository");
  });
});

describe("taxonomy and source lock parsing", () => {
  it("parses strict complete per-file taxonomy without inheriting generic capabilities", async () => {
    const text = await readFile(new URL("../../catalog/taxonomy.yaml", import.meta.url), "utf8");
    const parsed = parseTaxonomyYaml(text);

    expect(parsed.schemaVersion).toBe(1);
    expect(parsed.experts["engineering/frontend-architect.md"]?.capabilities)
      .toEqual(["frontend-architecture", "state-design"]);
  });

  it.each([
    "schemaVersion: 1\nschemaVersion: 1\ndivisions: {}\nexperts: {}\n",
    "schemaVersion: 1\ndivisions: &d {}\nexperts: *d\n",
    "---\nschemaVersion: 1\ndivisions: {}\nexperts: {}\n---\nschemaVersion: 1\n",
    "schemaVersion: 1\ndivisions: {}\nexperts: {}\nextra: true\n",
  ])("rejects ambiguous or non-strict taxonomy YAML %#", (text) => {
    expect(() => parseTaxonomyYaml(text)).toThrow();
  });

  it("accepts exactly the two immutable reviewed source locks and rejects extras", () => {
    const valid = JSON.stringify({
      schemaVersion: 1,
      sources: [
        { id: "agency-agents", repository: "https://github.com/msitarzewski/agency-agents", license: "MIT", commit: "2".repeat(40) },
        { id: "agency-agents-zh", repository: "https://github.com/jnMetaCode/agency-agents-zh", license: "MIT", commit: "1".repeat(40) },
      ],
    });
    expect(Object.keys(parseSourceLockJson(valid).sourcesById)).toEqual(["agency-agents", "agency-agents-zh"]);
    expect(() => parseSourceLockJson(JSON.stringify({
      ...JSON.parse(valid),
      sources: [...JSON.parse(valid).sources, { id: "evil", repository: "https://github.com/evil/evil", license: "MIT", commit: "3".repeat(40) }],
    }))).toThrow("exactly");
    expect(() => parseSourceLockJson("schemaVersion: 1\nsources: []\n")).toThrow("JSON");
  });

  it("rejects non-UTF-8 release input bytes", async () => {
    const root = await temporaryRoot();
    const path = join(root, "taxonomy.yaml");
    await writeFile(path, Buffer.from([0xff, 0xfe]));
    await expect(readBoundedTextFile(path)).rejects.toThrow("UTF-8");
  });
});

describe("indexMarkdownFiles", () => {
  it("indexes bounded regular files in portable deterministic order", async () => {
    const root = await temporaryRoot();
    await mkdir(join(root, "engineering"));
    await writeFile(join(root, "engineering", "z.md"), chineseMarkdown);
    await writeFile(join(root, "engineering", "a.md"), chineseMarkdown);
    await writeFile(join(root, "engineering", "README.txt"), "ignored");
    await mkdir(join(root, ".git"));
    await writeFile(join(root, ".git", "ignored.md"), chineseMarkdown);

    const files = await indexMarkdownFiles(root, {
      repository: translatedSource.repository,
      commit: translatedSource.commit,
      license: "MIT",
    });

    expect([...files.keys()]).toEqual(["engineering/a.md", "engineering/z.md"]);
    expect(files.get("engineering/a.md")?.source.path).toBe("engineering/a.md");
  });

  it("rejects file and directory symlinks", async (context) => {
    const root = await temporaryRoot();
    const external = await temporaryRoot();
    await mkdir(join(root, "engineering"));
    await writeFile(join(external, "outside.md"), chineseMarkdown);
    await symlinkOrSkip(context, join(external, "outside.md"), join(root, "engineering", "linked.md"), "file");
    await expect(indexMarkdownFiles(root, {
      repository: translatedSource.repository,
      commit: translatedSource.commit,
      license: "MIT",
    })).rejects.toThrow("symlink");
  });

  it("binds reads to O_NOFOLLOW handles and detects pre/post identity changes", async () => {
    expect(fsConstants.O_NOFOLLOW).toBeTypeOf("number");
    const root = await temporaryRoot();
    await mkdir(join(root, "engineering"));
    const path = join(root, "engineering", "frontend.md");
    await writeFile(path, chineseMarkdown);
    const before = await lstat(path);
    const files = await indexMarkdownFiles(root, {
      repository: translatedSource.repository,
      commit: translatedSource.commit,
      license: "MIT",
    });
    const after = await lstat(path);
    expect(before.dev).toBe(after.dev);
    expect(files.size).toBe(1);
  });

  it("rejects a source directory replaced between enumeration and use", async () => {
    const root = await temporaryRoot();
    const directory = join(root, "engineering");
    await mkdir(directory);
    await writeFile(join(directory, "frontend.md"), chineseMarkdown);
    let replaced = false;
    await expect(indexMarkdownFiles(root, {
      repository: translatedSource.repository,
      commit: translatedSource.commit,
      license: "MIT",
    }, {
      ...nodeMarkdownIndexRuntime,
      readdir: async (path) => {
        const entries = await nodeMarkdownIndexRuntime.readdir(path);
        if (path === directory && !replaced) {
          replaced = true;
          await rename(directory, join(root, "engineering-before"));
          await mkdir(directory);
          await writeFile(join(directory, "frontend.md"), chineseMarkdown);
        }
        return entries;
      },
    })).rejects.toThrow("directory changed");
  });

  it("rejects a Markdown file changed after its handle-bound read", async () => {
    const root = await temporaryRoot();
    await mkdir(join(root, "engineering"));
    const path = join(root, "engineering", "frontend.md");
    await writeFile(path, chineseMarkdown);
    await expect(indexMarkdownFiles(root, {
      repository: translatedSource.repository,
      commit: translatedSource.commit,
      license: "MIT",
    }, {
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

  it("rejects invalid UTF-8 and whitespace-only Markdown in either source", async () => {
    const invalidRoot = await temporaryRoot();
    await mkdir(join(invalidRoot, "engineering"));
    await writeFile(join(invalidRoot, "engineering", "invalid.md"), Buffer.from([0xff, 0xfe]));
    await expect(indexMarkdownFiles(invalidRoot, {
      repository: translatedSource.repository,
      commit: translatedSource.commit,
      license: "MIT",
    })).rejects.toThrow("UTF-8");

    const blankRoot = await temporaryRoot();
    await mkdir(join(blankRoot, "engineering"));
    await writeFile(join(blankRoot, "engineering", "blank.md"), " \n\t");
    await expect(indexMarkdownFiles(blankRoot, {
      repository: upstreamSource.repository,
      commit: upstreamSource.commit,
      license: "MIT",
    })).rejects.toThrow("empty");
  });
});

describe("fixture catalog import", () => {
  it("imports the two explicit local sources byte-identically with exact provenance", async () => {
    const projectRoot = join(import.meta.dirname, "..", "fixtures", "source-repos");
    const taxonomyPath = new URL("../../catalog/taxonomy.yaml", import.meta.url);
    const lockText = JSON.stringify({
      schemaVersion: 1,
      sources: [
        { id: "agency-agents", repository: upstreamSource.repository, license: "MIT", commit: upstreamSource.commit },
        { id: "agency-agents-zh", repository: translatedSource.repository, license: "MIT", commit: translatedSource.commit },
      ],
    });
    const first = await importExpertCatalog({
      englishRoot: join(projectRoot, "agency-agents"),
      chineseRoot: join(projectRoot, "agency-agents-zh"),
      sourceLockText: lockText,
      taxonomyText: await readFile(taxonomyPath, "utf8"),
    });
    const second = await importExpertCatalog({
      englishRoot: join(projectRoot, "agency-agents"),
      chineseRoot: join(projectRoot, "agency-agents-zh"),
      sourceLockText: lockText,
      taxonomyText: await readFile(taxonomyPath, "utf8"),
    });

    expect(serializeNormalizedCatalog(first)).toBe(serializeNormalizedCatalog(second));
    expect(first.map((expert) => [expert.id, expert.origin])).toEqual([
      ["ezagent.design.product-designer", "china_original"],
      ["ezagent.engineering.frontend-architect", "upstream_translation"],
    ]);
  });

  it("reports missing divisions, missing expert paths, and extra taxonomy paths separately", async () => {
    const fixtures = join(import.meta.dirname, "..", "fixtures", "source-repos");
    const taxonomyText = `schemaVersion: 1\ndivisions:\n  engineering:\n    defaultDomains: [engineering]\n  unused:\n    defaultDomains: [unused]\nexperts:\n  unused/ghost.md:\n    domains: [unused]\n    capabilities: [ghost]\n    projectSignals: []\n    activationConditions: [需要幽灵]\n    exclusionConditions: []\n    preferredTasks: [review]\n    qualityGates: [验证幽灵]\n`;
    const lockText = JSON.stringify({ schemaVersion: 1, sources: [
      { id: "agency-agents", repository: upstreamSource.repository, license: "MIT", commit: upstreamSource.commit },
      { id: "agency-agents-zh", repository: translatedSource.repository, license: "MIT", commit: translatedSource.commit },
    ] });

    await expect(importExpertCatalog({
      englishRoot: join(fixtures, "agency-agents"),
      chineseRoot: join(fixtures, "agency-agents-zh"),
      sourceLockText: lockText,
      taxonomyText,
    })).rejects.toMatchObject({
      missingDivisions: ["design"],
      missingExpertPaths: ["design/product-designer.md", "engineering/frontend-architect.md"],
      extraExpertPaths: ["unused/ghost.md"],
    });
  });

  it("reports a missing division independently when the per-expert mapping exists", async () => {
    const fixtures = join(import.meta.dirname, "..", "fixtures", "source-repos");
    const complete = await readFile(new URL("../../catalog/taxonomy.yaml", import.meta.url), "utf8");
    const taxonomyText = complete.replace("  design:\n    defaultDomains: [design]\n", "");
    const lockText = JSON.stringify({ schemaVersion: 1, sources: [
      { id: "agency-agents", repository: upstreamSource.repository, license: "MIT", commit: upstreamSource.commit },
      { id: "agency-agents-zh", repository: translatedSource.repository, license: "MIT", commit: translatedSource.commit },
    ] });

    await expect(importExpertCatalog({
      englishRoot: join(fixtures, "agency-agents"),
      chineseRoot: join(fixtures, "agency-agents-zh"),
      sourceLockText: lockText,
      taxonomyText,
    })).rejects.toMatchObject({
      missingDivisions: ["design"],
      missingExpertPaths: [],
      extraExpertPaths: [],
    });
  });

  it("rejects duplicate normalized ids before publication", async () => {
    expect(() => serializeNormalizedCatalog([
      normalizeExpertFile({ division: "engineering", relativePath: "engineering/frontend-architect.md", markdown: chineseMarkdown, source: translatedSource, upstreamSource, taxonomy }),
      normalizeExpertFile({ division: "engineering", relativePath: "engineering/frontend-architect.md", markdown: chineseMarkdown, source: translatedSource, upstreamSource, taxonomy }),
    ])).toThrow("duplicate expert id");
  });

  it("does not replace the old generated catalog when the atomic writer fails", async () => {
    const root = await temporaryRoot();
    const output = join(root, "catalog", "normalized", "experts.json");
    await mkdir(join(root, "catalog", "normalized"), { recursive: true });
    await writeFile(output, "old\n");
    const expert = normalizeExpertFile({ division: "engineering", relativePath: "engineering/frontend-architect.md", markdown: chineseMarkdown, source: translatedSource, upstreamSource, taxonomy });

    await expect(writeNormalizedCatalog(output, [expert], {
      atomicWriteText: async () => { throw new Error("injected write failure"); },
    })).rejects.toThrow("injected write failure");
    expect(await readFile(output, "utf8")).toBe("old\n");
  });

  it("rejects an existing output symlink", async (context) => {
    const root = await temporaryRoot();
    const output = join(root, "experts.json");
    const target = join(root, "outside.json");
    await writeFile(target, "outside\n");
    await symlinkOrSkip(context, target, output, "file");
    await expect(writeNormalizedCatalog(output, [])).rejects.toThrow("symlink");
    expect(await readFile(target, "utf8")).toBe("outside\n");
  });

  it("rejects a symlink in the project-relative output directory chain", async (context) => {
    const root = await temporaryRoot();
    const outside = await temporaryRoot();
    await symlinkOrSkip(context, outside, join(root, "catalog"), "dir");
    const output = join(root, "catalog", "normalized", "experts.json");
    await expect(writeNormalizedCatalog(output, [], {
      atomicWriteText: async (path, content) => writeFile(path, content),
      projectRoot: root,
    }))
      .rejects.toThrow("symlink");
    await expect(lstat(join(outside, "normalized", "experts.json"))).rejects.toMatchObject({ code: "ENOENT" });
  });
});

describe("release-only capability boundary", () => {
  it("contains no Git, child-process, HTTP, or network imports", async () => {
    const importer = await readFile(new URL("../../src/experts/importer.ts", import.meta.url), "utf8");
    const command = await readFile(new URL("../../scripts/import-experts.ts", import.meta.url), "utf8");
    expect(`${importer}\n${command}`).not.toMatch(/node:(?:child_process|http|https|net|tls)|\bfetch\s*\(/u);
    expect(importer).not.toMatch(/\bgit\b/iu);
  });

  it("imports without side effects and exposes an injectable command runtime", async () => {
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const { main } = await import("../../scripts/import-experts.js");
    expect(stdout).not.toHaveBeenCalled();
    expect(stderr).not.toHaveBeenCalled();

    const root = await temporaryRoot();
    const reads: string[] = [];
    const writes: string[] = [];
    const result = await main({ projectRoot: root }, {
      readText: async (path) => {
        reads.push(path);
        return path.endsWith("taxonomy.yaml") ? "taxonomy" : "lock";
      },
      importCatalog: async (options) => {
        expect(options.englishRoot).toBe(join(root, "vendor-sources", "agency-agents"));
        expect(options.chineseRoot).toBe(join(root, "vendor-sources", "agency-agents-zh"));
        expect(options.sourceLockText).toBe("lock");
        expect(options.taxonomyText).toBe("taxonomy");
        return [];
      },
      writeCatalog: async (path, experts, projectRoot) => {
        expect(experts).toEqual([]);
        expect(projectRoot).toBe(root);
        writes.push(path);
      },
      writeStdout: () => undefined,
      writeStderr: () => undefined,
    });

    expect(result).toBe(0);
    expect(reads).toEqual([
      join(root, "catalog", "sources.lock.json"),
      join(root, "catalog", "taxonomy.yaml"),
    ]);
    expect(writes).toEqual([join(root, "catalog", "normalized", "experts.json")]);
  });
});
