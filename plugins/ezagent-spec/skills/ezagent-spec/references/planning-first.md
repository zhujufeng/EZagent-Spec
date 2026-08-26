# Planning-first Work Contract 参考

仅当 Router 已选择 Planning-first 时读取本页。Planning-first 复用 Work Contract v2：规划材料是 `document` Deliverable Interface，规划认可由 `humanCheckpoint` 与 `human-approval` Evidence 兑现，下游实施通过 `blockedBy` 等待该 Slice 被接受。

## 选择与收敛

- 用户点名一种规划材料时只创建该材料；点名多种时可在同一个规划 Slice 中共同交付。
- Router 只是推荐时，把采用理由和文档清单放进同一份 Work Preview，由用户对整份合同一次确认；不要先写业务文档再补合同。
- 优先使用项目已经采用的路径。没有约定时可建议 `docs/prd.md`、`docs/technical-design.md` 和 `docs/implementation-plan.md`，但必须在预览中展示，不能把示例路径当成固定目录。
- Work Preview 批准只允许创建并执行合同；规划 Slice 完成后的 `human-approval` Evidence 才允许实施 Slice 解锁，两次批准不得混为一谈。
- 如果用户只要规划结果，删除实施 Deliverable、实施 Criterion 与实施 Slice，规划 Slice 也不必为了不存在的下游实施强制设置人工闸门。

## Standard 先规划后实施模板

这个模板表示用户明确要求三份规划材料，人工认可后继续本地实施。替换内容和路径时保持字段形状；若项目已有文档目录，必须替换示例中的 `docs/` 路径。

<!-- PLANNING_FIRST_TEMPLATE -->
```json
{
  "schemaVersion": 2,
  "specialistAssessment": {
    "decision": "not-needed",
    "reasons": ["当前协调器具备形成规划材料并按已批准边界实施所需的能力"],
    "needs": []
  },
  "brief": {
    "requestSummary": "先形成 PRD、技术设计和实施计划，人工确认后再编码",
    "intendedOutcome": "获得已确认的规划基线，并据此完成可验证的本地实现",
    "actors": ["需求提出者", "系统维护者", "规划审查者"],
    "canonicalTerms": [
      { "name": "规划基线", "meaning": "获人工认可后约束实施范围与验收方式的文档集合" }
    ],
    "decisions": ["实施必须等待规划 Slice 的人工认可 Evidence"],
    "assumptions": [
      { "statement": "项目没有更优先的文档路径约定", "source": "agent-recommendation", "confirmed": false }
    ],
    "openQuestions": [],
    "sourcePointers": []
  },
  "workSpec": {
    "mode": "standard",
    "outcome": "先交付可审查的规划材料，人工认可后按该基线完成实现",
    "scope": ["形成规划基线", "取得规划成果人工认可", "在认可范围内实施并验证"],
    "nonGoals": ["不执行生产写入、发布或其他真实外部动作", "不在规划认可前开始实施"],
    "deliverableInterfaces": [
      {
        "id": "deliverable-prd",
        "kind": "document",
        "description": "项目约定路径或 docs/prd.md 中供需求提出者审查的 PRD",
        "requiredSections": ["问题与目标", "用户与场景", "范围与非目标", "验收标准"],
        "invariants": ["事实、假设和待确认决策分开表达"],
        "consumer": "需求提出者与系统维护者"
      },
      {
        "id": "deliverable-design",
        "kind": "document",
        "description": "项目约定路径或 docs/technical-design.md 中供实施者使用的技术设计",
        "requiredSections": ["现状与约束", "接口与数据边界", "失败处理", "验证策略"],
        "invariants": ["所有关键设计选择可追溯到 PRD 范围"],
        "consumer": "系统维护者与实施者"
      },
      {
        "id": "deliverable-plan",
        "kind": "document",
        "description": "项目约定路径或 docs/implementation-plan.md 中可逐步执行的实施计划",
        "requiredSections": ["实施切片", "依赖关系", "验证步骤", "回退边界"],
        "invariants": ["每一步都有可观察结果且不超出技术设计"],
        "consumer": "实施者与结果审查者"
      },
      {
        "id": "deliverable-implementation",
        "kind": "code",
        "description": "遵守获批规划基线的本地实现与测试",
        "requiredSections": ["实现", "自动化测试"],
        "invariants": ["不得超出已获认可的规划范围"],
        "consumer": "系统维护者与最终用户"
      }
    ],
    "acceptanceCriteria": [
      {
        "id": "criterion-planning",
        "statement": "三份规划材料覆盖要求的章节，彼此范围一致且路径明确",
        "requiredEvidenceKinds": ["artifact", "comparison"]
      },
      {
        "id": "criterion-planning-approval",
        "statement": "规划审查者明确认可当前文档版本可作为实施基线",
        "requiredEvidenceKinds": ["human-approval"]
      },
      {
        "id": "criterion-implementation",
        "statement": "实现符合获认可的规划基线且关键路径可运行",
        "requiredEvidenceKinds": ["artifact", "command"]
      },
      {
        "id": "criterion-tests",
        "statement": "相关自动化测试通过且没有观察到既有行为回归",
        "requiredEvidenceKinds": ["command", "checklist"]
      }
    ],
    "boundaries": [
      {
        "id": "boundary-local-only",
        "dimension": "operation",
        "rule": "只修改当前项目内获批范围的文件，不执行真实外部动作",
        "resources": []
      }
    ],
    "approvalPoints": [],
    "reviewPolicy": {
      "method": "self",
      "reasons": ["规划 Slice 的人工检查点单独取证，其他结果按 Criterion 逐 Slice 复核"],
      "reviewAfterSlices": 1
    },
    "slicePlan": [
      {
        "id": "slice-planning",
        "title": "形成并确认规划基线",
        "intendedOutcome": "交付范围一致的 PRD、技术设计和实施计划并取得人工认可",
        "inputPointers": [],
        "deliverableInterfaceIds": ["deliverable-prd", "deliverable-design", "deliverable-plan"],
        "criterionIds": ["criterion-planning", "criterion-planning-approval"],
        "blockedBy": [],
        "humanCheckpoint": true
      },
      {
        "id": "slice-implementation",
        "title": "按获认可的基线实施和验证",
        "intendedOutcome": "在规划边界内完成实现并留下可复核测试证据",
        "inputPointers": [],
        "deliverableInterfaceIds": ["deliverable-implementation"],
        "criterionIds": ["criterion-implementation", "criterion-tests"],
        "blockedBy": ["slice-planning"],
        "humanCheckpoint": false
      }
    ]
  }
}
```
