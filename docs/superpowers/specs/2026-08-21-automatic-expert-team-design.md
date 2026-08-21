# EZagent 自动专家组队设计

> **交付更新（2026-08-22）：** 自动组队纵向闭环和标准 Task Knowledge/Finish 已实现。本文中“Knowledge 未交付”和“高风险授权待实现”的描述仅代表当时边界；v0.1.0 已选择直接关闭高风险实施，不再建设授权编号流程。

- 状态：已批准，待书面复核
- 日期：2026-08-21
- 产品：EZagent Spec
- 首发平台：Codex 插件
- 后续平台：Claude Code Adapter
- 运行边界：Local-only

## 1. 背景与结论

EZagent 当前已经具备三个经过测试的底层组件：265 位规范化中文专家目录、确定性的 `selectExperts` / `expandExpertSelection` 选择算法，以及将批准专家渲染为 Codex 项目级 Agent 的同步器。但这些组件尚未形成生产调用链：CLI 没有专家选择或分配入口，Router 只声明“按能力选择少量专家”，选择器与项目 Agent 同步器也没有生产调用者。

因此，当前版本不能声称已经实现自动专家组队。本设计把它补成核心纵向闭环，而不是新增一个供用户手动调用的 `select` 工具。

已确认的产品决策：

1. 专家团队按每个活跃需求动态选择，不在项目初始化时固定。
2. Requirement 澄清、Spec/Task 进入 Plan 阶段后才组队。
3. 专家团队随 Spec/Plan 一起展示和批准，不增加常规确认步骤。
4. 团队采用“最小能力覆盖 + 风险驱动的独立审查”，不设置固定人数或硬上限。
5. Agent 负责把中文需求提取为受控能力字段，本地 Core 负责最终确定性选人。
6. replan 可以增加、撤下或调整专家；Task 完成后撤下活跃团队，但保留历史。
7. 所有专家必须绑定 Requirement/Spec/Task、范围、交付物和质量门，且不能写 EZagent 状态。

## 2. 目标与非目标

### 2.1 目标

- 用户只描述需求，不需要手动挑选专家或输入专家命令。
- Plan 明确展示选中专家、角色、选择原因、范围、交付物和质量门。
- 相同 Task、SelectionRequest、目录版本和 revision 产生相同团队。
- 能力缺口、独立审查缺失、团队异常扩张或状态冲突时关闭失败。
- 批准团队可以跨会话恢复，并能重新生成 Codex 项目级 Agent。
- 团队历史和选择依据保存在项目本地，不保存聊天全文或完整用户提示。
- Core 和 Workflow 不依赖 Codex 文件格式，以便后续增加 Claude Code Adapter。

### 2.2 非目标

- 不在初始化时生成永久固定团队。
- 不在每条用户消息后重新选择专家。
- 不让 Agent 直接提交最终专家 ID 列表。
- 不用固定“三人团队”或其他总数限制替代能力覆盖。
- 不增加 daemon、数据库、MCP server、云端选择服务或 embedding 服务。
- 不允许专家自行批准质量门、推进状态或编辑 `.ezagent/**`。
- 本设计不补齐 Knowledge 持久化和完整高风险授权签发；它们仍属于后续 workflow/release 范围。高风险 Task 在授权能力完成前不得进入实现，Task 在 Knowledge 能力完成前也不得由用户流程推进到 completed。completed 清理行为通过 Core 集成测试验证，不能被宣传为当前完整用户流程。

## 3. 最小纵向范围

自动组队依赖已澄清的 Requirement、已批准的 Spec 和有效 Task。当前 CLI 尚未提供完整 `capture/plan/replan` 生产入口，因此实现不能只暴露选择器。

本功能必须同时交付以下最小 Plan 纵向能力：

- 从当前结构化 Requirement/Spec 创建或读取有效 Task Plan。
- 对 Task Plan 执行只读团队选择预览。
- 将最终团队作为 Plan 的组成部分展示。
- 使用绑定 revision 与目录 fingerprint 的 token 批准 Plan 和团队。
- 在 replan 时重新计算团队并展示差异。
- 在 Task 完成或取消时撤下活跃专家投影。
- 在每次开始实现前验证平台 Agent 与已批准团队一致。

完整 Requirement/Spec 交互体验可以在后续里程碑继续扩展，但没有上述最小 Plan 闭环时，本功能不得标记为完成。

## 4. 总体架构

```text
Router / Spec Skill
  │  从中文 Requirement/Spec 提取受控 SelectionRequest
  ▼
Workflow Core
  │  校验 Requirement / Spec / Task / revision
  │  调用确定性选择器
  │  执行独立审查、能力缺口和软阈值策略
  ▼
ExpertTeamPlan
  │  与 Spec/Plan 一起预览和批准
  ▼
Workspace Transaction
  │  Task Plan + Team history + active projection + audit
  ▼
Platform Adapter
     Codex: .codex/agents/ezagent-*.toml
     Claude Code: 后续使用同一已批准 ExpertTeamPlan
```

### 4.1 Router / Agent

Router 使用模型已有的中文语义理解能力，从 Requirement、Spec、项目文件证据和当前状态提取能力需求。Router 只能提交需要的能力、领域、项目技术信号和职责草案，不能把任意专家 ID 当作选择结果。

Router 每次开始相关工作时先读取 `context --json`。未初始化、处于 safe mode、没有有效 Task、状态或 revision 不匹配时，不进行专家选择。

### 4.2 ExpertTeamService

新增平台无关的 `ExpertTeamService`，职责包括：

- 校验 SelectionRequest 与 Task 风险一致。
- 从锁定的本地专家目录加载候选人。
- 调用现有选择算法形成最小能力覆盖团队。
- 应用独立 reviewer 策略。
- 校验成员职责、范围、交付物和质量门。
- 计算 catalog、selection 和 team fingerprint。
- 生成 preview/apply 所需的确定性 token 材料。
- 为 replan 计算成员和职责 diff。

该服务不得导入 Codex Adapter，也不得读写 `.codex/**`。

### 4.3 Workflow Service

Workflow Service 是 Requirement/Spec/Task 状态和专家团队之间的唯一协调者。它保证：

- 团队只能绑定当前有效 Task。
- Task 必须关联已经澄清或批准的上游工作项。
- Plan 批准与团队批准使用同一个用户决策。
- `planned -> implementing` 前团队必须已批准且平台投影一致。
- replan、完成和取消会正确更新 active 投影。

### 4.4 CLI 与平台 Adapter

CLI 是 Host/Skill 的内部边界，不是用户交互面。建议提供以下内部能力：

- `team-select-preview`：只读计算候选团队。
- `plan-preview`：校验成员职责并生成最终 Plan/团队预览和 approval token。
- `plan-apply`：重新计算并原子提交 Plan 与团队。
- `replan-preview` / `replan-apply`：展示并批准团队差异。
- `experts-reconcile`：使平台 Agent 与已批准团队重新一致。
- `context --json`：返回团队摘要、fingerprint 和平台同步状态。

复杂结构化输入使用一个有大小上限、严格 schema 校验的 UTF-8 JSON stdin 文档。Host 必须通过进程 stdin 传入字节，不得把 JSON 拼接为 shell 字符串。CLI 继续保持单行 JSON stdout、单行净化错误 stderr 和稳定非零错误码。

Codex Adapter 只负责渲染、验证、同步和恢复项目级 Agent。未来 Claude Code Adapter 使用相同 `ExpertTeamPlan` 生成自己的平台文件。

## 5. 核心数据契约

```ts
interface ExpertSelectionRequest {
  capabilities: string[];
  domains: string[];
  projectSignals: string[];
  risk: RiskLevel;
  reviewAfter: number;
}

interface ExpertTeamMember {
  expertId: ExpertId;
  mode: "analysis" | "implement" | "review";
  reasons: string[];
  scope: string[];
  deliverables: string[];
  qualityGates: string[];
}

interface ExpertTeamPlan {
  schemaVersion: 1;
  teamRevision: number;
  requirementId: RequirementId;
  specId: SpecId;
  taskId: TaskId;
  taskRevision: number;
  selectionRequest: ExpertSelectionRequest;
  members: ExpertTeamMember[];
  uncoveredCapabilities: string[];
  requiresPlanReview: boolean;
  catalogFingerprint: `sha256:${string}`;
  selectionFingerprint: `sha256:${string}`;
  teamFingerprint: `sha256:${string}`;
}
```

所有对象必须：

- 使用严格 schema，不允许额外 key、稀疏数组、Proxy、accessor 或危险原型键。
- 使用 NFC 文本和可移植 ID/token 格式。
- 在分配资源前完成元素、深度、文本和 UTF-8 字节预算检查。
- 使用稳定 code-unit 排序和 canonical serialization。
- 只接受 active Task 中记录的 risk，调用方不能通过 SelectionRequest 降低风险。

`capabilities` 中不在目录词表的规范 token 作为真实能力缺口返回；格式非法的 token 直接拒绝。未知 `domains` 或 `projectSignals` 视为调用方映射错误并拒绝，避免拼写错误被静默忽略。

## 6. 选择和角色策略

### 6.1 基础团队

现有 `selectExperts` 继续负责能力覆盖。选择顺序保持确定性：

1. 优先覆盖最多尚未覆盖能力。
2. 再比较领域、项目技术信号和风险审查加分。
3. 完全相同则按专家 ID 的可移植 code-unit 顺序决定。

算法不接受 `maxExperts`，也不因软阈值截断结果。

### 6.2 风险驱动的独立审查

- `consult`：通常不生成项目级 Agent；只读咨询无需团队状态。
- `light`：选择覆盖所需能力的最小团队，不强制独立 reviewer。
- `standard`：必须至少有一位未参与实现、且 `preferredTasks` 支持 review 的独立 reviewer。
- `high`：必须选择与请求领域、能力或项目技术信号最相关的独立 reviewer；无法找到时视为能力缺口。

同一成员不能在同一 Task 中同时承担 `implement` 和 `review`。Reviewer 排序同样必须确定性，并在结果中记录选择原因。

### 6.3 软阈值

默认 `reviewAfter` 为 6。它只是异常范围提示，不是团队上限：

- 结果超过阈值时设置 `requiresPlanReview: true`。
- Router 暂停自动批准，让用户选择拆分 Spec 或明确接受当前范围。
- 用户接受大团队后，决定和原因绑定到新版 Plan token。
- 选择结果不被截断，未覆盖能力也不能因阈值被忽略。

### 6.4 执行并发

团队人数和并发数是两个独立概念。`batchExpertSelection` 只按本机或 Host 并发预算安排批次，不改变团队成员、选择原因或质量门。MVP 可以使用保守并发预算，但不得把它描述为专家数量上限。

## 7. 预览、批准与 token

自动组队采用两次内部计算、一次用户可见确认：

1. `team-select-preview` 根据 Task 和 SelectionRequest 计算候选成员，不写磁盘。
2. Router 只能为返回的成员补充职责合同，不能替换或增加专家 ID。
3. `plan-preview` 重新计算选择，验证职责合同，并返回最终用户可见预览和 approval token。
4. 用户批准 Spec/Plan，同时批准专家团队。
5. `plan-apply` 使用相同输入重新计算；只有 token 完全一致才提交。

approval token 必须绑定：

- project root identity
- workspace revision
- Requirement、Spec、Task ID
- Task revision 和 risk
- SelectionRequest
- 最终成员、角色和职责合同
- catalog fingerprint
- selection/team fingerprint
- 大团队 review decision（如适用）

任何绑定字段变化都会让 token 失效并要求重新展示。Token 不是授权凭据，不能代替 high-risk action authorization。

## 8. 用户可见体验

常规流程不增加独立确认：

```text
本次 Plan

实现专家：后端架构师
选择原因：覆盖 authentication、api-design；匹配 Node.js 项目
职责：实现登录与权限边界
交付物：接口、测试、迁移说明

审查专家：应用安全工程师
选择原因：standard/high 独立审查；匹配 authentication
职责：只读检查认证、令牌和权限边界
质量门：失败路径、权限绕过、密钥与日志检查

能力缺口：无
团队规模：2
```

用户批准 Plan 后自动生成项目 Agent。只在以下情况增加单独提示：

- 存在未覆盖能力。
- 找不到独立 reviewer。
- 团队超过软阈值。
- replan 导致成员增加、撤下或职责发生实质变化。
- Task 或目录变化导致 token 过期。

## 9. 持久化与跨会话恢复

Core-owned 数据：

```text
.ezagent/
├── tasks/<task-id>.yaml
├── experts/
│   ├── active.yaml
│   └── teams/<task-id>/<team-revision>.json
└── audit/events.jsonl
```

- `teams/<task-id>/<team-revision>.json` 保存完整、版本化、平台无关的团队计划。
- `active.yaml` 只保存当前活跃成员摘要、原因和 Task ID，是可快速读取的投影。
- 历史团队文件不因 replan、完成或取消而删除。
- audit metadata 保存 Task/team revision、fingerprint、成员数量和状态变化；完整成员与原因由 fingerprint 指向的团队文件保存，避免 audit 数组上限成为产品人数上限。

Adapter-owned 派生数据：

```text
.codex/agents/ezagent-*.toml
.ezagent/experts/generated-codex.json
```

`context --json` 返回当前团队的 ID/名称/角色摘要、team fingerprint、team revision 和 `platformSyncStatus`。新会话先读取这些数据，不从聊天历史猜测团队。

## 10. replan 与完成

replan 始终针对完整新版 Plan 重新计算团队：

- 范围增加时保留仍适用成员，并补充缺失能力。
- 范围缩小或能力改变时允许撤下不再需要的成员。
- 角色、范围、交付物或质量门变化也属于团队 diff。
- diff 按 added、removed、changed、unchanged 稳定排序并展示。
- 用户批准新版 Plan 后写入新的 team revision，旧版本保持不变。

Task 进入 completed 或 cancelled 后：

- 从 `active.yaml` 撤下仅绑定该 Task 的成员。
- 安全删除或更新 EZagent 自己拥有且 hash 匹配的 Codex Agent 文件。
- 保留团队历史、选择 fingerprint 和验证证据。
- 用户文件、未登记文件或 hash 已变化的文件不得删除，必须进入 inspection/recovery。

## 11. 原子提交、同步与恢复

### 11.1 Core 事务

Plan/team 批准使用现有 `WorkspaceRepository.commitMutation()`，一次 mutation 写入：

- Task Plan
- 新 team revision
- `active.yaml`
- workspace state revision
- audit event

pending mutation marker、artifact hashes、audit 和 state projection 继续提供 crash recovery。不能先把 Task 标成 planned，再单独写团队状态。

现有 `ActiveExpertRepository` 的 canonical serializer/validator 应抽成可复用纯函数，由 Workspace mutation 写入 `active.yaml`；不能在同一逻辑事务中再开启第二个独立专家写锁。

### 11.2 平台同步

Core 事务成功后，Codex Adapter 根据批准团队生成 `.codex/agents/*.toml`。平台文件是可恢复派生物，不是选择事实来源。

同步失败时：

- 不回滚已经批准且内部一致的 Core Plan。
- 返回 recovery/inspection 路径并退出非零。
- Task 保持 planned，禁止进入 implementing。
- 下一次 Router 先运行幂等 `experts-reconcile`。
- 只有 generated manifest 和所有 Agent hash 与批准团队一致，平台同步状态才为 ready。

## 12. 失败关闭规则

- 未初始化、safe mode、Task 缺失或 Task 状态不合法：不选择、不写入。
- SelectionRequest 格式非法或 risk 与 Task 不一致：拒绝。
- 任何能力未覆盖：不能批准 Plan。
- standard/high 缺少独立 reviewer：不能批准 Plan。
- 大团队未经过范围复核：不能批准 Plan。
- workspace、Task、catalog 或 team revision 变化：token 失效。
- replan 并发冲突：返回 revision conflict，不覆盖新状态。
- 目录 provenance 或 fingerprint 无法验证：停止选择。
- Agent 文件同步未完成：不能进入 implementing。
- 高风险授权缺失：即使团队已批准，也不能进入 implementing。
- 专家不得写 `.ezagent/**`、批准自己的质量门或执行状态迁移。
- 不保存聊天全文、完整用户提示或未经使用的完整专家提示到 audit。

## 13. 测试策略

### 13.1 选择策略单元测试

- 最小能力覆盖且无固定人数。
- standard/high 独立 reviewer 自动加入。
- reviewer 与 implementer 角色隔离。
- 缺口和未知标签按契约处理。
- 超过软阈值只触发 review，不截断。
- 相同输入得到 byte-identical、fingerprint-identical 结果。

### 13.2 Workflow 集成测试

- 团队必须绑定有效 Requirement/Spec/Task。
- 两级 preview 均不写磁盘。
- apply 原子写入 Task、team history、active projection 和 audit。
- 过期 token、revision 和 catalog fingerprint 被拒绝。
- recovery 不重复批准或重复增加 revision。
- replan 正确生成 added/removed/changed/unchanged diff。
- completed/cancelled 撤下 active 投影并保留历史。

### 13.3 Codex Adapter 测试

- 每位批准成员生成一个项目 Agent。
- 用户自有 `.codex/agents` 文件保持 byte-identical。
- 只修改 manifest 登记且 hash 匹配的 EZagent 文件。
- 中断后可幂等恢复。
- 同步未 ready 时 transition gate 关闭失败。
- 生成指令禁止写 EZagent 状态和自批质量门。

### 13.4 E2E 场景

1. 用户提出一个 standard 风险的 Node.js 用户资料 API 输入校验与测试需求。
2. Router 生成受控能力请求。
3. Plan 展示实现专家和独立 reviewer，以及选择原因和职责。
4. 用户只批准一次 Plan。
5. Core 原子保存团队，Codex Adapter 生成项目 Agents。
6. 实现和独立审查分别按委派合同执行。
7. 新 Codex 会话从 context 恢复相同团队。
8. 用户增加审计日志范围，replan 展示团队 diff 并重新批准。
9. E2E 到 verifying 为止；Knowledge 未交付时保持关闭失败。另用 Core 集成测试验证 completed 清理，并用取消场景验证当前可执行流程会安全撤下活跃 Agent、保留历史。

同一场景必须在 macOS 与 Windows GitHub Actions 上运行。测试不得联网、写 Git、在仓库根初始化 `.ezagent/` 或修改用户未登记文件。

## 14. 完成标准

只有同时满足以下条件，才能声称自动专家组队已实现：

- 用户可以在 Plan 中看到选了谁、为什么、负责什么。
- 用户无需输入专家命令或手动选择专家。
- 团队人数随需求变化，不存在固定总数限制。
- standard/high 有独立 reviewer，且 reviewer 不参与同一 Task 的实现。
- 所有成员都进入真实结构化委派，不只是展示名称。
- replan 能展示并应用团队 diff。
- 跨会话 context 能恢复团队与平台同步状态。
- Core 状态、历史团队和 audit 可从中断中恢复。
- Codex Agent 同步失败时实现阶段关闭失败。
- 本地完整测试、官方插件 validator、离线插件 smoke、macOS 和 Windows CI 全部通过。
- README 不再把底层组件描述成已接通功能，而是用可复现的 E2E 说明能力。

## 15. 实施顺序约束

后续实施计划按以下依赖顺序展开：

1. 扩展并测试专家角色与独立 reviewer 策略。
2. 定义 ExpertTeamPlan、team history 和 canonical serialization。
3. 实现 ExpertTeamService 的 preview、token、apply 和 replan diff。
4. 将 Task Plan、team history、active projection 和 audit 接入单次 Workspace mutation。
5. 增加内部 CLI 结构化 stdin 契约与稳定错误码。
6. 接入 Codex Agent reconcile 和 implementing 前同步 gate。
7. 更新 Router/Spec/Implement/Review Skills 和 managed AGENTS 规则。
8. 完成跨会话、恢复、macOS/Windows E2E 和公开文档。

不得以“先让 Skill 自己读目录并挑人”作为临时生产方案；那会绕过确定性选择、状态绑定、审计和恢复边界。
