---
name: ezagent-review
description: 按 Acceptance Criterion 审查通用 Work Item 的真实 Evidence 并完成 Decision；同时保留已批准 v1 编码 Task 的独立质量门审查兼容路径。
---

# EZagent Review

## 恢复与分流

先取当前 `SKILL.md` 所在目录，再向上两级得到 `<plugin-root>`，把 `dist/ezagent-cli.mjs` 解析为 `<absolute-cli-path>` 绝对路径；不要在 `PATH` 中搜索其他 EZagent，也不要要求用户输入或运行 CLI。

必须使用支持 argv 数组的进程执行接口，禁止拼接 shell 字符串。每个动态值必须作为一个独立 argv 元素。若宿主只支持 shell 字符串，必须按当前 shell 的 literal 规则完整编码每个参数；无法证明编码正确就关闭失败，不得仅自行添加双引号。

```json
["node", "<absolute-cli-path>", "context", "--root", "<absolute-project-root>", "--json"]
```

安全模式或 inspection-required 只诊断。`sourceSchemaVersion: 2` 走通用 Evidence 审查；`sourceSchemaVersion: 1` 才走文末的旧编码适配器。不得虚构证据、状态、命令或人工结论。

## v2：Criterion-by-Criterion Review

逐个 Slice 对照 Work Spec：交付物是否符合 Deliverable Interface，每个 Acceptance Criterion 要求的 Evidence kind 是否真实存在且结论通过，资源和操作是否守住 Boundaries。只记录实际观察、实际执行或可定位的 Artifact；没有运行、无法读取、来源失效或证据不足都不能算通过。

Review Policy 为 `independent-agent` 或 `mixed` 时，只能使用当前 Slice 上已批准、`mode: review` 且没有实现该 Slice 的 reviewer project Agent。协调器、实现者或其他 Agent 不得模拟、替换或批准自己的输出。先为该 review delegation 创建不可变 start receipt：

```json
["node", "<absolute-cli-path>", "delegation-start", "--root", "<absolute-project-root>", "--delegation", "<delegation-id>"]
```

在隔离的原生 subagent 中调用 receipt 中 `expertId` 对应的专家。Codex 优先调用已生成的 reviewer project Agent；Claude Code 或 OpenCode 若不能加载 Codex TOML，则从 `<plugin-root>/catalog/experts.json` 精确读取同一 `expertId` 的专家定义，再用宿主原生 subagent 工具启动 reviewer。宿主没有可用 subagent 能力时必须提交 blocked 回执，协调器和实现者都不得模拟 reviewer。只传已批准的 `Work Item ID`、`Work Spec ID`、`Slice ID`、`delegation ID`、scope、交付物指针、Criterion IDs 和 Evidence requirements。只接收有界审查摘要、结果 hash、Evidence pointers 与通过/失败结论，不传完整聊天、完整提示或实现者的私有上下文。随后从 stdin 提交 completion receipt：

```json
["node", "<absolute-cli-path>", "delegation-complete", "--root", "<absolute-project-root>", "--delegation", "<delegation-id>"]
```

审查失败或无法完成时必须提交 `status: blocked`，Evidence 如实标记失败，`work-review` 会把 Slice 返回 `revise`；不得把失败 reviewer 替换成实现者。为 `human` 或 `mixed` 时，只有用户对匹配 Approval Point `contentHash` 的明确结论才能形成 `human-approval` Evidence；`mixed` 同时要求独立 review completion 与这份人工 Evidence。

把一个 Slice 的完整 Evidence Bundle 作为单个 JSON 从 stdin 传入：

```json
["node", "<absolute-cli-path>", "work-review", "--root", "<absolute-project-root>"]
```

核心分别返回 Criterion Evidence coverage 与 required Delegation coverage。任一缺失或 blocked 时 Slice 进入 `revise`，转回 `$ezagent-execute` 只修复该 Slice；二者都完整时才进入 `accepted`。已接受 Slice 也允许被真正独立的失败证据重新打开，不得用旧结论掩盖新发现。

所有 Slice 都 accepted 且 Work Item 为 verifying 后，重新读取持久化 Evidence，并形成有界 Decision：标题、摘要、决策、约束和后续事项。不要复制聊天、长文、完整提示或测试输出。把 `schemaVersion: 3` 的 Decision JSON 从 stdin 传入：

```json
["node", "<absolute-cli-path>", "work-complete", "--root", "<absolute-project-root>"]
```

核心会重新验证每个 Slice 的最新 Evidence，原子写入 Decision、完成 Work Item 并清空 active item。随后再次执行 `context`，确认 active item 为空且 Decision 可按返回 path 与 hash 读回；失败就保持关闭失败。

## v1：旧编码 Task 审查适配器

只有 `sourceSchemaVersion: 1` 且 kind 为 task、status 为 verifying 时使用：

```json
{"stateGuard":{"kind":"task","statuses":["verifying"]}}
```

审查只能交给已批准团队中没有参与该 Task 实现的 review 专家，逐项运行 Task 定义的 gates。失败时按以下兼容契约返回实施：

```json
{"failureHandoff":{"fromStatus":"verifying","toStatus":"implementing","supportedRisks":["light","standard"],"highRisk":"fail-closed","targetSkill":"ezagent-implement","onTransitionFailure":"fail-closed"}}
```

```json
["node", "<absolute-cli-path>", "transition", "--root", "<absolute-project-root>", "--to", "implementing", "--revision", "<active-work-item-revision>"]
```

high risk 返工关闭失败；transition 失败时关闭失败，不得转入 Implement。transition 成功后才转 `$ezagent-implement`。全部 gates 真实通过后，沿用 v1 Knowledge v2 capture-and-complete 契约：

```json
{"completion":{"knowledgeRequiredBeforeStatus":"completed","currentKnowledgePersistence":"available","currentAction":"capture-and-complete","resultStatus":"completed"}}
```

```json
["node", "<absolute-cli-path>", "transition", "--root", "<absolute-project-root>", "--to", "completed", "--revision", "<active-work-item-revision>"]
```

每次 `transition` 前都重新执行 `context`；若 `state.activeWorkItem` 为空就不得执行 transition。`--revision` 只取最近一次 `context` JSON 的 `state.activeWorkItem.revision`，绝不得使用 `state.revision`。v1 Knowledge 只保存决策、约束、验证证据、逐 gate PASS 回执与后续事项，不保存聊天、完整用户提示或完整专家提示；完成后必须写入、读回、验证再声称 completed。

不得直接编辑 `.ezagent/**`。所有状态变化由本地核心验证。不得自动联网或安装软件，不得自动执行任何 Git 写操作，不得自动发布或上传项目。
