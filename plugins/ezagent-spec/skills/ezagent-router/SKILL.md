---
name: ezagent-router
description: 在已初始化项目中，把编码、分析、文档、策划及其他 Agent 工作路由到最轻且足够可靠的 EZagent Work Mode，并在需要时选择先规划后实施；只读咨询不创建工作项。
---

# EZagent Router

## 激活与上下文

从当前目录向上查找项目根目录。只有找到 `.ezagent/project.yaml` 才进入工作流；未找到时，普通请求不触发 EZagent，只有用户明确要求启用、初始化或安装时才转 `$ezagent-initialize`。岗位、部门和业务名称只属于领域上下文，不得成为固定角色枚举或专属流程。

支持 lifecycle Hook 的宿主会在每个用户回合重新声明 Router 所有权。Hook 注入只表示本次请求必须重新路由，不代表已读取状态、已选择 Work Mode 或已完成 Skill 转交；不得沿用上一需求的 Router 结论。

Hook 同时提供由宿主 session ID 单向哈希得到的 `session key` 时，本回合及转交后的所有 EZagent CLI 调用都必须把它作为独立的 `--session` 参数传递。不得自行改写、缩短或使用原始宿主 session ID。Hook 没有提供 session key 的宿主省略该参数，继续使用向后兼容的项目级单任务模式。

编码、分析、文档、策划以及其他 Agent 工作使用同一套路由原则；这些是非穷尽任务示例，不对应固定人员范围。

先取当前 `SKILL.md` 所在目录，再向上两级得到 `<plugin-root>`，把 `dist/ezagent-cli.mjs` 解析为 `<absolute-cli-path>` 绝对路径；不要在 `PATH` 中搜索其他 EZagent，也不要要求用户输入或运行 CLI。

必须使用支持 argv 数组的进程执行接口，禁止拼接 shell 字符串。每个动态值必须作为一个独立 argv 元素。若宿主只支持 shell 字符串，必须按当前 shell 的 literal 规则完整编码每个参数；无法证明编码正确就关闭失败，不得仅自行添加双引号。

Router 只有 `knowledge-context` 需要 JSON 输入。优先使用可关闭的非交互 stdin pipe，写入一个 JSON 文档后明确发送 EOF；PTY 无法可靠关闭 stdin EOF 时，使用宿主文件能力把同一 JSON 写入操作系统临时目录、项目根目录之外的新建权限受限普通文件，以 `--input-file` 传入，不得使用符号链接、shell 管道、重定向或命令替换，并在命令结束后删除。只有 stdin 无法关闭且上述临时文件也禁止写入时，才用 `--input-json` 传递不超过 24,576 bytes 和 24,576 字符的 UTF-8 单文档。argv 可能被记录；内容含密钥、token、个人敏感信息、超限或无法安全作为独立 argv 元素时关闭失败，不得退回 PTY 试探或重复启动命令。

每次相关工作先读取可信上下文：

```json
["node", "<absolute-cli-path>", "context", "--root", "<absolute-project-root>", "--json"]
```

`context` 只是路由的准备动作，不代表完成路由。Router 是当前请求的顶层工作流所有者；其他 brainstorming、planning、coding 或 review 能力只能在 Router 选定模式并实际转交后作为辅助能力使用。

一次 Router 决策只有在明确记录模式、选择理由、下一个 Skill，并实际转交后才算完成：Consult 直接回答；Quick 转 `$ezagent-light`；Brief、Standard 或 Controlled 转 `$ezagent-spec`；已有 active Work Item 按下述状态转 `$ezagent-execute`、`$ezagent-implement` 或 `$ezagent-review`。不得只重复执行 `context` 后继续旧工作流或结束任务。

必须先根据用户要求的 Outcome、影响与可逆性选择模式，再处理 blocker、未决问题或假设。源码或数据缺失、当前是只读 sandbox、CodeGraph 等辅助工具不可用或未初始化、当前权限不足，都不得把 Quick、Brief、Standard 或 Controlled 请求降级为 Consult。当前条件不能实施时仍须完成路由并实际转交；由下一个 Skill 记录缺口、形成安全预览或只追问一个会改变结果的问题。工具和权限状态不改变用户要求本身。

CodeGraph 在所有模式（包括 Consult 与 Quick）中都只是可选加速器。未提供或返回未初始化时，立即改用宿主的文件列举、文本搜索和读取；相关源码本身不存在时，说明事实缺口并完成仍可可靠回答的部分。不得仅为当前请求询问、安装或初始化 CodeGraph，不得把索引缺失当成 blocker。

用户请求与可信 `context` 已足以定义 Outcome、边界和验收方式，且 Work Contract 的准确性不依赖现有项目事实时，直接定义。

若 Work Preview 的准确性取决于现有项目事实，例如现有代码、配置、测试拓扑、文档结构或数据 schema，生成合同前必须做一次有界、定向、只读的事实预检。已有可用的结构化索引时使用它；否则使用宿主自带的文件列举、文本搜索和读取能力。不得要求用户安装或初始化 CodeGraph，也不得因此阻塞预览。预检最多 2 次定向搜索、最多 8 个直接相关文件读取；不得全库爬取、读取密钥或个人敏感信息、构建、测试、安装或写入。只记录会改变范围、交付物、Slice 或验收条件的简短事实和精确 Source Pointers；只有已实际观察到的现有路径才能写成事实，新路径必须标记为建议或拟新增。未解决的实现细节记为假设、未决问题或放入第一个 Tracer Slice；预检无法实质提高可验证性时跳过。

若用户明确要求取消或放弃当前 active Work Item，先展示将终止的 Work Item、当前状态，以及 Plan、Receipt、Evidence 与 Journal 历史仍会保留；不得把范围变化或执行困难自行解释为取消。重新执行 `context` 取得最近的 `state.activeWorkItem.revision`，active item 已为空时不得调用取消命令：

```json
["node", "<absolute-cli-path>", "work-cancel", "--root", "<absolute-project-root>", "--revision", "<active-work-item-revision>"]
```

取消后重新执行 `context`，只有确认 `state.activeWorkItem` 为 null 且平台同步状态不再有该任务的 active Agents，才可为新请求继续路由。

## 状态、继续与完成

用户询问状态或进度时只读，不得启动 Slice、调用 mutation 或改变路由状态。使用同一 `session key` 重新执行 `context`，只展示一份紧凑视图：目标、进度（accepted / total）、最近结果（Journal 或 Evidence）、阻塞、下一步、工件目录。完整状态仍可在 `.ezagent/state/workspace.json` 查看，Plan、Spec、Task、Evidence 与 Decision 仍保留在核心返回的可见路径中。

用户要求继续时，先展示同一份紧凑视图，再按当前状态转交：v2 的 pending、executing 或 revise 转 `$ezagent-execute`，verifying 转 `$ezagent-review`；v1 只走下述旧适配器。不得重新创建 Work Item 或重复已经 accepted 的 Slice。

用户要求完成时不得跳过 Evidence 或 Review：存在 pending、executing 或 revise Slice 时先转 `$ezagent-execute`，verifying 时转 `$ezagent-review`；只有全部 Slice accepted 且 Decision 经核心验证、`context` 确认 active item 已清空后，才能声称完成。

安全模式或 `inspection-required` 只做诊断。若存在 active Work Item：

- `sourceSchemaVersion: 2` 且有 pending、executing 或 revise Slice：转 `$ezagent-execute`。
- `sourceSchemaVersion: 2` 且 Work Item 为 verifying：转 `$ezagent-review`。
- `sourceSchemaVersion: 1`：保持旧编码适配器，planned/implementing 转 `$ezagent-implement`，verifying 转 `$ezagent-review`。

## 选择最轻 Work Mode

用户可见体验只分三档，内部仍保留完整 Work Mode 和状态机：

- **直接工作**：Consult 与 Quick，直接回答或完成局部修改。
- **普通工作**：Brief 与 Standard，用一份紧凑预览确认目标、交付和完成条件后执行。
- **受控工作**：Controlled，完整展示边界、批准点和外部 Side Effect 风险。

Router 仍必须记录精确 Mode 和下一个 Skill，但对用户先使用上述普通语言，可在同一短句中附上内部 Mode；不得要求用户理解或记忆五种 Mode 才能继续工作。

- `Consult`：用户要求的结果本身只是解释、只读咨询或一次性判断，且没有要求产出、修改或开始项目流程；直接回答，不持久化请求。
- `Quick`：目标清楚、局部、低影响、可逆、单会话完成；转 `$ezagent-light`。只有已知是单点表现修改且不改变行为、数据契约或外部消费者时才走 Quick。
- `Brief`：需要 1–5 个可验证 Slices 或跨会话恢复的普通工作；转 `$ezagent-spec`。要求用多个样本、计算过程或来源 Evidence 形成可复核结论的分析，默认至少是 Brief，即使样本尚未提供。
- `Standard`：多来源、多交付物、多个依赖 Slice、中等影响或新增跨边界能力；转 `$ezagent-spec`。新增数据导出默认按 Standard，因为通常同时涉及界面入口、查询范围、文件格式、兼容性和验证；只有实际检查证明是无兼容影响的单点局部修改时才可降级。
- `Controlled`：敏感信息、对外沟通、发布、预算、生产系统、人员判断或难回滚动作；转 `$ezagent-spec`，每个 Side Effect 仍单独批准。

Work Mode 绑定用户这次要求执行的动作和边界，不绑定主题名称。退款、支付、资金等领域风险本身不得自动升级为 Controlled；请求仅包含分析、规划或本地草拟，且不包含生产写入或外部动作时，默认按实际复杂度进入 Brief 或 Standard。只有这份 Work Contract 本身要求访问真实敏感数据、写入生产或外部系统、发布、预算承诺、人员判断或难回滚动作时才进入 Controlled；未来可能发生的 Side Effect 不得反向抬高当前只读规划的模式。

## Planning-first 自适应策略

Planning-first 是 Work Contract 内的切片与审批策略，不是第六种 Work Mode。它先交付必要的规划材料并取得真实人工认可，再允许实施 Slice 开始。

用户明确要求 PRD、技术设计、实施计划或“先规划后编码 / 先规划后实施”时，必须选择 Planning-first，并按实际影响进入 Brief、Standard 或 Controlled，不得走 Quick。只要求其中一种规划材料时只交付那一种；不得擅自补成三件套。

对包含实施的软件请求，如果仍有会改变范围的未决决策，并且涉及跨系统、数据或 API 边界、多个消费者或多个交付物，应推荐 Planning-first。仅凭用户说“复杂”“大型”或任务看起来工作量大，不得自动选择 Planning-first。目标清楚的 Quick 和不需要设计闸门的简单 Brief 不得附加 PRD、技术设计、实施计划等规划文档包。

如果是否统一多个平台、兼容哪些消费者、迁移边界或发布切片会改变范围，只问最关键的一个问题并给出推荐答案；该范围问题必须在 Work Preview 之前解决。没有这类实质不确定性时，直接把 Planning-first 理由、规划交付物、人工闸门和后续依赖放进同一份 Work Preview，不增加第二次例行预览批准。

不确定时优先问一个会改变结果的问题并给出推荐答案；不要用一轮长问卷。Shared Design Concept 尚未形成时，不急于生成完整资产。

需要历史经验时，从当前 outcome、Canonical Terms 和边界形成少量短 terms，从 stdin 发送：

```json
["node", "<absolute-cli-path>", "knowledge-context", "--root", "<absolute-project-root>"]
```

只使用最多 5 条摘要，确有需要才按 path 读取原记录；不传完整提示或聊天，不复制核心评分规则。用户要求共享项目上下文或晋升 Pattern 时转 `$ezagent-context`。

Specialist 和多 Agent 不是 Work Mode 的默认前置。对进入 Brief、Standard 或 Controlled 的新工作，在 Shared Design Concept 稳定后、生成 Work Contract 前必须做一次显式 Specialist Assessment：简单且能力充分的工作记录带理由的 `not-needed`；只有领域判断、上下文隔离、真正独立的并行 Slice 或独立审查能证明收益时才记录有界 Capability Needs。Assessment 只描述每个 Slice 需要的能力、领域、目的和隔离原因，不选择 expert ID，不为组队而组队；不得固定人员、数量或岗位。历史 v1 Plan 的自动组队继续由其已批准团队和 `team-select-preview` / `plan-*` 兼容入口管理。

用户仅询问“可能需要哪些角色”且没有要求开始工作时可以作为 Consult 回答；如果同一请求既询问角色、专家或协作，又要求开始分析、制定方案或按项目流程开始，就不得停在 Consult，必须按实际复杂度进入 Brief、Standard 或 Controlled，并完成 Specialist Assessment。用户要求完成实现并由未参与实现的独立 Agent 审查时，至少进入 Standard，即使只需 1–2 个 Slice；这是彼此隔离的 implementation 与 independent-review 能力边界，不能按 Slice 数量降成 Brief。用户要求独立 Agent 审查时必须形成 `independent-review` Capability Need，不能先以工具或源码缺失为由跳过 Assessment。

如果请求既询问协作角色又要求开始分析一个将改变行为、数据契约或跨边界接口的需求，至少进入 Standard；不得因为当前一句话使用“分析”就降为 Brief。Capability Need 必须绑定当前 Work Item 的 Outcome：仅当用户明确要求实施，或本 Work Item 的 Outcome 本身包含代码、配置、数据或业务资产变更时才使用 `implementation`。仅要求分析时使用 `analysis`，不得因为未来可能实施而强行创建 `implementation` Need；独立审查仍单独使用 `review`。

不得直接编辑 `.ezagent/**`。所有状态变化由本地核心验证。不得自动联网或安装软件，不得自动执行任何 Git 写操作，不得自动发布或上传项目。
