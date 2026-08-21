# EZagent Spec 产品与 MVP 设计

> **Distribution note (2026-08-21):** 本文早期的封闭分发假设已由 `2026-08-21-ezagent-open-source-release-design.md` 取代；Local-only 运行边界与第三方许可证要求不变。

- 状态：已批准
- 日期：2026-08-20
- 产品：EZagent Spec
- 首发平台：Codex 插件
- 后续平台：Claude Code
- 运行环境：macOS、Windows
- 核心技术：TypeScript、Node.js

> **实施状态（2026-08-21）：** 本文描述的是获批的产品目标和完整 MVP，而不是当前分支已经全部交付的能力。当前 Codex 插件里程碑已通过 macOS 与 Windows GitHub Actions，验证初始化、上下文恢复、专家生成、自动 Router 和离线分发；`capture/plan/replan/Knowledge` 的完整持久化命令、高风险授权签发和无 Node.js 时的安装辅助仍属于后续 workflow/release 里程碑。缺少这些能力时实现必须关闭失败，不得伪造产物、命令或授权。

## 1. 摘要

EZagent Spec 是面向中文团队的 Spec Coding 插件。它把自然语言开发请求转化为可追踪的 Requirement、Spec、Task、Knowledge 和 Quality Gate，并从完整的中文专家目录中为当前项目动态选择合适的专家参与工作。

产品以 Codex 插件为第一优先。用户只在项目初始化时显式启用一次 EZagent；之后在该项目中的开发对话由插件自动识别和触发，不要求用户记忆命令。所有多 Agent 协作必须绑定结构化工作项并遵循统一状态流转。

EZagent 默认 Local-only：自己的状态、专家目录、审计和生成文件均保存在用户项目本地；不提供云端服务，不发送遥测，不自动联网，不自动提交或上传用户项目。

本产品学习 Trellis 的结构化 Spec 工作流思想，但独立实现自己的数据模型、状态机、模板、命令和插件架构。EZagent 不调用、不依赖、不打包、不复制 Trellis 的代码、模板或提示词。

## 2. 背景与问题

许多团队成员目前仍以 Vibe Coding 的方式使用代码 Agent：直接描述一个想法，让 Agent 立即修改代码，再通过多轮对话不断纠偏。这种方式在小型尝试中很直观，但进入真实项目后暴露出两个核心问题。

1. **开发效率较低。** 需求目标、范围、验收标准和实现约束没有先形成稳定 Spec，Agent 容易过早修改代码、理解偏移或只完成局部结果。用户需要反复解释、试错、回滚和重新验证，任务越复杂，返工成本越高。
2. **跨会话后 Agent 失忆。** 项目背景、已经确认的决策、当前进度、失败经验和后续任务主要留在单次聊天上下文中。新建会话、上下文压缩或切换协作者后，Agent 无法可靠恢复工作现场，用户必须重新讲述，Agent 也可能重复工作或推翻之前的正确决定。

根本原因不是 Agent 缺少生成代码的能力，而是需求、决策、任务状态、项目知识和验证结果没有沉淀为持久、结构化的项目上下文。

EZagent Spec 要把临时、依赖聊天记忆的 Vibe Coding 升级为中文 Spec Coding：在不增加日常命令负担的前提下，把每次开发工作纳入本地、可恢复、可验证的结构化流程，让 Agent 在跨会话后仍能继续正确工作。

## 3. 产品目标

### 3.1 必须实现

- 以中文自然语言为默认交互语言。
- 初始化一次后，后续开发意图自动触发 EZagent。
- 使用独立 TypeScript 本地核心管理确定性规则和状态。
- 支持 macOS 与 Windows。
- 使用 Requirement → Spec → Task → Implement → Verify → Finish 的结构化流程。
- 根据需求复杂度动态选择专家，不设置专家总数硬上限。
- 所有专家委派都必须绑定工作项、范围、交付物和质量门。
- 默认离线保存状态，不额外上传用户项目数据。
- 不自动运行 Git 提交、推送或 PR 操作。
- 能够从会话中断、Codex 重启和上下文压缩中恢复。

### 3.2 明确不做

- 不继续修改或复制旧 EZagent 桌面应用代码。
- MVP 不提供桌面 GUI、后台常驻服务、云端账号或团队服务器。
- MVP 不实现 Claude Code 适配，但核心接口不得依赖 Codex 专有格式。
- 不实现 Trellis 兼容层或 Trellis 项目导入。
- 不在运行时自动更新专家目录。
- 不在首版覆盖所有编程语言和框架。
- 不用非商业或内部使用作为绕过第三方许可证义务的理由。

## 4. 用户与核心体验

目标用户是中文团队中使用 Codex 开发或维护软件的用户。用户不需要理解 EZagent 的命令和内部状态机。

首次使用：

```text
安装 EZagent 插件
  → 检测操作系统和 Node.js
  → 必要时在用户同意后辅助安装 Node.js LTS
  → 预览将写入的项目文件
  → 初始化 .ezagent/ 与 Codex 项目集成
  → 写入受控 AGENTS.md 区块并完成插件自检
```

后续使用：

```text
用户自然语言消息
  → 项目 AGENTS.md 要求自动使用 Router Skill
  → Router Skill 调用打包 CLI 恢复状态并判断流程等级
  → 本地核心校验状态转换
  → 选择并编排所需专家
  → Plan → Implement → Verify → Finish
```

用户不需要输入 `/ezagent`、`ezagent plan` 或类似命令。CLI 是插件和调试工具的内部执行接口，不是日常交互入口。

## 5. 总体架构

采用“独立本地核心 + 平台适配层”，而不是 Trellis 包装器或纯提示词脚本。

```text
Codex Plugin
  ├── Skills：意图识别与可重复工作流
  ├── 打包 CLI：短生命周期上下文读取与确定性状态命令
  └── AGENTS.md：项目级持久规则
          ↓
Codex Adapter / CLI
  ├── doctor
  ├── init
  ├── context
  ├── transition
  ├── experts
  └── gate
          ↓
EZagent Core（TypeScript）
  ├── Workspace
  ├── Workflow State Machine
  ├── Expert Catalog and Selector
  ├── Delegation Contracts
  ├── Quality Gates
  ├── Privacy Policy
  └── Audit and Recovery
          ↓
项目内 .ezagent/ 文件系统
```

### 5.1 Codex 插件层

插件层负责对话触发、工作流说明、Codex 项目规则接入和结果展示，不保存业务状态，也不复制核心规则。

- Node.js 可用前的启动检测由无 Node 依赖的系统脚本完成：macOS 使用系统 Shell，Windows 使用 PowerShell。检测只读取环境，不联网；只有用户同意安装后才允许调用系统安装机制。
- 一个宽触发面的 Router Skill 处理已初始化项目中的开发、修改、修复、重构、审查和验证请求，并在开始工作时调用打包 CLI 读取当前状态。
- 初始化、Spec、实现和审查 Skills 提供边界清晰、可重复的子流程；它们只通过本地核心改变 `.ezagent/**`。
- 项目根 `AGENTS.md` 保存简短、稳定的 EZagent 项目规则，要求发现 `.ezagent/project.yaml` 后自动使用 Router Skill，因此新会话和上下文压缩后仍能恢复流程。
- 当前 Codex 插件契约没有稳定、可验证的每轮 Hook 或 `PreToolUse` 拦截接口；MVP 不声明不存在的工具级 Hook 能力。未来只有在 Codex 发布并可自动化验证该契约后才增加 Hook 适配层。

Node.js 缺失时，启动脚本应安全退出并向 Codex 返回可操作提示，不能使普通对话失败。Node.js 安装完成后必须重新检测，验证通过后才能调用 TypeScript 核心。

### 5.2 本地核心

本地核心是短生命周期的确定性执行器，不是后台服务：插件调用时启动，完成一次操作后退出。

面向最终用户的插件发布物包含已经编译或打包的 JavaScript。用户不需要安装 TypeScript、克隆源码或执行 `npm install`；只需要受支持的 Node.js LTS 运行时。

核心负责：

- 初始化、读取和校验工作区。
- 生成稳定 ID 和修订号。
- 校验状态转换和审批条件。
- 筛选、去重和记录专家选择。
- 验证委派契约与质量门。
- 对工作区事实文件执行原子写入，并对外部集成文件执行可恢复发布、审计和迁移。
- 生成 Codex 项目级专家适配文件。

核心不负责：

- 调用模型或选择模型供应商。
- 常驻监听文件或端口。
- 自动访问网络。
- 自动执行 Git 写操作。

### 5.3 平台适配

核心输出平台无关的专家与任务描述。Codex 适配器将当前项目选中的专家生成到 `.codex/agents/ezagent-*.toml`。未来 Claude Code 适配器读取相同的 `.ezagent/` 状态并生成 Claude Code 所需格式，而不改变核心领域模型。

## 6. 自动触发与安全兜底

自动触发采用当前 Codex 可安装、可验证的两层机制：插件 Skill 负责语义路由，项目 `AGENTS.md` 负责跨会话持久激活。确定性规则仍由本地核心验证，不能由提示词绕过。

### 6.1 Router Skill

Router Skill 对已初始化项目中的相关自然语言请求执行以下逻辑：

1. 从当前目录向上定位项目根。
2. 不存在 `.ezagent/project.yaml` 时退出 EZagent 流程，不产生副作用。
3. 存在工作区时调用插件内打包 CLI，读取当前阶段、活动工作项、质量门和专家摘要。
4. 把请求分类为 `consult`、`light`、`standard` 或 `high`，但不保存完整用户提示。
5. 把结构化分类结果交给核心校验，不能直接编辑状态文件。

Skill 不复制状态机、审批或质量门逻辑；这些规则只存在于核心。

### 6.2 项目规则

初始化在项目根 `AGENTS.md` 中创建一个带起止标记的 EZagent 区块。该区块要求：

- 发现 `.ezagent/project.yaml` 后自动遵守 EZagent 工作流。
- 修改类请求在写文件前必须取得有效工作项和质量门授权。
- 多 Agent 委派必须使用 EZagent 委派契约。
- 用户无需显式调用 EZagent 命令。

初始化只管理自己的标记区块，必须保留所有用户已有内容。重复初始化不得产生重复区块。

### 6.3 核心失败关闭

当前 Codex 插件层不声称能够拦截每一次工具调用。安全兜底由以下可验证边界组成：

- `AGENTS.md` 与 Skills 要求修改前先取得有效工作项、Task 范围和质量门。
- 所有 `.ezagent/**` 状态变化只能通过打包 CLI；核心拒绝非法状态跳转、过期 revision、缺少审批和缺少高风险单次授权的命令。
- 生成的实现专家仅获得已批准 Task 的范围；分析与审查专家保持只读。
- 外部终端或其他应用中的操作不在 EZagent 控制范围内。

这不是工具级强制隔离。若未来 Codex 提供稳定的原生 Hook 或策略接口，可把同一核心决策函数接入该接口，而不改变领域模型。

## 7. 意图分级与工作流

### 7.1 四级意图

| 等级 | 示例 | 行为 |
|---|---|---|
| 咨询 | “解释这个函数” | 正常回答，不创建工作项，不强制进入 Spec |
| 轻量 | 文案、局部低风险配置、小范围明确修复 | 自动生成轻量 Spec，记录目标和验证方式后执行 |
| 标准 | 新功能、行为变化、跨文件重构 | 生成正式 Spec，用户批准后才能实现 |
| 高风险 | 数据删除、不可逆迁移、外部上传、安全边界变化 | 正式 Spec、用户批准和单独动作授权缺一不可 |

如果请求同时包含咨询与修改，以修改等级处理。如果无法可靠判断是否会改变行为，先澄清；仍不确定时按标准变更处理。

### 7.2 状态流转

正式工作项使用以下状态：

```text
captured
  → clarifying
  → specified
  → approved
  → planned
  → implementing
  → verifying
  → completed
```

允许的回退：

- `clarifying → captured`：需求被撤回或重新描述。
- `specified → clarifying`：审批反馈要求补充。
- `verifying → implementing`：验证失败并生成修复任务。
- 任意未完成状态 → `cancelled`：用户明确取消。

不允许跳过 `approved` 直接进入正式实现。轻量工作项创建时由策略自动批准，但仍必须保留轻量 Spec 和验证记录。高风险动作的单独授权具有明确范围和一次性使用语义。

### 7.3 完整工作流

1. **Capture**：把变更意图整理为 Requirement，保留用户目标而非整段聊天。
2. **Clarify**：只询问影响范围、验收标准和风险所需的问题。
3. **Specify**：形成目标、非目标、行为、约束、验收标准和验证方法。
4. **Approve**：按流程等级执行自动批准、Spec 批准或高风险授权。
5. **Plan**：拆分有依赖、范围和完成标准的 Task。
6. **Implement**：只执行已批准 Task，并记录重要状态变化。
7. **Verify**：运行项目适用的测试、静态检查和专家审查。
8. **Finish**：确认验收条件，更新 Knowledge，生成本地总结；不自动提交 Git。

## 8. 中文专家目录

### 8.1 来源范围

MVP 收录：

- Agency Agents 英文上游的专家定义。
- `agency-agents-zh` 中对应的中文翻译。
- `agency-agents-zh` 中面向中国场景的原创专家。

当前中文项目文档声称约有 215 位上游翻译专家和 53 位中国原创专家，但不同清单存在计数差异。EZagent 不把 README 数字作为事实来源，而由导入器对指定 Commit 的实际文件执行清点、去重和验证。

### 8.2 规范化记录

每位专家必须具有：

```yaml
id: ezagent.frontend.architect
name_zh: 前端架构师
summary_zh: ...
capabilities: []
domains: []
project_signals: []
activation_conditions: []
exclusion_conditions: []
preferred_tasks: []
quality_gates: []
origin: upstream_translation | china_original
source:
  repository: ...
  path: ...
  commit: <full-sha>
  license: MIT
content_hash: sha256:...
```

导入器只接受完整 Commit SHA，不接受可移动分支名。运行时使用随插件发布的只读规范化快照，不访问上游仓库。

### 8.3 不导入的内容

- 上游或中文项目的编排器与 DAG 实现。
- 安装、转换、发布和在线服务脚本。
- 广告、赞助服务和外部服务依赖。
- 与 Codex、Claude 或其他工具强绑定的用户目录路径。
- 无法确认来源或许可证的内容。

## 9. 自适应专家编排

专家数量不设总数硬上限。系统依据以下因素选择和扩展专家：

- 独立专业领域数量。
- Task 图中可以并行的工作。
- 风险等级和独立审查要求。
- 当前项目技术栈和已有 Knowledge。
- 已选专家是否已经覆盖所需能力。

简单任务可以不启用子 Agent；单一领域通常只需少量专家；跨产品、架构、前端、后端、数据、安全和测试的复杂需求可以分多批使用更多专家。

### 9.1 防止无效扩张

- 每位专家必须有启用理由、任务范围、交付物和退出条件。
- 职责高度重叠的专家不得重复分析同一问题。
- 可以并行读取和分析，但状态写入只能由主协调 Agent 完成。
- 并发量受当前 Codex 运行环境和项目设置限制，总专家数可通过多批次扩展。
- `expert_policy.review_after` 是可配置的软阈值，默认值为 6 次 Agent 运行；超过时只要求展示协作方案并取得确认，不构成总数上限。

### 9.2 项目级专家

`.ezagent/experts/active.yaml` 是当前项目专家选择的事实来源。Codex 适配器只为实际启用的专家生成 `.codex/agents/ezagent-*.toml`，不会把完整目录注入上下文。

专家可以在执行中动态追加。当新增能力缺口得到证明时，核心记录选择理由并生成新的适配文件；不再需要的专家退出当前工作项，但仍保留审计记录。

### 9.3 委派契约

每次子 Agent 委派必须携带：

```yaml
spec_id: SPEC-20260820-001
task_id: TASK-20260820-003
expert_id: ezagent.frontend.architect
scope: 只分析页面状态与组件边界
inputs:
  - 已批准的 Spec
  - 允许读取的代码路径
deliverables:
  - 设计结论
  - 风险清单
quality_gates:
  - 不修改代码
  - 结论引用实际文件
```

子 Agent 不能自行扩大范围、改变工作项状态或跳过质量门。主协调 Agent 负责汇总、解决冲突并推进状态。

## 10. 本地工作区与数据格式

```text
.ezagent/
├── project.yaml
├── state/
│   └── workspace.json
├── requirements/
│   └── REQ-*.md
├── specs/
│   └── SPEC-*/spec.md
├── tasks/
│   └── TASK-*.md
├── knowledge/
│   ├── decisions/
│   └── patterns/
├── experts/
│   ├── active.yaml
│   └── catalog-lock.json
├── quality/
│   ├── gates.yaml
│   └── runs/
├── audit/
│   └── events.jsonl
└── backups/
```

### 10.1 事实来源

- Requirement、Spec、Task 和 Knowledge 使用 Markdown + YAML frontmatter。
- 项目策略、专家选择和质量门使用 YAML。
- `catalog-lock.json`、验证结果和可重建索引使用 JSON。
- `events.jsonl` 是追加式审计流。
- `workspace.json` 只保存当前指针、schema 版本和可重建投影，不复制正文。

正文与 frontmatter 是工作项事实来源。索引丢失后可以从工作项和事件流重建。所有机器状态修改必须经过核心；人工编辑会在下一次读取时接受 schema 与 revision 校验。

### 10.2 项目外观与 Git

初始化可能触及的路径仅限：

- `.ezagent/**`
- `AGENTS.md` 中 EZagent 标记区块
- `.codex/agents/ezagent-*.toml`

初始化必须先展示写入预览。EZagent 不执行 `git add`、`commit`、`push` 或 PR 操作。

`project.yaml` 提供 `git_tracking` 策略：

- `none`：默认，EZagent 建议将全部本地工作区排除在版本控制外。
- `artifacts`：允许 Requirement、Spec、Task 和 Knowledge 进入版本控制，排除审计、备份和运行缓存。
- `all`：不添加排除建议，仍不自动暂存或提交。

对已被 Git 跟踪的文件，EZagent 不会通过 ignore 规则隐藏已有变更。

## 11. 一致性、并发与恢复

### 11.1 写入规则

- `.ezagent/**` 事实文件使用临时文件、完整校验后原子替换。
- `AGENTS.md` 属于用户拥有的外部集成文件。初始化先做 preview token 比对，再创建独立、耐久的 `.bak` 与 `.next` 恢复副本；缺失目标仅以 no-clobber 方式创建，既有目标通过 no-follow 文件句柄更新。
- Node.js 在 macOS 与 Windows 上没有统一的“按 inode 比较后原子替换且绝不覆盖新目标”原语，因此 MVP 不宣称 `AGENTS.md` 更新对并发读者不可见，也不宣称所有 I/O 失败会自动回滚。写入失败时目标可能处于部分更新状态，但恢复副本必须完整保留并在错误中报告路径。
- 项目初始化应在项目静默期执行；初始化期间不得由编辑器、脚本或其他 Agent 同时修改 `AGENTS.md`、新增 hard link，或替换项目根、`.ezagent`、`backups` 祖先目录。
- 每次状态变更检查 `revision`。
- 使用工作区内短期锁串行化状态写入。
- 专家可以并行读取，只有主协调 Agent 可以写状态。
- 审计事件包含开始、完成或失败结果，未完成事件不会被视为成功转换。

### 11.2 恢复规则

- 会话重启后从最后一个完整状态和审计事件恢复。
- 临时文件存在时先验证目标文件；不自动用临时文件覆盖有效数据。
- 缓存损坏时从事实来源重建。
- 事实来源无法解析时进入只读安全模式，运行 `doctor` 给出定位信息。
- schema 升级前创建本地备份，迁移失败则保留原文件并停止写入。
- `AGENTS.md` 发布失败后不自动删除目标或恢复证据；用户按错误中报告的 `.bak`、`.next` 或 recovery 路径检查并恢复。
- 初始化拒绝符号链接、初始 hard link、非普通文件、超限文件、BOM 和非法 UTF-8。纯 Node.js MVP 会检测祖先替换与并发 hard link，但无法用 dirfd 在恶意同用户竞态下保证零越界写入；并发新增的 hard link 还可能在事后检测前观察到句柄写入。检测到异常后失败关闭并保留证据。
- macOS 与 Windows 的目录 sync 是 best-effort；不支持或权限拒绝时可能跳过。成功返回表示进程内身份与内容校验通过，不保证断电或系统崩溃后的目录项持久性。
- 不使用静默重置、批量删除或不可恢复修复。

### 11.3 生成文件

Codex Agent TOML 是可重建适配文件。EZagent 只拥有 `.ezagent/experts/generated-codex.json` 中记录了文件名与精确哈希的 `ezagent-*` 文件；未知的 `ezagent-*` 与所有其他 Agent 均视为用户文件，不按前缀擅自处理。

更新或停用已拥有文件时，EZagent 先将原字节移动到唯一恢复目录，再以 no-clobber 方式发布独立新副本；不得用按路径删除作为回滚。多文件同步和最终所有权清单不是一个跨文件原子事务：失败时保留 recovery、backup 和 next 证据并报告路径，重试只接纳哈希等于目标内容的已发布文件或已经缺失的过期文件。同步应在项目静默期执行。

## 12. 隐私与安全边界

Local-only 对 EZagent 的含义是：

- 不提供 EZagent 云端后端。
- 不发送遥测、崩溃日志、使用统计或专家选择记录。
- 正常运行不访问网络。
- 专家目录是离线发布快照。
- Node.js 安装、插件更新和专家快照更新只有在用户明确同意后才能联网。
- 审计默认记录事件类型、工作项 ID、状态、时间、修订号和内容哈希，不保存完整提示、密钥或终端输出。
- 不自动进行 Git 写操作或远程上传。

EZagent 的 Local-only 不改变 Codex 本身的模型处理、账号、组织策略或数据保留方式。使用方仍应按自己的 Codex 管理策略使用产品。

Router Skill 从 CLI 读取的摘要不得包含秘密或大段项目内容，只包含当前阶段、工作项摘要、允许动作、质量门和专家 ID。

## 13. 第三方许可证边界

### 13.1 Agency Agents

Agency Agents 英文项目和中文翻译项目均使用 MIT License。EZagent 可以规范化和内部分发相关专家内容，但必须保留许可证与版权声明。

发布包必须包含：

```text
LICENSE
THIRD_PARTY_NOTICES.md
licenses/
├── agency-agents-MIT.txt
└── agency-agents-zh-MIT.txt
```

规范化目录中的每条记录都保存来源仓库、文件、完整 Commit SHA、许可证、内容哈希以及翻译或原创标识。

### 13.2 Trellis

Trellis 使用 AGPL-3.0。EZagent 不通过“内部使用”或“非商业”解释来缩小其许可证义务，而是通过清晰的独立实现边界避免引入其受版权保护的实现内容：

- 不复制源代码。
- 不翻译或改写其模板和提示词作为产品内容。
- 不调用或打包其 CLI。
- 不声明格式兼容。
- 不把 Trellis 作为运行时或构建依赖。

产品文档可以注明受到结构化 Spec 工作流思想启发，并链接原项目，但 EZagent 的 PRD、schema、状态机、模板和实现均独立创作。

## 14. MVP 范围

### 14.1 包含

- macOS 与 Windows 环境检测。
- Node.js LTS 检查及经用户同意的安装辅助。
- 一次性项目初始化和重复初始化幂等性。
- 自动触发 Router Skill、项目规则和打包 CLI 上下文恢复。
- `.ezagent/` 工作区和状态机。
- 咨询、轻量、标准、高风险四级分类。
- Requirement、Spec、Task、Knowledge、Quality Gate 和 Audit。
- 离线中文专家目录、项目画像、自适应选择和 Codex Agent 生成。
- 标准 Spec 审批、高风险单独授权和工具调用兜底。
- 中断恢复、冲突检测和只读安全模式。
- 完整第三方许可证与来源校验。

### 14.2 不包含

- Claude Code 适配器。
- GUI、后台服务、账号系统、远程同步和遥测。
- 自动目录更新。
- Trellis 兼容或导入。
- 自动 Git 提交、推送和 PR。
- 旧 EZagent 桌面代码迁移。

## 15. MVP 端到端场景

### 15.1 轻量修改

输入：“把登录按钮文案改成登录系统。”

期望：自动识别为低风险小改动，生成包含目标、范围和验证方式的轻量 Spec，执行修改并记录验证结果，不要求正式审批。

### 15.2 标准功能

输入：“给用户列表增加 Excel 导出。”

期望：形成正式 Requirement 和 Spec，根据项目栈动态选择所需专家，等待用户批准后拆 Task、实现、验证并完成。批准前写入项目代码应被阻止。

### 15.3 高风险变更

输入：“迁移用户表并删除旧字段。”

期望：识别数据迁移与删除风险，要求正式 Spec 批准和一次性动作授权。缺少任一授权时不得执行写入或破坏性命令。

## 16. 测试策略

### 16.1 核心单元测试

- 状态机合法与非法转换。
- 四级意图策略和不确定请求的安全默认。
- 专家目录解析、去重、评分、扩展和软阈值。
- 委派契约与质量门。
- revision 冲突、原子写入、短期锁和事件记录。
- `AGENTS.md` preview token、no-follow 有界读取、独立恢复副本、部分写入、竞争发布和人工恢复路径。
- Windows 与 macOS 路径行为。
- 网络、Git 和路径边界策略。

### 16.2 插件契约测试

- Router Skill 在初始化和未初始化项目中的行为。
- `AGENTS.md` 标记区块幂等合并。
- 只管理 `ezagent-*` Agent 文件。
- Skills 的直接、间接、模糊和负向触发用例。
- 新会话、恢复和上下文压缩后通过项目规则重新读取状态。
- 未批准阶段的核心命令失败关闭行为。

### 16.3 集成与端到端测试

- Node.js 缺失、版本不支持和安装失败。
- 三个 MVP 场景。
- Codex 中断并重新打开。
- 多 Agent revision 冲突。
- 人工修改 Spec。
- 缓存、审计和事实来源损坏。
- 验证失败回到 Implement。
- 动态增加专家和多批次执行。
- 已有 `AGENTS.md`、`.codex/agents/` 和用户配置保护。
- 初始化静默期约束、并发 hard link/祖先替换检测，以及失败后 `.bak/.next` 人工恢复。

### 16.4 隐私与许可证测试

- 默认运行没有 EZagent 网络请求。
- 审计不包含完整提示、密钥和终端输出。
- 不产生自动 Commit、Push 或 PR。
- 每条专家记录具备完整来源和内容哈希。
- 发布包包含 MIT 版权声明。
- 构建和发布产物不包含 Trellis 源码、模板或依赖。

产品仓库可以在私有 CI 中运行跨平台测试；CI 不接触任何最终用户项目数据。

## 17. MVP 验收标准

以下条件必须全部满足：

- 初始化后用户无需记忆或输入 EZagent 命令。
- 自然语言开发需求能够自动进入正确流程等级。
- 普通咨询不会被强制创建 Spec。
- 标准变更在 Spec 批准前不能实现。
- 高风险动作在单独授权前不能执行。
- 专家数量动态决定且无总数硬上限，每位专家职责可解释。
- 所有专家工作绑定 Requirement、Spec 或 Task。
- 验证失败不能标记完成。
- Codex 重启后能从最后一致状态恢复。
- macOS 与 Windows 通过同一核心测试套件。
- 默认离线、不上传、不遥测、不自动操作 Git。
- 重复初始化不覆盖或重复用户配置。
- 日常本地上下文命令的目标为 p95 不超过 250ms。
- 专家目录、来源和第三方许可证检查全部通过。

## 18. 后续演进

MVP 完成后优先考虑：

1. Claude Code 适配器，共用现有核心与 `.ezagent/` 工作区。
2. 经用户明确发起的专家目录升级与差异审查。
3. 更丰富的项目质量门模板。
4. 在不引入云端依赖的前提下改善本地状态可视化。

这些方向不进入当前 MVP 实施计划。

## 19. 参考来源

- [Trellis](https://github.com/mindfold-ai/Trellis)
- [Trellis License](https://github.com/mindfold-ai/Trellis/blob/main/LICENSE)
- [Agency Agents](https://github.com/msitarzewski/agency-agents)
- [Agency Agents License](https://github.com/msitarzewski/agency-agents/blob/main/LICENSE)
- [Agency Agents 中文项目](https://github.com/jnMetaCode/agency-agents-zh)
- [Agency Agents 中文项目 License](https://github.com/jnMetaCode/agency-agents-zh/blob/main/LICENSE)
- [Agency Agents 中文项目上游映射](https://github.com/jnMetaCode/agency-agents-zh/blob/main/UPSTREAM.md)
- [OpenAI：Build skills](https://developers.openai.com/plugins/build/skills)
- [OpenAI：AGENTS.md](https://learn.chatgpt.com/docs/agent-configuration/agents-md)
- [OpenAI：Subagents](https://learn.chatgpt.com/docs/agent-configuration/subagents)
