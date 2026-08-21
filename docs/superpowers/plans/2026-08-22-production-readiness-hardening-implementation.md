# Production Readiness Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Repair the private vulnerability channel, enforce single-maintainer-safe GitHub release controls, and add a repeatable real-Codex host acceptance gate.

**Architecture:** Keep deterministic repository contracts in Vitest and GitHub Actions, while treating GitHub repository settings and real-model host runs as explicit release operations with read-back evidence. The host evaluator uses versioned synthetic prompts, isolated temporary Git repositories, argv-only process execution, ignored raw transcripts, and a committed redacted summary.

**Tech Stack:** TypeScript 7, Node.js 22, Zod, Execa, Vitest, GitHub Actions, GitHub REST API, Codex CLI 0.148.0 or newer.

---

## File map

- Modify `SECURITY.md`: make the enabled private-reporting channel, response times, and fallback boundary explicit.
- Modify `.github/workflows/ci.yml`: add the high/critical npm vulnerability gate.
- Create `.github/dependabot.yml`: weekly npm dependency updates.
- Create `.github/rulesets/main.json`: reproducible API payload for the default-branch ruleset.
- Create `.github/rulesets/release-tags.json`: reproducible API payload for immutable `v*` tags.
- Modify `test/release/open-source-contract.test.ts`: lock security docs, Dependabot, CI audit, and ruleset contracts.
- Create `test/fixtures/codex-host-eval.json`: versioned synthetic host-evaluation cases.
- Create `scripts/codex-host-eval.ts`: schema validation, preflight, isolated execution, transcript hashing, and evidence verification.
- Create `test/codex/host-eval.test.ts`: TDD coverage for the evaluator's pure contracts and safe argv.
- Modify `test/codex/activation-contract.test.ts`: consume the shared forward-evaluation corpus instead of maintaining a private duplicate.
- Modify `package.json`: expose explicit host-evaluation run and verify commands.
- Modify `.gitignore`: exclude raw local host-evaluation artifacts.
- Create `docs/release/codex-host-acceptance.md`: operator procedure and manual review rubric.
- Create `docs/release/evidence/codex-host-v0.1.0.md`: redacted result summary bound to the tested commit and artifact hash.

### Task 1: Lock repository security and release contracts

**Files:**
- Modify: `test/release/open-source-contract.test.ts`
- Create: `.github/dependabot.yml`
- Create: `.github/rulesets/main.json`
- Create: `.github/rulesets/release-tags.json`
- Modify: `.github/workflows/ci.yml`
- Modify: `SECURITY.md`

- [ ] **Step 1: Write the failing repository contract tests**

Extend `test/release/open-source-contract.test.ts` with YAML/JSON parsing and these assertions:

```typescript
import { parse } from "yaml";

test("keeps the private vulnerability channel actionable", async () => {
  const security = await text("SECURITY.md");
  expect(security).toContain("security/advisories/new");
  expect(security).toMatch(/2 个工作日/u);
  expect(security).toMatch(/7 个自然日/u);
  expect(security).toMatch(/通道不可用.*不要.*漏洞细节/su);
});

test("runs weekly npm dependency updates and audits high vulnerabilities in CI", async () => {
  const dependabot = parse(await text(".github/dependabot.yml")) as {
    version: number;
    updates: Array<Record<string, unknown>>;
  };
  const workflow = await text(".github/workflows/ci.yml");
  expect(dependabot.version).toBe(2);
  expect(dependabot.updates).toContainEqual(expect.objectContaining({
    "package-ecosystem": "npm",
    directory: "/",
    schedule: { interval: "weekly" },
    "open-pull-requests-limit": 5,
  }));
  expect(workflow).toContain("npm audit --audit-level=high");
});

test("versions single-maintainer branch and immutable release-tag rulesets", async () => {
  const main = JSON.parse(await text(".github/rulesets/main.json")) as Record<string, unknown>;
  const tags = JSON.parse(await text(".github/rulesets/release-tags.json")) as Record<string, unknown>;
  expect(main).toMatchObject({ name: "Protect main", target: "branch", enforcement: "active" });
  expect(main).toHaveProperty("conditions.ref_name.include", ["~DEFAULT_BRANCH"]);
  expect(main).toHaveProperty("bypass_actors.0", {
    actor_id: 5,
    actor_type: "RepositoryRole",
    bypass_mode: "always",
  });
  expect(main).toHaveProperty("rules", expect.arrayContaining([
    { type: "deletion" },
    { type: "non_fast_forward" },
    expect.objectContaining({ type: "pull_request" }),
    expect.objectContaining({ type: "required_status_checks" }),
  ]));
  expect(tags).toMatchObject({ name: "Protect release tags", target: "tag", enforcement: "active" });
  expect(tags).toHaveProperty("conditions.ref_name.include", ["refs/tags/v*"]);
  expect(tags).toHaveProperty("rules", expect.arrayContaining([
    { type: "deletion" },
    { type: "update" },
  ]));
});
```

- [ ] **Step 2: Run the focused tests and verify RED**

Run: `npm test -- --run test/release/open-source-contract.test.ts`

Expected: FAIL because `.github/dependabot.yml` and both ruleset payloads do not exist and `SECURITY.md` has no response-time contract.

- [ ] **Step 3: Add the minimal security configuration**

Create `.github/dependabot.yml`:

```yaml
version: 2
updates:
  - package-ecosystem: npm
    directory: /
    schedule:
      interval: weekly
    open-pull-requests-limit: 5
```

Create `.github/rulesets/main.json`:

```json
{
  "name": "Protect main",
  "target": "branch",
  "enforcement": "active",
  "bypass_actors": [
    {
      "actor_id": 5,
      "actor_type": "RepositoryRole",
      "bypass_mode": "always"
    }
  ],
  "conditions": {
    "ref_name": {
      "include": ["~DEFAULT_BRANCH"],
      "exclude": []
    }
  },
  "rules": [
    { "type": "deletion" },
    { "type": "non_fast_forward" },
    {
      "type": "pull_request",
      "parameters": {
        "allowed_merge_methods": ["merge", "squash", "rebase"],
        "dismiss_stale_reviews_on_push": false,
        "require_code_owner_review": false,
        "require_last_push_approval": false,
        "required_approving_review_count": 0,
        "required_review_thread_resolution": true
      }
    },
    {
      "type": "required_status_checks",
      "parameters": {
        "do_not_enforce_on_create": true,
        "strict_required_status_checks_policy": true,
        "required_status_checks": [
          { "context": "Verify (macos-latest)" },
          { "context": "Verify (windows-latest)" }
        ]
      }
    }
  ]
}
```

Create `.github/rulesets/release-tags.json`:

```json
{
  "name": "Protect release tags",
  "target": "tag",
  "enforcement": "active",
  "bypass_actors": [
    {
      "actor_id": 5,
      "actor_type": "RepositoryRole",
      "bypass_mode": "always"
    }
  ],
  "conditions": {
    "ref_name": {
      "include": ["refs/tags/v*"],
      "exclude": []
    }
  },
  "rules": [
    { "type": "deletion" },
    { "type": "update" }
  ]
}
```

Add this CI step immediately after `npm ci`:

```yaml
      - name: Audit high and critical npm vulnerabilities
        run: npm audit --audit-level=high
```

Extend `SECURITY.md` with exact operating targets: acknowledge valid reports within 2 business days, provide a status update within 7 calendar days, and allow a public Issue/Discussion to say only that the private channel is unavailable without including vulnerability details.

- [ ] **Step 4: Run the focused tests and verify GREEN**

Run: `npm test -- --run test/release/open-source-contract.test.ts`

Expected: PASS with all open-source release contract tests green.

- [ ] **Step 5: Commit the repository security contract**

```bash
git add -- SECURITY.md .github/dependabot.yml .github/rulesets/main.json .github/rulesets/release-tags.json .github/workflows/ci.yml test/release/open-source-contract.test.ts
git commit -m "security: harden repository release controls"
```

### Task 2: Version the real-host evaluation corpus

**Files:**
- Create: `test/fixtures/codex-host-eval.json`
- Create: `test/codex/host-eval.test.ts`
- Modify: `test/codex/activation-contract.test.ts`
- Create: `scripts/codex-host-eval.ts`

- [ ] **Step 1: Write failing corpus-schema and coverage tests**

Create `test/codex/host-eval.test.ts` with tests that import `loadHostEvalSuite` and require unique IDs, all six activation policies, explicit/implicit/negative/boundary/follow-up categories, non-empty prompts, and a follow-up prompt only on the follow-up case:

```typescript
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import { loadHostEvalSuite } from "../../scripts/codex-host-eval.js";

const SUITE = fileURLToPath(new URL("../fixtures/codex-host-eval.json", import.meta.url));

describe("Codex host evaluation corpus", () => {
  test("covers every activation policy and behavioral category", async () => {
    const suite = await loadHostEvalSuite(SUITE);
    expect(suite.schemaVersion).toBe(1);
    expect(new Set(suite.cases.map(({ id }) => id)).size).toBe(suite.cases.length);
    expect(new Set(suite.cases.map(({ expectedPolicy }) => expectedPolicy))).toEqual(new Set([
      "consult-no-work",
      "no-workflow",
      "initialize",
      "router-light",
      "router-standard",
      "router-high",
    ]));
    expect(new Set(suite.cases.flatMap(({ categories }) => categories))).toEqual(new Set([
      "explicit",
      "implicit",
      "negative",
      "boundary",
      "follow-up",
    ]));
    expect(suite.cases.filter(({ followUpPrompt }) => followUpPrompt !== undefined)).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Run the focused test and verify RED**

Run: `npm test -- --run test/codex/host-eval.test.ts`

Expected: FAIL because `scripts/codex-host-eval.ts` and the JSON corpus do not exist.

- [ ] **Step 3: Implement the corpus schema and fixture**

In `scripts/codex-host-eval.ts`, define and export Zod schemas with these exact stable fields:

```typescript
import { readFile } from "node:fs/promises";
import { z } from "zod";

const policySchema = z.enum([
  "consult-no-work",
  "no-workflow",
  "initialize",
  "router-light",
  "router-standard",
  "router-high",
]);

const hostEvalCaseSchema = z.object({
  id: z.string().regex(/^[a-z0-9-]+$/u),
  name: z.string().min(1),
  prompt: z.string().min(1),
  initialized: z.boolean(),
  expectedPolicy: policySchema,
  categories: z.array(z.enum(["explicit", "implicit", "negative", "boundary", "follow-up"])).min(1),
  reviewCriteria: z.array(z.string().min(1)).min(1),
  followUpPrompt: z.string().min(1).optional(),
});

export const hostEvalSuiteSchema = z.object({
  schemaVersion: z.literal(1),
  pluginId: z.literal("ezagent-spec@ezagent"),
  cases: z.array(hostEvalCaseSchema).min(7),
});

export type HostEvalSuite = z.infer<typeof hostEvalSuiteSchema>;

export async function loadHostEvalSuite(path: string): Promise<HostEvalSuite> {
  return hostEvalSuiteSchema.parse(JSON.parse(await readFile(path, "utf8")) as unknown);
}
```

Create `test/fixtures/codex-host-eval.json` with the seven existing forward prompts plus one indirect request and a follow-up prompt. Each of the six policies must appear; categories must cover `explicit`, `implicit`, `negative`, `boundary`, and `follow-up`. Review criteria must state observable behavior, including no EZagent initialization for ordinary or unrelated requests and a confirmation request before explicit initialization writes.

Modify `test/codex/activation-contract.test.ts` to load this JSON through `loadHostEvalSuite`, remove `FORWARD_TEST_CASES`, and iterate over `suite.cases`. Preserve every existing anchor assertion.

- [ ] **Step 4: Run corpus and activation tests and verify GREEN**

Run: `npm test -- --run test/codex/host-eval.test.ts test/codex/activation-contract.test.ts`

Expected: PASS; the shared corpus covers all policies and all static anchors still match.

- [ ] **Step 5: Commit the shared host corpus**

```bash
git add -- scripts/codex-host-eval.ts test/fixtures/codex-host-eval.json test/codex/host-eval.test.ts test/codex/activation-contract.test.ts
git commit -m "test: version Codex host evaluation corpus"
```

### Task 3: Implement safe host execution and evidence verification

**Files:**
- Modify: `scripts/codex-host-eval.ts`
- Modify: `test/codex/host-eval.test.ts`

- [ ] **Step 1: Write failing argv, plugin-preflight, and evidence tests**

Add tests for these public pure functions:

```typescript
import {
  buildCodexExecArgv,
  installedPlugin,
  verifyHostEvalEvidence,
} from "../../scripts/codex-host-eval.js";

test("builds a read-only argv without a shell or sandbox bypass", () => {
  expect(buildCodexExecArgv("/tmp/host-case", "帮我实现登录页", "/tmp/final.txt", true)).toEqual([
    "exec",
    "--json",
    "--ephemeral",
    "--sandbox",
    "read-only",
    "--cd",
    "/tmp/host-case",
    "--output-last-message",
    "/tmp/final.txt",
    "帮我实现登录页",
  ]);
});

test("requires the exact installed and enabled plugin", () => {
  expect(installedPlugin({ installed: [{
    pluginId: "ezagent-spec@ezagent",
    name: "ezagent-spec",
    marketplaceName: "ezagent",
    version: "0.1.0",
    installed: true,
    enabled: true,
  }] })).toMatchObject({ pluginId: "ezagent-spec@ezagent", version: "0.1.0" });
  expect(() => installedPlugin({ installed: [] })).toThrow(/ezagent-spec@ezagent.*not installed/iu);
});

test("rejects incomplete, changed-workspace, or pending-review evidence", () => {
  expect(() => verifyHostEvalEvidence(
    { schemaVersion: 1, commit: "a".repeat(40), cases: [] },
    ["explicit-init"],
    "a".repeat(40),
  ))
    .toThrow(/missing.*explicit-init/iu);
});
```

Add complete fixtures proving verification also rejects non-zero exits, `workspaceChanged: true`, empty transcript hashes, duplicate case IDs, stale commit SHAs, and any review status other than `pass`.

- [ ] **Step 2: Run the focused test and verify RED**

Run: `npm test -- --run test/codex/host-eval.test.ts`

Expected: FAIL because the command builder, plugin preflight, and evidence verifier are not implemented.

- [ ] **Step 3: Implement the minimal runner**

Extend `scripts/codex-host-eval.ts` with:

```typescript
export function buildCodexExecArgv(
  root: string,
  prompt: string,
  outputPath: string,
  ephemeral: boolean,
): string[] {
  return [
    "exec",
    "--json",
    ...(ephemeral ? ["--ephemeral"] : []),
    "--sandbox",
    "read-only",
    "--cd",
    root,
    "--output-last-message",
    outputPath,
    prompt,
  ];
}
```

Add strict Zod schemas for `codex plugin list --json` and evidence. `installedPlugin` must require exactly one installed, enabled `ezagent-spec@ezagent`. `verifyHostEvalEvidence(evidence, expectedCaseIds, expectedCommit)` must require the exact current case ID set and commit SHA, exit code `0`, unchanged workspace digest, a 64-hex transcript SHA-256, and manual `review.status: "pass"` for every case.

The `run` command must:

1. Run `codex --version`, `codex plugin list --json`, `git rev-parse HEAD`, and `git status --porcelain` with Execa argv and `shell: false`.
2. Refuse a dirty repository or missing/disabled plugin.
3. Create a UTC-named artifact directory such as `.artifacts/codex-host-eval/2026-08-22T010203Z/` and one `mkdtemp` project per case.
4. Run `git init` in each temporary project.
5. For initialized cases, run the repository's built plugin CLI `integration-preview`, parse `agentsToken`, then pass `["integration-init", "--root", root, "--name", "HostEval", "--agents-token", agentsToken]` as argv to the same CLI.
6. Hash the workspace tree before and after Codex, excluding `.git`, and require equality because Codex runs read-only.
7. Run independent cases with `codex exec --json --ephemeral --sandbox read-only`. Run the single follow-up case without `--ephemeral`, parse its `thread.started.thread_id`, then invoke Codex in the same temporary project with `["exec", "resume", "--json", "--ephemeral", threadId, followUpPrompt]`.
8. Store raw JSONL and final messages only under the ignored artifact directory.
9. Write `evidence.json` with `review.status: "pending"`; never infer behavioral success from prose. The `verify` command must select the newest valid run directory when `--evidence` is omitted and fail when no evidence exists.

Use `execa(command, args, { cwd, reject: false, shell: false })`; never concatenate user-controlled strings into a shell command. On failure, preserve artifacts and print the exact evidence path.

- [ ] **Step 4: Run the focused tests and verify GREEN**

Run: `npm test -- --run test/codex/host-eval.test.ts`

Expected: PASS for schema, safe argv, preflight parsing, and evidence rejection/acceptance cases.

- [ ] **Step 5: Commit the host evaluator**

```bash
git add -- scripts/codex-host-eval.ts test/codex/host-eval.test.ts
git commit -m "feat: add isolated Codex host evaluator"
```

### Task 4: Document and expose the host release gate

**Files:**
- Modify: `package.json`
- Modify: `.gitignore`
- Create: `docs/release/codex-host-acceptance.md`
- Modify: `test/release/open-source-contract.test.ts`

- [ ] **Step 1: Write failing release-command and documentation tests**

Add a contract test that requires:

```typescript
test("documents an explicit real-Codex release gate without adding it to PR CI", async () => {
  const packageJson = JSON.parse(await text("package.json")) as {
    scripts: Record<string, string>;
  };
  const workflow = await text(".github/workflows/ci.yml");
  const guide = await text("docs/release/codex-host-acceptance.md");
  const ignore = await text(".gitignore");
  expect(packageJson.scripts["plugin:host-eval"]).toBe(
    "node --import tsx scripts/codex-host-eval.ts run",
  );
  expect(packageJson.scripts["plugin:host-eval:verify"]).toBe(
    "node --import tsx scripts/codex-host-eval.ts verify",
  );
  expect(workflow).not.toContain("plugin:host-eval");
  expect(guide).toContain("codex plugin add ezagent-spec@ezagent");
  expect(guide).toContain("git tag -s");
  expect(guide).toContain("git verify-tag");
  expect(ignore).toContain(".artifacts/codex-host-eval/");
});
```

- [ ] **Step 2: Run the focused test and verify RED**

Run: `npm test -- --run test/release/open-source-contract.test.ts`

Expected: FAIL because the scripts, ignore rule, and release guide do not exist.

- [ ] **Step 3: Add the explicit operator workflow**

Add to `package.json`:

```json
"plugin:host-eval": "node --import tsx scripts/codex-host-eval.ts run",
"plugin:host-eval:verify": "node --import tsx scripts/codex-host-eval.ts verify"
```

Add `.artifacts/codex-host-eval/` to `.gitignore`.

Create `docs/release/codex-host-acceptance.md` with exact commands to verify Codex, add the local repository as marketplace only after explicit approval, install `ezagent-spec@ezagent`, run the evaluator, manually set each evidence review to `pass` with a non-empty reason, verify the evidence, produce the redacted summary, and create future releases using `git tag -s vX.Y.Z -m "EZagent Spec vX.Y.Z"` followed by `git verify-tag vX.Y.Z`. State that raw transcripts remain ignored and must not contain real project data.

- [ ] **Step 4: Run focused and TypeScript checks and verify GREEN**

Run: `npm test -- --run test/release/open-source-contract.test.ts test/codex/host-eval.test.ts && npm run check`

Expected: PASS with no TypeScript errors.

- [ ] **Step 5: Commit the release workflow**

```bash
git add -- package.json .gitignore docs/release/codex-host-acceptance.md test/release/open-source-contract.test.ts
git commit -m "docs: require real Codex release acceptance"
```

### Task 5: Apply and read back GitHub security settings

**Files:**
- Read: `.github/rulesets/main.json`
- Read: `.github/rulesets/release-tags.json`

- [ ] **Step 1: Capture the current remote state without mutation**

Run these authenticated read-only requests and save their terminal output in the task record:

```bash
gh api repos/zhujufeng/EZagent-Spec/private-vulnerability-reporting
gh api repos/zhujufeng/EZagent-Spec --jq '.security_and_analysis'
gh api repos/zhujufeng/EZagent-Spec/rulesets
gh api repos/zhujufeng/EZagent-Spec/commits/main/check-runs --jq '.check_runs[].name'
```

Expected before mutation: private reporting and the requested security features are disabled, no rulesets exist, and both `Verify (macos-latest)` and `Verify (windows-latest)` appear.

- [ ] **Step 2: Enable the native security features**

After approval for external repository writes, run:

```bash
gh api --method PUT repos/zhujufeng/EZagent-Spec/private-vulnerability-reporting
gh api --method PUT repos/zhujufeng/EZagent-Spec/automated-security-fixes
gh api --method PATCH repos/zhujufeng/EZagent-Spec -F 'security_and_analysis[secret_scanning][status]=enabled' -F 'security_and_analysis[secret_scanning_push_protection][status]=enabled' -F 'security_and_analysis[secret_scanning_validity_checks][status]=enabled' -F 'security_and_analysis[secret_scanning_non_provider_patterns][status]=enabled'
```

Expected: HTTP success for each supported feature. Record unsupported optional secret-scanning features individually instead of weakening required Private Vulnerability Reporting, Secret Scanning, Push Protection, or Dependabot security updates.

- [ ] **Step 3: Create the branch and tag rulesets from reviewed payloads**

Run:

```bash
gh api --method POST repos/zhujufeng/EZagent-Spec/rulesets --input .github/rulesets/main.json
gh api --method POST repos/zhujufeng/EZagent-Spec/rulesets --input .github/rulesets/release-tags.json
```

Expected: two active rulesets with distinct IDs. If a matching name already exists, compare its full body, capture its numeric ID using `hardening_main_ruleset_id="$(gh api repos/zhujufeng/EZagent-Spec/rulesets --jq '.[] | select(.name == "Protect main") | .id')"`, and update it with `gh api --method PUT "repos/zhujufeng/EZagent-Spec/rulesets/${hardening_main_ruleset_id}" --input .github/rulesets/main.json` instead of creating a duplicate. Apply the same bounded lookup for `Protect release tags`.

- [ ] **Step 4: Read back every external setting**

Repeat the Step 1 reads and fetch each ruleset by ID. Verify exact status-check names, zero required approvals, review-thread resolution, admin bypass actor, branch deletion/non-fast-forward restrictions, and tag deletion/update restrictions.

- [ ] **Step 5: Record external-state evidence**

Add the returned feature statuses and ruleset IDs to the final task report. Do not commit tokens, request headers, account metadata, or raw API responses containing unrelated repository data.

### Task 6: Run and record one real Codex acceptance

**Files:**
- Create: `docs/release/evidence/codex-host-v0.1.0.md`

- [ ] **Step 1: Finish and commit all evaluator changes**

Run: `git status --short`

Expected: empty output before the evaluator enforces a clean worktree.

- [ ] **Step 2: Obtain explicit approval for local plugin setup**

Explain that the following commands update the user's Codex marketplace/plugin configuration. After approval, run the local marketplace and plugin installation commands from `docs/release/codex-host-acceptance.md`; do not remove or overwrite unrelated plugins.

- [ ] **Step 3: Execute the real host suite**

Run: `npm run plugin:host-eval`

Expected: Codex executes every synthetic case, the repository remains unchanged, and the command prints an ignored `evidence.json` path with all reviews pending.

- [ ] **Step 4: Review and verify evidence**

Review each final message and JSONL event against the case's `reviewCriteria`. Set `review.status` to `pass` only with a concrete non-empty reason. Then run: `npm run plugin:host-eval:verify`

Expected: PASS only when every case exited successfully, left the workspace unchanged, produced a transcript hash, matched the current commit and received an explicit passing review.

- [ ] **Step 5: Commit only a redacted evidence summary**

Create `docs/release/evidence/codex-host-v0.1.0.md` containing the UTC timestamp, operating system, Codex CLI version, plugin ID/version, tested commit SHA, suite schema version, all case IDs and pass statuses, raw evidence SHA-256, and a statement that raw transcripts remain local and ignored. Do not copy model prose or local absolute paths.

```bash
git add -- docs/release/evidence/codex-host-v0.1.0.md
git commit -m "test: record Codex host acceptance evidence"
```

### Task 7: Run the complete production-readiness gate

**Files:**
- Verify: all files changed by Tasks 1–6

- [ ] **Step 1: Run dependency and deterministic plugin gates**

Run:

```bash
npm audit --audit-level=high
npm run plugin:verify
```

Expected: audit reports zero high/critical vulnerabilities; catalog, plugin build/check, validators, and Codex tests pass.

- [ ] **Step 2: Run repository type, test, and build gates**

Run: `npm run verify`

Expected: TypeScript check, the complete Vitest suite, and build all exit `0`.

- [ ] **Step 3: Check the final diff and repository state**

Run:

```bash
git diff --check
git status --short --branch
git log --oneline main..HEAD
```

Expected: no whitespace errors, no uncommitted files, and only the bounded hardening commits appear after `main`.

- [ ] **Step 4: Re-read GitHub external state one final time**

Repeat Task 5 Step 4 after local verification. Expected: all required features remain enabled and both rulesets remain active with the exact reviewed semantics.

- [ ] **Step 5: Report exact completion and remaining deployment action**

Report local test counts, audit result, Codex host evidence commit, ruleset IDs, security feature states, branch name, and commit list. State that the new CI/Dependabot files do not affect GitHub until this branch is pushed and merged; do not push or create a PR unless the user separately requests publication.
