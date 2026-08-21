# EZagent Spec

EZagent Spec 是公司内部使用、Local-only 的中文 Spec Coding 工具。它把项目配置、工作状态、需求、Spec、任务、专家、知识和质量证据保存在项目内，目标是让开发流程比纯 vibe coding 更可控，并让结构化上下文能够跨会话恢复。

当前里程碑交付 Codex 插件、本地 TypeScript core、265 位中文专家目录以及一次性项目集成。实现受 Trellis 的结构化流程思想启发，但不包含、复制或调用 Trellis 的代码、模板或运行时；也不复用旧 EZagent 桌面项目代码。

## 内部安装

安装来源是本仓库声明的内部 local marketplace。以下命令仅是管理员或同事获得明确许可后的安装说明；本项目运行时不会自行修改 Codex 全局配置。把 `<repo-root>` 替换为本仓库的绝对路径：

```bash
codex plugin marketplace add <repo-root>
codex plugin add ezagent-spec@ezagent-spec-internal
```

安装或更新 Skills 后，应新建一个 Codex 任务再使用插件。不要在未经用户同意时执行上述命令。

Node.js 22+ 是插件唯一的额外运行时前置。初始化 Skill 会先检测 Node 版本；缺失或版本过低时只给出说明，任何联网下载或系统安装都必须再次获得用户明确同意。普通同事不需要在项目中执行 `npm install`，插件已经包含自足的 `dist/ezagent-cli.mjs`、专家目录和运行时许可证。

## 使用方式与自动触发

首次使用时，用户明确要求“在当前项目启用 EZagent Spec”。初始化先展示三类受管路径与 `AGENTS.md` token，用户确认项目根、项目名和写入范围后才写入；用户只需初始化一次，之后在该项目的新会话中用自然语言描述开发、修改、修复、重构、实现、审查或验证请求。

当前自动机制是 **Router Skill + 项目内受管 `AGENTS.md`**，不是 Codex lifecycle Hook：

1. `.ezagent/project.yaml` 标识该项目已经启用。
2. `AGENTS.md` 要求相关请求自动使用 `$ezagent-router`。
3. Router 通过插件内打包 CLI 的 argv 数组先运行 `context`，恢复可信状态后再分类并路由 Spec、Implement 或 Review Skill。
4. `.ezagent/**` 只能由本地 core 写入，Skill 不得直接编辑状态文件。

当前 Codex 没有经过本项目验证的 `PreToolUse` interception contract，因此不能声称具备工具级 Hook 拦截。约束的执行边界是本地核心的确定性状态转换：不满足 revision、状态、批准或安全条件时关闭失败。项目规则与 Skills 负责路由和提示约束，本地 core 负责可验证的状态权限。

解释和只读咨询不创建工作项；行为变化按 `light`、`standard` 或 `high` 分类。专家数量按任务能力动态选择，不固定为三位或其他总数。所有多 Agent 委派必须携带 Requirement、Spec、Task、expert、delegation、范围、交付物和质量门标识。

## 当前能力边界

当前插件可以安全完成环境检测、集成预览、一次性初始化、上下文恢复、受限状态转换、Skills 路由和失败关闭。`capture/plan/replan/Knowledge` 的完整持久化命令以及高风险授权签发仍属于下一个 workflow/release 里程碑。

因此，目前可以形成结构化 Spec 草案和执行已存在的合法 Task 流转，但不能声称完整的 Requirement → Spec → Plan → Implement → Review → Knowledge 生命周期已经可执行。缺少命令、状态、Knowledge 写入或授权记录时必须关闭失败，不得伪造产物、命令或授权。

初始化预览到确认期间需要保持短暂静默期，尤其不要并发修改 `AGENTS.md`；token 过期会拒绝写入并要求重新预览。`AGENTS.md` 发布不是跨文件原子事务，core 会保留 `.ezagent/backups/` 中的 backup/recovery 证据；若返回 inspection/recovery 路径，应保留现场、停止写入并按明确路径人工检查，不得猜测成功或自行删除证据。

平台验证状态：

- macOS 已完成本地验证，包括离线插件 smoke、完整测试、validator 和打包 dry run。
- Windows：pending first CI run。仓库已经提交 macOS/Windows GitHub Actions matrix，但在首次 push 后的 Windows runner 实际通过前不宣称 Windows 已验证。

## Local-only 与隐私边界

EZagent runtime 不会自动访问网络、发送遥测、安装软件、执行 Git commit/push、发布或上传用户项目。初始化默认使用 `gitTracking: none`。只有用户单独、明确授权后，宿主才可执行联网、安装、Git 写操作或发布动作；这些动作不是 EZagent runtime 的隐式副作用。

Local-only 只描述 EZagent 自身的运行边界，不改变 Codex 的模型处理、账号、组织策略或数据保留方式。公司仍需按自己的 Codex 管理策略使用产品。安装依赖时的 `npm ci`、管理员安装插件以及 Codex 自身通信不属于 EZagent runtime 的离线行为。

## 仓库开发

开发环境要求 Node.js 22：

```bash
npm ci
npm run plugin:verify
npm run verify
```

核心 CLI 也可以显式运行；普通同事的插件体验不需要手动输入这些命令：

```bash
node dist/src/cli/main.js doctor --root .
node dist/src/cli/main.js context --root . --json
```

成功结果是单行 JSON 并以状态码 `0` 退出。错误写入单行 stderr、不输出堆栈，并以非零状态码退出。测试只在登记的临时目录创建项目状态，禁止在仓库根初始化 `.ezagent/`。
