#!/usr/bin/env node
import { realpathSync } from "node:fs";
import { lstat } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

import { transitionWorkItem } from "../domain/state-machine.js";
import type { WorkItemStatus } from "../domain/work-item.js";
import { isWellFormedUnicode } from "../text/unicode.js";
import { WorkspaceRepository } from "../workspace/repository.js";

const USAGE = "usage: ezagent <doctor|init|context|transition> [options]";
const PROJECT_NAME_MAX_LENGTH = 128;
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/giu;
const AUTHORIZATION_ID = /^AUTH-(\d{4})(\d{2})(\d{2})-(\d{3})$/u;
const WORK_ITEM_STATUSES = [
  "captured",
  "clarifying",
  "specified",
  "approved",
  "planned",
  "implementing",
  "verifying",
  "completed",
  "cancelled",
] as const satisfies readonly WorkItemStatus[];

type Command = "doctor" | "init" | "context" | "transition";

interface CommandSpec {
  readonly valueOptions: readonly string[];
  readonly booleanOptions: readonly string[];
  readonly requiredOptions: readonly string[];
}

const COMMAND_SPECS: Readonly<Record<Command, CommandSpec>> = {
  doctor: {
    valueOptions: ["--root"],
    booleanOptions: [],
    requiredOptions: [],
  },
  init: {
    valueOptions: ["--root", "--name"],
    booleanOptions: [],
    requiredOptions: ["--root", "--name"],
  },
  context: {
    valueOptions: ["--root"],
    booleanOptions: ["--json"],
    requiredOptions: ["--root", "--json"],
  },
  transition: {
    valueOptions: ["--root", "--to", "--revision", "--high-risk-authorization"],
    booleanOptions: [],
    requiredOptions: ["--root", "--to", "--revision"],
  },
};

interface ParsedCommand {
  readonly command: Command;
  readonly options: ReadonlyMap<string, string | true>;
}

export interface CliIo {
  readonly stdout: { readonly write: (contents: string) => unknown };
}

export interface CliRuntime {
  readonly cwd: () => string;
  readonly nodeVersion: string;
  readonly lstat: (path: string) => Promise<{ readonly isDirectory: () => boolean }>;
  readonly createRepository: (root: string) => WorkspaceRepository;
}

const defaultRuntime: CliRuntime = {
  cwd: () => process.cwd(),
  nodeVersion: process.version,
  lstat,
  createRepository: (root) => new WorkspaceRepository(root),
};

function isCommand(value: string | undefined): value is Command {
  return value !== undefined && Object.hasOwn(COMMAND_SPECS, value);
}

function parseCommand(argv: readonly string[]): ParsedCommand {
  const command = argv[0];
  if (!isCommand(command)) throw new Error(USAGE);

  const spec = COMMAND_SPECS[command];
  const valueOptions = new Set(spec.valueOptions);
  const booleanOptions = new Set(spec.booleanOptions);
  const options = new Map<string, string | true>();

  for (let index = 1; index < argv.length; index += 1) {
    const token = argv[index]!;
    if (!token.startsWith("--")) {
      throw new Error(`unexpected positional argument: ${token}`);
    }
    if (!valueOptions.has(token) && !booleanOptions.has(token)) {
      throw new Error(`unknown option for ${command}: ${token}`);
    }
    if (options.has(token)) {
      throw new Error(`duplicate option: ${token}`);
    }
    if (booleanOptions.has(token)) {
      options.set(token, true);
      continue;
    }

    const value = argv[index + 1];
    if (value === undefined || value.startsWith("--")) {
      throw new Error(`${token} requires a value`);
    }
    options.set(token, value);
    index += 1;
  }

  const missing = spec.requiredOptions.find((option) => !options.has(option));
  if (missing !== undefined) throw new Error(`${missing} is required for ${command}`);
  return { command, options };
}

function valueOption(parsed: ParsedCommand, name: string): string | undefined {
  const value = parsed.options.get(name);
  return typeof value === "string" ? value : undefined;
}

function requiredValueOption(parsed: ParsedCommand, name: string): string {
  const value = valueOption(parsed, name);
  if (value === undefined) throw new Error(`${name} is required for ${parsed.command}`);
  return value;
}

function absoluteRoot(parsed: ParsedCommand, runtime: CliRuntime): string {
  const supplied = valueOption(parsed, "--root");
  if (supplied === "") throw new Error("--root requires a non-empty value");
  return resolve(runtime.cwd(), supplied ?? ".");
}

function projectName(value: string): string {
  const normalized = value.trim();
  if (
    normalized.length === 0
    || normalized.length > PROJECT_NAME_MAX_LENGTH
    || !isWellFormedUnicode(normalized)
    || /[\u0000-\u001f\u007f]/u.test(normalized)
  ) {
    throw new Error(`project name must be 1-${PROJECT_NAME_MAX_LENGTH} printable characters`);
  }
  return normalized;
}

function workItemStatus(value: string): WorkItemStatus {
  if (!(WORK_ITEM_STATUSES as readonly string[]).includes(value)) {
    throw new Error(`--to must be one of: ${WORK_ITEM_STATUSES.join(", ")}`);
  }
  return value as WorkItemStatus;
}

function canonicalRevision(value: string): number {
  if (!/^(?:0|[1-9]\d*)$/u.test(value)) {
    throw new Error("--revision must be a canonical non-negative safe decimal integer");
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) {
    throw new Error("--revision must be a canonical non-negative safe decimal integer");
  }
  return parsed;
}

function authorizationId(value: string): string {
  const normalized = value.trim();
  const match = AUTHORIZATION_ID.exec(normalized);
  if (match === null) {
    throw new Error("--high-risk-authorization must match AUTH-YYYYMMDD-NNN with a real date");
  }
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(0);
  date.setUTCFullYear(year, month - 1, day);
  date.setUTCHours(0, 0, 0, 0);
  if (
    year < 1000
    || year > 9999
    || date.getUTCFullYear() !== year
    || date.getUTCMonth() !== month - 1
    || date.getUTCDate() !== day
  ) {
    throw new Error("--high-risk-authorization must match AUTH-YYYYMMDD-NNN with a real date");
  }
  return normalized;
}

function writeJson(io: CliIo, value: unknown): void {
  const json = JSON.stringify(value)
    .replace(/\u2028/gu, "\\u2028")
    .replace(/\u2029/gu, "\\u2029");
  io.stdout.write(`${json}\n`);
}

async function assertDoctorRoot(runtime: CliRuntime, root: string): Promise<void> {
  let observed: Awaited<ReturnType<CliRuntime["lstat"]>>;
  try {
    observed = await runtime.lstat(root);
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error(`project root does not exist: ${root}`);
    }
    throw error;
  }
  if (!observed.isDirectory()) throw new Error(`project root is not a directory: ${root}`);
}

export async function runCli(
  argv: readonly string[],
  io: CliIo = process,
  runtime: CliRuntime = defaultRuntime,
): Promise<void> {
  const parsed = parseCommand(argv);
  const root = absoluteRoot(parsed, runtime);

  if (parsed.command === "doctor") {
    await assertDoctorRoot(runtime, root);
    writeJson(io, { ok: true, node: runtime.nodeVersion, root });
    return;
  }

  const repository = runtime.createRepository(root);
  if (parsed.command === "init") {
    const name = projectName(requiredValueOption(parsed, "--name"));
    await repository.initialize({ schemaVersion: 1, name, gitTracking: "none" });
    writeJson(io, { ok: true, initialized: true, root });
    return;
  }

  if (parsed.command === "context") {
    writeJson(io, await repository.readContext());
    return;
  }

  const to = workItemStatus(requiredValueOption(parsed, "--to"));
  const revision = canonicalRevision(requiredValueOption(parsed, "--revision"));
  const suppliedAuthorization = valueOption(parsed, "--high-risk-authorization");
  const normalizedAuthorization = suppliedAuthorization === undefined
    ? undefined
    : authorizationId(suppliedAuthorization);
  const context = await repository.readContext();
  if (context.state.safeMode) throw new Error("workspace is in safe mode; transition is disabled");
  if (context.state.activeWorkItem === null) throw new Error("no active work item");

  const activeWorkItem = transitionWorkItem(context.state.activeWorkItem, {
    to,
    expectedRevision: revision,
    ...(normalizedAuthorization === undefined
      ? {}
      : { highRiskAuthorizationId: normalizedAuthorization }),
  });
  const next = {
    ...context.state,
    revision: context.state.revision + 1,
    activeWorkItem,
  };
  await repository.commitMutation(
    next,
    context.state.revision,
    "work-item-transitioned",
    [],
    normalizedAuthorization === undefined
      ? {}
      : { highRiskAuthorizationId: normalizedAuthorization },
  );
  writeJson(io, next);
}

export function formatCliError(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  const singleLine = raw.replace(/[\r\n\u2028\u2029]+/gu, " ").trim();
  return (singleLine || "command failed").replace(UUID, "<redacted>");
}

function isDirectExecution(): boolean {
  const entry = process.argv[1];
  if (entry === undefined) return false;
  const modulePath = fileURLToPath(import.meta.url);
  try {
    return realpathSync(entry) === realpathSync(modulePath);
  } catch {
    return resolve(entry) === resolve(modulePath);
  }
}

if (isDirectExecution()) {
  runCli(process.argv.slice(2)).catch((error: unknown) => {
    process.stderr.write(`${formatCliError(error)}\n`);
    process.exitCode = 1;
  });
}
