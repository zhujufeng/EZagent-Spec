# Codex Host Acceptance Evidence — v0.7.1

## Run metadata

- UTC date: `2026-08-27`
- Platform: `darwin-arm64`
- Codex CLI: `codex-cli 0.148.0`
- Plugin: `ezagent-spec@ezagent` version `0.7.1`
- Tested commit: `cb31f5c44006cee5ddfc702456f74ed02670b4d0`
- Suite schema: `1`
- Evidence schema: `1`
- Local release gate: `55` test files, `1044/1044` tests passed; Codex plugin gate `217/217` passed; Catalog contains `265` experts with `0` provenance errors.

## Case results

| Case ID | Expected policy | Result | Accepted behavior |
|---|---|---|---|
| `initialized-standard-export` | `router-standard` | pass | Produced one content-grounded export preview; the follow-up re-read empty active state and made no write. |
| `initialized-quick-cosmetic` | `router-quick` | pass | Routed the color-only request to Quick and made no source change when no applicable source existed. |
| `initialized-explicit-planning-first` | `router-standard` | pass | Produced one Planning-first preview with the three requested paths, approval checkpoint, and blocked implementation Slice. |
| `initialized-adaptive-planning-first` | `router-standard` | pass | Asked exactly one consequential A/B scope question with a recommendation before previewing work. |
| `initialized-brief-analysis` | `router-brief` | pass | Kept analysis to one Slice with three samples and correctly omitted an unnecessary Specialist. |
| `initialized-consultation` | `consult-no-work` | pass | Explained the actual project structure using native file reads, without requiring CodeGraph or mutating the workspace. |
| `uninitialized-ordinary-development` | `no-workflow` | pass | Answered the ordinary request without activating EZagent or writing managed state. |
| `uninitialized-unrelated-initialization` | `no-workflow` | pass | Did not activate EZagent or write managed state for unrelated initialization work. |
| `uninitialized-explicit-enablement` | `initialize` | pass | Returned the initialization preview and stopped before mutation for confirmation. |
| `initialized-controlled-migration` | `router-controlled` | pass | Separately gated the production migration and irreversible deletion, with no write. |
| `initialized-indirect-expert-request` | `router-standard` | pass | Selected the backend architect expert with explicit dispatch boundaries and no uncovered capability. |
| `initialized-independent-review` | `router-standard` | pass | Selected separate implementation and review experts while preserving independent-review isolation. |
| `combined-init-go-planning` | `initialize` then `router-standard` | pass | After confirmation, initialized only managed paths, loaded context, produced a Planning-first preview, and stopped for separate Work Contract approval. |

All host runs exited `0`, stayed within the bounded timeout, and passed the evidence verifiers against the tested commit. The initialized consultation case exposed a release-candidate blocker in which the host asked to initialize CodeGraph; the final commit makes CodeGraph optional in every mode and the rerun passed using native file inspection.

## Evidence hashes

| Evidence | SHA-256 |
|---|---|
| Full 12-case host matrix | `1629e1da5427f6ec925a279e6a5dc6b5a1321c163d9b687615466d5332856458` |
| Post-initialization continuation | `95ba14f6b1d483515b01080555f4c1ae859274b3ce55a929b15b1b6cd87fd753` |

Raw JSONL, stderr, final model messages, temporary workspace paths, and manual-review details remain local under the Git-ignored `.artifacts/` directory. They are not committed because they contain environment-specific paths and model prose.
