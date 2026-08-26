# Codex 宿主发布验收

真实宿主验收验证 Codex CLI 能否发现已安装的 EZagent 插件，并在显式初始化、隐式路由、负向、边界和同一任务后续请求中遵守激活策略。它会调用真实模型，可能消耗网络与账号额度，因此不放入普通 Pull Request CI。

## 安全边界

- 只使用 `test/fixtures/codex-host-eval.json` 中的合成请求，不放入真实项目数据、密钥或内部地址。
- 普通激活场景在独立的系统临时 Git 项目中执行，Codex sandbox 固定为 `read-only`。
- 初始化连续性场景使用另一个空白临时 Git 项目和 `workspace-write` sandbox；确认前摘要必须保持不变，确认后只允许 `.ezagent/**`、`AGENTS.md` 与受管 `.codex/agents/ezagent-*.toml`。
- 执行器不自动安装插件、不修改 Codex 全局配置、不提交、不推送、不发布。
- 原始 JSONL、stderr 和最终消息只保存在被 Git 忽略的 `.artifacts/codex-host-eval/` 与 `.artifacts/codex-post-init-eval/`，不得提交。
- 模型文本不会自动判为通过；每个场景都需要人工阅读并填写理由。

## 1. 预检

从待发布提交的仓库根目录运行：

```bash
codex --version
codex plugin list --json
npm run plugin:verify
npm run verify
git status --short
```

最后一条命令必须没有输出。正式记录应使用 Codex CLI 0.148.0 或更新版本。

## 2. 安装本地待测插件

以下两条命令会修改当前用户的 Codex marketplace/plugin 配置，必须先获得操作者明确同意。它们不会自动初始化任何业务项目。

```bash
codex plugin marketplace add .
codex plugin add ezagent-spec@ezagent
codex plugin list --json
```

最后一条输出必须包含 installed、enabled 的 `ezagent-spec@ezagent`，版本必须与待发布插件一致。不要删除或覆盖无关 marketplace 与插件。

## 3. 执行与人工复核

```bash
npm run plugin:host-eval
```

命令会打印本次 `evidence.json` 的绝对路径。逐个打开同目录下的 `initial.jsonl`、`final.txt`，以及 follow-up 场景的 `follow-up.jsonl`、`follow-up-final.txt`，对照语料中的 `reviewCriteria` 复核：

- 正确场景是否进入 Router 或初始化流程；
- 未初始化的普通/无关请求是否没有启用 EZagent；
- 初始化写入前是否先展示范围并请求确认；
- 只读咨询是否没有创建工作项；
- high 风险是否被当前版本关闭失败；
- follow-up 是否延续同一任务上下文。

只有全部条件满足时，才把对应结果的 `review.status` 改为 `pass`，并在 `review.reason` 写入具体、非空的判定依据。失败或不确定时写 `fail`，保留证据并停止发布。

这组场景固定为只读且不会替用户批准 Work Preview，因此 Specialist 场景只验收：Capability Need 是否正确、实现/独立审查是否隔离、预览是否没有谎称 Agent 已物化或已经执行，以及批准后的 dispatch/receipt 边界是否说明清楚。它不得要求或接受未批准的实际委派；批准后的真实委派、独立 reviewer 调用和有界回执由 v2 Specialist E2E 与 delegation receipt 门禁验证。

完成复核后运行：

```bash
npm run plugin:host-eval:verify
```

验证器只接受：被测提交仍是当前 `HEAD`、场景集合完整且唯一、命令全部退出 `0`、临时工作区字节摘要未变化、transcript 哈希有效、全部人工复核为 `pass`。

### 初始化后同任务交接回归

普通只读场景通过后，再运行专用的可变工作区评测：

```bash
npm run plugin:post-init-eval
```

该评测固定使用“启用 EZagent，然后规划 Go 云服务器端口检测工具”的组合请求。第一轮只能执行初始化预览并请求确认，工作区摘要不得变化；第二轮确认后必须观察到以下精确命令序列：

```text
integration-preview → integration-init → context → work-preview
```

评测器自动拒绝 `work-apply`、确认前写入、持久化 active Work Item，以及 `docs/superpowers/` 等非 EZagent 管理路径。逐项阅读 `initial.jsonl`、`follow-up.jsonl` 和最终消息，确认 Router 明确给出模式、理由、下一个 Skill 并实际转交，且没有把 `context` 当成路由完成。然后填写 `evidence.json` 的人工复核结果并运行：

```bash
npm run plugin:post-init-eval:verify
```

验证器只接受当前 `HEAD` 和当前安装插件版本完全匹配、命令序列精确、初始化批准没有越过 Work Contract 批准边界、工作区写入范围正确且人工复核通过的证据。

## 4. 提交脱敏摘要

只在 `docs/release/evidence/` 提交摘要。摘要包含 UTC 时间、操作系统、Codex CLI 版本、插件 ID/版本、被测提交 SHA、语料 schema、每个 case ID 的结果和最终 `evidence.json` SHA-256。不得复制模型原文、本地绝对路径、账号信息或原始 API 输出。

## 5. 签名并保护未来发布标签

`v0.1.0` 已发布且未签名，不移动、不重签、不改写。从下一版本开始，只有在本地发布门、真实宿主验收和 macOS/Windows CI 全部通过后，才创建签名 annotated tag。以 `v0.1.1` 为例：

```bash
git tag -s v0.1.1 -m "EZagent Spec v0.1.1"
git verify-tag v0.1.1
git push origin v0.1.1
```

`git verify-tag` 必须成功后才能推送。GitHub 的 `Protect release tags` ruleset 负责阻止 `v*` 标签删除或更新；它不能替代签名验证。
