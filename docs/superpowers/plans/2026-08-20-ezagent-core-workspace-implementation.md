# EZagent Local Core and Workspace Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the cross-platform TypeScript local core that initializes, validates, transitions, audits, and recovers an `.ezagent/` workspace without any Codex-specific behavior.

**Architecture:** Keep domain rules pure and place filesystem effects behind a `WorkspaceRepository`. Use Markdown/YAML for human-owned artifacts, JSON for state projections, JSONL for append-only audit, revision checks for optimistic concurrency, and a short-lived lock for writes.

**Tech Stack:** Node.js 22+, TypeScript, npm, Zod, YAML, Vitest, Node filesystem APIs.

---

## File map

- `package.json`: scripts, runtime metadata, and CLI entry.
- `tsconfig.json`: strict ESM TypeScript build.
- `src/version.ts`: single package version export.
- `src/domain/work-item.ts`: domain enums and data contracts.
- `src/domain/id.ts`: stable work-item ID generation and validation.
- `src/domain/state-machine.ts`: legal transitions and approval guards.
- `src/workspace/errors.ts`: typed workspace errors.
- `src/workspace/layout.ts`: all `.ezagent/` paths.
- `src/workspace/schema.ts`: YAML/JSON schemas and parsers.
- `src/workspace/atomic-write.ts`: atomic text replacement.
- `src/workspace/lock.ts`: short-lived workspace write lock.
- `src/workspace/repository.ts`: initialization, state reads, revisioned writes, context.
- `src/audit/events.ts`: append and validate JSONL events.
- `src/audit/recovery.ts`: rebuild state from valid audit history.
- `src/cli/main.ts`: internal `doctor`, `init`, `context`, and `transition` commands.
- `test/domain/**`: pure domain tests.
- `test/workspace/**`: filesystem, corruption, locking, and recovery tests.
- `test/cli/**`: child-process CLI tests.

### Task 1: Bootstrap a strict TypeScript project

**Files:**
- Create: `package.json`
- Create: `tsconfig.json`
- Create: `.gitignore`
- Create: `src/version.ts`
- Test: `test/version.test.ts`

- [ ] **Step 1: Create package and compiler configuration**

```json
{
  "name": "@ezagent/spec",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "bin": {
    "ezagent": "./dist/src/cli/main.js"
  },
  "engines": {
    "node": ">=22"
  },
  "scripts": {
    "build": "tsc -p tsconfig.json",
    "check": "tsc -p tsconfig.json --noEmit",
    "test": "vitest run",
    "test:core": "vitest run test/domain test/workspace test/cli",
    "test:experts": "vitest run test/experts",
    "test:codex": "vitest run test/codex",
    "test:workflow": "vitest run test/workflow test/e2e",
    "verify": "npm run check && npm run test && npm run build"
  }
}
```

```json
{
  "compilerOptions": {
    "target": "ES2023",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "rootDir": ".",
    "outDir": "dist",
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "exactOptionalPropertyTypes": true,
    "declaration": true,
    "sourceMap": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "types": ["node", "vitest/globals"]
  },
  "include": ["src/**/*.ts", "scripts/**/*.ts", "test/**/*.ts"],
  "exclude": ["dist", "node_modules"]
}
```

```gitignore
node_modules/
dist/
coverage/
*.log
.DS_Store
.codegraph/
.superpowers/
```

- [ ] **Step 2: Install and lock development dependencies**

Run:

```bash
npm install yaml zod
npm install --save-dev typescript tsx vitest @types/node
```

Expected: `package-lock.json` is created, `npm audit` output is reviewed, and both commands exit `0`.

- [ ] **Step 3: Write a failing version test**

```ts
// test/version.test.ts
import { describe, expect, it } from "vitest";
import { EZAGENT_VERSION } from "../src/version.js";

describe("EZAGENT_VERSION", () => {
  it("matches the package version", () => {
    expect(EZAGENT_VERSION).toBe("0.1.0");
  });
});
```

- [ ] **Step 4: Run the test and observe the intended failure**

Run: `npm test -- test/version.test.ts`

Expected: FAIL because `src/version.ts` does not exist.

- [ ] **Step 5: Add the minimal version module**

```ts
// src/version.ts
export const EZAGENT_VERSION = "0.1.0" as const;
```

- [ ] **Step 6: Verify scaffold and commit**

Run: `npm run check && npm test -- test/version.test.ts && npm run build`

Expected: all commands exit `0` and `dist/src/version.js` exists.

```bash
git add package.json package-lock.json tsconfig.json .gitignore src/version.ts test/version.test.ts
git commit -m "build: scaffold TypeScript local core"
```

### Task 2: Define work-item types, IDs, and legal transitions

**Files:**
- Create: `src/domain/work-item.ts`
- Create: `src/domain/id.ts`
- Create: `src/domain/state-machine.ts`
- Test: `test/domain/id.test.ts`
- Test: `test/domain/state-machine.test.ts`

- [ ] **Step 1: Write failing ID and transition tests**

```ts
// test/domain/id.test.ts
import { describe, expect, it } from "vitest";
import { createWorkItemId, isWorkItemId } from "../../src/domain/id.js";

describe("work item IDs", () => {
  it("creates stable date-prefixed IDs", () => {
    expect(createWorkItemId("spec", new Date("2026-08-20T01:00:00Z"), 7)).toBe("SPEC-20260820-007");
  });

  it("rejects unsupported prefixes", () => {
    expect(isWorkItemId("THING-20260820-001")).toBe(false);
  });
});
```

```ts
// test/domain/state-machine.test.ts
import { describe, expect, it } from "vitest";
import { transitionWorkItem } from "../../src/domain/state-machine.js";

describe("transitionWorkItem", () => {
  it("blocks standard implementation before approval", () => {
    expect(() => transitionWorkItem({
      id: "SPEC-20260820-001",
      kind: "spec",
      status: "specified",
      risk: "standard",
      revision: 2,
    }, { to: "implementing", expectedRevision: 2 })).toThrow("approved");
  });

  it("allows verification failure to return to implementation", () => {
    const next = transitionWorkItem({
      id: "TASK-20260820-001",
      kind: "task",
      status: "verifying",
      risk: "standard",
      revision: 5,
    }, { to: "implementing", expectedRevision: 5 });
    expect(next).toMatchObject({ status: "implementing", revision: 6 });
  });

  it("requires one-time high-risk authorization before implementation", () => {
    expect(() => transitionWorkItem({
      id: "TASK-20260820-002",
      kind: "task",
      status: "planned",
      risk: "high",
      revision: 1,
    }, { to: "implementing", expectedRevision: 1 })).toThrow("authorization");
  });
});
```

- [ ] **Step 2: Run tests and verify missing modules fail**

Run: `npm test -- test/domain/id.test.ts test/domain/state-machine.test.ts`

Expected: FAIL with module resolution errors for `src/domain/id.ts` and `state-machine.ts`.

- [ ] **Step 3: Add domain contracts and ID functions**

```ts
// src/domain/work-item.ts
export type WorkItemKind = "requirement" | "spec" | "task";
export type RiskLevel = "consult" | "light" | "standard" | "high";
export type WorkItemStatus =
  | "captured"
  | "clarifying"
  | "specified"
  | "approved"
  | "planned"
  | "implementing"
  | "verifying"
  | "completed"
  | "cancelled";

export interface WorkItemState {
  id: string;
  kind: WorkItemKind;
  status: WorkItemStatus;
  risk: RiskLevel;
  revision: number;
}

export interface TransitionRequest {
  to: WorkItemStatus;
  expectedRevision: number;
  highRiskAuthorizationId?: string;
}
```

```ts
// src/domain/id.ts
import type { WorkItemKind } from "./work-item.js";

const PREFIX = { requirement: "REQ", spec: "SPEC", task: "TASK" } as const;
const ID_PATTERN = /^(REQ|SPEC|TASK)-\d{8}-\d{3,}$/;

export function createWorkItemId(kind: WorkItemKind, date: Date, sequence: number): string {
  if (!Number.isInteger(sequence) || sequence < 1) throw new Error("sequence must be a positive integer");
  const day = date.toISOString().slice(0, 10).replaceAll("-", "");
  return `${PREFIX[kind]}-${day}-${String(sequence).padStart(3, "0")}`;
}

export function isWorkItemId(value: string): boolean {
  return ID_PATTERN.test(value);
}
```

- [ ] **Step 4: Add the guarded state machine**

```ts
// src/domain/state-machine.ts
import type { TransitionRequest, WorkItemState, WorkItemStatus } from "./work-item.js";

const ALLOWED: Readonly<Record<WorkItemStatus, readonly WorkItemStatus[]>> = {
  captured: ["clarifying", "cancelled"],
  clarifying: ["captured", "specified", "cancelled"],
  specified: ["clarifying", "approved", "cancelled"],
  approved: ["planned", "cancelled"],
  planned: ["implementing", "cancelled"],
  implementing: ["verifying", "cancelled"],
  verifying: ["implementing", "completed", "cancelled"],
  completed: [],
  cancelled: [],
};

export function transitionWorkItem(current: WorkItemState, request: TransitionRequest): WorkItemState {
  if (request.expectedRevision !== current.revision) {
    throw new Error(`revision conflict: expected ${request.expectedRevision}, actual ${current.revision}`);
  }
  if (request.to === "implementing" && !["approved", "planned", "verifying"].includes(current.status)) {
    throw new Error("work item must be approved before implementing");
  }
  if (!ALLOWED[current.status].includes(request.to)) {
    throw new Error(`illegal transition: ${current.status} -> ${request.to}`);
  }
  if (request.to === "implementing" && current.risk === "high" && current.status !== "verifying" && !request.highRiskAuthorizationId) {
    throw new Error("high-risk implementation requires authorization");
  }
  return { ...current, status: request.to, revision: current.revision + 1 };
}
```

- [ ] **Step 5: Run domain tests and commit**

Run: `npm test -- test/domain/id.test.ts test/domain/state-machine.test.ts && npm run check`

Expected: PASS with 5 tests.

```bash
git add src/domain test/domain
git commit -m "feat: add work item state machine"
```

### Task 3: Define workspace layout and schemas

**Files:**
- Create: `src/workspace/errors.ts`
- Create: `src/workspace/layout.ts`
- Create: `src/workspace/schema.ts`
- Test: `test/workspace/schema.test.ts`

- [ ] **Step 1: Write failing schema tests**

```ts
// test/workspace/schema.test.ts
import { describe, expect, it } from "vitest";
import { parseProjectConfig, parseWorkspaceState } from "../../src/workspace/schema.js";

describe("workspace schemas", () => {
  it("parses the default local-only project policy", () => {
    const config = parseProjectConfig("schemaVersion: 1\nname: Demo\ngitTracking: none\n");
    expect(config).toEqual({ schemaVersion: 1, name: "Demo", gitTracking: "none" });
  });

  it("rejects an invalid workspace revision", () => {
    expect(() => parseWorkspaceState({ schemaVersion: 1, revision: -1, activeWorkItem: null, safeMode: false })).toThrow();
  });
});
```

- [ ] **Step 2: Run tests and verify failure**

Run: `npm test -- test/workspace/schema.test.ts`

Expected: FAIL because the workspace modules do not exist.

- [ ] **Step 3: Add errors and path layout**

```ts
// src/workspace/errors.ts
export class WorkspaceNotInitializedError extends Error {}
export class WorkspaceCorruptError extends Error {}
export class WorkspaceLockedError extends Error {}
```

```ts
// src/workspace/layout.ts
import { join } from "node:path";

export const WORKSPACE_DIRECTORIES = [
  "state", "requirements", "specs", "tasks", "knowledge/decisions", "knowledge/patterns",
  "experts", "quality/runs", "quality/authorizations", "audit", "backups",
] as const;

export function workspacePaths(projectRoot: string) {
  const root = join(projectRoot, ".ezagent");
  return {
    root,
    project: join(root, "project.yaml"),
    state: join(root, "state", "workspace.json"),
    lock: join(root, "state", "write.lock"),
    audit: join(root, "audit", "events.jsonl"),
  } as const;
}
```

- [ ] **Step 4: Add strict YAML and JSON schemas**

```ts
// src/workspace/schema.ts
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { z } from "zod";
import type { WorkItemState } from "../domain/work-item.js";

const workItemStateSchema = z.object({
  id: z.string().min(1),
  kind: z.enum(["requirement", "spec", "task"]),
  status: z.enum(["captured", "clarifying", "specified", "approved", "planned", "implementing", "verifying", "completed", "cancelled"]),
  risk: z.enum(["consult", "light", "standard", "high"]),
  revision: z.number().int().nonnegative(),
});

const projectConfigSchema = z.object({
  schemaVersion: z.literal(1),
  name: z.string().min(1),
  gitTracking: z.enum(["none", "artifacts", "all"]).default("none"),
});

const workspaceStateSchema = z.object({
  schemaVersion: z.literal(1),
  revision: z.number().int().nonnegative(),
  activeWorkItem: workItemStateSchema.nullable(),
  safeMode: z.boolean(),
});

export type ProjectConfig = z.infer<typeof projectConfigSchema>;
export type WorkspaceState = Omit<z.infer<typeof workspaceStateSchema>, "activeWorkItem"> & { activeWorkItem: WorkItemState | null };

export const parseProjectConfig = (text: string): ProjectConfig => projectConfigSchema.parse(parseYaml(text));
export const serializeProjectConfig = (config: ProjectConfig): string => stringifyYaml(projectConfigSchema.parse(config));
export const parseWorkspaceState = (value: unknown): WorkspaceState => workspaceStateSchema.parse(value) as WorkspaceState;
```

- [ ] **Step 5: Verify schemas and commit**

Run: `npm test -- test/workspace/schema.test.ts && npm run check`

Expected: PASS with 2 tests.

```bash
git add src/workspace test/workspace/schema.test.ts
git commit -m "feat: define local workspace schemas"
```

### Task 4: Add atomic writes and a short-lived lock

**Files:**
- Create: `src/workspace/atomic-write.ts`
- Create: `src/workspace/lock.ts`
- Test: `test/workspace/persistence.test.ts`

- [ ] **Step 1: Write failing persistence tests**

```ts
// test/workspace/persistence.test.ts
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { atomicWriteText } from "../../src/workspace/atomic-write.js";
import { withWorkspaceLock } from "../../src/workspace/lock.js";

describe("workspace persistence", () => {
  it("replaces a complete file", async () => {
    const root = await mkdtemp(join(tmpdir(), "ezagent-atomic-"));
    const target = join(root, "state.json");
    await atomicWriteText(target, "first");
    await atomicWriteText(target, "second");
    expect(await readFile(target, "utf8")).toBe("second");
  });

  it("rejects a concurrent writer", async () => {
    const root = await mkdtemp(join(tmpdir(), "ezagent-lock-"));
    let entered!: () => void;
    let release!: () => void;
    const acquired = new Promise<void>((resolve) => { entered = resolve; });
    const held = new Promise<void>((resolve) => { release = resolve; });
    const first = withWorkspaceLock(root, async () => { entered(); await held; });
    await acquired;
    await expect(withWorkspaceLock(root, async () => undefined)).rejects.toThrow("locked");
    release();
    await first;
  });
});
```

- [ ] **Step 2: Run tests and verify failure**

Run: `npm test -- test/workspace/persistence.test.ts`

Expected: FAIL because persistence modules do not exist.

- [ ] **Step 3: Implement atomic replacement**

```ts
// src/workspace/atomic-write.ts
import { randomUUID } from "node:crypto";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export async function atomicWriteText(target: string, content: string): Promise<void> {
  await mkdir(dirname(target), { recursive: true });
  const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, content, { encoding: "utf8", flag: "wx" });
    await rename(temporary, target);
  } finally {
    await rm(temporary, { force: true });
  }
}
```

- [ ] **Step 4: Implement the exclusive lock**

```ts
// src/workspace/lock.ts
import { mkdir, open, readFile, rm, type FileHandle } from "node:fs/promises";
import { dirname } from "node:path";
import { WorkspaceLockedError } from "./errors.js";
import { workspacePaths } from "./layout.js";

export async function withWorkspaceLock<T>(projectRoot: string, operation: () => Promise<T>): Promise<T> {
  const lock = workspacePaths(projectRoot).lock;
  await mkdir(dirname(lock), { recursive: true });
  let handle: FileHandle;
  try {
    handle = await open(lock, "wx");
    await handle.writeFile(JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() }));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      const metadata = JSON.parse(await readFile(lock, "utf8")) as { createdAt: string };
      if (Date.now() - Date.parse(metadata.createdAt) > 30_000) {
        await rm(lock, { force: true });
        return withWorkspaceLock(projectRoot, operation);
      }
      throw new WorkspaceLockedError(`workspace is locked: ${lock}`);
    }
    throw error;
  }
  try {
    return await operation();
  } finally {
    await handle.close();
    await rm(lock, { force: true });
  }
}
```

- [ ] **Step 5: Verify persistence and commit**

Run: `npm test -- test/workspace/persistence.test.ts && npm run check`

Expected: PASS with 2 tests on the current operating system.

```bash
git add src/workspace/atomic-write.ts src/workspace/lock.ts test/workspace/persistence.test.ts
git commit -m "feat: add atomic workspace persistence"
```

### Task 5: Initialize and read a workspace idempotently

**Files:**
- Create: `src/workspace/repository.ts`
- Test: `test/workspace/repository.test.ts`

- [ ] **Step 1: Write failing repository tests**

```ts
// test/workspace/repository.test.ts
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { WorkspaceRepository } from "../../src/workspace/repository.js";

describe("WorkspaceRepository", () => {
  it("initializes the approved directory layout", async () => {
    const root = await mkdtemp(join(tmpdir(), "ezagent-repo-"));
    const repository = new WorkspaceRepository(root);
    await repository.initialize({ schemaVersion: 1, name: "Demo", gitTracking: "none" });
    expect((await repository.readState()).revision).toBe(0);
    expect(await readFile(join(root, ".ezagent", "project.yaml"), "utf8")).toContain("name: Demo");
  });

  it("is idempotent and refuses a different project name", async () => {
    const root = await mkdtemp(join(tmpdir(), "ezagent-idempotent-"));
    const repository = new WorkspaceRepository(root);
    await repository.initialize({ schemaVersion: 1, name: "Demo", gitTracking: "none" });
    await repository.initialize({ schemaVersion: 1, name: "Demo", gitTracking: "none" });
    await expect(repository.initialize({ schemaVersion: 1, name: "Other", gitTracking: "none" })).rejects.toThrow("already initialized");
  });
});
```

- [ ] **Step 2: Run tests and verify failure**

Run: `npm test -- test/workspace/repository.test.ts`

Expected: FAIL because `WorkspaceRepository` does not exist.

- [ ] **Step 3: Implement initialization and reads**

```ts
// src/workspace/repository.ts
import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { atomicWriteText } from "./atomic-write.js";
import { WORKSPACE_DIRECTORIES, workspacePaths } from "./layout.js";
import { parseProjectConfig, parseWorkspaceState, serializeProjectConfig, type ProjectConfig, type WorkspaceState } from "./schema.js";
import { WorkspaceNotInitializedError } from "./errors.js";
import { withWorkspaceLock } from "./lock.js";

const INITIAL_STATE: WorkspaceState = { schemaVersion: 1, revision: 0, activeWorkItem: null, safeMode: false };

export class WorkspaceRepository {
  constructor(readonly projectRoot: string) {}

  async initialize(config: ProjectConfig): Promise<void> {
    await withWorkspaceLock(this.projectRoot, async () => {
      const paths = workspacePaths(this.projectRoot);
      let existing: ProjectConfig | undefined;
      try { existing = parseProjectConfig(await readFile(paths.project, "utf8")); } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      if (existing) {
        if (JSON.stringify(existing) !== JSON.stringify(config)) throw new Error("workspace already initialized with different configuration");
        return;
      }
      for (const directory of WORKSPACE_DIRECTORIES) await mkdir(join(paths.root, directory), { recursive: true });
      await atomicWriteText(paths.project, serializeProjectConfig(config));
      await atomicWriteText(paths.state, `${JSON.stringify(INITIAL_STATE, null, 2)}\n`);
      await atomicWriteText(paths.audit, "");
    });
  }

  async readProject(): Promise<ProjectConfig> {
    try { return parseProjectConfig(await readFile(workspacePaths(this.projectRoot).project, "utf8")); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new WorkspaceNotInitializedError("workspace is not initialized");
      throw error;
    }
  }

  async readState(): Promise<WorkspaceState> {
    await this.readProject();
    return parseWorkspaceState(JSON.parse(await readFile(workspacePaths(this.projectRoot).state, "utf8")));
  }
}
```

- [ ] **Step 4: Verify repository behavior and commit**

Run: `npm test -- test/workspace/repository.test.ts && npm run check`

Expected: PASS with 2 tests.

```bash
git add src/workspace/repository.ts test/workspace/repository.test.ts
git commit -m "feat: initialize local workspace"
```

### Task 6: Add append-only audit and recovery projection

**Files:**
- Create: `src/audit/events.ts`
- Create: `src/audit/recovery.ts`
- Modify: `src/workspace/repository.ts`
- Test: `test/workspace/recovery.test.ts`

- [ ] **Step 1: Write failing recovery tests**

```ts
// test/workspace/recovery.test.ts
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { WorkspaceRepository } from "../../src/workspace/repository.js";

describe("workspace recovery", () => {
  it("rebuilds a damaged state projection from audit", async () => {
    const root = await mkdtemp(join(tmpdir(), "ezagent-recovery-"));
    const repository = new WorkspaceRepository(root);
    await repository.initialize({ schemaVersion: 1, name: "Demo", gitTracking: "none" });
    await repository.recordState({
      schemaVersion: 1,
      revision: 1,
      activeWorkItem: { id: "REQ-20260820-001", kind: "requirement", status: "captured", risk: "standard", revision: 0 },
      safeMode: false,
    }, 0, "work-item-captured");
    await writeFile(join(root, ".ezagent", "state", "workspace.json"), "broken", "utf8");
    expect((await repository.readContext()).state.revision).toBe(1);
  });

  it("enters safe mode when state and audit are both invalid", async () => {
    const root = await mkdtemp(join(tmpdir(), "ezagent-safe-"));
    const repository = new WorkspaceRepository(root);
    await repository.initialize({ schemaVersion: 1, name: "Demo", gitTracking: "none" });
    await writeFile(join(root, ".ezagent", "state", "workspace.json"), "broken", "utf8");
    await writeFile(join(root, ".ezagent", "audit", "events.jsonl"), "broken", "utf8");
    expect((await repository.readContext()).state.safeMode).toBe(true);
  });

  it("rejects mutation targets outside .ezagent", async () => {
    const root = await mkdtemp(join(tmpdir(), "ezagent-escape-"));
    const repository = new WorkspaceRepository(root);
    await repository.initialize({ schemaVersion: 1, name: "Demo", gitTracking: "none" });
    await expect(repository.commitMutation(
      { schemaVersion: 1, revision: 1, activeWorkItem: null, safeMode: false },
      0,
      "invalid-write",
      [{ relativePath: "../AGENTS.md", content: "should not write" }],
    )).rejects.toThrow("escapes .ezagent");
  });
});
```

- [ ] **Step 2: Run tests and verify missing methods fail**

Run: `npm test -- test/workspace/recovery.test.ts`

Expected: FAIL because `recordState` and `readContext` are not defined.

- [ ] **Step 3: Implement audit events and reducer**

```ts
// src/audit/events.ts
import { appendFile, readFile } from "node:fs/promises";
import { z } from "zod";
import type { WorkspaceState } from "../workspace/schema.js";

export const auditMetadataSchema = z.record(z.string(), z.union([
  z.string().max(256), z.number(), z.boolean(), z.null(), z.array(z.string().max(160)).max(32),
]));

const auditEventSchema = z.object({
  sequence: z.number().int().positive(),
  at: z.string().datetime(),
  type: z.string().min(1),
  state: z.unknown(),
  metadata: auditMetadataSchema,
});

export type AuditMetadata = z.infer<typeof auditEventSchema>["metadata"];

export interface AuditEvent {
  sequence: number;
  at: string;
  type: string;
  state: WorkspaceState;
  metadata: AuditMetadata;
}

export async function appendAuditEvent(path: string, event: AuditEvent): Promise<void> {
  await appendFile(path, `${JSON.stringify(event)}\n`, "utf8");
}

export async function readAuditEvents(path: string): Promise<AuditEvent[]> {
  const text = await readFile(path, "utf8");
  return text.split("\n").filter(Boolean).map((line) => auditEventSchema.parse(JSON.parse(line)) as AuditEvent);
}
```

```ts
// src/audit/recovery.ts
import { parseWorkspaceState, type WorkspaceState } from "../workspace/schema.js";
import type { AuditEvent } from "./events.js";

export function recoverState(events: AuditEvent[]): WorkspaceState {
  if (events.length === 0) return { schemaVersion: 1, revision: 0, activeWorkItem: null, safeMode: false };
  const ordered = [...events].sort((a, b) => a.sequence - b.sequence);
  ordered.forEach((event, index) => {
    if (event.sequence !== index + 1) throw new Error("audit sequence is not contiguous");
  });
  return parseWorkspaceState(ordered.at(-1)!.state);
}
```

- [ ] **Step 4: Extend repository with revisioned writes and safe recovery**

Add these methods and imports to `WorkspaceRepository`:

```ts
import { isAbsolute, relative, resolve, sep } from "node:path";
import { appendAuditEvent, readAuditEvents, type AuditMetadata } from "../audit/events.js";
import { recoverState } from "../audit/recovery.js";

interface WorkspaceMutationWrite { relativePath: string; content: string }

async commitMutation(
  next: WorkspaceState,
  expectedRevision: number,
  eventType: string,
  writes: WorkspaceMutationWrite[] = [],
  metadata: AuditMetadata = {},
): Promise<void> {
  await withWorkspaceLock(this.projectRoot, async () => {
    const current = await this.readState();
    if (current.revision !== expectedRevision) throw new Error(`revision conflict: expected ${expectedRevision}, actual ${current.revision}`);
    if (next.revision !== current.revision + 1) throw new Error("next workspace revision must increment by one");
    const paths = workspacePaths(this.projectRoot);
    for (const write of writes) {
      const target = resolve(paths.root, write.relativePath);
      const fromWorkspace = relative(resolve(paths.root), target);
      if (!fromWorkspace || fromWorkspace === ".." || fromWorkspace.startsWith(`..${sep}`) || isAbsolute(fromWorkspace)) {
        throw new Error(`workspace write escapes .ezagent: ${write.relativePath}`);
      }
      await atomicWriteText(target, write.content);
    }
    await appendAuditEvent(paths.audit, { sequence: next.revision, at: new Date().toISOString(), type: eventType, state: next, metadata });
    await atomicWriteText(paths.state, `${JSON.stringify(next, null, 2)}\n`);
  });
}

async recordState(next: WorkspaceState, expectedRevision: number, eventType: string): Promise<void> {
  await this.commitMutation(next, expectedRevision, eventType);
}

async readContext(): Promise<{ project: ProjectConfig; state: WorkspaceState; recovered: boolean }> {
  const project = await this.readProject();
  try {
    const state = await this.readState();
    const events = await readAuditEvents(workspacePaths(this.projectRoot).audit);
    const lastSequence = events.at(-1)?.sequence ?? 0;
    if (lastSequence !== state.revision) throw new Error("state and audit revisions differ");
    return { project, state, recovered: false };
  } catch {
    try {
      const state = recoverState(await readAuditEvents(workspacePaths(this.projectRoot).audit));
      return { project, state, recovered: true };
    } catch {
      return { project, state: { schemaVersion: 1, revision: 0, activeWorkItem: null, safeMode: true }, recovered: false };
    }
  }
}
```

All later workflow services must use `commitMutation` rather than acquiring `withWorkspaceLock` and then calling another lock-owning repository method. An active artifact's frontmatter revision must match the embedded `activeWorkItem.revision` in workspace state. If a process exits between artifact replacement and audit/state replacement, the bounded resume projection detects the mismatch and enters safe mode instead of continuing on a partially committed workflow.

- [ ] **Step 5: Verify recovery and commit**

Run: `npm test -- test/workspace/recovery.test.ts && npm run check`

Expected: PASS with 3 tests; recovery succeeds from valid audit, invalid state/audit returns safe mode, and path traversal is rejected.

```bash
git add src/audit src/workspace/repository.ts test/workspace/recovery.test.ts
git commit -m "feat: recover workspace state from audit"
```

### Task 7: Add the internal CLI

**Files:**
- Create: `src/cli/main.ts`
- Test: `test/cli/main.test.ts`

- [ ] **Step 1: Write a failing CLI test**

```ts
// test/cli/main.test.ts
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execa } from "execa";
import { beforeAll, describe, expect, it } from "vitest";
import { WorkspaceRepository } from "../../src/workspace/repository.js";

describe("ezagent CLI", () => {
  beforeAll(async () => { await execa("npm", ["run", "build"]); });

  it("initializes once and returns machine-readable context", async () => {
    const root = await mkdtemp(join(tmpdir(), "ezagent-cli-"));
    await execa("node", ["dist/src/cli/main.js", "init", "--root", root, "--name", "Demo"]);
    const result = await execa("node", ["dist/src/cli/main.js", "context", "--root", root, "--json"]);
    expect(JSON.parse(result.stdout)).toMatchObject({ project: { name: "Demo" }, state: { revision: 0, safeMode: false } });
  });

  it("transitions the active work item through the core", async () => {
    const root = await mkdtemp(join(tmpdir(), "ezagent-cli-transition-"));
    const repository = new WorkspaceRepository(root);
    await repository.initialize({ schemaVersion: 1, name: "Demo", gitTracking: "none" });
    await repository.recordState({
      schemaVersion: 1,
      revision: 1,
      activeWorkItem: { id: "REQ-20260820-001", kind: "requirement", status: "captured", risk: "standard", revision: 0 },
      safeMode: false,
    }, 0, "work-item-captured");
    const result = await execa("node", ["dist/src/cli/main.js", "transition", "--root", root, "--to", "clarifying", "--revision", "0"]);
    expect(JSON.parse(result.stdout).activeWorkItem).toMatchObject({ status: "clarifying", revision: 1 });
  });
});
```

- [ ] **Step 2: Install the child-process test dependency**

Run: `npm install --save-dev execa`

Expected: `package.json` and `package-lock.json` update and exit `0`.

- [ ] **Step 3: Run test and verify CLI module failure**

Run: `npm test -- test/cli/main.test.ts`

Expected: FAIL because `dist/src/cli/main.js` does not exist or has no command implementation.

- [ ] **Step 4: Implement minimal argument parsing and commands**

```ts
// src/cli/main.ts
#!/usr/bin/env node
import { access } from "node:fs/promises";
import { transitionWorkItem } from "../domain/state-machine.js";
import type { WorkItemStatus } from "../domain/work-item.js";
import { WorkspaceRepository } from "../workspace/repository.js";

function option(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

async function main(): Promise<void> {
  const command = process.argv[2];
  const root = option("--root") ?? process.cwd();
  const repository = new WorkspaceRepository(root);

  if (command === "doctor") {
    await access(root);
    process.stdout.write(`${JSON.stringify({ ok: true, node: process.version, root })}\n`);
    return;
  }
  if (command === "init") {
    const name = option("--name");
    if (!name) throw new Error("--name is required");
    await repository.initialize({ schemaVersion: 1, name, gitTracking: "none" });
    process.stdout.write(`${JSON.stringify({ ok: true, initialized: true, root })}\n`);
    return;
  }
  if (command === "context") {
    process.stdout.write(`${JSON.stringify(await repository.readContext())}\n`);
    return;
  }
  if (command === "transition") {
    const context = await repository.readContext();
    if (!context.state.activeWorkItem) throw new Error("no active work item");
    const to = option("--to") as WorkItemStatus | undefined;
    const revision = Number(option("--revision"));
    const authorizationId = option("--high-risk-authorization");
    if (!to || !Number.isInteger(revision)) throw new Error("--to and integer --revision are required");
    const activeWorkItem = transitionWorkItem(context.state.activeWorkItem, {
      to,
      expectedRevision: revision,
      ...(authorizationId ? { highRiskAuthorizationId: authorizationId } : {}),
    });
    const next = { ...context.state, revision: context.state.revision + 1, activeWorkItem };
    await repository.recordState(next, context.state.revision, "work-item-transitioned");
    process.stdout.write(`${JSON.stringify(next)}\n`);
    return;
  }
  throw new Error("usage: ezagent <doctor|init|context|transition> [options]");
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
```

- [ ] **Step 5: Verify CLI and commit**

Run: `npm run build && npm test -- test/cli/main.test.ts && npm run check`

Expected: PASS with 2 CLI integration tests.

```bash
git add package.json package-lock.json src/cli/main.ts test/cli/main.test.ts
git commit -m "feat: expose local core CLI"
```

### Task 8: Close the local-core milestone

**Files:**
- Create: `test/workspace/cross-platform.test.ts`
- Modify: `README.md`

- [ ] **Step 1: Add a path-invariant test**

```ts
// test/workspace/cross-platform.test.ts
import { describe, expect, it } from "vitest";
import { win32, posix } from "node:path";

describe("cross-platform path assumptions", () => {
  it("uses platform path helpers rather than embedded separators", () => {
    expect(posix.join("project", ".ezagent", "state")).toBe("project/.ezagent/state");
    expect(win32.join("C:\\project", ".ezagent", "state")).toBe("C:\\project\\.ezagent\\state");
  });
});
```

- [ ] **Step 2: Document only the implemented core commands**

````markdown
## Local core development

Requirements: Node.js 22 or newer.

```bash
npm install
npm run verify
node dist/src/cli/main.js doctor --root .
node dist/src/cli/main.js init --root . --name Demo
node dist/src/cli/main.js context --root . --json
```

The CLI is an internal plugin interface. End users will interact through natural-language Codex requests after project initialization.
````

- [ ] **Step 3: Run the complete milestone gate**

Run: `npm run check && npm run test:core && npm run build`

Expected: all commands exit `0`; no test writes `.ezagent/` into the repository root.

- [ ] **Step 4: Inspect repository boundaries**

Run: `git status --short && rg -n "fetch\(|https?://|git (commit|push)" src test`

Expected: only intended milestone files are modified; the search returns no runtime network calls or automatic Git commands.

- [ ] **Step 5: Commit the milestone documentation and test**

```bash
git add README.md test/workspace/cross-platform.test.ts
git commit -m "docs: verify local core milestone"
```
