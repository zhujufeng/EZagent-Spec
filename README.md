# EZagent Work Harness

EZagent Spec 正在演进为一个中文、Local-only、领域中立的 Agent Work Harness。它把“直接让 Agent 开始做”的 vibe 工作，变成一条轻量但可恢复、可审查的链路：

```text
共同理解 → Brief → Work Spec → 纵向 Slices → Evidence → Decision
                         ↘ Work Journal
                         ↘ 精确批准的 Side Effect
```

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
4. 按 Criterion 收集 `command`、`artifact`、`checklist`、`comparison`、`citation`、`human-approval` 或 `external-record` Evidence。
5. Evidence coverage 或已批准 Delegation 的 completion coverage 缺失，就把该 Slice 标记为 `revise`；两者完整才 `accepted`。
6. 所有 Slice 通过后，由最新持久化 Evidence 生成 Decision 并完成 Work Item。

这就是本项目融入的 Spec 思想：Spec 不是一份越长越好的文档，而是“共同理解 + 明确接口和边界 + 小步交付 + 逐条证据”的可执行契约。

## Specialist 与多 Agent

新 v2 工作流不要求专家团队，也没有固定专家人数。默认情况下，一个维护者或一个业务同事就可以沿同一条 Work Contract 完成工作。

每个新的持久化 v2 Work Item 都必须完成一次 Specialist Assessment：明确记录为什么不需要专家，或声明绑定具体 Slice 的能力需求。Agent 只提交能力、领域、用途和隔离理由；本地核心从随插件发布的锁定 Agency Agents 目录中确定性选择专家，不接受模型直接指定专家 ID。

只有以下情况能证明收益时才选择 Specialist 或多 Agent：领域判断、上下文隔离、真正独立的并行工作、独立审查。初始选择与 Work Contract 在同一份预览中展示和批准；选中的专家会被物化为项目级 Agent。

执行时，协调器必须调用与已批准 `expertId` 对应的 project Agent，不能把“生成了 Agent 文件”当成已经完成委派，也不能静默改成自己执行。每次真实委派绑定 Work Item、Work Spec、Slice、Delegation ID、范围、交付物和 Evidence requirements，只传必要输入指针，只接收有界结果摘要、result hash 与 Evidence pointers。Core 会保存不可变 start/completion receipts；独立 reviewer 必须与同一 Slice 的实现者不同。

执行中出现真实能力缺口时，可以做 Specialist-only replan。它只改变 assessment 与执行策略，展示 added、removed、changed、unchanged delegation diff 并单独批准，不能修改 Outcome、Scope、Non-goals、Acceptance Criteria、Boundaries 或 Approval Points，也不能覆盖未完成回执。Work Item 完成或取消后，只绑定该任务的 active experts 和 EZagent 托管 Agent 文件会退役，Plan 与 Receipt 历史保留。

第一版保持一次推进一个 Slice；同一 Slice 内真正独立的专家工作可以并行，多个 Slice 同时进入执行状态留待后续版本。

原来的自动专家团队、Requirement / Spec / Task、Plan / replan 和质量门流程继续作为 `sourceSchemaVersion: 1` 的编码兼容适配器保留；旧项目可以恢复和完成，新工作默认进入通用 v2 Work Harness。

## Controlled Side Effect

本地分析、草拟和验证不等于授权真实外部动作。发送消息、发布内容、写入外部系统、预算承诺等动作必须：

1. 在 Work Spec 中声明目标匹配的 Approval Point。
2. 向用户展示 action、target、content summary、content hash、影响、可逆性、验证与恢复方法。
3. 用户明确批准这份精确预览后，本地核心才写入授权记录。
4. 授权记录固定为 `externalActionExecuted: false`；它本身不会调用外部系统。
5. 实际动作只能使用刚批准的目标和内容；发生漂移必须重新预览。
6. 动作后以 External Record Evidence 记录真实结果。

结构化资产和 Journal 会拒绝明显的邮箱、手机号、身份证、私钥、Bearer token 和凭据赋值等高置信敏感内容。更复杂的数据分类仍应遵循公司的权限与合规制度。

## 安装

要求 Codex 和 Node.js 22+：

```bash
codex plugin marketplace add zhujufeng/EZagent-Spec
codex plugin add ezagent-spec@ezagent
```

安装或更新后新建一个 Codex 任务，让新 Skills 生效。

版本遵循语义化规则：兼容的新能力提升次版本，例如 `0.1.0 → 0.2.0`；后续兼容性修复依次使用 `0.2.1`、`0.2.2` 等小版本，避免相同版本号命中旧缓存。

也可以把下面这句话交给 Codex：

> 请帮我安装这个 Codex 插件：https://github.com/zhujufeng/EZagent-Spec 。先检查 Codex CLI 与 Node.js 22+，在联网、安装软件或修改全局配置前征得我的确认。

更新：

```bash
codex plugin marketplace upgrade ezagent
codex plugin remove ezagent-spec@ezagent
codex plugin add ezagent-spec@ezagent
```

卸载：

```bash
codex plugin remove ezagent-spec@ezagent
codex plugin marketplace remove ezagent
```

插件不会静默安装 Node.js。普通使用者不需要在业务项目执行 `npm install`；插件包含自足 CLI、兼容专家目录和运行时许可证。

## 在项目中启用

打开目标项目并说：

> 在当前项目启用 EZagent Work Harness。

初始化会先预览并确认以下受管范围：

- `.ezagent/**`
- `AGENTS.md#EZAGENT`
- `.codex/agents/ezagent-*.toml`（v2 按需 Specialist 与旧 v1 专家兼容流程共用的受管 project Agents）

每个项目只需初始化一次。之后直接描述需求；项目内受管 `AGENTS.md` 会自动调用 Router，不需要用户记忆或输入 CLI。这个机制是 Router Skill + 项目规则，不是 Codex lifecycle Hook。预览到确认期间应避免并发修改 `AGENTS.md`；token 过期时会重新预览，不覆盖并发修改。

## 共享上下文与知识

初始化默认 `gitTracking: none`，项目索引、Journal 和 Decision 都只保存在本地。用户可以显式请求启用团队共享；Context Skill 会先展示共享范围和排除范围，批准后才切换为 `artifacts`。

共享项目上下文只保存小型项目摘要、Canonical Terms、稳定约束和项目内来源指针，不复制完整文档或聊天。Router 最多恢复 5 条相关 Decision / Pattern 摘要，确有需要才读取原记录。EZagent 不修改 `.gitignore`，也不代替团队执行 Git 操作。

## Local-only 与安全边界

EZagent runtime 不会自动联网、发送遥测、安装软件、执行 Git 写操作、发布或上传项目。联网、安装、Git 写入和外部 Side Effect 都需要对应的明确授权。

Local-only 只描述 EZagent runtime，不改变 Codex 的模型处理、账号、组织策略或数据保留方式。GitHub marketplace 安装、Codex 自身通信和开发者主动执行的依赖安装不属于 runtime 的离线行为。

状态只能由本地核心修改；Skill 不得直接编辑 `.ezagent/**`。revision、状态、证据、批准 token 或安全条件不匹配时关闭失败。如果初始化或受管文件发布返回 inspection、recovery 或 backup 路径，应保留现场并停止，不猜测成功。

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
