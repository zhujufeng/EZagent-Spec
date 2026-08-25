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

import {
  buildCodexResumeArgv,
  createArtifactRunRoot,
  hostEvalProcessOptions,
  installedPlugin,
  threadIdFromJsonl,
} from "./codex-host-eval.js";

export function buildCodexPostInitExecArgv(
  root: string,
  prompt: string,
  outputPath: string,
): string[] {
  return [
    "exec",
    "--json",
    "--sandbox",
    "workspace-write",
    "--cd",
    root,
    "--output-last-message",
    outputPath,
    prompt,
  ];
}

const EZAGENT_EVAL_COMMANDS = [
  "integration-preview",
  "integration-init",
  "context",
  "work-preview",
  "work-apply",
] as const;

export type EzagentEvalCommand = typeof EZAGENT_EVAL_COMMANDS[number];

const ezagentEvalCommandSchema = z.enum(EZAGENT_EVAL_COMMANDS);
const postInitEvalCaseSchema = z.strictObject({
  id: z.string().regex(/^[a-z0-9-]+$/u),
  name: z.string().min(1),
  initialPrompt: z.string().min(1),
  confirmationPrompt: z.string().min(1),
  expectedCommandSequence: z.array(ezagentEvalCommandSchema).min(1),
  forbiddenCommands: z.array(ezagentEvalCommandSchema),
  forbiddenWorkspacePrefixes: z.array(z.string().min(1)),
  reviewCriteria: z.array(z.string().min(1).max(512)).min(1),
});

export const postInitEvalSuiteSchema = z.strictObject({
  schemaVersion: z.literal(1),
  pluginId: z.literal("ezagent-spec@ezagent"),
  case: postInitEvalCaseSchema,
});

export type PostInitEvalSuite = z.infer<typeof postInitEvalSuiteSchema>;

export async function loadPostInitEvalSuite(path: string): Promise<PostInitEvalSuite> {
  return postInitEvalSuiteSchema.parse(JSON.parse(await readFile(path, "utf8")) as unknown);
}

const sha256Schema = z.string().regex(/^[0-9a-f]{64}$/u);
const commitSchema = z.string().regex(/^[0-9a-f]{40}$/u);
const postInitEvalEvidenceSchema = z.strictObject({
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
  case: z.strictObject({
    id: z.string().regex(/^[a-z0-9-]+$/u),
    exitCode: z.number().int(),
    timedOut: z.boolean(),
    initialWorkspaceChanged: z.boolean(),
    workspaceBeforeSha256: sha256Schema,
    workspaceAfterInitialSha256: sha256Schema,
    workspaceAfterFollowUpSha256: sha256Schema,
    transcriptSha256: sha256Schema,
    initialized: z.boolean(),
    workspaceRevision: z.number().int().nonnegative().nullable(),
    activeWorkItemPresent: z.boolean().nullable(),
    observedCommandSequence: z.array(ezagentEvalCommandSchema),
    forbiddenCommandsObserved: z.array(ezagentEvalCommandSchema),
    unexpectedWorkspacePaths: z.array(z.string()),
    review: z.strictObject({
      status: z.enum(["pending", "pass", "fail"]),
      reason: z.string().max(1_024),
    }),
  }),
});

export type PostInitEvalEvidence = z.infer<typeof postInitEvalEvidenceSchema>;

function sameSequence(
  actual: readonly EzagentEvalCommand[],
  expected: readonly EzagentEvalCommand[],
): boolean {
  return actual.length === expected.length
    && actual.every((command, index) => command === expected[index]);
}

export function verifyPostInitEvalEvidence(
  value: unknown,
  suite: PostInitEvalSuite,
  expectedCommit: string,
): PostInitEvalEvidence {
  const evidence = postInitEvalEvidenceSchema.parse(value);
  if (evidence.commit !== expectedCommit) {
    throw new Error(`post-init evidence commit ${evidence.commit} does not match ${expectedCommit}`);
  }
  const result = evidence.case;
  if (result.id !== suite.case.id) throw new Error(`unexpected post-init case: ${result.id}`);
  if (result.timedOut) throw new Error("post-init evaluation timed out");
  if (result.exitCode !== 0) throw new Error(`post-init evaluation exited ${result.exitCode}`);
  if (
    result.initialWorkspaceChanged
    || result.workspaceBeforeSha256 !== result.workspaceAfterInitialSha256
  ) {
    throw new Error("post-init evaluation changed the workspace before initialization approval");
  }
  if (result.workspaceAfterFollowUpSha256 === result.workspaceBeforeSha256) {
    throw new Error("post-init evaluation did not initialize the workspace");
  }
  if (!result.initialized || result.workspaceRevision !== 0 || result.activeWorkItemPresent !== false) {
    throw new Error("post-init evaluation crossed the Work Contract approval boundary");
  }
  if (!sameSequence(result.observedCommandSequence, suite.case.expectedCommandSequence)) {
    throw new Error(
      `post-init command sequence mismatch: ${result.observedCommandSequence.join(" -> ") || "none"}`,
    );
  }
  const forbidden = result.observedCommandSequence.filter((command) => (
    suite.case.forbiddenCommands.includes(command)
  ));
  if (forbidden.length > 0 || result.forbiddenCommandsObserved.length > 0) {
    throw new Error(`post-init evaluation executed forbidden commands: ${forbidden.join(",")}`);
  }
  if (result.unexpectedWorkspacePaths.length > 0) {
    throw new Error(
      `post-init evaluation wrote unexpected paths: ${result.unexpectedWorkspacePaths.join(",")}`,
    );
  }
  if (result.review.status !== "pass" || result.review.reason.trim() === "") {
    throw new Error("post-init evaluation lacks a passing manual review");
  }
  return evidence;
}

export function unexpectedPostInitWorkspacePaths(
  paths: readonly string[],
  suite: PostInitEvalSuite,
): string[] {
  return paths
    .map((path) => path.replaceAll("\\", "/"))
    .filter((path) => {
      if (suite.case.forbiddenWorkspacePrefixes.some((prefix) => path.startsWith(prefix))) {
        return true;
      }
      return path !== "AGENTS.md"
        && !path.startsWith(".ezagent/")
        && !/^\.codex\/agents\/ezagent-[^/]+\.toml$/u.test(path);
    })
    .sort();
}

function executedCommand(value: unknown): string | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const event = value as Record<string, unknown>;
  if (event.type !== "item.completed") return undefined;
  const item = event.item;
  if (typeof item !== "object" || item === null) return undefined;
  const record = item as Record<string, unknown>;
  return record.type === "command_execution" && typeof record.command === "string"
    ? record.command
    : undefined;
}

function ezagentCommand(command: string): EzagentEvalCommand | undefined {
  const cli = "ezagent-cli.mjs";
  const cliIndex = command.indexOf(cli);
  if (cliIndex < 0) return undefined;
  const tail = command.slice(cliIndex + cli.length);
  const candidates = EZAGENT_EVAL_COMMANDS
    .map((candidate) => ({
      candidate,
      index: new RegExp(`[\\s\"'\u0060,]${candidate}(?=$|[\\s\"'\u0060,])`, "u").exec(tail)?.index,
    }))
    .filter((match): match is { readonly candidate: EzagentEvalCommand; readonly index: number } => (
      match.index !== undefined
    ))
    .sort((left, right) => left.index - right.index);
  return candidates[0]?.candidate;
}

export function ezagentCommandSequenceFromJsonl(jsonl: string): EzagentEvalCommand[] {
  const commands: EzagentEvalCommand[] = [];
  for (const line of jsonl.split(/\r?\n/gu)) {
    if (line.trim() === "") continue;
    const command = executedCommand(JSON.parse(line) as unknown);
    if (command === undefined) continue;
    const observed = ezagentCommand(command);
    if (observed !== undefined) commands.push(observed);
  }
  return commands;
}

interface CommandResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;
  readonly timedOut: boolean;
}

interface WorkspaceSnapshot {
  readonly digest: string;
  readonly files: readonly string[];
}

const REPOSITORY_ROOT = fileURLToPath(new URL("../", import.meta.url));
const SUITE_PATH = fileURLToPath(
  new URL("../test/fixtures/codex-post-init-eval.json", import.meta.url),
);
const ARTIFACT_ROOT = fileURLToPath(
  new URL("../.artifacts/codex-post-init-eval/", import.meta.url),
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

async function workspaceSnapshot(root: string): Promise<WorkspaceSnapshot> {
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
        files.push({
          path: relative(root, path).replaceAll("\\", "/"),
          contents: await readFile(path),
        });
      } else {
        throw new Error(`post-init workspace contains unsupported entry: ${path}`);
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
  return {
    digest: digest.digest("hex"),
    files: Object.freeze(files.map(({ path }) => path)),
  };
}

async function workspaceState(root: string): Promise<{
  readonly initialized: boolean;
  readonly workspaceRevision: number | null;
  readonly activeWorkItemPresent: boolean | null;
}> {
  try {
    await readFile(join(root, ".ezagent", "project.yaml"), "utf8");
    const state = z.object({
      revision: z.number().int().nonnegative(),
      activeWorkItem: z.unknown().nullable(),
    }).passthrough().parse(
      JSON.parse(await readFile(join(root, ".ezagent", "state", "workspace.json"), "utf8")) as unknown,
    );
    return {
      initialized: true,
      workspaceRevision: state.revision,
      activeWorkItemPresent: state.activeWorkItem !== null,
    };
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return {
        initialized: false,
        workspaceRevision: null,
        activeWorkItemPresent: null,
      };
    }
    throw error;
  }
}

function runIdFor(date: Date): string {
  return date.toISOString().replace(/[-:.]/gu, "");
}

export async function runPostInitEvaluation(): Promise<string> {
  const suite = await loadPostInitEvalSuite(SUITE_PATH);
  const codexVersion = (await checkedCommand("codex", ["--version"], REPOSITORY_ROOT)).stdout.trim();
  const pluginList = await checkedCommand("codex", ["plugin", "list", "--json"], REPOSITORY_ROOT);
  const plugin = installedPlugin(JSON.parse(pluginList.stdout) as unknown);
  const packageVersion = z.object({ version: z.string().min(1) }).parse(
    JSON.parse(await readFile(join(REPOSITORY_ROOT, "package.json"), "utf8")) as unknown,
  ).version;
  if (plugin.version !== packageVersion) {
    throw new Error(
      `installed plugin version ${plugin.version} does not match package version ${packageVersion}`,
    );
  }
  const commit = (await checkedCommand("git", ["rev-parse", "HEAD"], REPOSITORY_ROOT)).stdout.trim();
  commitSchema.parse(commit);
  const status = await checkedCommand(
    "git",
    ["status", "--porcelain", "--untracked-files=all"],
    REPOSITORY_ROOT,
  );
  if (status.stdout.trim() !== "") {
    throw new Error("Codex post-init evaluation requires a clean Git worktree");
  }

  const createdAt = new Date();
  const runId = runIdFor(createdAt);
  const runRoot = await createArtifactRunRoot(ARTIFACT_ROOT, runId);
  const workspaceRoot = await mkdtemp(join(tmpdir(), "ezagent-post-init-eval-"));
  await checkedCommand("git", ["init", "--quiet"], workspaceRoot);
  const before = await workspaceSnapshot(workspaceRoot);

  const initialOutput = join(runRoot, "initial-final.txt");
  const initial = await runCommand(
    "codex",
    buildCodexPostInitExecArgv(workspaceRoot, suite.case.initialPrompt, initialOutput),
    workspaceRoot,
  );
  await writeFile(join(runRoot, "initial.jsonl"), `${initial.stdout}\n`, "utf8");
  await writeFile(join(runRoot, "initial.stderr.txt"), initial.stderr, "utf8");
  const afterInitial = await workspaceSnapshot(workspaceRoot);
  const threadId = threadIdFromJsonl(initial.stdout);

  const followUpOutput = join(runRoot, "follow-up-final.txt");
  const followUp = await runCommand(
    "codex",
    buildCodexResumeArgv(threadId, suite.case.confirmationPrompt, followUpOutput),
    workspaceRoot,
  );
  await writeFile(join(runRoot, "follow-up.jsonl"), `${followUp.stdout}\n`, "utf8");
  await writeFile(join(runRoot, "follow-up.stderr.txt"), followUp.stderr, "utf8");
  const afterFollowUp = await workspaceSnapshot(workspaceRoot);
  const state = await workspaceState(workspaceRoot);

  const jsonl = `${initial.stdout}\n${followUp.stdout}`;
  const transcript = `${jsonl}\n${initial.stderr}\n${followUp.stderr}`;
  const observedCommandSequence = ezagentCommandSequenceFromJsonl(jsonl);
  const forbiddenCommandsObserved = observedCommandSequence.filter((command) => (
    suite.case.forbiddenCommands.includes(command)
  ));
  const unexpectedWorkspacePaths = unexpectedPostInitWorkspacePaths(afterFollowUp.files, suite);
  await writeFile(
    join(runRoot, "workspace-files.json"),
    `${JSON.stringify(afterFollowUp.files, null, 2)}\n`,
    "utf8",
  );
  await writeFile(
    join(runRoot, "workspace-state.json"),
    `${JSON.stringify(state, null, 2)}\n`,
    "utf8",
  );

  const evidence: PostInitEvalEvidence = {
    schemaVersion: 1,
    suiteSchemaVersion: suite.schemaVersion,
    runId,
    createdAt: createdAt.toISOString(),
    platform: `${process.platform}-${process.arch}`,
    codexVersion,
    plugin,
    commit,
    case: {
      id: suite.case.id,
      exitCode: initial.exitCode !== 0 ? initial.exitCode : followUp.exitCode,
      timedOut: initial.timedOut || followUp.timedOut,
      initialWorkspaceChanged: before.digest !== afterInitial.digest,
      workspaceBeforeSha256: before.digest,
      workspaceAfterInitialSha256: afterInitial.digest,
      workspaceAfterFollowUpSha256: afterFollowUp.digest,
      transcriptSha256: sha256(transcript),
      ...state,
      observedCommandSequence,
      forbiddenCommandsObserved,
      unexpectedWorkspacePaths,
      review: { status: "pending", reason: "" },
    },
  };
  const evidencePath = join(runRoot, "evidence.json");
  await writeFile(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`, "utf8");
  return evidencePath;
}

async function newestEvidencePath(): Promise<string> {
  const entries = await readdir(ARTIFACT_ROOT, { withFileTypes: true });
  const newest = entries
    .filter((entry) => entry.isDirectory())
    .map(({ name }) => name)
    .sort()
    .at(-1);
  if (newest === undefined) throw new Error("no Codex post-init evaluation evidence exists");
  return join(ARTIFACT_ROOT, newest, "evidence.json");
}

async function verifyEvidence(path?: string): Promise<string> {
  const suite = await loadPostInitEvalSuite(SUITE_PATH);
  const evidencePath = path === undefined ? await newestEvidencePath() : resolve(path);
  const currentCommit = (await checkedCommand(
    "git",
    ["rev-parse", "HEAD"],
    REPOSITORY_ROOT,
  )).stdout.trim();
  verifyPostInitEvalEvidence(
    JSON.parse(await readFile(evidencePath, "utf8")) as unknown,
    suite,
    currentCommit,
  );
  return evidencePath;
}

async function main(args: readonly string[]): Promise<void> {
  const command = args[0];
  if (command === "run" && args.length === 1) {
    const evidencePath = await runPostInitEvaluation();
    process.stdout.write(`Codex post-init evaluation evidence: ${evidencePath}\n`);
    return;
  }
  if (command === "verify") {
    if (args.length === 1) {
      const evidencePath = await verifyEvidence();
      process.stdout.write(`Codex post-init evaluation evidence verified: ${evidencePath}\n`);
      return;
    }
    if (args.length === 3 && args[1] === "--evidence") {
      const evidencePath = await verifyEvidence(args[2]);
      process.stdout.write(`Codex post-init evaluation evidence verified: ${evidencePath}\n`);
      return;
    }
  }
  throw new Error("usage: codex-post-init-eval <run|verify [--evidence path]>");
}

const entryPath = process.argv[1];
if (entryPath !== undefined && pathToFileURL(resolve(entryPath)).href === import.meta.url) {
  main(process.argv.slice(2)).catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
