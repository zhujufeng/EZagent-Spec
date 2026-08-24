# Changelog

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
