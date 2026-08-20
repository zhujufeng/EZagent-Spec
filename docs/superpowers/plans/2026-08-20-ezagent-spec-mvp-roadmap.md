# EZagent Spec MVP Roadmap Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver a locally stored, automatically triggered Chinese Spec Coding workflow as a Codex plugin on macOS and Windows.

**Architecture:** Build one TypeScript codebase with strict internal module boundaries, then deliver it in four independently testable milestones: local core, expert catalog, Codex adapter, and end-to-end workflow/release. Each milestone has its own detailed plan and must pass its verification gate before the next begins.

**Tech Stack:** Node.js LTS (minimum 22), TypeScript, npm, Zod, YAML, Vitest, esbuild, Codex Skills/Hooks/custom agents, GitHub Actions for product-repository CI.

---

## Scope decomposition

The approved design spans four independent subsystems. Keeping them in separate plans prevents a partially working plugin from hiding an untested core and lets every milestone end in working, reviewable software.

| Order | Detailed plan | Working outcome | Depends on |
|---|---|---|---|
| 1 | `2026-08-20-ezagent-core-workspace-implementation.md` | Cross-platform local workspace, state machine, recovery, audit, and internal CLI | Approved design |
| 2 | `2026-08-20-ezagent-expert-catalog-implementation.md` | Reproducible offline Chinese expert snapshot and adaptive selector | Milestone 1 |
| 3 | `2026-08-20-ezagent-codex-plugin-implementation.md` | Installable Codex plugin with automatic hooks and project agents | Milestones 1–2 |
| 4 | `2026-08-20-ezagent-workflow-release-implementation.md` | Full light/standard/high-risk workflows, privacy checks, cross-platform CI, and MVP package | Milestones 1–3 |

## Target repository map

```text
EZagent-Spec/
├── package.json
├── package-lock.json
├── tsconfig.json
├── src/
│   ├── domain/               # IDs, work items, state machine, risk
│   ├── workspace/            # Paths, schemas, locking, atomic persistence
│   ├── audit/                # Append-only events and recovery projection
│   ├── experts/              # Normalized catalog, selector, active experts
│   ├── workflow/             # Capture/spec/task/gate/orchestration use cases
│   ├── adapters/codex/       # Hooks, AGENTS.md, project agent TOML
│   └── cli/                  # Internal command entrypoint
├── catalog/
│   ├── sources.yaml
│   ├── sources.lock.json
│   └── normalized/
├── plugin/
│   ├── .codex-plugin/plugin.json
│   ├── hooks/hooks.json
│   ├── skills/
│   ├── dist/
│   └── licenses/
├── scripts/                  # Catalog import and plugin packaging
├── test/
│   ├── domain/
│   ├── workspace/
│   ├── experts/
│   ├── codex/
│   ├── workflow/
│   ├── e2e/
│   └── fixtures/
└── docs/
```

## Global implementation rules

- Before implementation, create a dedicated worktree on a `codex/` feature branch; planning commits remain on `main` until that worktree is created.
- Use TDD for every behavior: failing test, observed failure, minimal implementation, passing test, commit.
- Do not copy code, templates, prompts, or scripts from Trellis.
- Do not read or migrate the old EZagent desktop repository.
- Do not add a daemon, database, web service, telemetry, or runtime network dependency.
- Runtime code must work with packaged JavaScript and Node.js; end users do not run `npm install`.
- Tests may use temporary directories only; never initialize `.ezagent/` in this repository root.
- Every generated Codex file must use the `ezagent-` namespace or a managed marker block.
- No implementation task may run `git push`, publish a package, or contact upstream repositories without explicit user approval.

## Approved-design coverage

| Approved requirement | Implementation coverage |
|---|---|
| TypeScript/Node.js local core, no daemon | Core Tasks 1–7 |
| macOS/Windows support | Core Task 8; Codex Task 4; Release Task 11 |
| Initialize once, then automatic activation | Codex Tasks 1–5; Release Task 8 |
| Consult/light/standard/high classification | Release Tasks 1–3 and 8 |
| Requirement → Spec → Task → Implement → Verify → Finish | Core Task 2; Release Tasks 2–7 and 9 |
| Cross-session memory and recovery | Core Task 6; Release Tasks 8–9 |
| Full offline Chinese expert directory | Expert Tasks 1–4 and 7 |
| Adaptive expert count with no hard total cap | Expert Task 5; Release Task 4 |
| Structured multi-Agent delegation | Release Task 4 |
| Approval, high-risk authorization, and quality gates | Codex Task 5; Release Tasks 3, 5–6 |
| Local-only, no telemetry/network/automatic Git | Release Tasks 9–10; package inspection |
| Preserve existing AGENTS/custom agents | Codex Tasks 2 and 6 |
| Agency Agents MIT provenance | Expert Tasks 2–4 and 7 |
| No Trellis code/templates/dependency | Global rule; Codex Task 8; Release Task 10 |
| Future Claude adapter boundary | Core has no Codex imports; Codex-only code stays under `src/adapters/codex/` |

## Milestone gates

### Task 1: Local core gate

- [ ] Execute every task in `2026-08-20-ezagent-core-workspace-implementation.md`.
- [ ] Run `npm run check && npm run test:core`.
- [ ] Confirm the CLI initializes and resumes a temporary project on the current OS.
- [ ] Review the diff and tag the milestone locally as `mvp-core-ready` only if the user asks for a tag.

### Task 2: Expert catalog gate

- [ ] Execute every task in `2026-08-20-ezagent-expert-catalog-implementation.md`.
- [ ] Run `npm run catalog:verify && npm run test:experts`.
- [ ] Confirm every normalized record has provenance, license, full source SHA, and content hash.
- [ ] Confirm adaptive selection has no total-expert hard cap.

### Task 3: Codex plugin gate

- [ ] Execute every task in `2026-08-20-ezagent-codex-plugin-implementation.md`.
- [ ] Run `npm run plugin:build && npm run test:codex`.
- [ ] Install the unpacked plugin into a disposable Codex test environment.
- [ ] Confirm initialization is manual once and later turns trigger automatically.

### Task 4: MVP release gate

- [ ] Execute every task in `2026-08-20-ezagent-workflow-release-implementation.md`.
- [ ] Run `npm run verify` on macOS and Windows CI.
- [ ] Run all three approved end-to-end scenarios in disposable repositories.
- [ ] Inspect the package and prove it contains no Trellis material, telemetry, or runtime network client.
- [ ] Produce a local package artifact; do not publish it until the user explicitly requests publication.

## Definition of done

The roadmap is complete only when all four milestone gates pass, the design acceptance criteria are traceable to automated tests, and a colleague can initialize once and complete a standard feature request in a fresh Codex conversation without typing an EZagent command.
