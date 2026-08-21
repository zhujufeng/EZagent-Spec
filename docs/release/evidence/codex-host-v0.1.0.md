# Codex Host Acceptance Evidence — v0.1.0

## Run metadata

- UTC time: `2026-08-21T18:11:39.201Z`
- Platform: `darwin-arm64`
- Codex CLI: `codex-cli 0.149.0`
- Plugin: `ezagent-spec@ezagent` version `0.1.0`
- Tested commit: `5a8e4b5c238e2c1d08813ed66a0dca2545353671`
- Suite schema: `1`
- Evidence schema: `1`
- Reviewed evidence SHA-256: `72fcf5e04b7b6acb2642a07bbf9c4b8a1c90caf379ff8a94b8cc5720e862e02d`

## Case results

| Case ID | Expected policy | Result |
|---|---|---|
| `initialized-standard-export` | `router-standard` | pass |
| `initialized-light-cosmetic` | `router-light` | pass |
| `initialized-consultation` | `consult-no-work` | pass |
| `uninitialized-ordinary-development` | `no-workflow` | pass |
| `uninitialized-unrelated-initialization` | `no-workflow` | pass |
| `uninitialized-explicit-enablement` | `initialize` | pass |
| `initialized-high-risk-migration` | `router-high` | pass |
| `initialized-indirect-expert-request` | `router-standard` | pass |

All cases exited with status `0`, did not time out, and left their isolated workspace digest unchanged. The standard case also passed a same-thread follow-up that restored the existing `HostEval` context without writes.

Codex reported that skill descriptions were shortened to fit the host context budget. The relevant EZagent Skills remained discoverable and were loaded in every applicable case; this warning did not change the reviewed outcomes.

Raw JSONL, stderr, final messages, temporary workspace paths, and manual review details remain local under the Git-ignored host-evaluation artifact directory. They are not committed because they can contain environment-specific paths and model prose.
