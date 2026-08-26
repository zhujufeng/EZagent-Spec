---
name: ezagent-context
description: 在已初始化 EZagent 项目中检索轻量 Decision 与 Pattern 摘要、显式启用或更新共享上下文，并把用户批准的可复用经验晋升为团队 Pattern。
---

# EZagent Context

## 入口与执行边界

先取当前 `SKILL.md` 所在目录，再向上两级得到 `<plugin-root>`，把 `dist/ezagent-cli.mjs` 解析为 `<absolute-cli-path>` 绝对路径；不要在 `PATH` 中搜索其他 EZagent，也不要要求用户输入或运行 CLI。

必须使用支持 argv 数组的进程执行接口，禁止拼接 shell 字符串。每个动态值必须作为一个独立 argv 元素。若宿主只支持 shell 字符串，必须按当前 shell 的 literal 规则完整编码每个参数；无法证明编码正确就关闭失败，不得仅自行添加双引号。

所有需要 JSON 输入的命令默认使用可关闭的非交互 stdin pipe，并在写入一个 JSON 文档后明确发送 EOF。若宿主进程接口使用 PTY，无法可靠关闭 stdin EOF，禁止继续等待、后台运行或盲目重试 mutation；改用宿主文件能力把完全相同的 JSON 写入一个新建、权限受限的临时普通文件。临时文件必须位于操作系统临时目录且在项目根目录之外，不得位于 `<absolute-project-root>`、`.ezagent/**` 或任何业务文件目录；再把 `--input-file` 和该文件的绝对路径作为两个独立 argv 元素传给原命令。不得使用符号链接，不得使用 shell 输入重定向。预览与 Apply 必须读取完全相同的文件和字节；Apply 完成、用户拒绝或流程终止后删除临时文件。

先恢复项目上下文：

```json
["node", "<absolute-cli-path>", "context", "--root", "<absolute-project-root>", "--json"]
```

未初始化时转 `$ezagent-initialize`；安全模式或 inspection-required 时只报告诊断，不修改项目。不得直接编辑 `.ezagent/**`，所有状态写入必须由本地核心验证。

## 检索相关知识

从当前 Outcome、Canonical Terms、Boundaries、capabilities、domains 和 projectSignals 形成少量短 terms；把 terms 作为一个 JSON 文档从 stdin 传入，不传完整用户提示或聊天：

```json
["node", "<absolute-cli-path>", "knowledge-context", "--root", "<absolute-project-root>"]
```

只把核心返回的最多 5 条摘要和路径作为只读上下文。先依据摘要判断相关性，只在当前任务确有需要时按 path 读取完整记录；不得扫描或注入全部 Knowledge。评分、排序、去重和输入预算全部由本地核心负责，本 Skill 不复制这些规则。

## 显式共享项目上下文

用户要求启用团队共享或更新项目上下文时，只整理小型项目摘要、团队术语、稳定约束和项目内来源指针；不得复制完整文档。将同一个 ProjectContext JSON 文档从 stdin 传给预览：

```json
["node", "<absolute-cli-path>", "sharing-preview", "--root", "<absolute-project-root>"]
```

展示目标 `gitTracking`、写入路径、共享范围和排除范围。只有用户明确批准该预览后，才用完全相同的 stdin JSON 和预览 token 执行 Apply：

```json
["node", "<absolute-cli-path>", "sharing-apply", "--root", "<absolute-project-root>", "--approval-token", "<approval-token>"]
```

对这一 mutation 只请求一次批准。Apply 成功后说明建议由团队自己的 Git 流程提交哪些 artifacts；EZagent 不执行任何 Git 操作，也不修改 `.gitignore`。

## 晋升团队 Pattern

只有用户明确要求把已有 Decision 沉淀为团队经验时才形成精简的 Pattern 草案；保留来源 Work Spec，提炼标题、摘要、tags、guidance 和 constraints，不复制回执、测试输出、聊天或完整原文。旧版 Task Knowledge 仍可作为兼容来源。先把草案作为单个 JSON 文档从 stdin 传入：

```json
["node", "<absolute-cli-path>", "knowledge-promote-preview", "--root", "<absolute-project-root>"]
```

向用户展示来源、目标路径、内容哈希和规范化 Pattern。只有用户明确批准该预览后，才用完全相同的 stdin JSON 和 token 执行 Apply：

```json
["node", "<absolute-cli-path>", "knowledge-promote-apply", "--root", "<absolute-project-root>", "--approval-token", "<approval-token>"]
```

对这一 mutation 只请求一次批准。来源漂移、token 失效、Pattern 已存在或 `gitTracking` 不是 `artifacts` 时关闭失败，不覆盖或删除已有 Pattern。

不得自动联网或安装软件，不得自动执行任何 Git 写操作，不得自动发布或上传项目。
