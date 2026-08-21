# EZagent Spec MVP Roadmap

**Goal:** 通过公开 GitHub marketplace 在 macOS 与 Windows 上交付项目本地存储、初始化一次后自动路由的中文 Spec Coding Codex 插件；后续在同一 core 上增加 Claude Code adapter。

**Architecture:** 一个 Node.js 22 / TypeScript 本地 core 负责工作区、恢复、状态机和质量权限；Codex 层采用 **Skills + managed AGENTS.md + bundled CLI**。`AGENTS.md` 负责让相关自然语言请求进入 Router，Router 每次通过打包 CLI 读取可信状态，core 对所有状态转换实行关闭失败。当前不依赖 Codex lifecycle Hook，也不运行 daemon、数据库、Web 服务或 MCP server。

**Status truth (2026-08-21):** core、专家目录和 Codex 插件已通过本地 validator、离线 smoke、仓库测试，以及 macOS 与 Windows GitHub Actions。插件通过公开 marketplace 分发；完整 workflow/release 仍是下一里程碑。

## Milestones

| Order | Detailed plan | Current outcome | Status |
|---|---|---|---|
| 1 | `2026-08-20-ezagent-core-workspace-implementation.md` | 跨平台本地工作区、审计、恢复、状态机和内部 CLI | macOS + Windows CI verified |
| 2 | `2026-08-20-ezagent-expert-catalog-implementation.md` | 可复现的 265 位离线中文专家目录与无总数硬上限的自适应选择 | macOS + Windows CI verified |
| 3 | `2026-08-20-ezagent-codex-plugin-implementation.md` | 可验证的 Codex plugin、一次性初始化、自动 Router、项目专家文件和自足 CLI | macOS + Windows CI verified; public marketplace |
| 4 | `2026-08-20-ezagent-workflow-release-implementation.md` | 完整工作流命令、高风险授权、知识沉淀、三条 E2E 与公开发布包 | next milestone |

## Target repository map

```text
EZagent-Spec/
├── package.json
├── package-lock.json
├── src/
│   ├── domain/                  # IDs, work items, state machine, risk
│   ├── workspace/               # layout, schemas, locking, persistence
│   ├── audit/                   # append-only events and recovery projection
│   ├── experts/                 # normalized catalog and adaptive selector
│   ├── workflow/                # next milestone use cases
│   ├── adapters/codex/          # managed AGENTS and project-agent safety
│   └── cli/                     # deterministic local command boundary
├── catalog/normalized/          # verified source-of-truth expert snapshot
├── plugins/ezagent-spec/
│   ├── .codex-plugin/plugin.json
│   ├── skills/                  # Router, Initialize, Spec, Implement, Review
│   ├── dist/ezagent-cli.mjs     # self-contained Node.js 22 CLI
│   ├── catalog/                 # packaged normalized snapshot
│   └── licenses/                # source and npm runtime licenses
├── .agents/plugins/marketplace.json
├── .github/workflows/ci.yml     # read-only macOS/Windows matrix
├── scripts/                     # catalog and deterministic plugin packaging
└── test/                        # core, experts, Codex, workflow and e2e
```

项目初始化后只在用户确认的根目录管理三类路径：`.ezagent/**`、`AGENTS.md#EZAGENT` marker block 和 `.codex/agents/ezagent-*.toml`。已有用户内容必须保留；不确定发布结果必须保留 backup/recovery 证据并要求检查。

## Global rules

- 不复制 Trellis 的代码、模板、提示或脚本，也不调用 Trellis runtime；只独立实现结构化 Spec Coding 原则。
- 不读取、迁移或复用旧 EZagent 桌面仓库。
- runtime 默认 Local-only：无 telemetry、自动网络、自动安装、Git 写操作、发布或上传。
- 普通用户不运行 `npm install`；插件携带自足 CLI、目录和许可证，运行前置只有 Node.js 22+。
- 所有测试项目状态只写入登记的临时目录，不得在仓库根创建 `.ezagent/`。
- 初始化必须先预览精确写入范围并取得确认；预览到确认期间若 `AGENTS.md` token 变化则拒绝写入。
- Router 和其他 Skills 只能通过 argv 数组调用打包 CLI，不能拼接 shell，也不能直接编辑 `.ezagent/**`。
- 多 Agent 委派必须绑定 Requirement/Spec/Task/expert/delegation ID、范围、交付物和质量门；专家总数按能力需求动态确定。
- 未经用户明确批准，不执行插件安装、Git push、发布或任何外部系统变更。

## Current Codex milestone gate

Codex 层必须同时通过 **官方插件 validator + offline activation smoke**：

- manifest 与公开 marketplace 能被当前官方 validator 读取，且不声明未验证的 Hooks、MCP 或 Apps。
- smoke 只复制 `plugins/ezagent-spec/` 到临时目录，在剥离 proxy/npm/git/network 环境变量的子进程中运行打包 CLI。
- `doctor`、三路径 `integration-preview`、token 绑定 `integration-init`、fresh-process `context` 与重复初始化均通过，且第二次运行 byte-identical。
- 激活链闭合：managed `AGENTS.md` → `$ezagent-router` → `.ezagent/project.yaml` → argv-safe packaged `context`，并在分类前读取状态。
- 包文件 allowlist、文件模式和 bundle built-in import allowlist 证明只有本地 CLI 可执行，且没有 runtime network/Git-write capability。
- `npm run plugin:check`、`npm run plugin:verify` 与 `npm run verify` 在 macOS 本地通过。
- `.github/workflows/ci.yml` 以 `contents: read` 权限在 `macos-latest` 和 `windows-latest`、Node.js 22 上运行同一套 gate；Windows pass 只有实际 workflow 运行后才能记录。

这个 gate 证明当前插件能初始化、自动恢复上下文、正确路由并在能力缺失时关闭失败；它不等于完整 Spec 生命周期已经发布。

## Next workflow/release milestone

下一里程碑必须补齐 `capture/plan/replan/Knowledge/高风险授权签发` 的核心命令和持久化协议，然后才可以闭合：

```text
Requirement capture → Spec approval → Task plan → Implement → Verify → Knowledge → Finish
```

具体 release gate：

- 实现并测试 light / standard / high 三类工作流及合法状态转换。
- 高风险动作使用绑定 action 的一次性本地授权，Spec 批准不能代替动作授权。
- 范围、风险或依赖变化必须 replan，不能静默扩写 Task 或非法反向 transition。
- Review 全部 gate 通过后，必须先持久化并读回 Knowledge，才允许 completed。
- 用新的临时项目执行三条获批 E2E 场景，并验证跨会话恢复。
- 推送后取得真实 macOS/Windows GitHub Actions 结果。
- 生成公开仓库插件包并核对 provenance、licenses、无 Trellis material、无 telemetry/network client；未经用户明确请求不发布到 npm 或通用插件目录。

## MVP definition of done

MVP 只有在四个里程碑全部通过、设计验收项可追溯到自动化测试，并且用户能在新 Codex 任务中初始化一次后仅用自然语言完成一条 standard 需求时才算完成。当前 Codex 插件里程碑不是这个最终完成声明：缺少 workflow verbs、Knowledge 或授权签发时必须诚实报告并关闭失败。
