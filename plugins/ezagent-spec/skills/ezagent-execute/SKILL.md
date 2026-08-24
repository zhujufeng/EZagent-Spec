---
name: ezagent-execute
description: 执行已批准的通用 EZagent Work Item：一次推进一个纵向 Slice，维护有界 Work Journal，收集 Criterion 对应 Evidence，并把外部 Side Effect 与本地工作严格分离。
---

# EZagent Execute

## 恢复一个 Slice

先取当前 `SKILL.md` 所在目录，再向上两级得到 `<plugin-root>`，把 `dist/ezagent-cli.mjs` 解析为 `<absolute-cli-path>` 绝对路径；不要在 `PATH` 中搜索其他 EZagent，也不要要求用户输入或运行 CLI。

必须使用支持 argv 数组的进程执行接口，禁止拼接 shell 字符串。每个动态值必须作为一个独立 argv 元素。若宿主只支持 shell 字符串，必须按当前 shell 的 literal 规则完整编码每个参数；无法证明编码正确就关闭失败，不得仅自行添加双引号。

```json
["node", "<absolute-cli-path>", "context", "--root", "<absolute-project-root>", "--json"]
```

仅接受 `sourceSchemaVersion: 2` 的 active Work Item。安全模式或 inspection-required 只诊断。核对 Mode、Outcome、Scope、Non-goals、Boundaries、Deliverable Interfaces、Acceptance Criteria、Review Policy、Slice 状态和最新 Work Journal。

选择第一个依赖已 accepted 的 `pending` 或 `revise` Slice，并显式开始：

```json
["node", "<absolute-cli-path>", "work-start", "--root", "<absolute-project-root>", "--slice", "<slice-id>"]
```

每次只推进一个小而完整的纵向 Slice。先做最小 Tracer Slice，尽早验证 Source Pointer、交付接口和证据路径，再增加深度。不要按岗位拆成互不连通的大阶段，也不要为了“显得专业”创建专家团队。

Specialist 和多 Agent 只在领域判断、上下文隔离、真正独立的并行 Slice 或独立审查有明确收益时使用；人员和数量不固定。任何委派都必须绑定 `Work Item ID`、`Work Spec ID`、`Slice ID`、`delegation ID`、`scope`、`deliverables` 和 `Evidence requirements`，不持久化完整提示，也不得回传完整提示。

## Journal 与 Evidence

发生实质进展、切换上下文、失败尝试或需要暂停时，将有界 Journal entry 作为单个 JSON 从 stdin 传入。只记摘要、观察、决策、失败路径、明确下一步和最小 Context Pointers，不保存敏感信息、聊天或大段原文：

```json
["node", "<absolute-cli-path>", "journal-append", "--root", "<absolute-project-root>"]
```

完成 Slice 后，按其 Criterion 收集真实 Evidence。可用 kinds 为 `command`、`artifact`、`checklist`、`comparison`、`citation`、`human-approval`、`external-record`；每条 Evidence 必须绑定 `Work Item ID`、`Work Spec ID`、`Slice ID` 和 Criterion IDs。不要把“我认为完成了”当 Evidence。

把完整 Evidence Bundle 从 stdin 提交给本地核心：

```json
["node", "<absolute-cli-path>", "work-review", "--root", "<absolute-project-root>"]
```

`coverage.complete: false` 时只修正返回 missing 的 Criterion，Journal 记录失败方法后重新开始该 Slice；通过后继续下一个可执行 Slice。Review Policy 要求 independent-agent、human 或 mixed 时转 `$ezagent-review` 完成对应的独立或人工判断。

## Controlled Side Effect

本地分析、草拟和验证可以按 Slice 进行；发送、发布、外部系统写入、预算承诺等真实 Side Effect 必须命中 Work Spec 中目标完全一致的 Approval Point。先生成只读预览：

```json
["node", "<absolute-cli-path>", "side-effect-preview", "--root", "<absolute-project-root>", "--approval-point", "<approval-point-id>"]
```

向用户展示 action、target、content summary、content hash、impact、reversible、verification 和 recovery。只有用户明确批准这份精确预览后才写入本地授权：

```json
["node", "<absolute-cli-path>", "side-effect-apply", "--root", "<absolute-project-root>", "--approval-point", "<approval-point-id>", "--approval-token", "<approval-token>"]
```

Apply 只生成 `externalActionExecuted: false` 的授权记录，不会执行外部动作。随后也只能按用户刚批准的 action、target 和 content hash 调用对应外部能力；任一内容或目标漂移都必须重新预览和批准。执行后用 `external-record` Evidence 记录真实外部状态，失败时按 recovery 处理并如实报告。

不得直接编辑 `.ezagent/**`。所有状态变化由本地核心验证。不得自动联网或安装软件，不得自动执行任何 Git 写操作，不得自动发布或上传项目。
