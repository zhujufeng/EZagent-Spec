---
name: ezagent-implement
description: 兼容执行 sourceSchemaVersion 1 的旧版编码 Spec Task：使用其已批准专家团队、范围、交付物和质量门；新的通用 Work Item 应使用 ezagent-execute。
---

# EZagent Implement

这是旧版 v1 编码流程的兼容适配器。只有 `context` 返回 `sourceSchemaVersion: 1` 时使用；v2 Work Item 必须转 `$ezagent-execute`，不得为新请求强制组队。

## 开始条件

先取当前 `SKILL.md` 所在目录，再向上两级得到 `<plugin-root>`，把 `dist/ezagent-cli.mjs` 解析为 `<absolute-cli-path>` 绝对路径；不要在 `PATH` 中搜索其他 EZagent，也不要要求用户输入或运行 CLI。

必须使用支持 argv 数组的进程执行接口，禁止拼接 shell 字符串。每个动态值必须作为一个独立 argv 元素。若宿主只支持 shell 字符串，必须按当前 shell 的 literal 规则完整编码每个参数；无法证明编码正确就关闭失败，不得仅自行添加双引号。

```json
["node", "<absolute-cli-path>", "context", "--root", "<absolute-project-root>", "--json"]
```

若用户明确要求取消或放弃当前 active Work Item，先说明取消会停止旧版 Task，但保留 Plan、Receipt 与已写入历史。重新执行 `context` 取得最近的 `state.activeWorkItem.revision`；active item 已为空时不得调用：

```json
["node", "<absolute-cli-path>", "work-cancel", "--root", "<absolute-project-root>", "--revision", "<active-work-item-revision>"]
```

取消后重新执行 `context`，确认 `state.activeWorkItem` 为 null 后停止实施。不得把高风险关闭失败、同步失败或普通返工自行升级为取消。

任何工作或 transition 前都应用状态门；kind 或 status 不匹配就关闭失败：

```json
{"stateGuard":{"kind":"task","statuses":["planned","implementing"]}}
```

安全模式只诊断。仅继续本地核心已批准的 Task：最近上下文的 `state.activeWorkItem.status` 必须是 `planned` 或 `implementing`；`planned` 先走合法首次 transition，`implementing` 可继续实施。开始前核对 `allowedPaths`、依赖、`deliverables`、委派和 `gates`；状态或字段缺失就停止。

当前版本不支持高风险 Task 实施。若最近上下文中的 `state.activeWorkItem.risk` 为 `high`，立即停止并说明该版本关闭了高风险实施；不得进入 `implementing`，也不得通过编造参数、授权编号或绕过本地核心继续。

必须同时核对顶层 `platformSyncStatus`。只有其值为 `ready` 才可执行或继续执行 Task；若为 `pending`，先调用：

```json
["node", "<absolute-cli-path>", "experts-reconcile", "--root", "<absolute-project-root>"]
```

随后重新读取上下文并确认 `ready`。若为 inspection-required、同步失败或无法确认，关闭失败，不得进入 implementing。项目级 Agents 即当前已批准团队；不得自由替换、追加专家或让实现者兼任自己的审查者。

每次 `transition` 前都重新执行 `context`；若 `state.activeWorkItem` 为空就不得执行 transition。`--revision` 只取最近一次 `context` JSON 的 `state.activeWorkItem.revision`，绝不得使用 `state.revision`。

仅 `light` 或 `standard` planned Task 首次进入 implementing 使用：

```json
["node", "<absolute-cli-path>", "transition", "--root", "<absolute-project-root>", "--to", "implementing", "--revision", "<active-work-item-revision>"]
```

## 受控实施与重规划

只修改 `allowedPaths` 内的内容并产出约定交付物。按已批准团队委派少量合适专家，不固定专家数量。任何多 Agent 委派都必须绑定 `Requirement ID`、`Spec ID`、`Task ID`、`expert ID`、`delegation ID`、`scope`、`deliverables` 和 `gates`；子任务遵循相同范围和质量门，只保存结构化摘要，不得保存完整用户提示或完整专家提示。

范围越界或依赖、验收、风险、能力需求变化时，立即停止编码并转 `$ezagent-spec`。由 Spec 先执行 `replan-preview` 展示 replacement Plan 与团队差异，用户批准后再执行 `replan-apply`；批准和同步完成前不得继续修改。安装、联网和任何危险动作都必须在执行前获得对应的明确授权。

## 交付审查

实现交付完成后重新执行 `context`。只有 kind 为 task 且 status 为 implementing 时，才用最新 active revision 推进到 verifying：

```json
{"reviewHandoff":{"kind":"task","fromStatus":"implementing","toStatus":"verifying","targetSkill":"ezagent-review","onTransitionFailure":"fail-closed"}}
```

```json
["node", "<absolute-cli-path>", "transition", "--root", "<absolute-project-root>", "--to", "verifying", "--revision", "<active-work-item-revision>"]
```

transition 成功后才路由 `$ezagent-review`；失败就关闭失败，不得进入 Review。

不得直接编辑 `.ezagent/**`。所有状态变化由本地核心验证。不得自动联网或安装软件，不得自动执行任何 Git 写操作，不得自动发布或上传项目。
