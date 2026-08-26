# EZagent Work Harness

EZagent Spec 正在演进为一个中文、Local-only、领域中立的 Agent Work Harness。它把“直接让 Agent 开始做”的 vibe 工作，变成一条轻量但可恢复、可审查的链路：

```text
共同理解 → Brief → Work Spec → 纵向 Slices → Evidence → Decision
                         ↘ Work Journal
                         ↘ 精确批准的 Side Effect
```

## 不懂开发也能用：从零开始

先说结论：EZagent 可以分发给普通同事使用。它适合在可信的个人或公司电脑上，帮助同事完成分析、文档、策划、流程整理、代码修改等工作；同事只需要用自然语言交流，不需要理解 CLI、JSON、Git、状态机或 Specialist ID。

它不是“装好后接管所有聊天”的机器人，也不是外部系统的安全审批平台。只有在某个项目里初始化后，项目相关工作才会自动进入 EZagent；发送、发布、付款、写生产系统等真实外部动作仍要由人确认，并受宿主本身的权限和审批能力约束。

### 第 0 步：准备好三样东西

你需要：

1. Codex、Claude Code 或 OpenCode 其中一个 Agent 宿主。
2. Node.js 22 或更高版本。
3. 一个准备工作的项目文件夹。它可以是代码项目，也可以只是放文档、表格或资料的普通文件夹。

不知道 Node.js 是什么也没关系。直接对 Agent 说：

> 请只检查当前电脑是否安装 Node.js 22 或更高版本，不要自行安装或修改配置；把检查结果用中文告诉我。

如果没有安装，让公司的 IT 或懂电脑的同事协助。EZagent 不会静默安装 Node.js。

### 第 1 步：安装插件

最省心的方式是把下面整句话发给 Agent：

> 请帮我安装 EZagent Work Harness：https://github.com/zhujufeng/EZagent-Spec 。先检查 Agent 宿主和 Node.js 22+。任何联网、安装软件或修改全局配置的动作都先向我确认。完成后告诉我安装的插件版本和启用状态。

Agent 请求联网或修改插件配置时，确认目标确实是 `zhujufeng/EZagent-Spec` 再批准。熟悉终端的同事也可以使用后文的宿主安装命令。

### 第 2 步：安装后一定新建一个任务

这是最容易漏掉的一步。插件安装或升级完成后，不要继续使用安装前已经打开的旧任务；请在 Codex 侧边栏或对应宿主中新建一个任务。新任务启动时才会加载最新版 Skills。

### 第 3 步：打开项目文件夹并初始化

在新任务里打开要工作的项目文件夹，然后说：

> 请在当前项目启用 EZagent Work Harness。

Agent 会先展示初始化预览，通常只涉及：

- `.ezagent/**`：任务状态、计划、证据和历史；
- `AGENTS.md` 中的 EZagent 受管区块：让后续新任务自动进入 Router；
- `.codex/agents/ezagent-*.toml`：只有确实需要 Specialist 时才生成的项目专家。

初始化预览不会写文件。确认路径是当前项目、范围没有异常后，回复：

> 确认初始化。

每个项目只需初始化一次。不要手动创建、修改或删除 `.ezagent` 里的文件。

### 第 4 步：确认初始化真的成功

初始化后直接问：

> 请只检查 EZagent 是否初始化成功，并告诉我项目状态；不要开始新的工作。

正常结果应包含：项目已初始化、`activeWorkItem: null`、没有安全模式或 inspection-required。项目里也会出现 `.ezagent/project.yaml`。如果只是做了初始化，建议再新建一个任务后开始正式工作；如果同一句话里还包含了后续需求，EZagent 0.4.1 及以后会在初始化后把剩余需求重新交给 Router。

### 第 5 步：像平时一样说需求

不需要说“调用插件”，也不需要指定模式或专家。例如：

- “分析这个文件夹里的客户反馈，按问题类型归类，并给出可以复核的结论。”
- “把现有制度整理成新人第一天能照着做的操作手册。”
- “修复订单重复提交的问题，测试通过后告诉我改了什么。”
- “规划一个 Go 云服务器端口检测工具，先给我看范围和验收标准，不要直接实施。”
- “这个方案涉及安全和 Windows 兼容，请安排真正独立的专家审查。”

Router 会自动选择最轻且够用的方式：简单解释直接回答，局部小改快速完成，长任务则生成可恢复的 Work Contract。需要专家时，核心根据自然语言里的能力需求自动选择 Specialist；普通任务没有 Specialist 是正常结果，不代表插件失效。用户不需要知道或填写专家 ID。

### 第 6 步：看懂并确认 Work Preview

持久化任务开始前，Agent 会展示一份预览。非开发同事只需检查七件事：

1. Outcome：最后要得到什么？
2. Scope：这次会做哪些事？
3. Non-goals：哪些事明确不做？
4. Deliverables：最后会交付哪些文件或结果？
5. Acceptance Criteria：怎样才算完成？
6. Slices：会按什么小步骤推进？
7. Approval Points：哪些动作必须再次问你？

不满意就直接用自然语言纠正，例如：“不要改数据库，只输出迁移建议”“最终文档要给客服新人看”“增加一次独立安全审查”。预览修改正确后再回复：

> 我确认这份 Work Preview，可以创建工作项并开始执行。

初始化确认、Work Preview 确认和真实外部动作确认是三件不同的事，前一次确认不会自动授权后一次。

### 第 7 步：让 Agent 执行、暂停或恢复

执行时 EZagent 一次推进一个 Slice，保存必要 Journal，并逐条收集 Evidence。换电脑、关闭任务或第二天继续时，在新任务里说：

> 请恢复当前 EZagent 工作项，告诉我已经完成什么、下一步是什么，然后继续。

如果明确不做了，说：

> 请取消当前 EZagent 工作项，保留已有计划、证据和历史，然后确认我可以开始新任务。

不要通过删除 `.ezagent` 来“解除卡住”；正式取消会安全清空 active item，同时保留审计历史。

### 怎样判断插件正在正常工作

| 你看到的现象 | 是否正常 | 说明 |
|---|---|---|
| 只读问题直接回答，没有创建文件 | 正常 | Router 选择了 Consult |
| 小改动直接完成，没有 Work Preview | 正常 | Router 选择了 Quick |
| 长任务先展示 Outcome、Scope、Slices 和验收条件 | 正常 | 进入 Brief、Standard 或 Controlled |
| 普通任务没有任何 Specialist | 正常 | Specialist Assessment 判断不需要专家 |
| 高风险或独立审查任务自动出现少量 Specialist | 正常 | 核心按能力需求选人，不是用户点名 |
| 只运行了 `context`，没有说模式和下一个 Skill | 不正常 | `context` 只是准备动作，不等于完成路由 |
| 初始化后继续沿用旧 brainstorming / writing-plans | 不正常 | 升级插件并新建任务；0.4.1 已修复初始化交接 |
| 命令长时间等待 JSON 输入 | 不正常 | 升级到 0.5.0；新版会自动改用有界 `--input-file` 通道 |

### 新手常见问题

“安装后为什么没有自动调用？”

先确认这是安装后新建的任务，并确认当前项目存在 `.ezagent/project.yaml`。插件不会在未初始化项目里劫持普通聊天。仍不生效时，执行后文的升级步骤，完全退出并重开宿主，再新建任务。

“为什么没有 Specialist？”

Specialist 不是固定队伍，也不是每个任务必选。只有领域判断、上下文隔离、真正独立工作或独立审查有明确收益时才会创建。如果确实需要，可以说“请做 Specialist Assessment，并说明是否需要独立安全审查”，但仍由核心选择匹配的专家 ID。

“提示已有 active Work Item，不能开始新任务怎么办？”

如果要继续，就说“恢复当前工作项”；如果明确放弃，就说“取消当前工作项并保留历史”。不要手动改状态文件。

“Windows 路径有空格，会不会失败？”

支持。插件把每个路径作为独立 argv 参数处理，也为 PTY 无法关闭 stdin 的情况提供文件输入通道。仍有问题时，把完整报错和项目路径发给维护者，不要自行改 `.ezagent`。

“批准 Side Effect 后，消息是不是已经发送了？”

不是。EZagent Core 只写入 `externalActionExecuted: false` 的本地授权记录；真正发送、发布或外部写入由宿主能力执行。执行前仍要核对目标、账号和内容，执行后还要保存 `external-record` Evidence。

### 分发和安全边界

推荐分发范围：可信本机上的日常知识工作、项目规划、文档、分析、代码修改和有人工复核的受控流程。团队应统一使用带版本号的正式 Release，并在安装或升级后新建任务。

不要把 EZagent 当作以下系统的替代品：公司审批平台、密码或密钥管理器、生产权限系统、付款系统、不可抵赖电子签名、恶意本地进程隔离工具。Side Effect token 是本地工作流的漂移校验，不是不可伪造的用户签名；Core 也无法替宿主证明外部平台最终发送的 payload。对付款、生产发布、人事决定、法律承诺等高影响动作，必须继续使用公司的正式审批和权限制度。

它不限定谁能使用，也不按岗位分配流程。开发、分析、文档、调研、策划、流程整理等只是非穷尽示例；真正决定流程的是工作复杂度、影响、可逆性和需要的证据。

## 它解决什么问题

普通 vibe coding / vibe working 常见的问题不是 Agent 不会生成内容，而是：目标没有对齐、边界不断漂移、长任务中途失忆、完成声明没有证据、外部动作和本地草稿混在一起。

EZagent 用几个小而稳定的概念约束这些问题：

- `Brief` 保存用户真正要的结果、共同术语、已确认决策、假设和来源指针。
- `Work Spec` 明确范围、非目标、交付接口、验收条件、资源边界、审查方式和批准点。
- `Slice` 是可独立交付并验证的小型纵向切片；第一个 Tracer Slice 尽快证明整条路径可行。
- `Evidence` 必须绑定具体 Acceptance Criterion，而不是笼统地说“已经完成”。
- `Work Journal` 只保存进展、观察、决策、失败路径和下一步，让新会话快速恢复。
- `Decision` 从已经持久化的 Evidence 生成，沉淀可复用结论。
- `Side Effect` 把草拟与真实发送、发布、外部写入分开，按精确目标和内容单独批准。

## 五种工作模式

Router 总是选择“最轻且足够可靠”的模式：

| Mode | 适用情况 | 是否持久化 |
|---|---|---|
| Consult | 解释、只读咨询、一次性判断 | 否 |
| Quick | 目标明确、低影响、可逆、单会话完成 | 否 |
| Brief | 1–5 个可验证 Slice，或需要跨会话恢复 | 是 |
| Standard | 多来源、多交付物、依赖较多或中等影响 | 是 |
| Controlled | 敏感信息、外部沟通、发布、预算、生产系统、人员判断或难回滚动作 | 是，且 Side Effect 单独批准 |

模式不等于人员类型。库存负责人可以同时做 Consult、Quick 或 Standard；同一个运营请求也可能因为包含对外发布而进入 Controlled。项目里有哪些岗位，对核心状态机没有影响。

## 一次普通工作的样子

用户只需自然语言描述需求，例如：

- “分析这批库存预警为什么偏差这么大，给出可以复核的建议。”
- “根据这些访谈资料整理一份活动方案，事实和推断分开写。”
- “把这个招聘流程整理成新人能直接照做的检查清单。”
- “修复订单重复提交，并说明如何证明没有破坏原流程。”

Router 会先确认真正影响结果的少量问题，然后生成一份合并预览。用户看到的是 Outcome、Scope / Non-goals、Deliverable Interfaces、Acceptance Criteria、Slices、Review Policy、Approval Points 和关键假设，而不是一轮很长的问卷。

批准后，Agent 一次推进一个 Slice：

1. 显式开始 Slice。
2. 在已批准边界内产出一个可使用的纵向结果。
3. 用 Journal 保存必要的恢复信息。
4. 按 Criterion 收集 `command`、`artifact`、`checklist`、`comparison`、`citation`、`human-approval` 或 `external-record` Evidence；`humanCheckpoint: true` 的 Slice 必须有要求 `human-approval` 的 Criterion。
5. Evidence coverage 或已批准 Delegation 的 completion coverage 缺失，就把该 Slice 标记为 `revise`；两者完整才 `accepted`。
6. 所有 Slice 通过后，由最新持久化 Evidence 生成 Decision 并完成 Work Item。

当前版本逐 Slice Review，因此 `reviewAfterSlices` 只能为 `1`；不会接受一个看似支持批量反馈、实际却在运行期被忽略的 cadence。

用户明确放弃进行中的工作时，Agent 使用最新 active Work Item revision 调用 `work-cancel`。取消会清空 active item 并退役该任务的托管专家，但保留 Plan、Receipt、Evidence 与 Journal 历史；随后可以创建新的 Work Contract。

这就是本项目融入的 Spec 思想：Spec 不是一份越长越好的文档，而是“共同理解 + 明确接口和边界 + 小步交付 + 逐条证据”的可执行契约。

## Specialist 与多 Agent

新 v2 工作流不要求专家团队，也没有固定专家人数。默认情况下，一个维护者或一个业务同事就可以沿同一条 Work Contract 完成工作。

每个新的持久化 v2 Work Item 都必须完成一次 Specialist Assessment：明确记录为什么不需要专家，或声明绑定具体 Slice 的能力需求。Agent 只提交能力、领域、用途和隔离理由；本地核心从随插件发布的锁定 Agency Agents 目录中确定性选择专家，不接受模型直接指定专家 ID。

只有以下情况能证明收益时才选择 Specialist 或多 Agent：领域判断、上下文隔离、真正独立的并行工作、独立审查。初始选择与 Work Contract 在同一份预览中展示和批准；选中的专家会被物化为项目级 Agent。

执行时，协调器必须调用与已批准 `expertId` 对应的 project Agent，不能把“生成了 Agent 文件”当成已经完成委派，也不能静默改成自己执行。Core 会从批准的 delegation 生成唯一 `dispatch`，包含 Work Item、Work Spec、Slice、Delegation ID、范围、交付物和 Evidence requirements；协调器必须把它原样交给隔离 Agent。start/completion receipt v2 同时保存 `dispatchFingerprint`，完成回执指纹不一致就关闭失败。旧版 receipt v1 仍可读取和完成，不会让升级中的工作项失效。只接收有界结果摘要、result hash 与 Evidence pointers；独立 reviewer 必须与同一 Slice 的实现者不同。

执行中出现真实能力缺口时，可以做 Specialist-only replan。它只改变 assessment 与执行策略，展示 added、removed、changed、unchanged delegation diff 并单独批准，不能修改 Outcome、Scope、Non-goals、Acceptance Criteria、Boundaries 或 Approval Points，也不能覆盖未完成回执。Work Item 完成或取消后，只绑定该任务的 active experts 和 EZagent 托管 Agent 文件会退役，Plan 与 Receipt 历史保留。

第一版保持一次推进一个 Slice；同一 Slice 内真正独立的专家工作可以并行，多个 Slice 同时进入执行状态留待后续版本。

原来的自动专家团队、Requirement / Spec / Task、Plan / replan 和质量门流程继续作为 `sourceSchemaVersion: 1` 的编码兼容适配器保留；旧项目可以恢复和完成，新工作默认进入通用 v2 Work Harness。

## Controlled Side Effect

本地分析、草拟和验证不等于授权真实外部动作。发送消息、发布内容、写入外部系统、预算承诺等动作必须：

1. 在 Work Spec 中声明目标匹配的 Approval Point。
2. 向用户展示 action、target、content summary、content hash、影响、可逆性、验证与恢复方法。
3. 用户明确批准这份精确预览后，本地核心才写入授权记录。
4. 授权记录固定为 `externalActionExecuted: false`；它本身不会调用外部系统。
5. 宿主执行器应只使用刚批准的目标和内容；发生漂移必须重新预览。Core 负责本地记录和漂移校验，不声称能替外部宿主证明最终 payload。
6. 动作后以 External Record Evidence 记录真实结果。

结构化资产和 Journal 会拒绝明显的邮箱、手机号、身份证、私钥、Bearer token 和凭据赋值等高置信敏感内容。更复杂的数据分类仍应遵循公司的权限与合规制度。

## 安装

三个宿主都要求 Node.js 22+。插件包含自足 CLI、兼容专家目录和运行时许可证，普通使用者不需要在业务项目执行 `npm install`。

### Codex

```bash
codex plugin marketplace add zhujufeng/EZagent-Spec
codex plugin add ezagent-spec@ezagent
```

安装或更新后新建一个 Codex 任务，让新 Skills 生效。

### Claude Code

在 Claude Code 中执行：

```text
/plugin marketplace add zhujufeng/EZagent-Spec
/plugin install ezagent-spec@ezagent
```

也可以在仓库 checkout 中临时验证：

```bash
claude --plugin-dir ./plugins/ezagent-spec
```

### OpenCode

本仓库提供 `.opencode/skills/` 薄入口，直接从仓库根目录启动 OpenCode 即可；入口只负责加载 `plugins/ezagent-spec/skills` 中的 canonical Skill，不复制工作流逻辑。

要在其他项目使用，把构建后的 `plugins/ezagent-spec` 包内容完整合并到目标项目的 `.opencode/`。包根级的 `skills/`、`dist/` 与 `catalog/` 会保持 Skills 所需的相对路径，OpenCode 会忽略同包的 Claude/Codex manifest。不要只复制单个 Skill；若 `.opencode/` 已存在，安装器必须逐项合并并拒绝覆盖既有同名文件。

版本遵循语义化规则：兼容的新能力提升次版本，例如 `0.1.0 → 0.2.0`；后续兼容性修复依次使用 `0.2.1`、`0.2.2` 等小版本，避免相同版本号命中旧缓存。

也可以把下面这句话交给当前宿主：

> 请帮我为当前 Agent 宿主安装 EZagent Work Harness：https://github.com/zhujufeng/EZagent-Spec 。先检查宿主 CLI 与 Node.js 22+，在联网、安装软件或修改全局配置前征得我的确认。

更新：

```bash
codex plugin marketplace upgrade ezagent
codex plugin remove ezagent-spec@ezagent
codex plugin add ezagent-spec@ezagent
```

升级完成后必须新建任务。若同一版本曾被缓存，先 remove 再 add；不要只看安装命令成功，应让 Agent 报告插件版本和 enabled 状态。

卸载：

```bash
codex plugin remove ezagent-spec@ezagent
codex plugin marketplace remove ezagent
```

插件不会静默安装 Node.js。

## 在项目中启用

打开目标项目并说：

> 在当前项目启用 EZagent Work Harness。

初始化会先预览并确认以下受管范围：

- `.ezagent/**`
- `AGENTS.md#EZAGENT`
- `.codex/agents/ezagent-*.toml`（v2 按需 Specialist 与旧 v1 专家兼容流程共用的受管 project Agents）

每个项目只需初始化一次。之后直接描述需求；Codex 与 OpenCode 会读取项目内受管 `AGENTS.md`，Claude Code 则通过插件中可自动调用的 Router Skill 使用同一流程，不需要用户记忆或输入 CLI。这个机制是 Router Skill + 项目规则，不依赖 lifecycle Hook。预览到确认期间应避免并发修改 `AGENTS.md`；token 过期时会重新预览，不覆盖并发修改。

如果同一请求同时包含“初始化 EZagent”和后续工作，初始化成功是当前任务的工作流边界：Initialize Skill 会重新提取剩余目标并显式交给 Router，不会继续初始化前的 brainstorming、writing-plans 或其他主工作流。新写入的 `AGENTS.md` 从下一次任务自动加载；只有宿主无法在当前任务调用 Router 时，才会停止并提示开启新任务。`context` 只是路由准备动作，不等于完成路由；Router 必须明确模式、理由和下一个 Skill，并实际转交。初始化批准也不会被复用为 Work Contract 批准。

Codex 的按需 Specialist 继续使用受管 `.codex/agents/ezagent-*.toml`。Claude Code 与 OpenCode 在执行同一 delegation 时，从插件内 `catalog/experts.json` 精确加载匹配 `expertId` 的定义，并通过各自的原生隔离 subagent 执行；若宿主没有 subagent 能力则关闭失败，不由协调器模拟专家。

## 共享上下文与知识

初始化默认 `gitTracking: none`，项目索引、Journal 和 Decision 都只保存在本地。用户可以显式请求启用团队共享；Context Skill 会先展示共享范围和排除范围，批准后才切换为 `artifacts`。

共享项目上下文只保存小型项目摘要、Canonical Terms、稳定约束和项目内来源指针，不复制完整文档或聊天。Router 最多恢复 5 条相关 Decision / Pattern 摘要，确有需要才读取原记录。EZagent 不修改 `.gitignore`，也不代替团队执行 Git 操作。

## Local-only 与安全边界

EZagent runtime 不会自动联网、发送遥测、安装软件、执行 Git 写操作、发布或上传项目。联网、安装、Git 写入和外部 Side Effect 都需要对应的明确授权。

Local-only 只描述 EZagent runtime，不改变 Codex、Claude Code 或 OpenCode 的模型处理、账号、组织策略或数据保留方式。Marketplace / Git 安装、宿主自身通信和开发者主动执行的依赖安装不属于 runtime 的离线行为。

状态只能由本地核心修改；Skill 不得直接编辑 `.ezagent/**`。revision、状态、证据、批准 token 或安全条件不匹配时关闭失败。Workspace Core 会绑定项目根与写入祖先的文件系统 identity，并拒绝存量 portable 文件名冲突；如果初始化或受管文件发布返回 inspection、recovery 或 backup 路径，应保留现场并停止，不猜测成功。

这些控制面向可信本机上的误操作、漂移和协作并发，不承诺抵抗拥有同等本地文件权限、并能在系统调用之间替换目录的恶意进程。此类环境应先依赖操作系统账户隔离、目录权限和企业终端防护。

GitHub Actions 对 Windows 与 macOS 执行相同的类型检查、测试、确定性插件检查和构建门。

## 开源与来源

EZagent Spec 由 `zhujufeng` 开发，使用 MIT License。

兼容专家目录衍生自 MIT 许可的 [Agency Agents](https://github.com/msitarzewski/agency-agents) 与 [Agency Agents 中文项目](https://github.com/jnMetaCode/agency-agents-zh)。完整版权和许可证见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) 与 `licenses/`。

本项目受 [Trellis](https://github.com/mindfold-ai/Trellis) 的结构化工作流思想启发，但不包含、复制或调用 Trellis 的代码、模板、CLI 或运行时，也不声明格式兼容。

## 开发与贡献

```bash
npm ci
npm run plugin:verify
npm run verify
```

普通插件用户不需要手动运行 CLI。贡献要求见 [CONTRIBUTING.md](CONTRIBUTING.md)，安全问题见 [SECURITY.md](SECURITY.md)。
