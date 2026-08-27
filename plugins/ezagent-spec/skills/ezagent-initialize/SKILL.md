---
name: ezagent-initialize
description: 当用户明确要求在当前项目启用、初始化或安装 EZagent Work Harness 时，执行一次性环境检测、经确认补齐受支持的 Node.js、写入预览和本地初始化；若同一请求还包含后续工作，初始化成功后立即交回 EZagent Router。
---

# EZagent Initialize

仅处理用户明确提出的启用请求，不把普通开发请求解释为初始化授权，也不扩展受管路径范围。

先取当前 `SKILL.md` 所在目录，再向上两级得到 `<plugin-root>`，把 `dist/ezagent-cli.mjs` 解析为 `<absolute-cli-path>` 绝对路径；不要在 `PATH` 中搜索其他 EZagent，也不要要求用户输入或运行 CLI。

必须使用支持 argv 数组的进程执行接口，禁止拼接 shell 字符串。每个动态值必须作为一个独立 argv 元素。若宿主只支持 shell 字符串，必须按当前 shell 的 literal 规则完整编码每个参数；无法证明编码正确就关闭失败，不得仅自行添加双引号。

1. 在执行任何 EZagent JavaScript 之前，用系统内置命令检测操作系统：macOS/Linux 使用第一个 argv；Windows 使用第二个 argv 或当前 shell 的等价内置命令。操作系统检测之后，单独用第三个 argv 检测 Node；这些检测不得依赖 EZagent JavaScript。只有输出是可解析的 `v<major>.<minor>.<patch>` 且 major 至少为 22，才通过运行时预检。

```json
["uname", "-s"]
```

```json
["cmd", "/c", "ver"]
```

```json
["node", "--version"]
```

插件内的 CLI 已打包运行时 JavaScript 依赖。普通使用者不得在业务项目运行 `npm install`、`pnpm install`、`yarn install` 或 `bun install` 来准备 EZagent，也不得修改业务项目的 `package.json` 或 lockfile。

Node.js 缺失、版本无法解析或低于 22 时，不得只让用户自行安装或直接结束。必须完整读取 [references/node-bootstrap.md](references/node-bootstrap.md)，按当前操作系统完成只读安装器发现、精确计划、独立批准、安装和复检；用户拒绝或没有可靠安装渠道时保持项目不变。只有复检达到 22 或更高才继续第 2 步。

2. 未初始化时只使用当前宿主明确提供的 workspace root。存在多个 root、嵌套 root 或无法确定时，展示绝对候选并让用户先确认；不得只把 cwd 当项目根。项目名也从这次确认结果中明确取得。

```json
{"projectRootSelection":{"source":"host-workspace-root","ambiguous":"show-absolute-candidates-and-confirm","cwdOnly":false,"projectNameSource":"confirmed-selection"}}
```

3. 预览时逐项展示返回的精确 `paths` 和 `agentsToken`，只预览，不写入：

```json
["node", "<absolute-cli-path>", "integration-preview", "--root", "<absolute-project-root>"]
```

4. 提醒用户在确认前保持项目静默期，尤其不要并发修改 `AGENTS.md`。用户确认后，将确认得到的项目名和原 `agentsToken` 分别作为独立 argv 元素传入：

```json
["node", "<absolute-cli-path>", "integration-init", "--root", "<absolute-project-root>", "--name", "<project-name>", "--agents-token", "<agents-token>"]
```

token 过期时重新预览，绝不覆盖并发修改。

5. `AGENTS.md` 发布不是跨多个文件的原子事务。若 CLI 返回 inspection/recovery/backup 路径，保留证据、展示精确恢复路径并停止，不猜测成功，也不自行删除或覆盖。
6. 初始化成功后核对 CLI 返回的 `continuation`，并把它视为当前任务的工作流边界。重新检查用户的原始请求，区分初始化意图和尚未完成的剩余目标：

- 没有剩余目标时正常结束，并说明新写入的 `AGENTS.md` 会从下一次任务自动生效；以后只需用自然语言描述编码、分析、文档、策划或其他需求，相关请求会自动进入 Router。
- 有剩余目标时，在同一次任务中显式调用 `$ezagent-router`，把完整的剩余目标和已有交付物作为输入交给 Router。不得恢复 `brainstorming`、`writing-plans` 或其他初始化前已经激活的主工作流，也不得在 Router 决策前继续生成计划、代码或文档。
- 若宿主无法在当前任务显式调用 Router，必须停止初始化前的主工作流，说明新生成的项目指令只会在新任务加载，并请用户开启新任务继续剩余目标；不得自行绕过 Router。

初始化批准只授权预览中列出的初始化写入，不是 Work Contract 批准。Router 后续选择 Brief、Standard 或 Controlled 时，`work-preview` 与 `work-apply` 仍遵守各自独立的确认边界。已有设计文档或计划可以作为 `$ezagent-spec` 的输入，不要求从零重做。

这些任务类型只是非穷尽示例，不设置固定人员或岗位。不要增加未在预览中出现的写入范围。

不得直接编辑 `.ezagent/**`。所有状态变化由本地核心验证。不得自动联网或安装软件（用户明确同意后的安装除外），不得自动执行任何 Git 写操作，不得自动发布或上传项目。
