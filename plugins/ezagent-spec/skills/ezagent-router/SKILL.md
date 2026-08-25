---
name: ezagent-router
description: 在已初始化项目中，把编码、分析、文档、策划及其他 Agent 工作路由到最轻且足够可靠的 EZagent Work Mode；只读咨询不创建工作项。
---

# EZagent Router

## 激活与上下文

从当前目录向上查找项目根目录。只有找到 `.ezagent/project.yaml` 才进入工作流；未找到时，普通请求不触发 EZagent，只有用户明确要求启用、初始化或安装时才转 `$ezagent-initialize`。岗位、部门和业务名称只属于领域上下文，不得成为固定角色枚举或专属流程。

编码、分析、文档、策划以及其他 Agent 工作使用同一套路由原则；这些是非穷尽任务示例，不对应固定人员范围。

先取当前 `SKILL.md` 所在目录，再向上两级得到 `<plugin-root>`，把 `dist/ezagent-cli.mjs` 解析为 `<absolute-cli-path>` 绝对路径；不要在 `PATH` 中搜索其他 EZagent，也不要要求用户输入或运行 CLI。

必须使用支持 argv 数组的进程执行接口，禁止拼接 shell 字符串。每个动态值必须作为一个独立 argv 元素。若宿主只支持 shell 字符串，必须按当前 shell 的 literal 规则完整编码每个参数；无法证明编码正确就关闭失败，不得仅自行添加双引号。

每次相关工作先读取可信上下文：

```json
["node", "<absolute-cli-path>", "context", "--root", "<absolute-project-root>", "--json"]
```

安全模式或 `inspection-required` 只做诊断。若存在 active Work Item：

- `sourceSchemaVersion: 2` 且有 pending、executing 或 revise Slice：转 `$ezagent-execute`。
- `sourceSchemaVersion: 2` 且 Work Item 为 verifying：转 `$ezagent-review`。
- `sourceSchemaVersion: 1`：保持旧编码适配器，planned/implementing 转 `$ezagent-implement`，verifying 转 `$ezagent-review`。

## 选择最轻 Work Mode

- `Consult`：解释、只读咨询或一次性判断；直接回答，不持久化请求。
- `Quick`：目标清楚、局部、低影响、可逆、单会话完成；转 `$ezagent-light`。
- `Brief`：需要 1–5 个可验证 Slices 或跨会话恢复的普通工作；转 `$ezagent-spec`。
- `Standard`：多来源、多交付物、多个依赖 Slice 或中等影响；转 `$ezagent-spec`。
- `Controlled`：敏感信息、对外沟通、发布、预算、生产系统、人员判断或难回滚动作；转 `$ezagent-spec`，每个 Side Effect 仍单独批准。

不确定时优先问一个会改变结果的问题并给出推荐答案；不要用一轮长问卷。Shared Design Concept 尚未形成时，不急于生成完整资产。

需要历史经验时，从当前 outcome、Canonical Terms 和边界形成少量短 terms，从 stdin 发送：

```json
["node", "<absolute-cli-path>", "knowledge-context", "--root", "<absolute-project-root>"]
```

只使用最多 5 条摘要，确有需要才按 path 读取原记录；不传完整提示或聊天，不复制核心评分规则。用户要求共享项目上下文或晋升 Pattern 时转 `$ezagent-context`。

Specialist 和多 Agent 不是 Work Mode 的默认前置。对进入 Brief、Standard 或 Controlled 的新工作，在 Shared Design Concept 稳定后、生成 Work Contract 前必须做一次显式 Specialist Assessment：简单且能力充分的工作记录带理由的 `not-needed`；只有领域判断、上下文隔离、真正独立的并行 Slice 或独立审查能证明收益时才记录有界 Capability Needs。Assessment 只描述每个 Slice 需要的能力、领域、目的和隔离原因，不选择 expert ID，不为组队而组队；不得固定人员、数量或岗位。历史 v1 Plan 的自动组队继续由其已批准团队和 `team-select-preview` / `plan-*` 兼容入口管理。

不得直接编辑 `.ezagent/**`。所有状态变化由本地核心验证。不得自动联网或安装软件，不得自动执行任何 Git 写操作，不得自动发布或上传项目。
