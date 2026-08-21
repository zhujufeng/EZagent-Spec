# EZagent Spec

面向中文团队的 Local-only Spec Coding Codex 插件。EZagent Spec 在项目内保存结构化需求、Spec、任务、专家、知识和质量证据，降低纯 vibe coding 的不确定性，并让上下文可以跨会话恢复。

> 当前为 `0.1.0` MVP。初始化、上下文恢复、Router、265 位中文专家目录和安全状态转换已经可用；完整 `capture/plan/replan/Knowledge` 生命周期仍在开发中，缺少能力时会关闭失败。

## 安装

要求 Codex 和 Node.js 22+：

```bash
codex plugin marketplace add zhujufeng/EZagent-Spec --ref main
codex plugin add ezagent-spec@ezagent
```

安装后新建一个 Codex 任务，让新安装的 Skills 生效。

### 更新

```bash
codex plugin marketplace upgrade ezagent
codex plugin remove ezagent-spec@ezagent
codex plugin add ezagent-spec@ezagent
```

更新后同样需要新建 Codex 任务。

### 卸载

```bash
codex plugin remove ezagent-spec@ezagent
codex plugin marketplace remove ezagent
```

## 让 Agent 安装

把下面这段话发送给 Codex Agent：

> 请帮我安装这个 Codex 插件：https://github.com/zhujufeng/EZagent-Spec 。先阅读 README，检查 Codex CLI 与 Node.js 22+；在联网、安装软件或修改 Codex 全局配置前先征得我的确认。安装 marketplace `ezagent` 和插件 `ezagent-spec` 后，提醒我新建一个 Codex 任务。

插件不会静默安装 Node.js。普通用户不需要在业务项目中执行 `npm install`；插件已包含自足 CLI、专家目录和运行时许可证。

## 在项目中启用

打开目标项目并说：

> 在当前项目启用 EZagent Spec。

初始化会先预览以下受管范围，确认项目根目录、项目名和写入范围后才执行：

- `.ezagent/**`
- `AGENTS.md#EZAGENT`
- `.codex/agents/ezagent-*.toml`

每个项目只需初始化一次。预览到确认期间应避免并发修改 `AGENTS.md`；token 过期会要求重新预览，不会覆盖并发改动。

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

如果初始化或受管文件发布返回 inspection、recovery 或 backup 路径，应停止写入并保留证据，不得猜测成功或自行删除恢复现场。

## Local-only 与隐私

EZagent runtime 不会自动访问网络、发送遥测、安装软件、执行 Git commit/push、发布或上传用户项目。初始化默认使用 `gitTracking: none`。联网、安装、Git 写入或发布必须由用户针对具体动作单独授权。

Local-only 只描述 EZagent runtime，不改变 Codex 的模型处理、账号、组织策略或数据保留方式。GitHub marketplace 安装、Codex 自身通信和开发者主动执行的 `npm ci` 不属于 EZagent runtime 的离线行为。

## 平台与验证

Windows 与 macOS GitHub Actions 已通过。运行时要求 Node.js 22+，CI 对两个平台运行相同的类型检查、测试、确定性插件检查和构建门。

## 开源与来源

EZagent Spec 使用 MIT License。

专家目录衍生自 MIT 许可的 [Agency Agents](https://github.com/msitarzewski/agency-agents) 与 [Agency Agents 中文项目](https://github.com/jnMetaCode/agency-agents-zh)。完整版权、来源和许可证见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) 与 `licenses/`。

本项目受 [Trellis](https://github.com/mindfold-ai/Trellis) 的结构化 Spec 工作流思想启发，但不包含、复制或调用 Trellis 的代码、模板、CLI 或运行时，也不声明格式兼容。

## 开发与贡献

开发环境使用 Node.js 22：

```bash
npm ci
npm run plugin:verify
npm run verify
```

核心 CLI 也可以显式运行；普通插件用户不需要手动输入这些命令：

```bash
node dist/src/cli/main.js doctor --root .
node dist/src/cli/main.js context --root . --json
```

成功结果是单行 JSON 并以状态码 `0` 退出。错误写入单行 stderr、不输出堆栈，并以非零状态码退出。测试只在登记的临时目录创建项目状态，禁止在仓库根初始化 `.ezagent/`。

贡献要求见 [CONTRIBUTING.md](CONTRIBUTING.md)，安全问题见 [SECURITY.md](SECURITY.md)。
