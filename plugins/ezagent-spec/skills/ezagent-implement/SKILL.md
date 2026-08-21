---
name: ezagent-implement
description: 在 EZagent Spec 项目中执行已批准且已规划的 Task，约束路径、依赖、交付物、专家委派和质量门，并在范围变化时返回 Spec。
---

# EZagent Implement

## 开始条件

先取当前 `SKILL.md` 所在目录，再向上两级得到 `<plugin-root>`，把 `dist/ezagent-cli.mjs` 解析为 `<absolute-cli-path>` 绝对路径；不要在 `PATH` 中搜索其他 EZagent，也不要要求用户输入或运行 CLI。

必须使用支持 argv 数组的进程执行接口，禁止拼接 shell 字符串。每个动态值必须作为一个独立 argv 元素。若宿主只支持 shell 字符串，必须按当前 shell 的 literal 规则完整编码每个参数；无法证明编码正确就关闭失败，不得仅自行添加双引号。

```json
["node", "<absolute-cli-path>", "context", "--root", "<absolute-project-root>", "--json"]
```

任何工作或 transition 前都应用状态门；kind 或 status 不匹配就关闭失败：

```json
{"stateGuard":{"kind":"task","statuses":["planned","implementing"]}}
```

安全模式只诊断。仅继续本地核心已批准且已规划的 Task：最近上下文的 `state.activeWorkItem.status` 必须是 `planned` 或 `implementing`；`planned` 先走合法首次 transition，`implementing` 可继续实施。开始前核对 `allowedPaths`、依赖、`deliverables`、委派和 `gates`；状态或字段缺失就停止。

每次 `transition` 前都重新执行 `context`；若 `state.activeWorkItem` 为空就不得执行 transition。`--revision` 只取最近一次 `context` JSON 的 `state.activeWorkItem.revision`，绝不得使用 `state.revision`。

普通 planned Task 首次进入 implementing 使用：

```json
["node", "<absolute-cli-path>", "transition", "--root", "<absolute-project-root>", "--to", "implementing", "--revision", "<active-work-item-revision>"]
```

仅当最近一次上下文显示 `state.activeWorkItem.risk` 为 `high`、状态为 `planned`，目标为 `implementing`，且 `AUTH` 是本地核心中已存在并绑定该 action 的一次性记录时，才使用：

```json
["node", "<absolute-cli-path>", "transition", "--root", "<absolute-project-root>", "--to", "implementing", "--revision", "<active-work-item-revision>", "--high-risk-authorization", "<authorization-id>"]
```

不得由模型或用户随意编造授权 ID；授权记录不存在或无法验证时视为能力缺失并停止。Spec 批准不能代替该 action 授权。

## 受控实施

只修改 `allowedPaths` 内的内容并产出约定交付物。范围越界或依赖、验收、风险变化时，当前打包 CLI 没有 `replan` 命令；立即停止，转 `$ezagent-spec` 形成结构化 `scope-change` 草案，不做非法反向 transition，也不得静默扩写范围。安装、联网和任何危险动作都必须在执行前获得对应的明确授权。

按任务能力动态选择少量合适专家，不固定专家数量。任何多 Agent 委派都必须绑定 `Requirement ID`、`Spec ID`、`Task ID`、`expert ID`、`delegation ID`、`scope`、`deliverables` 和 `gates`；子任务必须遵循相同范围与质量门，只保存结构化摘要，不得保存完整用户提示或完整专家提示。

## 交付审查

实现交付完成后重新执行 `context`。只有 kind 为 task 且 status 为 implementing 时，才用最新 active revision 推进到 verifying：

```json
{"reviewHandoff":{"kind":"task","fromStatus":"implementing","toStatus":"verifying","targetSkill":"ezagent-review","onTransitionFailure":"fail-closed"}}
```

```json
["node", "<absolute-cli-path>", "transition", "--root", "<absolute-project-root>", "--to", "verifying", "--revision", "<active-work-item-revision>"]
```

transition 成功后才路由 `$ezagent-review`；失败就关闭失败，不得进入 Review。高风险实施中的实际危险动作仍各自需要独立授权。

不得直接编辑 `.ezagent/**`。所有状态变化由本地核心验证。不得自动联网或安装软件，不得自动执行任何 Git 写操作，不得自动发布或上传项目。
