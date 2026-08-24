---
name: ezagent-light
description: 在已初始化项目中完成低风险、局部、可逆且单会话可交付的任意 Quick 请求；使用最多 5 项微计划和相称验证，不创建持久化 Work Item 或专家团队。
---

# EZagent Light

## 入口门

先取当前 `SKILL.md` 所在目录，再向上两级得到 `<plugin-root>`，把 `dist/ezagent-cli.mjs` 解析为 `<absolute-cli-path>` 绝对路径；不要在 `PATH` 中搜索其他 EZagent，也不要要求用户输入或运行 CLI。

必须使用支持 argv 数组的进程执行接口，禁止拼接 shell 字符串。每个动态值必须作为一个独立 argv 元素。若宿主只支持 shell 字符串，必须按当前 shell 的 literal 规则完整编码每个参数；无法证明编码正确就关闭失败，不得仅自行添加双引号。

先读取上下文，确认项目已初始化、没有 active Work Item 且不在安全模式：

```json
["node", "<absolute-cli-path>", "context", "--root", "<absolute-project-root>", "--json"]
```

仅接受 Router 已分类为 `Quick` 的新请求。请求必须目标清楚、低风险、局部、可逆并可在当前会话完成；可以是小型文档、分析、整理或实现，但不得涉及敏感信息、外部写入、发布、预算、生产环境、难回滚决策，编码时也不得涉及迁移、鉴权边界、部署基础设施、公共 API 兼容性或跨模块架构。任一边界不确定就停止 Quick，转回 `$ezagent-spec` 按 `Brief` 或 `Standard` 处理。

## 执行

读取最小必要上下文，形成最多 5 项内部微计划，不再次请求用户批准。只修改请求直接涉及的路径，不调用 `team-select-preview`、`plan-preview`、`plan-apply` 或 `transition`，也不得直接编辑 `.ezagent/**`。

运行与改动相称的聚焦验证，向用户报告实际命令、退出结果和必要摘要。不得虚构命令、状态或结果；验证失败时报告真实状态。执行中一旦发现范围扩大，立即停止后续写入并升级为 `Standard`，不得在扩大后的范围内继续修改。

Quick 不创建 Brief、Work Spec、Work Item、Decision、专家团队或项目级 Agent。任何状态写入都必须由本地核心验证；本 Skill 不执行状态写入。不得自动联网或安装软件，不得自动执行任何 Git 写操作，不得自动发布或上传项目。
