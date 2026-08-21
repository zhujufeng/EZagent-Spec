# EZagent Structured Workflow and MVP Release Implementation Plan

> **v0.1.0 scope update (2026-08-22):** 本文保留早期完整方案作为历史记录。实际首版已经交付标准 Task 的结构化 Knowledge/Finish；一次性高风险授权方案被有意取消，高风险 Task 实施由核心统一关闭失败。以当前 README、MVP Roadmap 和代码测试为准。

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Complete the light, standard, and high-risk Spec Coding workflows, enforce structured expert delegation and verification, prove privacy and recovery behavior, and create an unpublished cross-platform MVP package.

**Architecture:** Add workflow use cases above the already-tested local core, persist human-readable artifacts through one service, and expose structured CLI operations for plugin Skills. Every mutating use case commits artifact writes, audit, and state through `WorkspaceRepository.commitMutation` without nested locks. Treat every mutation as a revisioned command, every expert run as a delegation contract, every completion as a verified gate result, and every high-risk action as a one-time fingerprinted authorization. Codex integration continues to use Router Skills + managed project `AGENTS.md` + the bundled short-lived CLI; this plan must not introduce lifecycle Hooks or claim a `PreToolUse` interception contract.

**Tech Stack:** TypeScript, Zod, YAML/Markdown frontmatter, Vitest, esbuild, GitHub Actions on macOS/Windows, local ZIP packaging.

---

## File map

- `src/workflow/intent.ts`: structured semantic classification accepted from Codex.
- `src/workflow/frontmatter.ts`: Markdown/frontmatter parsing and serialization.
- `src/workflow/artifacts.ts`: Requirement, Spec, and Task schemas.
- `src/workflow/resume-context.ts`: bounded cross-session Requirement/Spec/Task projection.
- `src/workflow/service.ts`: capture, specify, approve, plan, implement, verify, finish.
- `src/workflow/delegation.ts`: mandatory multi-Agent envelope.
- `src/workflow/authorization.ts`: one-time high-risk action fingerprints.
- `src/workflow/quality.ts`: gate definitions and verification runs.
- `src/workflow/privacy.ts`: redacted audit payload construction.
- `src/cli/main.ts`: structured workflow commands used by Skills.
- `plugins/ezagent-spec/skills/**`: final command contracts and recovery instructions.
- `test/workflow/**`: workflow and policy tests.
- `test/e2e/**`: approved product scenarios and restart recovery.
- `.github/workflows/ci.yml`: product-repository macOS/Windows checks.
- `scripts/package-plugin.ts`: local unpublished release archive.
- `release/`: ignored local artifacts.

### Task 1: Accept only structured intent classifications

**Files:**
- Create: `src/workflow/intent.ts`
- Create: `src/workflow/privacy.ts`
- Test: `test/workflow/intent.test.ts`
- Test: `test/workflow/privacy.test.ts`

- [ ] **Step 1: Write failing classification tests**

```ts
// test/workflow/intent.test.ts
import { describe, expect, it } from "vitest";
import { parseIntent } from "../../src/workflow/intent.js";

describe("parseIntent", () => {
  it("accepts a structured standard change", () => {
    expect(parseIntent({ level: "standard", title: "用户列表 Excel 导出", changesBehavior: true, reasons: ["新增用户可见功能"] }).level).toBe("standard");
  });

  it("rejects unstructured raw prompt storage", () => {
    expect(() => parseIntent({ prompt: "entire user prompt" })).toThrow();
  });

  it("requires uncertainty to resolve to clarification or standard", () => {
    expect(() => parseIntent({ level: "light", title: "不确定", changesBehavior: null, reasons: [] })).toThrow();
  });
});
```

- [ ] **Step 2: Run tests and verify missing module failure**

Run: `npm test -- test/workflow/intent.test.ts`

Expected: FAIL because `src/workflow/intent.ts` does not exist.

- [ ] **Step 3: Implement the classification schema**

```ts
// src/workflow/intent.ts
import { z } from "zod";

export const intentSchema = z.object({
  level: z.enum(["consult", "light", "standard", "high"]),
  title: z.string().min(1).max(120),
  changesBehavior: z.boolean(),
  reasons: z.array(z.string().min(1)).min(1),
  requestedCapabilities: z.array(z.string().min(1)).default([]),
  requestedDomains: z.array(z.string().min(1)).default([]),
}).strict().superRefine((intent, context) => {
  if (intent.level === "consult" && intent.changesBehavior) context.addIssue({ code: "custom", message: "behavior changes cannot be consult" });
  if (intent.level !== "consult" && !intent.changesBehavior) context.addIssue({ code: "custom", message: "non-consult work must change project behavior or artifacts" });
});

export type Intent = z.infer<typeof intentSchema>;
export const parseIntent = (value: unknown): Intent => intentSchema.parse(value);
```

- [ ] **Step 4: Add a redacted audit-metadata boundary**

```ts
// src/workflow/privacy.ts
import { auditMetadataSchema, type AuditMetadata } from "../audit/events.js";

const FORBIDDEN_KEY = /prompt|chat|transcript|environment|secret|token|terminal.?output|stdout|stderr|source.?content/i;

export function createAuditMetadata(value: unknown): AuditMetadata {
  const metadata = auditMetadataSchema.parse(value);
  for (const key of Object.keys(metadata)) {
    if (FORBIDDEN_KEY.test(key)) throw new Error(`forbidden audit metadata key: ${key}`);
  }
  return metadata;
}
```

`test/workflow/privacy.test.ts` must accept IDs, revisions, reasons, paths, and hashes; reject `rawPrompt`, `chatTranscript`, `environment`, `secret`, `stdout`, and `terminalOutput`; and reject strings/arrays above the core bounds. Every later `WorkflowService` mutation must pass metadata through this helper before calling `commitMutation`.

- [ ] **Step 5: Verify and commit**

Run: `npm test -- test/workflow/intent.test.ts test/workflow/privacy.test.ts && npm run check`

Expected: PASS; structured intent is accepted and forbidden audit payload shapes are rejected.

```bash
git add src/workflow/intent.ts src/workflow/privacy.ts test/workflow/intent.test.ts test/workflow/privacy.test.ts
git commit -m "feat: validate structured development intent"
```

### Task 2: Persist Requirement, Spec, and Task artifacts

**Files:**
- Create: `src/workflow/frontmatter.ts`
- Create: `src/workflow/artifacts.ts`
- Create: `src/workflow/resume-context.ts`
- Create: `src/workflow/service.ts`
- Modify: `src/adapters/codex/context.ts`
- Test: `test/workflow/artifacts.test.ts`
- Test: `test/workflow/resume-context.test.ts`

- [ ] **Step 1: Write failing artifact tests**

```ts
// test/workflow/artifacts.test.ts
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { WorkspaceRepository } from "../../src/workspace/repository.js";
import { WorkflowService } from "../../src/workflow/service.js";

describe("WorkflowService capture", () => {
  it("creates a light Requirement and approved lightweight Spec", async () => {
    const root = await mkdtemp(join(tmpdir(), "ezagent-light-"));
    await new WorkspaceRepository(root).initialize({ schemaVersion: 1, name: "Demo", gitTracking: "none" });
    const result = await new WorkflowService(root, { now: () => new Date("2026-08-20T01:00:00.000Z") }).capture({
      level: "light", title: "修改登录按钮文案", changesBehavior: true, reasons: ["局部可逆文案"], requestedCapabilities: [], requestedDomains: [],
    }, { goal: "登录按钮显示登录系统", scope: ["登录按钮文案"], acceptance: ["页面显示登录系统"], verification: ["运行现有前端测试"] });
    expect(result.spec.status).toBe("approved");
    expect(await readFile(join(root, ".ezagent", "specs", result.spec.id, "spec.md"), "utf8")).toContain("页面显示登录系统");
  });

  it("keeps a standard Spec unapproved", async () => {
    const root = await mkdtemp(join(tmpdir(), "ezagent-standard-"));
    await new WorkspaceRepository(root).initialize({ schemaVersion: 1, name: "Demo", gitTracking: "none" });
    const result = await new WorkflowService(root, { now: () => new Date("2026-08-20T01:00:00.000Z") }).capture({
      level: "standard", title: "用户列表 Excel 导出", changesBehavior: true, reasons: ["新增功能"], requestedCapabilities: ["frontend", "export"], requestedDomains: ["engineering"],
    }, { goal: "导出当前筛选结果", scope: ["用户列表"], acceptance: ["下载 xlsx 文件"], verification: ["导出集成测试"] });
    expect(result.spec.status).toBe("specified");
  });
});
```

- [ ] **Step 2: Add frontmatter utilities**

```ts
// src/workflow/frontmatter.ts
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";

export function serializeMarkdown(metadata: Record<string, unknown>, body: string): string {
  return `---\n${stringifyYaml(metadata).trimEnd()}\n---\n\n${body.trim()}\n`;
}

export function parseMarkdown(text: string): { metadata: Record<string, unknown>; body: string } {
  const normalized = text.replaceAll("\r\n", "\n");
  const match = normalized.match(/^---\n([\s\S]*?)\n---\n\n?([\s\S]*)$/);
  if (!match) throw new Error("artifact requires YAML frontmatter");
  return { metadata: parseYaml(match[1]!) as Record<string, unknown>, body: match[2]!.trim() };
}
```

- [ ] **Step 3: Define artifact schemas**

`src/workflow/artifacts.ts` must define Zod schemas and exported types for:

```ts
interface RequirementArtifact extends WorkItemState { kind: "requirement"; title: string; specIds: string[] }
interface SpecArtifact extends WorkItemState {
  kind: "spec"; requirementId: string; title: string; goal: string; scope: string[];
  nonGoals: string[]; acceptance: string[]; verification: string[]; taskIds: string[];
}
interface TaskArtifact extends WorkItemState {
  kind: "task"; specId: string; title: string; dependsOn: string[]; allowedPaths: string[];
  deliverables: string[]; qualityGateIds: string[];
}
```

Require stable IDs, non-empty acceptance and verification arrays, and `revision >= 0`.

- [ ] **Step 4: Implement the capture vertical slice**

`WorkflowService.capture(intent, details)` must:

1. Build one `commitMutation` command with the expected workspace revision; do not acquire a second lock inside the service.
2. Allocate the next Requirement and Spec IDs by scanning existing names for the current UTC date.
3. Stage the Requirement and Spec Markdown contents as relative `.ezagent` writes in that command.
4. Use `approved` for light Specs and `specified` for standard/high Specs.
5. Commit `workspace.json` so the new Spec is active, with artifact writes first, audit next, and state projection last.
6. Append one redacted audit event through the repository command that contains IDs, level, revisions, and hashes but not the raw prompt.
7. Return parsed artifacts.

The constructor must accept `{ now: () => Date }`, defaulting to the real clock in production. Every test fixture supplies the fixed 2026-08-20 clock so generated IDs and timestamps remain deterministic.

Use these body headings exactly:

```markdown
# 用户列表 Excel 导出

## 目标

## 范围

## 非目标

## 验收标准

## 验证方法
```

- [ ] **Step 5: Implement bounded cross-session resume context**

Before verification, implement `WorkflowService.resumeContext()` as a read-only projection. Starting from `workspace.activeWorkItem`, it must resolve and validate the parent chain (Task → Spec → Requirement), then return only bounded structured fields: IDs, titles, statuses, revisions, risk, Spec goal/scope/acceptance/verification, Task dependencies/allowed paths/deliverables/quality gate IDs, active expert IDs/reasons, safe mode, and recovery status. It must never return a raw prompt, chat transcript, environment variable, secret, full terminal output, or source-file contents.

Define the return schema in `src/workflow/resume-context.ts`. Add a test that captures work, constructs a fresh `WorkflowService`, and receives the same Requirement → Spec chain. Extend the existing `context --root <project-root> --json` CLI response with this bounded projection; Router calls that command at the start of every relevant turn. If any referenced artifact is missing or fails schema validation, return safe mode instead of silently dropping the broken link.

- [ ] **Step 6: Verify and commit**

Run: `npm test -- test/workflow/artifacts.test.ts test/workflow/resume-context.test.ts && npm run check`

Expected: PASS; light is approved, standard remains specified, artifacts are local, and a fresh service reconstructs the bounded context chain.

```bash
git add src/workflow/frontmatter.ts src/workflow/artifacts.ts src/workflow/resume-context.ts src/workflow/service.ts src/cli/main.ts test/workflow/artifacts.test.ts test/workflow/resume-context.test.ts
git commit -m "feat: capture local requirements and specs"
```

### Task 3: Add approval, planning, and Task execution boundaries

**Files:**
- Modify: `src/workflow/service.ts`
- Modify: `src/workspace/repository.ts`
- Test: `test/workflow/approval-plan.test.ts`
- Test: `test/workspace/repository.test.ts`

- [ ] **Step 1: Write failing approval and plan tests**

```ts
// test/workflow/approval-plan.test.ts
import { describe, expect, it } from "vitest";
import { createWorkflowFixture } from "../fixtures/workflow-fixture.js";

describe("approval and planning", () => {
  it("rejects planning an unapproved standard Spec", async () => {
    const fixture = await createWorkflowFixture("standard");
    await expect(fixture.service.plan(fixture.spec.id, fixture.spec.revision, [])).rejects.toThrow("approved");
  });

  it("creates dependency-ordered Tasks after approval", async () => {
    const fixture = await createWorkflowFixture("standard");
    const approved = await fixture.service.approveSpec(fixture.spec.id, fixture.spec.revision);
    const tasks = await fixture.service.plan(approved.id, approved.revision, [
      { title: "实现导出服务", dependsOn: [], allowedPaths: ["src/export/**"], deliverables: ["导出实现"], qualityGateIds: ["unit"] },
      { title: "接入用户列表", dependsOn: ["previous"], allowedPaths: ["src/users/**"], deliverables: ["导出入口"], qualityGateIds: ["integration"] },
    ]);
    expect(tasks).toHaveLength(2);
    expect(tasks[1]!.dependsOn).toEqual([tasks[0]!.id]);
    const started = await fixture.service.startTask(tasks[0]!.id, tasks[0]!.revision);
    expect(started.status).toBe("implementing");
    const resumed = await fixture.freshService().resumeContext();
    expect(resumed.task?.id).toBe(tasks[0]!.id);
  });
});
```

- [ ] **Step 2: Implement explicit Spec approval**

`approveSpec(id, expectedRevision)` must parse the Spec, call the domain state machine with `to: "approved"`, rewrite only that Spec, update workspace state, and append a redacted approval event. It must reject light Specs already approved, completed/cancelled Specs, and revision mismatches.

`createWorkflowFixture` must initialize `WorkflowService` with the same fixed 2026-08-20 clock used in Task 2 and expose `freshService()` that constructs a new instance against the same temporary root and clock.

- [ ] **Step 3: Implement Task planning**

`plan(specId, expectedRevision, taskInputs)` must require approved Spec status, reject empty plans, replace the literal dependency token `previous` with the preceding generated Task ID, detect dependency cycles, write Task Markdown files in stable input order, update the Spec to `planned`, make the first dependency-ready Task the workspace's active item, and return the Tasks.

Add `startTask(taskId, expectedRevision, highRiskAuthorizationId?)`. It must reject unmet dependencies and revision mismatches, transition a standard/light Task from `planned` to `implementing`, and require a valid authorization ID for a high-risk Task. Merely approving a Spec or planning a Task is never sufficient permission for project file writes.

Planning must load `.ezagent/quality/gates.yaml` and reject every `qualityGateId` that is not defined there. Extend `WorkspaceRepository.initialize` and its idempotency test so every new workspace creates this exact empty file without replacing a user-edited copy on repeated initialization:

```yaml
schemaVersion: 1
gates: []
```

Tests that use `unit` or `integration` must explicitly seed those gate definitions in their temporary fixture; production code must never invent a command for an unknown gate.

- [ ] **Step 4: Verify and commit**

Run: `npm test -- test/workflow/approval-plan.test.ts && npm run check`

Expected: PASS; unapproved planning fails and approved planning produces two ordered Tasks.

```bash
git add src/workflow/service.ts src/workspace/repository.ts test/workflow/approval-plan.test.ts test/workspace/repository.test.ts test/fixtures/workflow-fixture.ts
git commit -m "feat: approve specs and plan tasks"
```

### Task 4: Enforce structured multi-Agent delegation

**Files:**
- Create: `src/workflow/delegation.ts`
- Test: `test/workflow/delegation.test.ts`

- [ ] **Step 1: Write failing contract tests**

```ts
// test/workflow/delegation.test.ts
import { describe, expect, it } from "vitest";
import { parseDelegation } from "../../src/workflow/delegation.js";

describe("delegation contract", () => {
  it("requires work IDs, bounded scope, deliverables, gates, and an exit condition", () => {
    expect(parseDelegation({
      specId: "SPEC-20260820-001", taskId: "TASK-20260820-001", expertId: "ezagent.engineering.frontend-architect",
      scope: "只分析用户列表导出入口", inputs: ["已批准 Spec", "src/users"], deliverables: ["设计结论"],
      qualityGates: ["引用实际文件"], exitCondition: "提交设计结论后退出", canWriteState: false,
    }).canWriteState).toBe(false);
  });

  it("rejects subagents that can mutate EZagent state", () => {
    expect(() => parseDelegation({ specId: "SPEC-1", canWriteState: true })).toThrow();
  });
});
```

- [ ] **Step 2: Implement the strict delegation schema**

```ts
// src/workflow/delegation.ts
import { z } from "zod";

export const delegationSchema = z.object({
  specId: z.string().regex(/^SPEC-\d{8}-\d{3,}$/),
  taskId: z.string().regex(/^TASK-\d{8}-\d{3,}$/),
  expertId: z.string().regex(/^ezagent\./),
  scope: z.string().min(1),
  inputs: z.array(z.string().min(1)).min(1),
  deliverables: z.array(z.string().min(1)).min(1),
  qualityGates: z.array(z.string().min(1)).min(1),
  exitCondition: z.string().min(1),
  canWriteState: z.literal(false),
}).strict();

export type DelegationContract = z.infer<typeof delegationSchema>;
export const parseDelegation = (value: unknown): DelegationContract => delegationSchema.parse(value);
```

- [ ] **Step 3: Connect contracts to expert activation**

Add `WorkflowService.assignExperts(taskId, expectedRevision, delegations)`. It must validate every contract, require the same Task ID, require every expert ID to exist in the offline catalog, write `.ezagent/experts/active.yaml`, and append only expert IDs/reasons/task IDs to audit. It returns validated assignments but must not import the Codex adapter. The CLI `assign` handler is the adapter boundary: after the service succeeds, it calls `syncProjectAgents` to generate Codex project agents. This keeps `src/workflow/` reusable by a future Claude Code adapter.

- [ ] **Step 4: Verify and commit**

Run: `npm test -- test/workflow/delegation.test.ts && npm run check`

Expected: PASS; no delegation can grant state mutation.

```bash
git add src/workflow/delegation.ts src/workflow/service.ts test/workflow/delegation.test.ts
git commit -m "feat: require structured expert delegation"
```

### Task 5: Add one-time high-risk authorization

**Files:**
- Create: `src/workflow/authorization.ts`
- Modify: `src/adapters/codex/gate.ts`
- Test: `test/workflow/authorization.test.ts`

- [ ] **Step 1: Write failing authorization tests**

```ts
// test/workflow/authorization.test.ts
import { describe, expect, it } from "vitest";
import { actionFingerprint, consumeAuthorization } from "../../src/workflow/authorization.js";

describe("high-risk authorization", () => {
  it("binds authorization to canonical tool input and consumes it once", () => {
    const fingerprint = actionFingerprint("Bash", { command: "npm run migrate -- --drop-old-field" });
    const authorization = { id: "AUTH-20260820-001", specId: "SPEC-20260820-001", fingerprint, consumedAt: null };
    expect(consumeAuthorization(authorization, fingerprint, "2026-08-20T01:00:00.000Z").consumedAt).toBe("2026-08-20T01:00:00.000Z");
    expect(() => consumeAuthorization({ ...authorization, consumedAt: "2026-08-20T01:00:00.000Z" }, fingerprint, "2026-08-20T02:00:00.000Z")).toThrow("consumed");
  });
});
```

- [ ] **Step 2: Implement canonical fingerprints**

```ts
// src/workflow/authorization.ts
import { createHash } from "node:crypto";

export interface HighRiskAuthorization { id: string; specId: string; fingerprint: string; consumedAt: string | null }

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(",")}}`;
  return JSON.stringify(value) ?? "null";
}

export function actionFingerprint(toolName: string, input: unknown): string {
  return `sha256:${createHash("sha256").update(`${toolName}\n${canonical(input)}`).digest("hex")}`;
}

export function consumeAuthorization(authorization: HighRiskAuthorization, fingerprint: string, at: string): HighRiskAuthorization {
  if (authorization.consumedAt) throw new Error("authorization already consumed");
  if (authorization.fingerprint !== fingerprint) throw new Error("authorization does not match this action");
  return { ...authorization, consumedAt: at };
}
```

- [ ] **Step 3: Persist and enforce authorizations**

Store authorizations in `.ezagent/quality/authorizations/AUTH-*.json`. Add `WorkflowService.authorizeHighRisk(specId, expectedRevision, actionName, actionInput)` and a revisioned `consumeAuthorizedAction(...)` command. The command must require the active high-risk Task, match one exact unconsumed fingerprint, validate the declared target paths against the Task, and atomically consume the record before returning a structured authorization result; if no record matches, it fails closed with a specific reason. The Implement Skill must call this command immediately before the authorized action.

The same authorization ID must be supplied as `highRiskAuthorizationId` when the high-risk work item first transitions to `implementing`; this satisfies the domain state-machine guard. The stored fingerprint remains bound to one exact tool name/input, so authorization of the phase does not authorize a different command. If the authorized tool fails after the gate consumes the record, require a new explicit authorization instead of replaying it.

At the same core boundary, validate the active Task's `allowedPaths`. For an `apply_patch` action descriptor, extract every `*** Add File`, `*** Update File`, and `*** Delete File` target and reject the command if any normalized project-relative path falls outside the allowed globs. Other mutating action descriptors must carry an explicit normalized target-path list; unknown or unparseable actions fail closed.

This is a deterministic authorization boundary for EZagent state and its supported action protocol, not a claim that Codex intercepts every arbitrary tool call. If Codex later exposes a stable native policy/Hook interface, adapt the same decision function without changing the workflow model.

- [ ] **Step 4: Verify and commit**

Run: `npm test -- test/workflow/authorization.test.ts test/workflow/action-policy.test.ts && npm run check`

Expected: PASS; a second attempt with the same authorization is denied.

```bash
git add src/workflow/authorization.ts src/workflow/service.ts src/workflow/action-policy.ts test/workflow/authorization.test.ts test/workflow/action-policy.test.ts
git commit -m "feat: gate high-risk actions by authorization"
```

### Task 6: Record quality evidence and block false completion

**Files:**
- Create: `src/workflow/quality.ts`
- Modify: `src/workflow/service.ts`
- Test: `test/workflow/quality.test.ts`

- [ ] **Step 1: Write failing quality tests**

```ts
// test/workflow/quality.test.ts
import { describe, expect, it } from "vitest";
import { canCompleteTask } from "../../src/workflow/quality.js";

describe("quality completion", () => {
  it("requires every declared gate to pass for the current task revision", () => {
    expect(canCompleteTask(["unit", "integration"], [
      { gateId: "unit", taskRevision: 3, command: "npm test", exitCode: 0, outputHash: "sha256:" + "a".repeat(64) },
    ], 3)).toEqual({ allowed: false, missing: ["integration"], failed: [] });
  });

  it("reports a failed gate", () => {
    expect(canCompleteTask(["unit"], [
      { gateId: "unit", taskRevision: 3, command: "npm test", exitCode: 1, outputHash: "sha256:" + "b".repeat(64) },
    ], 3).failed).toEqual(["unit"]);
  });
});
```

- [ ] **Step 2: Implement gate evaluation**

```ts
// src/workflow/quality.ts
export interface VerificationRun { gateId: string; taskRevision: number; command: string; exitCode: number; outputHash: string }

export function canCompleteTask(required: string[], runs: VerificationRun[], taskRevision: number) {
  const current = runs.filter((run) => run.taskRevision === taskRevision);
  const missing = required.filter((gate) => !current.some((run) => run.gateId === gate));
  const failed = required.filter((gate) => current.some((run) => run.gateId === gate && run.exitCode !== 0));
  return { allowed: missing.length === 0 && failed.length === 0, missing, failed };
}
```

- [ ] **Step 3: Persist redacted verification runs**

`WorkflowService.recordVerification` accepts the current expected Task revision plus `{ gateId, command, exitCode, output }`. On the first run it transitions an `implementing` Task to `verifying`, then stores the resulting Task revision, command, exit code, timestamp, and SHA-256 of the complete output under `.ezagent/quality/runs/`; it must not store the complete output. Further runs while already `verifying` use that same revision. `completeTask` must call `canCompleteTask`; failure transitions the Task back to `implementing` (invalidating prior-revision runs), while success moves it to `completed` and activates the next dependency-ready Task if one exists.

- [ ] **Step 4: Verify and commit**

Run: `npm test -- test/workflow/quality.test.ts && npm run check`

Expected: PASS; no Task with missing or failed gates can complete.

```bash
git add src/workflow/quality.ts src/workflow/service.ts test/workflow/quality.test.ts
git commit -m "feat: require quality evidence for completion"
```

### Task 7: Expand the internal CLI for plugin workflows

**Files:**
- Modify: `src/cli/main.ts`
- Test: `test/cli/workflow.test.ts`

- [ ] **Step 1: Define JSON-in/JSON-out commands**

Add commands:

```text
capture       --root /workspace/demo --input /workspace/demo/inputs/capture.json
approve-spec  --root /workspace/demo --id SPEC-20260820-001 --revision 0
plan          --root /workspace/demo --id SPEC-20260820-001 --revision 1 --input /workspace/demo/inputs/tasks.json
assign        --root /workspace/demo --id TASK-20260820-001 --revision 0 --input /workspace/demo/inputs/delegations.json
authorize     --root /workspace/demo --id SPEC-20260820-001 --revision 2 --input /workspace/demo/inputs/hook-action.json
start         --root /workspace/demo --id TASK-20260820-001 --revision 0 [--authorization AUTH-20260820-001]
record-run    --root /workspace/demo --id TASK-20260820-001 --revision 1 --input /workspace/demo/inputs/verification.json
complete      --root /workspace/demo --id TASK-20260820-001 --revision 2
```

Every success prints one JSON object to stdout. Every failure prints one human-readable line to stderr, exits `1`, and makes no partial state change.

- [ ] **Step 2: Write a failing CLI workflow test**

The test must initialize a temporary project, write a standard capture payload to a temporary JSON file, run `capture`, assert the returned Spec is `specified`, prove `plan` fails before approval, approve it, plan one Task, and parse every stdout response as JSON.

- [ ] **Step 3: Implement command routing**

Use one parser helper for required options, read JSON input files with `readFile`, call the matching `WorkflowService` method, and serialize its return value. Do not accept raw JSON directly on the command line because shell escaping differs between macOS and Windows.

- [ ] **Step 4: Verify and commit**

Run: `npm run build && npm test -- test/cli/workflow.test.ts && npm run check`

Expected: PASS; planning before approval exits `1`, and the approved path succeeds.

```bash
git add src/cli/main.ts test/cli/workflow.test.ts
git commit -m "feat: expose structured workflow commands"
```

### Task 8: Prove the three MVP scenarios end to end

**Files:**
- Create: `test/e2e/light-change.test.ts`
- Create: `test/e2e/standard-feature.test.ts`
- Create: `test/e2e/high-risk-change.test.ts`
- Create: `test/e2e/restart-recovery.test.ts`
- Create: `test/fixtures/projects/web-app/**`

- [ ] **Step 1: Implement the light-change scenario**

Initialize a temporary copy of the web-app fixture, capture “登录按钮显示登录系统” as light, assert the Spec auto-approves, plan one bounded Task, start it, perform an allowed fixture edit, record a passing verification hash, complete the Task, and assert audit contains IDs/hashes but not the original full sentence.

- [ ] **Step 2: Implement the standard-feature scenario**

Capture “用户列表 Excel 导出” as standard, assert an `apply_patch` gate is denied before approval, approve and plan Tasks, select experts for frontend/export/testing capabilities, start the first dependency-ready Task, assert generated `ezagent-*` TOML files, then record passing gates and finish.

- [ ] **Step 3: Implement the high-risk scenario**

Capture “迁移用户表并删除旧字段” as high, approve and plan it, assert the migration command is still denied, create a fingerprinted authorization, start the Task with that authorization ID, assert the exact command is allowed once, and assert a modified or repeated command is denied.

- [ ] **Step 4: Implement restart recovery**

Stop using the first `WorkflowService` instance after planning, create a fresh instance against the same temporary project, call `resumeContext()`, and assert the Requirement/Spec/Task chain, status, experts, allowed paths, acceptance criteria, and quality requirements are preserved without reading a chat transcript.

- [ ] **Step 5: Run and commit**

Run: `npm run test:workflow`

Expected: all four end-to-end files pass; no fixture writes escape their temporary copies.

```bash
git add test/e2e test/fixtures/projects
git commit -m "test: cover approved Spec workflows end to end"
```

### Task 9: Persist project knowledge and prepare safe schema upgrades

**Files:**
- Create: `src/workflow/knowledge.ts`
- Create: `src/workspace/migration.ts`
- Create: `src/workspace/git-policy.ts`
- Modify: `src/workflow/service.ts`
- Modify: `src/cli/main.ts`
- Test: `test/workflow/knowledge.test.ts`
- Test: `test/workspace/migration.test.ts`
- Test: `test/workspace/git-policy.test.ts`

- [ ] **Step 1: Write a cross-session knowledge test**

Create a completed standard-workflow fixture, call `finishSpec` with a structured summary containing decisions, reusable patterns, verification run IDs, and no chat transcript, construct a fresh `WorkspaceRepository`, and assert `.ezagent/knowledge/decisions/SPEC-20260820-001.md` restores the same decisions while the active work item is cleared.

- [ ] **Step 2: Implement the knowledge record**

```ts
// src/workflow/knowledge.ts
import { z } from "zod";

export const knowledgeRecordSchema = z.object({
  specId: z.string().regex(/^SPEC-\d{8}-\d{3,}$/),
  title: z.string().min(1),
  summary: z.string().min(1),
  decisions: z.array(z.string().min(1)),
  reusablePatterns: z.array(z.string().min(1)),
  verificationRunIds: z.array(z.string().min(1)),
}).strict();

export type KnowledgeRecord = z.infer<typeof knowledgeRecordSchema>;
```

`WorkflowService.finishSpec` must require every Task completed, validate this record, write the knowledge Markdown, mark the Spec completed, clear `workspace.activeWorkItem`, and audit only the Spec ID, knowledge path, run IDs, and content hash.

Extend `resumeContext()` so a project with no active work returns paths, titles, and content hashes for the five most recently completed knowledge records. It may include their short structured summaries but must remain size-bounded and must not load arbitrary chat or terminal text.

Extend the CLI with `finish-spec --root /workspace/demo --id SPEC-20260820-001 --revision 4 --input /workspace/demo/inputs/knowledge.json`. It must follow the same JSON stdout, one-line stderr, exit-code, and no-partial-write contract as the other workflow commands.

- [ ] **Step 3: Implement local Git tracking advice**

```ts
// src/workspace/git-policy.ts
import type { ProjectConfig } from "./schema.js";

export function localExcludePatterns(policy: ProjectConfig["gitTracking"]): string[] {
  if (policy === "all") return [];
  if (policy === "artifacts") return [
    ".ezagent/state/", ".ezagent/audit/", ".ezagent/backups/", ".ezagent/quality/runs/",
    ".codex/agents/ezagent-*.toml",
  ];
  return [".ezagent/", ".codex/agents/ezagent-*.toml"];
}
```

The CLI `init` response must include these suggestions. It may update `.git/info/exclude` only when the user-approved initialization payload contains `applyLocalGitExclude: true`; it must never stage files or modify `.gitignore` silently.

- [ ] **Step 4: Implement backup-first migration infrastructure**

```ts
// src/workspace/migration.ts
export interface MigrationStep {
  from: number;
  to: number;
  apply: (backupRoot: string, stagingRoot: string) => Promise<void>;
}

export function migrationPath(current: number, target: number, steps: MigrationStep[]): MigrationStep[] {
  const path: MigrationStep[] = [];
  let version = current;
  while (version < target) {
    const step = steps.find((candidate) => candidate.from === version && candidate.to === version + 1);
    if (!step) throw new Error(`no workspace migration from schema ${version} to ${version + 1}`);
    path.push(step);
    version = step.to;
  }
  if (version !== target) throw new Error(`cannot migrate schema ${current} to ${target}`);
  return path;
}
```

Add `migrateWorkspace` in the same file. Read the current numeric schema version without first requiring the newest Zod schema. While holding the workspace lock, copy project config, state, requirements, specs, tasks, knowledge, experts, quality, and audit into a temporary backup directory, atomically rename that directory under `.ezagent/backups/`, then copy the completed backup into a separate staging directory. Every migration step mutates only staging. Validate the entire staged workspace before replacing live files, and write the new schema version last. If staging or validation fails, keep all business artifacts untouched, keep the completed backup, remove staging, and change only `safeMode` in live state. Recovery from a partially interrupted final replacement must use the backup manifest and content hashes.

- [ ] **Step 5: Verify and commit**

Run: `npm test -- test/workflow/knowledge.test.ts test/workspace/migration.test.ts test/workspace/git-policy.test.ts && npm run check`

Expected: project decisions survive a fresh repository instance, Git patterns match all three policies, and a failing fixture migration leaves a complete backup and safe mode.

```bash
git add src/workflow/knowledge.ts src/workspace/migration.ts src/workspace/git-policy.ts src/workflow/service.ts src/cli/main.ts test/workflow/knowledge.test.ts test/workspace/migration.test.ts test/workspace/git-policy.test.ts
git commit -m "feat: persist project knowledge and safe upgrades"
```

### Task 10: Add privacy, package, and performance verification

**Files:**
- Create: `test/e2e/privacy.test.ts`
- Create: `test/e2e/router-performance.test.ts`
- Create: `scripts/package-plugin.ts`
- Modify: `package.json`
- Modify: `.gitignore`

- [ ] **Step 1: Add runtime privacy scans**

The test must scan the runtime dependency graph and packaged JavaScript, reject network client imports and telemetry packages, reject `fetch(`, reject automatic `git commit`, `git push`, or PR commands, and inspect audit fixtures for raw prompts, environment variables, secrets, and full terminal output.

The same test must scan imports under `src/domain/`, `src/workspace/`, `src/audit/`, `src/experts/`, and `src/workflow/` and fail if any imports from `src/adapters/codex/`. Only the adapter may depend on core modules; the core must remain reusable by a future Claude Code adapter.

- [ ] **Step 2: Add the packaged context latency benchmark**

Build the plugin, initialize one temporary project, invoke `node plugins/ezagent-spec/dist/ezagent-cli.mjs context --root <temp-project> --json` in 100 fresh processes with argv-safe execution, sort durations, and assert the p95 duration is at most 250ms. Print min, median, p95, and max for macOS/Windows CI diagnosis. The benchmark measures the real automatic Router context path and does not simulate a nonexistent Hook.

- [ ] **Step 3: Add local ZIP packaging**

Run: `npm install --save-dev archiver @types/archiver`

`scripts/package-plugin.ts` must run the deterministic plugin build/check first, create `release/ezagent-spec-codex-plugin-0.1.0.zip`, include only `plugins/ezagent-spec/**`, normalize archive paths to `/`, and print the archive SHA-256. Add `release/` to `.gitignore`.

Add scripts:

```json
{
  "package:plugin": "tsx scripts/package-plugin.ts",
  "release:verify": "npm run verify && npm run catalog:verify && npm run plugin:verify && npm run test:workflow && npm run package:plugin"
}
```

- [ ] **Step 4: Verify and commit**

Run: `npm test -- test/e2e/privacy.test.ts test/e2e/router-performance.test.ts && npm run package:plugin`

Expected: privacy checks pass, packaged context p95 is at most 250ms, and one ignored ZIP with a printed SHA-256 exists under `release/`.

```bash
git add package.json package-lock.json .gitignore scripts/package-plugin.ts test/e2e/privacy.test.ts test/e2e/router-performance.test.ts
git commit -m "build: verify private local plugin package"
```

### Task 11: Add cross-platform product CI and final release gate

**Files:**
- Modify: `.github/workflows/ci.yml`
- Modify: `README.md`
- Create: `docs/mvp-verification.md`

- [ ] **Step 1: Add macOS and Windows CI**

Extend the existing `.github/workflows/ci.yml` without creating a second competing workflow. Keep the read-only `contents: read` permission, `persist-credentials: false`, macOS/Windows matrix, Node.js 22, `npm ci`, `plugin:check`, and repository verification. Pin every third-party Action to a reviewed full 40-hex commit SHA with a version comment; do not reference mutable major tags. Add `test:workflow` and the release verification command only after those scripts exist, and do not add secrets or publishing permissions.

- [ ] **Step 2: Document initialization and privacy truthfully**

README must state: Node.js is required but TypeScript/npm install is not required for end users; initialization is explicit once; later turns auto-trigger through Router Skill + managed `AGENTS.md`; no lifecycle Hook or tool-level interception is claimed; Local-only applies to EZagent rather than changing Codex data handling; no automatic Git/network/telemetry occurs.

- [ ] **Step 3: Create the verification report template with concrete evidence fields**

`docs/mvp-verification.md` must list the three scenario names, macOS and Windows CI run links, catalog count and lock SHAs, package SHA-256, packaged context p95 for both OS families, privacy scan result, license result, and known limitations. Populate every field from actual command output before calling the MVP complete.

- [ ] **Step 4: Run the complete local release gate**

Run: `npm ci && npm run release:verify`

Expected: all commands exit `0`, a local ZIP is produced, and no publish/push operation occurs.

- [ ] **Step 5: Commit CI and verification documentation**

```bash
git add .github/workflows/ci.yml README.md docs/mvp-verification.md
git commit -m "ci: verify EZagent MVP across platforms"
```

- [ ] **Step 6: Stop before distribution**

Report the local package path and SHA-256 to the user. Do not install it for colleagues, publish a marketplace entry, create a release, push Git, or upload the ZIP without a separate explicit request.
