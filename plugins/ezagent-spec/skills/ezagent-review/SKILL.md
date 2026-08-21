---
name: ezagent-review
description: 由已批准团队中的独立审查专家验证 EZagent Spec Task 的实际交付和质量证据；失败返回实现，通过后沉淀结构化知识。
---

# EZagent Review

## 验证证据

先取当前 `SKILL.md` 所在目录，再向上两级得到 `<plugin-root>`，把 `dist/ezagent-cli.mjs` 解析为 `<absolute-cli-path>` 绝对路径；不要在 `PATH` 中搜索其他 EZagent，也不要要求用户输入或运行 CLI。

必须使用支持 argv 数组的进程执行接口，禁止拼接 shell 字符串。每个动态值必须作为一个独立 argv 元素。若宿主只支持 shell 字符串，必须按当前 shell 的 literal 规则完整编码每个参数；无法证明编码正确就关闭失败，不得仅自行添加双引号。

```json
["node", "<absolute-cli-path>", "context", "--root", "<absolute-project-root>", "--json"]
```

任何 gate、返工或状态推进前都应用状态门；kind 或 status 不匹配就关闭失败：

```json
{"stateGuard":{"kind":"task","statuses":["verifying"]}}
```

安全模式只诊断。审查只能委派给当前已批准团队中 mode 为 review 的独立专家，且只能只读检查；不得审查自己参与实现的 Task，也不得临时换人规避角色隔离。委派必须绑定 `Requirement ID`、`Spec ID`、`Task ID`、`expert ID`、`delegation ID`、`scope`、`deliverables` 和 `gates`。

逐项运行 Task 定义的 `gates`，只记录实际执行的命令、环境、结果和必要摘要；未运行、无法运行或证据不足都不得记为 PASS。

任一质量门失败时不得把 Task 标成完成。重新执行 `context`，按以下返工契约使用最新 revision：

```json
{"failureHandoff":{"fromStatus":"verifying","toStatus":"implementing","targetSkill":"ezagent-implement","onTransitionFailure":"fail-closed"}}
```

```json
["node", "<absolute-cli-path>", "transition", "--root", "<absolute-project-root>", "--to", "implementing", "--revision", "<active-work-item-revision>"]
```

高风险 Task 从 verifying 返工不复用、也不需要 planned 首次授权，但返工中的实际危险动作仍须单独授权。transition 失败就关闭失败，不得转入 Implement 或修改代码；成功后才转 `$ezagent-implement`。

全部质量门通过也不能先推进 completed。必须先确认 Knowledge 持久化能力可用，写入结构化 Knowledge（决策、约束、验证证据与后续风险），再由本地核心读回并验证，最后才允许考虑 completed transition。当前插件未打包 Knowledge 持久化命令，因此必须保持 verifying 并关闭失败；绝不能先 completed。不保存聊天全文、完整用户提示或完整专家提示。

```json
{"completion":{"knowledgeRequiredBeforeStatus":"completed","currentKnowledgePersistence":"unavailable","currentAction":"fail-closed","retainedStatus":"verifying"}}
```

每次 `transition` 前都重新执行 `context`；若 `state.activeWorkItem` 为空就不得执行 transition。`--revision` 只取最近一次 `context` JSON 的 `state.activeWorkItem.revision`，绝不得使用 `state.revision`。不得虚构证据、状态或命令。

不得直接编辑 `.ezagent/**`。所有状态变化由本地核心验证。不得自动联网或安装软件，不得自动执行任何 Git 写操作，不得自动发布或上传项目。
