import { createHash } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { execa } from "execa";
import { z } from "zod";

const policySchema = z.enum([
  "consult-no-work",
  "no-workflow",
  "initialize",
  "router-light",
  "router-standard",
  "router-high",
]);

const ruleAnchorSchema = z.enum([
  "standard-new-capability",
  "light-cosmetic",
  "consult-no-work",
  "uninitialized-no-workflow",
  "explicit-initialize",
  "high-risk",
]);

const categorySchema = z.enum([
  "explicit",
  "implicit",
  "negative",
  "boundary",
  "follow-up",
]);

const hostEvalCaseSchema = z.strictObject({
  id: z.string().regex(/^[a-z0-9-]+$/u),
  name: z.string().min(1),
  prompt: z.string().min(1),
  initialized: z.boolean(),
  expectedPolicy: policySchema,
  ruleAnchor: ruleAnchorSchema,
  categories: z.array(categorySchema).min(1),
  reviewCriteria: z.array(z.string().min(1)).min(1),
  followUpPrompt: z.string().min(1).optional(),
});

export const hostEvalSuiteSchema = z.strictObject({
  schemaVersion: z.literal(1),
  pluginId: z.literal("ezagent-spec@ezagent"),
  cases: z.array(hostEvalCaseSchema).min(7),
}).superRefine(({ cases }, context) => {
  const ids = new Set<string>();
  for (const fixture of cases) {
    if (ids.has(fixture.id)) {
      context.addIssue({
        code: "custom",
        message: `duplicate host evaluation case id: ${fixture.id}`,
      });
    }
    ids.add(fixture.id);
  }
});

export type HostEvalSuite = z.infer<typeof hostEvalSuiteSchema>;

export async function loadHostEvalSuite(path: string): Promise<HostEvalSuite> {
  return hostEvalSuiteSchema.parse(JSON.parse(await readFile(path, "utf8")) as unknown);
}

const pluginListSchema = z.object({
  installed: z.array(z.object({
    pluginId: z.string(),
    name: z.string(),
    marketplaceName: z.string(),
    version: z.string().min(1),
    installed: z.boolean(),
    enabled: z.boolean(),
  }).passthrough()),
}).passthrough();

const sha256Schema = z.string().regex(/^[0-9a-f]{64}$/u);
const commitSchema = z.string().regex(/^[0-9a-f]{40}$/u);

const hostEvalEvidenceCaseSchema = z.strictObject({
  id: z.string().regex(/^[a-z0-9-]+$/u),
  expectedPolicy: policySchema,
  exitCode: z.number().int(),
  timedOut: z.boolean(),
  workspaceChanged: z.boolean(),
  workspaceBeforeSha256: sha256Schema,
  workspaceAfterSha256: sha256Schema,
  transcriptSha256: sha256Schema,
  review: z.strictObject({
    status: z.enum(["pending", "pass", "fail"]),
    reason: z.string(),
  }),
});

export const hostEvalEvidenceSchema = z.strictObject({
  schemaVersion: z.literal(1),
  suiteSchemaVersion: z.literal(1),
  runId: z.string().min(1),
  createdAt: z.string().min(1),
  platform: z.string().min(1),
  codexVersion: z.string().min(1),
  plugin: z.strictObject({
    pluginId: z.literal("ezagent-spec@ezagent"),
    version: z.string().min(1),
  }),
  commit: commitSchema,
  cases: z.array(hostEvalEvidenceCaseSchema).min(1),
});

export type HostEvalEvidence = z.infer<typeof hostEvalEvidenceSchema>;

export function buildCodexExecArgv(
  root: string,
  prompt: string,
  outputPath: string,
  ephemeral: boolean,
): string[] {
  return [
    "exec",
    "--json",
    ...(ephemeral ? ["--ephemeral"] : []),
    "--sandbox",
    "read-only",
    "--cd",
    root,
    "--output-last-message",
    outputPath,
    prompt,
  ];
}

export function buildCodexResumeArgv(
  threadId: string,
  prompt: string,
  outputPath: string,
): string[] {
  return [
    "exec",
    "resume",
    "--json",
    "--ephemeral",
    "--output-last-message",
    outputPath,
    threadId,
    prompt,
  ];
}

export function hostEvalProcessOptions(cwd: string): {
  readonly cwd: string;
  readonly reject: false;
  readonly shell: false;
  readonly stdin: "ignore";
  readonly timeout: 240_000;
  readonly forceKillAfterDelay: 10_000;
} {
  return {
    cwd,
    reject: false,
    shell: false,
    stdin: "ignore",
    timeout: 240_000,
    forceKillAfterDelay: 10_000,
  };
}

export function installedPlugin(value: unknown): {
  readonly pluginId: "ezagent-spec@ezagent";
  readonly version: string;
} {
  const matches = pluginListSchema.parse(value).installed.filter(
    (plugin) => plugin.pluginId === "ezagent-spec@ezagent"
      && plugin.installed
      && plugin.enabled,
  );
  if (matches.length !== 1) {
    throw new Error("ezagent-spec@ezagent is not installed and enabled exactly once");
  }
  return {
    pluginId: "ezagent-spec@ezagent",
    version: matches[0]!.version,
  };
}

export function threadIdFromJsonl(jsonl: string): string {
  const ids = jsonl
    .split(/\r?\n/gu)
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line) as unknown)
    .filter((event): event is { readonly type: "thread.started"; readonly thread_id: string } => (
      typeof event === "object"
      && event !== null
      && (event as Record<string, unknown>).type === "thread.started"
      && typeof (event as Record<string, unknown>).thread_id === "string"
    ))
    .map(({ thread_id: threadId }) => threadId);
  if (ids.length !== 1) {
    throw new Error(`expected exactly one thread.started event, received ${ids.length}`);
  }
  return ids[0]!;
}

export function verifyHostEvalEvidence(
  value: unknown,
  expectedCaseIds: readonly string[],
  expectedCommit: string,
): HostEvalEvidence {
  const evidence = hostEvalEvidenceSchema.parse(value);
  if (evidence.commit !== expectedCommit) {
    throw new Error(`evidence commit ${evidence.commit} does not match ${expectedCommit}`);
  }
  const expected = new Set(expectedCaseIds);
  if (expected.size !== expectedCaseIds.length) {
    throw new Error("expected host evaluation case ids must be unique");
  }
  const actual = new Set(evidence.cases.map(({ id }) => id));
  if (actual.size !== evidence.cases.length) {
    throw new Error("host evaluation evidence contains duplicate case ids");
  }
  const missing = expectedCaseIds.filter((id) => !actual.has(id));
  const unexpected = [...actual].filter((id) => !expected.has(id));
  if (missing.length > 0 || unexpected.length > 0) {
    throw new Error(
      `host evaluation case mismatch: missing=${missing.join(",") || "none"}; unexpected=${unexpected.join(",") || "none"}`,
    );
  }
  for (const result of evidence.cases) {
    if (result.timedOut) {
      throw new Error(`host evaluation case ${result.id} timed out`);
    }
    if (result.exitCode !== 0) {
      throw new Error(`host evaluation case ${result.id} exited ${result.exitCode}`);
    }
    if (
      result.workspaceChanged
      || result.workspaceBeforeSha256 !== result.workspaceAfterSha256
    ) {
      throw new Error(`host evaluation case ${result.id} changed its workspace`);
    }
    if (result.review.status !== "pass" || result.review.reason.trim() === "") {
      throw new Error(`host evaluation case ${result.id} lacks a passing manual review`);
    }
  }
  return evidence;
}

interface CommandResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;
  readonly timedOut: boolean;
}

const REPOSITORY_ROOT = fileURLToPath(new URL("../", import.meta.url));
const SUITE_PATH = fileURLToPath(
  new URL("../test/fixtures/codex-host-eval.json", import.meta.url),
);
const PLUGIN_CLI = fileURLToPath(
  new URL("../plugins/ezagent-spec/dist/ezagent-cli.mjs", import.meta.url),
);
const ARTIFACT_ROOT = fileURLToPath(
  new URL("../.artifacts/codex-host-eval/", import.meta.url),
);

async function runCommand(
  command: string,
  args: readonly string[],
  cwd: string,
): Promise<CommandResult> {
  const result = await execa(command, [...args], hostEvalProcessOptions(cwd));
  return {
    stdout: result.stdout,
    stderr: result.stderr,
    exitCode: result.exitCode ?? -1,
    timedOut: result.timedOut,
  };
}

async function checkedCommand(
  command: string,
  args: readonly string[],
  cwd: string,
): Promise<CommandResult> {
  const result = await runCommand(command, args, cwd);
  if (result.exitCode !== 0) {
    throw new Error(
      `${command} ${args.join(" ")} failed with ${result.exitCode}: ${result.stderr.trim()}`,
    );
  }
  return result;
}

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

async function workspaceTreeDigest(root: string): Promise<string> {
  const files: Array<{ readonly path: string; readonly contents: Buffer }> = [];

  async function visit(directory: string): Promise<void> {
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name, "en"));
    for (const entry of entries) {
      if (directory === root && entry.name === ".git") continue;
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        await visit(path);
      } else if (entry.isFile()) {
        files.push({ path: relative(root, path).replaceAll("\\", "/"), contents: await readFile(path) });
      } else {
        throw new Error(`host evaluation workspace contains unsupported entry: ${path}`);
      }
    }
  }

  await visit(root);
  const digest = createHash("sha256");
  for (const file of files) {
    digest.update(file.path, "utf8");
    digest.update("\0", "utf8");
    digest.update(file.contents);
    digest.update("\0", "utf8");
  }
  return digest.digest("hex");
}

async function prepareWorkspace(initialized: boolean): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "ezagent-host-eval-"));
  await checkedCommand("git", ["init", "--quiet"], root);
  if (!initialized) return root;

  const preview = await checkedCommand(
    process.execPath,
    [PLUGIN_CLI, "integration-preview", "--root", root],
    REPOSITORY_ROOT,
  );
  const previewValue = z.object({ agentsToken: z.string().min(1) }).parse(
    JSON.parse(preview.stdout) as unknown,
  );
  await checkedCommand(
    process.execPath,
    [
      PLUGIN_CLI,
      "integration-init",
      "--root",
      root,
      "--name",
      "HostEval",
      "--agents-token",
      previewValue.agentsToken,
    ],
    REPOSITORY_ROOT,
  );
  return root;
}

function runIdFor(date: Date): string {
  return date.toISOString().replace(/[-:.]/gu, "");
}

export async function createArtifactRunRoot(base: string, runId: string): Promise<string> {
  if (!/^\d{8}T\d{9}Z$/u.test(runId)) {
    throw new Error(`invalid Codex host evaluation run id: ${runId}`);
  }
  await mkdir(base, { recursive: true });
  const runRoot = join(base, runId);
  await mkdir(runRoot);
  return runRoot;
}

async function runHostEvaluation(): Promise<string> {
  const suite = await loadHostEvalSuite(SUITE_PATH);
  const codexVersion = (await checkedCommand("codex", ["--version"], REPOSITORY_ROOT)).stdout.trim();
  const pluginList = await checkedCommand("codex", ["plugin", "list", "--json"], REPOSITORY_ROOT);
  const plugin = installedPlugin(JSON.parse(pluginList.stdout) as unknown);
  const commit = (await checkedCommand("git", ["rev-parse", "HEAD"], REPOSITORY_ROOT)).stdout.trim();
  commitSchema.parse(commit);
  const status = await checkedCommand(
    "git",
    ["status", "--porcelain", "--untracked-files=all"],
    REPOSITORY_ROOT,
  );
  if (status.stdout.trim() !== "") {
    throw new Error("Codex host evaluation requires a clean Git worktree");
  }

  const createdAt = new Date();
  const runId = runIdFor(createdAt);
  const runRoot = await createArtifactRunRoot(ARTIFACT_ROOT, runId);
  const results: HostEvalEvidence["cases"][number][] = [];

  for (const fixture of suite.cases) {
    const caseRoot = join(runRoot, fixture.id);
    await mkdir(caseRoot);
    const workspaceRoot = await prepareWorkspace(fixture.initialized);
    const before = await workspaceTreeDigest(workspaceRoot);
    const initialOutput = join(caseRoot, "final.txt");
    const initial = await runCommand(
      "codex",
      buildCodexExecArgv(
        workspaceRoot,
        fixture.prompt,
        initialOutput,
        fixture.followUpPrompt === undefined,
      ),
      workspaceRoot,
    );
    await writeFile(join(caseRoot, "initial.jsonl"), `${initial.stdout}\n`, "utf8");
    await writeFile(join(caseRoot, "initial.stderr.txt"), initial.stderr, "utf8");

    let combinedTranscript = `${initial.stdout}\n${initial.stderr}`;
    let exitCode = initial.exitCode;
    let timedOut = initial.timedOut;
    if (fixture.followUpPrompt !== undefined) {
      const threadId = threadIdFromJsonl(initial.stdout);
      const followUpOutput = join(caseRoot, "follow-up-final.txt");
      const followUp = await runCommand(
        "codex",
        buildCodexResumeArgv(threadId, fixture.followUpPrompt, followUpOutput),
        workspaceRoot,
      );
      await writeFile(join(caseRoot, "follow-up.jsonl"), `${followUp.stdout}\n`, "utf8");
      await writeFile(join(caseRoot, "follow-up.stderr.txt"), followUp.stderr, "utf8");
      combinedTranscript += `\n${followUp.stdout}\n${followUp.stderr}`;
      if (followUp.exitCode !== 0) exitCode = followUp.exitCode;
      timedOut ||= followUp.timedOut;
    }

    const after = await workspaceTreeDigest(workspaceRoot);
    results.push({
      id: fixture.id,
      expectedPolicy: fixture.expectedPolicy,
      exitCode,
      timedOut,
      workspaceChanged: before !== after,
      workspaceBeforeSha256: before,
      workspaceAfterSha256: after,
      transcriptSha256: sha256(combinedTranscript),
      review: { status: "pending", reason: "" },
    });
  }

  const evidence: HostEvalEvidence = {
    schemaVersion: 1,
    suiteSchemaVersion: suite.schemaVersion,
    runId,
    createdAt: createdAt.toISOString(),
    platform: `${process.platform}-${process.arch}`,
    codexVersion,
    plugin,
    commit,
    cases: results,
  };
  const evidencePath = join(runRoot, "evidence.json");
  await writeFile(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`, "utf8");
  return evidencePath;
}

async function newestEvidencePath(): Promise<string> {
  const entries = await readdir(ARTIFACT_ROOT, { withFileTypes: true });
  const names = entries
    .filter((entry) => entry.isDirectory())
    .map(({ name }) => name)
    .sort();
  const newest = names.at(-1);
  if (newest === undefined) throw new Error("no Codex host evaluation evidence exists");
  return join(ARTIFACT_ROOT, newest, "evidence.json");
}

async function verifyEvidence(path?: string): Promise<string> {
  const suite = await loadHostEvalSuite(SUITE_PATH);
  const evidencePath = path === undefined ? await newestEvidencePath() : resolve(path);
  const currentCommit = (await checkedCommand("git", ["rev-parse", "HEAD"], REPOSITORY_ROOT)).stdout.trim();
  verifyHostEvalEvidence(
    JSON.parse(await readFile(evidencePath, "utf8")) as unknown,
    suite.cases.map(({ id }) => id),
    currentCommit,
  );
  return evidencePath;
}

async function main(args: readonly string[]): Promise<void> {
  const command = args[0];
  if (command === "run" && args.length === 1) {
    const evidencePath = await runHostEvaluation();
    process.stdout.write(`Codex host evaluation evidence: ${evidencePath}\n`);
    return;
  }
  if (command === "verify") {
    if (args.length === 1) {
      const evidencePath = await verifyEvidence();
      process.stdout.write(`Codex host evaluation evidence verified: ${evidencePath}\n`);
      return;
    }
    if (args.length === 3 && args[1] === "--evidence") {
      const evidencePath = await verifyEvidence(args[2]);
      process.stdout.write(`Codex host evaluation evidence verified: ${evidencePath}\n`);
      return;
    }
  }
  throw new Error("usage: codex-host-eval <run|verify [--evidence path]>");
}

const entryPath = process.argv[1];
if (entryPath !== undefined && pathToFileURL(resolve(entryPath)).href === import.meta.url) {
  main(process.argv.slice(2)).catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
