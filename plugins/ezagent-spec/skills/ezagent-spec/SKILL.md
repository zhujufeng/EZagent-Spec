---
name: ezagent-spec
description: 在已初始化 EZagent Spec 项目中澄清需求、分级风险，并把 Spec、Plan、Task 与自动提议的少量专家团队一起交给用户批准。
---

# EZagent Spec

## 形成规格

先取当前 `SKILL.md` 所在目录，再向上两级得到 `<plugin-root>`，把 `dist/ezagent-cli.mjs` 解析为 `<absolute-cli-path>` 绝对路径；不要在 `PATH` 中搜索其他 EZagent，也不要要求用户输入或运行 CLI。

必须使用支持 argv 数组的进程执行接口，禁止拼接 shell 字符串。每个动态值必须作为一个独立 argv 元素。若宿主只支持 shell 字符串，必须按当前 shell 的 literal 规则完整编码每个参数；无法证明编码正确就关闭失败，不得仅自行添加双引号。

```json
["node", "<absolute-cli-path>", "context", "--root", "<absolute-project-root>", "--json"]
```

安全模式只诊断。把请求分类为 `consult`、`light`、`standard` 或 `high`：解释和只读咨询属于 `consult` 且不创建工作项；纯文案、颜色或局部样式在范围明确且不改变行为、接口、数据、依赖或安全时属于 `light`；Excel 导出等不涉及权限、安全边界、敏感或破坏性数据变更、生产环境或不可逆影响的新增能力，以及一般行为或接口变化，属于 `standard`；权限或安全边界变化、敏感或破坏性数据变更、生产环境操作或不可逆影响属于 `high`。仍不确定时按 `standard` 处理并在必要时澄清。

结构化 Plan 至少明确目标、范围、非目标、验收条件、验证方法、Task、允许路径、依赖、交付物、质量门、能力需求、领域信号、假设与未决问题。`standard` 和 `high` 必须等待用户明确批准；`high` 的 Spec 批准不等于危险动作授权，每个实际危险动作仍需单独授权。

## 自动专家团队与一次批准

按能力需求使用本地完整目录动态提议少量合适专家，不固定专家数量。先把结构化 Plan 作为单个 JSON 文档从进程 stdin 传入：

```json
["node", "<absolute-cli-path>", "team-select-preview", "--root", "<absolute-project-root>"]
```

不得自行确定或直接提交最终 expert ID。只为返回的候选成员编写与其 mode 一致的 assignments；任何多 Agent 委派都必须绑定 `Requirement ID`、`Spec ID`、`Task ID`、`expert ID`、`delegation ID`、`scope`、`deliverables` 和 `gates`。只保存结构化摘要，不得保存完整用户提示或完整专家提示。

把 draft、selection fingerprint、assignments 与必要的大团队决策作为单个 JSON 文档从 stdin 传入：

```json
["node", "<absolute-cli-path>", "plan-preview", "--root", "<absolute-project-root>"]
```

必须把目标、范围、验收、风险、Task、团队成员、角色、选择理由、分工、质量门和 blockers 与 Spec/Plan 一起确认，而不是另开一次专家选择确认。存在能力未覆盖或独立审查者缺失时停止；超过软阈值时只有用户明确接受后才能继续。

用户批准合并预览后，以完全相同的 stdin JSON 和预览返回的 token 原子写入 Requirement、Spec、Task 与团队：

```json
["node", "<absolute-cli-path>", "plan-apply", "--root", "<absolute-project-root>", "--approval-token", "<approval-token>"]
```

批准后重新读取上下文；若平台专家尚未同步，由 Router 执行恢复流程。不要重复要求用户选择团队。

## 范围变化与重规划

实施中若范围、依赖、验收、风险或所需能力发生实质变化，停止编码并形成 replacement Plan。先用最新已批准团队计算只读差异：

```json
["node", "<absolute-cli-path>", "replan-preview", "--root", "<absolute-project-root>"]
```

将 replacement draft 与 assignments 作为单个 JSON 文档从 stdin 传入，向用户展示 Plan 差异及团队 added、removed、changed、unchanged。用户明确批准后，使用相同 stdin JSON 和绑定 token：

```json
["node", "<absolute-cli-path>", "replan-apply", "--root", "<absolute-project-root>", "--approval-token", "<approval-token>"]
```

未批准时维持原 Plan 和团队；不得静默扩写范围。

每次 `transition` 前都重新执行 `context`；若 `state.activeWorkItem` 为空就不得执行 transition。`--revision` 只取最近一次 `context` JSON 的 `state.activeWorkItem.revision`，绝不得使用 `state.revision`。

```json
["node", "<absolute-cli-path>", "transition", "--root", "<absolute-project-root>", "--to", "<target-status>", "--revision", "<active-work-item-revision>"]
```

不得直接编辑 `.ezagent/**`。所有状态变化由本地核心验证。不得自动联网或安装软件，不得自动执行任何 Git 写操作，不得自动发布或上传项目。
