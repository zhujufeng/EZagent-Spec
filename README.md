# EZagent Work Harness

面向 Codex、Claude Code 和 OpenCode 的本地优先 Agent Work Harness：把自然语言需求转成可审批、可恢复、证据驱动的工作，并按需匹配 Specialist。

它把“直接让 Agent 开始做”的工作，变成一条轻量但可恢复、可审查的链路：

```text
共同理解 → Brief → Work Spec → 纵向 Slices → Evidence → Decision
                         ↘ Work Journal
                         ↘ 精确批准的 Side Effect
```

## 日常使用：三句话就够

1. 首次在项目中说：“请在当前项目启用 EZagent，先预览。”
2. 之后直接描述需求；普通工作只确认目标、交付物、完成条件和执行步骤。
3. 随时说“状态”“继续”或“完成”；EZagent 会恢复当前会话的工作，不要求你填写 ID、Evidence 哈希或 CLI 参数。

界面默认简洁不等于文件被隐藏。批准后，完整工件都在项目目录的 `.ezagent/` 下可见：

```text
.ezagent/
├── state/workspace.json          # 当前状态与各会话 active Work Item
├── requirements/                 # Brief
├── specs/                        # Work Spec
├── tasks/                        # Work Item 与 Slices
├── experts/plans/                # Specialist Plan（如有）
├── journals/                     # 恢复日志
├── quality/runs/                 # 完整 Evidence JSON
└── knowledge/decisions/          # 完成后的 Decision
```

这些文件由本地核心维护，可以直接检查，但不要手工修改。需要看完整合同或逐条 Evidence 时，直接说“展开完整合同”或“展开完整证据”。详细安装、宿主兼容与安全说明仍在下文，日常使用无需先读完。

## 分发者先看

本教程对应 `v0.6.1`。正式分发时只使用 GitHub Releases 中带 `v0.6.1` 标签的版本，不要把 `main` 分支压缩包或开发中的工作区直接发给同事。安装或升级后必须完全退出并重开 Agent 宿主，再新建任务，让新版 Skills 与 lifecycle Hook 生效。

`v0.6.1` 修复了初始化后只有第一个需求可靠进入 Router 的持续激活缺口：Codex 与 Claude Code 插件现在通过只读 `UserPromptSubmit` Hook 在每个用户回合重新建立 Router 所有权，项目内 `AGENTS.md` 保留为启动时静态规则与 Hook 不可用时的兜底。它同时包含 `v0.6.0` 的 Node.js 22+ 自助准备能力；缺少 Node 时仍会先展示来源、命令、管理员影响和安装范围，经用户单独批准后才安装并复检。

如果你是维护者，正式通知同事“可以安装”之前，请确认：

- GitHub Release 页面已经出现 `v0.6.1`；
- Release 对应的 tag 和提交正确；
- Windows 与 macOS CI 都通过；
- 安装得到的插件报告版本为 `0.6.1` 且 enabled；
- Codex 中打开 `/hooks`，确认并信任 EZagent 的 `UserPromptSubmit` Hook；
- 至少完成一次真实宿主初始化预览，确认写入前工作区不变；
- 同事收到的是本 README 的正式 Release 版本，而不是本地未提交文档。

## 宿主支持状态

不要把 Claude Code 和 Claude Desktop 当成同一个宿主。当前发布承诺按下面的矩阵理解：

| 宿主 / 使用界面 | 支持级别 | 当前边界 |
|---|---|---|
| Codex | 正式支持 | 已有插件契约、离线包和 Windows / macOS 自动化验证 |
| Claude Code | 正式支持 | 已发布 Claude 插件清单、Marketplace 和 portable Skills 契约 |
| OpenCode | 正式支持 | 使用项目内 `.opencode/skills/` 薄入口加载同一组 canonical Skills |
| Claude Desktop Chat | 有限支持 | 可以安装并加载插件 Skills，但不承诺完整本地项目工作流或 Specialist |
| Claude Desktop Cowork | 实验性支持，待同事实机验收 | 最接近完整能力：可连接本地文件夹并使用 sub-agent；本项目维护者尚无 Claude Desktop，不能声称已实测通过 |

Anthropic 当前说明，插件 Skills 可以用于 Claude 网页 Chat、Claude Desktop Chat 和 Cowork，但 Hooks 与 sub-agent 只在 Cowork 运行。EZagent 在支持 Hook 的宿主使用每回合 Router 激活，在不支持 Hook 的界面退回 Skills 与项目规则；Specialist 仍必须使用真实隔离 sub-agent，而且完整流程还要执行打包的本地 CLI、读写已连接项目。因此桌面版请优先在 Cowork 测试，不要在 Chat 中把“Skill 能显示”误判为“整个 Work Harness 已验收”。官方边界见 [Use plugins in Claude](https://support.claude.com/en/articles/13837440-use-plugins-in-claude) 和 [Install Claude Desktop](https://support.claude.com/en/articles/10065433/install-claude-desktop)。

`v0.6.1` 可以分发给 Codex、Claude Code 和 OpenCode 同事。给 Claude Desktop 同事分发时，必须同时标注“Cowork 实验性支持”，并请他们按后文清单回传结果；在真实 Cowork 验收完成前，不得宣传为 Claude Desktop 全能力正式支持。

## 快速导航

- 第一次使用：从“第 0 步”开始顺序操作。
- 使用 Claude 桌面版：先看“宿主支持状态”和“Claude Desktop（Cowork 实验性验收）”。
- 只想知道为什么没有自动调用：看“新手常见问题”。
- 想理解五种处理方式：看“五种工作模式”。
- 想知道 Specialist 何时出现：看“Specialist 与多 Agent”。
- 想继续昨天的任务：看“执行、暂停、恢复和取消”。
- 涉及发送、发布或生产写入：看“Controlled Side Effect”。
- 负责给团队安装：看“安装”和“分发检查清单”。

## 不懂开发也能用：从零开始

本章给不懂 CLI、JSON、Git、状态机或 Specialist ID 的同事使用。大家不需要记忆 EZagent 命令，也不需要手动选择专家；只需按下面的话术操作并认真检查每次预览。

它不是“装好后接管所有聊天”的机器人，也不是外部系统的安全审批平台。只有在某个项目里初始化后，项目相关工作才会自动进入 EZagent；发送、发布、付款、写生产系统等真实外部动作仍要由人确认，并受宿主本身的权限和审批能力约束。

### 第 0 步：准备好三样东西

你需要：

1. Codex、Claude Code 或 OpenCode 其中一个正式支持的 Agent 宿主；参加实验性验收的同事也可以使用 Claude Desktop Cowork。
2. Node.js 22 或更高版本。
3. 一个准备工作的项目文件夹。它可以是代码项目，也可以只是放文档、表格或资料的普通文件夹。

不知道 Node.js 是什么也没关系。安装插件后，在项目里第一次启用 EZagent 时，Initialize Skill 会在调用任何 EZagent CLI 之前自动检查版本。你也可以直接对 Agent 说：

> 请检查当前电脑是否安装 Node.js 22 或更高版本。如果缺失或版本太低，先告诉我准备使用的安装器、软件来源、精确命令、是否需要管理员权限和是否会全局安装；等我确认后帮我安装并复检。不要修改当前项目的 package.json 或运行 npm install。

如果 Node.js 缺失或版本太低，EZagent 会先只读查找可靠安装渠道：Windows 优先 `winget`；macOS 优先使用已经存在的 Homebrew，没有 Homebrew 时直接下载 Node.js 官方签名和公证的通用 `.pkg`，校验 SHA-256、包签名与 Gatekeeper 后打开系统安装器，不会为了 Node 额外安装 Homebrew；Linux 只使用能确认提供 Node.js 22+ 的现有系统包管理器。它会先展示安装计划，收到你的明确确认后代为准备和安装，再重新检查版本；不会静默安装、自动加第三方软件源、执行远程安装脚本或修改 `PATH`。没有可靠安装渠道、公司电脑限制安装或安装后当前任务仍看不到 Node 时，它会停下来请你重启宿主或联系 IT。

这里的“前置检查”发生在插件已安装后的首次项目初始化之前。一个尚未安装的插件无法运行自己的 Skill，所以首次安装插件时，仍应使用下一步给出的完整自然语言提示，让当前 Agent 先检查环境。EZagent 的 CLI 已包含所需 JavaScript 运行时依赖；同事不需要、也不应该在业务项目里执行 `npm install`。

### 第 1 步：安装插件

最省心的方式是把下面整句话发给 Agent：

> 请帮我安装 EZagent Work Harness：https://github.com/zhujufeng/EZagent-Spec 。先检查当前 Agent 宿主；安装插件后新建任务，并在首次项目初始化前检查 Node.js 22+。如果 Node 缺失或版本太低，先展示安装器、官方来源、精确命令、下载量、管理员权限和全局影响，等我确认后再安装并复检。不要修改业务项目的 package.json，也不要在业务项目运行 npm install。任何联网、系统软件安装或全局配置修改都先向我确认。最后告诉我插件版本和 enabled 状态。

Agent 请求联网或修改插件配置时，确认目标确实是 `zhujufeng/EZagent-Spec` 再批准。熟悉终端的同事也可以使用后文的宿主安装命令。

### 第 2 步：加载新版并信任 Hook

这是最容易漏掉的一步。插件安装或升级完成后，不要继续使用安装前已经打开的旧任务；请在 Codex 侧边栏或对应宿主中新建一个任务。新任务启动时才会加载最新版 Skills 与插件 Hook。

> **必须手动允许：** 安装或升级插件不会自动授权 Hook。在新任务中打开 `/hooks`，找到 EZagent 的 `UserPromptSubmit` Hook，确认命令只运行插件内 `hooks/ezagent-router-prompt.mjs`，然后选择“允许/信任（Allow/Trust）”。新增或变化的非托管 Hook 在获准前会被跳过；若不完成这一步，`AGENTS.md` 只能作为新任务启动时的兜底，不能保证每个后续 prompt 都重新触发 Router。

### 第 3 步：打开项目文件夹并初始化

在新任务里打开要工作的项目文件夹，然后说：

> 请在当前项目启用 EZagent Work Harness。

Agent 会先展示初始化预览，通常只涉及：

- `.ezagent/**`：任务状态、计划、证据和历史；
- `AGENTS.md` 中的 EZagent 受管区块：作为新任务启动时的静态规则与 Hook 兜底；
- `.codex/agents/ezagent-*.toml`：只有确实需要 Specialist 时才生成的项目专家。

初始化预览不会写文件。确认路径是当前项目、范围没有异常后，回复：

> 确认初始化。

每个项目只需初始化一次。不要手动创建、修改或删除 `.ezagent` 里的文件。

### 第 4 步：确认初始化真的成功

初始化后直接问：

> 请只检查 EZagent 是否初始化成功，并告诉我项目状态；不要开始新的工作。

正常结果应包含：项目已初始化、`activeWorkItem: null`、没有安全模式或 inspection-required。项目里也会出现 `.ezagent/project.yaml`。如果只是做了初始化，已信任的 per-prompt Hook 会从下一条用户消息重新建立 Router 所有权；新建任务还会重新加载 `AGENTS.md` 兜底。如果同一句话里还包含了后续需求，EZagent 0.4.1 及以后会在初始化后把剩余需求重新交给 Router。

“安装插件”和“初始化项目”不是同一件事：

| 动作 | 作用范围 | 通常做几次 |
|---|---|---|
| 安装插件 | 当前 Codex、Claude Code 或 OpenCode 宿主 | 每台电脑或每次升级一次 |
| 初始化项目 | 当前打开的项目文件夹 | 每个项目一次 |
| 创建 Work Item | 当前这项需要持久化的工作 | 每个正式任务一次 |

插件已安装但项目没有 `.ezagent/project.yaml` 时，普通项目对话不会被 EZagent 接管；这是安全边界，不是安装失败。

### 第 5 步：像平时一样说需求

不需要说“调用插件”，也不需要指定模式或专家。例如：

- “分析这个文件夹里的客户反馈，按问题类型归类，并给出可以复核的结论。”
- “把现有制度整理成新人第一天能照着做的操作手册。”
- “修复订单重复提交的问题，测试通过后告诉我改了什么。”
- “规划一个 Go 云服务器端口检测工具，先给我看范围和验收标准，不要直接实施。”
- “这个方案涉及安全和 Windows 兼容，请安排真正独立的专家审查。”

Router 会自动选择最轻且够用的方式：简单解释直接回答，局部小改快速完成，长任务则生成可恢复的 Work Contract。需要专家时，核心根据自然语言里的能力需求自动选择 Specialist；普通任务没有 Specialist 是正常结果，不代表插件失效。用户不需要知道或填写专家 ID。

如果你希望“先把事情想清楚，再开始改”，可以直接说：

> 先写 PRD、技术设计和实施计划，给我确认后再编码。

也可以只要其中一种，例如“先写技术设计，确认后再实施”。EZagent 不会因为你提到一份文档，就自作主张生成三件套。对跨多个系统、数据或 API 边界、面向多个使用方，而且仍有范围选择的实施需求，Router 会推荐 Planning-first（先规划后实施）；普通小改和目标清楚的简单任务不会被强行拉成长流程。

### 第 6 步：看懂并确认 Work Preview

持久化任务开始前，Agent 会展示一份紧凑预览。普通工作只需检查目标、交付物、完成条件和执行步骤；存在风险、假设、问题或批准点时才额外显示。受控工作仍完整展示边界与批准点。完整 Work Contract 不会被删减，用户随时可以要求“展开完整合同”。

不满意就直接用自然语言纠正，例如：“不要改数据库，只输出迁移建议”“最终文档要给客服新人看”“增加一次独立安全审查”。预览修改正确后再回复：

> 我确认这份 Work Preview，可以创建工作项并开始执行。

初始化确认、Work Preview 确认和真实外部动作确认是三件不同的事，前一次确认不会自动授权后一次。

常见确认实际上有四类，回复前一定看清正在批准什么：

| 确认 | 你批准的内容 | 不会顺带批准什么 |
|---|---|---|
| Node 安装确认 | 指定来源、版本和系统安装影响 | 项目初始化、业务工作 |
| 初始化确认 | 预览列出的 `.ezagent`、`AGENTS.md` 等受管写入 | Work Item、编码或文档产出 |
| Work Preview 确认 | Outcome、范围、交付物、Slices 和验收方式 | 尚未生成的规划成果、真实外部动作 |
| Human / Side Effect 确认 | 当前规划成果，或精确目标与内容的外部动作 | 后续发生漂移的新版本或新目标 |

任何一次确认只绑定当前预览和当前版本。文件、范围、目标或内容变化后，应重新预览，不能沿用旧确认。

### 先规划后实施：两次确认分别是什么意思

Planning-first 不是新的工作模式，而是 Brief、Standard 或 Controlled 里面的一种执行顺序。你不需要记英文名，只要说“先规划，确认后再做”。

第一次是 **Work Preview 确认**。你确认的是：本次要产出哪些规划文档、放在哪里、需要哪些章节、谁会使用，以及后续准备实施什么。此时 PRD 或技术设计还没有写出来，也不会开始编码。

批准 Work Preview 后，Agent 先完成规划 Slice，把约定的文档交给你看。第二次是 **规划成果确认**。你可以直接说：

> 我认可当前 PRD、技术设计和实施计划，可以按这个版本开始实施。

只有这次确认被记录为 `human-approval` Evidence，后面的实施 Slice 才会解锁。如果文档不满意，就指出要改的地方；Agent 应继续修改规划 Slice，不能绕过确认提前编码。

一个正确的预览应该看起来像这样：

1. 规划文档是明确的 Deliverables，并写清文件路径和必需章节。
2. 规划 Slice 标记为人工检查点。
3. 实施 Slice 显示依赖规划 Slice，不能并行抢跑。
4. 只要求规划时，预览里没有“为了以后可能要做”而凭空增加的实施 Slice。

Planning-first 从正式版 `v0.5.1` 开始提供。使用更早版本的同事应升级到当前正式 Release、完全退出并重开宿主，再新建任务；旧任务不会在运行中自动加载新版规则。

### 第 7 步：执行、暂停、恢复和取消

执行时 EZagent 一次推进一个 Slice，保存必要 Journal，并从实际命令、文件哈希和检查结果自动形成常规 Evidence；用户不需要填写 Evidence ID、Criterion ID 或内容哈希。换电脑、关闭任务或第二天继续时，在新任务里说：

> 请恢复当前 EZagent 工作项，告诉我已经完成什么、下一步是什么，然后继续。

如果明确不做了，说：

> 请取消当前 EZagent 工作项，保留已有计划、证据和历史，然后确认我可以开始新任务。

不要通过删除 `.ezagent` 来“解除卡住”；正式取消会安全清空 active item，同时保留审计历史。

任务完成后，所有 Slice 必须已经通过 Evidence Review。EZagent 会从最新持久化 Evidence 生成 Decision，清空 active item，并退役只属于该任务的托管 Specialist；Work Spec、Plan、Receipt、Evidence、Journal 和 Decision 历史仍然保留。

支持 lifecycle session 的宿主在同一个项目里可让不同会话各自保留一个 active Work Item；同一会话内仍只有一个。完整映射可在 `.ezagent/state/workspace.json` 查看。没有 session 能力的宿主继续使用兼容的项目级单任务模式。看到当前会话“已有 active item”时应恢复、完成或明确取消，不要覆盖旧任务，也不要手动修改 `.ezagent/state`。

### 同事只需记住的七句话

如果前面的细节一时记不住，日常使用只需保存下面七句话：

1. 安装或升级后：“请告诉我 EZagent 的版本和 enabled 状态，然后完全退出宿主；我会新建任务。”
2. 第一次打开项目：“请在当前项目启用 EZagent，先预览，不要直接写入。”
3. 开始工作：“这是我的需求……请让 EZagent Router 选择合适流程。”
4. 预览不对：“先不要创建工作项，请按我补充的范围、非目标和验收条件修改预览。”
5. 第二天继续：“请恢复当前 EZagent 工作项，先告诉我已完成什么、证据在哪里、下一步是什么。”
6. 不再继续：“请取消当前 EZagent 工作项，保留历史，让项目可以开始新任务。”
7. 涉及发送、发布、付款或生产写入：“只准备精确预览；没有我对当前目标和内容的单独确认，不要执行外部动作。”

遇到异常时再加一句：

> 请只读取 EZagent 当前状态和错误，不要手动编辑 `.ezagent`，也不要用新计划覆盖 active Work Item；告诉我应该恢复、取消、重新预览还是联系维护者。

### 怎样判断插件正在正常工作

| 你看到的现象 | 是否正常 | 说明 |
|---|---|---|
| 只读问题直接回答，没有创建文件 | 正常 | Router 选择了 Consult |
| 小改动直接完成，没有 Work Preview | 正常 | Router 选择了 Quick |
| 长任务先展示 Outcome、Scope、Slices 和验收条件 | 正常 | 进入 Brief、Standard 或 Controlled |
| 明确说“先规划后编码”，预览中规划 Slice 挡住实施 Slice | 正常 | Planning-first 使用真实人工 Evidence 闸门 |
| 只说改一个小问题，却自动生成 PRD、设计和计划三件套 | 不正常 | Quick / 简单 Brief 不应被 Planning-first 膨胀 |
| 规划文档还没确认，Agent 已经开始编码 | 不正常 | 实施 Slice 没有正确等待规划人工检查点 |
| 普通任务没有任何 Specialist | 正常 | Specialist Assessment 判断不需要专家 |
| 高风险或独立审查任务自动出现少量 Specialist | 正常 | 核心按能力需求选人，不是用户点名 |
| 只运行了 `context`，没有说模式和下一个 Skill | 不正常 | `context` 只是准备动作，不等于完成路由 |
| 初始化后继续沿用旧 brainstorming / writing-plans | 不正常 | 升级插件并新建任务；0.4.1 已修复初始化交接 |
| 命令长时间等待 JSON 输入 | 不正常 | 升级到 0.5.0；新版会优先使用有界 `--input-file`，宿主禁止项目外临时文件时再走受限 argv 通道 |

### 新手常见问题

“安装后为什么没有自动调用？”

先确认这是安装后新建的任务，并确认当前项目存在 `.ezagent/project.yaml`。插件不会在未初始化项目里劫持普通聊天。仍不生效时，执行后文的升级步骤，完全退出并重开宿主，再新建任务。

“为什么没有 Specialist？”

Specialist 不是固定队伍，也不是每个任务必选。只有领域判断、上下文隔离、真正独立工作或独立审查有明确收益时才会创建。如果确实需要，可以说“请做 Specialist Assessment，并说明是否需要独立安全审查”，但仍由核心选择匹配的专家 ID。

Specialist 的任务类型也跟你这次真正要求的一致：只要求分析时会规划分析 Specialist，不会因为以后可能改代码就提前冒充实施；明确要求实施时才规划 implementation Specialist；明确要求独立审查时才增加隔离 reviewer。

匹配不是只看“工程”这种大类。以常见后端修复为例，系统边界与一致性分析会匹配后端架构能力，代码实施会匹配高级开发能力，独立代码审查会匹配代码审查能力；三者不会因为通用词同分而落到 UX、AI 数据修复或金融合规专家。若自然语言被错误转换成目录中不存在的领域词，Core 会显示 `domain-unmatched:<token>` blocker 并停止创建 delegation，不会随便找一个名字相近的人顶替。

预览里出现专家名称或 ID，只表示“批准后计划匹配这位专家”，不表示专家已经开始工作。只有你批准 Work Contract、Agent 真正完成委派并留下回执后，才可以说“专家已执行”或“独立审查已完成”。如果你要求“完成实现，并让没参与实现的独立 Agent 审查”，任务至少会进入 Standard，即使看起来只有一两个步骤。

需要 Specialist 的预览末尾应有“委派边界”：现在还没执行；批准后只把获批的任务、Slice、范围、交付物和证据要求发给匹配的隔离 Agent；只收回短摘要、结果哈希和最小证据位置。看不到这段时先不要批准，建议升级插件并新建任务重试。

“退款、支付这类高风险主题一定是 Controlled 吗？”

不一定，看你这次要求 Agent 做什么。只做内部分析、方案或本地草稿，并明确不访问真实敏感数据、不操作生产、不触发真实退款时，通常是 Brief 或 Standard；要求生产写入、真实外部操作、发布、预算承诺、人员判断或难回滚动作时才是 Controlled，而且具体外部动作仍要单独批准。

“提示已有 active Work Item，不能开始新任务怎么办？”

如果要继续，就说“恢复当前工作项”；如果明确放弃，就说“取消当前工作项并保留历史”。不要手动改状态文件。

“Agent 说 CodeGraph、源码、数据或写权限没准备好，然后就不走 EZagent 了？”

这不正常。缺少分析工具、业务文件、样本或权限可以成为 blocker，但不能把原本的 Brief、Standard 或 Controlled 请求降成 Consult。0.5.0 会先按你要求的结果选择模式，再把缺口放进 Work Preview、Tracer Slice 或一个必要的澄清问题；只读环境仍可生成预览，只是不能执行获批后的写入。如果 Agent 没有说明模式和下一个 Skill，请升级插件、新建任务后重试。

“Windows 路径有空格，会不会失败？”

支持。插件把每个路径作为独立 argv 参数处理，也为 PTY 无法关闭 stdin 的情况提供文件输入通道。需要临时文件时，它只会使用项目目录之外的操作系统临时目录，流程结束后自动清理，不会在你的项目里留下陌生 JSON 文件。若 Codex 同时禁止这类文件写入，插件会在确认内容不敏感且不超过 24,576 bytes 后使用受限 argv 通道；否则会明确停止，不会无限等待。仍有问题时，把完整报错和项目路径发给维护者，不要自行改 `.ezagent`。

“批准 Side Effect 后，消息是不是已经发送了？”

不是。EZagent Core 只写入 `externalActionExecuted: false` 的本地授权记录；真正发送、发布或外部写入由宿主能力执行。执行前仍要核对目标、账号和内容，执行后还要保存 `external-record` Evidence。

### 分发和安全边界

推荐分发范围：可信本机上的日常知识工作、项目规划、文档、分析、代码修改和有人工复核的受控流程。团队应统一使用带版本号的正式 Release，并在安装或升级后新建任务。

不要把 EZagent 当作以下系统的替代品：公司审批平台、密码或密钥管理器、生产权限系统、付款系统、不可抵赖电子签名、恶意本地进程隔离工具。Side Effect token 是本地工作流的漂移校验，不是不可伪造的用户签名；Core 也无法替宿主证明外部平台最终发送的 payload。对付款、生产发布、人事决定、法律承诺等高影响动作，必须继续使用公司的正式审批和权限制度。

它不限定谁能使用，也不按岗位分配流程。开发、分析、文档、调研、策划、流程整理等只是非穷尽示例；真正决定流程的是工作复杂度、影响、可逆性和需要的证据。

#### 维护者分发检查清单

请逐项完成后再通知团队安装：

1. GitHub Release 中存在目标版本，tag、提交和 CHANGELOG 一致；不要分发 `main` 分支快照。
2. Windows 与 macOS CI 全绿，插件确定性构建检查通过。
3. 在一台未装旧缓存的测试宿主中安装，确认版本为 `0.6.1`、状态为 enabled，并在 Codex `/hooks` 中信任 EZagent 的 `UserPromptSubmit` Hook。
4. 完全退出宿主并新建任务；不要用发布前已经打开的任务验收新版 Skill。
5. 在临时项目执行一次初始化预览，确认用户批准前项目字节不变。
6. 批准初始化后，新建任务并验证 Consult、Quick 和至少一个 Brief Work Preview。
7. 验证一次恢复和取消；需要 Specialist 的测试还应看到计划匹配、真实 dispatch、start/completion receipt，而不只是 Agent 文件。
8. 验证 Node 缺失场景只展示计划；未获得独立批准时不得下载、安装、提权或修改业务项目。
9. 把正式 Release 页面、本 README 和维护者联系方式一起发给同事。

#### 同事第一天验收脚本

安装后打开一个无重要资料的临时文件夹，按顺序发送：

1. “告诉我 EZagent 插件版本和 enabled 状态，不要修改项目。”
2. “请在当前项目启用 EZagent，先预览，不要直接写入。”
3. 检查预览路径后说“确认初始化”。
4. 新建任务，说“只检查 EZagent 状态，不要创建 Work Item”。
5. 说“解释一下这个文件夹目前有什么，不要修改内容”，应走 Consult。
6. 新建一个无关紧要的文本文件后说“把标题中的错别字改正”，应走 Quick。
7. 说“把这个文件夹整理成一份可恢复的交接手册，先给我 Work Preview”，应进入 Brief 或更高模式，但批准前不应产生业务交付物。
8. 如果不准备继续，最后说“取消当前 EZagent 工作项并保留历史”。

这套脚本验证的是路由、批准前零业务写入、持久化工作项和取消出口。不要在首日验收中使用真实客户数据、生产账号、付款或发布动作。

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

## 从一句需求到完成：完整工作流程

```text
安装插件
   ↓ 完全退出宿主并新建任务
初始化项目
   ↓ 初始化预览 → 用户确认 → 写入受管项目规则
自然语言需求
   ↓ Router 读取项目状态和少量相关历史
Consult / Quick ───────────────────────────────→ 直接答复或局部交付
   │
   └─ Brief / Standard / Controlled
          ↓
      Specialist Assessment
          ↓
      Work Preview（Outcome、范围、交付物、验收、Slices、批准点）
          ↓ 用户确认
      创建 active Work Item
          ↓
      一次执行一个 Slice → Journal → Criterion Evidence → Review
          │                         │
          │                         ├─ 不完整：revise 后补证据
          │                         └─ 完整：accepted，进入下一 Slice
          │
          ├─ 人工检查点：展示当前成果，等待 human-approval
          ├─ 外部动作：精确 Side Effect 预览，等待单独批准
          └─ 能力缺口：只重规划 Specialist，不偷改工作范围
          ↓
      所有 Slice accepted
          ↓
      Decision + 保留历史 + 清空 active Work Item + 退役任务专属专家
```

各阶段的可观察结果如下：

| 阶段 | 用户会看到什么 | EZagent 会保存什么 | 何时会停下来等人 |
|---|---|---|---|
| 环境准备 | Node 版本；必要时是精确安装计划 | 不保存业务工作 | 安装 Node 前必须单独确认 |
| 项目初始化 | 受管路径和变更预览 | `.ezagent` 基础状态、项目规则 | 初始化写入前必须确认 |
| 路由 | 模式、理由、下一个 Skill | Consult / Quick 通常不持久化 | 只有真正影响结果的问题才询问 |
| 工作规划 | 完整 Work Preview | 用户批准后才创建 Work Item | Preview 不满意就继续修改 |
| Specialist | 能力需求、计划匹配和委派边界 | 批准后生成 delegation 与不可变 receipt | 专家变化需要独立 replan 批准 |
| Slice 执行 | 当前 Slice、产出、检查结果 | 有界 Journal 和 Criterion Evidence | 人工检查点、blocker 或证据不足时暂停 |
| Side Effect | 精确 action、target、内容哈希和影响 | 本地授权记录，不代表动作已执行 | 每次真实外部动作单独确认 |
| 完成 | 已满足的验收条件、Evidence 和结论 | Decision 与完整历史 | Coverage 不完整时不能宣称完成 |

因此，EZagent 的核心价值不是“多生成几份文档”，而是让需求、授权、执行、证据和完成声明始终指向同一份经过批准的工作契约。关闭任务不会丢失 active Work Item；换会话后 Router 会从持久化状态恢复，而不是依赖模型记住整段聊天。

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

## 七个日常 Skill 如何协作

普通同事不需要手动点名 Skill，但了解分工有助于判断 Agent 有没有走偏：

| Skill | 负责什么 | 不负责什么 |
|---|---|---|
| `ezagent-initialize` | 检查 Node、预览并初始化项目；组合请求初始化后重新交回 Router | 不把初始化确认当成业务工作批准 |
| `ezagent-router` | 读取当前状态，选择 Consult、Quick、Brief、Standard 或 Controlled，并明确下一步 | 只调用 `context` 不算完成路由 |
| `ezagent-light` | 完成低风险、局部、可逆且单会话可交付的 Quick 请求 | 不接管已有 active Work Item，不绕过持久化任务 |
| `ezagent-spec` | 把复杂或跨会话需求整理为 Brief、Work Spec、Slices、Evidence 要求和 Specialist Assessment | 未经用户确认不创建正式 Work Item |
| `ezagent-execute` | 按已批准合同一次推进一个 Slice，维护 Journal，调用获批 Specialist 并提交 Evidence | 不擅自扩大范围，不跳过人工检查点 |
| `ezagent-review` | 按每条 Acceptance Criterion 核验真实 Evidence，决定 accepted 或 revise | 不把“Agent 说做完了”当成证据 |
| `ezagent-context` | 读取当前工作状态和少量相关 Decision / Pattern；显式管理共享摘要 | 不复制整段聊天，也不等同于 Router 模式选择 |

一个典型的持久化任务会经过 `router → context → spec → execute → review`；初始化项目时先由 `initialize` 建立入口，Quick 请求由 `light` 直接完成。已退役的 `ezagent-implement` 只作为 `sourceSchemaVersion: 1` 编码兼容适配器保留，用于让升级前已存在的旧任务完成，不再进入新任务的默认路径。宿主可以调用其他写作、测试、浏览或代码能力，但它们应作为获批 Slice 内的执行工具，不能取代 Router 和工作契约。

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

原来的自动专家团队、Requirement / Spec / Task、Plan / replan 和质量门流程已经从默认产品路径退役；只保留 `sourceSchemaVersion: 1` 的只恢复兼容适配器，确保旧项目可以继续和完成。所有新工作只进入通用 v2 Work Harness。

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

首次初始化时的环境处理规则如下：

| 系统 | 自动检查 | 获得单独确认后可以做什么 | 密码和管理员权限 |
|---|---|---|---|
| Windows | `node --version`、`winget` 和官方 `OpenJS.NodeJS.LTS` 元数据 | 通过 `winget` 安装官方 LTS，并重新检查 Node | 可能弹出 UAC；只在 Windows 系统界面确认，不在聊天里提供密码 |
| macOS，有 Homebrew | Node 版本、Homebrew 和官方 `node` formula | 执行 `brew install node` 并复检 | 不使用 `sudo brew`，通常不需要系统管理员密码 |
| macOS，无 Homebrew | Node 版本、官方精确 LTS、SHA-256、包签名和 Gatekeeper | 下载并验证官方通用 `.pkg`，再打开 macOS 安装器 | 系统安装器可能要求管理员账户；只在 macOS 窗口输入，Agent 不读取密码 |
| Linux | Node 版本、现有包管理器及其仓库中的 `nodejs` 候选版本 | 仅当现有仓库明确提供 Node 22+ 时安装 `nodejs` | 没有安全提权通道就停止，请用户或 IT 处理；不索取密码、不自行加 `sudo` |

无论哪个系统，联网和系统软件安装都不是项目初始化的一部分，必须分别确认。安装失败后不会暗中换镜像、添加第三方仓库或修改 shell 配置；当前宿主看不到刚安装的 Node 时，先完全退出并重开宿主，再重新初始化。

### Codex

```bash
codex plugin marketplace add zhujufeng/EZagent-Spec
codex plugin add ezagent-spec@ezagent
```

安装或更新后新建一个 Codex 任务，让新 Skills 与 Hook 生效；随后必须手动打开 `/hooks`，审查并允许来自 `ezagent-spec` 的 `UserPromptSubmit` Hook。Hook 默认启用不等于已经获得信任，新增或变化的非托管 Hook 在手动允许前会被跳过。

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

### Claude Desktop（Cowork 实验性验收）

Claude Desktop 不是 Claude Code 的另一个皮肤。当前版本只把 Cowork 列为实验性支持，而且本项目维护者没有 Claude Desktop 设备；下面的流程是给有桌面版的同事做真实宿主验收，不是已经完成的认证。

#### 安装插件

Claude 插件目前要求付费计划；公司 Team / Enterprise 账号还可能被管理员限制个人插件或 Marketplace。请让同事使用最新版 Claude Desktop：

1. 打开 Claude Desktop，进入 `Customize → Plugins`。
2. 在 Personal plugins 区域点击 `+`，选择 `Add marketplace`。
3. 选择从 GitHub repository 或 git URL 添加，输入 `https://github.com/zhujufeng/EZagent-Spec`。
4. 在新出现的 Marketplace 中安装 `ezagent-spec`，确认显示名为 `EZagent Work Harness`、版本为 `0.6.1`。
5. 完全退出并重开 Claude Desktop，再新建一个 Cowork 任务。

如果界面没有 Plugins、Add marketplace 或 Cowork，先检查账号计划、桌面版更新和组织管理员策略；不要把仓库文件手动复制进未知的 Claude 配置目录。Claude Desktop 的 `.mcpb` Desktop Extension 是本地 MCP 的另一种分发格式，EZagent 当前是 Claude Plugin，不需要改名或伪装成 `.mcpb`。

#### 用一次性文件夹验收

第一次不要连接真实业务项目、客户资料、生产凭据或已经存在 `.ezagent` 的目录。新建一个可以随时删除的空文件夹，在 Cowork 中只连接这个文件夹，然后按顺序发送：

1. “告诉我当前界面是 Chat 还是 Cowork、已连接文件夹的绝对路径、EZagent 插件版本和可用 Skills；不要修改任何文件。”
2. “请在当前文件夹启用 EZagent Work Harness，先做 Node 和初始化预检，只展示计划，不要安装软件，不要写入文件。”
3. 检查批准前文件夹完全不变，并记录 Node 版本、操作系统检测结果和 CLI 路径。Cowork 可能运行在隔离环境中，检测到的系统不一定等于电脑宿主系统；第一次验收如果提示安装 Node，先不要批准，把完整计划回传给维护者。
4. 路径和预览正确时回复“确认初始化”，随后确认只新增 `.ezagent/**`、`AGENTS.md` 受管区块和必要的受管 Agent 文件。
5. 新建 Cowork 任务并重新连接同一个文件夹，发送“只恢复 EZagent 状态，不要创建新工作项”；应看到 `activeWorkItem: null`，证明跨任务持久化有效。
6. 发送一个只读问题，应走 Consult；再要求修正一个临时文本文件中的错字，应走 Quick。
7. 发送“为这个临时项目整理一份可恢复的交接手册，先给 Work Preview，不要直接实施”；批准前不应出现业务交付物。
8. 发送“请增加一位没有参与实现的独立 reviewer 做审查”；若 Cowork 支持所需 sub-agent，应出现计划匹配、真实 dispatch 和 receipt。若宿主不提供 sub-agent，EZagent 必须明确 blocked，不得由主 Agent 冒充 Specialist。
9. 验证一次“恢复当前工作项”和“取消当前工作项并保留历史”。不要在本轮测试发送消息、发布内容或操作任何真实外部系统。

#### 把结果回传给维护者

请同事复制下面模板填写；错误时保留原始文字和截图，但先删除账号、绝对用户名、客户数据、token 和其他敏感信息：

```text
Claude Desktop 版本：
操作系统与版本：
账号计划：Pro / Max / Team / Enterprise
测试界面：Chat / Cowork
EZagent 版本：
Marketplace 安装：通过 / 失败
Node 预检：通过 / 失败；检测到的版本与系统：
批准前零写入：通过 / 失败
初始化：通过 / 失败
新 Cowork 任务恢复：通过 / 失败
Consult：通过 / 失败
Quick：通过 / 失败
Brief Work Preview：通过 / 失败
Specialist 真实 sub-agent：通过 / blocked / 失败
取消后 activeWorkItem 为空：通过 / 失败
实际新增或修改的路径：
完整错误信息（已脱敏）：
```

至少获得一台 macOS 和一台 Windows 的完整回报，并确认初始化、跨任务恢复和 Specialist 行为后，维护者才能把 Cowork 从“实验性支持”提升为“正式支持”。Claude Desktop Chat 即使能加载 Skills，也仍应单独评估，不能继承 Cowork 或 Claude Code 的结论。

### OpenCode

本仓库提供 `.opencode/skills/` 薄入口，直接从仓库根目录启动 OpenCode 即可；入口只负责加载 `plugins/ezagent-spec/skills` 中的 canonical Skill，不复制工作流逻辑。

要在其他项目使用，把构建后的 `plugins/ezagent-spec` 包内容完整合并到目标项目的 `.opencode/`。包根级的 `skills/`、`dist/` 与 `catalog/` 会保持 Skills 所需的相对路径，OpenCode 会忽略同包的 Claude/Codex manifest。不要只复制单个 Skill；若 `.opencode/` 已存在，安装器必须逐项合并并拒绝覆盖既有同名文件。

版本遵循语义化规则：兼容的新能力提升次版本，例如 `0.1.0 → 0.2.0`；后续兼容性修复依次使用 `0.2.1`、`0.2.2` 等小版本，避免相同版本号命中旧缓存。

也可以把下面这句话交给当前宿主：

> 请帮我为当前 Agent 宿主安装 EZagent Work Harness：https://github.com/zhujufeng/EZagent-Spec 。先检查宿主 CLI 与 Node.js 22+；如果 Node 缺失或版本太低，先展示准备使用的安装器、来源、精确命令、管理员权限和全局影响，等我确认后代为安装并复检。不要修改业务项目的 package.json，也不要在其中运行 npm install。任何联网、安装软件或修改全局配置的动作都先征得我的确认。

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

插件会在首次初始化前检查 Node.js；缺失时可在展示精确计划并获得单独确认后代为安装。它不会静默安装 Node.js，也不会把初始化批准当成系统软件安装批准。

## 在项目中启用

打开目标项目并说：

> 在当前项目启用 EZagent Work Harness。

初始化会先预览并确认以下受管范围：

- `.ezagent/**`
- `AGENTS.md#EZAGENT`
- `.codex/agents/ezagent-*.toml`（v2 按需 Specialist 与旧 v1 专家兼容流程共用的受管 project Agents）

每个项目只需初始化一次。之后直接描述需求；Codex 与 Claude Code 在每个用户回合由插件 `UserPromptSubmit` Hook 检查当前目录是否属于已初始化项目，并重新注入 Router 所有权；Router 再通过本地 CLI 读取真实状态。项目内受管 `AGENTS.md` 继续作为新任务启动时的静态规则与 Hook 不可用时的兜底，OpenCode 继续使用项目规则与 canonical Skills。Claude Desktop Cowork 在实机验收通过前只按上面的实验流程使用，不继承 Claude Code 的正式支持结论。预览到确认期间应避免并发修改 `AGENTS.md`；token 过期时会重新预览，不覆盖并发修改。

如果同一请求同时包含“初始化 EZagent”和后续工作，初始化成功是当前任务的工作流边界：Initialize Skill 会重新提取剩余目标并显式交给 Router，不会继续初始化前的 brainstorming、writing-plans 或其他主工作流。新写入的 `AGENTS.md` 从下一次任务自动加载；只有宿主无法在当前任务调用 Router 时，才会停止并提示开启新任务。`context` 只是路由准备动作，不等于完成路由；Router 必须明确模式、理由和下一个 Skill，并实际转交。初始化批准也不会被复用为 Work Contract 批准。

Codex 的按需 Specialist 继续使用受管 `.codex/agents/ezagent-*.toml`。Claude Code 与 OpenCode 在执行同一 delegation 时，从插件内 `catalog/experts.json` 精确加载匹配 `expertId` 的定义，并通过各自的原生隔离 subagent 执行；若宿主没有 subagent 能力则关闭失败，不由协调器模拟专家。

## 共享上下文与知识

初始化默认 `gitTracking: none`，项目索引、Journal 和 Decision 都只保存在本地。用户可以显式请求启用团队共享；Context Skill 会先展示共享范围和排除范围，批准后才切换为 `artifacts`。

共享项目上下文只保存小型项目摘要、Canonical Terms、稳定约束和项目内来源指针，不复制完整文档或聊天。Router 最多恢复 5 条相关 Decision / Pattern 摘要，确有需要才读取原记录。EZagent 不修改 `.gitignore`，也不代替团队执行 Git 操作。

## Local-only 与安全边界

EZagent runtime 不会自动联网、发送遥测、安装软件、执行 Git 写操作、发布或上传项目。联网、安装、Git 写入和外部 Side Effect 都需要对应的明确授权。

Local-only 只描述 EZagent runtime，不改变 Codex、Claude Code、OpenCode、Claude Desktop 或 Cowork 的模型处理、隔离环境、账号、组织策略或数据保留方式。Marketplace / Git 安装、宿主自身通信和开发者主动执行的依赖安装不属于 runtime 的离线行为。

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
