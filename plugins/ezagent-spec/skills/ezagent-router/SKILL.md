---
name: ezagent-router
description: 在已初始化 EZagent Spec 的项目中，自动处理开发、修改、修复、重构、实现、审查或验证请求；解释与只读咨询只回答且不创建工作项。
---

# EZagent Router

## 激活边界

从当前目录向上查找项目根目录。只有找到 `.ezagent/project.yaml` 才进入已初始化工作流；未找到时，普通开发请求不进入 EZagent 工作流，只有用户明确要求启用、初始化或安装 EZagent Spec 才转给 `$ezagent-initialize`。

解释与只读咨询归为 `consult`：直接回答，不创建工作项。已初始化项目中的行为变更再归为 `light`、`standard` 或 `high`；不确定的行为变更默认 `standard`，必要时先澄清。不得保存完整用户提示。

## 读取与路由

先取当前 `SKILL.md` 所在目录，再向上两级得到 `<plugin-root>`，把 `dist/ezagent-cli.mjs` 解析为 `<absolute-cli-path>` 绝对路径；不要在 `PATH` 中搜索其他 EZagent，也不要要求用户输入或运行 CLI。

必须使用支持 argv 数组的进程执行接口，禁止拼接 shell 字符串。每个动态值必须作为一个独立 argv 元素。若宿主只支持 shell 字符串，必须按当前 shell 的 literal 规则完整编码每个参数；无法证明编码正确就关闭失败，不得仅自行添加双引号。

每次相关工作先读取上下文：

```json
["node", "<absolute-cli-path>", "context", "--root", "<absolute-project-root>", "--json"]
```

安全模式只做诊断，不修改项目，不推进状态。`consult` 直接回答；已有已批准 Task 时按状态转 `$ezagent-implement` 或 `$ezagent-review`；新行为变更由 `$ezagent-spec` 进入以下自动规划流程。

## 自动规划与选队

1. 先形成结构化 Plan，至少包含风险等级、目标、范围、非目标、验收、验证、Task、允许路径、依赖、交付物、质量门，以及所需 capabilities、domains、projectSignals 和 `reviewAfter`。信息不足时先澄清。
2. 将该 Plan 作为单个 JSON 文档从进程 stdin 传入，只请求本地核心产生候选团队：

```json
["node", "<absolute-cli-path>", "team-select-preview", "--root", "<absolute-project-root>"]
```

不得直接提交专家 ID，也不得绕过候选结果自行挑选最终专家。根据返回成员的 expert ID 和 mode，为每位候选补齐 scope、deliverables 和 gates；专家应少量且与任务匹配，不固定人数。

3. 将 Plan、selection fingerprint 和 assignments 作为单个 JSON 文档从 stdin 传入，生成只读预览：

```json
["node", "<absolute-cli-path>", "plan-preview", "--root", "<absolute-project-root>"]
```

向用户一次展示 Spec/Plan、候选团队、分工、风险、质量门和所有 blockers。能力未覆盖或缺少独立审查者时关闭失败；超过软阈值时必须取得用户对大团队的明确接受。

4. 用户明确批准这份合并预览后，使用完全相同的 stdin JSON，并传入预览绑定的 token：

```json
["node", "<absolute-cli-path>", "plan-apply", "--root", "<absolute-project-root>", "--approval-token", "<approval-token>"]
```

批准只发生一次；后续相关会话通过 `context` 自动恢复已批准的 Plan、Task 和团队，不重复要求用户手动选专家或再次调用初始化。

5. 若批准后的 `platformSyncStatus` 为 `pending`，先恢复上下文，再调用：

```json
["node", "<absolute-cli-path>", "experts-reconcile", "--root", "<absolute-project-root>"]
```

重新读取上下文并确认 `platformSyncStatus` 为 `ready` 后，才允许进入 implementing；若为 inspection-required 或同步失败，报告可恢复错误并关闭失败。

## 状态约束

每次 `transition` 前都重新执行 `context`；若 `state.activeWorkItem` 为空就不得执行 transition。`--revision` 只取最近一次 `context` JSON 的 `state.activeWorkItem.revision`，绝不得使用 `state.revision`。

```json
["node", "<absolute-cli-path>", "transition", "--root", "<absolute-project-root>", "--to", "<target-status>", "--revision", "<active-work-item-revision>"]
```

不得直接编辑 `.ezagent/**`。所有状态变化由本地核心验证。不得自动联网或安装软件，不得自动执行任何 Git 写操作，不得自动发布或上传项目。
