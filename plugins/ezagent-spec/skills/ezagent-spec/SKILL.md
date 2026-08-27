---
name: ezagent-spec
description: 在已初始化项目中，把需要跨步骤、跨会话或受控执行的任意 Agent 请求整理为 Brief、Work Spec、Slices、Evidence 与 Approval Points；支持先交付规划材料、人工确认后再实施。
---

# EZagent Spec

## 先形成共同理解

先取当前 `SKILL.md` 所在目录，再向上两级得到 `<plugin-root>`，把 `dist/ezagent-cli.mjs` 解析为 `<absolute-cli-path>` 绝对路径；不要在 `PATH` 中搜索其他 EZagent，也不要要求用户输入或运行 CLI。

必须使用支持 argv 数组的进程执行接口，禁止拼接 shell 字符串。每个动态值必须作为一个独立 argv 元素。若宿主只支持 shell 字符串，必须按当前 shell 的 literal 规则完整编码每个参数；无法证明编码正确就关闭失败，不得仅自行添加双引号。

所有需要 JSON 输入的命令默认使用可关闭的非交互 stdin pipe，并在写入一个 JSON 文档后明确发送 EOF。若宿主进程接口使用 PTY，无法可靠关闭 stdin EOF，禁止继续等待、后台运行或盲目重试 mutation；改用宿主文件能力把完全相同的 JSON 写入一个新建、权限受限的临时普通文件。临时文件必须位于操作系统临时目录且在项目根目录之外，不得位于 `<absolute-project-root>`、`.ezagent/**` 或任何业务文件目录；再把 `--input-file` 和该文件的绝对路径作为两个独立 argv 元素传给原命令。不得使用符号链接，不得使用 shell 输入重定向。预览与 Apply 必须读取完全相同的文件和字节；Apply 完成、用户拒绝或流程终止后删除临时文件。最后兜底仅用于宿主不能用非交互 pipe 可靠关闭 stdin EOF、且文件能力禁止写入上述项目外临时文件的情况：把 `--input-json` 和完全相同的 JSON 文档作为两个独立 argv 元素传给原命令；为兼容 Windows 命令行上限，该选项只接受不超过 24,576 bytes 和 24,576 字符的 UTF-8 单文档。不得使用 `printf`、shell 管道、重定向或命令替换；若宿主只支持 shell 字符串，必须遵守本 Skill 开头的 literal 编码规则。Preview 与 Apply 必须复用完全相同的 JSON 字符串。argv 可能被宿主记录；内容含密钥、token、个人敏感信息、超限、literal 编码不确定或无法作为独立 argv 传递时必须关闭失败。不得退回 PTY 试探或重复启动目标 JSON 命令。

若由 Router 在同一任务实际转交，Router 已提供针对同一项目根、刚刚取得的完整 `context`，且两者之间没有任何状态变化，必须复用该可信 context，不得重复执行。缺少完整结果、项目根不同、发生过状态变化或无法证明仍新鲜时，才执行：

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

生成 Work Contract 前必须把 [references/work-contract-v2.md](references/work-contract-v2.md) 完整读取一次，并严格复用其中的字段名、枚举、稳定 Capability 词表和最接近的有效模板；不得再从 CLI 报错、`--help`、Catalog 或 `dist` 猜 schema。Router 选择 Planning-first 时，还必须把 [references/planning-first.md](references/planning-first.md) 完整读取一次；未选择时不要加载该参考。

根据 Router 已选模式生成 `schemaVersion: 2` 的单个 JSON：

- `brief`：请求摘要、预期结果、参与者、Canonical Terms、已确认决策、带来源的假设、未决问题和 Source Pointers。
- `workSpec`：`brief` / `standard` / `controlled` 模式、范围、非目标、Deliverable Interfaces、Acceptance Criteria、Boundaries、Approval Points、Review Policy 和 Slice Plan。
- `specialistAssessment`：每次都必须显式存在。能力和上下文已足够时用 `decision: not-needed`、有界 `reasons` 与空 `needs`；确有领域判断、上下文隔离、独立并行或独立审查需求时用 `decision: required`，并为每个需要填写 `id`、`sliceId`、`purpose`、`capabilities`、`domains`、`projectSignals` 和 `isolationReason`。
- 每个 Acceptance Criterion 必须声明所需 Evidence kinds；每个 Criterion 至少被一个 Slice 覆盖。
- 第一个 Tracer Slice 必须无依赖并尽快产出一个可验证的端到端结果；总 Slice 数保持在 1–15 个，优先小而完整的纵向切片。
- 当前版本逐 Slice Review，`reviewAfterSlices` 必须为 `1`。标记 `humanCheckpoint: true` 的 Slice 必须至少有一个要求 `human-approval` Evidence 的 Criterion。
- Deliverable Interface 描述结构、不可破坏的约束和消费者，不预先臆造大段正文或实现细节。
- 外部写入或发布只能进入 `controlled`，且目标必须有精确 Approval Point。Controlled Review 必须包含 human 或 mixed 判断以及 `human-approval` Evidence。
- Approval Point 的 `contentHash` 只能来自精确 payload 或其本地产物经实际哈希工具计算的 SHA-256；不得猜测、复用旧值或示例值，也不得用 content summary 冒充 payload。payload 尚未产生时，当前 Work Contract 不得包含真实 Side Effect；先完成并审查草稿，草稿确定后再为外部动作创建新的 Controlled Work Contract，并使用该版本的实际 hash。

合同必须保持最小必要：默认使用 1–3 个 Slice、1–3 个 Deliverable Interface 和 3–6 条 Acceptance Criteria；只有真实依赖或安全边界证明需要时才增加。每个字段写可验证的最短内容，不重复同一风险、范围或证据要求。对同一 Slice 中 purpose 相同、能力与隔离原因相同的工作，合并为一个 Capability Need；不要按设计、编码、测试等阶段机械复制专家，也不要为每条 Criterion 单独建 Need。实现与 `independent-review` purpose 必须保持分离，不能为了缩短合同而合并。

### Planning-first 合同映射

Planning-first 不新增 schema 字段。只为用户明确要求的规划材料，或 Router 推荐且用户接受纳入本次 Outcome 的规划材料，创建 `kind: document` 的 Deliverable Interface；不得自动创建 PRD、技术设计、实施计划三件套。文档位置优先遵守项目既有的文档约定；没有约定时才建议 `docs/` 下的清晰路径，并在 Work Preview 中逐项展示准确路径、必需章节、消费者和不变量。

把规划材料放在第一个可交付的规划 Slice。若本 Work Item 还包含实施，该规划 Slice 必须设置 `humanCheckpoint: true`，并覆盖至少一个要求 `human-approval` Evidence 的 Criterion；实施 Slice 的 `blockedBy` 必须包含这个规划 Slice。不得把 Work Preview 的合同批准冒充规划成果批准，也不得在缺少该 Evidence 时开始实施。用户只要求规划，包括调研、PRD、技术设计或实施计划时，不得为了“以后可能会做”增加实施 Slice。

规划材料可以由同一个 Slice 共同交付，只有真实依赖才拆成多段；选择 Specialist 仍按能力与隔离收益判断，不能因为启用 Planning-first 就机械增加专家。会改变交付范围的唯一问题必须在 Work Preview 前提出；规划执行中发现新的实质范围变化时遵守本 Skill 的范围变化规则。

Specialist 和多 Agent 的实际执行仍是可选手段，但 `specialistAssessment` 是 Work Contract 的必填判断。Assessment 不得填写 expert ID、指定人数或借岗位名称预选团队；本地核心根据已批准的 Capability Needs 和运行时 Catalog 确定性生成 Specialist Plan。若需要独立审查，review need 必须使用 `independent-review`，并与同一 Slice 的实现者隔离。任何生成的委派必须绑定 `Work Item ID`、`Work Spec ID`、`Slice ID`、`delegation ID`、`scope`、`deliverables` 和 `Evidence requirements`，只回传有界摘要，不保存完整用户提示或完整专家提示。

形成 Capability Needs 只做语义判断；不得为选择能力而读取、搜索或枚举 `catalog/experts.json`，不得遍历 expert ID，也不得搜索 `dist` 源码来反推专家名称。Core 对 Work Preview 返回的 Specialist Plan 负责确定性匹配；协调器不得根据专家名称或简介二次猜测 Core 的确定性匹配。只有 Core 明确返回 `uncoveredCapabilities` 或 `blockers` 时才能据此修正，并且最多重做一次预览；仍有缺口就把 blocker 如实展示给用户，不得扩大 Catalog 探索或盲目重试。

在 Codex 的命令工具或 PTY 中，JSON 不得通过 `printf`、shell 管道、重定向、命令替换或超长内联原文送入 CLI；优先按本 Skill 开头的规则使用 stdin 或项目外 `--input-file`，文件能力被拒绝时才使用有界 `--input-json` 兜底。公开输入契约只有 stdin、`--input-file` 和 `--input-json`；不得执行 `work-preview --help`、无参 CLI，或搜索 `dist` 来重新发现 schema。只读 `work-preview` 也遵守此规则。同一份合同不得重复启动 `work-preview` 来试探输入通道；只有正常结束的校验结果才能触发一次有界修正。

Router 已选择的模式由用户请求本身决定。源码、样本数据或权限暂缺，或者 CodeGraph 等辅助分析工具不可用、未初始化或要求另行批准，都不得把请求退回 Consult，也不得在 Outcome、边界和验收方式已经可以定义时阻止 Work Preview。Router 已产出事实预检摘要与 Source Pointers 时，合同必须复用其中的观察事实：现有路径只能来自实际观察，新路径必须标记为建议或拟新增；没有相应 Source Pointer 时，不得把臆造的文件名、模块或数据结构写成项目事实。把剩余的必要发现、数据校验或工具准备放进第一个 Tracer Slice，把未知项记录为有来源的假设、未决问题或 blocker；只有缺失答案会实质改变 Outcome 或安全边界且无法用上述方式表达时，才暂停并只问一个问题。

只读 sandbox 不阻止只读的 `work-preview`，只会阻止获批后的 `work-apply` 与实际实施。先生成并展示安全预览；不得因为当前不能写业务文件就声称请求是 Consult、跳过 Specialist Assessment 或结束已完成的 Router 转交。

把完全相同的 Work Contract JSON 从 stdin 先传给只读预览：

```json
["node", "<absolute-cli-path>", "work-preview", "--root", "<absolute-project-root>"]
```

`work-preview` 的返回值始终是完整合同；不得删除、缩减或改写任何 Work Contract 字段，也不得因为默认展示更短而改变 Preview 与 Apply 使用的 JSON 字节。显示层按风险分级：

- Brief 与 Standard 默认只显示目标、交付物、完成条件、执行步骤，以及非空的风险、假设、未决问题和批准点。执行步骤是 Slice 的短标题与依赖摘要；完成条件是 Acceptance Criteria 的可读摘要。事实预检确实帮助用户核对提纲时，可附一行“依据：”列出最关键的 Source Pointers，不倾倒搜索过程。Mode 只需在一处附带说明，不逐字段复述 Canonical Terms、Evidence kinds、Review Policy、空 Specialist Assessment、内部 ID 或 approval token。
- 用户要求“展开完整合同”、逐项审查或调试预览时，展示完整 Outcome、Mode、Scope / Non-goals、Deliverable Interfaces、Acceptance Criteria、Slices、Review Policy、Approval Points、关键假设、未决问题、Specialist Assessment、delegations、未覆盖能力与 blockers。
- Controlled 必须完整展示 Boundaries、Approval Points、资源访问、Review Policy、人工判断和 Side Effect 风险；不得使用紧凑展示隐藏安全信息。Controlled 的 Work Contract 批准不等于任何具体 Side Effect 授权。
- Specialist Assessment 为 `required`、存在未覆盖能力或 blocker 时，即使是 Brief 或 Standard，也必须展示相应计划和本 Skill 规定的“委派边界”。`not-needed` 且无 blocker 时只需一句“无需额外 Specialist”。

紧凑预览仍是同一份合并预览，Brief、Standard 和 Controlled 都只请求一次合同批准，不得把 Specialist Plan 另拆成一次例行确认。存在 blocker 时先修正 Capability Need 或说明能力缺口，不得 Apply。批准前说明：批准后完整 Brief、Work Spec、Work Item 与 Specialist Plan（如有）会分别以可读文件保存在 `.ezagent/requirements/`、`.ezagent/specs/`、`.ezagent/tasks/` 和 `.ezagent/experts/plans/`；用户随后可以直接检查这些文件。预览阶段保持零写入，因此用户需要批准前查看全部字段时必须在对话中展开，不得先写临时合同到项目目录。

批准前必须明确说明：所有 expert ID 和 delegation 都只是计划，project Agent 尚未物化、Specialist 尚未实际委派、尚未发生独立审查。没有匹配的 completion receipt 时不得声称“已完成审查”“审查结论”或 reviewer 已工作；协调器在预览阶段做的判断只能称为风险预检、方案自检或待审查问题。预览还必须说明批准后的执行边界：dispatch 只包含获批的 Work Item ID、Work Spec ID、Slice ID、delegation ID、scope、deliverables 与 Evidence requirements，并且 Specialist 只回传有界结果摘要、result hash 和最小 Evidence pointers。

当 Specialist Assessment 为 `required` 时，最终答复必须在请求批准前包含名为“委派边界”的三项短说明，不得省略：①现在只是计划、未实际委派或审查；②批准后 Core 生成上述最小 dispatch；③协调器必须调用 expert ID 匹配的隔离 project Agent，协调器不得模拟 Specialist，且只接收有界摘要、result hash 与最小 Evidence pointers。

用户批准后，把完全相同的 JSON 从 stdin 传入，并把预览 token 作为独立 argv 元素原子创建 Brief、Work Spec 与 Work Item：

```json
["node", "<absolute-cli-path>", "work-apply", "--root", "<absolute-project-root>", "--approval-token", "<approval-token>"]
```

Apply 会物化已批准的 project Agents，并返回 `specialistPlan` 与 `platformSyncStatus`。Apply 后重新读取 `context`，确认 `sourceSchemaVersion: 2`；存在 delegations 时还必须确认 `specialists.status: ready` 与 `platformSyncStatus: ready`，再转 `$ezagent-execute`。token 漂移、字段校验或平台同步失败时关闭失败并重新读取上下文，不猜测成功。

## 范围变化

执行中若 Outcome、Scope、Non-goals、Criterion、资源权限、风险或 Approval Point 实质变化，停止当前 Slice 并明确展示变化；当前 v2 不静默扩写或直接改状态文件。由用户决定收缩回已批准范围，或在结束当前 Work Item 后为新范围创建新的 Work Contract。

不得直接编辑 `.ezagent/**`。所有状态变化由本地核心验证。不得自动联网或安装软件，不得自动执行任何 Git 写操作，不得自动发布或上传项目。
