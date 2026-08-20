import { execFile } from "node:child_process";
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { afterEach, describe, expect, expectTypeOf, it, vi } from "vitest";

import {
  createSourceLock,
  lockCatalogSources,
  parseSourceCandidatesConfig,
  parseSourceCandidatesYaml,
  resolveLocalCheckoutCommit,
  serializeSourceLock,
  writeSourceLockFile,
  type GitRunner,
  type SourceCandidate,
  type SourceLock,
} from "../../src/experts/source-lock.js";

const execFileAsync = promisify(execFile);
const temporaryRoots: string[] = [];

const validCandidate = (overrides: Partial<SourceCandidate> = {}): SourceCandidate => ({
  id: "agency-agents",
  repository: "https://github.com/msitarzewski/agency-agents",
  ref: "main",
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

async function createLocalSource(root: string): Promise<{ checkout: string; head: string }> {
  const checkout = join(root, "vendor-sources", "agency-agents");
  await mkdir(checkout, { recursive: true });
  await execFileAsync("git", ["init", "-b", "main", checkout]);
  await runGit(checkout, ["config", "user.name", "EZagent Test"]);
  await runGit(checkout, ["config", "user.email", "ezagent@example.invalid"]);
  await writeFile(join(checkout, "README.md"), "offline fixture\n", "utf8");
  await runGit(checkout, ["add", "README.md"]);
  await runGit(checkout, ["commit", "-m", "fixture"]);
  await runGit(checkout, [
    "remote",
    "add",
    "origin",
    "https://github.com/msitarzewski/agency-agents",
  ]);
  return { checkout, head: (await runGit(checkout, ["rev-parse", "HEAD"])).trim() };
}

afterEach(async () => {
  vi.restoreAllMocks();
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
    await expect(createSourceLock([validCandidate()], async () => {
      throw new Error("SECRET RESOLVER DETAIL");
    })).rejects.toSatisfy((error: Error) =>
      error.message.includes("could not be resolved") && !error.message.includes("SECRET"));
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
    expect(commands).toHaveLength(6);
    expect(commands.every((args) => args[0] === "-C")).toBe(true);
    expect(commands.every((args) => args.includes("--no-optional-locks"))).toBe(true);
    expect(commands.every((args) => args.includes("protocol.allow=never"))).toBe(true);
    expect(commands.find((args) => args.includes("status"))).toContain("--ignored=matching");
    expect(commands.flat()).not.toContain("fetch");
    expect(commands.flat()).not.toContain("pull");
    expect(commands.flat()).not.toContain("clone");
    expect(commands.flat()).not.toContain("ls-remote");
  });

  it("rejects a non-Git checkout and does not leak Git stderr", async () => {
    const root = await temporaryRoot();
    await mkdir(join(root, "vendor-sources", "agency-agents"), { recursive: true });

    await expect(resolveLocalCheckoutCommit(root, validCandidate())).rejects.toSatisfy((error: Error) =>
      error.message.includes("Git worktree") && !error.message.includes("fatal:"));
  });

  it("rejects a mismatched origin", async () => {
    const root = await temporaryRoot();
    const { checkout } = await createLocalSource(root);
    await runGit(checkout, ["remote", "set-url", "origin", "https://github.com/example/wrong"]);

    await expect(resolveLocalCheckoutCommit(root, validCandidate())).rejects.toThrow("origin");
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
    await expect(resolveLocalCheckoutCommit(dirtyRoot, validCandidate())).rejects.toThrow("clean");

    const refRoot = await temporaryRoot();
    const source = await createLocalSource(refRoot);
    await runGit(source.checkout, ["branch", "reviewed"]);
    await writeFile(join(source.checkout, "README.md"), "second commit\n", "utf8");
    await runGit(source.checkout, ["add", "README.md"]);
    await runGit(source.checkout, ["commit", "-m", "second"]);
    await expect(resolveLocalCheckoutCommit(refRoot, validCandidate({ ref: "reviewed" })))
      .rejects.toThrow("does not equal HEAD");
  });

  it("rejects a checkout reached through a symbolic-link directory", async () => {
    const root = await temporaryRoot();
    const outside = await temporaryRoot();
    await createLocalSource(outside);
    await symlink(join(outside, "vendor-sources"), join(root, "vendor-sources"), "dir");

    await expect(resolveLocalCheckoutCommit(root, validCandidate())).rejects.toThrow("symbolic link");
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

  it("atomically creates once, refuses no-clobber races, and leaves no staging file", async () => {
    const root = await temporaryRoot();
    const target = join(root, "sources.lock.json");
    const results = await Promise.allSettled([
      writeSourceLockFile(target, lock),
      writeSourceLockFile(target, lock),
    ]);

    expect(results.filter(({ status }) => status === "fulfilled")).toHaveLength(1);
    expect(results.filter(({ status }) => status === "rejected")).toHaveLength(1);
    expect(await readFile(target, "utf8")).toBe(serializeSourceLock(lock));
    expect((await readdir(root)).filter((name) => name.includes("ezagent-source-lock"))).toEqual([]);
  });

  it("does not follow or replace an existing symbolic-link target", async () => {
    const root = await temporaryRoot();
    const victim = join(root, "victim.json");
    const target = join(root, "sources.lock.json");
    await writeFile(victim, "keep\n", "utf8");
    await symlink(victim, target, "file");

    await expect(writeSourceLockFile(target, lock)).rejects.toThrow("already exists");
    expect(await readFile(victim, "utf8")).toBe("keep\n");
    expect((await lstat(target)).isSymbolicLink()).toBe(true);
  });

  it("fails without leaving a file when the target parent is a symbolic link", async () => {
    const root = await temporaryRoot();
    const real = join(root, "real");
    const linked = join(root, "linked");
    await mkdir(real);
    await symlink(real, linked, "dir");

    await expect(writeSourceLockFile(join(linked, "sources.lock.json"), lock))
      .rejects.toThrow("parent directory");
    await expect(readFile(join(real, "sources.lock.json"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });
});

describe("lockCatalogSources", () => {
  it("uses only local release inputs and refuses to overwrite an existing lock", async () => {
    const root = await temporaryRoot();
    const source = await createLocalSource(root);
    await mkdir(join(root, "catalog"));
    await writeFile(join(root, "catalog", "sources.yaml"), [
      "schemaVersion: 1",
      "sources:",
      "  - id: agency-agents",
      "    repository: https://github.com/msitarzewski/agency-agents",
      "    ref: main",
      "    checkout: vendor-sources/agency-agents",
      "    license: MIT",
      "",
    ].join("\n"), "utf8");

    const result = await lockCatalogSources(root);
    expect(result.sources[0]?.commit).toBe(source.head);
    const target = join(root, "catalog", "sources.lock.json");
    expect(JSON.parse(await readFile(target, "utf8"))).toEqual(result);
    await expect(lockCatalogSources(root)).rejects.toThrow("already exists");
  });

  it("labels the executable command as a local, release-only, no-network operation", async () => {
    const root = await temporaryRoot();
    await createLocalSource(root);
    await mkdir(join(root, "catalog"));
    await writeFile(join(root, "catalog", "sources.yaml"), [
      "schemaVersion: 1",
      "sources:",
      "  - id: agency-agents",
      "    repository: https://github.com/msitarzewski/agency-agents",
      "    ref: main",
      "    checkout: vendor-sources/agency-agents",
      "    license: MIT",
      "",
    ].join("\n"), "utf8");
    const script = fileURLToPath(new URL("../../scripts/lock-catalog-sources.ts", import.meta.url));
    const tsxLoader = fileURLToPath(new URL("../../node_modules/tsx/dist/loader.mjs", import.meta.url));

    const { stdout } = await execFileAsync(process.execPath, ["--import", tsxLoader, script], {
      cwd: root,
      encoding: "utf8",
    });

    expect(stdout).toContain("release-only");
    expect(stdout).toContain("local");
    expect(stdout).toContain("no network");
  });
});
