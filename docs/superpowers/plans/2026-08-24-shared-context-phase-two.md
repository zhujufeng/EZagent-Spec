# Shared Context Phase Two Implementation Plan

> **Execution rule:** implement task-by-task with focused red/green tests. Do not add dependencies, network access, automatic Git operations, or extra full-suite runs.

**Goal:** Add an explicitly enabled, lightweight team project index; promote approved Task Knowledge into reusable Patterns; and return deterministic “3 relevant + 2 recent” knowledge summaries.

**Architecture:** Keep schemas and deterministic selection in small pure modules. Keep `ExpertTeamWorkflowService` as the orchestration boundary for bounded reads, preview tokens, and atomic workspace mutations. Expose five internal JSON CLI commands and one thin `ezagent-context` Skill; preserve `gitTracking: none` as the initialization default.

**Tech stack:** Node.js 22, TypeScript 7, Zod 4, YAML, Markdown, Vitest 3, esbuild. No new dependency.

---

## Task 1: Define the bounded ProjectContext contract

**Files (2):**

- Create: `src/workflow/project-context.ts`
- Create: `test/workflow/project-context.test.ts`

- [ ] Write focused failing tests for strict parsing, NFC normalization, nested freezing, item/file budgets, portable relative source paths, canonical YAML round-trips, and `knowledge/project.yaml` as the fixed path.
- [ ] Implement the strict `ProjectContext` schema, parser, serializer, file-size budget, and portable-path checks using existing Unicode conventions.
- [ ] Run `npx vitest run test/workflow/project-context.test.ts` and observe GREEN.
- [ ] Run `git diff --check`, then commit `feat: define shared project context`.

**Acceptance:** valid input round-trips canonically; invalid or oversized content is rejected before use; no filesystem or network side effect exists in this module.

## Task 2: Define Pattern, query, and deterministic 3+2 selection

**Files (4):**

- Create: `src/workflow/knowledge-pattern.ts`
- Create: `src/workflow/knowledge-selection.ts`
- Create: `test/workflow/knowledge-pattern.test.ts`
- Create: `test/workflow/knowledge-selection.test.ts`

- [ ] Write focused failing tests for strict Pattern/promotion/query schemas, canonical Markdown, nested freezing, maximum term budget, and fixed `knowledge/patterns/SPEC-*.md` paths.
- [ ] Write failing table tests for exact scoring, Unicode case folding, score ordering, Pattern tie priority, descending portable Spec ID order, source-Spec dedupe, positive-score-only relevant results, and at most two recent Decisions.
- [ ] Implement schema/serialization in `knowledge-pattern.ts` and pure ranking/selection in `knowledge-selection.ts`.
- [ ] Run `npx vitest run test/workflow/knowledge-pattern.test.ts test/workflow/knowledge-selection.test.ts` and observe GREEN.
- [ ] Run `git diff --check`, then commit `feat: add deterministic knowledge selection`.

**Acceptance:** identical inputs produce byte-stable output containing at most three positive-score relevant summaries plus two non-duplicate recent Decisions; zero-score candidates never fill a quota.

## Task 3: Assemble bounded project and knowledge context

**Files (3):**

- Modify: `src/workflow/service.ts`
- Modify: `src/workflow/resume-context.ts`
- Create: `test/workflow/knowledge-context.test.ts`

- [ ] Write focused failing workflow tests covering missing project index, valid project index, corrupt index inspection blocker, v1/v2 Decisions, Patterns, query privacy, path/hash-only summaries, and deterministic 3+2 output.
- [ ] Add bounded readers that validate filenames and canonical records, then expose `knowledgeContext(query)` without persisting or auditing terms.
- [ ] Extend `resumeContext()` with `projectContext: ProjectContext | null`; return inspection-required for corrupt shared facts while retaining compatibility when the file is absent.
- [ ] Run `npx vitest run test/workflow/knowledge-context.test.ts test/workflow/knowledge.test.ts` and observe GREEN.
- [ ] Run `git diff --check`, then commit `feat: assemble bounded shared context`.

**Acceptance:** only summaries, paths, hashes, source kind, and scores cross the service boundary; queries leave the workspace snapshot unchanged; legacy Knowledge remains readable.

## Task 4: Add explicit sharing preview/apply

**Files (2):**

- Modify: `src/workflow/service.ts`
- Create: `test/workflow/project-sharing.test.ts`

- [ ] Write failing tests for `none -> artifacts`, `artifacts -> artifacts`, rejected `all`, safe mode, stale revision/token/content/root identity, and atomic failure snapshots.
- [ ] Implement read-only `sharingPreview()` returning target paths and explicit include/exclude boundaries.
- [ ] Implement `sharingApply()` using one `commitMutation` to update `project.yaml`, write `knowledge/project.yaml`, advance revision, and audit hashes/counts without project prose.
- [ ] Assert no `.gitignore` mutation and no Git command exists in this flow.
- [ ] Run `npx vitest run test/workflow/project-sharing.test.ts` and observe GREEN.
- [ ] Run `git diff --check`, then commit `feat: add explicit artifact sharing`.

**Acceptance:** an exact preview token is required for every write; all validation precedes mutation; initialization still defaults to `gitTracking: none`.

## Task 5: Add approved Knowledge-to-Pattern promotion

**Files (2):**

- Modify: `src/workflow/service.ts`
- Create: `test/workflow/knowledge-promotion.test.ts`

- [ ] Write failing tests for v1/v2 source records, artifacts-mode gate, preview normalization, stale revision/token, source-hash drift, filename mismatch, duplicate target, safe mode, and atomic failure snapshots.
- [ ] Implement `knowledgePromotionPreview()` that resolves the source record and returns a normalized Pattern, target path, and token without writing.
- [ ] Implement `knowledgePromotionApply()` that revalidates all facts and writes one immutable Pattern through `commitMutation` with hash-only audit metadata.
- [ ] Verify the Pattern excludes receipts, verification commands, chat text, and raw Knowledge bodies.
- [ ] Run `npx vitest run test/workflow/knowledge-promotion.test.ts test/workflow/knowledge.test.ts` and observe GREEN.
- [ ] Run `git diff --check`, then commit `feat: promote approved knowledge patterns`.

**Acceptance:** one source Spec can create at most one Pattern; drift or duplicate publication fails before any workspace change.

## Task 6: Expose bounded internal CLI commands

**Files (2):**

- Modify: `src/cli/main.ts`
- Modify: `test/cli/main.test.ts`

- [ ] Write failing CLI tests for `sharing-preview`, `sharing-apply`, `knowledge-context`, `knowledge-promote-preview`, and `knowledge-promote-apply`, including argv allowlists, bounded stdin, token injection, and JSON output.
- [ ] Add the five command specifications and route each command to the matching service method.
- [ ] Keep dynamic payloads in the existing bounded stdin document and approval tokens in explicit argv options.
- [ ] Run `npx vitest run test/cli/main.test.ts test/cli/json-input.test.ts` and observe GREEN.
- [ ] Run `git diff --check`, then commit `feat: expose shared context commands`.

**Acceptance:** shell arguments never contain dynamic JSON; malformed/oversized input is rejected by the existing bounded reader; existing commands remain compatible.

## Task 7: Add the thin context Skill and Router handoff

**Files (5):**

- Create: `plugins/ezagent-spec/skills/ezagent-context/SKILL.md`
- Modify: `plugins/ezagent-spec/skills/ezagent-router/SKILL.md`
- Modify: `scripts/build-plugin.ts`
- Modify: `test/codex/activation-contract.test.ts`
- Modify: `test/codex/skill-contract.test.ts`

- [ ] Write failing contract tests requiring the new Skill, Router handoff, short retrieval terms, preview-before-apply, one approval, and the “EZagent never runs Git” boundary.
- [ ] Implement `ezagent-context` with three bounded paths: retrieve summaries, enable/update sharing, and preview/apply Pattern promotion.
- [ ] Update the Router with a bridge only; do not duplicate schemas or scoring rules.
- [ ] Add the Skill to deterministic packaging.
- [ ] Run `npx vitest run test/codex/activation-contract.test.ts test/codex/skill-contract.test.ts` and observe GREEN.
- [ ] Run `git diff --check`, then commit `feat: add shared context skill`.

**Acceptance:** normal users interact through intent rather than internal commands; the Skill requests approval exactly once for mutation and never performs Git or network operations.

## Task 8: Package, document, and verify once

**Files (up to 4):**

- Modify: `test/codex/offline-smoke.test.ts`
- Modify: `test/codex/plugin-package.test.ts`
- Modify: `README.md`
- Regenerate: `plugins/ezagent-spec/dist/ezagent-cli.mjs`

- [ ] Add focused package/offline assertions for the new Skill and five bundled commands.
- [ ] Document the default-private mode, explicit artifact sharing, 3+2 summary retrieval, approved Pattern promotion, and manual Git responsibility.
- [ ] Run `npm run plugin:build` once to regenerate the checked-in bundle.
- [ ] Run the focused package tests once.
- [ ] Run final verification exactly once each: `npm run verify` and `npm run plugin:verify`.
- [ ] Run `git diff --check`, inspect `git status --short` and the final diff for unrelated or generated drift, then commit `docs: document shared project knowledge` (including generated bundle and package tests).

**Acceptance:** all success criteria in the approved design pass; there are no new dependencies, network permissions, Git mutations, unrelated files, or uncommitted changes.

---

## Execution boundary

- Implement only the approved design in `docs/superpowers/specs/2026-08-24-shared-context-and-knowledge-promotion-design.md`.
- Stop and ask before changing sharing scope, supporting downgrade/`all`, overwriting/deleting Patterns, modifying Git ignore, adding a dependency, or adding external retrieval.
- Do not merge or push this phase until the user separately approves the verified branch.
