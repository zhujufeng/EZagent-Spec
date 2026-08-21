# EZagent Spec Open-Source Release Implementation Plan

> **Release update (2026-08-22):** v0.1.0 adds the standard Knowledge/Finish loop, removes the caller-supplied high-risk authorization path, and installs from an immutable tag. Earlier milestone caveats remain historical context.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Publish EZagent Spec under MIT as a public GitHub-backed Codex repo marketplace that an authorized Agent can install from `zhujufeng/EZagent-Spec`.

**Architecture:** Keep the existing self-contained TypeScript/Node.js plugin and repo marketplace layout. Add public release contracts and package the project license into the standalone plugin, then rewrite public documentation and governance files. Run privacy, dependency, plugin, repository, and private CI gates before changing GitHub visibility; public visibility is the final external mutation.

**Tech Stack:** TypeScript, Node.js 22, Vitest, esbuild, Codex plugin manifests and repo marketplaces, GitHub Actions, GitHub CLI.

---

## File map

- `LICENSE`: root MIT grant for EZagent-owned code.
- `package.json`: remains npm-private while declaring MIT metadata.
- `.agents/plugins/marketplace.json`: public marketplace identity `ezagent`.
- `plugins/ezagent-spec/.codex-plugin/plugin.json`: public MIT plugin metadata.
- `plugins/ezagent-spec/LICENSE`: generated standalone-plugin copy of the root license.
- `scripts/build-plugin.ts`: deterministic license copying and package allowlist.
- `README.md`: public install, Agent install, initialization, usage, boundaries, status, and contribution entrypoint.
- `CONTRIBUTING.md`: development and contribution contract.
- `SECURITY.md`: private vulnerability-reporting policy.
- `test/codex/plugin-manifest.test.ts`: public marketplace and manifest contract.
- `test/codex/plugin-package.test.ts`: standalone license and deterministic package contract.
- `test/codex/offline-smoke.test.ts`: public README and current cross-platform status contract.
- `test/release/open-source-contract.test.ts`: root license, metadata, governance, and public-copy contract.
- `docs/superpowers/plans/2026-08-20-ezagent-codex-plugin-implementation.md`: remove machine-specific absolute paths and mark historical internal distribution instructions as superseded.
- `docs/superpowers/plans/2026-08-20-ezagent-spec-mvp-roadmap.md`: record completed Windows CI and public distribution milestone.
- `docs/superpowers/specs/2026-08-20-ezagent-spec-product-design.md`: mark the earlier internal-only distribution decision as superseded by the approved open-source design.

### Task 1: Lock the public-release contract with failing tests

**Files:**
- Modify: `test/codex/plugin-manifest.test.ts`
- Modify: `test/codex/plugin-package.test.ts`
- Modify: `test/codex/offline-smoke.test.ts`
- Create: `test/release/open-source-contract.test.ts`

- [ ] **Step 1: Change the manifest test to require MIT and the public marketplace**

Update the existing expectations to the following exact contract:

```ts
expect(manifest).toMatchObject({
  name: "ezagent-spec",
  version: "0.1.0",
  license: "MIT",
  skills: "./skills/",
  interface: {
    displayName: "EZagent Spec",
    category: "Developer Tools",
  },
});

expect(marketplace).toEqual({
  name: "ezagent",
  interface: {
    displayName: "EZagent",
  },
  plugins: [
    {
      name: "ezagent-spec",
      source: {
        source: "local",
        path: "./plugins/ezagent-spec",
      },
      policy: {
        installation: "AVAILABLE",
        authentication: "ON_INSTALL",
      },
      category: "Developer Tools",
    },
  ],
});
```

Rename the marketplace test to `publishes the plugin through the public ezagent marketplace`.

- [ ] **Step 2: Change the package test to require the standalone license**

In `builds the complete verified distribution twice with byte-for-byte stable output`, require 17 files and the root license copy:

```ts
expect(paths).toHaveLength(17);
expect(paths).toContain("LICENSE");
expect(await readFile(join(first, "LICENSE"))).toEqual(
  await readFile(join(REPOSITORY_ROOT, "LICENSE")),
);
```

- [ ] **Step 3: Change the README smoke contract to require public instructions and current status**

Replace the old internal/pending assertions with:

```ts
expect(readme).toContain("codex plugin marketplace add zhujufeng/EZagent-Spec --ref main");
expect(readme).toContain("codex plugin add ezagent-spec@ezagent");
expect(readme).toContain("请帮我安装这个 Codex 插件");
expect(readme).toContain("Node.js 22+");
expect(readme).toContain("Router Skill + 项目内受管 `AGENTS.md`");
expect(readme).toContain("不是 Codex lifecycle Hook");
expect(readme).toContain("初始化一次");
expect(readme).toContain("Local-only");
expect(readme).toContain("MIT License");
expect(readme).toContain("Windows 与 macOS GitHub Actions 已通过");
expect(readme).not.toContain("ezagent-spec-internal");
expect(readme).not.toContain("Windows：pending first CI run");
```

Rename the test to `documents the public plugin boundary and verified platforms`.

- [ ] **Step 4: Add the root open-source contract test**

Create `test/release/open-source-contract.test.ts`:

```ts
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, test } from "vitest";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));

async function text(path: string): Promise<string> {
  return readFile(join(ROOT, path), "utf8");
}

describe("open-source release contract", () => {
  test("publishes EZagent-owned code under MIT without enabling npm publication", async () => {
    const license = await text("LICENSE");
    const packageJson = JSON.parse(await text("package.json")) as {
      readonly private?: boolean;
      readonly license?: string;
    };

    expect(license).toContain("MIT License");
    expect(license).toContain("Copyright (c) 2026 EZagent Contributors");
    expect(packageJson).toMatchObject({ private: true, license: "MIT" });
  });

  test("ships public contribution and private vulnerability-reporting guidance", async () => {
    const contributing = await text("CONTRIBUTING.md");
    const security = await text("SECURITY.md");

    expect(contributing).toContain("npm run plugin:verify");
    expect(contributing).toContain("npm run verify");
    expect(contributing).toContain("MIT License");
    expect(security).toContain("security/advisories/new");
    expect(security).toContain("不要在公开 Issue");
  });
});
```

- [ ] **Step 5: Run the focused tests and verify RED**

Run:

```bash
npm test -- --run test/codex/plugin-manifest.test.ts test/codex/plugin-package.test.ts test/codex/offline-smoke.test.ts test/release/open-source-contract.test.ts
```

Expected: failures for missing `LICENSE`, `CONTRIBUTING.md`, `SECURITY.md`, `license: MIT`, marketplace `ezagent`, package `LICENSE`, and public README text.

### Task 2: Adopt MIT metadata and the public marketplace

**Files:**
- Create: `LICENSE`
- Modify: `package.json`
- Modify: `.agents/plugins/marketplace.json`
- Modify: `plugins/ezagent-spec/.codex-plugin/plugin.json`
- Test: `test/codex/plugin-manifest.test.ts`
- Test: `test/release/open-source-contract.test.ts`

- [ ] **Step 1: Add the root MIT license**

Create `LICENSE` with the complete standard MIT text:

```text
MIT License

Copyright (c) 2026 EZagent Contributors

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

- [ ] **Step 2: Add root package license metadata without enabling npm publication**

Insert directly after `"private": true`:

```json
"license": "MIT"
```

Keep `"private": true` unchanged.

- [ ] **Step 3: Publish the marketplace identity**

Change `.agents/plugins/marketplace.json` only at the top-level identity:

```json
{
  "name": "ezagent",
  "interface": {
    "displayName": "EZagent"
  }
}
```

Preserve the existing plugin entry, relative `./plugins/ezagent-spec` path, policies, and category.

- [ ] **Step 4: Publish MIT in the plugin manifest**

Change:

```json
"license": "UNLICENSED"
```

to:

```json
"license": "MIT"
```

- [ ] **Step 5: Run the metadata tests**

Run:

```bash
npm test -- --run test/codex/plugin-manifest.test.ts test/release/open-source-contract.test.ts
```

Expected: marketplace and root-license test assertions pass; the governance-file test remains RED until Task 4.

- [ ] **Step 6: Commit the metadata slice**

```bash
git add LICENSE package.json .agents/plugins/marketplace.json plugins/ezagent-spec/.codex-plugin/plugin.json test/codex/plugin-manifest.test.ts test/release/open-source-contract.test.ts
git commit -m "chore: adopt MIT public marketplace"
```

### Task 3: Package the MIT license inside the standalone plugin

**Files:**
- Modify: `scripts/build-plugin.ts`
- Modify: `test/codex/plugin-package.test.ts`
- Generate: `plugins/ezagent-spec/LICENSE`

- [ ] **Step 1: Add LICENSE to generated and allowed entries**

Update the constants exactly:

```ts
const GENERATED_ENTRIES = [
  "dist",
  "catalog",
  "licenses",
  "LICENSE",
  "THIRD_PARTY_NOTICES.md",
  "RUNTIME_DEPENDENCIES.md",
] as const;

const PLUGIN_FILES = [
  ".codex-plugin/plugin.json",
  "LICENSE",
  "RUNTIME_DEPENDENCIES.md",
  "THIRD_PARTY_NOTICES.md",
  "catalog/catalog.lock.json",
  "catalog/experts.json",
  "dist/ezagent-cli.mjs",
  "licenses/UNICODE-LICENSE.txt",
  "licenses/agency-agents-MIT.txt",
  "licenses/agency-agents-zh-MIT.txt",
  "licenses/npm/yaml@2.9.0/LICENSE",
  "licenses/npm/zod@4.4.3/LICENSE",
  ...SKILLS.map((skill) => `skills/${skill}/SKILL.md`),
] as const;
```

- [ ] **Step 2: Copy the root license into every assembled stage**

At the start of `assembleStage`, after copying the plugin manifest, add:

```ts
await copyStableFile(
  REPOSITORY_ROOT,
  "LICENSE",
  join(stage, "LICENSE"),
  MAX_SMALL_SOURCE_BYTES,
  hooks,
);
```

- [ ] **Step 3: Regenerate the committed plugin distribution**

Run:

```bash
npm run plugin:build
```

Expected: `plugins/ezagent-spec/LICENSE` exists and generated plugin files match the updated allowlist.

- [ ] **Step 4: Run the deterministic package test**

Run:

```bash
npm test -- --run test/codex/plugin-package.test.ts
```

Expected: 11 tests pass, including two byte-identical builds containing 17 files.

- [ ] **Step 5: Commit the package slice**

```bash
git add scripts/build-plugin.ts test/codex/plugin-package.test.ts plugins/ezagent-spec/LICENSE
git commit -m "build: ship plugin under MIT"
```

### Task 4: Publish user, Agent, contributor, and security documentation

**Files:**
- Modify: `README.md`
- Create: `CONTRIBUTING.md`
- Create: `SECURITY.md`
- Modify: `test/codex/offline-smoke.test.ts`
- Test: `test/release/open-source-contract.test.ts`

- [ ] **Step 1: Rewrite README as the public project entrypoint**

Replace `README.md` with this complete public entrypoint:

```markdown
# EZagent Spec

面向中文团队的 Local-only Spec Coding Codex 插件。EZagent Spec 在项目内保存结构化需求、Spec、任务、专家、知识和质量证据，降低纯 vibe coding 的不确定性，并让上下文可以跨会话恢复。

> 当前为 `0.1.0` MVP。初始化、上下文恢复、Router、专家目录和安全状态转换已经可用；完整 `capture/plan/replan/Knowledge` 生命周期仍在开发中，缺少能力时会关闭失败。

## 安装

要求 Codex 和 Node.js 22+：

```bash
codex plugin marketplace add zhujufeng/EZagent-Spec --ref main
codex plugin add ezagent-spec@ezagent
```

安装或升级后新建一个 Codex 任务。

### 更新

```bash
codex plugin marketplace upgrade ezagent
```

更新后重新安装插件，并新建一个 Codex 任务：

```bash
codex plugin remove ezagent-spec@ezagent
codex plugin add ezagent-spec@ezagent
```

### 卸载

```bash
codex plugin remove ezagent-spec@ezagent
codex plugin marketplace remove ezagent
```

## 让 Agent 安装

把下面这段话发送给 Codex Agent：

> 请帮我安装这个 Codex 插件：https://github.com/zhujufeng/EZagent-Spec 。先阅读 README，检查 Codex CLI 与 Node.js 22+；在联网、安装软件或修改 Codex 全局配置前先征得我的确认。安装 marketplace `ezagent` 和插件 `ezagent-spec` 后，提醒我新建一个 Codex 任务。

## 在项目中启用

打开目标项目并说：

> 在当前项目启用 EZagent Spec。

初始化会先预览 `.ezagent/**`、`AGENTS.md#EZAGENT` 和 `.codex/agents/ezagent-*.toml`，确认后才写入。每个项目只需初始化一次。

## 日常使用

之后直接用自然语言描述实现、修改、修复、重构、审查或验证请求，例如：

- “帮我按 Spec 流程实现用户登录。”
- “修复订单重复提交的问题。”
- “审查这次修改是否符合 Spec 和质量门。”

自动机制是 **Router Skill + 项目内受管 `AGENTS.md`**，不是 Codex lifecycle Hook：

1. `.ezagent/project.yaml` 标识项目已经启用。
2. 受管 `AGENTS.md` 要求相关请求自动使用 `$ezagent-router`。
3. Router 通过插件内自足 CLI 读取可信上下文，再路由到 Spec、Implement 或 Review Skill。
4. `.ezagent/**` 只能由本地核心修改，Skill 不能直接编辑状态文件。

## 能力与边界

解释和只读咨询不会创建工作项。行为变化按 `light`、`standard` 或 `high` 分类；专家数量按任务能力动态选择，不固定为三位。所有多 Agent 委派都必须携带 Requirement、Spec、Task、expert、delegation、范围、交付物和质量门标识。

当前插件可以完成环境检测、集成预览、一次性初始化、上下文恢复、受限状态转换、Skills 路由和失败关闭。完整 `capture/plan/replan/Knowledge` 持久化命令和高风险授权签发仍在开发中。因此当前版本可以形成结构化 Spec 草案并执行已存在的合法 Task 流转，但不会伪造尚未支持的产物、命令或授权。

当前没有经过本项目验证的 `PreToolUse` interception contract。提示规则负责路由，本地核心的确定性状态转换负责关闭失败：revision、状态、批准或安全条件不满足时不会推进。

初始化预览到确认期间应避免并发修改 `AGENTS.md`。token 过期会要求重新预览；如果返回 inspection、recovery 或 backup 路径，应停止写入并保留证据。

## Local-only 与隐私

EZagent runtime 不会自动访问网络、发送遥测、安装软件、执行 Git commit/push、发布或上传用户项目。初始化默认使用 `gitTracking: none`。联网、安装、Git 写入或发布必须由用户针对具体动作单独授权。

Local-only 只描述 EZagent runtime，不改变 Codex 的模型处理、账号、组织策略或数据保留方式。GitHub marketplace 安装、Codex 自身通信和开发者主动执行的 `npm ci` 不属于 EZagent runtime 的离线行为。

## 平台与验证

Windows 与 macOS GitHub Actions 已通过。运行时要求 Node.js 22+；普通插件用户不需要在项目中执行 `npm install`。

## 开源与来源

EZagent Spec 使用 MIT License。专家目录衍生自 MIT 许可的 Agency Agents 与其中文项目，完整版权和来源见 `THIRD_PARTY_NOTICES.md` 与 `licenses/`。

本项目受 Trellis 的结构化 Spec 工作流思想启发，但不包含、复制或调用 Trellis 的代码、模板、CLI 或运行时，也不声明格式兼容。

## 开发与贡献

开发环境使用 Node.js 22：

```bash
npm ci
npm run plugin:verify
npm run verify
```

贡献要求见 `CONTRIBUTING.md`，安全问题见 `SECURITY.md`。
```

- [ ] **Step 2: Add contribution guidance**

Create `CONTRIBUTING.md` with these concrete sections:

```markdown
# Contributing to EZagent Spec

感谢你改进 EZagent Spec。提交贡献即表示你同意按项目的 MIT License 授权该贡献。

## 开发环境

- Node.js 22+
- npm（使用提交的 `package-lock.json`）
- macOS 或 Windows

```bash
npm ci
npm run plugin:verify
npm run verify
```

## 修改原则

- 保持 Local-only：不得默认增加遥测、网络请求、自动安装、Git 写入或上传。
- 不复制 Trellis 的代码、模板、提示词、CLI 或运行时。
- 更新专家目录时必须保留来源 Commit、内容哈希和许可证证明。
- 改变行为时先增加可失败的回归测试；不要直接编辑生成的插件文件而不更新构建源。
- 不提交密钥、真实项目数据、`.env`、私钥或内部地址。

## Pull Request

PR 应说明问题、设计选择、验证命令和结果。所有测试、类型检查、确定性插件构建及 macOS/Windows CI 必须通过。
```

- [ ] **Step 3: Add private security reporting**

Create `SECURITY.md`:

```markdown
# Security Policy

## Supported versions

安全修复目前只针对 `main` 和最新发布版本。

## Reporting a vulnerability

请使用 GitHub Private Vulnerability Reporting：
https://github.com/zhujufeng/EZagent-Spec/security/advisories/new

不要在公开 Issue、Discussion、Pull Request 或社交媒体中披露未修复漏洞、利用代码、密钥或真实用户项目数据。报告应包含受影响版本、复现条件、影响范围和建议缓解措施；请使用最小化的合成数据。

EZagent runtime 默认 Local-only，不代表 Codex 本身离线。报告涉及数据边界时，请明确区分 EZagent runtime、Codex 产品通信和用户主动授权的外部操作。
```

- [ ] **Step 4: Run documentation contract tests**

Run:

```bash
npm test -- --run test/codex/offline-smoke.test.ts test/release/open-source-contract.test.ts
```

Expected: all public documentation, governance, platform-status, and internal-name assertions pass.

- [ ] **Step 5: Commit the public documentation slice**

```bash
git add README.md CONTRIBUTING.md SECURITY.md test/codex/offline-smoke.test.ts
git commit -m "docs: publish GitHub installation guide"
```

### Task 5: Sanitize historical planning documents and status claims

**Files:**
- Modify: `docs/superpowers/plans/2026-08-20-ezagent-codex-plugin-implementation.md`
- Modify: `docs/superpowers/plans/2026-08-20-ezagent-spec-mvp-roadmap.md`
- Modify: `docs/superpowers/specs/2026-08-20-ezagent-spec-product-design.md`

- [ ] **Step 1: Use portable skill paths**

Use this path everywhere in the repository:

```text
$HOME/.codex/skills/.system/plugin-creator/
```

Do not include a machine-specific absolute home directory.

- [ ] **Step 2: Mark the earlier distribution decision as historical**

Add this note below the title of the 2026-08-20 plugin plan and product design:

```markdown
> Distribution note (2026-08-21): the internal-only marketplace decision in this historical document is superseded by `2026-08-21-ezagent-open-source-release-design.md`. Runtime Local-only and third-party license boundaries remain unchanged.
```

- [ ] **Step 3: Update the roadmap status without claiming unfinished workflow work**

Change the roadmap goal from company-internal delivery to public GitHub marketplace delivery, and replace Windows pending statements with:

```markdown
**Status truth (2026-08-21):** core、专家目录和 Codex 插件已通过 macOS 与 Windows GitHub Actions；公开 marketplace 发布按 `2026-08-21-ezagent-open-source-release-design.md` 执行。完整 workflow/release 仍是下一里程碑。
```

Keep `capture/plan/replan/Knowledge` explicitly incomplete.

- [ ] **Step 4: Verify personal paths are absent**

Run:

```bash
rg -n '/Users/[^/]+|C:\\Users\\[^\\]+' -g '!node_modules/**' -g '!.git/**' .
```

Expected: exit 1 with no output.

- [ ] **Step 5: Commit the sanitization slice**

```bash
git add docs/superpowers/plans/2026-08-20-ezagent-codex-plugin-implementation.md docs/superpowers/plans/2026-08-20-ezagent-spec-mvp-roadmap.md docs/superpowers/specs/2026-08-20-ezagent-spec-product-design.md
git commit -m "docs: retire internal distribution assumptions"
```

### Task 6: Run the private pre-publication release gates

**Files:**
- Verify only; do not change GitHub visibility in this task.

- [ ] **Step 1: Validate the plugin and marketplace with the bundled official helpers**

Run:

```bash
python3 "$HOME/.codex/skills/.system/plugin-creator/scripts/validate_plugin.py" plugins/ezagent-spec
python3 "$HOME/.codex/skills/.system/plugin-creator/scripts/read_marketplace_name.py" --marketplace-path .agents/plugins/marketplace.json
```

Expected: `Plugin validation passed` and `ezagent`.

- [ ] **Step 2: Run dependency and repository gates**

Run separately:

```bash
npm audit --audit-level=high
npm run plugin:verify
npm run verify
git diff --check
```

Expected: no high/critical vulnerabilities, plugin verification passes, all test files and tests pass, TypeScript/build passes, and no whitespace errors.

- [ ] **Step 3: Scan current files for high-confidence secrets without printing values**

Run:

```bash
rg -l --hidden -g '!node_modules/**' -g '!.git/**' -e '-----BEGIN [A-Z ]*PRIVATE KEY-----' -e 'gh[pousr]_[A-Za-z0-9_]{20,}' -e 'sk-(proj-)?[A-Za-z0-9_-]{20,}' -e 'AKIA[0-9A-Z]{16}' .
```

Expected: exit 1 with no filenames. If any filename appears, inspect it without copying the possible secret into chat; stop publication if it is real.

- [ ] **Step 4: Scan Git history for the same high-confidence patterns**

Run each `git log` search separately with `--name-only` so possible values are not printed:

```bash
git log --all -G '-----BEGIN [A-Z ]*PRIVATE KEY-----' --format='%H %s' --name-only
git log --all -G 'gh[pousr]_[A-Za-z0-9_]{20,}' --format='%H %s' --name-only
git log --all -G 'sk-(proj-)?[A-Za-z0-9_-]{20,}' --format='%H %s' --name-only
git log --all -G 'AKIA[0-9A-Z]{16}' --format='%H %s' --name-only
```

Expected: no output. Any real finding blocks publication until the credential is revoked and history is cleaned.

- [ ] **Step 5: Review public-surface internal markers**

Run:

```bash
rg -n "ezagent-spec-internal|EZagent Internal|Windows：pending first CI run|公司内部使用" README.md package.json .agents/plugins/marketplace.json plugins/ezagent-spec CONTRIBUTING.md SECURITY.md
```

Expected: exit 1 with no output.

- [ ] **Step 6: Confirm the repository is still private, then push**

Run:

```bash
gh repo view zhujufeng/EZagent-Spec --json visibility,url,defaultBranchRef
git status --short --branch
git push origin main
```

Expected before push: visibility `PRIVATE`, default branch `main`, and no uncommitted changes. The push must contain only reviewed commits.

- [ ] **Step 7: Wait for both private CI jobs**

Run:

```bash
gh run list --repo zhujufeng/EZagent-Spec --branch main --limit 1
EZAGENT_RELEASE_RUN_ID="$(gh run list --repo zhujufeng/EZagent-Spec --branch main --limit 1 --json databaseId --jq '.[0].databaseId')"
gh run watch "$EZAGENT_RELEASE_RUN_ID" --repo zhujufeng/EZagent-Spec --exit-status
```

Expected: `EZAGENT_RELEASE_RUN_ID` is a numeric ID and macOS and Windows jobs both succeed. A failure returns to the relevant task; do not make the repository public.

### Task 7: Make GitHub public and verify anonymous distribution

**Files:**
- External GitHub repository visibility only.

- [ ] **Step 1: Reconfirm the exact target and private CI SHA**

Run:

```bash
git remote get-url origin
git rev-parse HEAD
gh repo view zhujufeng/EZagent-Spec --json nameWithOwner,visibility,defaultBranchRef,url
```

Expected: exact target `zhujufeng/EZagent-Spec`, local HEAD equals the successful CI SHA, visibility is `PRIVATE`, and default branch is `main`.

- [ ] **Step 2: Change visibility with GitHub's explicit consequence acknowledgement**

Run:

```bash
gh repo edit zhujufeng/EZagent-Spec --visibility public --accept-visibility-change-consequences
```

Expected: exit 0. Do not change repository name, default branch, topics, branch protection, or issue settings in this command.

- [ ] **Step 3: Verify final visibility**

Run:

```bash
gh repo view zhujufeng/EZagent-Spec --json nameWithOwner,visibility,url,defaultBranchRef
```

Expected: visibility `PUBLIC`, URL `https://github.com/zhujufeng/EZagent-Spec`, default branch `main`.

- [ ] **Step 4: Verify anonymous Git and raw marketplace access**

Run:

```bash
env -u GH_TOKEN -u GITHUB_TOKEN git -c credential.helper= ls-remote https://github.com/zhujufeng/EZagent-Spec.git refs/heads/main
curl --fail --silent --show-error https://raw.githubusercontent.com/zhujufeng/EZagent-Spec/main/.agents/plugins/marketplace.json
```

Expected: `ls-remote` returns the published main SHA without credentials; the raw JSON has marketplace name `ezagent` and plugin path `./plugins/ezagent-spec`.

- [ ] **Step 5: Report the release evidence**

Report the public repository URL, final commit SHA, MIT license, marketplace selector `ezagent-spec@ezagent`, full local verification counts, private pre-publication CI URL, and anonymous-read evidence. Explicitly state that npm and the Codex universal public directory were not published.
