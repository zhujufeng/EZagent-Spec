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

读取上下文使用：

```json
["node", "<absolute-cli-path>", "context", "--root", "<absolute-project-root>", "--json"]
```

先读取上下文：

- 安全模式只做诊断，不修改项目，不推进状态。
- `consult` 直接回答；需要形成或批准规格时转 `$ezagent-spec`，只执行已批准且已规划任务时转 `$ezagent-implement`，验证与质量收口时转 `$ezagent-review`。
- 无 `state.activeWorkItem` 时，当前打包 CLI 没有 `capture`/`plan` 命令；只能转 `$ezagent-spec` 形成结构化草案并关闭失败，不得声称工作项已创建。
- 每次 `transition` 前都重新执行 `context`；若 `state.activeWorkItem` 为空就不得执行 transition。`--revision` 只取最近一次 `context` JSON 的 `state.activeWorkItem.revision`，绝不得使用 `state.revision`。
- 状态推进只能使用打包 CLI 当前支持的 `transition`，并保持每个值为独立 argv 元素：

```json
["node", "<absolute-cli-path>", "transition", "--root", "<absolute-project-root>", "--to", "<target-status>", "--revision", "<active-work-item-revision>"]
```

若所需能力尚未打包，明确报告并关闭失败，不得发明 requirement/spec/task 命令。

不得直接编辑 `.ezagent/**`。所有状态变化由本地核心验证。不得自动联网或安装软件，不得自动执行任何 Git 写操作，不得自动发布或上传项目。
