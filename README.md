# EZagent Spec

面向中文团队的 Local-only Spec Coding Codex 插件。EZagent Spec 在项目内保存结构化需求、Spec、任务、专家、知识和质量证据，降低纯 vibe coding 的不确定性，并让上下文可以跨会话恢复。

> 当前为 `0.1.0`。初始化、轻量共享上下文、Router、265 位中文专家目录、自动专家组队、Plan/replan、结构化 Knowledge、Pattern 晋升和 Task Finish 已形成闭环。当前版本有意关闭高风险 Task 实施；`light` 使用非持久化快速通道，`standard` 使用完整闭环。

## 安装

要求 Codex 和 Node.js 22+：

```bash
codex plugin marketplace add zhujufeng/EZagent-Spec --ref v0.1.0
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
3. Router 通过插件内自足 CLI 读取可信上下文和相关知识摘要，再路由到 Light、Context、Spec、Implement 或 Review Skill。
4. `.ezagent/**` 只能由本地核心修改，Skill 不能直接编辑状态文件。

### Light 与 standard

局部、低风险、可逆，并且不涉及依赖、数据模型、迁移、鉴权或安全边界、部署基础设施、公共 API 兼容性或跨模块架构的修改走 `light` 快速通道。Light 使用最多 5 项内部微计划，直接完成请求范围内的修改和聚焦验证，不创建 Requirement、Spec、Task、Knowledge 或专家团队，也不会再次请求流程批准。执行中发现范围扩大时会停止后续写入并升级为 `standard`。

`standard` 保留完整的持久化 Spec、自动组队、一次批准、独立 Review 和 Knowledge 闭环。不确定的行为变化默认按 `standard` 处理。

## 自动专家团队

用户不需要查看目录或手动挑选 Agent。Router 会先把需求整理成结构化 Plan，再由本地核心根据 capabilities、domains、project signals 和风险等级，从 265 位中文专家中确定一个尽量小的候选团队。`standard` 和 `high` 任务还必须包含一位没有参与实现的独立审查者；团队人数不是固定三位，超过软阈值时才额外请求确认。

Plan 和团队只确认一次。例如用户提出“给用户资料 API 增加输入校验”时，合并预览会类似：

```text
Plan: 实现用户资料输入校验
风险: standard
验收: 非法输入返回结构化错误；API 测试通过
团队:
  [implement] 工程实现专家 — 实现校验与回归测试
  [review] API 测试专家 — 独立只读审查失败路径
质量门: API 测试通过；实现者不得自审
```

用户批准后，本地核心会原子写入 Requirement、Spec、Task、团队历史和审计记录，并生成当前项目需要的 `.codex/agents/ezagent-*.toml`。后续新会话自动从 `context` 恢复同一个已批准团队，不会再次要求初始化或选专家。

如果实施中范围、风险、依赖或能力需求变化，Agent 必须停止编码并给出 replan 差异，例如：

```text
团队差异:
  added:   安全工程专家
  changed: 工程实现专家（新增安全校验交付物）
  removed: 无
```

只有用户批准 replacement Plan 后才更新团队并继续；取消 Task 时当前团队会退出 active 列表，但不可变团队历史仍保留用于恢复和审计。

质量门全部通过后，Review Skill 会把决策、约束、验证摘要、逐门 PASS 回执和后续事项整理成有界 Knowledge v2。每个回执包含与 active Task 精确匹配的 gate、实际命令、PASS 结果、退出码 0 和必要摘要；缺失、重复或未知 gate 都不能完成 Task。本地核心在一次原子事务中写入 `.ezagent/knowledge/decisions/`、完成 Task 并清退当前专家；新会话通过 `context` 恢复最近五条 Knowledge 摘要和内容哈希，不保存聊天全文。历史 Knowledge v1 保持可读，但新的完成请求必须使用 v2。

## 团队共享上下文与 Pattern

初始化仍默认 `gitTracking: none`，项目索引和 Knowledge 只保留在本地。需要团队共享时可以直接说“启用团队共享项目上下文”或“更新项目术语和架构入口”。Context Skill 会先展示共享范围和排除范围，取得一次明确批准后才把策略切换为 `gitTracking: artifacts`，并原子写入 `.ezagent/knowledge/project.yaml`。

项目索引只保存项目摘要、团队术语、稳定约束和项目内来源指针，不复制 README、完整设计文档或聊天。建议由团队自己的 Git 流程跟踪 project、Requirement、Spec、Task、Decision Knowledge 和 Pattern；审计、state、备份、运行缓存、完整测试输出及本地专家投影保持排除。EZagent 不修改 `.gitignore`，也不执行 `git add`、commit、push 或 PR。

Router 会从当前任务的标题、目标和结构化 selection 信号形成短查询词。本地核心使用确定性文本匹配返回最多 3 条正相关知识，再补充最多 2 条未重复的近期 Decision；结果只包含来源、路径、标题、摘要、内容哈希和分数。零分记录不会为了凑数进入相关结果，完整内容只在当前任务确有需要时按路径读取。检索无网络、无 embedding、无向量数据库，也不保存查询词。

如果某条 Task Knowledge 值得长期复用，可以说“把这条经验沉淀成团队 Pattern”。Context Skill 会提炼不含测试回执、命令、聊天和原始全文的 Pattern 预览；用户批准一次后，本地核心校验来源哈希和 workspace revision，再写入 `.ezagent/knowledge/patterns/SPEC-*.md`。来源漂移或同一 Spec 已存在 Pattern 时会关闭失败，不覆盖旧经验。

## 能力与边界

解释和只读咨询不会创建工作项。行为变化按 `light`、`standard` 或 `high` 分类；专家数量按任务能力动态选择，不固定为三位。所有多 Agent 委派都必须携带 Requirement、Spec、Task、expert、delegation、范围、交付物和质量门标识。

当前插件可以完成环境检测、集成预览、一次性初始化、项目索引与相关知识恢复、显式 artifact 共享、结构化 Plan 预览和原子批准、自动专家组队、项目专家生成、replan 差异与批准、受限状态转换、结构化 Knowledge、人工批准的 Pattern 晋升、Task Finish、Skills 路由和失败关闭。

当前版本不支持高风险 Task 实施：risk 为 `high` 的 Task 不能进入或返回 `implementing`，也不存在可由调用方填写的授权编号绕过入口。高风险需求可以被分析和规划，但实际实施应拆分、降险或交由人工流程处理。持久化的 `standard` Task 只有在 verifying 状态提交包含完整质量门回执的 Knowledge v2 后才能进入 `completed`；非持久化 light 通道不创建 Task 状态。

当前没有经过本项目验证的 `PreToolUse` interception contract。提示规则负责路由，本地核心的确定性状态转换负责关闭失败：revision、状态、批准或安全条件不满足时不会推进。

如果初始化或受管文件发布返回 inspection、recovery 或 backup 路径，应停止写入并保留证据，不得猜测成功或自行删除恢复现场。

## Local-only 与隐私

EZagent runtime 不会自动访问网络、发送遥测、安装软件、执行 Git commit/push、发布或上传用户项目。初始化默认使用 `gitTracking: none`；只有用户明确预览并批准后才切换为 `artifacts`，这仍然只写本地文件，不代表授权 EZagent 执行 Git。联网、安装、Git 写入或发布必须由用户针对具体动作单独授权。

Local-only 只描述 EZagent runtime，不改变 Codex 的模型处理、账号、组织策略或数据保留方式。GitHub marketplace 安装、Codex 自身通信和开发者主动执行的 `npm ci` 不属于 EZagent runtime 的离线行为。

## 平台与验证

运行时要求 Node.js 22+。GitHub Actions 对 Windows 与 macOS 运行相同的类型检查、测试、确定性插件检查和构建门；正式 tag 只在两个平台均通过后发布。

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
