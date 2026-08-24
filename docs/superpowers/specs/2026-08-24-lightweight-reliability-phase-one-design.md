# EZagent Spec 轻量可靠性第一阶段设计

日期：2026-08-24

## 1. 背景

EZagent Spec 已具备本地优先的 Spec、专家团队、执行、审查和知识沉淀闭环，但当前存在三个会直接影响团队采用的问题：

1. 未知 `domains` 或 `projectSignals` 会出现在预览的词汇不匹配中，却仍可通过 `plan-apply` 或 `replan-apply` 落盘。
2. Task 完成只要求若干自由文本 `verificationEvidence`，核心无法确认每个 `qualityGate` 都有对应结果。
3. Router 能识别 `light`，但新行为变更仍进入完整的 Spec、组队、预览和批准流程，小改动的流程成本过高。

本阶段强化可靠性并缩短轻量路径，不引入共享知识库或相关性检索。共享项目知识、经验晋升以及“相关三条加最近两条”的上下文组装属于第二阶段。

## 2. 目标

- 词汇映射错误在任何持久化发生前关闭失败。
- standard Task 只有在所有质量门都有结构化 PASS 回执时才能完成。
- light 请求不创建持久化工作项或专家团队，同时保留明确边界和真实验证。
- 保持 Router 为轻量入口，不复制 Spec、Implement 或 Review 的完整流程。
- 保持已有 Knowledge v1 记录可读。

## 3. 非目标

- 不让核心 CLI 执行任意项目命令。
- 不为 light 请求设计第二套持久化状态机。
- 不新增全局安装器、远程更新、MCP 服务或外部知识同步。
- 不在本阶段修改 Knowledge 检索排序。
- 不承诺结构化回执具有密码学可信来源；它是可机器校验的宿主执行记录，真实性仍由 Review Skill 的工具调用纪律保证。

## 4. 词汇关闭失败

`team-select-preview` 和 `plan-preview` 继续返回 `vocabularyMismatches`，便于 Router 向用户解释输入错误。持久化入口增加统一断言：

- 未知 capability 继续由现有 `capability-uncovered` blocker 处理。
- `domains` 或 `projectSignals` 任一不匹配时，`plan-apply` 拒绝。
- `replan-apply` 使用相同规则拒绝。
- 拒绝发生在 artifact、active experts、审计记录或 workspace revision 写入之前。

错误消息必须区分 `domains` 和 `projectSignals`，但不得回显无边界输入全文。

## 5. 质量门回执

### 5.1 Knowledge v2

新完成请求和新 Knowledge 记录使用 `schemaVersion: 2`。除现有标题、摘要、决策、约束、验证摘要和后续事项外，增加 `qualityGateReceipts`：

```ts
interface QualityGateReceipt {
  gate: string;
  command: string;
  outcome: "passed";
  exitCode: 0;
  summary: string;
}
```

字段全部使用有界、NFC、无控制字符文本。`gate` 必须与 active Task 的一个 `qualityGates` 文本精确匹配；比较在规范化后进行。

### 5.2 完成条件

`completeActiveTask` 在状态转换和写入前验证：

- 每个 Task quality gate 恰好有一个回执。
- 不允许未知 gate、重复 gate 或缺失 gate。
- 所有回执必须是 `outcome: "passed"` 且 `exitCode: 0`。
- 回执验证失败时，Task 保持 `verifying`，专家不清退，Knowledge 不写入，workspace revision 不变化。

`verificationEvidence` 继续作为面向人的简短摘要，不能替代结构化回执。

### 5.3 兼容策略

- Markdown 读取器接受历史 Knowledge v1 和新 Knowledge v2。
- 新完成请求只接受 v2，以避免产生没有 gate 覆盖证明的新记录。
- 新序列化结果始终为规范化 v2 Markdown。
- CLI 和插件示例同步升级，避免旧调用静默降级。

## 6. Light 快速通道

新增 `ezagent-light` Skill，由 Router 在确认请求满足 light 边界后直接转发。它不调用 team selection、plan preview 或 plan apply，也不创建 Requirement、Spec、Task、Knowledge 或项目级 Agent。

### 6.1 允许范围

light 请求必须同时满足：

- 改动局部、可逆且风险低。
- 内部微计划不超过 5 项。
- 不改变依赖、数据模型、迁移、鉴权或安全边界。
- 不改变部署基础设施或破坏公共 API。
- 不需要跨模块架构决策。
- 能通过有限、明确的本地命令验证。

任一条件不满足或无法确认时，Router 自动升级为 standard，进入现有完整工作流。

### 6.2 执行流程

1. 读取最小必要项目上下文。
2. 形成最多 5 项的内部微计划，不要求用户再次批准。
3. 只修改与请求直接相关的路径。
4. 运行与风险相称的专项验证。
5. 向用户报告变更、命令和结果。

light 不强制独立 reviewer，但不得跳过验证或虚构命令结果。若执行中发现范围扩大，停止 light 路径并升级为 standard；不得在已扩大的范围上继续静默修改。

## 7. Router 边界

Router 只保留以下职责：

- 识别项目是否已初始化。
- 将请求分类为 consult、light、standard 或 high。
- 恢复已有 active Task。
- 将 light 转给 `ezagent-light`，将 standard/high 转给现有 Spec 流程。

具体实现、审查和完成规则分别留在对应 Skill 与核心中。项目 `AGENTS.md` 继续只作为指向 Router 的 Bridge Rule，避免多处规则漂移。

## 8. 错误处理和安全性

- 所有新 schema 保持 strict，拒绝额外 key、危险原型、稀疏数组、超预算文本和非法 Unicode。
- 质量回执中的 command 仅作为已经执行的证据文本；核心不得把它交给 shell 执行。
- 所有失败路径必须在 mutation 之前完成验证。
- 插件仍保持离线、本地优先，不新增网络权限。

## 9. 测试与验收

实现严格采用测试先行，但验证次数保持适度：每个行为先运行对应专项测试观察失败，修复后运行同一专项测试观察通过；全部实现结束后只运行一次完整验证和一次插件验证。

验收项：

1. `plan-apply` 对未知 domain 或 project signal 关闭失败且快照不变。
2. `replan-apply` 对相同错误关闭失败且快照不变。
3. v2 Knowledge schema 拒绝缺失、重复、未知或非 PASS 回执。
4. 完成失败保持 active Task、专家、文件和 revision 不变。
5. v1 Knowledge 记录仍可读取，新记录规范化写为 v2。
6. Router 明确把符合边界的请求转给 `ezagent-light`。
7. light Skill 明确升级条件、最多 5 项微计划和真实验证要求。
8. 插件构建包含新 Skill，离线包和激活契约同步更新。
9. `npm run verify`、`npm run plugin:verify` 和 `git diff --check` 通过。

## 10. 发布边界

本阶段作为一个可独立发布、可独立回滚的可靠性版本交付。第二阶段不得在本阶段验收完成前混入。由于完成输入升级为 v2，发布说明必须明确标注 pre-1.0 API 收紧及调用示例变化。
