# Work Contract v2 精确输入契约

生成 `work-preview` 输入时只使用本页字段名和枚举。所有对象都是 strict object，不得增加解释性字段。所有 ID 使用小写 kebab-case；数组按最小必要填写。

## Specialist Assessment

- `decision`: `not-needed` 或 `required`。前者的 `needs` 必须为空；后者至少一个 Need。
- Need 必填：`id`、`sliceId`、`purpose`、`capabilities`、`domains`、`projectSignals`、`isolationReason`。
- `purpose`: `analysis`、`implementation`、`review`。
- `isolationReason`: `domain-judgment`、`context-isolation`、`parallel-work`、`independent-review`。
- `review` 必须搭配 `independent-review`；其他 purpose 不得使用 `independent-review`。
- 不填写 expert ID。不要发明主题专属 capability。优先从稳定通用词表选一个最小能力：后端服务、API、数据库、事务或分布式一致性分析使用 `engineering-backend-architect`；对应的后端代码实施使用 `engineering-senior-developer`；代码或 Evidence 的独立审查使用 `engineering-code-reviewer`。只有无法进一步归类的通用系统分析才使用 `architecture-design`；其他分析可用 `evidence-analysis`、`decision-support` 或 `structured-planning`。只有确实无法归类到稳定专业能力时才使用 `production-implementation`、`workflow-execution`、`quality-review` 或 `evidence-based-review`。
- `domains` 只能使用目录中的稳定领域词。软件系统、服务、API、数据库和工程架构任务使用 `domains: ["engineering"]`，不得自造 `refund-domain`、`distributed-consistency`、`payment-integration` 等主题词；主题细节写进 reasons、Scope、Criterion 和交付接口。
- `projectSignals` 只填写已从项目或目录精确观察到的 kebab-case token；没有精确观察值时使用空数组 `[]`，不得填写自然语言句子或猜测 token。
- 仅要求分析时使用 `analysis`，不要为了将来可能实施而改成 `implementation`。只有用户明确要求实施，或本 Work Item 的 Outcome 本身包含代码、配置、数据或业务资产变更时，才使用 `implementation`。

## Brief 与 Work Spec

- `brief` 精确字段：`requestSummary`、`intendedOutcome`、`actors`、`canonicalTerms[{name,meaning}]`、`decisions`、`assumptions[{statement,source,confirmed}]`、`openQuestions`、`sourcePointers[{kind,locator,purpose}]`。
- assumption source: `user`、`project`、`agent-recommendation`。
- pointer kind: `file`、`document`、`dataset`、`application`、`external-system`、`other`。
- `workSpec` 精确字段：`mode`、`outcome`、`scope`、`nonGoals`、`deliverableInterfaces`、`acceptanceCriteria`、`boundaries`、`approvalPoints`、`reviewPolicy`、`slicePlan`。
- Deliverable kind: `code`、`document`、`analysis`、`dataset`、`visual`、`draft-action`、`other`。
- Evidence kind 只能是：`command`、`artifact`、`checklist`、`comparison`、`citation`、`human-approval`、`external-record`。
- Boundary dimension: `resource`、`data`、`people`、`time`、`budget`、`system`、`operation`。Boundary 顶层始终只有 `id`、`dimension`、`rule`、`resources`，不得在 Boundary 顶层填写 `access`。`access` 只属于 `resources` 中的 resource 元素；非空元素精确形状为 `{kind,locator,purpose,access}`，其中 access 为 `read`、`draft`、`write` 或 `publish`。
- 本地项目内的源码、测试和工作产物读写属于 Work Scope，不是外部 resource；在 Brief/Standard 中用 Scope 与 Boundary rule 约束，并让 `resources` 保持空数组 `[]`。不得把项目根目录伪装成 `application` 或 `external-system` resource 并填写 `access: write`，否则 Core 会正确要求 Controlled Mode 与目标审批点。
- Review method: `self`、`independent-agent`、`human`、`mixed`；`reviewAfterSlices` 固定为 `1`。
- Slice 精确字段：`id`、`title`、`intendedOutcome`、`inputPointers`、`deliverableInterfaceIds`、`criterionIds`、`blockedBy`、`humanCheckpoint`。`inputPointers` 必须是 pointer 对象数组。
- `resources`、`inputPointers`、`sourcePointers` 未知时一律使用空数组 `[]`；不得把它们改成字符串数组或增加未列出的字段。
- 第一个 Slice 的 `blockedBy` 必须为空；每个 Criterion 必须被 Slice 覆盖。`humanCheckpoint: true` 的 Slice 必须覆盖要求 `human-approval` 的 Criterion。

## Standard 分析模板

只替换自然语言文字，保留字段形状与枚举。后端服务、API、数据库、事务或分布式一致性分析保留 `capabilities: ["engineering-backend-architect"]`、`domains: ["engineering"]`、`projectSignals: []`。没有精确观察到来源、资源或 pointer 时，`resources`、`inputPointers`、`sourcePointers` 保持空数组。默认保留一个 tracer Slice；只有存在真实依赖或审批边界时才增加 Slice，不要复制 Capability Need。

<!-- STANDARD_ANALYSIS_TEMPLATE -->
```json
{
  "schemaVersion": 2,
  "specialistAssessment": {
    "decision": "required",
    "reasons": ["跨接口与数据边界的分析需要隔离的系统设计判断"],
    "needs": [
      {
        "id": "need-analysis",
        "sliceId": "slice-tracer",
        "purpose": "analysis",
        "capabilities": ["engineering-backend-architect"],
        "domains": ["engineering"],
        "projectSignals": [],
        "isolationReason": "domain-judgment"
      }
    ]
  },
  "brief": {
    "requestSummary": "按项目流程分析一个跨接口与数据边界的需求",
    "intendedOutcome": "形成可复核的现状、方案边界和验证建议",
    "actors": ["需求提出者", "系统维护者", "结果审查者"],
    "canonicalTerms": [
      { "name": "业务意图", "meaning": "需要在重复或并发请求中保持一致的逻辑操作" }
    ],
    "decisions": ["本轮只分析并形成决策材料，不执行生产或外部动作"],
    "assumptions": [
      { "statement": "源码发现可在首个 Slice 中完成", "source": "agent-recommendation", "confirmed": false }
    ],
    "openQuestions": [],
    "sourcePointers": []
  },
  "workSpec": {
    "mode": "standard",
    "outcome": "形成有证据支撑的跨边界需求分析与验证建议",
    "scope": ["定位相关接口与数据边界", "比较候选方案并记录风险"],
    "nonGoals": ["不修改代码、生产数据或外部系统"],
    "deliverableInterfaces": [
      {
        "id": "deliverable-analysis",
        "kind": "analysis",
        "description": "一份供系统维护者审查的需求分析",
        "requiredSections": ["现状", "边界", "候选方案", "风险", "验证建议"],
        "invariants": ["事实、假设和建议分开表达"],
        "consumer": "系统维护者与结果审查者"
      }
    ],
    "acceptanceCriteria": [
      {
        "id": "criterion-boundaries",
        "statement": "相关接口、数据状态和外部边界均有可追溯说明",
        "requiredEvidenceKinds": ["artifact", "citation"]
      },
      {
        "id": "criterion-options",
        "statement": "候选方案按一致性、失败恢复和验证方式完成比较",
        "requiredEvidenceKinds": ["artifact", "comparison"]
      }
    ],
    "boundaries": [
      {
        "id": "boundary-read-only",
        "dimension": "operation",
        "rule": "本 Work Item 只读分析，不执行真实外部动作",
        "resources": []
      }
    ],
    "approvalPoints": [],
    "reviewPolicy": {
      "method": "self",
      "reasons": ["当前只形成分析材料，按 Criterion 逐 Slice 复核"],
      "reviewAfterSlices": 1
    },
    "slicePlan": [
      {
        "id": "slice-tracer",
        "title": "建立端到端边界与方案基线",
        "intendedOutcome": "用最小证据路径形成可审查的现状与候选方案比较",
        "inputPointers": [],
        "deliverableInterfaceIds": ["deliverable-analysis"],
        "criterionIds": ["criterion-boundaries", "criterion-options"],
        "blockedBy": [],
        "humanCheckpoint": false
      }
    ]
  }
}
```
