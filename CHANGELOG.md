# Changelog

## 0.5.0 - 2026-08-26

### Agent 宿主可靠性

- 所有 JSON 输入命令新增有界 `--input-file` 通道；Codex、Claude Code 或 OpenCode 使用 PTY 且无法可靠关闭 stdin EOF 时，不再后台等待或依赖 shell 重定向。
- 五个会提交 JSON 的 canonical Skills 统一要求：优先使用会关闭 EOF 的非交互 stdin；必要时使用权限受限、非符号链接的临时普通文件，并让 Preview 与 Apply 复用完全相同的输入字节。
- Router 现在先按用户要求的 Outcome、影响和可逆性定模式；源码、样本、写权限或 CodeGraph 等辅助工具缺失只会成为后续 blocker，不再把 Brief/Standard/Controlled 错降为 Consult。新增导出、可复核多样本分析，以及“询问协作角色并要求开始项目流程”等边界也给出明确判定。

### Specialist 可审计委派

- Core 现在从已批准 delegation 生成唯一 `specialist-dispatch`，并把它作为 `delegation-start` 的机器可读结果返回；协调器必须原样交给隔离 Specialist。
- 新生成的 start/completion receipt 升级为 schema v2，并用 `dispatchFingerprint` 绑定 Work Item、Work Spec、Slice、专家、范围、交付接口、Criterion 与 Evidence requirements。
- completion 必须回填 start receipt 的同一指纹；计划、专家或 dispatch 漂移会在写入回执前关闭失败。既有 schema v1 receipt 继续兼容读取与完成。

### Workspace 文件系统加固

- `WorkspaceRepository` 在构造时规范化真实项目根并绑定稳定文件 identity；根目录被替换后，初始化、读取和 mutation 会停止。
- mutation 在发布 pending marker 前捕获 `.ezagent` 与写入祖先 identity，并在目录创建、每次 artifact 写入、audit、state 和 marker 清理前后复核；发现替换时保留恢复证据并关闭失败。
- portable 文件名冲突检查扩展到父目录中的存量文件，阻止大小写、NFKC 或 Unicode case-fold 等价名称在 macOS 与 Windows 间发生覆盖或不可移植双文件。

### 面向非开发同事的文档

- README 新增从 Node.js 预检、插件安装、新建任务、项目初始化、Work Preview 确认、执行/恢复/取消到故障排查的完整中文教程。
- 明确说明 Specialist 由自然语言能力需求自动评估，普通任务没有 Specialist 是正常结果；同时公开 Local-only、Side Effect 与可信本机威胁模型边界。

### 兼容性说明

- `--input-file` 是兼容新增选项，原 stdin 调用保持不变。
- 0.5.0 创建的 delegation start receipt 使用 schema v2，因此 completion 也必须使用 schema v2 并提供 `dispatchFingerprint`；升级前已经存在的 schema v1 start receipt 仍按 v1 完成。
- Node.js 最低版本仍为 22。

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
