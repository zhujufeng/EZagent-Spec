# Codex Host Acceptance Evidence — v0.5.0

## Run metadata

- UTC date: `2026-08-26`
- Platform: `darwin-arm64`
- Codex CLI: `codex-cli 0.148.0`
- Plugin: `ezagent-spec@ezagent` version `0.5.0`
- Suite schema: `1`
- Evidence schema: `1`
- Local release gate: `54` test files, `1026/1026` tests passed; Catalog contains `265` experts with `0` provenance errors.

The baseline ten-case matrix identified three scoped defects: an ambiguous local-resource boundary, generic backend implementation/review capabilities, and an unbounded ordinary-development fixture. The fixes were verified with targeted runs on the corresponding later commits. Changes after the baseline were limited to the exact Work Contract reference, Specialist regression tests, host-evidence policy, and bounded host fixtures; unaffected cases were manually reviewed from the baseline run.

## Case results

| Case ID | Expected policy | Result | Accepted evidence |
|---|---|---|---|
| `initialized-standard-export` | `router-standard` | pass | targeted `6d5c676c356984eab74b4a8ef6ef369c3bf4f6f9` |
| `initialized-quick-cosmetic` | `router-quick` | pass | baseline matrix |
| `initialized-brief-analysis` | `router-brief` / Specialist `not-needed` | pass | baseline matrix |
| `initialized-consultation` | `consult-no-work` | pass | baseline matrix |
| `uninitialized-ordinary-development` | `no-workflow` | pass | targeted `6d5c676c356984eab74b4a8ef6ef369c3bf4f6f9` |
| `uninitialized-unrelated-initialization` | `no-workflow` | pass | baseline matrix |
| `uninitialized-explicit-enablement` | `initialize` | pass | baseline matrix |
| `initialized-controlled-migration` | `router-controlled` | pass | baseline matrix |
| `initialized-indirect-expert-request` | `router-standard` / analysis delegation | pass | targeted `e5438ddf74d7cda3908917d936c84d115f50fb04` |
| `initialized-independent-review` | `router-standard` / independent review | pass | targeted `80f144e00888f86efd3797f71401a38eb5e09a3b` |
| `combined-init-go-planning` | initialize, then Router handoff | pass | post-init `004553c12b8693df3b2185364b3296e3c3b113fb` |

The accepted Specialist runs used one schema-valid Work Preview. Backend analysis selected `ezagent.engineering.engineering-backend-architect`; backend implementation selected `ezagent.engineering.engineering-senior-developer`; independent code review selected `ezagent.engineering.engineering-code-reviewer`. No accepted Specialist run contained uncovered capabilities or blockers, and every preview explicitly stated that Agents had not yet been materialized or dispatched.

## Evidence hashes

| Evidence | SHA-256 |
|---|---|
| Ten-case baseline matrix | `392fd1974962c364b6f670345c1531a023de9331481b5b9e67eaed00a6fc6922` |
| Backend analysis targeted run | `1263e7eeb3f5fdefbbb083eb12088370f006e179031101be8e4b533d181b274d` |
| Independent implementation/review targeted run | `65e8b83d8a2f7cf478e3079c645cf3e38ce4c1d0538e7febc603a80fbb076ab6` |
| Ordinary no-workflow targeted run | `ba7ca61dd88cef78f087511f3818b3cf95c9a41193a28a22d02f984c88a17109` |
| Standard export targeted run | `2b06759c70b92e207cc371f06a57c2e82c4d59549f6cb661537c591ea72a3df0` |
| Post-initialization Router handoff | `aecfd7278a69136bf839565d3846610d2cb9a930e0c05b11c620037f76e21bf2` |

Raw JSONL, stderr, final model messages, temporary workspace paths, and manual-review details remain local under the Git-ignored `.artifacts/` directories. They are not committed because they contain environment-specific paths and model prose.
