# EZagent Spec 共享上下文与知识晋升设计

- 状态：已批准
- 日期：2026-08-24
- 阶段：轻量化优化第二阶段

## 1. Objective

为使用 EZagent 的团队提供轻量、可审查、可版本控制的项目上下文，同时避免把聊天记录、完整文档或全部历史 Knowledge 注入每次 Agent 会话。

本阶段解决三个问题：

1. 项目背景、术语、架构入口和稳定约束缺少团队共享的事实来源。
2. Task Knowledge 都停留在本地决策记录中，没有“候选经验 → 人工确认 → 团队 Pattern”的晋升路径。
3. `context` 当前只返回最近 5 条 Knowledge，时间近不等于与当前任务相关。

成功体验是：同事不需要搬运上下文或记忆命令；Agent 读取一个小型项目索引，按当前任务选择最多 3 条相关知识并补充最多 2 条近期决策。只有用户明确批准的经验才会成为团队 Pattern。

## 2. 已确认假设

- 默认 `gitTracking: none` 保持不变。
- 团队共享必须显式启用 `gitTracking: artifacts`。
- EZagent 只写本地文件，不执行 `git add`、commit、push 或 PR。
- 共享内容只包括项目索引、Spec、Task、Knowledge 和晋升后的 Pattern；不包括聊天全文、审计、备份、运行缓存或完整测试输出。
- 检索完全本地、确定性、无网络、无 embedding、无向量数据库、无新增依赖。
- 经验晋升使用预览和一次用户批准，不允许 Review Skill 自动发布 Pattern。

## 3. Tech Stack 与 Commands

保持现有技术栈：Node.js 22、TypeScript 7、Zod 4、YAML、Markdown、Vitest 3 和 esbuild。不得增加运行时或开发依赖。

开发验证命令：

```bash
npm run check
npx vitest run test/workflow/project-context.test.ts test/workflow/knowledge-selection.test.ts
npx vitest run test/workflow/knowledge-promotion.test.ts test/cli/main.test.ts
npx vitest run test/codex/activation-contract.test.ts test/codex/skill-contract.test.ts
npm run verify
npm run plugin:verify
```

插件内部新增命令，普通用户不需要手动输入：

```json
["node", "<absolute-cli-path>", "sharing-preview", "--root", "<absolute-project-root>"]
["node", "<absolute-cli-path>", "sharing-apply", "--root", "<absolute-project-root>", "--approval-token", "<approval-token>"]
["node", "<absolute-cli-path>", "knowledge-context", "--root", "<absolute-project-root>"]
["node", "<absolute-cli-path>", "knowledge-promote-preview", "--root", "<absolute-project-root>"]
["node", "<absolute-cli-path>", "knowledge-promote-apply", "--root", "<absolute-project-root>", "--approval-token", "<approval-token>"]
```

动态输入继续通过一个有界 JSON 文档从 stdin 传入，不拼接 shell 字符串。

## 4. Project Structure

新增和使用以下项目文件：

```text
.ezagent/
├── project.yaml                         # gitTracking 策略
└── knowledge/
    ├── project.yaml                     # 小型项目上下文索引
    ├── decisions/SPEC-*.md              # 本地 Task Knowledge
    └── patterns/SPEC-*.md               # 人工批准的团队 Pattern
```

源码职责：

```text
src/workflow/project-context.ts           # 项目索引 schema、序列化与路径
src/workflow/knowledge-pattern.ts         # Pattern schema、序列化与路径
src/workflow/knowledge-selection.ts       # 3+2 确定性选择算法
src/workflow/service.ts                   # 预览/批准、原子 mutation 和上下文组装
src/workflow/resume-context.ts            # 对外的小型上下文结果类型
src/cli/main.ts                           # 新命令的 argv 与 stdin 边界
plugins/.../skills/ezagent-context/       # 共享设置、检索和经验晋升工作流
```

不得把检索、Pattern schema 或项目上下文 schema 继续堆进已经较大的 `service.ts`；service 只负责编排和 mutation。

## 5. Project Context Schema

`.ezagent/knowledge/project.yaml` 使用严格 schema：

```ts
interface ProjectContext {
  readonly schemaVersion: 1;
  readonly summary: string;
  readonly terms: readonly {
    readonly name: string;
    readonly meaning: string;
  }[];
  readonly constraints: readonly string[];
  readonly sources: readonly {
    readonly path: string;
    readonly purpose: string;
  }[];
}
```

设计原则：

- `summary` 只描述项目用途和主要边界，不复制 README。
- `terms` 只保存团队特有、容易误解的业务术语。
- `constraints` 保存稳定架构或编码约束，不保存临时 Task 要求。
- `sources` 使用项目内可移植相对路径和一句用途说明；不复制文档正文。
- 每个列表最多 32 项，单项文本和整份文件都有 UTF-8 字节预算。
- 路径拒绝绝对路径、反斜杠、空组件、`.`、`..`、Windows 设备名和控制字符。
- 文件缺失不是错误，返回 `projectContext: null`；文件损坏则进入 inspection-required，不能静默忽略。

项目索引是 context-engineering 的 Level 2 指针层。Agent 只在当前任务需要时读取 `sources` 指向的具体文件。

## 6. 显式团队共享

### 6.1 Preview

`sharing-preview` 输入完整 `ProjectContext`，只读返回：

- 当前和目标 `gitTracking`。
- 将写入的路径。
- 明确的共享/排除边界。
- 绑定 workspace revision、当前 project config、ProjectContext 内容和项目根 identity 的 approval token。

只允许：

```text
none → artifacts
artifacts → artifacts（更新项目索引）
```

不在本阶段自动支持降级为 `none` 或升级为 `all`，避免隐藏已经共享的事实或扩大共享范围。

### 6.2 Apply

`sharing-apply` 使用完全相同输入和 token，在一次 workspace mutation 中：

- 将 `project.yaml` 的 `gitTracking` 设置为 `artifacts`。
- 写入或更新 `knowledge/project.yaml`。
- 推进 workspace revision 并写入不含项目正文的审计元数据。

它不修改 `.gitignore`，也不执行 Git 命令。Skill 只向用户列出建议跟踪和排除的路径，由团队自己的 Git 流程处理。

## 7. Knowledge Pattern 晋升

Pattern 使用来源 Spec ID 作为稳定文件名，每条 Task Knowledge 最多晋升一次：

```ts
interface KnowledgePattern {
  readonly schemaVersion: 1;
  readonly sourceSpecId: string;
  readonly sourceTaskId: string;
  readonly title: string;
  readonly summary: string;
  readonly tags: readonly string[];
  readonly guidance: readonly string[];
  readonly constraints: readonly string[];
  readonly sourceKnowledgeHash: `sha256:${string}`;
}
```

### 7.1 Preview

`knowledge-promote-preview` 输入：

```ts
interface KnowledgePromotionDraft {
  readonly schemaVersion: 1;
  readonly sourceSpecId: string;
  readonly title: string;
  readonly summary: string;
  readonly tags: readonly string[];
  readonly guidance: readonly string[];
  readonly constraints: readonly string[];
}
```

核心读取并验证来源 Knowledge，补齐 `sourceTaskId` 和内容哈希，返回规范化 Pattern、目标路径和 approval token。预览不写磁盘。

### 7.2 Apply

Apply 必须满足：

- workspace 为 `gitTracking: artifacts`。
- token、workspace revision、来源 Knowledge hash 和 Pattern 内容完全匹配。
- 目标 Pattern 不存在。
- 来源 Knowledge 是可读取的规范 v1 或 v2 记录。

成功后原子写入 Pattern、推进 revision 并记录摘要 hash。任何失败都不写 Pattern、不推进 revision。Pattern 不保存验证命令、回执、聊天内容或完整原始 Knowledge。

## 8. “相关 3 条＋最近 2 条”检索

`knowledge-context` 输入短查询词，而不是完整用户提示：

```ts
interface KnowledgeContextQuery {
  readonly schemaVersion: 1;
  readonly terms: readonly string[];
}
```

- 最多 16 个 term，每项最多 128 字符，总输入最多 8 KiB。
- Router 从 Task 标题、目标、capabilities、domains 和 projectSignals 生成 terms。
- terms 只用于当前进程选择，不写磁盘、不进入审计。

### 8.1 确定性相关度

使用现有 Unicode 规范化和 case folding。每个 term 独立计分：

```ts
tag 完全匹配              +4
title 包含 term           +3
summary 包含 term         +2
guidance/decision/constraint 包含 term  +1
```

- 分数必须大于 0 才属于 relevant。
- 分数降序；同分时 Pattern 优先于 Decision，再按 source Spec ID 的可移植顺序降序。
- relevant 最多 3 条。
- recent 只从 Decision 中按 Spec ID 降序选择，排除已经相关命中的 source Spec ID，最多 2 条。
- 不足时不使用无关记录填满配额。
- 结果最多 5 条且 source Spec ID 唯一。

输出每条只包含 source、path、title、summary、contentHash 和 relevanceScore；不直接返回完整正文。Agent 根据项目索引和选中 path 按需读取具体内容。

## 9. Router 与 Skill

新增 `ezagent-context` Skill，职责仅限：

- 显式启用或更新团队共享项目索引。
- 使用短 terms 调用 `knowledge-context`。
- 展示 Pattern 晋升预览并取得一次用户批准。
- Apply 后提示用户由自己的 Git 流程提交 artifacts。

Router 保持 Bridge Rule：

- 新任务在形成短目标和 selection terms 后调用 `knowledge-context`。
- 将最多 5 条摘要作为 Plan 的只读输入，不复制完整 Knowledge。
- 用户提出“启用团队共享、更新项目上下文、沉淀为团队经验”时转 `$ezagent-context`。
- Router 不复制 schema、评分或审批规则。

## 10. Code Style

遵循现有严格解析、不可变返回、确定性排序和单一事实来源风格：

```ts
export function selectKnowledge(
  query: KnowledgeContextQuery,
  candidates: readonly KnowledgeCandidate[],
): KnowledgeSelection {
  const terms = parseKnowledgeContextQuery(query).terms;
  const ranked = candidates
    .map((candidate) => ({ candidate, score: relevanceScore(candidate, terms) }))
    .filter(({ score }) => score > 0)
    .sort(compareRankedKnowledge);
  return freezeKnowledgeSelection(buildThreePlusTwo(ranked, candidates));
}
```

要求：

- 对外输入全部使用 strict Zod schema。
- 验证预算后再分配或读取大集合。
- 使用可移植 code-unit 排序，不依赖 locale。
- 返回对象和嵌套数组全部冻结。
- Preview 只读；Apply 在 mutation 前完成所有验证。
- 不用时间、随机数或模型生成结果参与检索排序。

## 11. Testing Strategy

严格 TDD，但不过度重复验证：每个行为先运行一个聚焦测试观察失败，再实现并运行同一聚焦测试观察通过；全部任务结束后各运行一次 `npm run verify` 和 `npm run plugin:verify`。

测试层级：

- Unit：ProjectContext/Pattern/Query schema、Unicode、预算、路径和规范序列化。
- Unit：评分、排序、Pattern 优先、去重、相关不足和 recent 补充。
- Workflow：sharing preview/apply token、revision、原子失败和 safe mode。
- Workflow：promotion preview/apply、来源 hash 漂移、重复 Pattern 和 gitTracking gate。
- CLI：有界 stdin、approval token 绑定和 JSON 输出。
- Plugin：新 Skill 打包、Router handoff、离线和无网络权限。
- Compatibility：缺少项目索引仍可工作；历史 Knowledge v1/v2 均可参与选择和晋升。

## 12. Boundaries

### Always

- 保持默认 `gitTracking: none`。
- 共享启用和 Pattern 晋升都先预览、后一次批准。
- 只把短 terms、摘要和路径加入上下文。
- 对损坏的共享事实关闭失败并提供 inspection blocker。
- 在提交每个逻辑切片前运行对应聚焦测试。

### Ask First

- 改变共享内容范围。
- 修改 Git ignore 或执行任何 Git 写操作。
- 引入外部检索服务、embedding、数据库或依赖。
- 允许 Pattern 覆盖或删除。
- 支持 `artifacts → none/all` 迁移。

### Never

- 保存完整用户提示、聊天记录或专家提示。
- 自动把 Task Knowledge 晋升为 Pattern。
- 自动提交、推送或上传 artifacts。
- 为凑满 3 条 relevant 返回零分记录。
- 把完整项目文档或全部 Knowledge 注入每次上下文。

## 13. Success Criteria

1. 默认初始化仍得到 `gitTracking: none`。
2. 只有带有效 token 的 `sharing-apply` 能切换到 artifacts 并原子写入项目索引。
3. ProjectContext 只保存摘要、术语、约束和项目内来源指针。
4. `knowledge-context` 在相同输入和文件集下逐字节稳定。
5. 选择结果最多 3 条正分 relevant 和最多 2 条去重 recent，不足时不填充。
6. 查询 terms 不持久化、不进入审计。
7. Pattern 必须由现有 Knowledge 经 preview/apply 晋升，来源 hash 漂移时拒绝。
8. Pattern 不包含验证回执、聊天或完整原始 Knowledge。
9. v1/v2 Knowledge 继续可读并可参与相关性选择。
10. Router 只传递短 terms 和最多 5 条摘要，不复制评分规则。
11. 插件仍无新增依赖、网络权限或自动 Git 写入。
12. 聚焦测试、`npm run verify`、`npm run plugin:verify` 和 `git diff --check` 通过。

## 14. Open Questions

无。共享默认值、隐私边界、晋升审批和检索方式已由用户确认。
