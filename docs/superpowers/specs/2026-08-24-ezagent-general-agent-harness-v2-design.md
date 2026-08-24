# EZagent 通用 Agent Harness v2 设计

- 状态：已批准，进入第二阶段实现
- 日期：2026-08-24
- 阶段：第二阶段——纵向能力切片实现
- 当前交付：按本设计修改运行时、CLI、Skills 和兼容适配器

## 1. Objective

将 EZagent Spec 从“面向中文团队的 Spec Coding 插件”演进为轻量、Local-only、领域中立的 Agent Work Harness：把模糊请求转化为人与 Agent 共同理解、用户批准、可分片执行、可基于证据验收、可跨会话恢复的工作契约。

目标用户是任何希望借助 Agent 完成一项可交付工作的个人或团队成员。下面仅列举常见情况，不构成岗位清单：

- 独立维护完整软件项目的开发者或业务负责人。
- 使用 Agent 完成分析、策划、内容、运营、库存、文档等工作的非开发同事。
- 使用 Agent 处理招聘准备、入职材料、绩效框架等工作，并在敏感数据或对外动作前保留人工控制的同事。

核心 Schema、路由和状态机不得包含岗位枚举或岗位专属分支。新岗位、新部门和新业务场景通过领域术语、Boundary、Deliverable Interface、ReviewPolicy、Evidence 和 adapter 接入，而不是修改核心流程。

核心问题不是“非开发人员不会写 Prompt”，而是他们同样会陷入一种通用的 Vibe Working：

1. 用模糊请求启动大规模生成。
2. 人和 Agent 没有形成 Shared Design Concept。
3. Agent 一次做太多，反馈发生得太晚。
4. 产出看似完整，但无法逐项说明是否满足目标。
5. 会话中断后丢失进度、假设和失败经验。
6. 临时经验、长期规范和聊天噪音混在一起。

成功体验是：用户仍然只需要自然语言描述需求；Harness 自动选择最小必要流程，在关键歧义处一次问一个问题，把共同理解压缩为 Brief 和 Work Spec，先完成一个可验证 Slice，再根据 Evidence 继续。用户负责方向、审批和价值判断，Agent 负责受约束的分析与执行。

## 2. Research Basis

本设计综合以下材料，但不复制其特定目录、命令或编码限定：

- 《理解大模型，用好 AI Coding》：概率模型、上下文稀释、Harness Engineering、渐进式披露、反馈闭环、记忆治理、Skill 与 Hook 的适用边界。
- 《从 Harness Engineering，再到 Trellis 落地》：Project Spec、Task、Workspace Journal 三层认知结构；按任务注入；生命周期；会话恢复；Harness 过重警告。
- 腾讯《当整个团队开始 0 人工 Coding》：Propose/Apply/Archive、人与 Agent 的责任分配、知识/MCP/Skill 分层、Bridge Rule、幂等和降级策略。
- Matt Pocock《Software Fundamentals Matter More Than Ever》及相关 Skills：Shared Design Concept、Ubiquitous Language、反馈速度、Tracer Bullet、Vertical Slice、Deliverable Interface、独立审查和持续结构投资。

共同结论：Spec 不是一次性文档，也不能成为另一种 Vibe Working。可靠性来自模型之外的约束、短反馈环、状态恢复和经验治理；任何 Harness 组件都必须证明其收益大于上下文、等待和维护成本。

## 3. Assumptions

本设计先按以下假设推进；用户审查时可以修改：

1. EZagent 继续保持 Codex-first，但核心模型不依赖代码、Git 或 Shell 才能成立。
2. Local-only、无遥测、无自动联网、无自动 Git、无自动发布仍是运行时默认边界。
3. 用户不需要理解 CLI、内部 ID、Schema 或专家目录；这些都是 Harness 内部实现。
4. v1 Requirement、Spec、Task、Knowledge 和状态文件必须继续可读，不要求用户一次性迁移。
5. v2 不通过增加向量数据库、外部检索服务或新依赖解决上下文问题。
6. 完整用户提示、聊天全文、凭证、候选人敏感数据和完整工具输出不得进入持久化工作记录。
7. Work Spec 批准不等于外部 Side Effect 授权；发送、发布、修改外部系统、花费预算或影响他人的动作必须单独批准。
8. 多 Agent 不是默认值；只有上下文隔离、真正独立的并行 Slice 或独立 Review 能证明收益时才启用。
9. 库存分析、活动策划和招聘准备只是非穷举验收样例；它们必须使用同一个核心模型走通，不能形成岗位枚举、固定人员清单或岗位专属状态机。
10. 编码任务继续作为重要适配器，但不得再定义核心对象的名称和能力边界。

### 3.1 Tech Stack and Phase Two Commands

v2 保持现有技术栈：Node.js 22、TypeScript 7、Zod 4、YAML、Markdown、Vitest 3 和 esbuild。第一阶段不增加依赖，也不运行构建或测试。

第二阶段每个 Tracer Slice 只运行与当前行为直接相关的聚焦测试；三个能力切片全部完成后，各运行一次完整验证：

```bash
npm run check
npm run test:workflow
npm run test:codex
npm run verify
npm run plugin:verify
git diff --check
```

实现计划必须把聚焦命令细化到具体测试文件，避免在每个小提交后重复全量验证。

## 4. Product Positioning

### 4.1 Proposed positioning

> 面向中文用户的轻量 Agent Work Harness：把模糊请求转化为可执行、可验证、可恢复的工作契约，让人负责方向与判断，让 Agent 负责受约束的执行。

### 4.2 What EZagent is

- Shared Design Concept 的形成器。
- Work Spec 与 Approval Point 的执行契约管理器。
- 相关上下文的渐进式加载器。
- Slice 级 Feedback Loop 的控制器。
- Work Journal、Decision Record 和 Pattern 的记忆治理器。
- Skills、工具、MCP 和可选 Specialists 的轻量路由器。

### 4.3 What EZagent is not

- 不是通用项目管理或工单系统。
- 不是要求用户手写大量规范文档的流程框架。
- 不是把所有任务都交给多 Agent 团队的编排平台。
- 不是自动执行所有外部动作的 RPA 平台。
- 不是企业全文知识库或聊天归档系统。
- 不是“写一份 Spec 后忽略产出结构”的 Specs-to-Anything 编译器。

## 5. Product Principles

### P1. Shared understanding before persistent assets

Brief 只能压缩已经形成的 Shared Design Concept。Router 不得因为“需要 Spec”而急于创建 Plan；应先解决会改变结果的决策分支。

### P2. Ask one consequential question at a time

- 一次只问一个会改变结果、范围、证据或 Side Effect 的问题。
- 每个问题附带推荐答案和理由。
- 能从项目、附件或受权工具中查到的事实由 Agent 自行查找。
- 清晰请求可以零问题进入 Brief；不得为了表现流程而机械访谈。

### P3. Context is selected, not accumulated

每个阶段只加载：

1. 极小的 Bridge Rule。
2. 当前 Work Spec 和 active Slice。
3. 最多若干条相关 Project Constitution 指针、Decision Record 或 Pattern 摘要。
4. 当前动作确实需要的源文件或工具结果。

不得注入全部 Project Knowledge、完整 Work Journal、完整聊天或所有 Skills 正文。

### P4. Feedback rate is the speed limit

Agent 不能一次完成大批产出再统一检查。每个 Slice 必须产生可观察 Deliverable，并用声明的 Evidence 关闭一个 Feedback Loop。

### P5. Interface first, implementation delegated

用户优先审查 Deliverable Interface、Acceptance Criteria 和 Approval Points。Agent 可以自主处理内部实现，但不得改变外部契约。

### P6. Vertical slices over horizontal phases

Slice 必须是小而完整的端到端结果。不得默认采用“先收集全部资料、再生成全部内容、最后统一验证”的水平拆分。

### P7. Human steers; Agent executes

人的默认职责是：决定目标、解决价值冲突、批准边界、审查主观质量、授权 Side Effect。Agent 的默认职责是：发现遗漏、组织上下文、提出建议、执行 Slice、收集 Evidence 和报告偏差。

### P8. Memory has separate lifetimes

- Project Constitution：长期稳定。
- Work Journal：active Work Item 的短期记忆。
- Decision Record：完成后的任务记录。
- Pattern：人工批准的可复用经验。

任何信息不得仅因为“以后可能有用”就升级生命周期。

### P9. Harness strength is adaptive

清晰、低风险、可逆的工作不应进入完整状态机；长期、跨会话、含敏感数据或 Side Effect 的工作必须加强约束。流程强度由 Work Mode 决定，不由任务是否“写代码”决定。

### P10. Deterministic safety surrounds semantic work

Schema、预算、路径、revision、token、状态转换、Evidence 完整性和 Side Effect gate 由本地核心确定性验证；需求理解、写作质量和策略判断保留给 Agent 与用户。

## 6. Canonical Model

项目根目录的 `UBIQUITOUS_LANGUAGE.md` 是 v2 设计使用的词汇单一事实来源。核心关系如下：

```text
Request
  -> Shared Design Concept
  -> Brief
  -> approved Work Spec
  -> Work Item
       -> Slice 1 -> Evidence -> feedback
       -> Slice 2 -> Evidence -> feedback
       -> ...
  -> Review against every Acceptance Criterion
  -> Decision Record
  -> optional user-approved Pattern
```

项目上下文关系：

```text
Project Constitution
  -> Canonical Terms
  -> durable Boundaries
  -> Context Pointers

active Work Item
  -> Work Spec
  -> active Slice
  -> bounded Work Journal

completed work
  -> Decision Records
  -> approved Patterns
```

## 7. Work Modes

### 7.1 Consult

适用：解释、只读咨询、单次分析且不产生 Side Effect。

- 不创建 Work Item。
- 不持久化用户请求。
- 可以读取最小必要上下文。
- 输出中明确区分事实、推断和建议。

### 7.2 Quick

适用：目标清楚、局部、低影响、可逆、单会话完成。

- 最多 5 项内部微计划。
- 至少关闭一个轻量 Feedback Loop。
- 不持久化 Brief、Work Spec、Work Journal 或 Specialists。
- 发现关键歧义、范围扩大、跨会话需求或 Side Effect 时停止并升级。

### 7.3 Brief Mode

适用：大多数非开发同事的结构化工作和边界明确的单人项目任务。

- 形成小型 Brief 和 Work Spec。
- 默认 1 至 5 个 Slices。
- 默认单 Agent 执行。
- 每个 Slice 有 Deliverable Interface 和 Evidence 方法。
- 允许跨会话恢复，但不强制独立 Reviewer。

### 7.4 Standard Mode

适用：跨会话、多来源、多 Deliverables、多个依赖 Slices 或中等影响的工作。

- 持久化完整 Brief、Work Spec、Slice 状态和 Work Journal。
- 每个 Acceptance Criterion 必须有 Evidence coverage。
- 是否使用 Specialist 或 Independent Reviewer 由 reviewPolicy 决定。
- 单一 Work Item 最多 15 个 Slices；超过时拆分新的 Work Item，避免上下文和 Review 失控。

### 7.5 Controlled Mode

适用：敏感数据、对外沟通、发布、预算、生产系统、人员决策、法律/合规影响或难以回滚的工作。

- 可以执行只读调查、草稿准备、模拟和 dry-run。
- 每个危险 Side Effect 有单独 Approval Point。
- Work Spec 的一次批准不能作为 blanket authorization。
- 当前 v1 `high` 继续保持实施关闭；v2 只有在对应 Side Effect adapter 和审批契约完成后才逐项开放。

### 7.6 Compatibility mapping

| v1 | v2 view | Migration rule |
| --- | --- | --- |
| `consult` | Consult | 无持久化变化 |
| `light` | Quick | 保留现有快速通道 |
| `standard` | Standard Mode | 旧任务不自动降级；新任务可根据复杂度选择 Brief Mode |
| `high` | Controlled Mode | 默认仍关闭实际 Side Effect，仅允许安全准备 |

## 8. Conceptual Schemas

以下 Schema 用于确定语义和兼容边界，不是本阶段的最终 TypeScript API。

### 8.1 Brief

```ts
interface BriefV2 {
  readonly schemaVersion: 2;
  readonly requestSummary: string;
  readonly intendedOutcome: string;
  readonly actors: readonly string[];
  readonly canonicalTerms: readonly {
    readonly name: string;
    readonly meaning: string;
  }[];
  readonly decisions: readonly string[];
  readonly assumptions: readonly {
    readonly statement: string;
    readonly source: "user" | "project" | "agent-recommendation";
    readonly confirmed: boolean;
  }[];
  readonly openQuestions: readonly string[];
  readonly sourcePointers: readonly ContextPointer[];
}
```

规则：

- 不保存完整用户提示或完整访谈记录。
- `requestSummary` 必须是中性、无新增承诺的压缩描述。
- 只有会改变结果的未决问题才能阻止进入 Work Spec。
- 非阻塞 open question 可以显式保留为假设或后续项。

### 8.2 Work Spec

```ts
interface WorkSpecV2 {
  readonly schemaVersion: 2;
  readonly mode: "brief" | "standard" | "controlled";
  readonly outcome: string;
  readonly scope: readonly string[];
  readonly nonGoals: readonly string[];
  readonly deliverableInterfaces: readonly DeliverableInterface[];
  readonly acceptanceCriteria: readonly AcceptanceCriterion[];
  readonly boundaries: readonly Boundary[];
  readonly approvalPoints: readonly ApprovalPoint[];
  readonly reviewPolicy: ReviewPolicy;
  readonly slicePlan: readonly SlicePlan[];
}
```

Work Spec 不规定 Agent 的每个内部思考步骤，只固定用户可观察契约。任何影响 outcome、scope、nonGoals、Deliverable Interface、Acceptance Criteria、Boundary 或 Approval Point 的变化都必须 Replan。

### 8.3 Deliverable Interface

```ts
interface DeliverableInterface {
  readonly id: string;
  readonly kind: "code" | "document" | "analysis" | "dataset" | "visual" | "draft-action" | "other";
  readonly description: string;
  readonly requiredSections: readonly string[];
  readonly invariants: readonly string[];
  readonly consumer: string;
}
```

`draft-action` 仅代表准备好的邮件、发布内容、审批申请或外部变更草案，不表示已经执行 Side Effect。

### 8.4 Boundary and resource reference

```ts
interface Boundary {
  readonly id: string;
  readonly dimension: "resource" | "data" | "people" | "time" | "budget" | "system" | "operation";
  readonly rule: string;
  readonly resources: readonly ResourceRef[];
}

interface ResourceRef {
  readonly kind: "file" | "document" | "dataset" | "application" | "external-system" | "other";
  readonly locator: string;
  readonly purpose: string;
  readonly access: "read" | "draft" | "write" | "publish";
}
```

规则：

- `allowedPaths` 成为 `kind: file` 的兼容 adapter，不再是核心模型唯一边界。
- `locator` 只能保存安全引用，不得包含 Token、密码、候选人完整敏感信息或私密正文。
- `publish` 和对外 `write` 自动生成 Approval Point。

### 8.5 Acceptance Criterion and Evidence

```ts
interface AcceptanceCriterion {
  readonly id: string;
  readonly statement: string;
  readonly requiredEvidenceKinds: readonly EvidenceKind[];
}

type EvidenceKind =
  | "command"
  | "artifact"
  | "checklist"
  | "comparison"
  | "citation"
  | "human-approval"
  | "external-record";

interface EvidenceBase {
  readonly id: string;
  readonly criterionIds: readonly string[];
  readonly sliceId: string;
  readonly observedAt: string;
  readonly summary: string;
}

type Evidence =
  | CommandEvidence
  | ArtifactEvidence
  | ChecklistEvidence
  | ComparisonEvidence
  | CitationEvidence
  | HumanApprovalEvidence
  | ExternalRecordEvidence;
```

各 Evidence kind 的最小语义：

- `command`：实际命令、环境、退出码和有界摘要。
- `artifact`：Deliverable 引用、内容 hash、检查方法和观察结果。
- `checklist`：预先声明的检查项及逐项 pass/fail/blocked。
- `comparison`：比较对象、方法、差异和阈值。
- `citation`：来源指针、支持的 claim 和访问日期；不得保存整篇来源。
- `human-approval`：被批准内容的 hash、批准结论和 Approval Point ID；默认不保存个人身份。
- `external-record`：系统、非敏感记录引用和观察状态；外部系统成功响应不自动等于用户目标完成。

完成规则：

1. 每个 Acceptance Criterion 至少由一条 Evidence 引用。
2. Evidence kind 必须满足 criterion 声明的类型。
3. Review 必须输出 criterion-by-criterion coverage；不能只报告“所有命令通过”。
4. 缺失、矛盾、过期或无法复现的 Evidence 关闭失败。

### 8.6 Slice

```ts
interface SliceV2 {
  readonly id: string;
  readonly title: string;
  readonly intendedOutcome: string;
  readonly inputPointers: readonly ContextPointer[];
  readonly deliverableInterfaceIds: readonly string[];
  readonly criterionIds: readonly string[];
  readonly blockedBy: readonly string[];
  readonly humanCheckpoint: boolean;
  readonly status: "pending" | "executing" | "reviewing" | "accepted" | "revise" | "cancelled";
}
```

Slice 规则：

- 第一条 Slice 默认是 Tracer Slice，证明完整路径可工作。
- 一个 Slice 必须能独立展示或验证，不得只完成某一内部层。
- Slice 之间有强共享中间状态时优先顺序执行，不为了并行而拆 Agent。
- `revise` 只回到当前 Slice；影响 Work Spec 契约时必须 Replan。

### 8.7 Work Journal

```ts
interface WorkJournalEntry {
  readonly schemaVersion: 1;
  readonly workItemId: string;
  readonly sliceId: string;
  readonly sequence: number;
  readonly summary: string;
  readonly observations: readonly string[];
  readonly decisions: readonly string[];
  readonly failedApproaches: readonly string[];
  readonly nextStep: string;
  readonly contextPointers: readonly ContextPointer[];
}
```

规则：

- Journal 只保存继续工作所需的有界摘要，不保存完整聊天、思维链或完整工具输出。
- `sequence` 单调递增，条目 append-only；压缩时保留决策理由、失败方向和下一步。
- Journal 默认 local-only，不进入 `gitTracking: artifacts`。
- 完成 Work Item 后，Review 从 Journal 提炼 Decision Record；Journal 不自动晋升为 Pattern。

## 9. Lifecycle

### 9.1 Work Item lifecycle

```text
captured
  -> clarifying
  -> specified
  -> approved
  -> executing
  <-> reviewing
  -> completed

any non-terminal state -> cancelled
```

- `captured`：只有有界 Request 摘要。
- `clarifying`：形成 Shared Design Concept。
- `specified`：Brief 和 Work Spec preview 已就绪。
- `approved`：用户批准 exact Work Spec，尚未产生执行成本。
- `executing`：只执行当前 active Slice。
- `reviewing`：检查当前 Slice 或最终 Acceptance coverage。
- `completed`：全部 criteria 有有效 Evidence，最终 Deliverable 可读取，Decision Record 已原子写入。

`blocked` 不作为可长期停留的成功状态；阻塞原因作为 blocker 保存在上下文，解除后继续原状态。无法安全恢复时进入 inspection-required。

### 9.2 Slice feedback loop

```text
load minimal context
  -> execute one bounded action
  -> observe Evidence
  -> compare with Slice criteria
     -> accepted: advance
     -> revise: update Journal and retry current Slice
     -> contract changed: stop and Replan
     -> Side Effect reached: stop at Approval Point
```

### 9.3 Replan

Replan preview 必须显示：

- Shared Design Concept 的新决策。
- Work Spec 字段级差异。
- Slices added/removed/changed/unchanged。
- Evidence coverage 受影响项。
- Specialists 或 ReviewPolicy 的变化。
- 新增、删除或扩大的 Approval Points。

未批准时保留原 Work Spec、已接受 Slices 和有效 Evidence；不得静默扩写。

## 10. Discovery and Brief Formation

Router 在创建持久化资产前执行轻量 discovery：

1. 从 Request、Project Constitution 和已授权来源提取候选 outcome、actors、Canonical Terms、boundaries、Deliverable Interface 和 Side Effects。
2. 标记会改变结果的 ambiguities 与 assumptions。
3. 优先通过只读探索解决事实问题。
4. 对剩余最重要决策一次问一个问题，并给出推荐答案。
5. 当 outcome、主要 boundary、Deliverable Interface 和 Review 方法稳定后生成 Brief preview。

停止澄清的条件：

- 所有阻塞决策都有用户答案、项目证据或明确批准的推荐答案。
- 未决问题不会改变当前 Tracer Slice。
- 用户可以看懂“会得到什么、不会做什么、如何判断好坏、哪里还要批准”。

不得使用固定问题数量。不得把探索本身变成长篇问卷。

## 11. Context Architecture

### 11.1 Always-on bridge

常驻上下文只包含：

- 如何判断 Consult/Quick/Brief/Standard/Controlled。
- 如何定位当前 Work Item。
- 何时加载对应 Skill。
- 不得自动 Side Effect、不得绕过核心状态。

Bridge 不复制 Schema、评分、项目知识或完整流程正文。

### 11.2 On-demand layers

| Layer | Content | Lifetime |
| --- | --- | --- |
| L0 | Bridge Rule | session |
| L1 | Project Constitution 摘要与 Canonical Terms | project |
| L2 | active Work Spec + active Slice | work item |
| L3 | selected Decision/Pattern summaries + Journal tail | current action |
| L4 | exact source files, documents, tool results | one Feedback Loop |

### 11.3 Selection rules

- 沿用确定性的相关知识检索作为候选入口。
- 当前 active Slice 的 Context Pointers 优先于近期知识。
- Journal 只加载最近有效摘要和未解决 blocker，不注入全部历史。
- Skills 根据“何时使用”加载，不按专家数量全部启用。
- MCP/tool definitions 只在当前 Slice 需要时暴露；不能让工具目录吞噬固定上下文。

## 12. Specialists and Review

### 12.1 Selection order

```text
Shared Design Concept
  -> capability need
  -> decide Skill / tool / Specialist
  -> decide whether isolation is valuable
```

不得先选专家再反向解释任务。

### 12.2 When to use a Specialist

- 需要当前 Agent 缺少的领域判断框架。
- 需要隔离大量探索或工具输出，主上下文只保留结构化摘要。
- 一个 Slice 与其他 Slice 真正独立，可以安全并行。
- ReviewPolicy 要求未参与执行的独立视角。

### 12.3 When not to use a Specialist

- 任务简单且单一。
- 子任务强依赖共享中间状态。
- 只是为了让团队规模显得完整。
- 同一个 Skill 或确定性脚本已经能提供所需能力。
- 委派、同步和审查成本超过 Slice 本身。

### 12.4 ReviewPolicy

```ts
interface ReviewPolicy {
  readonly method: "self" | "independent-agent" | "human" | "mixed";
  readonly reasons: readonly string[];
  readonly reviewAfterSlices: number;
}
```

- 可机器验证且低影响的 Brief Mode 可 self review。
- 主观策略、品牌、人员、法律和高影响决策至少需要 human 或 mixed。
- 独立 Agent Review 必须只读，且不能复用执行者未压缩的内部上下文作为结论依据。
- `reviewAfterSlices` 约束反馈间隔，不能只在所有工作结束后 Review。

## 13. Side Effects and Approval

Side Effect 包括但不限于：

- 发送邮件、即时消息或通知。
- 发布内容、广告、职位或页面。
- 修改生产系统、外部表格、业务记录或权限。
- 花费预算、提交订单或触发付费服务。
- 对候选人、员工、客户或供应商产生直接影响的动作。
- 删除、覆盖、归档或不可逆转换数据。

每个 Approval Point preview 必须显示：

- exact action。
- exact target。
- 将发送或写入的有界内容摘要/hash。
- 预计影响和可逆性。
- 成功后的验证方式。
- 失败或部分成功时的恢复路径。

Approval token 继续绑定项目 identity、workspace revision、action、target 和 exact content。工具连接、已登录状态、Work Spec 批准或历史授权都不能替代本次批准。

## 14. Storage and Compatibility

### 14.1 Minimal storage evolution

优先复用现有目录，避免为概念重新复制数据：

```text
.ezagent/
├── project.yaml
├── requirements/          # v1 Requirement；v2 Brief 的兼容存储区
├── specs/                 # v1 Spec；v2 Work Spec
├── tasks/                 # v1 Task；v2 Work Item + embedded Slice metadata
├── journals/              # v2 Work Journal，默认 local-only
├── quality/runs/          # v1 quality runs；v2 Evidence bundles
└── knowledge/
    ├── project.yaml       # Project Constitution index
    ├── decisions/         # Decision Records
    └── patterns/          # approved Patterns
```

### 14.2 Schema compatibility

- v1 files remain immutable and readable.
- New v2 writes use discriminated `schemaVersion: 2` records.
- Context returns one normalized view with `sourceSchemaVersion` for diagnostics.
- No background rewrite, bulk migration, or destructive rename.
- A v1 active Task continues with v1 rules until completion or explicit replacement Work Spec approval.

### 14.3 Field adapters

| v1 field | v2 normalized meaning |
| --- | --- |
| Requirement `title/summary` | partial Brief Request summary |
| Spec `goal` | Work Spec outcome |
| Spec `scope/nonGoals` | same canonical meaning |
| Spec `acceptance` | Acceptance Criteria without typed Evidence requirements |
| Spec `verification` | candidate Evidence methods |
| Task `allowedPaths` | file ResourceRefs with write access |
| Task `deliverables` | untyped Deliverable Interfaces |
| Task `qualityGates` | Acceptance Criteria or Evidence methods, resolved conservatively |
| Knowledge v2 receipt | `command` Evidence |
| `implementing` | user-facing `executing` |
| `verifying` | user-facing `reviewing` |

Ambiguous v1 `qualityGates` must not be silently reinterpreted for new completion. Existing v1 completion continues under v1 validation; replacement v2 Work Spec must assign explicit criterion IDs and Evidence kinds.

## 15. Skills and Internal Commands

### 15.1 Proposed Skills

保持职责小而清晰：

- `ezagent-router`：识别 Work Mode、恢复 active Work Item、加载最小 Bridge。
- `ezagent-discover`：形成 Shared Design Concept，一次问一个关键问题。
- `ezagent-spec`：把 approved Brief 转为 Work Spec preview/apply 和 Replan。
- `ezagent-execute`：只执行 active Slice，维护 Journal 和 Evidence。
- `ezagent-review`：按 Acceptance coverage 审查 Slice 或 Work Item。
- `ezagent-context`：维护 Project Constitution、检索相关知识和晋升 Pattern。

`ezagent-implement` 在兼容期作为 `ezagent-execute` 的 coding adapter 或别名，不立即删除。

### 15.2 User-facing verbs

用户不需要记命令，Router 应理解：

- 探索、一起想清楚、梳理需求。
- 制定方案、写计划、创建分析、整理材料。
- 开始执行、继续、先做一个样例。
- 检查、核对、验收、找遗漏。
- 发送、发布、提交、更新外部系统。
- 记录进度、明天继续、恢复任务。
- 沉淀经验、更新项目术语。

### 15.3 Internal command families

内部 CLI 仍使用 preview/apply 和 bounded stdin；具体命令名在实现计划中确定，至少覆盖：

- brief preview/apply。
- Work Spec preview/apply/replan。
- Slice start/review/accept/revise。
- Journal append/context。
- Evidence capture/coverage。
- Side Effect preview/apply。
- completion and Decision Record capture。

## 16. Scenario Walkthroughs

本节的三个场景只是用于检验同一抽象能否跨领域成立的 acceptance fixtures，并不限定产品服务的人员、岗位或部门。实现不得根据这些标题写入 `inventory`、`operations`、`hr` 等角色枚举；场景差异只能来自 Work Spec 中声明的领域术语、边界、交付接口、证据和审查策略。

### 16.1 Inventory owner: inaccurate stock alerts

#### Request

> 帮我检查最近库存预警为什么不准确，并给出修正方案。

#### Discovery

Agent 先读取库存项目的 Project Constitution，发现“库存”可能指账面、可售或包含在途库存。它不直接生成结论，而是只问一个会改变结果的问题，并推荐“可售库存作为主口径，在途库存单列”。

#### Brief

- Outcome：解释预警偏差并给出可验证修正方案。
- Canonical Terms：可售库存、在途库存、安全库存、缺货风险。
- Boundary：先分析鞋服品类；只读库存数据；不修改生产规则。
- Deliverable Interface：口径、异常样本、原因、影响、建议、数据截止时间。
- Open Question：修正规则是否扩展到全部品类，待 Tracer Slice 后决定。

#### Slices

1. Tracer：选择一个鞋服子类，复现预警与实际结果。
2. 对照：比较当前规则、建议规则和历史数据。
3. 扩展：用户确认后覆盖剩余鞋服品类。
4. Draft action：准备规则变更草案，不应用生产系统。

#### Evidence

- `citation`：数据源与截止时间。
- `comparison`：预警结果与实际缺货/积压结果。
- `artifact`：分析报告内容 hash。
- `checklist`：Deliverable Interface 完整性。
- 修改生产规则需要新的 Side Effect Approval Point。

#### Success

用户可以先审查一个小样本，确认口径和分析方向，再决定是否扩展；Agent 不会直接批量改规则。

### 16.2 Operations planner: Xiaohongshu campaign

#### Request

> 帮我做一个下月的小红书活动方案。

#### Discovery

Agent 从已有品牌资料读取能自行确认的信息，只询问最关键的目标：曝光、线索或成交，并推荐一个主目标与一个守护指标。随后确认预算上限和发布是否在本次范围。

#### Brief

- Outcome：形成可以交给运营执行的活动方案，而不是泛泛创意列表。
- Boundary：一个月、指定品牌、预算上限；本轮不发布内容、不调整广告预算。
- Deliverable Interface：目标、受众、内容支柱、渠道节奏、样例、预算、指标、风险。
- Canonical Terms：曝光、有效互动、线索、成交分别定义，禁止混用。

#### Slices

1. Tracer：一个内容支柱的一周完整样例。
2. Feedback：用户按品牌、可执行性和成本检查样例。
3. Expansion：扩展完整月度日历。
4. Review：对照预算、目标和品牌约束。
5. Draft action：准备发布包；任何真实发布单独批准。

#### Evidence

- `artifact`：一周样例和完整活动方案。
- `checklist`：品牌、预算、必需章节。
- `citation`：引用的市场事实和平台规则。
- `human-approval`：主观创意方向和最终发布包。

#### Success

Agent 不会一开始生成十页方案；用户先看一个端到端样例，反馈成为下一 Slice 的输入。

### 16.3 HR: warehouse supervisor recruitment package

#### Request

> 帮我做一个仓储主管的招聘方案。

#### Discovery

Agent 先解决岗位边界：仓储主管是否管理人员、仓库规模、必须能力和最终审批人。它读取现有岗位资料，但不主动扫描候选人数据。

#### Brief

- Outcome：形成一致、可执行、可审查的招聘包。
- Boundary：不做候选人录用决定；不使用受保护特征；不联系候选人；不发布职位。
- Deliverable Interface：岗位能力模型、JD、面试问题、评分表、风险提示、入职准备清单。
- ReviewPolicy：mixed；HR 负责人审查岗位和公平性，Agent 检查结构完整性。

#### Slices

1. Tracer：岗位能力模型与一组行为评分题。
2. Human checkpoint：HR 与业务负责人确认能力模型。
3. Expansion：生成 JD、完整题库和评分表。
4. Review：公平性、岗位一致性、证据记录方式。
5. Draft action：准备职位发布草稿；真实发布另行批准。

#### Evidence

- `artifact`：招聘包及内容 hash。
- `checklist`：必需组成、禁用条件和敏感信息边界。
- `human-approval`：能力模型和发布草稿。
- `external-record`：仅在批准发布后记录非敏感职位 ID 与状态。

#### Success

Agent 负责结构化和草拟，人保留岗位判断、公平性审查和对外动作；Work Journal 不保存候选人敏感正文。

## 17. Testing Strategy for Phase Two

第二阶段采用 Tracer Bullet 和聚焦验证，不先写完所有 Schema 再统一接线。

### 17.1 Slice A: domain-neutral work contract

端到端证明：

- discovery 可以形成 bounded Brief。
- Work Spec 能表达 file/dataset Boundary。
- 一个 Slice 可以捕获 comparison/artifact Evidence。
- completion 必须覆盖全部 criteria。
- v1 coding Task 仍可恢复。

库存分析场景只作为该能力切片的验收样例。

### 17.2 Slice B: heterogeneous evidence and side-effect gate

端到端证明：

- Brief Mode 不需要专家团队。
- Deliverable Interface 可以描述文档方案。
- citation/checklist/human-approval Evidence 可组合。
- publish Side Effect 在单独 approval 前关闭失败。

活动策划场景只作为该能力切片的验收样例。

### 17.3 Slice C: controlled work and mixed review

端到端证明：

- Controlled Mode 可安全准备但不能自动联系或发布。
- 敏感内容不进入 Journal、audit 或 Evidence summary。
- mixed ReviewPolicy 能阻止缺少 human approval 的 completion。

招聘准备场景只作为该能力切片的验收样例。

### 17.4 Compatibility and safety

- v1 Requirement/Spec/Task/Knowledge fixtures 原样读取。
- v1 command receipt 映射为 command Evidence 时 hash 稳定。
- v1 active Task 不自动改用 v2 completion。
- approval token 绑定 action、target、content 和 revision。
- Evidence 缺失、重复、错误类型、跨 Slice 引用和 source drift 关闭失败。
- bounded input、Unicode、路径、JSON/YAML/Markdown 和 symlink 安全保持现有标准。
- Router/Skill contract 测试覆盖非开发触发词和不触发条件。
- 完成三个聚焦 Slice 后各运行一次完整 `npm run verify` 与 `npm run plugin:verify`，不重复全量验证。

### 17.5 Code Style and Implementation Constraints

- 所有 v2 外部输入使用 strict discriminated Zod schemas，并在读取集合或分配内存前检查字节预算。
- v1 与 v2 使用显式 adapters；不得把兼容条件散落在 Router、CLI 和 Skills 中。
- 核心对象、嵌套数组和 normalized views 保持不可变返回。
- ID、hash、排序、Evidence coverage 和 selection 不依赖 locale、随机数或当前时间做决策。
- 时间只作为观察元数据，不参与 approval token、相关性或完成判定，除非 Work Spec 明确声明时间阈值。
- `service.ts` 只负责编排和原子 mutation；Brief、Work Spec、Slice、Evidence 和 Journal schemas 分别放在聚焦模块。
- Skills 只描述何时加载、语义流程和停止条件；核心 Schema、状态转换和安全验证只保留在本地核心。
- coding、document、analysis 和 external-system 行为通过 adapters 接入同一 Harness，不在核心复制状态机。
- 新增可观察行为先完成一个端到端聚焦测试，再扩展下一个行为；禁止先批量写完测试或 Schema 后统一实现。

## 18. Migration Strategy

### Phase 1: design and contract approval

本文件与 Ubiquitous Language 完成后：

1. 用户确认产品定位、Work Modes、核心对象和三个非穷举验收场景。
2. 根据审查修订设计。
3. 形成第二阶段纵向实现计划。
4. 未获批准前不修改 runtime、CLI、Skills 或 v1 files。

### Phase 2: vertical implementation

按三个领域中立的 Tracer Slices 实施；括号中的业务场景仅用于验收：

1. Work Contract Slice（库存分析样例）：先建立最小 v2 Brief/Work Spec/Slice/Evidence 内核和 v1 adapter。
2. Evidence & Action Slice（活动策划样例）：扩展非命令 Evidence、Brief Mode 和 Side Effect preview。
3. Controlled Review Slice（招聘准备样例）：扩展 Controlled Mode、mixed review 和敏感信息边界。
4. 三个能力切片都成立后再抽取稳定公共接口并更新 Router、Skills、README 和插件定位。

每个 Slice 独立提交、聚焦测试、可回滚；不使用一次性水平大迁移。

## 19. Success Criteria

1. 用户无需使用开发术语即可完成 discovery、批准、执行、Review 和恢复。
2. 清晰小任务不会被迫创建完整持久化流程。
3. 大多数运营、策划和文档任务可以使用默认 Brief Mode，而不自动组建专家团队。
4. Shared Design Concept 形成在 Brief 和 Work Spec 之前；Router 不急于产出资产。
5. 每个持久化 Work Item 至少有一个独立可验证 Slice。
6. 每个 Acceptance Criterion 在完成前都有类型匹配的 Evidence。
7. command 只是 Evidence 的一种，不再定义 Review。
8. file path 只是 Boundary 的一种，不再定义任务范围。
9. Work Journal 可以跨会话恢复尝试、发现、决策和下一步，但不保存聊天全文。
10. Project Constitution、Work Journal、Decision Record 和 Pattern 生命周期清晰，不互相替代。
11. Specialists 与 Independent Reviewer 按实际价值启用，不再是 Standard 的固定前置。
12. Controlled Mode 可以安全准备草稿，但任何敏感或不可逆 Side Effect 都有独立批准。
13. 至少三个跨领域样例使用同一核心 Schema 和状态机走通；增加任何新岗位或业务类型都不需要修改核心枚举。
14. v1 active 和 archived records 保持可读、可恢复、可完成。
15. 插件保持 Local-only、无新增网络权限、无自动 Git、无自动发布、无新增依赖。
16. Harness 维护和上下文成本有明确预算；若流程成本超过工作本身，Router 必须降级到更轻 Work Mode。

## 20. Boundaries

### Always

- 使用 `UBIQUITOUS_LANGUAGE.md` 中的 Canonical Terms。
- 先形成 Shared Design Concept，再持久化 Brief。
- 每个问题一次只解决一个关键决策分支并给出推荐答案。
- 以 Deliverable Interface 和 Acceptance Criteria 约束结果。
- 以 Slice 关闭短 Feedback Loop。
- 所有 completion 提供 criterion-by-criterion Evidence coverage。
- 保持 v1 可读和现有 fail-closed 安全模型。

### Ask First

- 改变本设计中的产品定位或 Work Mode 含义。
- 删除或重命名 v1 目录、命令、状态或公开类型。
- 允许某类 Side Effect 自动执行。
- 保存个人身份、候选人数据或完整外部文档。
- 引入外部知识库、embedding、数据库或运行时依赖。
- 使多 Agent 成为某个通用 Work Mode 的固定要求。

### Never

- 把完整用户 Prompt 或聊天持久化为 Brief、Journal 或 Knowledge。
- 用一份大 Spec 替代增量反馈。
- 为满足流程而机械追问、机械组队或机械拆分。
- 将“工具调用成功”等同于“用户目标完成”。
- 将 Work Spec 批准解释为外部 Side Effect 的 blanket authorization。
- 自动把 Journal 或 Decision Record 晋升为 Pattern。
- 在没有迁移路径时破坏 v1 active Work Item。

## 21. Approved Decisions

以下决策已由用户确认：

1. 产品定位是否从 `Spec Coding` 调整为 `Agent Work Harness`，同时保留 Coding adapter？（推荐：是）
2. 是否采用 Consult、Quick、Brief、Standard、Controlled 五种 Work Modes？（推荐：是；用户界面可使用中文，不要求记英文名）
3. 是否允许 Controlled Mode 执行只读调查和草稿准备，但让每个外部 Side Effect 单独批准？（推荐：是）
4. 是否取消 Standard 默认必须组建专家团队，改为按上下文隔离和 ReviewPolicy 决定？（推荐：是）
5. 是否把 `UBIQUITOUS_LANGUAGE.md` 作为项目公开的产品语言来源？（推荐：是）
6. 按三个领域中立的 Tracer Slices 实现，并仅把库存分析、活动策划和招聘准备作为非穷举验收样例，而不是先完成全部底层 Schema。

## 22. Open Questions

- `ezagent-execute` 是新 Skill 名，还是仅把 `ezagent-implement` 的用户语义泛化并保留原名作为内部兼容入口？推荐新增 `execute`，保留 `implement` adapter 至少一个兼容周期。
- Work Journal 使用 JSONL 还是规范 Markdown？推荐本地核心使用有界 JSONL 便于追加和验证，`context` 输出人类可读摘要；不把完整 Journal 作为共享文档。
- HumanApprovalEvidence 是否需要保存批准时间？推荐保存本地生成时间、Approval Point ID 和内容 hash，不保存姓名或账号，除非外部合规流程明确要求。
- Brief Mode 是否默认持久化？推荐是；Quick 已覆盖无需持久化的任务，Brief Mode 的价值就是低成本跨会话恢复。
