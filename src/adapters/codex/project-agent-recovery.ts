import { type Stats } from "node:fs";
import { join } from "node:path";

import { unicodeDefaultCaseFold } from "../../text/unicode-case-fold.js";
import {
  MAX_PROJECT_AGENTS,
  MAX_PROJECT_AGENT_FILE_BYTES,
  portableProjectAgentCompare,
} from "./project-agent-render.js";
import {
  assertBoundedRegularFile,
  chargeByteBudget,
  type BoundedReadPolicy,
  type FileIdentity,
} from "./safe-fs.js";

export const MAX_RECOVERY_RUNS = MAX_PROJECT_AGENTS * 8;
export const MAX_RECOVERY_EVIDENCE_ENTRIES = MAX_PROJECT_AGENTS * 16;
export const MAX_RECOVERY_EVIDENCE_ENTRIES_PER_RUN = MAX_PROJECT_AGENTS * 3 + 2;
export const MAX_RECOVERY_EVIDENCE_BYTES_PER_RUN = 8 * 1_048_576;
export const MAX_RECOVERY_EVIDENCE_BYTES_TOTAL = 32 * 1_048_576;

export type RecoveryEvidenceKind = "next" | "bak";

export interface RecoveryEvidence {
  readonly fileName: string;
  readonly kind: RecoveryEvidenceKind;
  readonly path: string;
  readonly recoveryPath: string;
  readonly runPath: string;
  readonly sha256: `sha256:${string}`;
}

export interface RecoveryEvidenceIndex {
  readonly byKey: ReadonlyMap<string, readonly RecoveryEvidence[]>;
  readonly runCount: number;
  readonly entryCount: number;
  readonly totalBytes: number;
}

export interface RecoveryDirectoryObservation {
  readonly identity: FileIdentity;
  readonly path: string;
}

export interface RecoveryFileObservation {
  readonly bytes: Buffer;
  readonly identity: FileIdentity;
  readonly path: string;
  readonly sha256: `sha256:${string}`;
}

interface RecoveryScanDependencies {
  readonly backupsPath: string;
  readonly recoveryRoot: string;
  readonly readdir: (path: string) => Promise<string[]>;
  readonly lstat: (path: string) => Promise<Stats>;
  readonly assertWorkspaceBinding: () => Promise<void>;
  readonly requireDirectory: (
    path: string,
    label: string,
  ) => Promise<RecoveryDirectoryObservation>;
  readonly optionalDirectory: (
    path: string,
    label: string,
  ) => Promise<RecoveryDirectoryObservation | undefined>;
  readonly assertDirectoryIdentity: (
    directory: RecoveryDirectoryObservation,
  ) => Promise<void>;
  readonly readOptionalFile: (
    path: string,
    label: string,
    preflight?: Stats,
  ) => Promise<RecoveryFileObservation | undefined>;
}

const RECOVERY_READ_POLICY: BoundedReadPolicy = Object.freeze({
  maximumBytes: MAX_PROJECT_AGENT_FILE_BYTES,
  invalidMessage: "generated agent recovery evidence must be a bounded, uniquely linked regular file",
  changedMessage: "generated agent recovery evidence changed during read",
  exceedsMessage: "generated agent recovery evidence exceeds its size limit",
});

function recoveryEvidenceKey(
  fileName: string,
  kind: RecoveryEvidenceKind,
  sha256: `sha256:${string}`,
): string {
  return `${fileName}\0${kind}\0${sha256}`;
}

export function findRecoveryEvidence(
  index: RecoveryEvidenceIndex,
  fileName: string,
  kind: RecoveryEvidenceKind,
  sha256: `sha256:${string}`,
): RecoveryEvidence | undefined {
  return index.byKey.get(recoveryEvidenceKey(fileName, kind, sha256))?.[0];
}

export function findRunBackup(
  index: RecoveryEvidenceIndex,
  fileName: string,
  runPath: string,
  sha256?: `sha256:${string}`,
): RecoveryEvidence | undefined {
  for (const entries of index.byKey.values()) {
    const match = entries.find((entry) => (
      entry.fileName === fileName
      && entry.kind === "bak"
      && entry.runPath === runPath
      && (sha256 === undefined || entry.sha256 === sha256)
    ));
    if (match !== undefined) return match;
  }
  return undefined;
}

export async function scanRecoveryEvidence(
  dependencies: RecoveryScanDependencies,
): Promise<RecoveryEvidenceIndex> {
  await dependencies.assertWorkspaceBinding();
  const backups = await dependencies.requireDirectory(dependencies.backupsPath, "workspace backups");
  const root = await dependencies.optionalDirectory(
    dependencies.recoveryRoot,
    "generated agent recovery root",
  );
  if (root === undefined) {
    await dependencies.assertWorkspaceBinding();
    await dependencies.assertDirectoryIdentity(backups);
    return { byKey: new Map(), runCount: 0, entryCount: 0, totalBytes: 0 };
  }
  const evidence = new Map<string, RecoveryEvidence[]>();
  const observedRuns = await dependencies.readdir(root.path);
  if (observedRuns.length > MAX_RECOVERY_RUNS) {
    throw new Error("generated agent recovery root has too many entries");
  }
  const runs = [...observedRuns].sort(portableProjectAgentCompare);
  const runCollisions = new Map<string, string>();
  let scannedEntries = 0;
  const totalEvidenceBudget = { bytes: 0 };
  for (const name of runs) {
    if (!/^run-[0-9a-f]{24}$/u.test(name)) {
      throw new Error("generated agent recovery root contains an invalid entry");
    }
    const foldedRun = unicodeDefaultCaseFold(name.normalize("NFKC"));
    const previousRun = runCollisions.get(foldedRun);
    if (previousRun !== undefined && previousRun !== name) {
      throw new Error("generated agent recovery run has a portable collision");
    }
    runCollisions.set(foldedRun, name);
    const run = await dependencies.requireDirectory(
      join(root.path, name),
      "generated agent recovery run",
    );
    await dependencies.assertWorkspaceBinding();
    await dependencies.assertDirectoryIdentity(backups);
    await dependencies.assertDirectoryIdentity(root);
    const observedEntries = await dependencies.readdir(run.path);
    if (observedEntries.length > MAX_RECOVERY_EVIDENCE_ENTRIES_PER_RUN) {
      throw new Error("generated agent recovery run has too many entries");
    }
    const entries = [...observedEntries].sort(portableProjectAgentCompare);
    scannedEntries += entries.length;
    if (scannedEntries > MAX_RECOVERY_EVIDENCE_ENTRIES) {
      throw new Error("generated agent recovery evidence exceeds its global limit");
    }
    const entryCollisions = new Map<string, string>();
    const runEvidenceBudget = { bytes: 0 };
    for (const entry of entries) {
      const foldedEntry = unicodeDefaultCaseFold(entry.normalize("NFKC"));
      const previousEntry = entryCollisions.get(foldedEntry);
      if (previousEntry !== undefined && previousEntry !== entry) {
        throw new Error("generated agent recovery entry has a portable collision");
      }
      entryCollisions.set(foldedEntry, entry);
      const manifestMatch = /^(generated-codex\.json)\.(next|bak)$/u.exec(entry);
      const agentMatch = /^(?:0|[1-9]\d*)\.(ezagent-[a-z0-9]+(?:-[a-z0-9]+)*\.toml)\.(next|bak)$/u.exec(entry);
      const fileName = manifestMatch?.[1] ?? agentMatch?.[1];
      const kind = manifestMatch?.[2] ?? agentMatch?.[2];
      if (fileName === undefined || (kind !== "next" && kind !== "bak")) {
        throw new Error("generated agent recovery run contains an invalid evidence entry");
      }
      const evidencePath = join(run.path, entry);
      const before = await dependencies.lstat(evidencePath);
      assertBoundedRegularFile(before, RECOVERY_READ_POLICY);
      chargeByteBudget(
        runEvidenceBudget,
        before.size,
        MAX_RECOVERY_EVIDENCE_BYTES_PER_RUN,
        "generated agent recovery per-run byte budget exceeded",
      );
      chargeByteBudget(
        totalEvidenceBudget,
        before.size,
        MAX_RECOVERY_EVIDENCE_BYTES_TOTAL,
        "generated agent recovery global byte budget exceeded",
      );
      const observation = await dependencies.readOptionalFile(
        evidencePath,
        "generated agent recovery evidence",
        before,
      );
      if (observation === undefined) {
        throw new Error("generated agent recovery evidence disappeared during scan");
      }
      const indexed: RecoveryEvidence = {
        fileName,
        kind,
        path: observation.path,
        recoveryPath: root.path,
        runPath: run.path,
        sha256: observation.sha256,
      };
      const key = recoveryEvidenceKey(fileName, kind, observation.sha256);
      const items = evidence.get(key) ?? [];
      items.push(indexed);
      evidence.set(key, items);
      await dependencies.assertWorkspaceBinding();
      await dependencies.assertDirectoryIdentity(backups);
      await dependencies.assertDirectoryIdentity(root);
      await dependencies.assertDirectoryIdentity(run);
    }
    await dependencies.assertDirectoryIdentity(run);
    await dependencies.assertDirectoryIdentity(root);
  }
  await dependencies.assertDirectoryIdentity(backups);
  await dependencies.assertWorkspaceBinding();
  return {
    byKey: evidence,
    runCount: runs.length,
    entryCount: scannedEntries,
    totalBytes: totalEvidenceBudget.bytes,
  };
}
