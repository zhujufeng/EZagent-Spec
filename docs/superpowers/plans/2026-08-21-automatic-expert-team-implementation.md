# EZagent Automatic Expert Team Implementation Plan

> **Completion update (2026-08-22):** The vertical slice now continues through structured Knowledge and Task Finish. High-risk implementation is intentionally unsupported in v0.1.0; legacy authorization-planning notes are historical only.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver the shortest real vertical slice in which a Chinese Requirement/Spec produces a deterministic, approved, persisted, recoverable, and actually materialized Codex expert team without user-entered expert commands.

**Architecture:** Add a platform-neutral workflow layer above the existing catalog, selector, workspace transaction, active-expert projection, and Codex project-agent renderer. The Agent submits only a structured Plan draft and controlled capability request; Core selects members, enforces independent review, binds a token to the complete Plan/team preview, and commits Requirement/Spec/Task/team artifacts atomically. The Codex adapter then reconciles derived project agents and blocks implementation while the projection is not ready.

**Tech Stack:** TypeScript 7, Node.js 22+, Zod, YAML, Vitest, esbuild, Codex Skills, GitHub Actions on macOS and Windows.

---

## Execution policy: fast closure without validation loops

- Implement on the existing `main` branch because the repository owner has explicitly chosen direct-main development.
- Each task gets exactly one focused RED run and one focused GREEN run unless a genuine failure requires repair.
- Do not run `npm run verify`, `npm run plugin:verify`, the official validator, or the complete E2E after every task.
- Run one midpoint `npm run check` after Task 5.
- Run the full local release gate once in Task 10, then push once and wait for one macOS/Windows CI run if the user authorizes push.
- Commit each coherent slice so a failure can be reverted without discarding later work.
- Never initialize `.ezagent/` in the repository root; every stateful test uses a registered temporary directory.

## File map

- `src/experts/runtime-catalog.ts`: bounded, offline loading of the packaged expert catalog and controlled vocabulary.
- `src/workflow/plan-artifacts.ts`: strict Requirement/Spec/Task Plan draft and persisted-artifact schemas.
- `src/workflow/expert-team.ts`: team proposal, role policy, independent reviewer selection, soft threshold, and replan diff.
- `src/workflow/team-record.ts`: canonical ExpertTeamPlan serialization, fingerprints, approval tokens, and history paths.
- `src/workflow/service.ts`: two-stage preview, atomic apply, replan, retirement, and bounded resume context.
- `src/adapters/codex/expert-team.ts`: render/reconcile/inspect approved teams using the existing project-agent boundary.
- `src/experts/active.ts`: export canonical validation/serialization for use inside one workspace mutation.
- `src/adapters/codex/project-agent.ts`: expose a read-only readiness inspection without weakening synchronization safety.
- `src/cli/json-input.ts`: bounded strict JSON stdin reader for structured internal commands.
- `src/cli/main.ts`: team preview, Plan preview/apply, replan, reconcile, context projection, and implementing gate.
- `plugins/ezagent-spec/skills/**`: automatic Router/Spec/Implement/Review invocation contract.
- `src/adapters/codex/agents-md.ts`: persistent automatic routing and reconciliation rule.
- `test/workflow/**`: contracts, policy, transaction, token, replan, and recovery tests.
- `test/codex/**`: adapter, CLI/package, Skill, activation, and offline-smoke contracts.
- `test/e2e/automatic-expert-team.test.ts`: fresh-process vertical slice and cross-session recovery.
- `README.md`: honest user-visible automatic-team behavior and current lifecycle boundary.

### Task 1: Load the locked runtime catalog and vocabulary

**Files:**
- Create: `src/experts/runtime-catalog.ts`
- Create: `test/experts/runtime-catalog.test.ts`

- [ ] **Step 1: Write the focused failing tests**

```ts
// test/experts/runtime-catalog.test.ts
import { readFile } from "node:fs/promises";
import { describe, expect, test } from "vitest";
import {
  loadRuntimeCatalogBytes,
  parseRuntimeCatalog,
} from "../../src/experts/runtime-catalog.js";

describe("runtime expert catalog", () => {
  test("loads all locked experts and derives stable controlled vocabularies", async () => {
    const bytes = await readFile("catalog/normalized/experts.json");
    const catalog = parseRuntimeCatalog(bytes);
    expect(catalog.experts).toHaveLength(265);
    expect(catalog.fingerprint).toMatch(/^sha256:[0-9a-f]{64}$/u);
    expect([...catalog.capabilities]).toEqual([...catalog.capabilities].sort());
    expect(catalog.capabilities.size).toBeGreaterThan(0);
  });

  test("uses only an explicit local file and rejects malformed or oversized input", async () => {
    await expect(loadRuntimeCatalogBytes("/definitely/missing/experts.json")).rejects.toThrow();
    expect(() => parseRuntimeCatalog(Buffer.from('{"schemaVersion":1,"experts":[]}'))).toThrow();
    expect(() => parseRuntimeCatalog(Buffer.alloc(16 * 1024 * 1024 + 1))).toThrow();
  });
});
```

- [ ] **Step 2: Run one RED check**

Run: `npm test -- test/experts/runtime-catalog.test.ts`

Expected: FAIL because `src/experts/runtime-catalog.ts` does not exist.

- [ ] **Step 3: Implement the bounded offline loader**

Create these exact public contracts:

```ts
// src/experts/runtime-catalog.ts
import { createHash } from "node:crypto";
import { open } from "node:fs/promises";
import { parseExpert, type Expert } from "./expert.js";

export const RUNTIME_CATALOG_MAX_BYTES = 16 * 1024 * 1024;

export interface RuntimeCatalog {
  readonly experts: readonly Expert[];
  readonly byId: ReadonlyMap<string, Expert>;
  readonly capabilities: ReadonlySet<string>;
  readonly domains: ReadonlySet<string>;
  readonly projectSignals: ReadonlySet<string>;
  readonly fingerprint: `sha256:${string}`;
}

export async function loadRuntimeCatalogBytes(path: string): Promise<Buffer>;
export function parseRuntimeCatalog(bytes: Uint8Array): RuntimeCatalog;
```

Implementation requirements:

1. Open one caller-supplied absolute path read-only, reject symlinks/non-files, reject files above `RUNTIME_CATALOG_MAX_BYTES`, and compare file identity before/after read using existing filesystem-stat helpers.
2. Parse exact top-level keys `schemaVersion` and `experts`; require schema version 1 and a non-empty dense array.
3. Validate every item with `parseExpert`, reject duplicate IDs, and sort by expert ID using code-unit order.
4. Derive capability/domain/project-signal Sets from validated records and freeze returned arrays/records.
5. Compute the fingerprint from the exact reviewed bytes, not from reparsed JSON.
6. Do not import Git, `fetch`, HTTP, environment variables, telemetry, or release-only source-lock code.

- [ ] **Step 4: Run one GREEN check**

Run: `npm test -- test/experts/runtime-catalog.test.ts`

Expected: PASS with 2 tests; the normalized catalog reports 265 experts.

- [ ] **Step 5: Commit the catalog boundary**

```bash
git add src/experts/runtime-catalog.ts test/experts/runtime-catalog.test.ts
git commit -m "feat: load locked runtime expert catalog"
```

### Task 2: Define Plan artifacts and versioned team records

**Files:**
- Create: `src/workflow/plan-artifacts.ts`
- Create: `src/workflow/team-record.ts`
- Create: `test/workflow/plan-artifacts.test.ts`
- Create: `test/workflow/team-record.test.ts`

- [ ] **Step 1: Write the focused failing contract tests**

```ts
// test/workflow/plan-artifacts.test.ts
import { describe, expect, test } from "vitest";
import { parsePlanDraft } from "../../src/workflow/plan-artifacts.js";

export const standardPlanDraft = {
  schemaVersion: 1,
  requirement: { title: "用户资料输入校验", summary: "拒绝非法资料更新" },
  spec: {
    goal: "校验用户资料 API 输入",
    scope: ["用户资料更新接口"],
    nonGoals: ["不改变登录流程"],
    acceptance: ["非法输入返回结构化错误"],
    verification: ["运行 API 单元测试"],
  },
  task: {
    title: "实现资料校验",
    risk: "standard",
    allowedPaths: ["src/users/**", "test/users/**"],
    deliverables: ["实现和回归测试"],
    qualityGates: ["API 测试通过", "独立审查失败路径"],
  },
  selection: {
    capabilities: ["api-design"],
    domains: ["engineering"],
    projectSignals: ["typescript"],
    reviewAfter: 6,
  },
} as const;

describe("Plan draft", () => {
  test("accepts bounded structured content without raw prompt fields", () => {
    expect(parsePlanDraft(standardPlanDraft).task.risk).toBe("standard");
  });

  test("rejects raw prompts, unknown keys, empty gates, and unsafe paths", () => {
    expect(() => parsePlanDraft({ ...standardPlanDraft, rawPrompt: "full chat" })).toThrow();
    expect(() => parsePlanDraft({
      ...standardPlanDraft,
      task: { ...standardPlanDraft.task, qualityGates: [] },
    })).toThrow();
    expect(() => parsePlanDraft({
      ...standardPlanDraft,
      task: { ...standardPlanDraft.task, allowedPaths: ["../outside"] },
    })).toThrow();
  });
});
```

```ts
// test/workflow/team-record.test.ts
import { describe, expect, test } from "vitest";
import {
  approvalToken,
  createExpertTeamPlan,
  parseExpertTeamPlan,
  serializeExpertTeamPlan,
  teamHistoryPath,
} from "../../src/workflow/team-record.js";

describe("ExpertTeamPlan record", () => {
  test("round-trips canonically and binds approval to root and workspace revision", () => {
    const team = createExpertTeamPlan({
      schemaVersion: 1,
      teamRevision: 1,
      requirementId: "REQ-20260821-001",
      specId: "SPEC-20260821-001",
      taskId: "TASK-20260821-001",
      taskRevision: 0,
      selectionRequest: {
        capabilities: ["api-design"],
        domains: ["engineering"],
        projectSignals: ["typescript"],
        risk: "standard",
        reviewAfter: 6,
      },
      members: [
        {
          expertId: "ezagent.test.implementer",
          mode: "implement",
          reasons: ["covers:api-design"],
          scope: ["用户资料 API"],
          deliverables: ["实现和测试"],
          qualityGates: ["API 测试通过"],
        },
        {
          expertId: "ezagent.test.reviewer",
          mode: "review",
          reasons: ["independent-review"],
          scope: ["只读审查失败路径"],
          deliverables: ["审查结论"],
          qualityGates: ["不得自审"],
        },
      ],
      uncoveredCapabilities: [],
      requiresPlanReview: false,
      catalogFingerprint: `sha256:${"a".repeat(64)}`,
      selectionFingerprint: `sha256:${"b".repeat(64)}`,
    });
    const parsed = parseExpertTeamPlan(JSON.parse(serializeExpertTeamPlan(team)));
    expect(parseExpertTeamPlan(JSON.parse(serializeExpertTeamPlan(parsed)))).toEqual(parsed);
    expect(approvalToken("/project", 7, parsed)).not.toBe(approvalToken("/project", 8, parsed));
    expect(teamHistoryPath(parsed.taskId, parsed.teamRevision))
      .toBe(`experts/teams/${parsed.taskId}/000001.json`);
  });
});
```

- [ ] **Step 2: Run one RED check**

Run: `npm test -- test/workflow/plan-artifacts.test.ts test/workflow/team-record.test.ts`

Expected: FAIL because both workflow modules are missing.

- [ ] **Step 3: Implement strict Plan schemas**

Export these types and parsers from `src/workflow/plan-artifacts.ts`:

```ts
export type PlanRisk = "light" | "standard" | "high";

export interface PlanDraft {
  readonly schemaVersion: 1;
  readonly requirement: { readonly title: string; readonly summary: string };
  readonly spec: {
    readonly goal: string;
    readonly scope: readonly string[];
    readonly nonGoals: readonly string[];
    readonly acceptance: readonly string[];
    readonly verification: readonly string[];
  };
  readonly task: {
    readonly title: string;
    readonly risk: PlanRisk;
    readonly allowedPaths: readonly string[];
    readonly deliverables: readonly string[];
    readonly qualityGates: readonly string[];
  };
  readonly selection: {
    readonly capabilities: readonly string[];
    readonly domains: readonly string[];
    readonly projectSignals: readonly string[];
    readonly reviewAfter: number;
  };
}

export function parsePlanDraft(value: unknown): PlanDraft;
```

Use strict Zod objects, NFC normalized bounded text, dense non-empty arrays, canonical portable token validation, duplicate rejection after Unicode case-folding, and repository-relative forward-slash globs that reject absolute paths, `..`, backslashes, NUL, Windows device names, and control characters. The parser must never accept raw prompt/chat/transcript/environment/source-content fields.

Define persisted Requirement, Spec, and Task artifact types with `schemaVersion: 1`, generated IDs, status, revision, and parent IDs. Export canonical YAML serializers whose parse/serialize round trip is byte-stable.

- [ ] **Step 4: Implement canonical team records and tokens**

Export these contracts from `src/workflow/team-record.ts`:

```ts
export type ExpertTeamMode = "analysis" | "implement" | "review";

export interface ExpertTeamMember {
  readonly expertId: string;
  readonly mode: ExpertTeamMode;
  readonly reasons: readonly string[];
  readonly scope: readonly string[];
  readonly deliverables: readonly string[];
  readonly qualityGates: readonly string[];
}

export interface ExpertTeamPlan {
  readonly schemaVersion: 1;
  readonly teamRevision: number;
  readonly requirementId: string;
  readonly specId: string;
  readonly taskId: string;
  readonly taskRevision: number;
  readonly selectionRequest: {
    readonly capabilities: readonly string[];
    readonly domains: readonly string[];
    readonly projectSignals: readonly string[];
    readonly risk: PlanRisk;
    readonly reviewAfter: number;
  };
  readonly members: readonly ExpertTeamMember[];
  readonly uncoveredCapabilities: readonly string[];
  readonly requiresPlanReview: boolean;
  readonly catalogFingerprint: `sha256:${string}`;
  readonly selectionFingerprint: `sha256:${string}`;
  readonly teamFingerprint: `sha256:${string}`;
}

export function parseExpertTeamPlan(value: unknown): ExpertTeamPlan;
export function createExpertTeamPlan(
  value: Omit<ExpertTeamPlan, "teamFingerprint">,
): ExpertTeamPlan;
export function serializeExpertTeamPlan(value: ExpertTeamPlan): string;
export function teamHistoryPath(taskId: string, teamRevision: number): string;
export function approvalToken(
  canonicalProjectRoot: string,
  workspaceRevision: number,
  team: ExpertTeamPlan,
  largeTeamDecision?: "accepted",
): `sha256:${string}`;
```

The team fingerprint is computed from the same canonical object with `teamFingerprint` omitted. The approval token additionally binds canonical project root, workspace revision, all Plan/team contents, and the optional large-team decision. Do not include a timestamp, random value, prompt, or machine username.

- [ ] **Step 5: Run one GREEN check**

Run: `npm test -- test/workflow/plan-artifacts.test.ts test/workflow/team-record.test.ts`

Expected: PASS with strict schemas, stable serialization, and revision-bound tokens.

- [ ] **Step 6: Commit the contracts**

```bash
git add src/workflow/plan-artifacts.ts src/workflow/team-record.ts test/workflow/plan-artifacts.test.ts test/workflow/team-record.test.ts
git commit -m "feat: define expert team plan contracts"
```

### Task 3: Build deterministic role-aware team selection

**Files:**
- Create: `src/workflow/expert-team.ts`
- Create: `test/workflow/expert-team.test.ts`
- Create: `test/fixtures/expert-team-fixture.ts`

- [ ] **Step 1: Write the focused failing policy tests**

```ts
// test/workflow/expert-team.test.ts
import { describe, expect, test } from "vitest";
import { proposeExpertTeam, diffExpertTeams } from "../../src/workflow/expert-team.js";
import {
  expertFixture,
  nextTeam,
  previousTeam,
  requestFixture,
} from "../fixtures/expert-team-fixture.js";

describe("proposeExpertTeam", () => {
  test("selects the minimum implementer coverage plus an independent standard reviewer", () => {
    const proposal = proposeExpertTeam([
      expertFixture("broad", ["api-design", "validation"], ["implement"]),
      expertFixture("narrow", ["api-design"], ["implement"]),
      expertFixture("reviewer", ["api-design"], ["review"]),
    ], requestFixture({ risk: "standard", capabilities: ["api-design", "validation"] }));

    expect(proposal.members.map(({ expertId, mode }) => [expertId, mode])).toEqual([
      ["ezagent.test.broad", "implement"],
      ["ezagent.test.reviewer", "review"],
    ]);
    expect(proposal.uncoveredCapabilities).toEqual([]);
  });

  test("fails closed when standard work has no independent reviewer", () => {
    const proposal = proposeExpertTeam(
      [expertFixture("only", ["api-design"], ["implement"])],
      requestFixture({ risk: "standard", capabilities: ["api-design"] }),
    );
    expect(proposal.blockers).toContain("independent-reviewer-missing");
  });

  test.each([
    ["light", false],
    ["standard", true],
    ["high", true],
  ] as const)("applies the reviewer policy for %s risk", (risk, expectsReviewer) => {
    const proposal = proposeExpertTeam([
      expertFixture("implementer", ["api-design"], ["implement"]),
      expertFixture("reviewer", ["api-design"], ["review"]),
    ], requestFixture({ risk, capabilities: ["api-design"] }));
    expect(proposal.members.some((member) => member.mode === "review")).toBe(expectsReviewer);
  });

  test("uses reviewAfter only as a soft review threshold", () => {
    const proposal = proposeExpertTeam(
      Array.from({ length: 8 }, (_, index) => expertFixture(`e-${index}`, [`cap-${index}`], ["implement"])),
      requestFixture({ risk: "light", capabilities: Array.from({ length: 8 }, (_, i) => `cap-${i}`), reviewAfter: 6 }),
    );
    expect(proposal.members).toHaveLength(8);
    expect(proposal.requiresPlanReview).toBe(true);
  });

  test("returns stable added, removed, changed, and unchanged replan members", () => {
    expect(diffExpertTeams(previousTeam(), nextTeam())).toEqual({
      added: ["ezagent.test.security"],
      removed: ["ezagent.test.frontend"],
      changed: ["ezagent.test.backend"],
      unchanged: ["ezagent.test.reviewer"],
    });
  });
});
```

The fixture file must use real `Expert` shapes accepted by `parseExpert`; do not cast incomplete objects through `as Expert`.
It exports these builders and returns data accepted by `parseExpert` / `createExpertTeamPlan`:

```ts
export function expertFixture(
  slug: string,
  capabilities: readonly string[],
  preferredTasks: readonly ("implement" | "review")[],
): Expert;
export function requestFixture(overrides?: Partial<SelectionRequest>): SelectionRequest;
export function previousTeam(): ExpertTeamPlan;
export function nextTeam(): ExpertTeamPlan;
```

- [ ] **Step 2: Run one RED check**

Run: `npm test -- test/workflow/expert-team.test.ts`

Expected: FAIL because `src/workflow/expert-team.ts` does not exist.

- [ ] **Step 3: Implement the deterministic proposal policy**

Create these public contracts:

```ts
export interface ProposedExpertMember {
  readonly expertId: string;
  readonly mode: "implement" | "review";
  readonly reasons: readonly string[];
}

export interface ExpertTeamProposal {
  readonly members: readonly ProposedExpertMember[];
  readonly uncoveredCapabilities: readonly string[];
  readonly blockers: readonly (
    | "capability-uncovered"
    | "independent-reviewer-missing"
    | "large-team-review-required"
  )[];
  readonly requiresPlanReview: boolean;
  readonly selectionFingerprint: `sha256:${string}`;
}

export interface AssignmentDraft {
  readonly expertId: string;
  readonly scope: readonly string[];
  readonly deliverables: readonly string[];
  readonly qualityGates: readonly string[];
}

export interface TeamIdentity {
  readonly teamRevision: number;
  readonly requirementId: string;
  readonly specId: string;
  readonly taskId: string;
  readonly taskRevision: number;
  readonly catalogFingerprint: `sha256:${string}`;
}

export interface TeamDiff {
  readonly added: readonly string[];
  readonly removed: readonly string[];
  readonly changed: readonly string[];
  readonly unchanged: readonly string[];
}

export function proposeExpertTeam(
  catalog: readonly Expert[],
  request: SelectionRequest,
): ExpertTeamProposal;

export function finalizeExpertTeam(
  proposal: ExpertTeamProposal,
  assignments: readonly AssignmentDraft[],
  identity: TeamIdentity,
): ExpertTeamPlan;

export function diffExpertTeams(
  previous: ExpertTeamPlan,
  next: ExpertTeamPlan,
): TeamDiff;
```

Policy requirements:

1. `consult` is not accepted by the Plan parser; this vertical slice handles behavior-changing light/standard/high Tasks only.
2. Base candidates must support `implement`; pass only them to existing `selectExperts`.
3. Light work uses only base coverage.
4. Standard/high work selects one deterministic reviewer from candidates that support `review`, are not implementers, and overlap at least one requested capability, domain, or project signal. Score overlap as capabilities × 6, domains × 4, signals × 2, then expert ID.
5. If no reviewer qualifies, return the reviewer blocker; never reuse an implementer.
6. Preserve every base selection even above `reviewAfter`; add the large-team blocker without truncation.
7. `finalizeExpertTeam` requires assignments for exactly the proposed IDs, preserves proposed modes, and rejects an assignment that changes membership or role.
8. Diff by expert ID; mark `changed` when mode, reasons, scope, deliverables, or quality gates differ.
9. Sort all exposed arrays deterministically and freeze returned data.

- [ ] **Step 4: Run one GREEN check**

Run: `npm test -- test/workflow/expert-team.test.ts`

Expected: PASS; no fixed team size and no self-review role collision.

- [ ] **Step 5: Commit the policy**

```bash
git add src/workflow/expert-team.ts test/workflow/expert-team.test.ts test/fixtures/expert-team-fixture.ts
git commit -m "feat: select role-aware expert teams"
```

### Task 4: Preview and atomically approve a Plan with its team

**Files:**
- Create: `src/workflow/service.ts`
- Create: `test/workflow/expert-team-service.test.ts`
- Create: `test/fixtures/workflow-team-fixture.ts`
- Modify: `src/experts/active.ts`
- Modify: `test/experts/active.test.ts`

- [ ] **Step 1: Write the focused failing service tests**

```ts
// test/workflow/expert-team-service.test.ts
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { createWorkflowTeamFixture } from "../fixtures/workflow-team-fixture.js";

describe("ExpertTeamWorkflowService", () => {
  test("keeps both previews read-only and commits Plan/team/active/audit once", async () => {
    const fixture = await createWorkflowTeamFixture();
    const before = await fixture.snapshot();
    const selection = await fixture.service.selectPreview(fixture.draft);
    const preview = await fixture.service.planPreview({
      draft: fixture.draft,
      selectionFingerprint: selection.selectionFingerprint,
      assignments: fixture.assignmentsFor(selection),
    });
    expect(await fixture.snapshot()).toEqual(before);

    const applied = await fixture.service.planApply({
      draft: fixture.draft,
      selectionFingerprint: selection.selectionFingerprint,
      assignments: fixture.assignmentsFor(selection),
      approvalToken: preview.approvalToken,
    });
    expect(applied.task.status).toBe("planned");
    expect(applied.team.members.some((member) => member.mode === "review")).toBe(true);
    expect(await readFile(join(fixture.root, ".ezagent", "experts", "active.yaml"), "utf8"))
      .toContain(applied.task.id);
    expect((await fixture.repository.readState()).revision).toBe(1);
  });

  test("rejects an expired token without any artifact or revision change", async () => {
    const fixture = await createWorkflowTeamFixture();
    const prepared = await fixture.prepareApprovedInput();
    await fixture.bumpWorkspaceRevision();
    const before = await fixture.snapshot();
    await expect(fixture.service.planApply(prepared)).rejects.toThrow("approval token");
    expect(await fixture.snapshot()).toEqual(before);
  });

  test("requires an explicit accepted decision for a team above the soft threshold", async () => {
    const fixture = await createWorkflowTeamFixture({ capabilityCount: 7, reviewAfter: 6 });
    const selection = await fixture.service.selectPreview(fixture.draft);
    const input = {
      draft: fixture.draft,
      selectionFingerprint: selection.selectionFingerprint,
      assignments: fixture.assignmentsFor(selection),
    };
    const preview = await fixture.service.planPreview(input);
    expect(preview.blockers).toContain("large-team-review-required");
    await expect(fixture.service.planApply({
      ...input,
      approvalToken: preview.approvalToken,
    })).rejects.toThrow("large team");

    const acceptedInput = { ...input, largeTeamDecision: "accepted" as const };
    const acceptedPreview = await fixture.service.planPreview(acceptedInput);
    await expect(fixture.service.planApply({
      ...acceptedInput,
      approvalToken: acceptedPreview.approvalToken,
    })).resolves.toMatchObject({ task: { status: "planned" } });
  });
});
```

- [ ] **Step 2: Run one RED check**

Run: `npm test -- test/workflow/expert-team-service.test.ts`

Expected: FAIL because the workflow service is missing.

- [ ] **Step 3: Export pure active-expert normalization**

Refactor `src/experts/active.ts` without changing existing repository behavior:

```ts
export function parseActiveExperts(value: unknown): ActiveExperts;
export function serializeActiveExperts(value: ActiveExperts): string;
```

Both functions must call the same current bounded normalizer. `ActiveExpertRepository.read/write` must reuse them. Add one focused test showing the exported serializer is byte-identical to the repository output. Do not run the whole active-expert suite yet; Task 10 covers it once.

- [ ] **Step 4: Implement the workflow service contracts**

```ts
export interface TeamWorkflowRuntime {
  readonly now: () => Date;
  readonly canonicalRoot: (root: string) => Promise<string>;
  readonly readCatalog: () => Promise<RuntimeCatalog>;
  readonly createRepository: (root: string) => WorkspaceRepository;
  readonly readActiveExperts: (root: string) => Promise<ActiveExperts>;
}

export class ExpertTeamWorkflowService {
  constructor(projectRoot: string, runtime?: TeamWorkflowRuntime);
  selectPreview(draftValue: unknown): Promise<SelectionPreview>;
  planPreview(inputValue: unknown): Promise<PlanPreview>;
  planApply(inputValue: unknown): Promise<AppliedPlan>;
}

export interface PlanPreviewInput {
  readonly draft: PlanDraft;
  readonly selectionFingerprint: `sha256:${string}`;
  readonly assignments: readonly AssignmentDraft[];
  readonly largeTeamDecision?: "accepted";
}

export interface PlanApplyInput extends PlanPreviewInput {
  readonly approvalToken: `sha256:${string}`;
}
```

Implementation sequence:

1. Every method reads current context and the same runtime catalog before calculating.
2. Generate the next same-day `REQ-YYYYMMDD-NNN`, `SPEC-...`, and `TASK-...` IDs by reading only existing artifact names below their fixed directories; reject unsafe, duplicate, or malformed names.
3. `selectPreview` returns proposed IDs/modes/reasons, blockers, selection fingerprint, and vocabulary mismatch details; it performs no write.
4. `planPreview` recomputes selection, requires the exact selection fingerprint, finalizes assignments, returns the user-visible preview and approval token, and performs no write.
5. `planApply` recomputes the full result again, requires no capability/reviewer blocker, requires `largeTeamDecision: "accepted"` only when the soft threshold is exceeded, and verifies the approval token.
6. Build Requirement `specified`, Spec `approved`, and Task `planned` YAML artifacts; create team revision 1 JSON and active-expert revision `current + 1` YAML.
7. Call one `WorkspaceRepository.commitMutation` containing all five artifact writes, next workspace state with the Task active, event type `plan-approved`, and bounded metadata `{ requirementId, specId, taskId, teamRevision, memberCount, teamFingerprint }`.
8. Never call `ActiveExpertRepository.write`; that would acquire a nested second lock and split the transaction.
9. Before committing, reject a pre-existing non-identical history path or artifact path. A retry after a completed commit observes the new workspace revision and fails rather than overwriting history.
10. Return parsed committed objects; do not include raw prompts, full catalog records, or complete expert instructions.

- [ ] **Step 5: Run one GREEN check**

Run: `npm test -- test/workflow/expert-team-service.test.ts test/experts/active.test.ts`

Expected: PASS; preview is read-only, apply advances exactly one workspace revision, and active serialization remains compatible.

- [ ] **Step 6: Commit the atomic workflow**

```bash
git add src/workflow/service.ts src/experts/active.ts test/workflow/expert-team-service.test.ts test/experts/active.test.ts test/fixtures/workflow-team-fixture.ts
git commit -m "feat: atomically approve plans with expert teams"
```

### Task 5: Add replan, retirement, and cross-session projection

**Files:**
- Create: `src/workflow/resume-context.ts`
- Create: `test/workflow/expert-team-replan.test.ts`
- Modify: `src/workflow/service.ts`
- Modify: `test/workflow/expert-team-service.test.ts`
- Modify: `test/fixtures/workflow-team-fixture.ts`

- [ ] **Step 1: Write the focused failing lifecycle tests**

```ts
// test/workflow/expert-team-replan.test.ts
import { describe, expect, test } from "vitest";
import { createAppliedWorkflowTeamFixture } from "../fixtures/workflow-team-fixture.js";

describe("expert-team replan and retirement", () => {
  test("previews a stable diff and writes a new immutable team revision", async () => {
    const fixture = await createAppliedWorkflowTeamFixture();
    const preview = await fixture.service.replanPreview(fixture.expandedDraft());
    expect(preview.diff.added.length).toBeGreaterThan(0);
    expect(preview.nextTeam.teamRevision).toBe(2);
    const applied = await fixture.service.replanApply({
      ...fixture.expandedDraft(),
      approvalToken: preview.approvalToken,
    });
    expect(applied.team.teamRevision).toBe(2);
    expect(await fixture.teamHistoryRevisions()).toEqual(["000001.json", "000002.json"]);
  });

  test("a fresh service restores the approved team and cancellation retires only this Task", async () => {
    const fixture = await createAppliedWorkflowTeamFixture();
    expect((await fixture.freshService().resumeContext()).team?.teamRevision).toBe(1);
    await fixture.service.retireTeam(fixture.taskId, fixture.taskRevision, "cancelled");
    expect((await fixture.freshService().resumeContext()).team).toBeNull();
    expect(await fixture.teamHistoryRevisions()).toEqual(["000001.json"]);
  });
});
```

- [ ] **Step 2: Run one RED check**

Run: `npm test -- test/workflow/expert-team-replan.test.ts`

Expected: FAIL because replan and retirement methods are missing.

- [ ] **Step 3: Implement replan and bounded resume context**

Add these methods:

```ts
replanPreview(inputValue: unknown): Promise<ReplanPreview>;
replanApply(inputValue: unknown): Promise<AppliedPlan>;
retireTeam(taskId: string, expectedTaskRevision: number, to: "completed" | "cancelled"): Promise<void>;
resumeContext(): Promise<WorkflowResumeContext>;
```

Requirements:

1. Replan reads the latest team history record and recomputes the complete minimum team from the complete new Plan; do not use append-only expansion for scope shrink.
2. It creates a deterministic `added/removed/changed/unchanged` diff and binds that diff to the approval token.
3. Replan apply atomically writes updated Task/Spec data, the next immutable team revision, active projection, state revision, and `plan-replanned` audit event.
4. Retirement is legal only for the active matching Task, removes only that Task from each active expert, deletes experts with no remaining Task IDs from the active projection, preserves team history, and commits `expert-team-retired` with a state transition to the requested terminal status.
5. `resumeContext` returns only bounded Requirement/Spec/Task IDs/titles/status/revisions, team IDs/names/modes/reasons, team fingerprint/revision, blockers, and recovery status. It never returns expert instructions, raw prompts, source contents, environment variables, terminal output, or secrets.
6. If any referenced artifact or fingerprint is invalid, return safe mode and do not silently omit the broken team.
7. The public user flow remains unable to reach completed until Knowledge support exists; the completed branch here is a Core integration seam, while current executable cleanup uses cancellation.

- [ ] **Step 4: Run the single midpoint type gate and focused GREEN tests**

Run: `npm test -- test/workflow/expert-team-replan.test.ts test/workflow/expert-team-service.test.ts`

Expected: PASS.

Run: `npm run check`

Expected: PASS. This is the only pre-final full TypeScript check.

- [ ] **Step 5: Commit lifecycle behavior**

```bash
git add src/workflow/service.ts src/workflow/resume-context.ts test/workflow/expert-team-replan.test.ts test/workflow/expert-team-service.test.ts test/fixtures/workflow-team-fixture.ts
git commit -m "feat: replan and restore expert teams"
```

### Task 6: Reconcile approved teams into real Codex project Agents

**Files:**
- Create: `src/adapters/codex/expert-team.ts`
- Create: `test/codex/expert-team.test.ts`
- Modify: `src/adapters/codex/project-agent.ts`
- Modify: `test/codex/project-agent.test.ts`

- [ ] **Step 1: Write the focused failing adapter tests**

```ts
// test/codex/expert-team.test.ts
import { describe, expect, test } from "vitest";
import { inspectCodexExpertTeam, reconcileCodexExpertTeam } from "../../src/adapters/codex/expert-team.js";
import { createAppliedWorkflowTeamFixture } from "../fixtures/workflow-team-fixture.js";

describe("Codex expert-team adapter", () => {
  test("renders every approved member and reports ready after reconciliation", async () => {
    const fixture = await createAppliedWorkflowTeamFixture();
    expect((await inspectCodexExpertTeam(fixture.root)).status).toBe("pending");
    const result = await reconcileCodexExpertTeam(fixture.root, fixture.catalog);
    expect(result.files.length).toBe(fixture.team.members.length);
    expect((await inspectCodexExpertTeam(fixture.root)).status).toBe("ready");
  });

  test("never overwrites a user-owned agent and returns inspection-required on managed drift", async () => {
    const fixture = await createAppliedWorkflowTeamFixture();
    await fixture.writeUserAgent("keep.toml", "user content\n");
    await reconcileCodexExpertTeam(fixture.root, fixture.catalog);
    expect(await fixture.readUserAgent("keep.toml")).toBe("user content\n");
    await fixture.modifyFirstManagedAgent();
    await expect(reconcileCodexExpertTeam(fixture.root, fixture.catalog)).rejects.toMatchObject({
      code: "INSPECTION_REQUIRED",
    });
  });
});
```

- [ ] **Step 2: Run one RED check**

Run: `npm test -- test/codex/expert-team.test.ts`

Expected: FAIL because the adapter module does not exist.

- [ ] **Step 3: Add a read-only project-agent readiness API**

Export from `src/adapters/codex/project-agent.ts`:

```ts
export type ProjectAgentReadiness =
  | { readonly status: "ready"; readonly files: readonly string[] }
  | { readonly status: "pending"; readonly reason: string }
  | { readonly status: "inspection-required"; readonly reason: string };

export async function inspectProjectAgents(
  projectRoot: string,
  renderedValue: readonly RenderedProjectAgent[],
  runtime?: ProjectAgentRuntime,
): Promise<ProjectAgentReadiness>;
```

It must reuse the same root binding, manifest parser, filename collision checks, ownership hashes, active-expert comparison, and no-follow reads as synchronization, but perform no mkdir, lock, backup, recovery, rename, delete, or write. Missing manifest/files are pending; malformed boundaries, unowned collisions, or modified managed files are inspection-required.

- [ ] **Step 4: Implement the platform adapter**

`src/adapters/codex/expert-team.ts` must:

1. Read the current approved team through `ExpertTeamWorkflowService.resumeContext()`.
2. Resolve every team member ID from the supplied validated runtime catalog; reject missing or fingerprint-mismatched experts.
3. Convert each member into the existing `ProjectAgentAssignment` with one Task ID, fixed mode, joined deterministic reason, scope, deliverables, and quality gates.
4. Render through `renderProjectAgent`; never construct TOML directly.
5. Reconcile through `syncProjectAgents`; never edit `.codex/agents` directly.
6. Inspect through `inspectProjectAgents` and return `none` when there is no active team.
7. Keep reviewer/analysis agents read-only and implementers workspace-write using the existing renderer policy.

- [ ] **Step 5: Run one GREEN check**

Run: `npm test -- test/codex/expert-team.test.ts test/codex/project-agent.test.ts`

Expected: PASS; approved members become real managed project Agents, user files remain unchanged, and drift closes safely.

- [ ] **Step 6: Commit the Codex projection**

```bash
git add src/adapters/codex/expert-team.ts src/adapters/codex/project-agent.ts test/codex/expert-team.test.ts test/codex/project-agent.test.ts
git commit -m "feat: reconcile approved Codex expert teams"
```

### Task 7: Expose the structured CLI without shell interpolation

**Files:**
- Create: `src/cli/json-input.ts`
- Create: `test/cli/json-input.test.ts`
- Modify: `src/cli/main.ts`
- Modify: `test/cli/main.test.ts`

- [ ] **Step 1: Write the focused failing CLI tests**

```ts
// test/cli/json-input.test.ts
import { describe, expect, test } from "vitest";
import { readBoundedJsonInput } from "../../src/cli/json-input.js";

function source(text: string) {
  return {
    chunks: (async function* () {
      yield Buffer.from(text, "utf8");
    })(),
  };
}

describe("bounded JSON stdin", () => {
  test("accepts one UTF-8 JSON document and rejects trailing or oversized data", async () => {
    await expect(readBoundedJsonInput(source('{"schemaVersion":1}'))).resolves.toEqual({ schemaVersion: 1 });
    await expect(readBoundedJsonInput(source('{}{}'))).rejects.toThrow("JSON");
    await expect(readBoundedJsonInput(source("x".repeat(65_537)))).rejects.toThrow("65536");
  });
});
```

Extend `test/cli/main.test.ts` with a fresh-process scenario that passes JSON through execa's `input` option, never through a shell command string:

```ts
const selection = await runCli(["team-select-preview", "--root", root], PROJECT_ROOT, {
  input: `${JSON.stringify(planDraft)}\n`,
});
const plan = await runCli(["plan-preview", "--root", root], PROJECT_ROOT, {
  input: `${JSON.stringify({ draft: planDraft, selectionFingerprint, assignments })}\n`,
});
const applied = await runCli([
  "plan-apply", "--root", root, "--approval-token", approvalToken,
], PROJECT_ROOT, { input: samePlanInput });
expect(expectJsonSuccess(applied)).toMatchObject({ task: { status: "planned" } });
```

- [ ] **Step 2: Run one RED check**

Run: `npm test -- test/cli/json-input.test.ts test/cli/main.test.ts`

Expected: FAIL because the input reader and commands are missing.

- [ ] **Step 3: Implement bounded JSON stdin**

```ts
export const CLI_JSON_INPUT_MAX_BYTES = 65_536;

export interface JsonInputSource {
  readonly chunks: AsyncIterable<Uint8Array | string>;
}

export async function readBoundedJsonInput(source: JsonInputSource): Promise<unknown>;
```

Count bytes before concatenation, require valid UTF-8 without BOM/NUL, allow surrounding ASCII whitespace, parse exactly one JSON value, and reject primitives. The default CLI runtime wraps `process.stdin` as the chunk source. Tests inject chunks directly.

- [ ] **Step 4: Add internal commands and stable outputs**

Extend the flat command union and specs with:

```text
team-select-preview --root PROJECT_ROOT                                  # JSON stdin: PlanDraft
plan-preview        --root PROJECT_ROOT                                  # JSON stdin: draft + selection fingerprint + assignments
plan-apply          --root PROJECT_ROOT --approval-token APPROVAL_TOKEN  # same JSON stdin as preview
replan-preview      --root PROJECT_ROOT                                  # JSON stdin: replacement Plan draft + assignments
replan-apply        --root PROJECT_ROOT --approval-token APPROVAL_TOKEN  # same JSON stdin as preview
experts-reconcile   --root PROJECT_ROOT                                  # no stdin payload
```

Also change:

- `context --json` to include bounded workflow team summary and `platformSyncStatus`.
- `transition --to implementing` to inspect the current approved Codex team first and reject any status other than ready.
- `transition --to cancelled` to call `ExpertTeamWorkflowService.retireTeam` for the active approved Task, so cancellation retires the active projection and preserves immutable team history in the same Core mutation.
- `plan-apply` / `replan-apply` to run reconciliation after Core commit. If reconciliation fails, preserve Core Plan and return the existing inspection/recovery error; never transition to implementing.
- CLI runtime to inject catalog path/loader, workflow service, reconciliation, inspection, and stdin source so unit tests stay offline and deterministic.
- Usage/error messages to remain single-line and omit UUIDs, stack traces, full input, expert instructions, and machine-specific temporary paths except the existing explicit inspection path contract.

Resolve the runtime catalog without requiring a global installation: packaged CLI code first reads `../catalog/experts.json` relative to `import.meta.url`; the repository-built CLI falls back to `../../../catalog/normalized/experts.json`. Tests may inject an explicit path. All variants are local filesystem reads and must pass through the same locked catalog loader.

- [ ] **Step 5: Run one GREEN check**

Run: `npm test -- test/cli/json-input.test.ts test/cli/main.test.ts`

Expected: PASS; a fresh process previews, applies, reconciles, reports ready context, and rejects implementation when readiness is pending.

- [ ] **Step 6: Commit the CLI surface**

```bash
git add src/cli/json-input.ts src/cli/main.ts test/cli/json-input.test.ts test/cli/main.test.ts
git commit -m "feat: expose automatic expert team workflow"
```

### Task 8: Make Router and Skills trigger the team flow automatically

**Files:**
- Modify: `plugins/ezagent-spec/skills/ezagent-router/SKILL.md`
- Modify: `plugins/ezagent-spec/skills/ezagent-spec/SKILL.md`
- Modify: `plugins/ezagent-spec/skills/ezagent-implement/SKILL.md`
- Modify: `plugins/ezagent-spec/skills/ezagent-review/SKILL.md`
- Modify: `src/adapters/codex/agents-md.ts`
- Modify: `test/codex/skill-contract.test.ts`
- Modify: `test/codex/activation-contract.test.ts`
- Modify: `test/codex/agents-md.test.ts`

- [ ] **Step 1: Write one failing activation contract batch**

Add exact assertions:

```ts
expect(router.body).toContain("team-select-preview");
expect(router.body).toContain("不得直接提交专家 ID");
expect(spec.body).toContain("plan-preview");
expect(spec.body).toContain("与 Spec/Plan 一起确认");
expect(implement.body).toContain("platformSyncStatus");
expect(implement.body).toContain("ready");
expect(review.body).toContain("不得审查自己参与实现的 Task");
expect(managedAgentsBlock).toContain("先恢复并核对已批准专家团队");
```

The activation test must assert command ordering: `context` before classification, team selection only after structured Plan data exists, `plan-preview` before `plan-apply`, and `experts-reconcile` before any implementing transition when status is pending.

- [ ] **Step 2: Run one RED check**

Run: `npm test -- test/codex/skill-contract.test.ts test/codex/activation-contract.test.ts test/codex/agents-md.test.ts`

Expected: FAIL because current Skills describe policy but do not invoke the new production commands.

- [ ] **Step 3: Update the automatic workflow instructions**

Router contract:

1. Run `context` first.
2. Do not select a team for consult-only questions.
3. For behavior-changing work, collect structured Requirement/Spec/Task fields and controlled capability/domain/project-signal tokens.
4. Call `team-select-preview`; never choose final expert IDs itself.
5. Create assignments only for returned members, preserving modes.
6. Call `plan-preview` and show one combined Plan/team preview.
7. After user approval, call `plan-apply` with the bound token.
8. If capability/reviewer blockers or large-team review appear, stop and ask the specific question.

Spec Skill must own Plan/team preview and approval. Implement Skill must require active Task `planned`, no blockers, and `platformSyncStatus: ready`. Review Skill must use only members with mode `review`, remain read-only, and reject self-review. All Skills must pass JSON through process stdin rather than constructing a shell string or editing `.ezagent/**`.

Managed `AGENTS.md` must require the Router to restore the approved team on every relevant turn and reconcile pending derived Agents before implementation. It must not claim a lifecycle Hook.

- [ ] **Step 4: Run one GREEN check**

Run: `npm test -- test/codex/skill-contract.test.ts test/codex/activation-contract.test.ts test/codex/agents-md.test.ts`

Expected: PASS; the documentation contract points to real commands and preserves automatic activation.

- [ ] **Step 5: Commit automatic routing**

```bash
git add plugins/ezagent-spec/skills src/adapters/codex/agents-md.ts test/codex/skill-contract.test.ts test/codex/activation-contract.test.ts test/codex/agents-md.test.ts
git commit -m "feat: route plans through automatic expert teams"
```

### Task 9: Prove the fresh-process vertical slice and update public truth

**Files:**
- Create: `test/e2e/automatic-expert-team.test.ts`
- Modify: `test/codex/offline-smoke.test.ts`
- Modify: `test/codex/plugin-package.test.ts`
- Modify: `README.md`
- Modify: `docs/superpowers/plans/2026-08-20-ezagent-spec-mvp-roadmap.md`
- Modify: `docs/superpowers/specs/2026-08-20-ezagent-spec-product-design.md`

- [ ] **Step 1: Write the failing E2E and public contract**

The E2E must spawn the built CLI in a new temporary project and perform:

```ts
test("selects, approves, materializes, restores, replans, and retires a real expert team", async () => {
  const root = await initializedTemporaryProject();
  const draft = standardProfileValidationPlan();
  const selection = await cliJson(root, "team-select-preview", draft);
  expect(selection.members.some((member) => member.mode === "implement")).toBe(true);
  expect(selection.members.some((member) => member.mode === "review")).toBe(true);

  const previewInput = assignmentsFor(selection, draft);
  const preview = await cliJson(root, "plan-preview", previewInput);
  const applied = await cliJson(root, "plan-apply", previewInput, preview.approvalToken);
  expect(applied.platformSyncStatus).toBe("ready");

  const restarted = await cliContextFromFreshProcess(root);
  expect(restarted.team.teamFingerprint).toBe(applied.team.teamFingerprint);

  const replan = await previewAndApplyReplan(root, addAuditLogging(draft));
  expect(replan.diff.added.length + replan.diff.changed.length).toBeGreaterThan(0);

  await cliTransition(root, "cancelled", replan.task.revision);
  expect((await cliContextFromFreshProcess(root)).team).toBeNull();
  expect(await historicalTeamFiles(root)).toEqual(["000001.json", "000002.json"]);
});
```

It must additionally prove: no runtime network/Git-write environment, no user Agent overwrite, no `.ezagent/` in repository root, repeatable context bytes after restart, and a high-risk draft remains blocked before implementing without a valid action authorization.

README contract assertions must require visible examples of the selected team, automatic Plan approval behavior, replan diff, and the honest statement that Knowledge still blocks completed.

- [ ] **Step 2: Run one RED check**

Run: `npm test -- test/e2e/automatic-expert-team.test.ts test/codex/offline-smoke.test.ts`

Expected: FAIL until E2E helpers, packaged commands, and public documentation are updated.

- [ ] **Step 3: Complete E2E, package, and documentation integration**

1. Add the built CLI to the E2E `beforeAll` once; do not rebuild inside each test.
2. Extend offline smoke to run `team-select-preview`, `plan-preview`, `plan-apply`, fresh-process `context`, and a byte-identical reconciliation retry using only the copied plugin.
3. Keep the plugin file allowlist unchanged unless a genuinely new runtime file is added outside the bundle; TypeScript modules should remain inside `dist/ezagent-cli.mjs`.
4. Update package import allowlist only if a new Node built-in is truly imported; do not add network, child-process, Git, HTTP, socket, or telemetry imports.
5. Rewrite README capability text from “components exist” to a reproducible automatic-team flow and include an example Plan/team preview.
6. Update the roadmap milestone to distinguish automatic expert team completion from still-incomplete Knowledge/high-risk authorization issuance.
7. Keep Local-only, no automatic install, no automatic Git, Trellis independence, MIT, and third-party notices unchanged.

- [ ] **Step 4: Run one GREEN E2E batch**

Run: `npm test -- test/e2e/automatic-expert-team.test.ts test/codex/offline-smoke.test.ts test/codex/plugin-package.test.ts`

Expected: PASS; the copied plugin selects and materializes a team across a fresh process with no network or Git writes.

- [ ] **Step 5: Commit the user-visible closure**

```bash
git add test/e2e test/codex/offline-smoke.test.ts test/codex/plugin-package.test.ts README.md docs/superpowers/plans/2026-08-20-ezagent-spec-mvp-roadmap.md docs/superpowers/specs/2026-08-20-ezagent-spec-product-design.md
git commit -m "feat: close automatic expert team workflow"
```

### Task 10: Run one final release gate and prepare integration

**Files:**
- Modify only files required by genuine failures found in this gate.

- [ ] **Step 1: Run the official plugin validator once**

Run:

```bash
/opt/miniconda3/envs/zjf_env/bin/python $HOME/.codex/skills/.system/plugin-creator/scripts/validate_plugin.py plugins/ezagent-spec
```

Expected: `Plugin validation passed`.

- [ ] **Step 2: Run the plugin release gate once**

Run: `npm run plugin:verify`

Expected: catalog reports 265 experts; deterministic package check and all Codex tests pass.

- [ ] **Step 3: Run the complete repository gate once**

Run: `npm run verify`

Expected: TypeScript check, all tests, and build pass with zero failures.

- [ ] **Step 4: Run the release safety checks once**

Run: `npm audit --audit-level=high`

Expected: zero high or critical vulnerabilities.

Run: `git diff --check`

Expected: no output.

Run the existing high-confidence secret and personal-path scans. Treat the three literal private-key header examples in the locked security-expert catalog as reviewed documentation patterns only; fail on a private-key body/end marker, GitHub/OpenAI/AWS token, machine username, or any new match outside the locked catalog artifacts.

- [ ] **Step 5: Commit only if the final gate required a repair**

If no repair was needed, do not create an empty verification commit. If a repair is required, stop the final gate, add a concrete repair step naming the exact source and test files, run only the failed focused command, and commit that bounded repair as `fix: close expert team release gate` before resuming the remaining final checks.

- [ ] **Step 6: Report the integration-ready state**

Report:

- exact HEAD SHA and clean `git status --short --branch`;
- focused E2E count and complete test count;
- plugin validator, dependency audit, deterministic build, and Local-only scan results;
- that no push, npm publish, marketplace-directory submission, or repository setting change occurred unless the user separately authorized it.

If push is authorized, push `main` once, wait for the single resulting macOS/Windows CI run, and report its URL and both job conclusions. Do not trigger redundant reruns when both jobs are green.
