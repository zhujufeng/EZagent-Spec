# Codex Host Acceptance Evidence — v0.5.1

## Run metadata

- UTC date: `2026-08-26`
- Platform: `darwin-arm64`
- Codex CLI: `codex-cli 0.148.0`
- Plugin: `ezagent-spec@ezagent` version `0.5.1`
- Tested commit: `41fd6361815e582bc764491a5e2560c1e0e2e2d9`
- Suite schema: `1`
- Evidence schema: `1`
- Local release gate: `54` test files, `1028/1028` tests passed; Codex plugin gate `208/208` passed; Catalog contains `265` experts with `0` provenance errors.

This patch release changes only Planning-first routing, Work Contract guidance, execution checkpoint behavior, documentation, and their regression fixtures. The unchanged activation, Specialist, initialization-continuation, safety, and packaging policies retain the accepted v0.5.0 matrix. Two new targeted real-host cases cover the newly introduced behavior on the v0.5.1 release commit.

## Case results

| Case ID | Expected policy | Result | Accepted behavior |
|---|---|---|---|
| `initialized-explicit-planning-first` | `router-standard` | pass | Selected `Standard + Planning-first`; one schema-valid read-only Work Preview contained the three requested document paths, a planning `humanCheckpoint` backed by `human-approval`, and an implementation Slice blocked by the planning Slice. Contract approval was explicitly separated from approval to code. |
| `initialized-adaptive-planning-first` | `router-standard` | pass | Recommended `Planning-first` for unresolved cross-platform implementation scope, asked exactly one consequential question with a concrete lower-risk recommendation before Work Preview, and performed no project mutation. |

Both runs exited `0`, stayed within the bounded timeout, used the installed and enabled `0.5.1` plugin, and preserved identical before/after workspace SHA-256 digests. The evidence verifier accepted each file against the tested commit and exact case ID.

## Evidence hashes

| Evidence | SHA-256 |
|---|---|
| Explicit Planning-first targeted run | `6021faa2bf7f576b9f40a937e7692e64ae369e364d466c5e42a6d2b5429b0d03` |
| Adaptive Planning-first targeted run | `1764fb70b845b8c8a44c7ba4706c1d1479ea533645323996d0f5dad2a460e290` |

Raw JSONL, stderr, final model messages, temporary workspace paths, and manual-review details remain local under the Git-ignored `.artifacts/` directory. They are not committed because they contain environment-specific paths and model prose.
