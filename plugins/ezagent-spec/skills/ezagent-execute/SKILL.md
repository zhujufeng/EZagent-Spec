---
name: ezagent-execute
description: 执行已批准的通用 EZagent Work Item：一次推进一个纵向 Slice，维护有界 Work Journal，收集 Criterion 对应 Evidence，并把外部 Side Effect 与本地工作严格分离。
---

# EZagent Execute

## 恢复一个 Slice

先取当前 `SKILL.md` 所在目录，再向上两级得到 `<plugin-root>`，把 `dist/ezagent-cli.mjs` 解析为 `<absolute-cli-path>` 绝对路径；不要在 `PATH` 中搜索其他 EZagent，也不要要求用户输入或运行 CLI。

必须使用支持 argv 数组的进程执行接口，禁止拼接 shell 字符串。每个动态值必须作为一个独立 argv 元素。若宿主只支持 shell 字符串，必须按当前 shell 的 literal 规则完整编码每个参数；无法证明编码正确就关闭失败，不得仅自行添加双引号。

所有需要 JSON 输入的命令默认使用可关闭的非交互 stdin pipe，并在写入一个 JSON 文档后明确发送 EOF。若宿主进程接口使用 PTY，无法可靠关闭 stdin EOF，禁止继续等待、后台运行或盲目重试 mutation；改用宿主文件能力把完全相同的 JSON 写入一个新建、权限受限的临时普通文件。临时文件必须位于操作系统临时目录且在项目根目录之外，不得位于 `<absolute-project-root>`、`.ezagent/**` 或任何业务文件目录；再把 `--input-file` 和该文件的绝对路径作为两个独立 argv 元素传给原命令。不得使用符号链接，不得使用 shell 输入重定向。预览与 Apply 必须读取完全相同的文件和字节；Apply 完成、用户拒绝或流程终止后删除临时文件。最后兜底仅用于宿主不能用非交互 pipe 可靠关闭 stdin EOF、且文件能力禁止写入上述项目外临时文件的情况：把 `--input-json` 和完全相同的 JSON 文档作为两个独立 argv 元素传给原命令；为兼容 Windows 命令行上限，该选项只接受不超过 24,576 bytes 和 24,576 字符的 UTF-8 单文档。不得使用 `printf`、shell 管道、重定向或命令替换；若宿主只支持 shell 字符串，必须遵守本 Skill 开头的 literal 编码规则。Preview 与 Apply 必须复用完全相同的 JSON 字符串。argv 可能被宿主记录；内容含密钥、token、个人敏感信息、超限、literal 编码不确定或无法作为独立 argv 传递时必须关闭失败。不得退回 PTY 试探或重复启动目标 JSON 命令。

```json
["node", "<absolute-cli-path>", "context", "--root", "<absolute-project-root>", "--json"]
```

若用户明确要求取消或放弃当前 active Work Item，先说明未完成 Slice 将终止而 Plan、Receipt、Evidence 与 Journal 历史保留。重新执行 `context` 取得最近的 `state.activeWorkItem.revision`；active item 已为空时不得调用：

```json
["node", "<absolute-cli-path>", "work-cancel", "--root", "<absolute-project-root>", "--revision", "<active-work-item-revision>"]
```

取消后重新执行 `context`，确认 `state.activeWorkItem` 为 null 后停止本 Work Item。不得因为 Slice blocked、Evidence 缺失或能力不足而自行取消。

仅接受 `sourceSchemaVersion: 2` 的 active Work Item。安全模式或 inspection-required 只诊断。核对 Mode、Outcome、Scope、Non-goals、Boundaries、Deliverable Interfaces、Acceptance Criteria、Review Policy、Slice 状态和最新 Work Journal。

选择第一个依赖已 accepted 的 `pending` 或 `revise` Slice，并显式开始：

```json
["node", "<absolute-cli-path>", "work-start", "--root", "<absolute-project-root>", "--slice", "<slice-id>"]
```

每次只推进一个小而完整的纵向 Slice。先做最小 Tracer Slice，尽早验证 Source Pointer、交付接口和证据路径，再增加深度。不要按岗位拆成互不连通的大阶段，也不要为了“显得专业”创建专家团队。

Specialist 与多 Agent 只按已批准计划执行，人员和数量不固定。若 `context.specialists.status: ready`，只处理当前 Slice 上已批准的 delegations；不得新增专家、替换 expert ID 或把委派静默改成协调器自执行。`work-start` 会对有委派的 Slice 检查 project Agents，`platformSyncStatus` 不是 `ready` 时只诊断并停止。

对当前 Slice 的每个 `analysis` 或 `implement` delegation，先创建不可变 start receipt：

```json
["node", "<absolute-cli-path>", "delegation-start", "--root", "<absolute-project-root>", "--delegation", "<delegation-id>"]
```

然后必须使用宿主原生 subagent 工具，在隔离上下文中执行返回 `expertId` 对应的专家。Codex 优先调用已生成的 project Agent；Claude Code 或 OpenCode 若不能加载 Codex TOML，则从 `<plugin-root>/catalog/experts.json` 精确读取同一 `expertId` 的专家定义，并把它作为隔离上下文的专家指令。宿主没有可用 subagent 能力时必须提交 blocked 回执，不得由协调器模拟专家。把 `delegation-start` 返回的 `dispatch` 作为完整任务载荷原样发送给 subagent；不保存完整提示，不得改写、扩写或附加聊天、完整用户提示、其他专家指令或未批准范围。该 dispatch 已包含批准的 `Work Item ID`、`Work Spec ID`、`Slice ID`、`delegation ID`、scope、deliverables 和 Evidence requirements，start receipt 的 `dispatchFingerprint` 绑定它的规范化内容。subagent 只回传有界结果摘要、result hash 和最小 Evidence pointers。协调器验证绑定后，completion JSON 必须使用 `schemaVersion: 2` 并原样回填 start receipt 的 `dispatchFingerprint`，再从 stdin 或上述 `--input-file` 通道提交：

```json
["node", "<absolute-cli-path>", "delegation-complete", "--root", "<absolute-project-root>", "--delegation", "<delegation-id>"]
```

专家无法完成时提交 `status: blocked` 的真实回执并让 Slice 进入 `revise`；不得伪造 `completed`，协调器不得自行接管已批准委派。当前 Slice 有 `review` delegation 或 Review Policy 为 `independent-agent` / `mixed` 时，转 `$ezagent-review` 使用隔离的 reviewer project Agent；实现者和协调器都不得替代独立审查者。

只有出现真实能力缺口且没有已开始但未完成的 receipt 时，才可提交只含新 `specialistAssessment` 的 Specialist-only replan 预览：

```json
["node", "<absolute-cli-path>", "specialist-replan-preview", "--root", "<absolute-project-root>"]
```

它不得改变 Outcome、Scope、Non-goals、Deliverable Interfaces、Acceptance Criteria、Boundaries 或 Approval Points。向用户精确展示 added、removed、changed、unchanged delegations；用户批准这份 diff 后才可 Apply：

```json
["node", "<absolute-cli-path>", "specialist-replan-apply", "--root", "<absolute-project-root>", "--approval-token", "<approval-token>"]
```

Apply 后必须确认新的 plan revision 与 project Agents 已同步；token 或 workspace 漂移就重新预览。不得用 replan 覆盖未完成委派或绕过原 Work Contract。

## Journal 与 Evidence

发生实质进展、切换上下文、失败尝试或需要暂停时，将有界 Journal entry 作为单个 JSON 从 stdin 传入。只记摘要、观察、决策、失败路径、明确下一步和最小 Context Pointers，不保存敏感信息、聊天或大段原文：

```json
["node", "<absolute-cli-path>", "journal-append", "--root", "<absolute-project-root>"]
```

完成 Slice 后，按其 Criterion 收集真实 Evidence。可用 kinds 为 `command`、`artifact`、`checklist`、`comparison`、`citation`、`human-approval`、`external-record`；每条 Evidence 必须绑定 `Work Item ID`、`Work Spec ID`、`Slice ID` 和 Criterion IDs。不要把“我认为完成了”当 Evidence。

当前 Slice 为 `humanCheckpoint: true` 时，先完成并收集所有非人工 Evidence，向用户展示可审查的交付物、准确路径、对应 Criterion 和仍缺少的人工判断，然后停止并请求明确批准。不得把 Work Preview 的合同批准、初始化批准、沉默或含糊回复记录成 `human-approval`。用户后续明确认可当前交付物版本时，才把该决定作为绑定当前 Slice 与 Criterion 的 `human-approval` Evidence，并随完整 Evidence Bundle 调用 `work-review`。用户拒绝或要求修改时不得创建 `human-approval`；记录反馈、修正交付物，并让 Slice 保持 executing 或经正常 Review 进入 `revise`，不得启动任何依赖它的下游 Slice。

把完整 Evidence Bundle 从 stdin 提交给本地核心：

```json
["node", "<absolute-cli-path>", "work-review", "--root", "<absolute-project-root>"]
```

`coverage.complete: false` 或 `delegationCoverage.complete: false` 时只修正返回的 missing Criterion 或未完成 delegation，Journal 记录失败方法后重新开始该 Slice；两类 coverage 都完整后才继续下一个可执行 Slice。Review Policy 要求 independent-agent、human 或 mixed 时转 `$ezagent-review` 完成对应的独立或人工判断。

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
