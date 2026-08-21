---
name: ezagent-spec
description: 在已初始化 EZagent Spec 项目中，对 Router 判定需要规格工作的请求澄清需求、分级风险，并形成可批准的目标、非目标、验收、验证和能力需求。
---

# EZagent Spec

## 形成规格

先取当前 `SKILL.md` 所在目录，再向上两级得到 `<plugin-root>`，把 `dist/ezagent-cli.mjs` 解析为 `<absolute-cli-path>` 绝对路径；不要在 `PATH` 中搜索其他 EZagent，也不要要求用户输入或运行 CLI。

必须使用支持 argv 数组的进程执行接口，禁止拼接 shell 字符串。每个动态值必须作为一个独立 argv 元素。若宿主只支持 shell 字符串，必须按当前 shell 的 literal 规则完整编码每个参数；无法证明编码正确就关闭失败，不得仅自行添加双引号。

```json
["node", "<absolute-cli-path>", "context", "--root", "<absolute-project-root>", "--json"]
```

安全模式只诊断。把请求分类为 `consult`、`light`、`standard` 或 `high`：解释和只读咨询属于 `consult` 且不创建工作项；纯文案、颜色或局部样式在范围明确且不改变行为、接口、数据、依赖或安全时属于 `light`；Excel 导出等不涉及权限、安全边界、敏感或破坏性数据变更、生产环境或不可逆影响的新增能力，以及一般行为或接口变化，属于 `standard`；权限或安全边界变化、敏感或破坏性数据变更、生产环境操作或不可逆影响属于 `high`。仍不确定时按 `standard` 处理并在必要时澄清。

规格至少明确目标、非目标、验收条件、验证方法和能力需求，并把假设与未决问题显式列出。`standard` 和 `high` 必须等待用户明确批准 Spec；`high` 的 Spec 批准不等于危险动作授权，执行每个危险动作前仍需单独授权。

## 专家与状态

按能力需求动态选择少量合适专家，不固定专家数量。任何多 Agent 委派都必须绑定 `Requirement ID`、`Spec ID`、`Task ID`、`expert ID`、`delegation ID`、`scope`、`deliverables` 和 `gates`；只保存结构化摘要，不得保存完整用户提示或完整专家提示。

无 `state.activeWorkItem` 时，当前打包 CLI 没有 `capture`/`plan` 命令；只能形成包含目标、非目标、验收、验证和能力需求的结构化草案并关闭失败，不得声称 Requirement/Spec/Task 已创建。

每次 `transition` 前都重新执行 `context`；若 `state.activeWorkItem` 为空就不得执行 transition。`--revision` 只取最近一次 `context` JSON 的 `state.activeWorkItem.revision`，绝不得使用 `state.revision`。状态推进只使用打包 CLI 当前支持的 argv：

```json
["node", "<absolute-cli-path>", "transition", "--root", "<absolute-project-root>", "--to", "<target-status>", "--revision", "<active-work-item-revision>"]
```

若其他持久化能力尚未打包，明确报告能力未打包并关闭失败，不得杜撰命令或绕过状态机。

不得直接编辑 `.ezagent/**`。所有状态变化由本地核心验证。不得自动联网或安装软件，不得自动执行任何 Git 写操作，不得自动发布或上传项目。
