# EZagent Codex Plugin and Automatic Activation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Package the existing local core and selected experts as a valid Codex plugin that is initialized once and then automatically routes project development requests without requiring a user command.

**Architecture:** Use the Codex capabilities that are currently installable and testable: plugin Skills for semantic routing, a managed project `AGENTS.md` block for cross-session activation, a bundled short-lived CLI for deterministic state access, and generated `.codex/agents/ezagent-*.toml` files for selected experts. Do not declare Claude-style lifecycle Hooks, a background daemon, or an MCP server; the local core remains the only state authority and fails closed on invalid transitions.

**Tech Stack:** TypeScript, Node.js 22+, esbuild, Codex plugin manifest and Skills, project `AGENTS.md`, project-scoped custom agents, Vitest, the bundled Codex plugin validator.

---

## Current Codex contract and non-goals

- Plugin source lives at `plugins/ezagent-spec/`; the outer directory and manifest name both equal `ezagent-spec`.
- `.codex-plugin/plugin.json` includes `skills` but omits `hooks`, `mcpServers`, and `apps`. The current bundled validator rejects `hooks`, and no stable Codex per-prompt or `PreToolUse` Hook contract is assumed.
- Automatic activation is the combination of a broad Router Skill and an initialization-managed `AGENTS.md` block that explicitly requires `$ezagent-router` whenever `.ezagent/project.yaml` exists.
- Every relevant turn starts by calling the bundled local CLI to recover current state. The Skill does not copy the state machine or directly edit `.ezagent/**`.
- The plugin does not start a daemon, listen on a port, access the network, emit telemetry, or perform Git writes.
- This milestone makes initialization, context restoration, expert rendering, packaging, and automatic routing real. Full Requirement/Spec/Task command verbs remain in the already approved workflow/release plan.
- Do not read, modify, or copy the old EZagent desktop project or Trellis implementation material.
- Do not push during task execution. Keep changes local until the user requests the next integration action.

## File map

- `plugins/ezagent-spec/.codex-plugin/plugin.json`: validated Codex plugin metadata.
- `plugins/ezagent-spec/skills/ezagent-router/SKILL.md`: broad automatic routing entrypoint.
- `plugins/ezagent-spec/skills/ezagent-initialize/SKILL.md`: one-time Node check, preview, and initialization.
- `plugins/ezagent-spec/skills/ezagent-spec/SKILL.md`: Requirement and Spec policy.
- `plugins/ezagent-spec/skills/ezagent-implement/SKILL.md`: approved Task execution policy.
- `plugins/ezagent-spec/skills/ezagent-review/SKILL.md`: verification and completion policy.
- `.agents/plugins/marketplace.json`: repo-local company marketplace entry.
- `src/adapters/codex/agents-md.ts`: deterministic managed `AGENTS.md` block.
- `src/adapters/codex/integration.ts`: initialization preview and managed-file coordination.
- `src/adapters/codex/safe-fs.ts`: shared read-only identity and bounded no-follow filesystem primitives.
- `src/adapters/codex/project-agent.ts`: deterministic project expert TOML and safe synchronization.
- `src/cli/main.ts`: internal `integration-preview` and `integration-init` commands.
- `scripts/build-plugin.ts`: reproducible standalone plugin assembly.
- `scripts/collect-runtime-licenses.ts`: offline bundled-dependency license collection.
- `test/codex/**`: manifest, activation, initialization, agent, package, and smoke tests.

### Task 1: Create a validator-clean Codex plugin shell

**Files:**
- Create: `plugins/ezagent-spec/.codex-plugin/plugin.json`
- Create: `plugins/ezagent-spec/skills/ezagent-router/SKILL.md`
- Create: `.agents/plugins/marketplace.json`
- Create: `test/codex/plugin-manifest.test.ts`

- [ ] **Step 1: Write the failing manifest test**

```ts
// test/codex/plugin-manifest.test.ts
import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("Codex plugin manifest", () => {
  it("uses the supported skills-only contract and a repo marketplace entry", async () => {
    const manifest = JSON.parse(await readFile("plugins/ezagent-spec/.codex-plugin/plugin.json", "utf8"));
    expect(manifest).toMatchObject({
      name: "ezagent-spec",
      version: "0.1.0",
      skills: "./skills/",
      interface: { displayName: "EZagent Spec", category: "Developer Tools" },
    });
    expect(manifest).not.toHaveProperty("hooks");
    expect(manifest).not.toHaveProperty("mcpServers");
    expect(manifest).not.toHaveProperty("apps");

    const marketplace = JSON.parse(await readFile(".agents/plugins/marketplace.json", "utf8"));
    expect(marketplace.plugins).toContainEqual({
      name: "ezagent-spec",
      source: { source: "local", path: "./plugins/ezagent-spec" },
      policy: { installation: "AVAILABLE", authentication: "ON_INSTALL" },
      category: "Developer Tools",
    });
  });
});
```

- [ ] **Step 2: Run the focused test and observe RED**

Run: `npm test -- test/codex/plugin-manifest.test.ts`

Expected: FAIL with `ENOENT` for `plugins/ezagent-spec/.codex-plugin/plugin.json`.

- [ ] **Step 3: Use the official scaffold in a temporary directory, then create the repo files with `apply_patch`**

Run the official scaffold only in disposable storage so it cannot overwrite repository work:

```bash
python3 /Users/mediastorm/.codex/skills/.system/plugin-creator/scripts/create_basic_plugin.py ezagent-spec \
  --path /private/tmp/ezagent-plugin-scaffold \
  --with-skills
```

Create the repository manifest with the validated shape:

```json
{
  "name": "ezagent-spec",
  "version": "0.1.0",
  "description": "中文、本地优先的 Spec Coding 工作流。",
  "author": { "name": "EZagent" },
  "repository": "https://github.com/zhujufeng/EZagent-Spec",
  "license": "UNLICENSED",
  "keywords": ["spec-coding", "chinese", "multi-agent", "local-first"],
  "skills": "./skills/",
  "interface": {
    "displayName": "EZagent Spec",
    "shortDescription": "中文、本地优先的 Spec Coding",
    "longDescription": "初始化一次后，通过项目规则和 Router Skill 自动恢复需求、任务、专家与质量上下文。",
    "developerName": "EZagent",
    "category": "Developer Tools",
    "capabilities": ["Instructions", "Read", "Write"],
    "defaultPrompt": ["在这个项目启用 EZagent Spec。", "帮我按 Spec 流程实现这个需求。"]
  }
}
```

Create `.agents/plugins/marketplace.json` with top-level name `ezagent-spec-internal`, display name `EZagent Internal`, and the exact plugin entry asserted above.

Create the first real Router Skill:

```markdown
---
name: ezagent-router
description: 在已初始化 EZagent Spec 的项目中，自动处理开发、修改、修复、重构、实现、审查或验证请求；普通解释和只读咨询不创建工作项。
---

# EZagent Router

当向上查找能够发现 `.ezagent/project.yaml` 时使用本 Skill；否则不进入 EZagent 流程。

1. 先定位本 Skill 所属插件根目录，并运行其 `dist/ezagent-cli.mjs context --root <project-root> --json`。
2. 安全模式下只诊断，不修改项目。
3. 把用户请求分类为 `consult`、`light`、`standard` 或 `high`；不保存完整用户提示。
4. `consult` 正常回答。其他等级转入对应 EZagent Skill，并让本地核心验证所有状态变化。
5. 不直接编辑 `.ezagent/**`，不自动联网、安装软件、提交、推送、发布或上传项目。
```

- [ ] **Step 4: Validate the shell and observe GREEN**

Run:

```bash
python3 /Users/mediastorm/.codex/skills/.system/plugin-creator/scripts/validate_plugin.py plugins/ezagent-spec
npm test -- test/codex/plugin-manifest.test.ts
```

Expected: validator prints `Plugin validation passed`; focused test PASS.

- [ ] **Step 5: Stage the task without committing or pushing**

Run: `git add plugins/ezagent-spec/.codex-plugin/plugin.json plugins/ezagent-spec/skills/ezagent-router/SKILL.md .agents/plugins/marketplace.json test/codex/plugin-manifest.test.ts`

### Task 2: Render the managed project `AGENTS.md` block

**Files:**
- Create: `src/adapters/codex/agents-md.ts`
- Create: `test/codex/agents-md.test.ts`

- [ ] **Step 1: Write RED tests for preservation, idempotency, line endings, and invalid markers**

```ts
// test/codex/agents-md.test.ts
import { describe, expect, it } from "vitest";
import { mergeEzagentAgentsBlock } from "../../src/adapters/codex/agents-md.js";

describe("mergeEzagentAgentsBlock", () => {
  it("preserves user bytes outside one managed block and is idempotent", () => {
    const existing = "# Team rules\n\nKeep this line.\n";
    const once = mergeEzagentAgentsBlock(existing);
    expect(mergeEzagentAgentsBlock(once)).toBe(once);
    expect(once).toContain("# Team rules\n\nKeep this line.\n");
    expect(once.match(/EZAGENT:START/gu)).toHaveLength(1);
    expect(once).toContain("$ezagent-router");
  });

  it("uses an existing CRLF convention without rewriting user content", () => {
    const existing = "# Team\r\nKeep\r\n";
    const merged = mergeEzagentAgentsBlock(existing);
    expect(merged.startsWith(existing)).toBe(true);
    expect(merged).not.toMatch(/(?<!\r)\n/gu);
  });

  it.each([
    "<!-- EZAGENT:START -->\n",
    "<!-- EZAGENT:END -->\n",
    "<!-- EZAGENT:END -->\n<!-- EZAGENT:START -->\n",
    "<!-- EZAGENT:START -->\n<!-- EZAGENT:START -->\n<!-- EZAGENT:END -->\n",
  ])("rejects malformed managed markers", (contents) => {
    expect(() => mergeEzagentAgentsBlock(contents)).toThrow(/managed markers/iu);
  });
});
```

- [ ] **Step 2: Run and verify RED**

Run: `npm test -- test/codex/agents-md.test.ts`

Expected: FAIL because `src/adapters/codex/agents-md.ts` does not exist.

- [ ] **Step 3: Implement the pure merge function**

```ts
// src/adapters/codex/agents-md.ts
const START = "<!-- EZAGENT:START -->";
const END = "<!-- EZAGENT:END -->";

const RULES = [
  "## EZagent Spec",
  "",
  "当项目根存在 `.ezagent/project.yaml` 时，所有开发、修改、修复、重构、实现、审查和验证请求都必须自动使用 `$ezagent-router`；不要要求用户输入 EZagent 命令。",
  "每次相关工作先通过插件内打包 CLI 读取当前状态；不得直接编辑 `.ezagent/**`。",
  "修改前必须具备当前流程等级要求的工作项、Task 范围与质量门；高风险动作还需要单独的一次性授权。",
  "多 Agent 委派必须绑定 Requirement/Spec/Task ID、专家 ID、范围、交付物和质量门。",
  "不得自动联网、安装软件、提交、推送、创建 PR、发布或上传项目。",
];

export function mergeEzagentAgentsBlock(existing: string): string {
  const starts = [...existing.matchAll(/<!-- EZAGENT:START -->/gu)];
  const ends = [...existing.matchAll(/<!-- EZAGENT:END -->/gu)];
  if (starts.length > 1 || ends.length > 1 || starts.length !== ends.length) {
    throw new Error("invalid EZagent managed markers");
  }
  const newline = existing.includes("\r\n") ? "\r\n" : "\n";
  let user = existing;
  if (starts.length === 1) {
    const start = starts[0]!.index!;
    const end = ends[0]!.index!;
    if (end < start) throw new Error("invalid EZagent managed markers");
    user = `${existing.slice(0, start)}${existing.slice(end + END.length)}`;
  }
  const block = [START, ...RULES, END].join(newline);
  const separator = user.length === 0 || user.endsWith(`${newline}${newline}`)
    ? ""
    : user.endsWith(newline) ? newline : `${newline}${newline}`;
  return `${user}${separator}${block}${newline}`;
}
```

- [ ] **Step 4: Run focused tests and type checking**

Run: `npm test -- test/codex/agents-md.test.ts && npm run check`

Expected: PASS with no user-content rewrite outside the managed span.

- [ ] **Step 5: Stage the task**

Run: `git add src/adapters/codex/agents-md.ts test/codex/agents-md.test.ts`

### Task 3: Add previewed, repeatable Codex integration initialization

**Files:**
- Create: `src/adapters/codex/integration.ts`
- Modify: `src/cli/main.ts`
- Modify: `test/cli/main.test.ts`
- Create: `test/codex/integration.test.ts`

- [ ] **Step 1: Write RED tests for zero-side-effect preview and guarded initialization**

```ts
// test/codex/integration.test.ts
import { access, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { initializeCodexIntegration, previewCodexIntegration } from "../../src/adapters/codex/integration.js";

describe("Codex integration initialization", () => {
  it("previews managed paths without creating project state", async () => {
    const root = await mkdtemp(join(tmpdir(), "ezagent-integration-preview-"));
    const preview = await previewCodexIntegration(root);
    expect(preview.paths).toEqual([".ezagent/**", "AGENTS.md#EZAGENT", ".codex/agents/ezagent-*.toml"]);
    await expect(access(join(root, ".ezagent"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("preserves user AGENTS content and rejects a stale preview token", async () => {
    const root = await mkdtemp(join(tmpdir(), "ezagent-integration-cas-"));
    await writeFile(join(root, "AGENTS.md"), "# User\n", "utf8");
    const preview = await previewCodexIntegration(root);
    await writeFile(join(root, "AGENTS.md"), "# Concurrent edit\n", "utf8");
    await expect(initializeCodexIntegration(root, "Demo", preview.agentsToken)).rejects.toThrow(/preview is stale/iu);
    expect(await readFile(join(root, "AGENTS.md"), "utf8")).toBe("# Concurrent edit\n");
    await expect(access(join(root, ".ezagent"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("initializes once and remains byte-identical when repeated", async () => {
    const root = await mkdtemp(join(tmpdir(), "ezagent-integration-repeat-"));
    const preview = await previewCodexIntegration(root);
    await initializeCodexIntegration(root, "Demo", preview.agentsToken);
    const once = await readFile(join(root, "AGENTS.md"), "utf8");
    const secondPreview = await previewCodexIntegration(root);
    await initializeCodexIntegration(root, "Demo", secondPreview.agentsToken);
    expect(await readFile(join(root, "AGENTS.md"), "utf8")).toBe(once);
  });
});
```

Add CLI tests proving `integration-preview --root <root>` emits JSON and creates nothing, and `integration-init --root <root> --name Demo --agents-token <token>` initializes the workspace plus exactly one managed block.

- [ ] **Step 2: Run and verify RED**

Run: `npm test -- test/codex/integration.test.ts test/cli/main.test.ts`

Expected: FAIL because the integration module and commands do not exist.

- [ ] **Step 3: Implement strict preview tokens and initialization**

```ts
// src/adapters/codex/integration.ts
import { createHash } from "node:crypto";
import { lstat, readFile } from "node:fs/promises";
import { join } from "node:path";
import { atomicWriteText } from "../../workspace/atomic-write.js";
import { WorkspaceRepository } from "../../workspace/repository.js";
import { mergeEzagentAgentsBlock } from "./agents-md.js";

const MAX_AGENTS_BYTES = 1_048_576;

async function readAgents(path: string): Promise<Buffer | undefined> {
  try {
    const stat = await lstat(path);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_AGENTS_BYTES) {
      throw new Error("AGENTS.md must be a bounded regular file");
    }
    const bytes = await readFile(path);
    if (bytes.length !== stat.size) throw new Error("AGENTS.md changed during read");
    return bytes;
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

function token(bytes: Buffer | undefined): string {
  return bytes === undefined ? "missing" : `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

export async function previewCodexIntegration(projectRoot: string) {
  const bytes = await readAgents(join(projectRoot, "AGENTS.md"));
  return {
    paths: [".ezagent/**", "AGENTS.md#EZAGENT", ".codex/agents/ezagent-*.toml"] as const,
    agentsToken: token(bytes),
  };
}

export async function initializeCodexIntegration(projectRoot: string, name: string, expectedToken: string) {
  const agentsPath = join(projectRoot, "AGENTS.md");
  const before = await readAgents(agentsPath);
  if (token(before) !== expectedToken) throw new Error("AGENTS.md preview is stale; preview again");
  const merged = mergeEzagentAgentsBlock(before?.toString("utf8") ?? "");
  await new WorkspaceRepository(projectRoot).initialize({ schemaVersion: 1, name, gitTracking: "none" });
  const current = await readAgents(agentsPath);
  if (token(current) !== expectedToken) throw new Error("AGENTS.md changed before publication");
  if (current?.toString("utf8") !== merged) await atomicWriteText(agentsPath, merged);
  return { initialized: true as const, root: projectRoot };
}
```

Before GREEN, harden `readAgents` to use pre-lstat → no-follow open → handle stat/read → post-lstat identity checks and reject BOM/invalid UTF-8. The code block above is only an API sketch; do not ship its `atomicWriteText` call.

The cross-platform MVP uses a recoverable, explicitly non-atomic publication state machine because Node.js has no common macOS/Windows primitive for conditional inode replacement without clobbering a newly appeared path:

1. Verify the preview token before any write. Claim a missing final `.ezagent` only with exclusive directory creation, then populate that exclusively claimed tree with exclusive child directories and `open("wx")` files; never rename a directory over a competing target. A present but incomplete workspace fails closed instead of being repaired in place.
2. Read `AGENTS.md` with the bounded no-follow identity sequence. Reject symlinks, initial hard links, non-regular files, BOM, invalid UTF-8, growth, shrink, and ancestor replacement.
3. Under a uniquely created `.ezagent/backups/agents-md/` recovery directory, write independent mode-`0600` `.bak` and `.next` byte copies, file-sync them, verify their content and identities, and sync each relevant directory before touching an existing target. They must not share an inode with each other or the target.
4. If `AGENTS.md` is missing, publish with `open("wx")`; a competing creator wins and remains untouched. If it exists, update only through the already verified `O_NOFOLLOW | O_RDWR` handle. Re-check target identity and link count before and after the write; never delete or overwrite a competing path by filename.
5. After recovery evidence exists, every identity, ancestor, sync, partial-write, competing-publication, or indeterminate error reports `requires inspection` plus the concrete recovery path. Do not automatically unlink, rename, remove, or roll back target, backup, recovery, or workspace paths.

This design protects data and preserves evidence, but it does not promise an invisible atomic update to concurrent readers. A failed handle write can leave `AGENTS.md` partially updated while `.bak` and `.next` remain durable. Run one-time initialization while the project is quiescent: no editor, script, Agent, or same-user adversary may concurrently change `AGENTS.md`, add a hard link, or replace the project/workspace/backup ancestors. Pure Node.js can detect these cases after or around path operations, but without dirfd/native helpers it cannot prevent every malicious ancestor race; a hard link added after the final pre-write check can observe the handle update before the post-write link-count check fails. Directory sync support is best-effort on macOS and Windows, and unsupported or permission-denied directory sync may be skipped. A successful return therefore means in-process identity/content checks passed, not that directory entries are guaranteed durable across an immediate power loss.

Inject filesystem functions so growth, shrink, symlink, ancestor replacement, competing creation, concurrent hard links, partial writes, sync failures, and recovery-path reporting are deterministic. The public API and base stale-preview error strings above remain unchanged.

Extend the CLI command union and specs with:

```ts
type Command = "doctor" | "init" | "context" | "transition" | "integration-preview" | "integration-init";
```

`integration-preview` requires `--root`; `integration-init` requires `--root`, `--name`, and `--agents-token`. Both emit one-line JSON and use the existing redacted one-line error path.

- [ ] **Step 4: Run focused and core regression tests**

Run: `npm test -- test/codex/integration.test.ts test/cli/main.test.ts && npm run check && npm run test:core`

Expected: PASS. A stale preview detected before publication leaves both `AGENTS.md` and `.ezagent/` unchanged. Once publication has begun, deterministic failures either leave user-owned paths unchanged or retain independent `.bak`/`.next` evidence and return a concrete `requires inspection` recovery path; tests must not equate evidence-preserving failure with atomic rollback.

- [ ] **Step 5: Stage the task**

Run: `git add src/adapters/codex/integration.ts src/cli/main.ts test/codex/integration.test.ts test/cli/main.test.ts`

### Task 4: Generate only selected, assignment-bound project experts

**Files:**
- Create: `src/adapters/codex/project-agent.ts`
- Create: `test/codex/project-agent.test.ts`

- [ ] **Step 1: Write RED tests for rendering and managed synchronization**

```ts
// test/codex/project-agent.test.ts
import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { renderProjectAgent, syncProjectAgents } from "../../src/adapters/codex/project-agent.js";

const translated = JSON.parse(readFileSync(new URL("../fixtures/experts/translated.json", import.meta.url), "utf8"));

describe("Codex project experts", () => {
  it("renders a namespaced assignment-bound read-only reviewer", () => {
    const rendered = renderProjectAgent(translated, {
      taskIds: ["TASK-20260820-001"], mode: "review", reason: "独立前端审查",
    });
    expect(rendered.fileName).toBe("ezagent-engineering-frontend-architect.toml");
    expect(rendered.content).toContain('sandbox_mode = "read-only"');
    expect(rendered.content).toContain("TASK-20260820-001");
  });

  it("preserves user agents and refuses to delete a user-modified managed agent", async () => {
    const root = await mkdtemp(join(tmpdir(), "ezagent-project-agent-"));
    const directory = join(root, ".codex", "agents");
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, "user-reviewer.toml"), "user = true\n", "utf8");
    await writeFile(join(directory, "ezagent-old.toml"), "modified = true\n", "utf8");
    await expect(syncProjectAgents(root, [])).rejects.toThrow(/modified managed agent/iu);
    expect(await readFile(join(directory, "user-reviewer.toml"), "utf8")).toBe("user = true\n");
    expect(await readFile(join(directory, "ezagent-old.toml"), "utf8")).toBe("modified = true\n");
  });
});
```

- [ ] **Step 2: Run and verify RED**

Run: `npm test -- test/codex/project-agent.test.ts`

Expected: FAIL because `project-agent.ts` does not exist.

- [ ] **Step 3: Implement deterministic rendering and an ownership manifest**

`renderProjectAgent` must parse the expert through `parseExpert`, validate the assignment as a bounded snapshot, and produce only `ezagent-[a-z0-9-]+.toml`. Analysis/review modes use `read-only`; implement mode uses `workspace-write`. Instructions include expert Chinese instructions, exact Task IDs, reason, scope restriction, deliverables, quality gates, and “不得自行推进 EZagent 状态”.

`syncProjectAgents` owns only filenames and hashes recorded in `.ezagent/experts/generated-codex.json`:

```ts
interface GeneratedAgentManifest {
  readonly schemaVersion: 1;
  readonly files: Readonly<Record<string, `sha256:${string}`>>;
}
```

The synchronization algorithm is evidence-preserving and explicitly non-atomic across multiple agent files:

1. Validate all rendered agents and hashes before filesystem side effects.
2. Acquire the existing workspace lock and re-read `.ezagent/experts/active.yaml` plus the ownership manifest.
3. Reject symlinked/non-regular `.codex`, `.codex/agents`, generated files, or manifest. Reject initially hard-linked managed files and normalized/case-folded filename collisions.
4. Preserve every non-`ezagent-*` file byte-for-byte.
5. Exclusively create a unique recovery directory under `.ezagent/backups/generated-codex-agents/`, retain and re-check the identities of the workspace/backup ancestors, and sync the recovery directory before moving any owned file.
6. For a stale owned file whose current hash equals the prior ownership hash, atomically rename it into a destination that is known absent inside the unique recovery directory. A rename error is indeterminate until both source and recovery paths are inspected. Never unlink either path. If a competitor replaced the source before the move, preserve those bytes, restore them to a missing target only with an independent no-clobber copy, and fail with `requires inspection` plus concrete paths.
7. To update an owned file, first perform the same recoverable move. Write a bounded independent mode-`0600` `.next` copy, file-sync and verify it, then publish to the now-missing target with `open("wx")`; a competing creator remains untouched. New files use the same verified `.next` plus `open("wx")` publication without a prior move. Do not use a hard link for final publication.
8. Verify source, recovery, next, target, and ancestor identities/content around every operation. Once recovery evidence exists, every race, partial write, sync failure, or indeterminate result reports `requires inspection` with concrete recovery/backup paths. No rollback path deletes or overwrites by filename.
9. Publish the ownership manifest last using the workspace's guarded internal-state writer. A retry may adopt a target already equal to the desired hash and may accept an already-absent stale target; any other deviation fails closed. Manifest failure leaves evidence and does not claim synchronization succeeded.

Because portable Node.js has no conditional rename-by-inode primitive, stale removal and updates have a visible interval in which the active path can be absent. Run synchronization during a project quiet period. Pure Node.js can detect ancestor replacement and same-user races but cannot prevent every malicious dirfd-level race; preserve evidence and report instead of claiming atomic rollback.

Inject the filesystem runtime used by steps 2–9 so tests cover symlink, replacement, stale-file modification, ambiguous rename, backup-ancestor replacement, partial publication, ownership-manifest failure, Windows path case-fold collision, and retry behavior without time-sensitive races. Register and clean only test-created temporary roots.

- [ ] **Step 4: Run focused, expert, and type gates**

Run: `npm test -- test/codex/project-agent.test.ts && npm run test:experts && npm run check`

Expected: PASS; user agents remain byte-identical and only provably owned stale files are removable.

- [ ] **Step 5: Stage the task**

Run: `git add src/adapters/codex/project-agent.ts test/codex/project-agent.test.ts`

### Task 4.5: Share safety primitives and split the project-agent internals

**Files:**
- Create: `src/adapters/codex/safe-fs.ts`
- Create: `src/adapters/codex/project-agent-render.ts`
- Create: `src/adapters/codex/project-agent-recovery.ts`
- Modify: `src/adapters/codex/integration.ts`
- Modify: `src/adapters/codex/project-agent.ts`
- Create: `test/codex/safe-fs.test.ts`
- Modify: `test/codex/integration.test.ts`
- Modify: `test/codex/project-agent.test.ts`

- [ ] **Step 1: Freeze public behavior before moving code**

Add characterization tests for both adapters that lock their exported API, successful on-disk bytes, typed error codes and path fields, no-follow rejection, same-byte inode replacement, growth/shrink, close failure, recovery evidence, and no-op behavior. These tests must fail if refactoring changes publication or recovery semantics.

- [ ] **Step 2: Extract only shared read/validation primitives**

Move `FileIdentity`, identity comparison, ENOENT-safe `lstat`, real-directory and bounded regular/single-link assertions, bounded `O_NOFOLLOW` handle reads, handle-close behavior, path/handle identity re-checks, byte-budget accumulation, and best-effort directory sync into `safe-fs.ts`. Both `integration.ts` and `project-agent.ts` must call the shared implementations; do not leave behaviorally equivalent private copies behind.

Keep each adapter's runtime facade, typed errors, write/publication protocol, and recovery state machine separate. In particular, do not try to unify Task 3's existing-file handle update with Task 4's two-phase rename/no-clobber ownership synchronization.

- [ ] **Step 3: Split rendering and recovery indexing from orchestration**

Move assignment normalization, bounded TOML rendering, and filename construction to `project-agent-render.ts`. Move recovery evidence types, bounded deterministic scanning, and evidence lookup to `project-agent-recovery.ts`. Keep `project-agent.ts` as the public facade plus synchronization planner/orchestrator; public exports and generated bytes remain unchanged.

- [ ] **Step 4: Record the inode portability decision**

The MVP currently characterizes number-valued Node `Stats.dev/ino` identity because all injected runtimes and the macOS implementation use `Stats`. Do not claim that this proves Windows precision or stability. Task 7 must run the shared identity suite on a real Windows runner; if the result is not stable and unique, migrate the shared identity representation to bigint stats before declaring Windows support.

- [ ] **Step 5: Run all characterization and regression gates**

Run: `npm test -- test/codex/safe-fs.test.ts test/codex/integration.test.ts test/codex/project-agent.test.ts && npm run verify`

Expected: public APIs, error codes/paths, generated TOML, recovery bytes, and all existing tests remain byte-identical; both adapters import and use `safe-fs.ts`; no third publication state machine is introduced.

- [ ] **Step 6: Stage without committing or pushing**

Run: `git add src/adapters/codex/safe-fs.ts src/adapters/codex/project-agent-render.ts src/adapters/codex/project-agent-recovery.ts src/adapters/codex/integration.ts src/adapters/codex/project-agent.ts test/codex/safe-fs.test.ts test/codex/integration.test.ts test/codex/project-agent.test.ts`

### Task 5: Add the initialization, Spec, implementation, and review Skills

**Files:**
- Modify: `plugins/ezagent-spec/skills/ezagent-router/SKILL.md`
- Create: `plugins/ezagent-spec/skills/ezagent-initialize/SKILL.md`
- Create: `plugins/ezagent-spec/skills/ezagent-spec/SKILL.md`
- Create: `plugins/ezagent-spec/skills/ezagent-implement/SKILL.md`
- Create: `plugins/ezagent-spec/skills/ezagent-review/SKILL.md`
- Create: `test/codex/skill-contract.test.ts`
- Create: `test/codex/activation-contract.test.ts`

- [ ] **Step 1: Write RED contract tests**

The skill test must parse all five YAML frontmatters, require unique names equal to their directory names, non-empty descriptions, `disable-model-invocation` absent or false, no Hook environment variables, no affirmative network/Git-write commands, and no instruction to edit `.ezagent/**` directly.

The activation test must assert:

```ts
expect(agentsBlock).toContain("$ezagent-router");
expect(router.description).toMatch(/开发|修改|修复|重构|实现|审查|验证/u);
expect(router.body).toContain("dist/ezagent-cli.mjs context");
expect(router.body).toContain(".ezagent/project.yaml");
expect(initialize.body).toContain("integration-preview");
expect(initialize.body).toContain("integration-init");
expect(initialize.body).toContain("用户明确同意");
```

Also add negative trigger fixtures proving explanation-only questions do not create work items and uninitialized projects do not enter the workflow.

- [ ] **Step 2: Run and verify RED**

Run: `npm test -- test/codex/skill-contract.test.ts test/codex/activation-contract.test.ts`

Expected: FAIL because four Skills are missing and the Router does not yet meet the complete contract.

- [ ] **Step 3: Write the final Skill contracts**

Every Skill resolves `<plugin-root>` as the directory two levels above its own `SKILL.md`; it must invoke `node "<plugin-root>/dist/ezagent-cli.mjs" ...` with an absolute resolved path, never search `PATH` for another EZagent binary, and never require the user to type the command.

`ezagent-initialize`:

```markdown
---
name: ezagent-initialize
description: 当用户要求在当前项目启用、初始化或安装 EZagent Spec 时，执行一次性环境检测、写入预览、确认和本地初始化。
---

1. 使用系统自带命令检测操作系统与 `node --version`；检测本身不能依赖 EZagent JavaScript。
2. Node.js 缺失或低于 22 时，只说明需要受支持的 LTS。只有用户明确同意后才能联网或调用系统安装机制，安装后必须重新检测。
3. 解析本 Skill 所属插件根目录，调用打包 CLI 的 `integration-preview`，向用户展示返回的受管路径；不得自行扩展写入范围。
4. 用户确认后，把预览返回的 `agentsToken` 原样传给 `integration-init`。若 token 过期，重新预览，不覆盖并发修改。
5. 初始化成功后说明以后只需自然语言描述需求；不得自动提交、推送或上传项目。
```

`ezagent-spec` 负责 `consult|light|standard|high` 分类、目标/非目标/验收/验证/能力需求；`standard` 和 `high` 等待明确 Spec 批准；`high` 不把 Spec 批准解释为危险动作授权。

`ezagent-implement` 只执行已批准且已规划的 Task，绑定 `allowedPaths`、依赖、交付物、专家委派和质量门；范围变化回到 Spec；不自动安装、联网或进行 Git 写操作。

`ezagent-review` 只记录实际运行的质量证据；失败回到实现，不得虚构 PASS；全部满足后才完成并沉淀结构化 Knowledge，不保存聊天全文。

Router 在已初始化项目中先读取上下文，再选择上述 Skill；在未初始化项目中只有用户明确要求启用时才转入 initialization Skill。

- [ ] **Step 4: Validate Skills and run GREEN tests**

Run:

```bash
python3 /Users/mediastorm/.codex/skills/.system/plugin-creator/scripts/validate_plugin.py plugins/ezagent-spec
npm test -- test/codex/skill-contract.test.ts test/codex/activation-contract.test.ts
```

Expected: validator and both tests PASS.

- [ ] **Step 5: Stage the task**

Run: `git add plugins/ezagent-spec/skills test/codex/skill-contract.test.ts test/codex/activation-contract.test.ts`

### Task 6: Build a deterministic, self-contained plugin distribution

**Files:**
- Create: `scripts/build-plugin.ts`
- Create: `scripts/collect-runtime-licenses.ts`
- Create: `test/codex/plugin-package.test.ts`
- Modify: `package.json`
- Modify: `package-lock.json`
- Generate: `plugins/ezagent-spec/dist/ezagent-cli.mjs`
- Generate: `plugins/ezagent-spec/catalog/experts.json`
- Generate: `plugins/ezagent-spec/catalog/catalog.lock.json`
- Generate: `plugins/ezagent-spec/licenses/**`
- Generate: `plugins/ezagent-spec/THIRD_PARTY_NOTICES.md`

- [ ] **Step 1: Write the RED package inspection test**

The test runs the build into a temporary output directory and asserts:

- the bundled CLI exists and has no external imports;
- manifest and five Skills are present;
- normalized `experts.json` and `catalog.lock.json` exactly match the verified source artifacts;
- Agency Agents, agency-agents-zh, Unicode, YAML, and Zod notices/license texts are present;
- no source lock, taxonomy, importer, vendor source, test, source map, `.git`, Trellis path, telemetry SDK, `fetch(`, automatic `git commit`, or automatic `git push` appears;
- building twice produces the same sorted relative paths, modes, sizes, and SHA-256 hashes.

- [ ] **Step 2: Run and verify RED**

Run: `npm test -- test/codex/plugin-package.test.ts`

Expected: FAIL because `scripts/build-plugin.ts` does not exist.

- [ ] **Step 3: Add esbuild as the only new build dependency**

Run: `npm install --save-dev esbuild`

No new runtime dependency is allowed. License-expression parsing is not needed: the collector accepts only the exact package-lock v3 production packages reachable from the esbuild metafile and requires each package to declare a non-empty license plus installed license text.

- [ ] **Step 4: Implement offline license collection and deterministic assembly**

```ts
// scripts/build-plugin.ts
import { cp, mkdir, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { build } from "esbuild";
import { collectRuntimeLicenses } from "./collect-runtime-licenses.js";

export async function buildPlugin(outputRoot = "plugins/ezagent-spec"): Promise<void> {
  const root = resolve(outputRoot);
  await rm(resolve(root, "dist"), { recursive: true, force: true });
  await mkdir(resolve(root, "dist"), { recursive: true });
  const result = await build({
    entryPoints: ["src/cli/main.ts"],
    outfile: resolve(root, "dist/ezagent-cli.mjs"),
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node22",
    sourcemap: false,
    metafile: true,
    legalComments: "none",
    banner: { js: "#!/usr/bin/env node" },
  });
  await mkdir(resolve(root, "catalog"), { recursive: true });
  await cp("catalog/normalized/experts.json", resolve(root, "catalog/experts.json"));
  await cp("catalog/normalized/catalog.lock.json", resolve(root, "catalog/catalog.lock.json"));
  await collectRuntimeLicenses(root, result.metafile);
}
```

The collector reads package-lock v3 and the installed package directories only; it never downloads content. Copy exact root notices and license bytes to:

```text
plugins/ezagent-spec/THIRD_PARTY_NOTICES.md
plugins/ezagent-spec/licenses/agency-agents-MIT.txt
plugins/ezagent-spec/licenses/agency-agents-zh-MIT.txt
plugins/ezagent-spec/licenses/UNICODE-LICENSE.txt
plugins/ezagent-spec/licenses/npm/<name>@<version>/LICENSE*
plugins/ezagent-spec/RUNTIME_DEPENDENCIES.md
```

Reject missing license metadata/text, unexpected production packages, symlinked package/license inputs, duplicate normalized output paths, and any build output outside the plugin root. Write generated text with LF and mode `0644`; set the CLI to `0755` on POSIX while retaining `node <file>` compatibility on Windows.

Add scripts:

```json
{
  "plugin:build": "node --import tsx scripts/build-plugin.ts",
  "plugin:validate": "vitest run test/codex/plugin-manifest.test.ts test/codex/skill-contract.test.ts",
  "test:codex": "vitest run test/codex",
  "plugin:verify": "npm run catalog:verify && npm run plugin:build && npm run plugin:validate && npm run test:codex"
}
```

- [ ] **Step 5: Run GREEN package gates**

Run: `npm test -- test/codex/plugin-package.test.ts && npm run plugin:verify`

Expected: deterministic package test PASS, validator PASS, and all Codex tests PASS.

- [ ] **Step 6: Stage source and deterministic generated distribution**

Run: `git add package.json package-lock.json scripts/build-plugin.ts scripts/collect-runtime-licenses.ts test/codex/plugin-package.test.ts plugins/ezagent-spec`

### Task 7: Prove automatic activation and offline smoke behavior

**Files:**
- Create: `test/codex/offline-smoke.test.ts`
- Create: `.github/workflows/ci.yml`
- Create: `.gitattributes`
- Modify: `README.md`
- Modify: `docs/superpowers/plans/2026-08-20-ezagent-spec-mvp-roadmap.md`

- [ ] **Step 1: Write the RED offline smoke test**

The test must copy only `plugins/ezagent-spec` to a temporary directory, remove network-related environment variables, and invoke the packaged CLI with `execFile(process.execPath, [...])`:

1. `doctor --root <temp-project>` succeeds.
2. `integration-preview --root <temp-project>` returns the three exact managed path classes and creates no files.
3. `integration-init --root <temp-project> --name Demo --agents-token <token>` creates `.ezagent/project.yaml` and one managed `AGENTS.md` block.
4. A fresh process runs `context --root <temp-project> --json` and recovers the same project/state.
5. A second preview/init is byte-identical.
6. The generated `AGENTS.md` and Router Skill form a closed activation chain: project rule names `$ezagent-router`, Router checks `.ezagent/project.yaml`, and Router invokes the packaged context command before classification.
7. The plugin directory contains no executable/network/Git-write capability other than the declared local CLI.

The smoke test also parses `.github/workflows/ci.yml` and requires a read-only GitHub Actions matrix containing both `macos-latest` and `windows-latest`, Node.js 22, `npm ci`, `npm run plugin:check`, and `npm run verify`. The workflow must use no secrets, deployment, publish, release, upload, or Git write step.

Add `.gitattributes` so repository text inputs and the generated plugin distribution are checked out with LF on both macOS and Windows. The smoke/contract test must prove the rule covers plugin files, catalog inputs, root notices, and license inputs; this prevents `core.autocrlf=true` from making `plugin:check` compare CRLF checkout bytes against a fresh LF build.

- [ ] **Step 2: Run and verify RED**

Run: `npm test -- test/codex/offline-smoke.test.ts`

Expected: FAIL until the packaged integration commands and final activation contract are assembled.

- [ ] **Step 3: Update documentation and roadmap truthfully**

README must explain:

- installation is through the internal repo marketplace;
- Node.js 22+ is detected during initialization and is the only runtime prerequisite;
- the current automatic mechanism is Router Skill + managed `AGENTS.md`, not a Codex lifecycle Hook;
- current Codex lacks a validated `PreToolUse` interception contract, so deterministic core transitions are the enforcement boundary;
- the user initializes once and uses natural language afterward;
- runtime is local-only and performs no automatic Git/network action.
- the current plugin milestone routes and fails closed correctly, but `capture/plan/replan/Knowledge` and high-risk authorization issuance remain in the next workflow/release milestone; do not claim the full Spec lifecycle is executable yet.
- macOS is locally verified; Windows support is release-gated by the committed GitHub Actions runner and must remain “pending CI” until that workflow actually passes after push.

Update the roadmap target map from `plugin/` plus Hooks to `plugins/ezagent-spec/` plus Skills/AGENTS/bundled CLI, and change the Codex milestone gate to validator + offline activation smoke.

- [ ] **Step 4: Run every final gate**

Run:

```bash
npm run plugin:verify
npm run verify
npm pack --dry-run --json
git diff --check
git diff --cached --check
git status --short --ignored
```

Expected:

- plugin validator PASS;
- all Codex and full repository tests PASS;
- npm package still contains the core runtime and catalog but no release-only importer/source-lock code;
- `plugins/ezagent-spec` contains the self-contained plugin distribution;
- no vendor source, temporary marketplace cache, `.tgz`, root `.ezagent`, or untracked generated file is staged.
- the local macOS gate passes; the workflow definition contains a real macOS/Windows matrix, but no Windows pass is claimed before a pushed GitHub Actions run exists.

- [ ] **Step 5: Validate installability without mutating user Codex configuration**

Run the official plugin validator again and read the repo marketplace name:

```bash
python3 /Users/mediastorm/.codex/skills/.system/plugin-creator/scripts/validate_plugin.py plugins/ezagent-spec
python3 /Users/mediastorm/.codex/skills/.system/plugin-creator/scripts/read_marketplace_name.py --marketplace-path .agents/plugins/marketplace.json
```

Expected: `Plugin validation passed` and `ezagent-spec-internal`.

Do not run `codex plugin marketplace add` or `codex plugin add` until the user explicitly approves changing their Codex configuration. When approved, install the repo root as the local marketplace, add `ezagent-spec@ezagent-spec-internal`, and test it in a new Codex task so the new Skills are loaded.

- [ ] **Step 6: Stage final documentation and tests, but do not push**

Run: `git add README.md docs/superpowers/plans/2026-08-20-ezagent-spec-mvp-roadmap.md test/codex/offline-smoke.test.ts .github/workflows/ci.yml .gitattributes`

## Milestone definition of done

- The plugin passes the bundled current Codex plugin validator.
- No manifest, file, test, or instruction contains a Claude lifecycle Hook assumption.
- Initialization always previews managed paths, preserves existing user instructions, and is repeatable.
- New conversations in an initialized project receive a durable `AGENTS.md` instruction to invoke the broad Router Skill automatically.
- The Router restores state through the packaged CLI before classifying a request.
- Only selected experts are rendered, user custom agents are preserved, and modified generated files fail closed.
- The plugin is self-contained, deterministic, offline at runtime, and includes all required notices and licenses.
- The committed CI definition gates both macOS and Windows; release notes distinguish local macOS verification from the still-pending first pushed Windows run.
- Full workflow command verbs remain explicitly assigned to the next workflow/release milestone rather than being falsely claimed here.
- All implementation changes are staged or locally committed only as separately authorized; nothing is pushed automatically.
