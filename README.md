# EZagent Spec

EZagent Spec 是公司内部使用、Local-only 的中文 Spec Coding 工具。它希望把需求、Spec、任务、知识和质量记录保存在项目内，让开发工作跨会话仍有可恢复的结构化上下文。

当前完成的是本地 core。仓库内的 CLI 是供后续插件调用的内部集成接口；Codex 插件、自然语言路由和初始化后的自动触发尚未实现，将在后续 milestone 完成。当前不能把 CLI 当作最终同事安装体验。

## 本地 core 开发

要求 Node.js 22 或更新版本。开发者可执行：

```bash
npm ci
npm run verify
npm run build
```

Node.js 目前既是本地 core 的运行前置，也是本仓库的开发前置。面向普通同事的 Node.js 检测和安装引导属于后续插件 milestone；目前不要假设同事电脑已经具备运行条件。

## CLI

所有平台都可以显式使用 Node.js 启动构建产物：

```bash
node dist/src/cli/main.js doctor --root .
node dist/src/cli/main.js init --root . --name "Demo"
node dist/src/cli/main.js context --root . --json
node dist/src/cli/main.js transition --root . --to clarifying --revision 0
```

`init` 是对目标项目执行的一次显式初始化；相同配置可安全重试。`transition` 仅在工作区已有 active work item 时可用，`--revision` 必须等于该 work item 当前的 revision。

macOS/Linux 构建后也可以直接执行 CLI：

```bash
./dist/src/cli/main.js doctor --root .
./dist/src/cli/main.js context --root . --json
```

构建脚本通过 Node.js 设置 POSIX 执行位；Windows 不依赖 POSIX 执行位，统一的 `node dist/src/cli/main.js ...` 方式可用。包内已声明 `ezagent` bin，供 npm 在安装产物时生成对应的平台启动入口（包括 Windows shim）。

成功结果是单行 JSON 并以状态码 `0` 退出。错误写入单行 stderr、不输出堆栈，并以非零状态码退出。

## 项目内数据

初始化会在目标项目创建 `.ezagent/`，主要内容包括：

- `project.yaml`：项目配置；CLI 初始化时 `gitTracking` 默认为 `none`。
- `state/`：当前状态投影，以及写锁和未完成 mutation 标记等短期事务证据。
- `requirements/`、`specs/`、`tasks/`、`knowledge/`、`experts/`、`quality/`：结构化工作产物的本地目录。
- `audit/events.jsonl`：按 revision 连续追加的审计事件。
- `backups/`：恢复过程中保留损坏状态投影的本地备份。

每次成功 mutation 会将 revision 增加 `1`，并先记录可恢复的事务/审计证据，再发布状态投影。如果状态投影损坏但审计链有效，`context` 会从审计记录恢复上下文并报告 `recovered`。无法信任关键证据时，core 会进入或返回 safe mode；safe mode 禁止继续 mutation，避免在不确定状态上写入。

## Local-only 与隐私边界

EZagent runtime 不会自动访问网络、发送遥测、执行 Git commit/push，也不会上传用户项目。CLI 初始化默认使用 `gitTracking: none`；是否跟踪本地产物仍由用户和后续策略明确决定。

Local-only 只描述 EZagent 自身的运行边界，不改变 Codex 的模型处理、账号、组织策略或数据保留方式。公司仍需按自己的 Codex 管理策略使用产品。`npm ci` 等开发命令可能访问包注册表，这不属于 EZagent runtime 行为。

## Trellis 边界

本项目受结构化 Spec Coding 原则启发，独立实现自己的本地数据模型和工作流。当前 runtime、源码与构建依赖不包含 Trellis 运行时、代码或模板，也不通过调用 Trellis 来工作。
