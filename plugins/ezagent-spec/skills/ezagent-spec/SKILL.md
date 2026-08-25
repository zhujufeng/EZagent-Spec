---
name: ezagent-spec
description: 在已初始化项目中，把需要跨步骤、跨会话或受控执行的任意 Agent 请求整理为 Brief、Work Spec、Slices、Evidence 与 Approval Points，并在一次预览后创建通用 Work Item。
---

# EZagent Spec

## 先形成共同理解

先取当前 `SKILL.md` 所在目录，再向上两级得到 `<plugin-root>`，把 `dist/ezagent-cli.mjs` 解析为 `<absolute-cli-path>` 绝对路径；不要在 `PATH` 中搜索其他 EZagent，也不要要求用户输入或运行 CLI。

必须使用支持 argv 数组的进程执行接口，禁止拼接 shell 字符串。每个动态值必须作为一个独立 argv 元素。若宿主只支持 shell 字符串，必须按当前 shell 的 literal 规则完整编码每个参数；无法证明编码正确就关闭失败，不得仅自行添加双引号。

```json
["node", "<absolute-cli-path>", "context", "--root", "<absolute-project-root>", "--json"]
```

若用户明确要求取消或放弃当前 active Work Item，说明取消会停止继续执行但保留已有 Plan、Receipt、Evidence 与 Journal 历史。重新执行 `context` 取得最近的 `state.activeWorkItem.revision`；active item 已为空时不得调用：

```json
["node", "<absolute-cli-path>", "work-cancel", "--root", "<absolute-project-root>", "--revision", "<active-work-item-revision>"]
```

取消后重新执行 `context`，确认 `state.activeWorkItem` 为 null 后，才可为变化后的范围形成新 Work Contract。未经用户明确放弃，不得用取消代替澄清或 replan。

安全模式或 inspection-required 只做诊断。先用自然语言复述 Shared Design Concept：用户真正想改变什么、谁会使用结果、什么算成功、哪些事明确不做。只追问一个会实质改变结果的问题，并给出推荐答案；答案可以从项目和可信来源取得时不要询问。共同理解尚不稳定时，不急着生成完整资产。

人员、岗位、部门和业务类型只进入 `actors`、交付物消费者或边界上下文，不得成为固定角色枚举。库存、运营、策划、人事、研发等只能作为非穷尽示例，不能决定流程。

## 形成通用 Work Contract

根据 Router 已选模式生成 `schemaVersion: 2` 的单个 JSON：

- `brief`：请求摘要、预期结果、参与者、Canonical Terms、已确认决策、带来源的假设、未决问题和 Source Pointers。
- `workSpec`：`brief` / `standard` / `controlled` 模式、范围、非目标、Deliverable Interfaces、Acceptance Criteria、Boundaries、Approval Points、Review Policy 和 Slice Plan。
- `specialistAssessment`：每次都必须显式存在。能力和上下文已足够时用 `decision: not-needed`、有界 `reasons` 与空 `needs`；确有领域判断、上下文隔离、独立并行或独立审查需求时用 `decision: required`，并为每个需要填写 `id`、`sliceId`、`purpose`、`capabilities`、`domains`、`projectSignals` 和 `isolationReason`。
- 每个 Acceptance Criterion 必须声明所需 Evidence kinds；每个 Criterion 至少被一个 Slice 覆盖。
- 第一个 Tracer Slice 必须无依赖并尽快产出一个可验证的端到端结果；总 Slice 数保持在 1–15 个，优先小而完整的纵向切片。
- 当前版本逐 Slice Review，`reviewAfterSlices` 必须为 `1`。标记 `humanCheckpoint: true` 的 Slice 必须至少有一个要求 `human-approval` Evidence 的 Criterion。
- Deliverable Interface 描述结构、不可破坏的约束和消费者，不预先臆造大段正文或实现细节。
- 外部写入或发布只能进入 `controlled`，且目标必须有精确 Approval Point。Controlled Review 必须包含 human 或 mixed 判断以及 `human-approval` Evidence。

Specialist 和多 Agent 的实际执行仍是可选手段，但 `specialistAssessment` 是 Work Contract 的必填判断。Assessment 不得填写 expert ID、指定人数或借岗位名称预选团队；本地核心根据已批准的 Capability Needs 和运行时 Catalog 确定性生成 Specialist Plan。若需要独立审查，review need 必须使用 `independent-review`，并与同一 Slice 的实现者隔离。任何生成的委派必须绑定 `Work Item ID`、`Work Spec ID`、`Slice ID`、`delegation ID`、`scope`、`deliverables` 和 `Evidence requirements`，只回传有界摘要，不保存完整用户提示或完整专家提示。

把完全相同的 Work Contract JSON 从 stdin 先传给只读预览：

```json
["node", "<absolute-cli-path>", "work-preview", "--root", "<absolute-project-root>"]
```

向用户展示 Outcome、Mode、Scope / Non-goals、Deliverable Interfaces、Acceptance Criteria、Slices、Review Policy、Approval Points、关键假设和未决问题，并展示 Specialist Assessment、确定性生成的 delegations、未覆盖能力与 blockers。不得把 Specialist Plan 另拆成一次例行确认；`brief`、`standard`、`controlled` 都只确认这一份合并预览。存在 blocker 时先修正 Capability Need 或说明能力缺口，不得 Apply。Controlled 的 Work Contract 批准不等于任何具体 Side Effect 授权。

用户批准后，把完全相同的 JSON 从 stdin 传入，并把预览 token 作为独立 argv 元素原子创建 Brief、Work Spec 与 Work Item：

```json
["node", "<absolute-cli-path>", "work-apply", "--root", "<absolute-project-root>", "--approval-token", "<approval-token>"]
```

Apply 会物化已批准的 project Agents，并返回 `specialistPlan` 与 `platformSyncStatus`。Apply 后重新读取 `context`，确认 `sourceSchemaVersion: 2`；存在 delegations 时还必须确认 `specialists.status: ready` 与 `platformSyncStatus: ready`，再转 `$ezagent-execute`。token 漂移、字段校验或平台同步失败时关闭失败并重新读取上下文，不猜测成功。

## 范围变化

执行中若 Outcome、Scope、Non-goals、Criterion、资源权限、风险或 Approval Point 实质变化，停止当前 Slice 并明确展示变化；当前 v2 不静默扩写或直接改状态文件。由用户决定收缩回已批准范围，或在结束当前 Work Item 后为新范围创建新的 Work Contract。

不得直接编辑 `.ezagent/**`。所有状态变化由本地核心验证。不得自动联网或安装软件，不得自动执行任何 Git 写操作，不得自动发布或上传项目。
