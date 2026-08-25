# EZagent v2 On-Demand Specialist Orchestration Implementation Plan

**Goal:** Restore Agency Agents as a real, deterministic, on-demand execution capability in the v2 Work Harness without returning to mandatory expert teams for every Work Item.

**Architecture:** Every new persisted v2 Work Contract carries an explicit Specialist Assessment. The Agent submits only bounded capability needs; Core selects experts from the locked local catalog, creates a platform-neutral `SpecialistPlanV2`, and binds that plan into the existing Work preview/apply approval token. Apply atomically persists the Work artifacts, Specialist Plan, and active-expert projection. The Codex adapter materializes only approved specialists as project Agents. Execution uses Slice-bound Delegation Contracts and immutable receipts; review and completion fail closed when required delegations are missing, stale, or not independent.

**Tech Stack:** TypeScript 7, Node.js 22+, Zod, YAML, Vitest, esbuild, Codex Skills, local packaged expert catalog.

---

## Product decisions

1. `Consult` and `Quick` never create persistent Specialists or project Agents.
2. Every new persisted v2 Work Contract must explicitly record either `not-needed` or `required`; silence is not treated as a valid assessment.
3. The Agent may submit capability, domain, project-signal, purpose, and isolation requirements, but never an expert ID.
4. Core remains the only selector of expert IDs and uses the locked local catalog and deterministic fingerprints.
5. Initial Specialist selection is shown inside the existing combined Work preview and receives no extra routine confirmation.
6. Once an approved Specialist delegation exists for a Slice, the Host must actually delegate it; the coordinator may not silently perform the delegated work itself.
7. `mixed` review means both an independent Agent review and an explicit human conclusion.
8. Specialist changes after Apply require a dedicated preview/apply diff; experts cannot be added or replaced silently.
9. The first release keeps one active Slice at a time. Multiple Specialists may work inside that Slice, but concurrent Slice state transitions are deferred.
10. Existing v1 Plan/team behavior and artifacts remain readable, resumable, and completable without migration.

## Non-goals

- Do not restore a mandatory team for Brief or Standard Mode.
- Do not inject the complete 265-expert catalog into model context.
- Do not let the model select arbitrary expert IDs or edit `.ezagent/**`.
- Do not add network access, telemetry, automatic installation, Git writes, publishing, or uploads.
- Do not add concurrent `executing` state for several Slices in this release.
- Do not redesign the expert catalog taxonomy or importer.
- Do not implement a non-Codex platform adapter in this release.

## Dependency graph

```text
Product semantics and compatibility contract
    -> SpecialistPlanV2 schema and canonical serialization
        -> deterministic per-Slice selection and combined approval token
            -> atomic persistence and resume context
                -> Codex project-Agent materialization and readiness gate
                    -> delegation lifecycle and receipts
                        -> Skill-driven execution and independent review
                            -> Specialist replan, retirement, and end-to-end host validation
```

## Target data flow

```text
Shared Design Concept
  -> SpecialistAssessmentDraft
  -> work-preview
      -> validate Work Contract
      -> select experts from locked catalog
      -> create SpecialistPlanV2
      -> bind Work artifacts + Specialist Plan + catalog fingerprint to one token
  -> user approves combined preview
  -> work-apply
      -> atomically write Brief / Work Spec / Work Item / Specialist Plan / active.yaml
  -> Codex reconcile
      -> materialize only approved project Agents
  -> work-start
      -> expose active Slice delegations
  -> delegation-start / Host Agent invocation / delegation-complete
  -> Evidence review + delegation coverage
  -> Slice accepted
  -> Work complete
      -> retire active experts and reconcile generated Agents
```

## Proposed contracts

The exact implementation may refine names, but it must preserve these semantics:

```ts
interface SpecialistAssessmentDraftV2 {
  readonly decision: "not-needed" | "required";
  readonly reasons: readonly string[];
  readonly needs: readonly CapabilityNeedDraftV2[];
}

interface CapabilityNeedDraftV2 {
  readonly id: string;
  readonly sliceId: string;
  readonly purpose: "analysis" | "implementation" | "review";
  readonly capabilities: readonly string[];
  readonly domains: readonly string[];
  readonly projectSignals: readonly string[];
  readonly isolationReason:
    | "domain-judgment"
    | "context-isolation"
    | "parallel-work"
    | "independent-review";
}

interface SpecialistDelegationV2 {
  readonly id: string;
  readonly expertId: string;
  readonly workItemId: string;
  readonly workSpecId: string;
  readonly workSpecRevision: number;
  readonly sliceId: string;
  readonly mode: "analysis" | "implement" | "review";
  readonly reasons: readonly string[];
  readonly scope: readonly string[];
  readonly deliverableInterfaceIds: readonly string[];
  readonly criterionIds: readonly string[];
  readonly evidenceRequirements: readonly string[];
}

interface SpecialistPlanV2 {
  readonly schemaVersion: 2;
  readonly revision: number;
  readonly workItemId: string;
  readonly workSpecId: string;
  readonly workSpecRevision: number;
  readonly catalogFingerprint: `sha256:${string}`;
  readonly selectionFingerprint: `sha256:${string}`;
  readonly planFingerprint: `sha256:${string}`;
  readonly assessment: SpecialistAssessmentDraftV2;
  readonly delegations: readonly SpecialistDelegationV2[];
  readonly uncoveredCapabilities: readonly string[];
  readonly blockers: readonly string[];
}
```

Persist immutable records at:

```text
.ezagent/experts/plans/<TASK-ID>/<revision>.json
.ezagent/experts/receipts/<TASK-ID>/<delegation-id>/<sequence>.json
```

Continue using `.ezagent/experts/active.yaml` only as the current active-expert projection. Do not overload legacy `experts/teams/**` records with a second schema.

---

## Phase 1: Contract and deterministic planning

### Task 1: Record the v2 Specialist design contract

**Description:** Add a superseding design document and align product terminology before changing schemas. The document must distinguish capability assessment, selected Specialist, project Agent, Delegation Contract, receipt, and independent reviewer.

**Acceptance criteria:**

- [ ] The new design states that persistent v2 work must explicitly decide `not-needed` or `required`.
- [ ] It states that Core selects IDs and that the Host performs the actual delegation.
- [ ] It defines compatibility, replan, retirement, and the one-active-Slice boundary.

**Verification:**

- [ ] `rg -n "not-needed|SpecialistPlanV2|Delegation|one active Slice" docs/superpowers/specs UBIQUITOUS_LANGUAGE.md README.md`
- [ ] Manual review confirms that the historical 2026-08-24 v2 design remains historical rather than being silently rewritten.

**Dependencies:** None.

**Files likely touched:**

- Create: `docs/superpowers/specs/2026-08-25-v2-on-demand-specialist-orchestration-design.md`
- Modify: `UBIQUITOUS_LANGUAGE.md`
- Modify: `README.md`

**Estimated scope:** Medium, 3 files.

### Task 2: Define and canonically serialize SpecialistPlanV2

**Description:** Implement strict bounded schemas, normalization, fingerprints, and immutable history paths for capability needs, selected delegations, and the complete Specialist Plan. Keep the plan platform-neutral and independent from legacy `ExpertTeamPlan`.

**Acceptance criteria:**

- [ ] `not-needed` requires non-empty reasons and no needs or delegations.
- [ ] `required` requires at least one valid Slice-bound capability need and rejects user-supplied expert IDs in the assessment.
- [ ] Serialization is canonical, fingerprints detect drift, and history paths cannot escape `.ezagent/experts/plans`.

**Verification:**

- [ ] `npm test -- test/workflow/specialist-plan.test.ts`
- [ ] `npm run check`

**Dependencies:** Task 1.

**Files likely touched:**

- Create: `src/workflow/specialist-plan.ts`
- Create: `test/workflow/specialist-plan.test.ts`
- Create: `test/fixtures/specialist-plan-fixture.ts`

**Estimated scope:** Medium, 3 files.

### Task 3: Require Specialist Assessment in new v2 Work drafts

**Description:** Extend the new-work draft contract with a required Specialist Assessment while leaving persisted Brief, Work Spec, and Work Item v2 schemas backward compatible. Existing active v2 records have no draft to reparse and must continue to resume.

**Acceptance criteria:**

- [ ] New `work-preview` drafts without an assessment fail validation.
- [ ] `not-needed` is accepted for a simple Brief and produces no expert selection request.
- [ ] `independent-agent` and `mixed` review require at least one review capability need using `independent-review` isolation.

**Verification:**

- [ ] `npm test -- test/workflow/work-contract.test.ts`
- [ ] `npm test -- test/workflow/work-artifacts.test.ts`

**Dependencies:** Task 2.

**Files likely touched:**

- Modify: `src/workflow/work-contract.ts`
- Modify: `src/workflow/work-artifacts.ts`
- Modify: `test/workflow/work-contract.test.ts`
- Modify: `test/fixtures/work-contract-fixture.ts`

**Estimated scope:** Medium, 4 files.

### Checkpoint A: Contract foundation

- [ ] Tasks 1-3 focused tests pass.
- [ ] `npm run check` passes.
- [ ] A simple Brief can explicitly select `not-needed` without generating a plan with members.
- [ ] An old v2 Work Item fixture still parses and resumes.
- [ ] Review the public contract before adding workflow mutations.

---

## Phase 2: Selection, approval, and persistence

### Task 4: Select Specialists deterministically per Slice

**Description:** Build a v2 proposal function that resolves each capability need against the locked catalog. Reuse `selectExperts` and extract reusable reviewer logic from the legacy team path where appropriate; do not duplicate scoring rules or introduce a fixed team size.

**Acceptance criteria:**

- [ ] The same catalog and normalized assessment always produce the same selected experts and fingerprint.
- [ ] Implementation and review purpose filter candidates appropriately, and a reviewer cannot implement the same Slice.
- [ ] Uncovered required capabilities and missing independent reviewers become explicit blockers rather than silent fallback.

**Verification:**

- [ ] `npm test -- test/workflow/specialist-selection.test.ts`
- [ ] `npm test -- test/experts/selector.test.ts test/workflow/expert-team.test.ts`

**Dependencies:** Task 3.

**Files likely touched:**

- Create: `src/workflow/specialist-selection.ts`
- Create: `test/workflow/specialist-selection.test.ts`
- Modify: `src/workflow/expert-team.ts`
- Modify: `test/workflow/expert-team.test.ts`

**Estimated scope:** Medium, 4 files.

### Task 5: Bind Specialist Plan into work-preview and work-apply

**Description:** Extend preparation so `work-preview` loads the catalog, generates the Specialist Plan, and returns it with the Work artifacts. The approval token must bind the root, workspace revision, Work artifacts, Specialist Plan, and catalog fingerprint. Apply must recompute rather than trusting preview output.

**Acceptance criteria:**

- [ ] Preview shows selected names/IDs, reasons, Slice assignments, uncovered capabilities, and blockers.
- [ ] Any change to the Work draft, assessment, workspace revision, catalog, assignment, or plan fingerprint invalidates the token.
- [ ] Apply refuses a blocked plan and never accepts caller-supplied selected members.

**Verification:**

- [ ] `npm test -- test/workflow/work-harness-service.test.ts -t "Specialist"`
- [ ] `npm test -- test/cli/main.test.ts -t "work-preview|work-apply"`

**Dependencies:** Task 4.

**Files likely touched:**

- Modify: `src/workflow/service.ts`
- Modify: `src/workflow/specialist-plan.ts`
- Modify: `test/workflow/work-harness-service.test.ts`
- Modify: `test/cli/main.test.ts`

**Estimated scope:** Medium, 4 files.

### Task 6: Persist and resume the approved Specialist Plan atomically

**Description:** Commit the plan record and updated `active.yaml` in the same workspace mutation as Brief, Work Spec, and Work Item. Extend resume context with v2 Specialist summaries and current-Slice delegations while preserving the legacy v1 `team` field.

**Acceptance criteria:**

- [ ] Apply writes either an explicit empty plan or an approved selected plan; it never leaves a new v2 task unassessed.
- [ ] Failure during mutation recovery restores or rolls back Work artifacts, plan history, active projection, and audit consistently.
- [ ] Existing v2 active work without a plan resumes as `legacy-unassessed`; existing v1 work still returns its team unchanged.

**Verification:**

- [ ] `npm test -- test/workflow/work-harness-service.test.ts -t "resume|Specialist"`
- [ ] `npm test -- test/workspace/recovery.test.ts -t "expert|specialist|pending mutation"`

**Dependencies:** Task 5.

**Files likely touched:**

- Modify: `src/workflow/service.ts`
- Modify: `src/workflow/resume-context.ts`
- Modify: `src/experts/active.ts`
- Modify: `test/workspace/recovery.test.ts`
- Modify: `test/workflow/work-harness-service.test.ts`

**Estimated scope:** Medium, 5 files.

### Checkpoint B: Platform-neutral vertical slice

- [ ] Tasks 4-6 focused tests pass.
- [ ] `npm run test:workflow` passes.
- [ ] `npm run check` passes.
- [ ] A fresh v2 Standard preview selects deterministic Specialists and Apply resumes the same plan after process restart.
- [ ] A fresh simple Brief persists an explicit no-Specialist decision.

---

## Phase 3: Codex materialization and execution proof

### Task 7: Materialize approved v2 Specialists as Codex project Agents

**Description:** Generalize the Codex expert adapter so it can render either a legacy v1 team or a v2 Specialist Plan. Extend project-Agent assignments with Work Spec, Slice, Delegation, and Evidence identifiers while accepting old generated snapshots during recovery.

**Acceptance criteria:**

- [ ] Only experts referenced by the active approved plan are materialized.
- [ ] Generated instructions contain Task, Work Spec, Slice, delegation, scope, deliverables, Evidence requirements, and the prohibition on state mutation.
- [ ] Existing user-owned Agent files remain untouched, and drift or ambiguous managed files cause `inspection-required`.

**Verification:**

- [ ] `npm test -- test/codex/project-agent.test.ts`
- [ ] `npm test -- test/codex/expert-team.test.ts`

**Dependencies:** Task 6.

**Files likely touched:**

- Modify: `src/adapters/codex/project-agent-render.ts`
- Modify: `src/adapters/codex/expert-team.ts`
- Modify: `test/codex/project-agent.test.ts`
- Modify: `test/codex/expert-team.test.ts`

**Estimated scope:** Medium, 4 files.

### Task 8: Reconcile v2 Specialists through CLI and gate work-start

**Description:** Reconcile generated Agents after v2 Apply and expose platform readiness in `context`. Before starting a Slice with delegations, inspect the materialized Agents and fail closed unless every required Agent matches the approved plan.

**Acceptance criteria:**

- [ ] `work-apply` returns the Specialist Plan and `platformSyncStatus` after reconciliation.
- [ ] `context` reports v1 team or v2 Specialists and the correct platform readiness without conflating the schemas.
- [ ] `work-start` rejects delegated Slices when project Agents are missing, stale, or require inspection; no-Specialist Slices remain unaffected.

**Verification:**

- [ ] `npm test -- test/cli/main.test.ts -t "Specialist|platformSyncStatus|work-start"`
- [ ] `npm test -- test/codex/offline-smoke.test.ts`

**Dependencies:** Task 7.

**Files likely touched:**

- Modify: `src/cli/main.ts`
- Modify: `src/workflow/service.ts`
- Modify: `test/cli/main.test.ts`
- Modify: `test/codex/offline-smoke.test.ts`

**Estimated scope:** Medium, 4 files.

### Task 9: Persist bounded Delegation receipts

**Description:** Add immutable start and completion receipts bound to the selected plan fingerprint. Receipts record only identifiers, bounded summaries, result hashes, evidence pointers, status, and timestamps; they never store full prompts, chat, or full expert instructions.

**Acceptance criteria:**

- [ ] `delegation-start` only accepts an approved delegation for the active Slice and returns its immutable contract.
- [ ] `delegation-complete` rejects mismatched experts, stale plan fingerprints, unsupported Slice state, duplicate completion, and sensitive or oversized content.
- [ ] Review reports separate criterion Evidence coverage and required Delegation coverage; a missing required completion keeps the Slice unaccepted.

**Verification:**

- [ ] `npm test -- test/workflow/delegation-receipt.test.ts`
- [ ] `npm test -- test/workflow/work-harness-service.test.ts -t "delegation"`
- [ ] `npm test -- test/cli/main.test.ts -t "delegation"`

**Dependencies:** Task 8.

**Files likely touched:**

- Create: `src/workflow/delegation-receipt.ts`
- Create: `test/workflow/delegation-receipt.test.ts`
- Modify: `src/workflow/service.ts`
- Modify: `src/cli/main.ts`
- Modify: `test/workflow/work-harness-service.test.ts`

**Estimated scope:** Medium, 5 files.

### Checkpoint C: Real materialization boundary

- [ ] Tasks 7-9 focused tests pass.
- [ ] `npm run test:codex` passes.
- [ ] `npm run test:workflow` passes.
- [ ] `npm run check` passes.
- [ ] A delegated Slice cannot start without ready project Agents and cannot pass review without matching completion receipts.

---

## Phase 4: Skill behavior, independent review, and lifecycle

### Task 10: Make Router and Spec produce explicit assessments

**Description:** Update activation and planning instructions so persisted v2 work always performs capability assessment after the Shared Design Concept. The Skill must explain a no-Specialist decision or submit bounded needs; it must never choose IDs or create a team for appearance.

**Acceptance criteria:**

- [ ] Brief/Standard/Controlled previews always include an assessment.
- [ ] Simple requests produce a reasoned `not-needed` decision.
- [ ] Domain judgment, context isolation, independent work, or independent review can produce bounded needs without fixed roles or counts.

**Verification:**

- [ ] `npm test -- test/codex/skill-contract.test.ts -t "Specialist|assessment"`
- [ ] `npm test -- test/codex/agents-md.test.ts test/codex/activation-contract.test.ts`

**Dependencies:** Task 9.

**Files likely touched:**

- Modify: `plugins/ezagent-spec/skills/ezagent-router/SKILL.md`
- Modify: `plugins/ezagent-spec/skills/ezagent-spec/SKILL.md`
- Modify: `src/adapters/codex/agents-md.ts`
- Modify: `test/codex/skill-contract.test.ts`
- Modify: `test/codex/agents-md.test.ts`

**Estimated scope:** Medium, 5 files.

### Task 11: Make Execute and Review perform approved delegations

**Description:** Update execution instructions to read active Slice delegations, call the matching project Agents, and submit bounded receipts. Independent review must use an approved review-mode expert who did not implement the Slice; `mixed` additionally requires the existing human-approval Evidence.

**Acceptance criteria:**

- [ ] The coordinator cannot silently replace an approved delegation with self-execution.
- [ ] Delegated messages contain only the approved IDs, scope, inputs, deliverables, and Evidence requirements.
- [ ] Reviewer failure returns the Slice to `revise`; the implementer cannot approve its own output.

**Verification:**

- [ ] `npm test -- test/codex/skill-contract.test.ts -t "delegation|independent"`
- [ ] `npm test -- test/workflow/work-harness-service.test.ts -t "review"`

**Dependencies:** Task 10.

**Files likely touched:**

- Modify: `plugins/ezagent-spec/skills/ezagent-execute/SKILL.md`
- Modify: `plugins/ezagent-spec/skills/ezagent-review/SKILL.md`
- Modify: `test/codex/skill-contract.test.ts`
- Modify: `test/workflow/work-harness-service.test.ts`

**Estimated scope:** Medium, 4 files.

### Task 12: Add Specialist-only replan and retirement

**Description:** Permit an approved Work Contract to revise only its execution strategy when a genuine capability gap appears. Preview/apply must show a canonical member/delegation diff. Completion or cancellation retires v2 Specialists and reconciles generated Agents.

**Acceptance criteria:**

- [ ] Replan cannot change Outcome, Scope, Non-goals, Criteria, Boundaries, or Approval Points.
- [ ] Replan refuses active unfinished receipts and requires exact approval of added/removed/changed/unchanged delegations.
- [ ] Completion and cancellation remove task-only active experts, preserve immutable plan/receipt history, and remove only managed generated Agent files.

**Verification:**

- [ ] `npm test -- test/workflow/specialist-replan.test.ts`
- [ ] `npm test -- test/e2e/v2-specialist-orchestration.test.ts -t "replan|retire"`

**Dependencies:** Task 11.

**Files likely touched:**

- Create: `test/workflow/specialist-replan.test.ts`
- Modify: `src/workflow/specialist-plan.ts`
- Modify: `src/workflow/service.ts`
- Modify: `src/cli/main.ts`
- Modify: `src/adapters/codex/expert-team.ts`

**Estimated scope:** Medium, 5 files.

### Checkpoint D: Complete lifecycle

- [ ] Tasks 10-12 focused tests pass.
- [ ] `npm run plugin:validate` passes.
- [ ] `npm run test:workflow` passes.
- [ ] `npm run test:codex` passes.
- [ ] Human review confirms that no routine confirmation was added before initial Work Apply.

---

## Phase 5: End-to-end proof and release honesty

### Task 13: Prove three v2 Specialist paths end to end

**Description:** Add fresh-process tests for explicit no-Specialist work, selected implementation Specialists, and mixed independent review. Include restart, reconciliation, receipts, Evidence, completion, and retirement.

**Acceptance criteria:**

- [ ] A simple Brief records `not-needed` and never creates `.codex/agents/ezagent-*.toml`.
- [ ] A cross-domain Standard task selects deterministic experts, materializes Agents, records matching receipts, and resumes identically after restart.
- [ ] Mixed review uses a distinct read-only reviewer plus human approval and retires all managed Agents after completion.

**Verification:**

- [ ] `npm test -- test/e2e/v2-specialist-orchestration.test.ts`
- [ ] `npm test -- test/e2e/automatic-expert-team.test.ts`

**Dependencies:** Task 12.

**Files likely touched:**

- Create: `test/e2e/v2-specialist-orchestration.test.ts`
- Modify: `test/e2e/automatic-expert-team.test.ts`
- Modify: `test/fixtures/work-contract-fixture.ts`

**Estimated scope:** Medium, 3 files.

### Task 14: Add real Codex Host evaluation and update release contracts

**Description:** Extend Host evaluation beyond “Specialist is optional” to observe actual delegation behavior. Update user documentation, Changelog, package/Skill contracts, and plugin build checks only after the real Host path passes.

**Acceptance criteria:**

- [ ] Host evaluation includes one no-Specialist case, one implementation delegation case, and one independent-review case.
- [ ] Review criteria distinguish project-Agent materialization from actual Host delegation and require bounded summaries rather than full prompts.
- [ ] README and Changelog claim only behavior proven by local tests and Host evidence.

**Verification:**

- [ ] `npm run plugin:verify`
- [ ] `npm run plugin:host-eval`
- [ ] `npm run plugin:host-eval:verify`
- [ ] `npm run verify`

**Dependencies:** Task 13.

**Files likely touched:**

- Modify: `test/fixtures/codex-host-eval.json`
- Modify: `scripts/codex-host-eval.ts`
- Modify: `test/codex/host-eval.test.ts`
- Modify: `README.md`
- Modify: `CHANGELOG.md`

**Estimated scope:** Medium, 5 files.

### Final checkpoint

- [ ] All 14 tasks and checkpoints are complete.
- [ ] `npm run verify` passes.
- [ ] `npm run plugin:verify` passes.
- [ ] Real Host evidence passes for no-Specialist, implementation Specialist, and independent reviewer behavior.
- [ ] v1 automatic expert-team E2E remains green.
- [ ] Old v2 active records remain resumable.
- [ ] No full prompts, chats, unused expert instructions, secrets, or raw tool output are persisted.
- [ ] No network, Git write, telemetry, install, publish, or upload authority was added.

---

## Parallelization opportunities

- Tasks 1 and the initial test fixture preparation for Task 2 may proceed in parallel after contract names are fixed.
- After Task 6, project-Agent rendering tests for Task 7 can be prepared while CLI readiness tests for Task 8 are drafted, but implementation must merge through the shared adapter contract sequentially.
- Task 10 Skill drafting can begin after Task 5 fixes preview input/output, but it must not merge before Tasks 8-9 establish the real commands and context fields.
- Task 13 E2E fixture preparation and Task 14 Host-eval fixture drafting may proceed in parallel after Task 12, while final verification remains sequential.
- Tasks that mutate `src/workflow/service.ts`, `src/cli/main.ts`, or the shared Work Contract must not be implemented concurrently without explicit coordination.

## Risks and mitigations

| Risk | Impact | Mitigation |
| --- | --- | --- |
| Optional Specialists remain prompt-only | High | Persist a Core-selected plan, gate delegated Slice review on receipts, and add real Host evaluation. |
| Adding draft fields breaks old active v2 work | High | Change only new draft validation; keep persisted Brief/Spec/Task readers compatible and treat missing plan history as `legacy-unassessed`. |
| Reusing v1 Team types leaks coding-only semantics | Medium | Create `SpecialistPlanV2`; reuse only catalog, selection primitives, active projection, and platform rendering. |
| The Host ignores generated project Agents | High | Gate materialization separately, require bounded receipts, and verify actual Host behavior before release claims. |
| A receipt is fabricated by the coordinator | Medium | Bind it to an approved delegation and fingerprint, keep it immutable, require result hashes/evidence pointers, and supplement with Host evaluation. |
| Reviewer is not independent | High | Core rejects overlapping implement/review assignments per Slice and validates receipt expert IDs and modes. |
| Catalog drift changes selected experts after preview | High | Recompute on Apply and bind the catalog and selection fingerprints into the approval token. |
| Generated Agent drift blocks unrelated simple work | Medium | Gate only Slices with delegations; no-Specialist Work Items never depend on project-Agent readiness. |
| Specialist context consumes too many tokens | Medium | Materialize only selected experts and expose only current-Slice delegation summaries in `context`. |
| Specialist replan silently broadens the Work Contract | High | Restrict replan to execution strategy; contract changes still require a new Work Contract. |
| Multi-Slice concurrency destabilizes the state machine | Medium | Keep one active Slice in this release and defer concurrent Slice transitions. |
| New files are left after completion | Medium | Retire active projection inside the completion mutation and reconcile managed Agent files before reporting success. |

## Deferred follow-ups

- Concurrent execution of multiple independent Slices.
- Specialist effectiveness scoring based on accepted receipts and Evidence.
- Cross-project reusable Specialist patterns.
- Claude Code or other platform adapters consuming `SpecialistPlanV2`.
- Optional UI visualization of Specialist selection and delegation history.

## Plan quality checklist

- [x] Dependencies are explicit and ordered bottom-up.
- [x] Tasks are limited to approximately 3-5 files each.
- [x] Every task has testable acceptance criteria and verification commands.
- [x] Checkpoints occur after every 2-3 implementation tasks.
- [x] The highest-risk assumptions—schema compatibility, deterministic selection, Host invocation, and retirement—are tested before release claims.
- [x] v1 compatibility and old v2 recovery are first-class acceptance conditions.
