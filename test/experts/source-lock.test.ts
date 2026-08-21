import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";

import { afterEach, describe, expect, expectTypeOf, it, vi, type TestContext } from "vitest";

import {
  createSourceLock,
  lockCatalogSources,
  parseSourceCandidatesConfig,
  parseSourceCandidatesYaml,
  resolveLocalCheckoutAttestation,
  resolveLocalCheckoutCommit,
  serializeSourceLock,
  nodeSourceConfigReadRuntime,
  nodeSourceLockPublishRuntime,
  writeSourceLockFile,
  type GitBinaryRunner,
  type GitRunner,
  type AttestedSourceLock,
  type SourceConfigReadRuntime,
  type SourceLockPublishRuntime,
  type SourceCandidate,
  type SourceLock,
} from "../../src/experts/source-lock.js";
import { parseSourceLockJson } from "../../src/experts/importer.js";
import {
  createAttestedLicenseEntry,
  createAttestedMarkdownEntry,
} from "../../src/experts/attested-source-contract.js";

const execFileAsync = promisify(execFile);
const temporaryRoots: string[] = [];

const validCandidate = (overrides: Partial<SourceCandidate> = {}): SourceCandidate => ({
  id: "agency-agents",
  repository: "https://github.com/msitarzewski/agency-agents",
  ref: "refs/heads/main",
  checkout: "vendor-sources/agency-agents",
  license: "MIT",
  ...overrides,
});

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "ezagent-source-lock-"));
  temporaryRoots.push(root);
  return root;
}

async function runGit(repository: string, args: readonly string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", ["-C", repository, ...args], {
    encoding: "utf8",
  });
  return stdout;
}

async function createLocalSource(
  root: string,
  id: "agency-agents" | "agency-agents-zh" = "agency-agents",
): Promise<{ checkout: string; head: string }> {
  const repository = id === "agency-agents"
    ? "https://github.com/msitarzewski/agency-agents"
    : "https://github.com/jnMetaCode/agency-agents-zh";
  const checkout = join(root, "vendor-sources", id);
  await mkdir(checkout, { recursive: true });
  await execFileAsync("git", ["init", "-b", "main", checkout]);
  await runGit(checkout, ["config", "user.name", "EZagent Test"]);
  await runGit(checkout, ["config", "user.email", "ezagent@example.invalid"]);
  await writeFile(join(checkout, "README.md"), "offline fixture\n", "utf8");
  await writeFile(join(checkout, "LICENSE"), "MIT fixture license\n", "utf8");
  await runGit(checkout, ["add", "README.md", "LICENSE"]);
  await runGit(checkout, ["commit", "-m", "fixture"]);
  await runGit(checkout, [
    "remote",
    "add",
    "origin",
    repository,
  ]);
  return { checkout, head: (await runGit(checkout, ["rev-parse", "HEAD"])).trim() };
}

function reviewedSourcesYaml(): string {
  return [
    "schemaVersion: 1",
    "sources:",
    "  - id: agency-agents",
    "    repository: https://github.com/msitarzewski/agency-agents",
    "    ref: refs/heads/main",
    "    checkout: vendor-sources/agency-agents",
    "    license: MIT",
    "  - id: agency-agents-zh",
    "    repository: https://github.com/jnMetaCode/agency-agents-zh",
    "    ref: refs/heads/main",
    "    checkout: vendor-sources/agency-agents-zh",
    "    license: MIT",
    "",
  ].join("\n");
}

function fixtureLicenseFile() {
  const bytes = Buffer.from("MIT fixture license\n", "utf8");
  const oid = createHash("sha1").update(Buffer.from(`blob ${bytes.length}\0`)).update(bytes).digest("hex");
  return createAttestedLicenseEntry("LICENSE", oid, bytes);
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
    if (process.platform === "win32"
      && code !== undefined
      && ["EACCES", "ENOSYS", "ENOTSUP", "EPERM"].includes(code)) {
      context.skip(`Windows symbolic links unavailable: ${code}`);
    }
    throw error;
  }
}

afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await Promise.all(temporaryRoots.splice(0).map(async (root) => rm(root, { force: true, recursive: true })));
});

describe("parseSourceCandidatesConfig", () => {
  it("parses the checked-in reviewed source candidates", async () => {
    const text = await readFile(new URL("../../catalog/sources.yaml", import.meta.url), "utf8");

    expect(parseSourceCandidatesYaml(text)).toEqual({
      schemaVersion: 1,
      sources: [
        validCandidate({ ref: "3f78a30" }),
        validCandidate({
          id: "agency-agents-zh",
          repository: "https://github.com/jnMetaCode/agency-agents-zh",
          checkout: "vendor-sources/agency-agents-zh",
          ref: "refs/heads/main",
        }),
      ],
    });
  });

  it.each([
    ["schemaVersion: 1\nschemaVersion: 1\nsources: []\n", "ambiguous"],
    [
      "schemaVersion: 1\nsource: &source { id: x }\nsources: [*source]\n",
      "ambiguous",
    ],
    ["---\nschemaVersion: 1\nsources: []\n---\nschemaVersion: 1\nsources: []\n", "ambiguous"],
  ])("rejects ambiguous YAML %#", (text, message) => {
    expect(() => parseSourceCandidatesYaml(text)).toThrow(message);
  });

  it("accepts and snapshots the strict reviewed-source document", () => {
    const input = { schemaVersion: 1, sources: [validCandidate()] };

    const parsed = parseSourceCandidatesConfig(input);
    (input.sources[0] as { ref: string }).ref = "changed-after-parse";

    expect(parsed).toEqual({ schemaVersion: 1, sources: [validCandidate()] });
    expectTypeOf(parsed.sources).toEqualTypeOf<readonly SourceCandidate[]>();
  });

  it.each([
    [{ sources: [validCandidate()] }, "schemaVersion"],
    [{ schemaVersion: 2, sources: [validCandidate()] }, "schemaVersion"],
    [{ schemaVersion: 1, sources: [validCandidate()], extra: true }, "unsupported"],
    [{ schemaVersion: 1, sources: [] }, "at least one"],
    [{ schemaVersion: 1, sources: [validCandidate({ license: "Apache-2.0" as "MIT" })] }, "MIT"],
    [{ schemaVersion: 1, sources: [validCandidate({ ref: "--upload-pack=evil" })] }, "ref"],
    [{ schemaVersion: 1, sources: [validCandidate({ ref: "HEAD" })] }, "ref"],
    [{ schemaVersion: 1, sources: [validCandidate({ ref: "main" })] }, "full refs/heads"],
    [{ schemaVersion: 1, sources: [validCandidate({ ref: "refs/tags/main" })] }, "full refs/heads"],
    [{ schemaVersion: 1, sources: [validCandidate({ ref: "abcdef" })] }, "7-40"],
    [{ schemaVersion: 1, sources: [validCandidate({ checkout: "vendor-sources/a/b" })] }, "checkout"],
    [{ schemaVersion: 1, sources: [validCandidate({ checkout: "vendor-sources/../escape" })] }, "checkout"],
    [{ schemaVersion: 1, sources: [validCandidate({ checkout: "vendor-sources\\agency-agents" })] }, "checkout"],
    [{ schemaVersion: 1, sources: [validCandidate({ checkout: "vendor-sources/%2e%2e" })] }, "checkout"],
    [{ schemaVersion: 1, sources: [validCandidate({ checkout: "vendor-sources/con" })] }, "Windows"],
    [{ schemaVersion: 1, sources: [validCandidate({ checkout: "vendor-sources/com1" })] }, "Windows"],
    [{ schemaVersion: 1, sources: [validCandidate({ repository: "http://github.com/org/repo" })] }, "repository"],
    [{ schemaVersion: 1, sources: [validCandidate({ repository: "https://github.com/org/repo.git" })] }, "repository"],
    [{ schemaVersion: 1, sources: [validCandidate({ repository: "https://github.com./org/repo" })] }, "repository"],
    [{ schemaVersion: 1, sources: [validCandidate({ repository: "https://github.com/%6frg/repo" })] }, "repository"],
  ])("rejects non-canonical input %#", (input, message) => {
    expect(() => parseSourceCandidatesConfig(input)).toThrow(message as string);
  });

  it("rejects duplicate ids, repositories, and checkouts before resolving", () => {
    const base = validCandidate();
    const other = validCandidate({
      id: "agency-agents-zh",
      repository: "https://github.com/jnmetacode/agency-agents-zh",
      checkout: "vendor-sources/agency-agents-zh",
    });
    for (const duplicate of [
      { ...other, id: base.id },
      { ...other, repository: base.repository },
      { ...other, checkout: base.checkout },
    ]) {
      expect(() => parseSourceCandidatesConfig({ schemaVersion: 1, sources: [base, duplicate] }))
        .toThrow("duplicate");
    }
  });

  it("rejects proxies, accessors, sparse arrays, extra candidate keys, and oversized arrays", () => {
    const proxy = new Proxy({ schemaVersion: 1, sources: [validCandidate()] }, {
      ownKeys: () => { throw new Error("trap must not run"); },
    });
    expect(() => parseSourceCandidatesConfig(proxy)).toThrow("Proxy");

    const accessor = { schemaVersion: 1 } as Record<string, unknown>;
    Object.defineProperty(accessor, "sources", { enumerable: true, get: () => [validCandidate()] });
    expect(() => parseSourceCandidatesConfig(accessor)).toThrow("accessor");

    const sparse = new Array<SourceCandidate>(1);
    expect(() => parseSourceCandidatesConfig({ schemaVersion: 1, sources: sparse })).toThrow("dense");

    expect(() => parseSourceCandidatesConfig({
      schemaVersion: 1,
      sources: [{ ...validCandidate(), extra: true }],
    })).toThrow("unsupported");

    const oversized = new Array<SourceCandidate>(65);
    expect(() => parseSourceCandidatesConfig({ schemaVersion: 1, sources: oversized })).toThrow("64");
  });
});

describe("createSourceLock", () => {
  it("resolves validated sources exactly once in deterministic id order", async () => {
    const calls: string[] = [];
    const lock = await createSourceLock([
      validCandidate({ id: "z-source", checkout: "vendor-sources/z-source" }),
      validCandidate({
        id: "a-source",
        repository: "https://github.com/example/a-source",
        checkout: "vendor-sources/a-source",
      }),
    ], async (checkout, candidate) => {
      calls.push(`${candidate.id}:${checkout}`);
      return candidate.id === "a-source" ? `${"a".repeat(40)}\n` : "b".repeat(40);
    });

    expect(calls).toEqual([
      "a-source:vendor-sources/a-source",
      "z-source:vendor-sources/z-source",
    ]);
    expect(lock.sources.map(({ id }) => id)).toEqual(["a-source", "z-source"]);
    expectTypeOf(lock).toEqualTypeOf<SourceLock>();
  });

  it.each([
    "abc",
    "A".repeat(40),
    "a".repeat(41),
    ` ${"a".repeat(40)}`,
    `${"a".repeat(40)} `,
    `${"a".repeat(40)}\n\n`,
    `${"a".repeat(40)}\nextra`,
  ])(
    "rejects an invalid resolved commit %j",
    async (commit) => {
      await expect(createSourceLock([validCandidate()], async () => commit))
        .rejects.toThrow("40-character lowercase commit SHA");
    },
  );

  it("validates every candidate before invoking the resolver", async () => {
    const resolver = vi.fn(async () => "a".repeat(40));
    await expect(createSourceLock([
      validCandidate(),
      validCandidate({ id: "BAD" }),
    ], resolver)).rejects.toThrow("id");
    expect(resolver).not.toHaveBeenCalled();
  });

  it("does not expose an untrusted resolver exception", async () => {
    const secret = new Error("SECRET RESOLVER DETAIL");
    await expect(createSourceLock([validCandidate()], async () => {
      throw secret;
    })).rejects.toSatisfy((error: Error & { code?: string; sourceId?: string; cause?: unknown }) =>
      error.code === "RESOLVER_FAILED"
      && error.sourceId === "agency-agents"
      && error.cause === secret
      && error.message.includes("could not be resolved")
      && !error.message.includes("SECRET"));
  });

  it("uses a stable code for an invalid resolved commit", async () => {
    await expect(createSourceLock([validCandidate()], async () => "abc"))
      .rejects.toMatchObject({ code: "INVALID_RESOLVED_COMMIT", sourceId: "agency-agents" });
  });
});

describe("resolveLocalCheckoutCommit", () => {
  it("proves a clean local checkout, canonical origin, ref, and HEAD without network commands", async () => {
    const root = await temporaryRoot();
    const { head } = await createLocalSource(root);
    const commands: readonly string[][] = [];
    const runner: GitRunner = async (args) => {
      (commands as string[][]).push([...args]);
      const { stdout } = await execFileAsync("git", [...args], { encoding: "utf8" });
      return stdout;
    };

    await expect(resolveLocalCheckoutCommit(root, validCandidate(), runner)).resolves.toBe(head);
    expect(commands.length).toBeGreaterThanOrEqual(6);
    expect(commands.every((args) => args[0] === "-C")).toBe(true);
    expect(commands.every((args) => args.includes("--no-optional-locks"))).toBe(true);
    expect(commands.every((args) => args.includes("--no-replace-objects"))).toBe(true);
    expect(commands.every((args) => args.includes("protocol.allow=never"))).toBe(true);
    expect(commands.every((args) => args.includes("gc.auto=0"))).toBe(true);
    expect(commands.every((args) => args.includes("maintenance.auto=false"))).toBe(true);
    expect(commands.filter((args) => args.includes("rev-parse") && args.includes("--verify"))
      .every((args) => args.includes("--end-of-options"))).toBe(true);
    expect(commands.find((args) => args.includes("status"))).toContain("--ignored=matching");
    const configIndex = commands.findIndex((args) => args.includes("config"));
    const firstDangerousIndex = commands.findIndex((args) =>
      args.includes("status") || args.includes("diff-files") || args.includes("fsck"));
    expect(configIndex).toBeGreaterThanOrEqual(0);
    expect(firstDangerousIndex).toBeGreaterThan(configIndex);
    expect(commands.flat()).not.toContain("fetch");
    expect(commands.flat()).not.toContain("pull");
    expect(commands.flat()).not.toContain("clone");
    expect(commands.flat()).not.toContain("ls-remote");
  });

  it("rejects a non-Git checkout and does not leak Git stderr", async () => {
    const root = await temporaryRoot();
    await mkdir(join(root, "vendor-sources", "agency-agents"), { recursive: true });

    await expect(resolveLocalCheckoutCommit(root, validCandidate())).rejects.toMatchObject({
      code: "NOT_GIT_WORKTREE",
      sourceId: "agency-agents",
    });
  });

  it("rejects a mismatched origin", async () => {
    const root = await temporaryRoot();
    const { checkout } = await createLocalSource(root);
    await runGit(checkout, ["remote", "set-url", "origin", "https://github.com/example/wrong"]);

    await expect(resolveLocalCheckoutCommit(root, validCandidate())).rejects.toMatchObject({
      code: "ORIGIN_MISMATCH",
      sourceId: "agency-agents",
    });
  });

  it("does not normalize whitespace in the checkout origin URL", async () => {
    const root = await temporaryRoot();
    const { checkout } = await createLocalSource(root);
    await runGit(checkout, [
      "remote",
      "set-url",
      "origin",
      "https://github.com/msitarzewski/agency-agents ",
    ]);

    await expect(resolveLocalCheckoutCommit(root, validCandidate())).rejects.toThrow("origin");
  });

  it("rejects tracked or untracked dirt and a ref that does not equal HEAD", async () => {
    const dirtyRoot = await temporaryRoot();
    const { checkout } = await createLocalSource(dirtyRoot);
    await writeFile(join(checkout, "UNTRACKED"), "dirty\n", "utf8");
    await expect(resolveLocalCheckoutCommit(dirtyRoot, validCandidate())).rejects.toMatchObject({
      code: "WORKTREE_DIRTY",
      sourceId: "agency-agents",
    });

    const refRoot = await temporaryRoot();
    const source = await createLocalSource(refRoot);
    await runGit(source.checkout, ["branch", "reviewed"]);
    await writeFile(join(source.checkout, "README.md"), "second commit\n", "utf8");
    await runGit(source.checkout, ["add", "README.md"]);
    await runGit(source.checkout, ["commit", "-m", "second"]);
    await expect(resolveLocalCheckoutCommit(refRoot, validCandidate({ ref: "refs/heads/reviewed" })))
      .rejects.toMatchObject({ code: "REF_MISMATCH", sourceId: "agency-agents" });
  });

  it("removes inherited Git environment configuration before invoking real Git", async () => {
    const root = await temporaryRoot();
    const source = await createLocalSource(root);
    const poisonRoot = await temporaryRoot();
    const poison = await createLocalSource(poisonRoot);
    const globalConfig = join(poisonRoot, "global.gitconfig");
    await writeFile(globalConfig, "[remote \"origin\"]\n\turl = https://github.com/example/poison\n", "utf8");
    vi.stubEnv("GIT_DIR", join(poison.checkout, ".git"));
    vi.stubEnv("GIT_WORK_TREE", poison.checkout);
    vi.stubEnv("GIT_INDEX_FILE", join(poison.checkout, ".git", "index"));
    vi.stubEnv("GIT_CONFIG_GLOBAL", globalConfig);
    vi.stubEnv("GIT_CONFIG_COUNT", "1");
    vi.stubEnv("GIT_CONFIG_KEY_0", "remote.origin.url");
    vi.stubEnv("GIT_CONFIG_VALUE_0", "https://github.com/example/injected");

    await expect(resolveLocalCheckoutCommit(root, validCandidate())).resolves.toBe(source.head);
  });

  it("rejects executable local filter configuration before Git can run the filter", async () => {
    const root = await temporaryRoot();
    const source = await createLocalSource(root);
    await writeFile(join(source.checkout, ".gitattributes"), "README.md filter=proof\n", "utf8");
    await runGit(source.checkout, ["add", ".gitattributes"]);
    await runGit(source.checkout, ["commit", "-m", "declare filter attribute"]);
    const marker = join(root, "FILTER_EXECUTED");
    const filterCommand = [
      JSON.stringify(process.execPath),
      "-e",
      JSON.stringify("require('node:fs').writeFileSync(process.argv[1], 'executed')"),
      JSON.stringify(marker),
    ].join(" ");
    await runGit(source.checkout, ["config", "filter.proof.clean", filterCommand]);
    await runGit(source.checkout, ["config", "filter.proof.required", "true"]);

    await expect(resolveLocalCheckoutCommit(root, validCandidate()))
      .rejects.toMatchObject({ code: "CONFIG_UNSAFE", sourceId: "agency-agents" });
    await expect(readFile(marker, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it.each([
    ["diff.proof.command", "untrusted-command"],
    ["diff.proof.textconv", "untrusted-command"],
    ["core.hooksPath", "untrusted-hooks"],
    ["core.fsmonitor", "untrusted-command"],
    ["core.alternateRefsCommand", "untrusted-command"],
    ["fsck.skipList", "untrusted-skip-list"],
    ["protocol.file.allow", "always"],
    ["maintenance.auto", "true"],
    ["gc.auto", "1"],
    ["include.path", "untrusted-include"],
  ])("rejects local Git verification override %s", async (key, value) => {
    const root = await temporaryRoot();
    const source = await createLocalSource(root);
    await runGit(source.checkout, ["config", key, value]);

    await expect(resolveLocalCheckoutCommit(root, validCandidate()))
      .rejects.toMatchObject({ code: "CONFIG_UNSAFE", sourceId: "agency-agents" });
  });

  it("rejects a local config snapshot changed after object verification", async () => {
    const root = await temporaryRoot();
    const source = await createLocalSource(root);
    let fsckCount = 0;
    const runner: GitRunner = async (args) => {
      const { stdout } = await execFileAsync("git", [...args], { encoding: "utf8" });
      if (args.includes("fsck") && ++fsckCount === 1) {
        await runGit(source.checkout, ["config", "user.provenance-audit", "changed"]);
      }
      return stdout;
    };

    await expect(resolveLocalCheckoutCommit(root, validCandidate(), runner))
      .rejects.toMatchObject({ code: "CONFIG_CHANGED", sourceId: "agency-agents" });
  });

  it("sanitizes an unknown runner failure while retaining it as the cause", async () => {
    const root = await temporaryRoot();
    await createLocalSource(root);
    const secret = new Error("SECRET RUNNER STDERR /private/path");

    await expect(resolveLocalCheckoutCommit(root, validCandidate(), async () => {
      throw secret;
    })).rejects.toSatisfy((error: Error & { code?: string; cause?: unknown }) =>
      error.code === "GIT_COMMAND_FAILED"
      && error.cause === secret
      && !error.message.includes("SECRET")
      && !error.message.includes("/private/path"));
  });

  it("rejects assume-unchanged and skip-worktree index flags", async () => {
    const assumeRoot = await temporaryRoot();
    const assume = await createLocalSource(assumeRoot);
    await runGit(assume.checkout, ["update-index", "--assume-unchanged", "README.md"]);
    await writeFile(join(assume.checkout, "README.md"), "hidden modification\n", "utf8");
    await expect(resolveLocalCheckoutCommit(assumeRoot, validCandidate()))
      .rejects.toMatchObject({ code: "INDEX_FLAGS_UNSAFE" });

    const skipRoot = await temporaryRoot();
    const skip = await createLocalSource(skipRoot);
    await runGit(skip.checkout, ["update-index", "--skip-worktree", "README.md"]);
    await expect(resolveLocalCheckoutCommit(skipRoot, validCandidate()))
      .rejects.toMatchObject({ code: "INDEX_FLAGS_UNSAFE" });
  });

  it("rejects sparse and partial/promisor repository configuration", async () => {
    const sparseRoot = await temporaryRoot();
    const sparse = await createLocalSource(sparseRoot);
    await runGit(sparse.checkout, ["sparse-checkout", "init", "--cone"]);
    await expect(resolveLocalCheckoutCommit(sparseRoot, validCandidate()))
      .rejects.toMatchObject({ code: "SPARSE_CHECKOUT_UNSUPPORTED" });

    const partialRoot = await temporaryRoot();
    const partial = await createLocalSource(partialRoot);
    await runGit(partial.checkout, ["config", "core.repositoryFormatVersion", "1"]);
    await runGit(partial.checkout, ["config", "extensions.partialClone", "origin"]);
    await runGit(partial.checkout, ["config", "remote.origin.promisor", "true"]);
    await expect(resolveLocalCheckoutCommit(partialRoot, validCandidate()))
      .rejects.toMatchObject({ code: "PARTIAL_CLONE_UNSUPPORTED" });

    const promisorRoot = await temporaryRoot();
    const promisor = await createLocalSource(promisorRoot);
    await writeFile(join(promisor.checkout, ".git", "objects", "pack", "fixture.promisor"), "", "utf8");
    await expect(resolveLocalCheckoutCommit(promisorRoot, validCandidate()))
      .rejects.toMatchObject({ code: "PARTIAL_CLONE_UNSUPPORTED" });
  });

  it.each([false, true])("rejects %s packed replacement refs under original-object semantics", async (packed) => {
    const root = await temporaryRoot();
    const source = await createLocalSource(root);
    await writeFile(join(source.checkout, "README.md"), "replacement tree\n", "utf8");
    await runGit(source.checkout, ["add", "README.md"]);
    await runGit(source.checkout, ["commit", "-m", "replacement commit"]);
    const replacement = (await runGit(source.checkout, ["rev-parse", "HEAD"])).trim();
    await runGit(source.checkout, ["replace", source.head, replacement]);
    await runGit(source.checkout, ["reset", "--hard", source.head]);
    if (packed) await runGit(source.checkout, ["pack-refs", "--all", "--prune"]);

    await expect(resolveLocalCheckoutCommit(root, validCandidate()))
      .rejects.toMatchObject({ code: "REPLACE_REFS_UNSUPPORTED", sourceId: "agency-agents" });
  });

  it("rejects legacy grafts from the actual local Git metadata directory", async () => {
    const root = await temporaryRoot();
    const source = await createLocalSource(root);
    await writeFile(join(source.checkout, ".git", "info", "grafts"), `${source.head}\n`, "utf8");

    await expect(resolveLocalCheckoutCommit(root, validCandidate()))
      .rejects.toMatchObject({ code: "GRAFTS_UNSUPPORTED", sourceId: "agency-agents" });
  });

  it("rejects tracked symbolic links", async (context) => {
    const symlinkRoot = await temporaryRoot();
    const symlinkSource = await createLocalSource(symlinkRoot);
    await runGit(symlinkSource.checkout, ["config", "core.symlinks", "true"]);
    await symlinkOrSkip(context, "README.md", join(symlinkSource.checkout, "LINK.md"), "file");
    await runGit(symlinkSource.checkout, ["add", "LINK.md"]);
    await runGit(symlinkSource.checkout, ["commit", "-m", "tracked symlink"]);
    await expect(resolveLocalCheckoutCommit(symlinkRoot, validCandidate()))
      .rejects.toMatchObject({ code: "TRACKED_SYMLINK_UNSUPPORTED" });
  });

  it("rejects gitlinks without requiring symbolic-link privileges", async () => {
    const gitlinkRoot = await temporaryRoot();
    const gitlink = await createLocalSource(gitlinkRoot);
    await runGit(gitlink.checkout, [
      "update-index",
      "--add",
      "--cacheinfo",
      "160000",
      gitlink.head,
      "dependency",
    ]);
    await runGit(gitlink.checkout, ["commit", "-m", "gitlink"]);
    await expect(resolveLocalCheckoutCommit(gitlinkRoot, validCandidate()))
      .rejects.toMatchObject({ code: "GITLINK_UNSUPPORTED" });
  });

  it("rejects a checkout with a missing reachable object", async () => {
    const root = await temporaryRoot();
    const source = await createLocalSource(root);
    const blob = (await runGit(source.checkout, ["rev-parse", "HEAD:README.md"])).trim();
    const objectPath = join(source.checkout, ".git", "objects", blob.slice(0, 2), blob.slice(2));
    await rename(objectPath, `${objectPath}.missing`);

    await expect(resolveLocalCheckoutCommit(root, validCandidate()))
      .rejects.toMatchObject({ code: "OBJECTS_INCOMPLETE" });
  });

  it("rejects a checkout with a corrupt reachable object", async () => {
    const root = await temporaryRoot();
    const source = await createLocalSource(root);
    const blob = (await runGit(source.checkout, ["rev-parse", "HEAD:README.md"])).trim();
    const objectPath = join(source.checkout, ".git", "objects", blob.slice(0, 2), blob.slice(2));
    await rm(objectPath);
    await writeFile(objectPath, "corrupt loose object", "utf8");

    await expect(resolveLocalCheckoutCommit(root, validCandidate()))
      .rejects.toMatchObject({ code: "OBJECTS_INCOMPLETE" });
  });

  it("uses an exact full branch ref even when a tag has the same name", async () => {
    const root = await temporaryRoot();
    const source = await createLocalSource(root);
    await runGit(source.checkout, ["tag", "main"]);

    await expect(resolveLocalCheckoutCommit(root, validCandidate({ ref: "refs/heads/main" })))
      .resolves.toBe(source.head);
  });

  it("rejects a detached checkout at an old tag instead of treating the tag as the branch", async () => {
    const root = await temporaryRoot();
    const source = await createLocalSource(root);
    await runGit(source.checkout, ["tag", "reviewed-old"]);
    await writeFile(join(source.checkout, "README.md"), "new branch head\n", "utf8");
    await runGit(source.checkout, ["add", "README.md"]);
    await runGit(source.checkout, ["commit", "-m", "advance branch"]);
    await runGit(source.checkout, ["checkout", "--detach", "refs/tags/reviewed-old"]);

    await expect(resolveLocalCheckoutCommit(root, validCandidate({ ref: "refs/heads/main" })))
      .rejects.toMatchObject({ code: "REF_MISMATCH", sourceId: "agency-agents" });
  });

  it("accepts a unique lowercase commit prefix and rejects a stale prefix", async () => {
    const root = await temporaryRoot();
    const source = await createLocalSource(root);
    await expect(resolveLocalCheckoutCommit(root, validCandidate({ ref: source.head.slice(0, 7) })))
      .resolves.toBe(source.head);

    const oldHead = source.head;
    await writeFile(join(source.checkout, "README.md"), "new head\n", "utf8");
    await runGit(source.checkout, ["add", "README.md"]);
    await runGit(source.checkout, ["commit", "-m", "new head"]);
    await expect(resolveLocalCheckoutCommit(root, validCandidate({ ref: oldHead.slice(0, 7) })))
      .rejects.toMatchObject({ code: "REF_MISMATCH", sourceId: "agency-agents" });
  });

  it("reports unborn HEAD and a missing full branch ref separately", async () => {
    const unbornRoot = await temporaryRoot();
    const unbornCheckout = join(unbornRoot, "vendor-sources", "agency-agents");
    await mkdir(unbornCheckout, { recursive: true });
    await execFileAsync("git", ["init", "-b", "main", unbornCheckout]);
    await runGit(unbornCheckout, [
      "remote", "add", "origin", "https://github.com/msitarzewski/agency-agents",
    ]);
    await expect(resolveLocalCheckoutCommit(unbornRoot, validCandidate()))
      .rejects.toMatchObject({ code: "HEAD_UNRESOLVED", sourceId: "agency-agents" });

    const missingRoot = await temporaryRoot();
    await createLocalSource(missingRoot);
    await expect(resolveLocalCheckoutCommit(
      missingRoot,
      validCandidate({ ref: "refs/heads/missing" }),
    )).rejects.toMatchObject({ code: "REF_UNRESOLVED", sourceId: "agency-agents" });
  });

  it("fails closed when the checkout directory is replaced after final verification", async () => {
    const root = await temporaryRoot();
    const source = await createLocalSource(root);
    const replacementRoot = await temporaryRoot();
    const replacement = await createLocalSource(replacementRoot);
    const stagedReplacement = join(root, "replacement-checkout");
    await rename(replacement.checkout, stagedReplacement);
    let fsckCount = 0;
    const runner: GitRunner = async (args) => {
      const { stdout } = await execFileAsync("git", [...args], { encoding: "utf8" });
      if (args.includes("fsck") && ++fsckCount === 2) {
        await rename(source.checkout, join(root, "replaced-checkout"));
        await rename(stagedReplacement, source.checkout);
      }
      return stdout;
    };

    await expect(resolveLocalCheckoutCommit(root, validCandidate(), runner))
      .rejects.toMatchObject({ code: "CHECKOUT_CHANGED", sourceId: "agency-agents" });
  });

  it("detects a worktree modification made after the second object verification", async () => {
    const root = await temporaryRoot();
    const source = await createLocalSource(root);
    let fsckCount = 0;
    const runner: GitRunner = async (args) => {
      const { stdout } = await execFileAsync("git", [...args], { encoding: "utf8" });
      if (args.includes("fsck") && ++fsckCount === 2) {
        await writeFile(join(source.checkout, "README.md"), "modified after final fsck\n", "utf8");
      }
      return stdout;
    };

    await expect(resolveLocalCheckoutCommit(root, validCandidate(), runner))
      .rejects.toMatchObject({ code: "WORKTREE_DIRTY", sourceId: "agency-agents" });
  });

  it("rejects a checkout reached through a symbolic-link directory", async (context) => {
    const root = await temporaryRoot();
    const outside = await temporaryRoot();
    await createLocalSource(outside);
    await symlinkOrSkip(
      context,
      join(outside, "vendor-sources"),
      join(root, "vendor-sources"),
      "dir",
    );

    await expect(resolveLocalCheckoutCommit(root, validCandidate())).rejects.toThrow("symbolic link");
  });

  it("rejects a symbolic-link Git metadata directory", async (context) => {
    const root = await temporaryRoot();
    const source = await createLocalSource(root);
    const realGitDirectory = join(root, "real-git-directory");
    await rename(join(source.checkout, ".git"), realGitDirectory);
    await symlinkOrSkip(context, realGitDirectory, join(source.checkout, ".git"), "dir");

    await expect(resolveLocalCheckoutCommit(root, validCandidate()))
      .rejects.toMatchObject({ code: "GIT_METADATA_UNSAFE", sourceId: "agency-agents" });
  });
});

describe("source lock file", () => {
  const lock: SourceLock = {
    schemaVersion: 1,
    sources: [{
      id: "agency-agents",
      repository: "https://github.com/msitarzewski/agency-agents",
      license: "MIT",
      commit: "a".repeat(40),
    }],
  };

  it("serializes deterministic indented JSON with one LF", () => {
    const serialized = serializeSourceLock(lock);
    expect(serialized).toBe(`${JSON.stringify(lock, null, 2)}\n`);
    expect(serialized.endsWith("\n\n")).toBe(false);
  });

  it("uses one portable manifest contract for producer and consumer path validation", () => {
    const bytes = Buffer.from("reviewed\n");
    const entry = {
      path: "README.md",
      oid: createHash("sha1").update(Buffer.from(`blob ${bytes.length}\0`)).update(bytes).digest("hex"),
      size: bytes.length,
      sha256: `sha256:${createHash("sha256").update(bytes).digest("hex")}`,
      normalizedSize: bytes.length,
      normalizedSha256: `sha256:${createHash("sha256").update(bytes).digest("hex")}`,
    };
    const reviewed: AttestedSourceLock = {
      schemaVersion: 2,
      sources: [
        { id: "agency-agents", repository: "https://github.com/msitarzewski/agency-agents", license: "MIT", commit: "a".repeat(40), tree: "b".repeat(40), objectFormat: "sha1", licenseFile: fixtureLicenseFile(), markdown: [entry] },
        { id: "agency-agents-zh", repository: "https://github.com/jnMetaCode/agency-agents-zh", license: "MIT", commit: "c".repeat(40), tree: "d".repeat(40), objectFormat: "sha1", licenseFile: fixtureLicenseFile(), markdown: [entry] },
      ],
    };
    const serialized = serializeSourceLock(reviewed);
    expect(parseSourceLockJson(serialized).sourcesById["agency-agents"].markdown[0]).toEqual(entry);

    for (const invalidPath of ["bad:name.md", "bad\u0001name.md", "folder/CON.md", "folder/file.MD", "folder/cafe\u0301.md"]) {
      const invalid = structuredClone(reviewed) as AttestedSourceLock;
      (invalid.sources[0]!.markdown[0] as { path: string }).path = invalidPath;
      expect(() => serializeSourceLock(invalid)).toThrow(/path|manifest/iu);
    }
    const collision = structuredClone(reviewed) as AttestedSourceLock;
    (collision.sources[0] as { markdown: unknown }).markdown = [
      { ...entry, path: "folder/Straße.md" },
      { ...entry, path: "folder/STRAẞE.md" },
    ];
    expect(() => serializeSourceLock(collision)).toThrow(/duplicate|collision/iu);
  });

  it("keeps raw Git identity while attesting single-BOM CRLF canonical Markdown separately", () => {
    const raw = Buffer.from("\uFEFF第一行\r\n第二行\r\n", "utf8");
    const oid = createHash("sha1").update(Buffer.from(`blob ${raw.length}\0`)).update(raw).digest("hex");
    const entry = createAttestedMarkdownEntry("design/researcher.md", oid, raw);
    const normalized = Buffer.from("第一行\n第二行\n", "utf8");
    expect(entry).toEqual({
      path: "design/researcher.md",
      oid,
      size: raw.length,
      sha256: `sha256:${createHash("sha256").update(raw).digest("hex")}`,
      normalizedSize: normalized.length,
      normalizedSha256: `sha256:${createHash("sha256").update(normalized).digest("hex")}`,
    });
  });

  it("attests exact bounded LICENSE Git blob bytes", () => {
    const raw = Buffer.from("MIT fixture license\n", "utf8");
    const oid = createHash("sha1").update(Buffer.from(`blob ${raw.length}\0`)).update(raw).digest("hex");
    expect(createAttestedLicenseEntry("LICENSE", oid, raw)).toEqual({
      path: "LICENSE",
      oid,
      size: raw.length,
      sha256: `sha256:${createHash("sha256").update(raw).digest("hex")}`,
    });
    expect(() => createAttestedLicenseEntry("LICENSE.md", oid, raw)).toThrow(/LICENSE/u);
    expect(() => createAttestedLicenseEntry("LICENSE", "a".repeat(40), raw)).toThrow(/blob|oid/iu);
  });

  it.each([
    Buffer.from("\uFEFF\uFEFF重复 BOM\n", "utf8"),
    Buffer.from("裸回车\r不允许\n", "utf8"),
    Buffer.from([0xff, 0xfe]),
  ])("rejects a non-canonical reviewed Markdown blob %#", (raw) => {
    const oid = createHash("sha1").update(Buffer.from(`blob ${raw.length}\0`)).update(raw).digest("hex");
    expect(() => createAttestedMarkdownEntry("design/researcher.md", oid, raw)).toThrow();
  });

  it("rejects an over-budget v2 lock identically before producer serialization or consumer parsing", () => {
    const bytes = Buffer.from("x\n");
    const base = {
      oid: createHash("sha1").update(Buffer.from(`blob ${bytes.length}\0`)).update(bytes).digest("hex"),
      size: bytes.length,
      sha256: `sha256:${createHash("sha256").update(bytes).digest("hex")}`,
      normalizedSize: bytes.length,
      normalizedSha256: `sha256:${createHash("sha256").update(bytes).digest("hex")}`,
    };
    const markdown = Array.from({ length: 3_000 }, (_, index) => ({
      ...base,
      path: `engineering/${"a".repeat(200)}/${"b".repeat(200)}/${"c".repeat(200)}/${String(index).padStart(4, "0")}.md`,
    }));
    const oversized: SourceLock = {
      schemaVersion: 2,
      sources: [
        { id: "agency-agents", repository: "https://github.com/msitarzewski/agency-agents", license: "MIT", commit: "a".repeat(40), tree: "b".repeat(40), objectFormat: "sha1", licenseFile: fixtureLicenseFile(), markdown },
        { id: "agency-agents-zh", repository: "https://github.com/jnMetaCode/agency-agents-zh", license: "MIT", commit: "c".repeat(40), tree: "d".repeat(40), objectFormat: "sha1", licenseFile: fixtureLicenseFile(), markdown: [] },
      ],
    };
    const raw = `${JSON.stringify(oversized)}\n`;
    expect(Buffer.byteLength(raw)).toBeGreaterThan(2 * 1_048_576);
    expect(() => serializeSourceLock(oversized)).toThrow(/large|budget/iu);
    expect(() => parseSourceLockJson(raw)).toThrow(/large|budget/iu);
  });

  it("rejects a v2 manifest above the shared entry-count budget", () => {
    const bytes = Buffer.from("x\n");
    const base = {
      oid: createHash("sha1").update(Buffer.from(`blob ${bytes.length}\0`)).update(bytes).digest("hex"),
      size: bytes.length,
      sha256: `sha256:${createHash("sha256").update(bytes).digest("hex")}`,
      normalizedSize: bytes.length,
      normalizedSha256: `sha256:${createHash("sha256").update(bytes).digest("hex")}`,
    };
    const markdown = Array.from({ length: 4_097 }, (_, index) => ({ ...base, path: `x/${index}.md` }));
    const lock = {
      schemaVersion: 2,
      sources: [
        { id: "agency-agents", repository: "https://github.com/msitarzewski/agency-agents", license: "MIT", commit: "a".repeat(40), tree: "b".repeat(40), objectFormat: "sha1", licenseFile: fixtureLicenseFile(), markdown },
        { id: "agency-agents-zh", repository: "https://github.com/jnMetaCode/agency-agents-zh", license: "MIT", commit: "c".repeat(40), tree: "d".repeat(40), objectFormat: "sha1", licenseFile: fixtureLicenseFile(), markdown: [] },
      ],
    } as SourceLock;
    expect(() => serializeSourceLock(lock)).toThrow(/entry|manifest|budget/iu);
  });

  it("atomically creates once, refuses no-clobber races, and conservatively retains staging names", async () => {
    const root = await temporaryRoot();
    const target = join(root, "sources.lock.json");
    const runtime: SourceLockPublishRuntime = {
      ...nodeSourceLockPublishRuntime,
      syncDirectory: async () => "synced",
    };
    const results = await Promise.allSettled([
      writeSourceLockFile(target, lock, runtime),
      writeSourceLockFile(target, lock, runtime),
    ]);

    expect(results.filter(({ status }) => status === "fulfilled")).toHaveLength(1);
    expect(results.filter(({ status }) => status === "rejected")).toHaveLength(1);
    expect(results.find(({ status }) => status === "fulfilled")).toMatchObject({
      value: {
        published: true,
        warnings: [{ code: "TEMPORARY_RETAINED" }],
      },
    });
    expect(results.find(({ status }) => status === "rejected")).toMatchObject({
      reason: { code: "LOCK_EXISTS", publicationState: "not-published" },
    });
    expect(await readFile(target, "utf8")).toBe(serializeSourceLock(lock));
    expect((await readdir(root)).filter((name) => name.includes("ezagent-source-lock"))).toHaveLength(2);
  });

  it("syncs the parent directory after publication through the runtime seam", async () => {
    const root = await temporaryRoot();
    const syncDirectory = vi.fn(async () => "synced" as const);
    const runtime: SourceLockPublishRuntime = {
      ...nodeSourceLockPublishRuntime,
      syncDirectory,
    };

    const result = await writeSourceLockFile(join(root, "sources.lock.json"), lock, runtime);

    expect(result).toEqual({
      published: true,
      warnings: [{ code: "TEMPORARY_RETAINED", message: expect.stringContaining("retained") }],
    });
    expect(syncDirectory).toHaveBeenCalledExactlyOnceWith(root);
  });

  it("reports unsupported parent-directory sync as a visible published warning", async () => {
    const root = await temporaryRoot();
    const runtime: SourceLockPublishRuntime = {
      ...nodeSourceLockPublishRuntime,
      syncDirectory: async () => "unsupported",
    };

    const result = await writeSourceLockFile(join(root, "sources.lock.json"), lock, runtime);

    expect(result).toEqual({
      published: true,
      warnings: [{
        code: "DIRECTORY_SYNC_UNSUPPORTED",
        message: expect.stringContaining("not supported"),
      }, { code: "TEMPORARY_RETAINED", message: expect.stringContaining("retained") }],
    });
  });

  it("reports a genuine parent-directory sync failure without denying publication", async () => {
    const root = await temporaryRoot();
    const target = join(root, "sources.lock.json");
    const runtime: SourceLockPublishRuntime = {
      ...nodeSourceLockPublishRuntime,
      syncDirectory: async () => {
        throw Object.assign(new Error("simulated durability failure"), { code: "EIO" });
      },
    };

    const result = await writeSourceLockFile(target, lock, runtime);

    expect(result).toEqual({
      published: true,
      warnings: [{
        code: "DIRECTORY_SYNC_FAILED",
        message: expect.stringContaining("durability could not be confirmed"),
      }, { code: "TEMPORARY_RETAINED", message: expect.stringContaining("retained") }],
    });
    expect(await readFile(target, "utf8")).toBe(serializeSourceLock(lock));
  });

  it("never path-unlinks a retained staging name after successful publication", async () => {
    const root = await temporaryRoot();
    const target = join(root, "sources.lock.json");
    const remove = vi.fn(nodeSourceLockPublishRuntime.remove);
    const runtime: SourceLockPublishRuntime = {
      ...nodeSourceLockPublishRuntime,
      remove,
      syncDirectory: async () => "synced",
    };

    const result = await writeSourceLockFile(target, lock, runtime);

    expect(result).toEqual({
      published: true,
      warnings: [{ code: "TEMPORARY_RETAINED", message: expect.stringContaining("retained") }],
    });
    expect(remove).not.toHaveBeenCalled();
    expect(await readFile(target, "utf8")).toBe(serializeSourceLock(lock));
  });

  it("fails before linking when the parent directory identity changes", async () => {
    const root = await temporaryRoot();
    const other = await temporaryRoot();
    const target = join(root, "sources.lock.json");
    let parentObservations = 0;
    const runtime: SourceLockPublishRuntime = {
      ...nodeSourceLockPublishRuntime,
      lstat: async (path) => {
        if (path === root && ++parentObservations === 2) return lstat(other);
        return nodeSourceLockPublishRuntime.lstat(path);
      },
    };

    await expect(writeSourceLockFile(target, lock, runtime))
      .rejects.toMatchObject({ code: "LOCK_PARENT_CHANGED", publicationState: "not-published" });
    await expect(readFile(target, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    expect((await readdir(root)).filter((name) => name.includes("ezagent-source-lock"))).toHaveLength(1);
  });

  it("does not misreport a published lock as unpublished when the final parent observation fails", async () => {
    const root = await temporaryRoot();
    const target = join(root, "sources.lock.json");
    const observationFailure = Object.assign(new Error("simulated final observation failure"), {
      code: "EIO",
    });
    let parentObservations = 0;
    const runtime: SourceLockPublishRuntime = {
      ...nodeSourceLockPublishRuntime,
      lstat: async (path) => {
        if (path === root && ++parentObservations === 3) throw observationFailure;
        return nodeSourceLockPublishRuntime.lstat(path);
      },
    };

    await expect(writeSourceLockFile(target, lock, runtime)).rejects.toMatchObject({
      code: "LOCK_PARENT_CHANGED",
      publicationState: "unknown",
      cause: observationFailure,
      message: expect.stringContaining("do not rerun or overwrite blindly"),
    });
    expect(await readFile(target, "utf8")).toBe(serializeSourceLock(lock));
  });

  it("preserves the target and marks state unknown when the parent changes after link", async () => {
    const root = await temporaryRoot();
    const other = await temporaryRoot();
    const target = join(root, "sources.lock.json");
    const remove = vi.fn(nodeSourceLockPublishRuntime.remove);
    let parentObservations = 0;
    const runtime: SourceLockPublishRuntime = {
      ...nodeSourceLockPublishRuntime,
      remove,
      lstat: async (path) => {
        if (path === root && ++parentObservations === 3) return lstat(other);
        return nodeSourceLockPublishRuntime.lstat(path);
      },
    };

    await expect(writeSourceLockFile(target, lock, runtime)).rejects.toMatchObject({
      code: "LOCK_PARENT_CHANGED",
      publicationState: "unknown",
    });
    expect(remove).not.toHaveBeenCalled();
    expect(await readFile(target, "utf8")).toBe(serializeSourceLock(lock));
  });

  it("marks a post-link staging-file ABA replacement unknown without deleting its target", async () => {
    const root = await temporaryRoot();
    const target = join(root, "sources.lock.json");
    const attack = "{\"schemaVersion\":1,\"sources\":[]}\n";
    const runtime: SourceLockPublishRuntime = {
      ...nodeSourceLockPublishRuntime,
      link: async (temporary, destination) => {
        await rm(temporary);
        await writeFile(temporary, attack, "utf8");
        await nodeSourceLockPublishRuntime.link(temporary, destination);
      },
    };

    await expect(writeSourceLockFile(target, lock, runtime)).rejects.toMatchObject({
      code: "LOCK_STAGING_CHANGED",
      publicationState: "unknown",
    });
    expect(await readFile(target, "utf8")).toBe(attack);
  });

  it("verifies published bytes when staging content changes through the same inode", async () => {
    const root = await temporaryRoot();
    const target = join(root, "sources.lock.json");
    const attack = serializeSourceLock(lock).replace("a".repeat(40), "b".repeat(40));
    const runtime: SourceLockPublishRuntime = {
      ...nodeSourceLockPublishRuntime,
      link: async (temporary, destination) => {
        await nodeSourceLockPublishRuntime.link(temporary, destination);
        await writeFile(temporary, attack, "utf8");
      },
    };

    await expect(writeSourceLockFile(target, lock, runtime)).rejects.toMatchObject({
      code: "LOCK_STAGING_CHANGED",
      publicationState: "unknown",
    });
    expect(await readFile(target, "utf8")).toBe(attack);
  });

  it("preserves a competing publication B after link-time target verification becomes stale", async () => {
    const root = await temporaryRoot();
    const target = join(root, "sources.lock.json");
    const original = join(root, "publication-a.backup");
    const competing = "competing publication B\n";
    const remove = vi.fn(nodeSourceLockPublishRuntime.remove);
    const runtime: SourceLockPublishRuntime = {
      ...nodeSourceLockPublishRuntime,
      remove,
      inspectFileNoFollow: async (path, maxBytes) => {
        const inspection = await nodeSourceLockPublishRuntime.inspectFileNoFollow(path, maxBytes);
        await rename(target, original);
        await writeFile(target, competing, "utf8");
        return { ...inspection, content: "stale publication A" };
      },
    };

    await expect(writeSourceLockFile(target, lock, runtime)).rejects.toMatchObject({
      code: "LOCK_STAGING_CHANGED",
      publicationState: "unknown",
    });
    expect(remove).not.toHaveBeenCalled();
    expect(await readFile(target, "utf8")).toBe(competing);
    expect(await readFile(original, "utf8")).toBe(serializeSourceLock(lock));
  });

  it("marks an invoked link failure unknown even when no target is observable", async () => {
    const root = await temporaryRoot();
    const target = join(root, "sources.lock.json");
    const failure = Object.assign(new Error("simulated link failure"), { code: "EIO" });
    const runtime: SourceLockPublishRuntime = {
      ...nodeSourceLockPublishRuntime,
      link: async () => { throw failure; },
    };

    await expect(writeSourceLockFile(target, lock, runtime))
      .rejects.toMatchObject({
        code: "LOCK_PUBLISH_FAILED",
        publicationState: "unknown",
        cause: failure,
        temporaryState: "retained",
      });
    await expect(readFile(target, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    expect((await readdir(root)).filter((name) => name.includes("ezagent-source-lock"))).toHaveLength(1);
  });

  it("preserves a target when link creates it and then reports EIO", async () => {
    const root = await temporaryRoot();
    const target = join(root, "sources.lock.json");
    const failure = Object.assign(new Error("post-link EIO"), { code: "EIO" });
    const remove = vi.fn(nodeSourceLockPublishRuntime.remove);
    const runtime: SourceLockPublishRuntime = {
      ...nodeSourceLockPublishRuntime,
      remove,
      link: async (temporary, destination) => {
        await nodeSourceLockPublishRuntime.link(temporary, destination);
        throw failure;
      },
    };

    await expect(writeSourceLockFile(target, lock, runtime)).rejects.toMatchObject({
      code: "LOCK_PUBLISH_FAILED",
      publicationState: "unknown",
      temporaryState: "retained",
      cause: failure,
      message: expect.stringContaining("do not rerun or overwrite blindly"),
    });
    expect(remove).not.toHaveBeenCalled();
    expect(await readFile(target, "utf8")).toBe(serializeSourceLock(lock));
  });

  it("does not follow or replace an existing symbolic-link target", async (context) => {
    const root = await temporaryRoot();
    const victim = join(root, "victim.json");
    const target = join(root, "sources.lock.json");
    await writeFile(victim, "keep\n", "utf8");
    await symlinkOrSkip(context, victim, target, "file");

    await expect(writeSourceLockFile(target, lock)).rejects.toThrow("already exists");
    expect(await readFile(victim, "utf8")).toBe("keep\n");
    expect((await lstat(target)).isSymbolicLink()).toBe(true);
  });

  it("fails without leaving a file when the target parent is a symbolic link", async (context) => {
    const root = await temporaryRoot();
    const real = join(root, "real");
    const linked = join(root, "linked");
    await mkdir(real);
    await symlinkOrSkip(context, real, linked, "dir");

    await expect(writeSourceLockFile(join(linked, "sources.lock.json"), lock))
      .rejects.toThrow("parent directory");
    await expect(readFile(join(real, "sources.lock.json"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });
});

describe("lockCatalogSources", () => {
  it("rejects non-UTF-8 path bytes from the NUL-delimited Git tree before publication", async () => {
    const root = await temporaryRoot();
    await createLocalSource(root);
    const runner: GitRunner = async (args) => {
      const { stdout } = await execFileAsync("git", [...args], { encoding: "utf8" });
      return stdout;
    };
    const binaryRunner: GitBinaryRunner = async (args) => new Promise<Buffer>((resolvePromise, rejectPromise) => {
      execFile("git", [...args], { encoding: "buffer" }, (error, stdout) => {
        if (error !== null) {
          rejectPromise(error);
          return;
        }
        const bytes = Buffer.isBuffer(stdout) ? Buffer.from(stdout) : Buffer.from(stdout);
        if (args.includes("ls-tree")) {
          const tab = bytes.indexOf(0x09);
          if (tab >= 0 && tab + 1 < bytes.length) bytes[tab + 1] = 0xff;
        }
        resolvePromise(bytes);
      });
    });

    await expect(resolveLocalCheckoutAttestation(root, validCandidate(), runner, binaryRunner))
      .rejects.toMatchObject({ code: "GIT_OUTPUT_INVALID", sourceId: "agency-agents" });
  });

  it("refuses to publish a production lock unless both exact reviewed source roles are configured", async () => {
    const root = await temporaryRoot();
    await createLocalSource(root);
    await mkdir(join(root, "catalog"));
    await writeFile(join(root, "catalog", "sources.yaml"), [
      "schemaVersion: 1",
      "sources:",
      "  - id: agency-agents",
      "    repository: https://github.com/msitarzewski/agency-agents",
      "    ref: refs/heads/main",
      "    checkout: vendor-sources/agency-agents",
      "    license: MIT",
      "",
    ].join("\n"), "utf8");

    await expect(lockCatalogSources(root)).rejects.toThrow(/exactly|reviewed/iu);
    await expect(readFile(join(root, "catalog", "sources.lock.json"), "utf8"))
      .rejects.toMatchObject({ code: "ENOENT" });
  });

  it("uses only local release inputs and refuses to overwrite an existing lock", async () => {
    const root = await temporaryRoot();
    const source = await createLocalSource(root);
    await createLocalSource(root, "agency-agents-zh");
    await mkdir(join(root, "catalog"));
    await writeFile(join(root, "catalog", "sources.yaml"), reviewedSourcesYaml(), "utf8");

    const result = await lockCatalogSources(root);
    expect(result.schemaVersion).toBe(2);
    expect(result.sources[0]?.commit).toBe(source.head);
    expect(result.sources[0]).toMatchObject({
      objectFormat: "sha1",
      tree: await runGit(source.checkout, ["rev-parse", `${source.head}^{tree}`]).then((value) => value.trim()),
      licenseFile: {
        path: "LICENSE",
        oid: await runGit(source.checkout, ["rev-parse", `${source.head}:LICENSE`]).then((value) => value.trim()),
        size: Buffer.byteLength("MIT fixture license\n"),
        sha256: `sha256:${createHash("sha256").update("MIT fixture license\n").digest("hex")}`,
      },
      markdown: [{
        path: "README.md",
        oid: await runGit(source.checkout, ["rev-parse", `${source.head}:README.md`]).then((value) => value.trim()),
        size: Buffer.byteLength("offline fixture\n"),
        sha256: `sha256:${createHash("sha256").update("offline fixture\n").digest("hex")}`,
        normalizedSize: Buffer.byteLength("offline fixture\n"),
        normalizedSha256: `sha256:${createHash("sha256").update("offline fixture\n").digest("hex")}`,
      }],
    });
    const target = join(root, "catalog", "sources.lock.json");
    expect(JSON.parse(await readFile(target, "utf8"))).toEqual(result);
    await expect(lockCatalogSources(root)).rejects.toThrow("already exists");
    await writeFile(join(source.checkout, "LICENSE"), "modified working tree license\n", "utf8");
    expect(result.sources[0]?.licenseFile?.sha256).toBe(
      `sha256:${createHash("sha256").update("MIT fixture license\n").digest("hex")}`,
    );
  }, 30_000);

  it("labels the executable command as a local, release-only, no-network operation", async () => {
    const root = await temporaryRoot();
    await createLocalSource(root);
    await createLocalSource(root, "agency-agents-zh");
    await mkdir(join(root, "catalog"));
    await writeFile(join(root, "catalog", "sources.yaml"), reviewedSourcesYaml(), "utf8");
    const script = fileURLToPath(new URL("../../scripts/lock-catalog-sources.ts", import.meta.url));
    const tsxLoader = fileURLToPath(new URL("../../node_modules/tsx/dist/loader.mjs", import.meta.url));

    const { stdout } = await execFileAsync(process.execPath, ["--import", pathToFileURL(tsxLoader).href, script], {
      cwd: root,
      encoding: "utf8",
    });

    expect(stdout).toContain("release-only");
    expect(stdout).toContain("local");
    expect(stdout).toContain("no network");
  }, 30_000);

  it("propagates unsupported directory-sync warnings to the CLI notification seam", async () => {
    const root = await temporaryRoot();
    await createLocalSource(root);
    await createLocalSource(root, "agency-agents-zh");
    await mkdir(join(root, "catalog"));
    await writeFile(join(root, "catalog", "sources.yaml"), reviewedSourcesYaml(), "utf8");
    const onPublishWarning = vi.fn();
    const publishRuntime: SourceLockPublishRuntime = {
      ...nodeSourceLockPublishRuntime,
      syncDirectory: async () => "unsupported",
    };

    await lockCatalogSources(root, { publishRuntime, onPublishWarning });

    expect(onPublishWarning).toHaveBeenCalledWith({
      code: "DIRECTORY_SYNC_UNSUPPORTED",
      message: expect.stringContaining("not supported"),
    });
    expect(onPublishWarning).toHaveBeenCalledWith({
      code: "TEMPORARY_RETAINED",
      message: expect.stringContaining("retained"),
    });
    expect(onPublishWarning).toHaveBeenCalledTimes(2);
  }, 30_000);

  it("detects sources YAML replacement during its no-follow stable read", async () => {
    const root = await temporaryRoot();
    const catalog = join(root, "catalog");
    const configPath = join(catalog, "sources.yaml");
    await mkdir(catalog);
    const configText = [
      "schemaVersion: 1",
      "sources:",
      "  - id: agency-agents",
      "    repository: https://github.com/msitarzewski/agency-agents",
      "    ref: refs/heads/main",
      "    checkout: vendor-sources/agency-agents",
      "    license: MIT",
      "",
    ].join("\n");
    await writeFile(configPath, configText, "utf8");
    const runtime: SourceConfigReadRuntime = {
      ...nodeSourceConfigReadRuntime,
      openNoFollow: async (path) => {
        const handle = await nodeSourceConfigReadRuntime.openNoFollow(path);
        return {
          ...handle,
          readText: async () => {
            const text = await handle.readText();
            await rename(configPath, join(catalog, "sources.original.yaml"));
            await writeFile(configPath, configText, "utf8");
            return text;
          },
        };
      },
    };

    await expect(lockCatalogSources(root, { configReadRuntime: runtime }))
      .rejects.toMatchObject({ code: "SOURCE_CONFIG_CHANGED" });
    await expect(readFile(join(catalog, "sources.lock.json"), "utf8"))
      .rejects.toMatchObject({ code: "ENOENT" });
  });
});

describe("lock-catalog-sources script module", () => {
  it("is import-safe and exports main without output, writes, or exit-code changes", async () => {
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const previousExitCode = process.exitCode;
    process.exitCode = 73;
    const moduleUrl = new URL("../../scripts/lock-catalog-sources.ts", import.meta.url);
    moduleUrl.searchParams.set("import-safe", randomUUID());

    try {
      const imported = await import(moduleUrl.href);
      expect(imported.main).toBeTypeOf("function");
      expect(imported.publicationStateAdvice({ publicationState: "unknown" }))
        .toContain("inspect catalog/sources.lock.json");
      expect(stdout).not.toHaveBeenCalled();
      expect(stderr).not.toHaveBeenCalled();
      expect(process.exitCode).toBe(73);
    } finally {
      process.exitCode = previousExitCode;
    }
  });
});
