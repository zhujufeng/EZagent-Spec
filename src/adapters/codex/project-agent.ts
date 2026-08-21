import { randomUUID } from "node:crypto";
import { type Stats } from "node:fs";
import { lstat, mkdir, open, readdir, rename } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { types as nodeTypes } from "node:util";

import {
  ActiveExpertRepository,
  type ActiveExperts,
} from "../../experts/active.js";
import { unicodeDefaultCaseFold } from "../../text/unicode-case-fold.js";
import { isWellFormedUnicode } from "../../text/unicode.js";
import { withWorkspaceLock } from "../../workspace/lock.js";
import {
  MAX_PROJECT_AGENT_FILE_BYTES as MAX_FILE_BYTES,
  MAX_PROJECT_AGENTS as MAX_AGENTS,
  PROJECT_AGENT_FILE as AGENT_FILE,
  PROJECT_AGENT_HASH as HASH,
  digestProjectAgent as digest,
  portableProjectAgentCompare as portableCompare,
  projectAgentOwnDataObject as ownDataObject,
  renderProjectAgent,
  snapshotRenderedProjectAgents as snapshotRendered,
  type RenderedProjectAgent,
} from "./project-agent-render.js";
import {
  MAX_RECOVERY_EVIDENCE_BYTES_PER_RUN,
  MAX_RECOVERY_EVIDENCE_BYTES_TOTAL,
  MAX_RECOVERY_EVIDENCE_ENTRIES,
  MAX_RECOVERY_EVIDENCE_ENTRIES_PER_RUN,
  MAX_RECOVERY_RUNS,
  findRecoveryEvidence,
  findRunBackup,
  scanRecoveryEvidence,
  type RecoveryEvidence,
  type RecoveryEvidenceIndex,
} from "./project-agent-recovery.js";
import {
  assertBoundedRegularFile,
  assertRealDirectory as assertDirectory,
  assertRealDirectoryIdentity,
  chargeByteBudget,
  identity,
  observedLstat as observed,
  readNoFollowPathBounded,
  sameFile,
  syncDirectoryBestEffort,
  type BoundedReadPolicy,
  type FileIdentity,
} from "./safe-fs.js";

export { renderProjectAgent } from "./project-agent-render.js";
export type {
  ProjectAgentAssignment,
  RenderedProjectAgent,
} from "./project-agent-render.js";

const MAX_CODEX_AGENT_ENTRIES = MAX_AGENTS * 8;
const MANIFEST_KEYS = ["schemaVersion", "files"] as const;

interface ProjectAgentFileHandle {
  readonly stat: () => Promise<Stats>;
  readonly read: (
    buffer: Buffer,
    offset: number,
    length: number,
    position: number | null,
  ) => Promise<{ readonly bytesRead: number }>;
  readonly write: (
    buffer: Uint8Array,
    offset: number,
    length: number,
    position: number | null,
  ) => Promise<{ readonly bytesWritten: number }>;
  readonly sync: () => Promise<void>;
  readonly close: () => Promise<void>;
}

export interface ProjectAgentRuntime {
  readonly lstat: (path: string) => Promise<Stats>;
  readonly mkdir: (path: string) => Promise<void>;
  readonly open: (path: string, flags: string | number, mode?: number) => Promise<ProjectAgentFileHandle>;
  readonly readdir: (path: string) => Promise<string[]>;
  readonly rename: (oldPath: string, newPath: string) => Promise<void>;
  readonly randomId: () => string;
  readonly readActiveExperts: (projectRoot: string) => Promise<ActiveExperts>;
  readonly withWorkspaceLock: <T>(
    projectRoot: string,
    operation: () => Promise<T>,
  ) => Promise<T>;
}

export const nodeProjectAgentRuntime: ProjectAgentRuntime = {
  lstat,
  mkdir: async (path) => { await mkdir(path); },
  open: async (path, flags, mode) => open(path, flags, mode),
  readdir,
  rename,
  randomId: randomUUID,
  readActiveExperts: async (projectRoot) => new ActiveExpertRepository(projectRoot).read(),
  withWorkspaceLock,
};

interface FileObservation {
  readonly bytes: Buffer;
  readonly identity: FileIdentity;
  readonly path: string;
  readonly sha256: `sha256:${string}`;
}

interface DirectoryObservation {
  readonly identity: FileIdentity;
  readonly path: string;
}

interface GeneratedAgentManifest {
  readonly schemaVersion: 1;
  readonly files: Readonly<Record<string, `sha256:${string}`>>;
}

interface SyncPaths {
  readonly root: string;
  readonly workspace: string;
  readonly experts: string;
  readonly backups: string;
  readonly recoveryRoot: string;
  readonly codex: string;
  readonly agents: string;
  readonly manifest: string;
}

interface PlannedFile {
  readonly fileName: string;
  readonly rendered: RenderedProjectAgent | undefined;
  readonly priorHash: `sha256:${string}` | undefined;
  readonly current: FileObservation | undefined;
  readonly move: boolean;
  readonly publish: boolean;
}

interface RecoveryDirectories {
  readonly workspace: DirectoryObservation;
  readonly backups: DirectoryObservation;
  readonly root: DirectoryObservation;
  readonly run: DirectoryObservation;
}

interface WorkspaceBinding {
  readonly projectRoot: DirectoryObservation;
  readonly workspace: DirectoryObservation;
}

interface AgentDirectories {
  readonly projectRoot: DirectoryObservation;
  readonly codex: DirectoryObservation;
  readonly agents: DirectoryObservation;
}

export class ProjectAgentInspectionRequiredError extends Error {
  readonly code = "INSPECTION_REQUIRED" as const;
  readonly paths: readonly string[];
  readonly runPath: string | undefined;
  readonly nextPath: string | undefined;

  constructor(
    readonly operation: string,
    readonly recoveryPath: string,
    readonly backupPath: string | undefined,
    cause: unknown,
    evidence: {
      readonly runPath?: string;
      readonly nextPath?: string;
    } = {},
  ) {
    super(
      `${operation} failed and requires inspection; recovery: ${recoveryPath}; run: ${evidence.runPath ?? "not-created"}; next: ${evidence.nextPath ?? "not-created"}; backup: ${backupPath ?? "not-created"}`,
      { cause },
    );
    this.name = "ProjectAgentInspectionRequiredError";
    this.runPath = evidence.runPath;
    this.nextPath = evidence.nextPath;
    this.paths = Object.freeze([...new Set([
      recoveryPath,
      evidence.runPath,
      evidence.nextPath,
      backupPath,
    ].filter((path): path is string => path !== undefined))]);
  }
}

function boundedReadPolicy(label: string): BoundedReadPolicy {
  const invalidMessage = `${label} must be a bounded, uniquely linked regular file`;
  return {
    maximumBytes: MAX_FILE_BYTES,
    invalidMessage,
    changedMessage: `${label} changed during read`,
    exceedsMessage: `${label} exceeds its size limit`,
    mapOpenError: (error: unknown) => new Error(invalidMessage, { cause: error }),
  };
}

async function readOptionalFile(
  runtime: ProjectAgentRuntime,
  path: string,
  label: string,
  preflight?: Stats,
): Promise<FileObservation | undefined> {
  const before = preflight ?? await observed(runtime, path);
  if (before === undefined) return undefined;
  const result = await readNoFollowPathBounded(runtime, path, before, boundedReadPolicy(label));
  return { bytes: result.bytes, identity: result.identity, path, sha256: digest(result.bytes) };
}

function decodeUtf8(bytes: Buffer, label: string): string {
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    throw new Error(`${label} must not contain a UTF-8 BOM`);
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch (error: unknown) {
    throw new Error(`${label} must contain valid UTF-8`, { cause: error });
  }
}

function parseManifest(observation: FileObservation | undefined): GeneratedAgentManifest {
  if (observation === undefined) return { schemaVersion: 1, files: Object.freeze({}) };
  let parsed: unknown;
  try {
    parsed = JSON.parse(decodeUtf8(observation.bytes, "generated Codex manifest"));
  } catch (error: unknown) {
    throw new Error("generated Codex manifest is invalid", { cause: error });
  }
  const top = ownDataObject(parsed, "generated Codex manifest", MANIFEST_KEYS);
  if (top.schemaVersion !== 1) throw new Error("generated Codex manifest schemaVersion is invalid");
  const source = top.files;
  if (source === null || typeof source !== "object" || Array.isArray(source) || nodeTypes.isProxy(source)) {
    throw new Error("generated Codex manifest files must be an object");
  }
  const keys = Reflect.ownKeys(source);
  if (keys.length > MAX_AGENTS) throw new Error("generated Codex manifest has too many files");
  const files: Record<string, `sha256:${string}`> = Object.create(null) as Record<string, `sha256:${string}`>;
  const collision = new Set<string>();
  for (const key of keys) {
    if (typeof key !== "string" || !AGENT_FILE.test(key)) throw new Error("generated Codex manifest filename is invalid");
    const folded = unicodeDefaultCaseFold(key);
    if (collision.has(folded)) throw new Error("generated Codex manifest has a portable case-fold collision");
    collision.add(folded);
    const descriptor = Object.getOwnPropertyDescriptor(source, key);
    if (descriptor === undefined || !descriptor.enumerable || !("value" in descriptor) || typeof descriptor.value !== "string" || !HASH.test(descriptor.value)) {
      throw new Error("generated Codex manifest hash is invalid");
    }
    files[key] = descriptor.value as `sha256:${string}`;
  }
  return { schemaVersion: 1, files: Object.freeze(files) };
}

function pathsFor(projectRoot: string): SyncPaths {
  if (typeof projectRoot !== "string" || !isAbsolute(projectRoot) || projectRoot.includes("\0")) {
    throw new Error("project root must be an absolute path");
  }
  const root = resolve(projectRoot);
  const workspace = join(root, ".ezagent");
  const experts = join(workspace, "experts");
  const backups = join(workspace, "backups");
  const codex = join(root, ".codex");
  const agents = join(codex, "agents");
  return {
    root,
    workspace,
    experts,
    backups,
    recoveryRoot: join(backups, "generated-codex-agents"),
    codex,
    agents,
    manifest: join(experts, "generated-codex.json"),
  };
}

async function requireDirectory(runtime: ProjectAgentRuntime, path: string, label: string): Promise<DirectoryObservation> {
  const stat = await runtime.lstat(path);
  assertDirectory(stat, label);
  return { path, identity: identity(stat) };
}

async function optionalDirectory(runtime: ProjectAgentRuntime, path: string, label: string): Promise<DirectoryObservation | undefined> {
  const stat = await observed(runtime, path);
  if (stat === undefined) return undefined;
  assertDirectory(stat, label);
  return { path, identity: identity(stat) };
}

async function assertDirectoryIdentity(runtime: ProjectAgentRuntime, directory: DirectoryObservation): Promise<void> {
  await assertRealDirectoryIdentity(
    runtime,
    directory.path,
    directory.identity,
    directory.path,
    `${directory.path} changed during synchronization`,
  );
}

async function captureWorkspaceBinding(
  runtime: ProjectAgentRuntime,
  paths: SyncPaths,
): Promise<WorkspaceBinding> {
  return {
    projectRoot: await requireDirectory(runtime, paths.root, "project root"),
    workspace: await requireDirectory(runtime, paths.workspace, "workspace"),
  };
}

async function assertWorkspaceBinding(
  runtime: ProjectAgentRuntime,
  binding: WorkspaceBinding,
): Promise<void> {
  try {
    await assertDirectoryIdentity(runtime, binding.projectRoot);
    await assertDirectoryIdentity(runtime, binding.workspace);
  } catch (error: unknown) {
    throw new Error("project root or workspace identity changed during synchronization", { cause: error });
  }
}

function inspectionFromEvidence(
  operation: string,
  evidence: RecoveryEvidence,
  backup: RecoveryEvidence | undefined,
  cause: unknown,
): ProjectAgentInspectionRequiredError {
  const next = evidence.kind === "next" ? evidence : undefined;
  const resolvedBackup = evidence.kind === "bak" ? evidence : backup;
  return new ProjectAgentInspectionRequiredError(
    operation,
    evidence.recoveryPath,
    resolvedBackup?.path,
    cause,
    {
      runPath: evidence.runPath,
      ...(next === undefined ? {} : { nextPath: next.path }),
    },
  );
}

async function inspectBoundaries(
  runtime: ProjectAgentRuntime,
  paths: SyncPaths,
  rendered: readonly RenderedProjectAgent[],
  desiredManifestBytes: Buffer,
  evidenceIndex: RecoveryEvidenceIndex,
): Promise<{
  readonly manifest: GeneratedAgentManifest;
  readonly observation: FileObservation | undefined;
  readonly agentEntries: ReadonlySet<string>;
}> {
  await requireDirectory(runtime, paths.root, "project root");
  await requireDirectory(runtime, paths.workspace, "workspace");
  await requireDirectory(runtime, paths.experts, "workspace experts");
  await requireDirectory(runtime, paths.backups, "workspace backups");
  const codex = await optionalDirectory(runtime, paths.codex, "Codex directory");
  const agents = codex === undefined
    ? undefined
    : await optionalDirectory(runtime, paths.agents, "Codex agents directory");
  const manifestObservation = await readOptionalFile(runtime, paths.manifest, "generated Codex manifest");
  let manifest: GeneratedAgentManifest;
  try {
    manifest = parseManifest(manifestObservation);
  } catch (error: unknown) {
    const nextEvidence = findRecoveryEvidence(
      evidenceIndex,
      "generated-codex.json",
      "next",
      digest(desiredManifestBytes),
    );
    if (nextEvidence !== undefined) {
      throw inspectionFromEvidence(
        "partial generated Codex manifest retry",
        nextEvidence,
        findRunBackup(evidenceIndex, "generated-codex.json", nextEvidence.runPath),
        error,
      );
    }
    throw error;
  }
  const actualEntries = agents === undefined ? [] : await runtime.readdir(paths.agents);
  if (agents !== undefined) await assertDirectoryIdentity(runtime, agents);
  if (actualEntries.length > MAX_CODEX_AGENT_ENTRIES) throw new Error("Codex agents directory enumeration exceeds its limit");
  const portableNames = new Map<string, string>();
  const register = (name: string): void => {
    if (!isWellFormedUnicode(name)) throw new Error("Codex agents directory contains an invalid filename");
    const key = unicodeDefaultCaseFold(name.normalize("NFKC"));
    const previous = portableNames.get(key);
    if (previous !== undefined && previous !== name) {
      throw new Error(`Codex agents directory has a portable case-fold collision: ${previous}; ${name}`);
    }
    portableNames.set(key, name);
  };
  actualEntries.forEach(register);
  Object.keys(manifest.files).forEach(register);
  rendered.map((agent) => agent.fileName).forEach(register);
  const names = new Set([...Object.keys(manifest.files)]);
  for (const name of names) {
    await readOptionalFile(runtime, join(paths.agents, name), "managed agent");
  }
  return { manifest, observation: manifestObservation, agentEntries: new Set(actualEntries) };
}

function verifyActive(active: ActiveExperts, rendered: readonly RenderedProjectAgent[]): void {
  const expected = rendered.map((agent) => ({
    id: agent.expertId,
    reason: agent.assignment.reason,
    taskIds: [...agent.assignment.taskIds],
  })).sort((left, right) => portableCompare(left.id, right.id));
  const actual = active.experts.map((agent) => ({
    id: agent.id,
    reason: agent.reason,
    taskIds: [...agent.taskIds].sort(),
  })).sort((left, right) => portableCompare(left.id, right.id));
  if (JSON.stringify(expected) !== JSON.stringify(actual)) {
    throw new Error("rendered project agents do not match the active expert selection");
  }
}

async function planFiles(
  runtime: ProjectAgentRuntime,
  paths: SyncPaths,
  oldManifest: GeneratedAgentManifest,
  rendered: readonly RenderedProjectAgent[],
  binding: WorkspaceBinding,
  evidenceIndex: RecoveryEvidenceIndex,
): Promise<readonly PlannedFile[]> {
  const desired = new Map(rendered.map((agent) => [agent.fileName, agent]));
  const names = [...new Set([...Object.keys(oldManifest.files), ...desired.keys()])].sort();
  const plans: PlannedFile[] = [];
  for (const name of names) {
    await assertWorkspaceBinding(runtime, binding);
    const priorHash = oldManifest.files[name];
    const next = desired.get(name);
    const nextEvidence = next === undefined
      ? undefined
      : findRecoveryEvidence(evidenceIndex, name, "next", next.sha256);
    const priorBackup = priorHash === undefined
      ? undefined
      : findRecoveryEvidence(evidenceIndex, name, "bak", priorHash);
    const current = await readOptionalFile(runtime, join(paths.agents, name), "managed agent");
    await assertWorkspaceBinding(runtime, binding);
    if (priorHash !== undefined) {
      if (current === undefined) {
        plans.push({ fileName: name, rendered: next, priorHash, current, move: false, publish: next !== undefined });
      } else if (current.sha256 === priorHash) {
        plans.push({
          fileName: name,
          rendered: next,
          priorHash,
          current,
          move: next === undefined || next.sha256 !== priorHash,
          publish: next !== undefined && next.sha256 !== priorHash,
        });
      } else if (next !== undefined && current.sha256 === next.sha256) {
        plans.push({ fileName: name, rendered: next, priorHash, current, move: false, publish: false });
      } else {
        const deviationEvidence = nextEvidence ?? priorBackup;
        if (deviationEvidence !== undefined) {
          throw inspectionFromEvidence(
            "owned managed target differs after retained evidence",
            deviationEvidence,
            nextEvidence === undefined
              ? priorBackup
              : findRunBackup(evidenceIndex, name, nextEvidence.runPath, priorHash),
            new Error(name),
          );
        }
        throw new Error(`modified managed agent: ${name}`);
      }
    } else if (next !== undefined) {
      if (current !== undefined && current.sha256 !== next.sha256) {
        if (nextEvidence !== undefined) {
          throw inspectionFromEvidence(
            "partial managed target retry",
            nextEvidence,
            findRunBackup(evidenceIndex, name, nextEvidence.runPath),
            new Error(name),
          );
        }
        throw new Error(`unowned managed agent target already exists: ${name}`);
      }
      if (current !== undefined && nextEvidence === undefined) {
        throw new Error(`unowned managed agent target already exists without publication evidence: ${name}`);
      }
      plans.push({ fileName: name, rendered: next, priorHash, current, move: false, publish: current === undefined });
    }
  }
  return plans;
}

function canonicalManifest(rendered: readonly RenderedProjectAgent[]): { readonly value: GeneratedAgentManifest; readonly bytes: Buffer } {
  const files: Record<string, `sha256:${string}`> = Object.create(null) as Record<string, `sha256:${string}`>;
  for (const agent of rendered) files[agent.fileName] = agent.sha256;
  return {
    value: { schemaVersion: 1, files },
    bytes: Buffer.from(`${JSON.stringify({ schemaVersion: 1, files }, null, 2)}\n`, "utf8"),
  };
}

function plannedRecoveryBudget(
  plans: readonly PlannedFile[],
  manifestNeedsUpdate: boolean,
  oldManifestObservation: FileObservation | undefined,
  desiredManifestBytes: Buffer,
): { readonly bytes: number; readonly entries: number } {
  const budget = { bytes: 0 };
  let entries = 0;
  const charge = (size: number): void => {
    chargeByteBudget(
      budget,
      size,
      MAX_RECOVERY_EVIDENCE_BYTES_PER_RUN,
      "planned recovery per-run byte budget exceeded",
    );
    entries += 1;
    if (entries > MAX_RECOVERY_EVIDENCE_ENTRIES_PER_RUN) {
      throw new Error("planned recovery evidence entry count exceeds its per-run limit");
    }
  };
  for (const plan of plans) {
    if (plan.move) charge(plan.current!.bytes.length);
    if (plan.publish) charge(Buffer.byteLength(plan.rendered!.content, "utf8"));
  }
  if (manifestNeedsUpdate) {
    charge(desiredManifestBytes.length);
    if (oldManifestObservation !== undefined) charge(oldManifestObservation.bytes.length);
  }
  return { bytes: budget.bytes, entries };
}

async function ensureDirectory(
  runtime: ProjectAgentRuntime,
  path: string,
  label: string,
): Promise<DirectoryObservation> {
  let stat = await observed(runtime, path);
  if (stat === undefined) {
    try {
      await runtime.mkdir(path);
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    stat = await runtime.lstat(path);
  }
  assertDirectory(stat, label);
  return { path, identity: identity(stat) };
}

async function syncDirectory(runtime: ProjectAgentRuntime, directory: DirectoryObservation): Promise<void> {
  await syncDirectoryBestEffort(runtime, directory.path, {
    before: async () => assertDirectoryIdentity(runtime, directory),
    after: async () => assertDirectoryIdentity(runtime, directory),
  });
}

async function writeAll(handle: ProjectAgentFileHandle, bytes: Buffer): Promise<void> {
  let offset = 0;
  while (offset < bytes.length) {
    const result = await handle.write(bytes, offset, bytes.length - offset, offset);
    if (result.bytesWritten <= 0) throw new Error("exclusive file write made no progress");
    offset += result.bytesWritten;
  }
}

async function createExclusiveFile(
  runtime: ProjectAgentRuntime,
  path: string,
  bytes: Buffer,
  label: string,
): Promise<FileObservation> {
  let handle = await runtime.open(path, "wx", 0o600);
  let createdIdentity: FileIdentity | undefined;
  let failure: unknown;
  try {
    await writeAll(handle, bytes);
    await handle.sync();
    const checked = await handle.stat();
    assertBoundedRegularFile(checked, boundedReadPolicy(label));
    if (checked.size !== bytes.length) throw new Error(`${label} size verification failed`);
    createdIdentity = identity(checked);
  } catch (error: unknown) {
    failure = error;
    throw error;
  } finally {
    try {
      await handle.close();
    } catch (error: unknown) {
      if (failure === undefined) throw error;
    }
  }
  const result = await readOptionalFile(runtime, path, label);
  if (
    result === undefined
    || createdIdentity === undefined
    || !sameFile(result.identity, createdIdentity)
    || !result.bytes.equals(bytes)
  ) {
    throw new Error(`${label} path identity or content verification failed`);
  }
  return result;
}

async function restoreMovedReplacement(
  runtime: ProjectAgentRuntime,
  target: string,
  moved: FileObservation | undefined,
): Promise<void> {
  if (moved === undefined || await observed(runtime, target) !== undefined) return;
  try {
    await createExclusiveFile(runtime, target, moved.bytes, "concurrent replacement recovery");
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
}

async function recoverableMove(
  runtime: ProjectAgentRuntime,
  source: FileObservation,
  backupPath: string,
  recoveryPath: string,
): Promise<FileObservation> {
  const current = await readOptionalFile(runtime, source.path, "managed source before move");
  if (current === undefined || !sameFile(current.identity, source.identity) || !current.bytes.equals(source.bytes)) {
    throw new ProjectAgentInspectionRequiredError("managed source pre-move verification", recoveryPath, backupPath, new Error("source changed"));
  }
  if (await observed(runtime, backupPath) !== undefined) {
    throw new ProjectAgentInspectionRequiredError("backup no-clobber verification", recoveryPath, backupPath, new Error("backup appeared"));
  }
  try {
    await runtime.rename(source.path, backupPath);
  } catch (error: unknown) {
    const [sourceAfter, backupAfter] = await Promise.all([
      readOptionalFile(runtime, source.path, "ambiguous move source"),
      readOptionalFile(runtime, backupPath, "ambiguous move backup"),
    ]);
    if (sourceAfter === undefined && backupAfter !== undefined && backupAfter.sha256 !== source.sha256) {
      await restoreMovedReplacement(runtime, source.path, backupAfter);
    }
    throw new ProjectAgentInspectionRequiredError("ambiguous managed-file rename", recoveryPath, backupPath, error);
  }
  const [sourceAfter, backupAfter] = await Promise.all([
    readOptionalFile(runtime, source.path, "post-move source"),
    readOptionalFile(runtime, backupPath, "managed backup"),
  ]);
  if (
    sourceAfter !== undefined
    || backupAfter === undefined
    || !sameFile(backupAfter.identity, source.identity)
    || !backupAfter.bytes.equals(source.bytes)
  ) {
    if (sourceAfter === undefined && backupAfter !== undefined) {
      await restoreMovedReplacement(runtime, source.path, backupAfter);
    }
    throw new ProjectAgentInspectionRequiredError(
      "managed-file rename verification",
      recoveryPath,
      backupPath,
      new Error("source or backup identity changed"),
    );
  }
  return backupAfter;
}

async function publishNoClobber(
  runtime: ProjectAgentRuntime,
  target: string,
  stage: FileObservation,
  recoveryPath: string,
  runPath: string,
  backupPath: string | undefined,
): Promise<void> {
  if (await observed(runtime, target) !== undefined) {
    throw new ProjectAgentInspectionRequiredError(
      "managed target appeared",
      recoveryPath,
      backupPath,
      new Error(target),
      { runPath, nextPath: stage.path },
    );
  }
  try {
    const published = await createExclusiveFile(runtime, target, stage.bytes, "managed publication");
    if (published.sha256 !== stage.sha256) throw new Error("managed target hash mismatch");
  } catch (error: unknown) {
    if (error instanceof ProjectAgentInspectionRequiredError) throw error;
    throw new ProjectAgentInspectionRequiredError(
      "managed no-clobber publication",
      recoveryPath,
      backupPath,
      error,
      { runPath, nextPath: stage.path },
    );
  }
}

async function createRecoveryDirectory(
  runtime: ProjectAgentRuntime,
  paths: SyncPaths,
  binding: WorkspaceBinding,
): Promise<RecoveryDirectories> {
  await assertWorkspaceBinding(runtime, binding);
  const workspace = binding.workspace;
  const backups = await requireDirectory(runtime, paths.backups, "workspace backups");
  const root = await ensureDirectory(runtime, paths.recoveryRoot, "generated agent recovery root");
  try {
    await assertDirectoryIdentity(runtime, workspace);
    await assertDirectoryIdentity(runtime, backups);
    await assertDirectoryIdentity(runtime, root);
    await syncDirectory(runtime, backups);
  } catch (error: unknown) {
    throw new ProjectAgentInspectionRequiredError("recovery ancestor verification", paths.recoveryRoot, undefined, error);
  }
  const token = digest(runtime.randomId()).slice("sha256:".length, "sha256:".length + 24);
  const runPath = join(root.path, `run-${token}`);
  if (await observed(runtime, runPath) !== undefined) {
    throw new ProjectAgentInspectionRequiredError("exclusive recovery allocation", root.path, undefined, new Error(runPath));
  }
  try {
    await runtime.mkdir(runPath);
    const run = await requireDirectory(runtime, runPath, "generated agent recovery run");
    await assertDirectoryIdentity(runtime, workspace);
    await assertDirectoryIdentity(runtime, backups);
    await assertDirectoryIdentity(runtime, root);
    await syncDirectory(runtime, root);
    await assertWorkspaceBinding(runtime, binding);
    return { workspace, backups, root, run };
  } catch (error: unknown) {
    if (error instanceof ProjectAgentInspectionRequiredError) throw error;
    throw new ProjectAgentInspectionRequiredError("recovery directory creation", root.path, undefined, error);
  }
}

async function assertRecoveryDirectories(
  runtime: ProjectAgentRuntime,
  recovery: RecoveryDirectories,
): Promise<void> {
  await assertDirectoryIdentity(runtime, recovery.workspace);
  await assertDirectoryIdentity(runtime, recovery.backups);
  await assertDirectoryIdentity(runtime, recovery.root);
  await assertDirectoryIdentity(runtime, recovery.run);
}

async function ensureAgentDirectories(
  runtime: ProjectAgentRuntime,
  paths: SyncPaths,
): Promise<AgentDirectories> {
  const root = await requireDirectory(runtime, paths.root, "project root");
  const codex = await ensureDirectory(runtime, paths.codex, "Codex directory");
  await assertDirectoryIdentity(runtime, root);
  const agents = await ensureDirectory(runtime, paths.agents, "Codex agents directory");
  await assertDirectoryIdentity(runtime, root);
  await assertDirectoryIdentity(runtime, codex);
  return { projectRoot: root, codex, agents };
}

async function assertAgentDirectories(
  runtime: ProjectAgentRuntime,
  directories: AgentDirectories,
): Promise<void> {
  await assertDirectoryIdentity(runtime, directories.projectRoot);
  await assertDirectoryIdentity(runtime, directories.codex);
  await assertDirectoryIdentity(runtime, directories.agents);
}

async function synchronizeLocked(
  runtime: ProjectAgentRuntime,
  paths: SyncPaths,
  rendered: readonly RenderedProjectAgent[],
  binding: WorkspaceBinding,
): Promise<{ readonly synced: true; readonly files: readonly string[] }> {
  await assertWorkspaceBinding(runtime, binding);
  const desiredManifest = canonicalManifest(rendered);
  const evidenceIndex = await scanRecoveryEvidence({
    backupsPath: paths.backups,
    recoveryRoot: paths.recoveryRoot,
    readdir: runtime.readdir,
    lstat: runtime.lstat,
    assertWorkspaceBinding: async () => assertWorkspaceBinding(runtime, binding),
    requireDirectory: async (path, label) => requireDirectory(runtime, path, label),
    optionalDirectory: async (path, label) => optionalDirectory(runtime, path, label),
    assertDirectoryIdentity: async (directory) => assertDirectoryIdentity(runtime, directory),
    readOptionalFile: async (path, label, preflight) => (
      readOptionalFile(runtime, path, label, preflight)
    ),
  });
  await assertWorkspaceBinding(runtime, binding);
  const inspected = await inspectBoundaries(
    runtime,
    paths,
    rendered,
    desiredManifest.bytes,
    evidenceIndex,
  );
  await assertWorkspaceBinding(runtime, binding);
  const active = await runtime.readActiveExperts(paths.root);
  await assertWorkspaceBinding(runtime, binding);
  verifyActive(active, rendered);
  const oldManifestObservation = inspected.observation;
  const oldManifest = inspected.manifest;
  const plans = await planFiles(runtime, paths, oldManifest, rendered, binding, evidenceIndex);
  await assertWorkspaceBinding(runtime, binding);
  const manifestCurrent = oldManifestObservation?.bytes;
  const manifestNeedsUpdate = manifestCurrent === undefined || !manifestCurrent.equals(desiredManifest.bytes);
  const plannedRecovery = plannedRecoveryBudget(
    plans,
    manifestNeedsUpdate,
    oldManifestObservation,
    desiredManifest.bytes,
  );
  if (plannedRecovery.bytes > MAX_RECOVERY_EVIDENCE_BYTES_TOTAL - evidenceIndex.totalBytes) {
    throw new Error("planned recovery global byte budget exceeded");
  }
  const plannedRunDelta = plannedRecovery.entries === 0 ? 0 : 1;
  if (evidenceIndex.runCount > MAX_RECOVERY_RUNS - plannedRunDelta) {
    throw new Error("planned recovery run count exceeds its limit");
  }
  if (evidenceIndex.entryCount > MAX_RECOVERY_EVIDENCE_ENTRIES - plannedRecovery.entries) {
    throw new Error("planned recovery evidence entry count exceeds its global limit");
  }
  let finalAgentEntryCount = inspected.agentEntries.size;
  for (const plan of plans) {
    const listed = inspected.agentEntries.has(plan.fileName);
    if (listed !== (plan.current !== undefined)) {
      throw new Error(`Codex agents directory changed while planning: ${plan.fileName}`);
    }
    if (!plan.move && !plan.publish) continue;
    let presentAfter = listed;
    if (plan.move) presentAfter = false;
    if (plan.publish) presentAfter = true;
    finalAgentEntryCount += Number(presentAfter) - Number(listed);
  }
  if (finalAgentEntryCount > MAX_CODEX_AGENT_ENTRIES) {
    throw new Error("planned Codex agents entry count exceeds its limit");
  }
  const needsAgentsDirectory = plans.some((plan) => plan.move || plan.publish);
  if (!needsAgentsDirectory && !manifestNeedsUpdate) {
    await assertWorkspaceBinding(runtime, binding);
    return { synced: true, files: rendered.map((agent) => agent.fileName) };
  }

  let agentDirectories: AgentDirectories | undefined;
  await assertWorkspaceBinding(runtime, binding);
  if (needsAgentsDirectory || rendered.length > 0) agentDirectories = await ensureAgentDirectories(runtime, paths);
  await assertWorkspaceBinding(runtime, binding);
  const expertsDirectory = await requireDirectory(runtime, paths.experts, "workspace experts");
  await assertWorkspaceBinding(runtime, binding);
  const recovery = await createRecoveryDirectory(runtime, paths, binding);
  const stages = new Map<string, FileObservation>();
  try {
    for (const [index, plan] of plans.entries()) {
      if (!plan.publish) continue;
      await assertWorkspaceBinding(runtime, binding);
      await assertRecoveryDirectories(runtime, recovery);
      await assertWorkspaceBinding(runtime, binding);
      const stagePath = join(recovery.run.path, `${index}.${plan.fileName}.next`);
      stages.set(plan.fileName, await createExclusiveFile(
        runtime,
        stagePath,
        Buffer.from(plan.rendered!.content, "utf8"),
        "managed next recovery file",
      ));
      await assertRecoveryDirectories(runtime, recovery);
    }
    await assertRecoveryDirectories(runtime, recovery);
    const manifestStage = manifestNeedsUpdate
      ? await createExclusiveFile(
        runtime,
        join(recovery.run.path, "generated-codex.json.next"),
        desiredManifest.bytes,
        "manifest next recovery file",
      )
      : undefined;
    await assertRecoveryDirectories(runtime, recovery);
    await syncDirectory(runtime, recovery.run);

    // Phase A frees every stale/update target before Phase B creates any target.
    // Besides making move failure a publication barrier, this keeps the live
    // agents-directory peak bounded by max(initial entries, final entries).
    const planBackups = new Map<number, string>();
    for (const [index, plan] of plans.entries()) {
      if (!plan.move) continue;
      const planBackup = join(
        recovery.run.path,
        `${index}.${plan.fileName}.bak`,
      );
      planBackups.set(index, planBackup);
      try {
        await assertWorkspaceBinding(runtime, binding);
        await assertRecoveryDirectories(runtime, recovery);
        await assertAgentDirectories(runtime, agentDirectories!);
        await recoverableMove(runtime, plan.current!, planBackup, recovery.run.path);
        await assertRecoveryDirectories(runtime, recovery);
        await assertAgentDirectories(runtime, agentDirectories!);
        await syncDirectory(runtime, recovery.run);
        await syncDirectory(runtime, agentDirectories!.agents);
      } catch (error: unknown) {
        if (error instanceof ProjectAgentInspectionRequiredError) throw error;
        throw new ProjectAgentInspectionRequiredError(
          `project-agent Phase A move: ${plan.fileName}`,
          recovery.run.path,
          planBackup,
          error,
        );
      }
    }

    // Phase B starts only after every Phase A move and durability check passed.
    for (const [index, plan] of plans.entries()) {
      if (!plan.publish) continue;
      const planBackup = planBackups.get(index);
      try {
        await assertWorkspaceBinding(runtime, binding);
        await assertRecoveryDirectories(runtime, recovery);
        await assertAgentDirectories(runtime, agentDirectories!);
        await publishNoClobber(
          runtime,
          join(paths.agents, plan.fileName),
          stages.get(plan.fileName)!,
          recovery.root.path,
          recovery.run.path,
          planBackup,
        );
        await assertRecoveryDirectories(runtime, recovery);
        await assertAgentDirectories(runtime, agentDirectories!);
        await syncDirectory(runtime, agentDirectories!.agents);
      } catch (error: unknown) {
        if (error instanceof ProjectAgentInspectionRequiredError) throw error;
        throw new ProjectAgentInspectionRequiredError(
          `project-agent Phase B publication: ${plan.fileName}`,
          recovery.run.path,
          planBackup,
          error,
        );
      }
    }

    if (manifestNeedsUpdate) {
      let manifestBackup: string | undefined;
      try {
        await assertWorkspaceBinding(runtime, binding);
        await assertRecoveryDirectories(runtime, recovery);
        await assertDirectoryIdentity(runtime, expertsDirectory);
        if (oldManifestObservation !== undefined) {
          manifestBackup = join(recovery.run.path, "generated-codex.json.bak");
          await recoverableMove(runtime, oldManifestObservation, manifestBackup, recovery.run.path);
          await syncDirectory(runtime, recovery.run);
        }
        await assertWorkspaceBinding(runtime, binding);
        await publishNoClobber(
          runtime,
          paths.manifest,
          manifestStage!,
          recovery.root.path,
          recovery.run.path,
          manifestBackup,
        );
        await assertRecoveryDirectories(runtime, recovery);
        await assertDirectoryIdentity(runtime, expertsDirectory);
        await syncDirectory(runtime, expertsDirectory);
        await assertWorkspaceBinding(runtime, binding);
      } catch (error: unknown) {
        if (error instanceof ProjectAgentInspectionRequiredError) throw error;
        throw new ProjectAgentInspectionRequiredError(
          "generated Codex manifest synchronization",
          recovery.run.path,
          manifestBackup,
          error,
        );
      }
    }
  } catch (error: unknown) {
    if (error instanceof ProjectAgentInspectionRequiredError) throw error;
    throw new ProjectAgentInspectionRequiredError("project-agent synchronization", recovery.run.path, undefined, error);
  }

  try {
    await assertWorkspaceBinding(runtime, binding);
    const finalManifest = await readOptionalFile(runtime, paths.manifest, "generated Codex manifest");
    if (finalManifest === undefined || !finalManifest.bytes.equals(desiredManifest.bytes)) {
      throw new ProjectAgentInspectionRequiredError(
        "final manifest verification",
        recovery.run.path,
        undefined,
        new Error("manifest mismatch"),
      );
    }
    for (const agent of rendered) {
      await assertWorkspaceBinding(runtime, binding);
      const final = await readOptionalFile(runtime, join(paths.agents, agent.fileName), "managed agent");
      if (final === undefined || final.sha256 !== agent.sha256) {
        throw new ProjectAgentInspectionRequiredError(
          "final managed-agent verification",
          recovery.run.path,
          undefined,
          new Error(agent.fileName),
        );
      }
    }
    await assertWorkspaceBinding(runtime, binding);
  } catch (error: unknown) {
    if (error instanceof ProjectAgentInspectionRequiredError) throw error;
    throw new ProjectAgentInspectionRequiredError("final synchronization verification", recovery.run.path, undefined, error);
  }
  return { synced: true, files: rendered.map((agent) => agent.fileName) };
}

export async function syncProjectAgents(
  projectRoot: string,
  renderedValue: readonly RenderedProjectAgent[],
  runtime: ProjectAgentRuntime = nodeProjectAgentRuntime,
): Promise<{ readonly synced: true; readonly files: readonly string[] }> {
  const rendered = snapshotRendered(renderedValue);
  const paths = pathsFor(projectRoot);
  // Only pure input validation happens before binding and lock acquisition.
  // All mutable disk state is re-read while holding the workspace lock.
  const binding = await captureWorkspaceBinding(runtime, paths);
  return runtime.withWorkspaceLock(paths.root, async () => {
    await assertWorkspaceBinding(runtime, binding);
    return synchronizeLocked(runtime, paths, rendered, binding);
  });
}
