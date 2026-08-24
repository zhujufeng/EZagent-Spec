---
name: ezagent-light
description: 在已初始化项目中执行经 Router 确认为低风险、局部且可逆的轻量行为修改；使用最多 5 项微计划和聚焦验证，不创建持久化工作项或专家团队。
---

# EZagent Light

## 入口门

先取当前 `SKILL.md` 所在目录，再向上两级得到 `<plugin-root>`，把 `dist/ezagent-cli.mjs` 解析为 `<absolute-cli-path>` 绝对路径；不要在 `PATH` 中搜索其他 EZagent，也不要要求用户输入或运行 CLI。

必须使用支持 argv 数组的进程执行接口，禁止拼接 shell 字符串。每个动态值必须作为一个独立 argv 元素。若宿主只支持 shell 字符串，必须按当前 shell 的 literal 规则完整编码每个参数；无法证明编码正确就关闭失败，不得仅自行添加双引号。

先读取上下文，确认项目已初始化、没有 active Task 且不在安全模式：

```json
["node", "<absolute-cli-path>", "context", "--root", "<absolute-project-root>", "--json"]
```

仅接受 Router 已分类为 `light` 的新行为变更。请求必须低风险、局部、可逆，并且不涉及依赖、数据模型、迁移、鉴权或安全边界、部署基础设施、公共 API 兼容性或跨模块架构。任一边界不确定就停止 light，转回 `$ezagent-spec` 按 `standard` 处理。

## 执行

读取最小必要上下文，形成最多 5 项内部微计划，不再次请求用户批准。只修改请求直接涉及的路径，不调用 `team-select-preview`、`plan-preview`、`plan-apply` 或 `transition`，也不得直接编辑 `.ezagent/**`。

运行与改动相称的聚焦验证，向用户报告实际命令、退出结果和必要摘要。不得虚构命令、状态或结果；验证失败时报告真实状态。执行中一旦发现范围扩大，立即停止后续写入并升级为 `standard`，不得在扩大后的范围内继续修改。

light 不创建 Requirement、Spec、Task、Knowledge、专家团队或项目级 Agent。任何状态写入都必须由本地核心验证；本 Skill 不执行状态写入。不得自动联网或安装软件，不得自动执行任何 Git 写操作，不得自动发布或上传项目。
