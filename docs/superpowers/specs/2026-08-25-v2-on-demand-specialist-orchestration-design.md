# EZagent v2 按需 Specialist 编排设计

日期：2026-08-25

状态：已批准，进入实现

## 1. 背景

v2 Work Harness 将 Specialist 和多 Agent 从默认前置条件改成可选执行手段，避免简单工作为组队而组队。这个方向保留，但当前实现只在 Skill 文本中描述“按需使用”，没有把能力评估、确定性选择、项目 Agent 物化、真实委派和回执连接成生产闭环。

结果是：新的 v2 Work Item 即使存在明确的领域判断、上下文隔离或独立审查需求，也可能完全不使用随插件发布的 Agency Agents 专家目录。用户无法区分“已经判断不需要专家”和“根本没有执行专家评估”。

本设计恢复按需 Specialist 编排，同时不恢复 v1 的强制专家团队语义。

## 2. 目标

1. 每个新的持久化 v2 Work Item 都显式记录 Specialist Assessment，结论只能是 `not-needed` 或 `required`。
2. Agent 只提交能力需求；Core 从锁定的本地目录确定性选择专家 ID。
3. 初始 Specialist Plan 与 Brief、Work Spec 和 Slices 在同一份预览中展示和批准。
4. 已批准 Specialist 被物化为真实 Codex 项目 Agent，并绑定具体 Work Item、Work Spec、Slice 和 Delegation。
5. 执行者必须真正调用已批准的 Specialist，并保存有界、可恢复的 Delegation Receipt。
6. 独立 reviewer 不参与同一 Slice 的实现；`mixed` 同时包含独立 Agent 和人工判断。
7. v1 Team 和旧 v2 Work Item 保持可读、可恢复、可完成。

## 3. 非目标

- Consult 和 Quick 不创建持久化 Specialist。
- 不把 265 位专家的完整提示或目录注入上下文。
- 不允许模型直接选择专家 ID。
- 不在本轮支持多个同时处于 `executing` 的 Slices。
- 不改变专家目录导入、许可证或来源锁。
- 不增加联网、安装、Git 写入、遥测、发布或上传权限。

## 4. 核心术语

### Specialist Assessment

在 Shared Design Concept 和 Slice Plan 已知后形成的执行能力判断。它必须明确说明为什么不需要 Specialist，或声明一个或多个 Slice 级 Capability Needs。

### Capability Need

不包含专家 ID 的能力请求，绑定 Slice、用途、能力、领域、项目特征和隔离理由。用途为 `analysis`、`implementation` 或 `review`；隔离理由为领域判断、上下文隔离、并行工作或独立审查。

### Specialist Plan

Core 根据 Assessment 和锁定目录生成的平台无关执行计划。它保存选择 fingerprint、目录 fingerprint、成员、原因、Delegation Contracts、未覆盖能力和 blocker。

### Delegation Contract

一次对子 Agent 的有界授权，绑定 Work Item ID、Work Spec ID、Work Spec revision、Slice ID、Delegation ID、expert ID、scope、deliverables 和 Evidence requirements。

### Delegation Receipt

Host 调用 Specialist 后提交的有界事实记录。它只保存标识符、状态、摘要、结果 hash、Evidence pointers 和时间，不保存完整提示、聊天、工具输出或专家指令。

## 5. 选择顺序

```text
Shared Design Concept
  -> Slice Plan
  -> Specialist Assessment
  -> Capability Need
  -> Core selection
  -> Specialist Plan
  -> decide whether Host isolation/delegation is required
```

不得先挑选专家再反向解释任务。`not-needed` 必须有非空理由；`required` 必须至少包含一个有效 Capability Need。

## 6. 模式策略

- Consult：直接回答，不进行持久化评估。
- Quick：允许内部使用普通工具，但不创建 Specialist Plan 或项目 Agent。
- Brief：默认可以 `not-needed`，存在明确能力或独立审查需求时允许 `required`。
- Standard：必须评估，但不强制选择专家。
- Controlled：必须评估；现有 human/mixed 安全规则保持不变。

`independent-agent` 和 `mixed` Review Policy 必须产生至少一个 `review` Capability Need，且 isolation reason 为 `independent-review`。`mixed` 还必须保留现有 `human-approval` Evidence 要求。

## 7. 预览与批准

模型提交 Work Contract Draft 和 Specialist Assessment，不提交专家 ID。`work-preview` 读取本地目录，确定性生成 Specialist Plan，并把下列内容绑定到一个 approval token：

- canonical project root；
- workspace revision；
- Brief、Work Spec 和 Work Item；
- Specialist Assessment 和选中 Delegations；
- catalog、selection 和 plan fingerprints。

用户批准合并预览后，`work-apply` 必须重新加载目录和重新选择，不能信任 preview 回传的成员。任何漂移都会使 token 失效。

初始选择不增加第二次常规确认。执行中新增、移除或改变 Specialist 时，必须使用 Specialist-only replan 展示 added、removed、changed 和 unchanged 差异并单独批准。

## 8. 持久化

```text
.ezagent/experts/active.yaml
.ezagent/experts/plans/<TASK-ID>/<revision>.json
.ezagent/experts/receipts/<TASK-ID>/<delegation-id>/<sequence>.json
```

`plans/**` 和 `receipts/**` 是不可变历史；`active.yaml` 只是当前投影。v2 不复用 `experts/teams/**`，避免把新语义伪装成 legacy `ExpertTeamPlan`。

新 v2 Apply 必须在一个 Workspace mutation 中写入 Brief、Work Spec、Work Item、Specialist Plan 和 active projection。旧 v2 Work Item 没有 Specialist Plan 时以 `legacy-unassessed` 恢复，不能解释为 `not-needed`。

## 9. Codex 物化

Codex Adapter 从已批准的 v1 Team 或 v2 Specialist Plan 生成 `.codex/agents/ezagent-*.toml`。v2 assignment 必须包含 Work Spec、Slice、Delegation 和 Evidence identifiers。

只有当前 active plan 中的专家会被生成。用户拥有的 Agent 文件不得修改。托管文件缺失、内容漂移或恢复歧义会返回 `inspection-required`；包含 Delegation 的 Slice 在平台状态 `ready` 前不得开始。

## 10. 委派与审查

`delegation-start` 校验当前 active Slice、approved plan、expert、mode 和 platform readiness，并返回不可变 Delegation Contract。Coordinator 使用该契约调用对应项目 Agent。

`delegation-complete` 记录 bounded receipt。Slice Review 同时计算：

1. Acceptance Criteria 的 Evidence coverage；
2. approved Delegations 的 completion coverage。

任一不完整都不能接受 Slice。Reviewer receipt 必须来自 `review` mode 的不同 expert；实现专家不得自审。Coordinator 仍是唯一可推进 EZagent 状态的主体。

本地 receipt 不能单独证明 Host 确实调用了子 Agent，因此发布前还必须通过真实 Codex Host evaluation；文档只声明两类证据共同证明的行为。

## 11. Replan 与退场

Specialist-only replan 只能改变执行策略，不得改变 Outcome、Scope、Non-goals、Deliverable Interfaces、Acceptance Criteria、Boundaries 或 Approval Points。契约变化仍需新的 Work Contract。

Replan 不能覆盖未完成的活动 Delegation。完成或取消 Work Item 时，Core 原子撤下只绑定该任务的 active experts，保留 plan/receipt 历史；CLI 随后 reconcile，仅删除 EZagent 托管的项目 Agent 文件。

## 12. 并发边界

第一版维持一次推进一个 Slice。一个 Slice 内若 Delegation scope 真正独立，Host 可以并行调用多个 Specialist，但 Slice 状态仍由 Coordinator 串行推进。多 Slice 并发留作后续独立设计。

## 13. 成功标准

1. 简单 Brief 明确记录 `not-needed`，且不生成项目 Agent。
2. 跨领域 Standard Work Item 能自动选择、批准、物化并真实调用 Specialist。
3. restart 后 selection、Delegations、receipts 和 platform readiness 可一致恢复。
4. Independent/mixed review 使用未参与实现的 reviewer。
5. 缺失、过期或伪造结构的 Delegation Receipt 会关闭失败。
6. Work completion 后托管 Agents 退场，历史保留。
7. v1 automatic expert-team E2E 和旧 v2 recovery 继续通过。
