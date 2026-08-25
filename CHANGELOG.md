# Changelog

## 0.4.1 - 2026-08-25

### 初始化连续性

- 修复“初始化 EZagent 并继续规划”组合请求在同一次任务中恢复旧工作流的问题；初始化成功后会重新提取剩余目标并显式交给 Router。
- Router 新增完成不变量：`context` 只负责读取可信上下文，只有明确模式、理由、下一个 Skill 并实际转交后才算完成路由。
- 生成的 `AGENTS.md` 明确 Router 是相关请求的顶层工作流所有者；其他 brainstorming、planning、coding 与 review 能力只能作为路由后的辅助能力。
- `integration-init` 新增机器可读 `continuation`，区分下一任务自动加载、同任务显式 Router 交接和无法交接时的新任务兜底。
- 初始化批准与 Work Contract 批准保持独立；组合请求最多生成 Work Preview，不会自动调用 `work-apply`。

### 回归验证

- 新增隔离式双轮 Codex post-init Host Eval，自动验证确认前零写入、`integration-preview → integration-init → context → work-preview` 精确序列、无 `work-apply`，以及仅写 EZagent 管理路径。
- 新增组合请求语料和交接契约测试，覆盖曾发生路由错误的 Go 云服务器工具规划场景。

### 兼容性说明

- `integration-init` 的成功 JSON 响应新增 `continuation` 字段；按完整对象做深度相等判断的调用方需要接受该新增字段。

## 0.4.0 - 2026-08-25

### 工作流可靠性

- 新增 `work-cancel`，允许显式取消废弃的 active Work Item、退役受管专家并继续创建新计划，同时保留完整审计历史。
- Specialist Delegation Receipt 改为按 Plan revision 分代存储；replan 后可安全复用委派内容未变化的历史回执，也可为同 ID 的变更委派创建新一代不可变回执。
- Work Contract 拒绝重复或成环的 `blockedBy` 依赖，并在错误中给出具体环路径。
- 新增独立的 v2 生命周期状态机，禁止 pending Slice 直接评审、并发执行多个 Slice，以及在依赖未接受时启动下游 Slice。
- `humanCheckpoint` 现在必须由要求 `human-approval` Evidence 的 Criterion 实际兑现。

### 兼容性说明

- 当前版本仍采用逐 Slice Review；`reviewAfterSlices` 仅接受 `1`。此前配置其他值但依赖其被静默忽略的 Work Contract 需要改为 `1`。
- 旧版状态转换表明确限定为 v1 compatibility lifecycle；v2 Controlled Mode 不再与旧版 high-risk 转换限制混用。

## 0.3.0 - 2026-08-25

### Claude Code 与 OpenCode

- 新增 Claude Code 插件清单和仓库级 marketplace，可复用同一套 Skills 与自足 CLI。
- 新增 OpenCode 配置与 Agent Skills 兼容验证；OpenCode 继续使用受管 `AGENTS.md` 自动路由。
- Specialist 在 Claude Code / OpenCode 中使用宿主原生隔离 subagent，并按 `expertId` 从打包目录加载同一专家定义。

## 0.2.1 - 2026-08-25

### 按需 Specialist 编排

- v2 Work Contract 新增显式 Specialist Assessment；Core 按 Capability Needs 确定性选择专家并在 Apply 后物化 project Agents。
- 新增绑定 Plan 指纹的不可变 Delegation start/completion receipts；Evidence 与 Delegation coverage 必须同时完整才能接受 Slice。
- 新增 Specialist-only replan、独立 reviewer 隔离以及完成/取消后的受管 Agent 自动退役，Plan 与 Receipt 历史保持可审计。

## 0.2.0 - 2026-08-24

### 通用 Agent Work Harness

- 新增领域中立的 Brief、Work Spec、Slices、Evidence、Work Journal、Decision 与 Controlled Side Effect 闭环。
- Router 使用 Consult、Quick、Brief、Standard、Controlled 五档模式，不按人员、岗位或部门分流。
- Specialist 和多 Agent 改为按需能力，不再是新工作项的前置条件；原 Spec Coding 专家团队流程作为 v1 兼容适配器保留。

### 元数据

- 插件开发者统一显示为 `zhujufeng`。

## 0.1.0 - 2026-08-22

### 新功能

- 提供初始化一次、后续自然语言自动路由的中文 Spec Coding Codex 插件。
- 内置 265 位可追溯中文专家，并按 Plan 动态选择少量项目级专家团队。
- 支持 Plan 原子批准、跨会话恢复、replan、独立审查和专家退场。
- 支持结构化 Knowledge 持久化、内容哈希恢复和 Task Finish 原子事务。

### 安全与边界

- runtime 默认 Local-only，不自动联网、安装、提交、推送、发布或上传用户项目。
- 当前版本明确关闭高风险 Task 实施，不提供可伪造的授权编号入口。
- 在 macOS 与 Windows 上执行相同的确定性插件和仓库验证门。
