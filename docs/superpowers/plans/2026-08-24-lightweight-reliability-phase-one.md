# Lightweight Reliability Phase One Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close expert-vocabulary persistence gaps, require one structured PASS receipt per quality gate, and add a genuinely short light-work path.

**Architecture:** Keep the standard workflow and its persisted artifacts intact. Add fail-closed checks immediately before plan mutations, evolve Knowledge to a backward-readable v2 record with structured receipts, and implement light work as a separate non-persistent Skill selected by the thin Router.

**Tech Stack:** TypeScript 7, Node.js 22, Zod 4, Vitest 3, Markdown-based Codex Skills, esbuild plugin packaging.

---

## File map

- `src/workflow/service.ts`: enforce vocabulary and active Task quality-gate invariants before mutations.
- `src/workflow/knowledge.ts`: define v2 capture/record schemas and keep canonical v1 reads.
- `test/workflow/expert-team-service.test.ts`: regression coverage for initial Plan vocabulary mismatches.
- `test/workflow/expert-team-replan.test.ts`: regression coverage for replacement Plan vocabulary mismatches.
- `test/workflow/knowledge.test.ts`: v2 completion, exact gate coverage, atomic failures, and legacy reads.
- `test/cli/main.test.ts`: update the public completion example to v2 receipts.
- `plugins/ezagent-spec/skills/ezagent-light/SKILL.md`: bounded, non-persistent light implementation contract.
- `plugins/ezagent-spec/skills/ezagent-router/SKILL.md`: route eligible light work to the new Skill and promote uncertain work.
- `plugins/ezagent-spec/skills/ezagent-review/SKILL.md`: emit v2 Knowledge with structured receipts.
- `scripts/build-plugin.ts`: include the new Skill in deterministic plugin output.
- `test/codex/activation-contract.test.ts`: assert the Router/light boundary and handoff.
- `test/codex/offline-smoke.test.ts`: require the new Skill in source and packaged plugin trees.
- `README.md`: describe the short light lane and v2 completion evidence.

### Task 1: Reject unknown selection vocabulary before Plan mutations

**Files:**
- Modify: `test/workflow/expert-team-service.test.ts`
- Modify: `test/workflow/expert-team-replan.test.ts`
- Modify: `src/workflow/service.ts`

- [ ] **Step 1: Write failing initial-Plan regression test**

Add a test that clones `fixture.draft`, sets `domains` to `enginnering` and `projectSignals` to `appi`, obtains both previews, snapshots `.ezagent`, and expects `planApply` to reject while the snapshot remains equal.

```ts
test("rejects unknown domain and project signal before applying any artifact", async () => {
  const fixture = await createWorkflowTeamFixture();
  const draft = structuredClone(fixture.draft);
  draft.selection.domains = ["enginnering"];
  draft.selection.projectSignals = ["appi"];
  const selection = await fixture.service.selectPreview(draft);
  const input = {
    draft,
    selectionFingerprint: selection.selectionFingerprint,
    assignments: fixture.assignmentsFor(selection),
  };
  const preview = await fixture.service.planPreview(input);
  expect(preview.vocabularyMismatches).toMatchObject({
    domains: ["enginnering"],
    projectSignals: ["appi"],
  });
  const before = await fixture.snapshot();
  await expect(fixture.service.planApply({
    ...input,
    approvalToken: preview.approvalToken,
  })).rejects.toThrow(/unknown domains.*project signals/iu);
  expect(await fixture.snapshot()).toEqual(before);
});
```

- [ ] **Step 2: Run the initial-Plan test and observe RED**

Run: `npx vitest run test/workflow/expert-team-service.test.ts`

Expected: the new test fails because `planApply` currently resolves and writes artifacts.

- [ ] **Step 3: Write failing replan regression test**

Add a test that mutates `fixture.expandedDraft().draft`, recomputes selection through `selectPreview`, builds assignments from the returned members, and verifies `replanApply` rejects without changing the snapshot.

```ts
test("rejects unknown replacement context before writing a team revision", async () => {
  const fixture = await createAppliedWorkflowTeamFixture();
  const replacement = fixture.expandedDraft();
  replacement.draft.selection.domains = ["enginnering"];
  replacement.draft.selection.projectSignals = ["appi"];
  const selection = await fixture.service.selectPreview(replacement.draft);
  const input = {
    draft: replacement.draft,
    selectionFingerprint: selection.selectionFingerprint,
    assignments: fixture.assignmentsFor(selection),
  };
  const preview = await fixture.service.replanPreview(input);
  const before = await fixture.snapshot();
  await expect(fixture.service.replanApply({
    ...input,
    approvalToken: preview.approvalToken,
  })).rejects.toThrow(/unknown domains.*project signals/iu);
  expect(await fixture.snapshot()).toEqual(before);
});
```

- [ ] **Step 4: Run the replan test and observe RED**

Run: `npx vitest run test/workflow/expert-team-replan.test.ts`

Expected: the new test fails because `replanApply` currently writes the replacement artifacts.

- [ ] **Step 5: Add one fail-closed helper and call it from both apply methods**

Add this helper near `vocabularyMismatches`:

```ts
function assertKnownSelectionContext(mismatches: VocabularyMismatches): void {
  const unknown: string[] = [];
  if (mismatches.domains.length > 0) {
    unknown.push(`unknown domains: ${mismatches.domains.join(", ")}`);
  }
  if (mismatches.projectSignals.length > 0) {
    unknown.push(`unknown project signals: ${mismatches.projectSignals.join(", ")}`);
  }
  if (unknown.length > 0) throw new Error(unknown.join("; "));
}
```

Call `assertKnownSelectionContext(prepared.vocabularyMismatches)` after approval-token equality and before blocker checks in `planApply` and `replanApply`. Capabilities remain governed by `capability-uncovered`.

- [ ] **Step 6: Run both focused tests and observe GREEN**

Run: `npx vitest run test/workflow/expert-team-service.test.ts test/workflow/expert-team-replan.test.ts`

Expected: both files pass and the atomic snapshot assertions remain green.

- [ ] **Step 7: Commit the vocabulary fix**

```bash
git add src/workflow/service.ts test/workflow/expert-team-service.test.ts test/workflow/expert-team-replan.test.ts
git commit -m "fix: reject unknown expert selection context"
```

### Task 2: Add backward-readable Knowledge v2 receipts

**Files:**
- Modify: `test/workflow/knowledge.test.ts`
- Modify: `src/workflow/knowledge.ts`

- [ ] **Step 1: Write failing schema and legacy-read tests**

Update the successful completion fixture to `schemaVersion: 2` and add two receipts matching the fixture gates exactly:

```ts
qualityGateReceipts: [
  {
    gate: "API 测试通过",
    command: "npm run test:api",
    outcome: "passed",
    exitCode: 0,
    summary: "API tests passed.",
  },
  {
    gate: "独立审查失败路径",
    command: "npm run review:failures",
    outcome: "passed",
    exitCode: 0,
    summary: "Failure-path review passed.",
  },
],
```

Add a direct module test that supplies a canonical v1 Markdown record to `parseKnowledgeRecordMarkdown` and expects `schemaVersion` to be `1`. Also assert a new completed record contains `schemaVersion: 2` and the receipts in frontmatter.

- [ ] **Step 2: Run the Knowledge test and observe RED**

Run: `npx vitest run test/workflow/knowledge.test.ts`

Expected: v2 parsing fails because only schema version 1 exists.

- [ ] **Step 3: Define strict v2 types and a v1/v2 record union**

In `src/workflow/knowledge.ts`, add:

```ts
export interface QualityGateReceipt {
  readonly gate: string;
  readonly command: string;
  readonly outcome: "passed";
  readonly exitCode: 0;
  readonly summary: string;
}

export interface KnowledgeCaptureInput {
  readonly schemaVersion: 2;
  readonly title: string;
  readonly summary: string;
  readonly decisions: readonly string[];
  readonly constraints: readonly string[];
  readonly verificationEvidence: readonly string[];
  readonly qualityGateReceipts: readonly QualityGateReceipt[];
  readonly followUps: readonly string[];
}
```

Create strict `legacyRecordSchema` for existing v1 frontmatter and strict `captureSchema`/`recordSchema` for v2. Receipt fields use `textSchema`; `outcome` is the literal `passed`; `exitCode` is literal `0`; duplicate normalized gate names are rejected.

- [ ] **Step 4: Preserve canonical v1 reads and write only canonical v2**

Use a discriminated union for record parsing. Freeze every nested receipt. `parseKnowledgeRecordMarkdown` selects serialization by `schemaVersion` before comparing the exact canonical Markdown. `createKnowledgeRecord` and `serializeKnowledgeRecord` accept only v2 output records.

- [ ] **Step 5: Run the Knowledge schema tests and observe GREEN**

Run: `npx vitest run test/workflow/knowledge.test.ts`

Expected: v2 success and legacy parsing pass. Exact active Task gate-set failure cases are added separately in Task 3.

- [ ] **Step 6: Commit the v2 schema foundation**

```bash
git add src/workflow/knowledge.ts test/workflow/knowledge.test.ts
git commit -m "feat: add structured quality gate receipts"
```

### Task 3: Enforce exact receipt coverage at completion

**Files:**
- Modify: `test/workflow/knowledge.test.ts`
- Modify: `src/workflow/service.ts`
- Modify: `test/cli/main.test.ts`

- [ ] **Step 1: Write failing atomic completion cases**

Add a table-driven test for missing, duplicate, and unknown gates. For each case, create a fresh applied fixture, move it to `verifying`, capture `fixture.snapshot()`, call `completeActiveTask`, expect rejection, and assert the snapshot remains unchanged. Keep the duplicate case at the schema layer and the missing/unknown cases at service coverage.

- [ ] **Step 2: Run the focused Knowledge test and observe RED**

Run: `npx vitest run test/workflow/knowledge.test.ts`

Expected: missing and unknown receipt sets are accepted because the service does not compare them to the active Task.

- [ ] **Step 3: Add exact gate-set validation before transition**

Add a helper in `src/workflow/service.ts`:

```ts
function assertQualityGateReceipts(
  qualityGates: readonly string[],
  receipts: readonly QualityGateReceipt[],
): void {
  const expected = new Set(qualityGates);
  const actual = new Set(receipts.map(({ gate }) => gate));
  const missing = qualityGates.filter((gate) => !actual.has(gate));
  const unknown = receipts.map(({ gate }) => gate).filter((gate) => !expected.has(gate));
  if (missing.length > 0 || unknown.length > 0 || actual.size !== receipts.length) {
    throw new Error("quality gate receipts must match the active Task exactly");
  }
}
```

Call it in `completeActiveTask` after `readActiveRecords` and before `transitionWorkItem`, passing `records.task.qualityGates` and `input.qualityGateReceipts`.

- [ ] **Step 4: Upgrade the CLI completion fixture to v2**

Use receipts for `测试通过` and `独立审查`, with the real fixture commands recorded as bounded strings. Assert `task-completed` audit metadata includes `qualityGateReceiptCount: 2` instead of relying only on the evidence string count.

- [ ] **Step 5: Run focused workflow and CLI tests and observe GREEN**

Run: `npx vitest run test/workflow/knowledge.test.ts test/cli/main.test.ts`

Expected: all completion success and failure paths pass.

- [ ] **Step 6: Commit completion enforcement**

```bash
git add src/workflow/service.ts test/workflow/knowledge.test.ts test/cli/main.test.ts
git commit -m "fix: enforce active task quality gates"
```

### Task 4: Add the bounded light-work Skill and Router handoff

**Files:**
- Create: `plugins/ezagent-spec/skills/ezagent-light/SKILL.md`
- Modify: `plugins/ezagent-spec/skills/ezagent-router/SKILL.md`
- Modify: `plugins/ezagent-spec/skills/ezagent-review/SKILL.md`
- Modify: `scripts/build-plugin.ts`
- Modify: `test/codex/activation-contract.test.ts`
- Modify: `test/codex/offline-smoke.test.ts`

- [ ] **Step 1: Write failing plugin contract tests**

Extend the activation contract to require Router body text containing `$ezagent-light`, `最多 5 项`, and promotion to `standard` when dependencies, data model, migrations, auth/security boundaries, deployment infrastructure, public API compatibility, or cross-module architecture are involved. Require the light Skill to prohibit `.ezagent/**` mutation, team selection, plan apply, and fabricated command results.

Add `skills/ezagent-light/SKILL.md` to both source and packaged expected-file arrays in offline smoke coverage.

- [ ] **Step 2: Run the focused Codex tests and observe RED**

Run: `npx vitest run test/codex/activation-contract.test.ts test/codex/offline-smoke.test.ts`

Expected: tests fail because the new Skill and Router handoff do not exist.

- [ ] **Step 3: Create the light Skill**

The Skill frontmatter activates only when Router has classified an initialized-project behavior change as light. Its body must require: minimal context, an internal plan of at most 5 actions, no repeat approval, request-scoped writes, focused verification, exact command/result reporting, and immediate standard promotion before further writes if scope expands.

Use this contract structure:

```markdown
---
name: ezagent-light
description: 在已初始化项目中执行经 Router 确认为低风险、局部且可逆的轻量行为修改；使用最多 5 项微计划和聚焦验证，不创建持久化工作项或专家团队。
---

# EZagent Light

## 入口门

仅接受 Router 已分类为 light 的新行为变更。先确认不涉及依赖、数据模型、迁移、鉴权或安全边界、部署基础设施、公共 API 兼容性或跨模块架构；任一项不确定就停止 light，并转回 `$ezagent-spec` 按 standard 处理。

## 执行

读取最小必要上下文，形成最多 5 项内部微计划，不再次请求批准。只修改请求直接涉及的路径，不调用 team selection、plan preview、plan apply 或 transition，也不得写入 `.ezagent/**`。

运行与改动相称的聚焦验证，向用户报告实际命令、退出结果和必要摘要。不得虚构结果；验证失败时报告真实状态。执行中一旦发现范围扩大，停止后续写入并升级为 standard。
```

- [ ] **Step 4: Keep Router thin and update Review v2 example**

After context recovery and safe-mode checks, route new eligible light work directly to `$ezagent-light`. Route standard and high work to `$ezagent-spec`. Replace the Review completion JSON example with schema version 2 and one receipt per Task gate.

Use this v2 Review shape, expanding the receipt array to exactly match the active Task gates:

```json
{"schemaVersion":2,"title":"<knowledge-title>","summary":"<bounded-summary>","decisions":["<decision>"],"constraints":["<constraint>"],"verificationEvidence":["<human-readable-summary>"],"qualityGateReceipts":[{"gate":"<exact-task-gate>","command":"<actual-command>","outcome":"passed","exitCode":0,"summary":"<bounded-result-summary>"}],"followUps":[]}
```

- [ ] **Step 5: Include the Skill in deterministic packaging**

Insert `ezagent-light` into `SKILLS` in `scripts/build-plugin.ts`. Do not change plugin permissions or introduce runtime dependencies.

- [ ] **Step 6: Run the focused Codex tests and observe GREEN**

Run: `npx vitest run test/codex/activation-contract.test.ts test/codex/offline-smoke.test.ts test/codex/plugin-package.test.ts test/codex/skill-contract.test.ts`

Expected: all focused plugin and Skill contracts pass.

- [ ] **Step 7: Commit the light path**

```bash
git add plugins/ezagent-spec/skills scripts/build-plugin.ts test/codex
git commit -m "feat: add bounded light workflow"
```

### Task 5: Document compatibility and verify the release boundary

**Files:**
- Modify: `README.md`
- Modify: `docs/superpowers/plans/2026-08-24-lightweight-reliability-phase-one.md`

- [ ] **Step 1: Document the two workflow lanes and v2 evidence contract**

Add a concise README section: light work uses a non-persistent micro-plan and focused checks; standard/high retains the persisted lifecycle; new completion requests require v2 receipts while v1 Knowledge remains readable.

- [ ] **Step 2: Run one complete project verification**

Run: `npm run verify`

Expected: typecheck, all Vitest files, and production build pass once.

- [ ] **Step 3: Run one complete plugin verification**

Run: `npm run plugin:verify`

Expected: catalog verification, deterministic plugin check, plugin contract tests, and Codex tests pass once.

- [ ] **Step 4: Run the final whitespace and scope check**

Run: `git diff --check && git status --short`

Expected: no whitespace errors; status contains only the intended phase-one files.

- [ ] **Step 5: Commit documentation and final plan state**

```bash
git add README.md docs/superpowers/plans/2026-08-24-lightweight-reliability-phase-one.md
git commit -m "docs: explain lightweight reliability workflow"
```
