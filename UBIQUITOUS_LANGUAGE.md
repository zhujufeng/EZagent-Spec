# Ubiquitous Language

## Work definition

| Term | Definition | Aliases to avoid |
| --- | --- | --- |
| **Request** | 从用户原始消息中提炼出的、有界且结构化的预期结果描述。 | Prompt、requirement、instruction |
| **Shared Design Concept** | 用户与 Agent 对问题、预期结果、重要决策和未决分支形成的当前共同理解。 | Plan、spec、prompt |
| **Brief** | 在批准和执行前，对 Shared Design Concept 形成的可审查快照。 | Requirement、draft spec、plan |
| **Work Spec** | 用户批准的任务契约，定义一个 Work Item 的结果、范围、非目标、Boundary、Deliverable Interface、Acceptance Criteria、Evidence 预期和 Approval Points。 | Project Spec、prompt、implementation plan |
| **Work Item** | 由一个 active Work Spec 约束的持久化工作单元。 | Ticket、task、request |
| **Slice** | Work Item 中最小的端到端工作单元，能产生可独立审查的结果并关闭一个 Feedback Loop。 | Subtask、phase、layer |
| **Deliverable** | 交付给用户的结果，例如代码、文档、分析、表格、方案或准备好的外部动作草稿。 | Output、artifact、answer |
| **Deliverable Interface** | Deliverable 对外可观察的形状、必需章节、不变量和使用预期。 | Template、format、implementation |
| **Acceptance Criterion** | Work Item 完成前必须由 Evidence 支持的一项可观察条件。 | Quality gate、task step、test |
| **Evidence** | 说明某项 Acceptance Criterion 如何被检查以及实际观察到什么的有界记录。 | Claim、summary、test output |

## Context and memory

| Term | Definition | Aliases to avoid |
| --- | --- | --- |
| **Project Constitution** | 保存项目目的、Canonical Terms、长期约束和权威来源指针的小型稳定事实来源。 | Project Spec、README 副本、all context |
| **Canonical Term** | 用户、Agent、Deliverables 和项目记录共同使用的一个领域概念的唯一推荐名称。 | Keyword、tag、synonym |
| **Context Pointer** | 不复制来源正文，只说明相关信息在哪里以及为何可能需要它的有界引用。 | Context、attachment、embedded document |
| **Work Journal** | 用于跨会话恢复的任务局部记录，保存已尝试动作、发现、决策、当前位置和下一步。 | Chat history、audit log、Knowledge |
| **Decision Record** | 已完成 Work Item 的有界记录，保存任务特有的决策、约束、Evidence 摘要和后续事项。 | Journal、Pattern、full transcript |
| **Pattern** | 从一个或多个已验证 Decision Records 中提炼并经用户批准的可复用指导。 | Rule、raw Knowledge、automatic memory |

## Execution and control

| Term | Definition | Aliases to avoid |
| --- | --- | --- |
| **Harness** | 位于模型之外、负责提供相关上下文、约束动作、运行 Feedback Loops、保存状态和治理 Side Effects 的系统。 | Model、Agent、prompt framework |
| **Feedback Loop** | 执行一个 Slice、观察 Evidence，并决定继续、修订或停止的循环。 | Final review、status update、retry |
| **Boundary** | 对资源、数据、人员、时间、预算、系统或操作声明的限制，在整个 Work Item 中持续生效。 | File path、scope note、suggestion |
| **Side Effect** | 改变外部状态、影响他人、消耗资源、发布信息或难以回滚的动作。 | Tool call、implementation、output |
| **Approval Point** | 执行必须暂停的命名决策点，直到用户批准 exact Side Effect 或契约变化。 | Confirmation、review、general permission |
| **Review** | 将 Deliverable 及其 Evidence 与 approved Work Spec 中每项 Acceptance Criterion 逐条比较。 | Test run、opinion、self-check |
| **Work Mode** | 根据歧义、时长、风险、可恢复性和 Side Effects 所需的最小 Harness 强度。 | Risk level、team size、task type |
| **Specialist Assessment** | Shared Design Concept 和 Slice Plan 已知后，对是否需要额外领域能力或隔离执行作出的显式判断；持久化工作必须说明 `not-needed` 或 `required`。 | Silent default、team size、role list |
| **Capability Need** | 不包含专家 ID、绑定具体 Slice 的能力、领域、用途和隔离需求。 | Expert choice、persona request、job title |
| **Specialist** | Core 根据已声明 Capability Need 从锁定目录中确定性选择的可选领域或方法执行者。 | Mandatory agent、team member、persona |
| **Delegation Contract** | 绑定 Work Item、Work Spec、Slice、expert、范围、交付物和 Evidence requirements 的一次有界子 Agent 授权。 | Prompt、free-form subtask、role assignment |
| **Delegation Receipt** | Host 执行 Delegation Contract 后形成的有界事实记录，只保存状态、摘要、结果哈希和 Evidence pointers。 | Full transcript、self-claim、chat history |
| **Independent Reviewer** | 未参与被审查 Slice 产出，并通过已声明 Deliverable Interface 评价结果的 Specialist 或人。 | Extra implementer、approver、self-reviewer |

## Work modes

| Term | Definition | Aliases to avoid |
| --- | --- | --- |
| **Consult** | 不创建 Work Item 且不产生 Side Effect 的只读回答。 | Quick、analysis task |
| **Quick** | 在一个短 Feedback Loop 中完成的清晰、局部、可逆工作，不创建持久化工作记录。 | Light Spec、unreviewed work |
| **Brief Mode** | 有界 Work Item 的默认持久化模式，需要小型 Brief、Work Spec 和一个或少量 Slices，但不强制组队。 | Light、standard、mini project |
| **Standard Mode** | 跨会话或多 Slice 的 Work Item，需要持久化恢复、明确 Evidence coverage 和风险驱动的 Review。 | Full team、heavy process |
| **Controlled Mode** | 涉及敏感数据、外部 Side Effects、重大影响或有限可逆性的 Work Item，安全准备和每个危险动作拥有独立 Approval Points。 | High-risk bypass、blocked task、blanket approval |

## Relationships

- A **Request** develops into one **Shared Design Concept**, which may be captured in multiple revised **Briefs** before approval.
- One approved **Brief** produces one active **Work Spec** for a **Work Item**.
- A **Work Item** contains one or more ordered **Slices**; each **Slice** must close at least one **Feedback Loop**.
- Every **Acceptance Criterion** must reference at least one piece of **Evidence** before **Review** can complete the **Work Item**.
- A **Deliverable Interface** describes what the user must be able to observe without prescribing the internal implementation.
- A **Project Constitution** uses **Canonical Terms** and **Context Pointers** to guide many Work Items without injecting every source.
- A **Work Journal** belongs to one active Work Item and may inform a final **Decision Record**, but it is not itself long-term project knowledge.
- A **Pattern** can only be promoted from validated **Decision Records** after explicit user approval.
- Every persisted v2 Work Item has a **Specialist Assessment**; `not-needed` requires reasons and `required` produces one or more Slice-bound **Capability Needs**.
- Core selects a **Specialist** only from a known **Capability Need**; the Agent does not submit expert IDs.
- A selected Specialist works through a **Delegation Contract**, and required delegation coverage is incomplete until a matching **Delegation Receipt** exists.
- An **Independent Reviewer** is selected only when the Work Spec's review policy requires one and cannot implement the same Slice.
- A **Side Effect** in **Controlled Mode** requires its own **Approval Point** even when the Work Spec is already approved.

## Example dialogue

> **User:** "帮我检查库存预警为什么不准确，并给出修正方案。"
>
> **Agent:** "我先确认一个会改变结果的术语：这里的 **库存** 是账面库存、可售库存，还是包含在途库存？我建议把预警口径固定为可售库存，并把在途库存作为单独信号。"
>
> **User:** "库存指可售库存，在途库存单列。先看鞋服品类，不要直接改生产规则。"
>
> **Agent:** "明白。我会把这个 **Shared Design Concept** 压缩成 **Brief**：先用鞋服品类完成一个可验证 **Slice**，**Deliverable Interface** 包含口径、异常样本、原因和建议；修改生产规则属于 **Side Effect**，本轮仅准备草案，不执行。你批准后我再开始。"
>
> **User:** "可以。"

## Flagged ambiguities

- “Spec” previously referred both to durable project rules and to a task-specific contract. Use **Project Constitution** for durable rules and **Work Spec** for one approved Work Item.
- “Knowledge” previously covered active progress, completed task records, and reusable guidance. Use **Work Journal**, **Decision Record**, and **Pattern** respectively.
- “Task” previously meant both a whole approved change and a small implementation step. Use **Work Item** for the whole change and **Slice** for a minimal end-to-end unit.
- “Quality Gate” previously mixed an Acceptance Criterion with the command used to check it. Use **Acceptance Criterion** for the expected condition and **Evidence** for the observation.
- “Context” previously meant project rules, source content, conversation history, and task state. Use **Project Constitution**, **Context Pointer**, **Work Journal**, and **Brief** for these distinct concepts.
- “Review” previously implied command-based software verification. Use **Review** only for criterion-by-criterion comparison; command execution is one possible Evidence kind.
- “High risk” previously meant the whole task could not enter implementation. Use **Controlled Mode** to allow safe preparation while keeping every sensitive or irreversible Side Effect behind an Approval Point.
- “Expert team” implied that multiple Agents are the default execution unit. Use **Specialist** and **Independent Reviewer** as optional roles selected only after a concrete need is known.
- “Specialist is optional” must not mean “the assessment may be skipped.” Use **Specialist Assessment** to distinguish an explicit no-Specialist decision from legacy unassessed work.
