# EZagent Codex Plugin and Automatic Activation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Package the local core and selected experts as a Codex plugin that is initialized once and then activates automatically in every relevant project conversation.

**Architecture:** Bundle focused Skills for semantic routing, lifecycle Hooks for deterministic context injection and tool gating, a managed `AGENTS.md` block for durable project policy, and generated `.codex/agents/ezagent-*.toml` files for selected experts. Hooks call bundled JavaScript and exit immediately; no daemon or network service is introduced.

**Tech Stack:** TypeScript, esbuild, Codex plugin manifest, Skills, `SessionStart`/`UserPromptSubmit`/`PreToolUse` Hooks, project-scoped custom agents, Vitest.

---

## File map

- `plugin/.codex-plugin/plugin.json`: Codex plugin metadata and component paths.
- `plugin/hooks/hooks.json`: cross-platform lifecycle definitions.
- `plugin/skills/ezagent-router/SKILL.md`: automatic workflow routing.
- `plugin/skills/ezagent-initialize/SKILL.md`: one-time environment and project setup.
- `plugin/skills/ezagent-spec/SKILL.md`: light, standard, and high-risk planning.
- `plugin/skills/ezagent-implement/SKILL.md`: approved-task execution.
- `plugin/skills/ezagent-review/SKILL.md`: quality gates and completion.
- `src/adapters/codex/agents-md.ts`: managed project instruction block.
- `src/adapters/codex/hook-io.ts`: hook JSON input/output contracts.
- `src/adapters/codex/context.ts`: concise model context.
- `src/adapters/codex/gate.ts`: deterministic pre-tool decisions.
- `src/adapters/codex/project-agent.ts`: generated expert TOML.
- `src/adapters/codex/hook-main.ts`: bundled hook entrypoint.
- `scripts/build-plugin.ts`: reproducible plugin assembly.
- `scripts/collect-runtime-licenses.ts`: production dependency license bundle.
- `test/codex/**`: manifest, activation, managed-file, gate, agent, and package tests.

### Task 1: Create a valid skills-only plugin shell

**Files:**
- Create: `plugin/.codex-plugin/plugin.json`
- Create: `plugin/skills/ezagent-router/SKILL.md`
- Create: `plugin/skills/ezagent-initialize/SKILL.md`
- Test: `test/codex/plugin-manifest.test.ts`

- [ ] **Step 1: Write a failing manifest test**

```ts
// test/codex/plugin-manifest.test.ts
import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("Codex plugin manifest", () => {
  it("points to packaged skills and hooks", async () => {
    const manifest = JSON.parse(await readFile("plugin/.codex-plugin/plugin.json", "utf8"));
    expect(manifest).toMatchObject({ name: "ezagent-spec", version: "0.1.0", skills: "./skills/", hooks: "./hooks/hooks.json" });
  });
});
```

- [ ] **Step 2: Run the test and observe the missing file failure**

Run: `npm test -- test/codex/plugin-manifest.test.ts`

Expected: FAIL with `ENOENT` for `plugin/.codex-plugin/plugin.json`.

- [ ] **Step 3: Add the plugin manifest**

```json
{
  "name": "ezagent-spec",
  "version": "0.1.0",
  "description": "中文 Spec Coding：本地需求、任务、专家协作与质量门。",
  "author": {
    "name": "EZagent"
  },
  "license": "UNLICENSED",
  "keywords": ["spec-coding", "chinese", "multi-agent", "local-first"],
  "skills": "./skills/",
  "hooks": "./hooks/hooks.json",
  "interface": {
    "displayName": "EZagent Spec",
    "shortDescription": "中文、本地优先的 Spec Coding 工作流",
    "longDescription": "初始化一次后，自动管理需求、Spec、任务、项目专家、验证和跨会话恢复。",
    "developerName": "EZagent",
    "category": "Developer Tools",
    "capabilities": ["Instructions", "Lifecycle hooks", "Read", "Write"],
    "defaultPrompt": ["在这个项目启用 EZagent Spec。", "帮我实现这个需求。"]
  }
}
```

- [ ] **Step 4: Add the automatic router skill**

```markdown
---
name: ezagent-router
description: 在已初始化 EZagent 的项目中，自动处理任何开发、修改、修复、重构、审查或验证请求；用户不需要显式调用 EZagent 命令。普通解释和只读咨询不创建工作项。
---

当项目根存在 `.ezagent/project.yaml` 时使用此 Skill。

1. 读取 Hook 注入的当前 EZagent 阶段和活动工作项。
2. 把请求分类为 `consult`、`light`、`standard` 或 `high`。
3. 无法判断请求是否改变行为时先澄清；仍不确定则使用 `standard`。
4. 把结构化分类交给本地核心校验，不直接改写状态文件。
5. `consult` 正常回答；其他等级进入对应 Spec 流程。
6. 用户无需输入斜杠命令或 CLI 命令。
7. 不自动联网、提交、推送或上传项目。
```

- [ ] **Step 5: Add the one-time initialization skill**

```markdown
---
name: ezagent-initialize
description: 当用户要求在当前项目启用、初始化或安装 EZagent Spec 时，执行一次性环境检测、写入预览、信任说明和项目初始化。
---

1. 使用系统命令检测操作系统、项目根和 Node.js；此步骤不能依赖 Node.js 自己运行。
2. Node.js 缺失或不受支持时，说明需要 Node.js LTS。只有用户同意后才能联网或调用系统安装机制。
3. 重新检测 Node.js，验证通过后运行插件内打包的 `init` 命令。
4. 初始化前展示将管理的 `.ezagent/**`、`AGENTS.md` 标记区块和 `.codex/agents/ezagent-*`。
5. 保留所有现有配置；重复初始化必须幂等。
6. 说明 Hook 首次启用或升级时可能需要用户确认信任。
7. 初始化完成后告诉用户以后只需自然语言描述需求。
```

- [ ] **Step 6: Verify and commit**

Create an empty valid `plugin/hooks/hooks.json` containing `{ "hooks": {} }`, then run:

`npm test -- test/codex/plugin-manifest.test.ts`

Expected: PASS.

```bash
git add plugin test/codex/plugin-manifest.test.ts
git commit -m "feat: add Codex plugin shell"
```

### Task 2: Manage the project `AGENTS.md` block idempotently

**Files:**
- Create: `src/adapters/codex/agents-md.ts`
- Test: `test/codex/agents-md.test.ts`

- [ ] **Step 1: Write failing merge tests**

```ts
// test/codex/agents-md.test.ts
import { describe, expect, it } from "vitest";
import { mergeEzagentAgentsBlock } from "../../src/adapters/codex/agents-md.js";

describe("mergeEzagentAgentsBlock", () => {
  it("preserves user instructions and is idempotent", () => {
    const existing = "# Team rules\n\nKeep this line.\n";
    const once = mergeEzagentAgentsBlock(existing);
    const twice = mergeEzagentAgentsBlock(once);
    expect(twice).toBe(once);
    expect(twice).toContain("Keep this line.");
    expect(twice.match(/EZAGENT:START/g)).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Run and observe missing implementation**

Run: `npm test -- test/codex/agents-md.test.ts`

Expected: FAIL because `agents-md.ts` does not exist.

- [ ] **Step 3: Implement the managed block**

```ts
// src/adapters/codex/agents-md.ts
const START = "<!-- EZAGENT:START -->";
const END = "<!-- EZAGENT:END -->";
const BODY = `${START}
## EZagent Spec workflow

When \`.ezagent/project.yaml\` exists, automatically use the EZagent Spec workflow for development changes.
Do not require the user to type EZagent commands.
Before editing, obtain a valid light, approved standard, or separately authorized high-risk work item.
All subagent delegations must include the current Requirement/Spec/Task IDs, scope, deliverables, and quality gates.
Do not automatically access the network, commit, push, create a PR, or upload project data.
${END}`;

export function mergeEzagentAgentsBlock(existing: string): string {
  const start = existing.indexOf(START);
  const end = existing.indexOf(END);
  if ((start >= 0) !== (end >= 0) || (start >= 0 && end < start)) throw new Error("invalid EZagent AGENTS.md markers");
  const without = start >= 0 ? `${existing.slice(0, start)}${existing.slice(end + END.length)}` : existing;
  return `${without.trimEnd()}${without.trim() ? "\n\n" : ""}${BODY}\n`;
}
```

- [ ] **Step 4: Verify and commit**

Run: `npm test -- test/codex/agents-md.test.ts && npm run check`

Expected: PASS; user content is byte-identical outside the managed block.

Before committing, extend the CLI `init` path to read an existing root `AGENTS.md` or an empty string, apply `mergeEzagentAgentsBlock`, and write it with `atomicWriteText` only after workspace initialization succeeds. Add a second CLI initialization assertion proving the managed block appears once.

```bash
git add src/adapters/codex/agents-md.ts test/codex/agents-md.test.ts
git commit -m "feat: manage Codex project instructions"
```

### Task 3: Implement hook input/output and automatic context

**Files:**
- Create: `src/adapters/codex/hook-io.ts`
- Create: `src/adapters/codex/context.ts`
- Create: `src/adapters/codex/hook-main.ts`
- Test: `test/codex/context-hook.test.ts`

- [ ] **Step 1: Write a failing context-hook test**

```ts
// test/codex/context-hook.test.ts
import { mkdir, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { WorkspaceRepository } from "../../src/workspace/repository.js";
import { handleContextHook } from "../../src/adapters/codex/context.js";

describe("automatic context hook", () => {
  it("is silent outside initialized projects", async () => {
    const root = await mkdtemp(join(tmpdir(), "ezagent-hook-empty-"));
    expect(await handleContextHook({ hook_event_name: "UserPromptSubmit", cwd: root, prompt: "改一下按钮" })).toBeNull();
  });

  it("injects concise policy without echoing the full prompt", async () => {
    const root = await mkdtemp(join(tmpdir(), "ezagent-hook-active-"));
    await new WorkspaceRepository(root).initialize({ schemaVersion: 1, name: "Demo", gitTracking: "none" });
    const nested = join(root, "src", "feature");
    await mkdir(nested, { recursive: true });
    const output = await handleContextHook({ hook_event_name: "UserPromptSubmit", cwd: nested, prompt: "secret full prompt" });
    expect(output?.hookSpecificOutput.additionalContext).toContain("EZagent project: Demo");
    expect(JSON.stringify(output)).not.toContain("secret full prompt");
  });

  it("restores the same context at session start after compaction", async () => {
    const root = await mkdtemp(join(tmpdir(), "ezagent-hook-session-"));
    await new WorkspaceRepository(root).initialize({ schemaVersion: 1, name: "Demo", gitTracking: "none" });
    const output = await handleContextHook({ hook_event_name: "SessionStart", cwd: root });
    expect(output?.hookSpecificOutput.hookEventName).toBe("SessionStart");
    expect(output?.hookSpecificOutput.additionalContext).toContain("Active work item:");
  });
});
```

- [ ] **Step 2: Add hook contracts**

```ts
// src/adapters/codex/hook-io.ts
import { z } from "zod";

export const hookInputSchema = z.object({
  hook_event_name: z.enum(["SessionStart", "UserPromptSubmit", "PreToolUse"]),
  cwd: z.string().min(1),
  prompt: z.string().optional(),
  tool_name: z.string().optional(),
  tool_input: z.unknown().optional(),
}).passthrough();

export type HookInput = z.infer<typeof hookInputSchema>;
export interface ContextHookOutput {
  hookSpecificOutput: { hookEventName: "SessionStart" | "UserPromptSubmit"; additionalContext: string };
}
```

- [ ] **Step 3: Implement concise context**

```ts
// src/adapters/codex/context.ts
import { access } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { WorkspaceRepository } from "../../workspace/repository.js";
import type { ContextHookOutput, HookInput } from "./hook-io.js";

export async function findProjectRoot(start: string): Promise<string | null> {
  let current = resolve(start);
  while (true) {
    try { await access(join(current, ".ezagent", "project.yaml")); return current; }
    catch { /* continue toward the filesystem root */ }
    const parent = dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

export async function handleContextHook(input: HookInput): Promise<ContextHookOutput | null> {
  const projectRoot = await findProjectRoot(input.cwd);
  if (!projectRoot) return null;
  const { project, state, recovered } = await new WorkspaceRepository(projectRoot).readContext();
  const active = state.activeWorkItem ? `${state.activeWorkItem.id} ${state.activeWorkItem.status} ${state.activeWorkItem.risk}` : "none";
  return {
    hookSpecificOutput: {
      hookEventName: input.hook_event_name === "SessionStart" ? "SessionStart" : "UserPromptSubmit",
      additionalContext: `EZagent project: ${project.name}\nActive work item: ${active}\nSafe mode: ${state.safeMode}\nRecovered: ${recovered}\nAutomatically route mutating requests through EZagent; do not require a manual command.`,
    },
  };
}
```

- [ ] **Step 4: Add a stdin/stdout hook entrypoint**

```ts
// src/adapters/codex/hook-main.ts
import { handleContextHook } from "./context.js";
import { hookInputSchema } from "./hook-io.js";

const chunks: Buffer[] = [];
for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
const input = hookInputSchema.parse(JSON.parse(Buffer.concat(chunks).toString("utf8")));
const output = await handleContextHook(input);
if (output) process.stdout.write(`${JSON.stringify(output)}\n`);
```

- [ ] **Step 5: Verify and commit**

Run: `npm test -- test/codex/context-hook.test.ts && npm run check`

Expected: PASS; the uninitialized result is null, nested directories resolve their project root, session starts restore context, and output contains no raw prompt.

```bash
git add src/adapters/codex test/codex/context-hook.test.ts
git commit -m "feat: inject automatic EZagent context"
```

### Task 4: Configure cross-platform lifecycle hooks

**Files:**
- Modify: `plugin/hooks/hooks.json`
- Test: `test/codex/hooks-config.test.ts`

- [ ] **Step 1: Write a failing hook-config test**

```ts
// test/codex/hooks-config.test.ts
import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("plugin hooks", () => {
  it("defines macOS and Windows commands for automatic lifecycle events", async () => {
    const config = JSON.parse(await readFile("plugin/hooks/hooks.json", "utf8"));
    for (const event of ["SessionStart", "UserPromptSubmit", "PreToolUse"]) {
      const command = config.hooks[event][0].hooks[0];
      expect(command.command).toContain("command -v node");
      expect(command.commandWindows).toContain("Get-Command node");
      expect(command.timeout).toBeLessThanOrEqual(5);
    }
  });
});
```

- [ ] **Step 2: Replace the empty hook config**

```json
{
  "hooks": {
    "SessionStart": [
      {
        "matcher": "startup|resume|clear|compact",
        "hooks": [
          {
            "type": "command",
            "command": "command -v node >/dev/null 2>&1 || exit 0; node \"${CLAUDE_PLUGIN_ROOT}/dist/ezagent-hook.mjs\"",
            "commandWindows": "if (Get-Command node -ErrorAction SilentlyContinue) { node \"$env:CLAUDE_PLUGIN_ROOT\\dist\\ezagent-hook.mjs\" }",
            "timeout": 5,
            "statusMessage": "Loading EZagent project state..."
          }
        ]
      }
    ],
    "UserPromptSubmit": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "command -v node >/dev/null 2>&1 || exit 0; node \"${CLAUDE_PLUGIN_ROOT}/dist/ezagent-hook.mjs\"",
            "commandWindows": "if (Get-Command node -ErrorAction SilentlyContinue) { node \"$env:CLAUDE_PLUGIN_ROOT\\dist\\ezagent-hook.mjs\" }",
            "timeout": 5
          }
        ]
      }
    ],
    "PreToolUse": [
      {
        "matcher": "Bash|apply_patch|Write|Edit",
        "hooks": [
          {
            "type": "command",
            "command": "command -v node >/dev/null 2>&1 || exit 0; node \"${CLAUDE_PLUGIN_ROOT}/dist/ezagent-hook.mjs\"",
            "commandWindows": "if (Get-Command node -ErrorAction SilentlyContinue) { node \"$env:CLAUDE_PLUGIN_ROOT\\dist\\ezagent-hook.mjs\" }",
            "timeout": 5,
            "statusMessage": "Checking EZagent quality gate..."
          }
        ]
      }
    ]
  }
}
```

- [ ] **Step 3: Verify config and commit**

Run: `npm test -- test/codex/hooks-config.test.ts`

Expected: PASS for all three lifecycle events.

```bash
git add plugin/hooks/hooks.json test/codex/hooks-config.test.ts
git commit -m "feat: configure automatic Codex hooks"
```

### Task 5: Enforce pre-tool workflow gates

**Files:**
- Create: `src/adapters/codex/gate.ts`
- Modify: `src/adapters/codex/hook-main.ts`
- Test: `test/codex/pre-tool-gate.test.ts`

- [ ] **Step 1: Write failing gate tests**

```ts
// test/codex/pre-tool-gate.test.ts
import { describe, expect, it } from "vitest";
import { decideToolUse } from "../../src/adapters/codex/gate.js";

describe("decideToolUse", () => {
  it("blocks file edits with no approved work item", () => {
    const decision = decideToolUse({ schemaVersion: 1, revision: 0, activeWorkItem: null, safeMode: false }, "apply_patch", {});
    expect(decision.hookSpecificOutput.permissionDecision).toBe("deny");
  });

  it("allows explicit read-only inspection before approval", () => {
    const decision = decideToolUse({ schemaVersion: 1, revision: 0, activeWorkItem: null, safeMode: false }, "Bash", { command: "git status --short" });
    expect(decision.hookSpecificOutput.permissionDecision).toBe("allow");
  });

  it("allows only the packaged EZagent control plane to advance workflow state", () => {
    const decision = decideToolUse({ schemaVersion: 1, revision: 0, activeWorkItem: null, safeMode: false }, "Bash", {
      command: "node \"/plugins/ezagent-spec/dist/ezagent-cli.mjs\" capture --root /workspace/demo --input /tmp/capture.json",
    }, { controlPlanePath: "/plugins/ezagent-spec/dist/ezagent-cli.mjs" });
    expect(decision.hookSpecificOutput.permissionDecision).toBe("allow");

    const impostor = decideToolUse({ schemaVersion: 1, revision: 0, activeWorkItem: null, safeMode: false }, "Bash", {
      command: "node \"/tmp/ezagent-cli.mjs\" capture --root /workspace/demo --input /tmp/capture.json",
    }, { controlPlanePath: "/plugins/ezagent-spec/dist/ezagent-cli.mjs" });
    expect(impostor.hookSpecificOutput.permissionDecision).toBe("deny");
  });

  it("does not treat an approved Spec or planned Task as write authorization", () => {
    for (const status of ["approved", "planned"] as const) {
      const decision = decideToolUse({ schemaVersion: 1, revision: 1, activeWorkItem: { id: "TASK-20260820-001", status, risk: "standard", revision: 0 }, safeMode: false }, "apply_patch", {});
      expect(decision.hookSpecificOutput.permissionDecision).toBe("deny");
    }
  });

  it("fails closed in safe mode", () => {
    const decision = decideToolUse({ schemaVersion: 1, revision: 0, activeWorkItem: null, safeMode: true }, "Bash", { command: "npm install x" });
    expect(decision.hookSpecificOutput.permissionDecision).toBe("deny");
  });
});
```

- [ ] **Step 2: Implement the base gate**

```ts
// src/adapters/codex/gate.ts
import type { WorkspaceState } from "../../workspace/schema.js";

const READ_ONLY_COMMANDS = [
  /^pwd$/, /^ls(?:\s|$)/, /^rg(?:\s|$)/, /^git (?:status|diff|log|show)(?:\s|$)/,
  /^node --version$/, /^npm (?:test|run check)(?:\s|$)/,
];
const CONTROL_VERBS = new Set(["init", "doctor", "context", "capture", "approve-spec", "plan", "assign", "start", "authorize", "record-run", "complete", "finish-spec"]);

export function decideToolUse(state: WorkspaceState, toolName: string, toolInput: unknown, options: { controlPlanePath?: string } = {}) {
  const command = typeof toolInput === "object" && toolInput !== null && "command" in toolInput ? String((toolInput as { command: unknown }).command).trim() : "";
  const readOnly = toolName === "Bash" && READ_ONLY_COMMANDS.some((pattern) => pattern.test(command));
  const prefixes = options.controlPlanePath ? [`node \"${options.controlPlanePath}\" `, `node '${options.controlPlanePath}' `, `node ${options.controlPlanePath} `] : [];
  const prefix = prefixes.find((candidate) => command.startsWith(candidate));
  const controlPlane = toolName === "Bash" && prefix !== undefined && CONTROL_VERBS.has(command.slice(prefix.length).split(/\s/, 1)[0]!);
  const writableStatus = state.activeWorkItem && ["implementing", "verifying"].includes(state.activeWorkItem.status);
  const allow = readOnly || (!state.safeMode && (controlPlane || Boolean(writableStatus)));
  return {
    hookSpecificOutput: {
      hookEventName: "PreToolUse" as const,
      permissionDecision: allow ? "allow" as const : "deny" as const,
      permissionDecisionReason: allow ? "EZagent gate passed" : "EZagent requires a valid approved work item before project changes",
    },
  };
}
```

- [ ] **Step 3: Route PreToolUse through the entrypoint**

Update `hook-main.ts` so `PreToolUse` calls `findProjectRoot(input.cwd)`, exits `0` with no output when it returns null, otherwise loads `WorkspaceRepository(projectRoot).readContext()`, resolves the trusted sibling CLI path with `fileURLToPath(new URL("./ezagent-cli.mjs", import.meta.url))`, passes that exact path as `controlPlanePath` to `decideToolUse`, and prints its JSON decision. `SessionStart` and `UserPromptSubmit` continue using `handleContextHook`. This exact-path comparison prevents an unrelated file named `ezagent-cli.mjs` from bypassing the gate.

- [ ] **Step 4: Verify and commit**

Run: `npm test -- test/codex/pre-tool-gate.test.ts && npm run check`

Expected: PASS with 3 gate cases.

```bash
git add src/adapters/codex/gate.ts src/adapters/codex/hook-main.ts test/codex/pre-tool-gate.test.ts
git commit -m "feat: enforce Codex workflow gates"
```

### Task 6: Generate only selected project experts

**Files:**
- Create: `src/adapters/codex/project-agent.ts`
- Test: `test/codex/project-agent.test.ts`

- [ ] **Step 1: Write a failing agent-render test**

```ts
// test/codex/project-agent.test.ts
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { renderProjectAgent } from "../../src/adapters/codex/project-agent.js";

const expert = JSON.parse(readFileSync(new URL("../fixtures/experts/translated.json", import.meta.url), "utf8"));

describe("renderProjectAgent", () => {
  it("creates a namespaced, assignment-bound custom agent", () => {
    const rendered = renderProjectAgent(expert, { taskIds: ["TASK-20260820-001"], mode: "review", reason: "independent frontend review" });
    expect(rendered.fileName).toBe("ezagent-engineering-frontend-architect.toml");
    expect(rendered.content).toContain('sandbox_mode = "read-only"');
    expect(rendered.content).toContain("TASK-20260820-001");
  });
});
```

- [ ] **Step 2: Implement deterministic TOML rendering**

```ts
// src/adapters/codex/project-agent.ts
import { parseExpert } from "../../experts/expert.js";

interface Assignment { taskIds: string[]; mode: "analysis" | "implement" | "review"; reason: string }

export function renderProjectAgent(value: unknown, assignment: Assignment): { fileName: string; content: string } {
  const expert = parseExpert(value);
  const slug = expert.id.replace(/^ezagent\./, "").replaceAll(".", "-");
  const name = `ezagent_${slug.replaceAll("-", "_")}`;
  const instructions = [expert.instructionsZh, `任务: ${assignment.taskIds.join(", ")}`, `启用理由: ${assignment.reason}`, "只处理委派范围；不得自行推进 EZagent 状态。"].join("\n\n");
  return {
    fileName: `ezagent-${slug}.toml`,
    content: [
      `name = ${JSON.stringify(name)}`,
      `description = ${JSON.stringify(expert.summaryZh)}`,
      `sandbox_mode = ${JSON.stringify(assignment.mode === "implement" ? "workspace-write" : "read-only")}`,
      `developer_instructions = ${JSON.stringify(instructions)}`,
      "",
    ].join("\n"),
  };
}
```

- [ ] **Step 3: Add safe file synchronization**

```ts
import { mkdir, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { atomicWriteText } from "../../workspace/atomic-write.js";

export async function syncProjectAgents(
  projectRoot: string,
  renderedAgents: Array<{ fileName: string; content: string }>,
): Promise<void> {
  const directory = join(projectRoot, ".codex", "agents");
  await mkdir(directory, { recursive: true });
  const wanted = new Set(renderedAgents.map((agent) => agent.fileName));
  for (const fileName of await readdir(directory)) {
    if (fileName.startsWith("ezagent-") && fileName.endsWith(".toml") && !wanted.has(fileName)) {
      await rm(join(directory, fileName));
    }
  }
  for (const agent of renderedAgents) {
    if (!/^ezagent-[a-z0-9-]+\.toml$/.test(agent.fileName)) throw new Error(`invalid generated agent name: ${agent.fileName}`);
    await atomicWriteText(join(directory, agent.fileName), agent.content);
  }
}
```

Add a test fixture containing `.codex/agents/user-reviewer.toml` and a stale `ezagent-old.toml`; after synchronization, the user file must remain byte-identical and only the stale EZagent file may be removed.

- [ ] **Step 4: Verify and commit**

Run: `npm test -- test/codex/project-agent.test.ts && npm run check`

Expected: PASS; analysis/review agents are read-only and implement agents are workspace-write.

```bash
git add src/adapters/codex/project-agent.ts test/codex/project-agent.test.ts
git commit -m "feat: generate selected Codex experts"
```

### Task 7: Add focused Spec, implementation, and review Skills

**Files:**
- Create: `plugin/skills/ezagent-spec/SKILL.md`
- Create: `plugin/skills/ezagent-implement/SKILL.md`
- Create: `plugin/skills/ezagent-review/SKILL.md`
- Test: `test/codex/skill-contract.test.ts`

- [ ] **Step 1: Write a skill-contract test**

The test must load all five EZagent `SKILL.md` files, parse their YAML frontmatter, require unique names and non-empty descriptions, and assert the following trigger phrases occur in the appropriate descriptions: `初始化`, `开发`, `Spec`, `实现`, and `验证`.

- [ ] **Step 2: Write `ezagent-spec` instructions**

````markdown
---
name: ezagent-spec
description: 为已初始化项目中的开发需求编写中文 Requirement 与 Spec，完成分级、范围、验收、验证和专家能力规划。
---

1. 从 Hook 上下文读取项目根、活动工作项、修订号和安全模式；安全模式下只做诊断。
2. 把意图结构化为 `consult|light|standard|high`，只保存简短标题、理由和能力需求，不保存完整对话。
3. `consult` 直接回答且不创建工作项。其余等级先明确目标、范围、非目标、验收标准和验证方法，再通过打包 CLI 的 `capture` 写入。
4. `light` 仅用于局部、可逆、低影响变更；短 Spec 写入后自动批准，但仍须规划一个有 `allowedPaths` 和质量门的 Task。
5. `standard` 展示 Spec 摘要并等待用户明确批准；批准后才能调用 `approve-spec` 和 `plan`。
6. `high` 同样先等待 Spec 批准；计划阶段不得把批准解释为对迁移、删除、发布、权限或数据操作的授权。
7. 从需求提取专家能力、领域和项目信号；专家总数按覆盖需求决定，超过并发能力时分批，不截断目录结果。
8. 只调用本地核心改变 `.ezagent/**`，不得直接编辑状态文件；不得自动联网、提交、推送或上传项目。
````

- [ ] **Step 3: Write `ezagent-implement` instructions**

````markdown
---
name: ezagent-implement
description: 实现 EZagent 已批准并规划的 Task，遵守文件范围、专家委派、高风险授权和本地质量证据约束。
---

1. 读取当前 Task、修订号、依赖、`allowedPaths`、交付物和质量门；缺少 Task 或依赖未完成时停止写入。
2. 使用选择器返回的全部专家，按运行时并发限制分批。每次委派都必须包含 Spec/Task/专家 ID、范围、输入、交付物、质量门、退出条件，并设置 `canWriteState: false`。
3. 通过 `assign` 同步当前项目专家；保留用户自有 Agent 文件。
4. 普通 Task 调用 `start` 进入 `implementing`。高风险 Task 先向用户展示一个精确工具动作，调用 `authorize` 后把返回的授权 ID 交给 `start`；授权不得泛化或复用。
5. 只修改 `allowedPaths` 内文件，按任务顺序工作，并收集实际变更与验证证据。范围变化时回到 Spec，而不是静默扩大 Task。
6. 所有状态变化都调用打包 CLI；不得直接编辑 `.ezagent/**`。
7. 不自动访问网络、安装系统软件、提交、推送、创建 PR、发布或上传项目。需要这些动作时单独请求用户授权。
````

- [ ] **Step 4: Write `ezagent-review` instructions**

````markdown
---
name: ezagent-review
description: 验证 EZagent Task 与 Spec，记录真实质量门证据，处理失败回路并沉淀跨会话项目知识。
---

1. 只运行 `.ezagent/quality/gates.yaml` 中被当前 Task 引用的命令；不得虚构测试、命令或结果。
2. 每个结果通过 `record-run` 保存命令、退出码、Task 修订号和完整输出哈希，不保存完整终端输出。
3. 缺失或失败的门使 Task 回到 `implementing`；说明失败证据，不得标记完成。
4. Spec 要求独立审查时，使用只读 review 专家和结构化委派；主协调者统一写入状态。
5. 所有门通过且交付物、验收标准满足后调用 `complete`。存在后继 Task 时切换到下一个依赖就绪的 Task。
6. 全部 Task 完成后调用 `finishSpec`，只沉淀结构化摘要、决策、可复用模式和验证 run ID；不得保存聊天全文。
7. 向用户报告结果和未解决风险；不得自动提交、推送、发布或上传。
````

- [ ] **Step 5: Verify and commit**

Run: `npm test -- test/codex/skill-contract.test.ts`

Expected: PASS for all five Skills and no duplicate trigger boundaries.

```bash
git add plugin/skills test/codex/skill-contract.test.ts
git commit -m "feat: add automatic Spec workflow skills"
```

### Task 8: Bundle and inspect the installable plugin

**Files:**
- Create: `scripts/build-plugin.ts`
- Create: `scripts/collect-runtime-licenses.ts`
- Create: `test/codex/plugin-package.test.ts`
- Modify: `package.json`
- Generate: `plugin/dist/ezagent-hook.mjs`
- Generate: `plugin/dist/ezagent-cli.mjs`

- [ ] **Step 1: Install the bundler and license-expression validator, then add scripts**

Run: `npm install --save-dev esbuild spdx-expression-parse @types/spdx-expression-parse`

Add:

```json
{
  "plugin:build": "tsx scripts/build-plugin.ts",
  "plugin:verify": "npm run plugin:build && vitest run test/codex"
}
```

- [ ] **Step 2: Implement deterministic runtime-license collection**

`collectRuntimeLicenses()` reads package-lock v3, selects every installed non-development package, validates its SPDX expression, and copies its installed license text. Do not download license text during packaging.

```ts
// scripts/collect-runtime-licenses.ts
import { cp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import parseSpdx from "spdx-expression-parse";

interface LockedPackage {
  name?: string;
  version?: string;
  dev?: boolean;
  link?: boolean;
  license?: string;
}

interface PackageLock {
  lockfileVersion?: number;
  packages?: Record<string, LockedPackage>;
}

function packageDirectory(name: string, version: string): string {
  return `${name.replace(/^@/, "").replaceAll("/", "__")}@${version}`;
}

export async function collectRuntimeLicenses(): Promise<void> {
  const lock = JSON.parse(await readFile("package-lock.json", "utf8")) as PackageLock;
  if (lock.lockfileVersion !== 3 || !lock.packages) throw new Error("package-lock v3 is required");

  const outputRoot = "plugin/licenses/npm";
  await rm(outputRoot, { recursive: true, force: true });
  await mkdir(outputRoot, { recursive: true });
  const notices = new Map<string, string>();

  for (const [installedPath, pkg] of Object.entries(lock.packages).sort(([a], [b]) => a.localeCompare(b))) {
    if (!installedPath.startsWith("node_modules/") || pkg.dev === true || pkg.link === true) continue;
    if (!pkg.name || !pkg.version || !pkg.license) throw new Error(`incomplete production license metadata: ${installedPath}`);
    try { parseSpdx(pkg.license); }
    catch { throw new Error(`invalid SPDX expression for ${pkg.name}@${pkg.version}: ${pkg.license}`); }

    const licenseFiles = (await readdir(installedPath)).filter((name) => /^licen[cs]e(?:[._-].*)?$/i.test(name)).sort();
    if (licenseFiles.length === 0) throw new Error(`missing installed LICENSE file: ${pkg.name}@${pkg.version}`);
    const key = `${pkg.name}@${pkg.version}`;
    if (notices.has(key)) continue;
    const target = join(outputRoot, packageDirectory(pkg.name, pkg.version));
    await mkdir(target, { recursive: true });
    for (const file of licenseFiles) await cp(join(installedPath, file), join(target, file));
    notices.set(key, pkg.license);
  }

  const rows = [...notices].sort(([a], [b]) => a.localeCompare(b)).map(([id, license]) => `| ${id} | ${license} |`).join("\n");
  await writeFile("plugin/RUNTIME_DEPENDENCIES.md", `# Runtime Dependencies\n\n| Package | SPDX license |\n|---|---|\n${rows}\n`, "utf8");
}
```

- [ ] **Step 3: Implement deterministic bundling**

```ts
// scripts/build-plugin.ts
import { cp, mkdir, rm } from "node:fs/promises";
import { build } from "esbuild";
import { collectRuntimeLicenses } from "./collect-runtime-licenses.js";

await rm("plugin/dist", { recursive: true, force: true });
await mkdir("plugin/dist", { recursive: true });
await build({ entryPoints: ["src/adapters/codex/hook-main.ts"], outfile: "plugin/dist/ezagent-hook.mjs", bundle: true, platform: "node", format: "esm", target: "node22", sourcemap: false });
await build({ entryPoints: ["src/cli/main.ts"], outfile: "plugin/dist/ezagent-cli.mjs", bundle: true, platform: "node", format: "esm", target: "node22", banner: { js: "#!/usr/bin/env node" }, sourcemap: false });
await rm("plugin/licenses", { recursive: true, force: true });
await mkdir("plugin/licenses", { recursive: true });
await cp("licenses/agency-agents-MIT.txt", "plugin/licenses/agency-agents-MIT.txt");
await cp("licenses/agency-agents-zh-MIT.txt", "plugin/licenses/agency-agents-zh-MIT.txt");
await cp("THIRD_PARTY_NOTICES.md", "plugin/THIRD_PARTY_NOTICES.md");
await rm("plugin/catalog", { recursive: true, force: true });
await mkdir("plugin/catalog", { recursive: true });
await cp("catalog/normalized/experts.json", "plugin/catalog/experts.json");
await cp("catalog/sources.lock.json", "plugin/catalog/sources.lock.json");
await collectRuntimeLicenses();
```

- [ ] **Step 4: Write package inspection tests**

The test must run the build, assert both bundles exist, verify the plugin contains the normalized catalog, Agency license files, and a notice/license for every bundled production dependency, scan all packaged text for `trellis` imports or copied `.trellis/` paths, and fail if it finds `fetch(`, telemetry SDK names, or automatic `git push`/`git commit` commands.

- [ ] **Step 5: Run the plugin gate**

Run: `npm run plugin:verify && node plugin/dist/ezagent-cli.mjs doctor --root .`

Expected: all Codex tests pass and doctor prints JSON with `ok: true`.

- [ ] **Step 6: Commit source and reproducible package metadata**

Add `plugin/dist/` and `plugin/catalog/` to `.gitignore`. The private release workflow always builds these generated files before creating its local archive; source control keeps only source, normalized catalog inputs, and packaging logic.

```bash
git add package.json package-lock.json .gitignore scripts/build-plugin.ts scripts/collect-runtime-licenses.ts test/codex/plugin-package.test.ts README.md
git commit -m "build: add Codex plugin packaging"
```
