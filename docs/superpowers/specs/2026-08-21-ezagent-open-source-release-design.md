# EZagent Spec 开源发布设计

> **发布更新（2026-08-22）：** v0.1.0 安装固定到不可变 tag，标准 Task 已闭合 Knowledge/Finish，高风险 Task 实施明确不支持。本文较早的能力状态描述仅作为发布决策历史。

日期：2026-08-21
状态：已完成自审，待用户书面确认

## 1. 目标

将 `zhujufeng/EZagent-Spec` 从公司内部私有仓库转换为可公开审阅、可通过 GitHub repo marketplace 安装的 Codex 插件项目。公开后的主要安装体验是：用户把 GitHub 地址交给 Agent，Agent 在获得联网和全局配置写入授权后完成 marketplace 与插件安装；每个业务项目仍只需初始化一次，后续通过自然语言自动进入 EZagent Router。

本次发布不提交 Codex 通用公共插件目录，不发布 npm 包，也不改变 EZagent 的 Local-only、无遥测、无自动 Git 写入和无自动上传边界。

## 2. 已确认决策

- 项目采用 MIT License，项目版权主体写作 `EZagent Contributors`。
- 公开 marketplace 名称从 `ezagent-spec-internal` 改为 `ezagent`。
- 插件名称保持 `ezagent-spec`，安装选择器为 `ezagent-spec@ezagent`。
- GitHub 仓库保持 `zhujufeng/EZagent-Spec`，默认分支保持 `main`。
- `package.json` 保留 `"private": true`，防止意外发布到 npm；同时增加 `"license": "MIT"`。
- GitHub repo marketplace 是首个公开分发渠道；Codex 通用公共插件目录提交不在本次范围。

## 3. 分发与安装体验

### 3.1 面向人的安装方式

README 在首屏提供以下命令：

```bash
codex plugin marketplace add zhujufeng/EZagent-Spec --ref main
codex plugin add ezagent-spec@ezagent
```

安装后必须新建 Codex 任务，再在目标项目中说“在当前项目启用 EZagent Spec”。README 同时说明 Node.js 22+ 前置条件、macOS/Windows 支持状态、升级命令和卸载路径。

### 3.2 面向 Agent 的安装方式

README 提供一段可直接复制给 Agent 的中文提示。提示要求 Agent：

1. 读取仓库 README 与插件清单。
2. 检查 Codex CLI 与 Node.js 22+。
3. 在联网、安装 Node 或修改 Codex 全局配置前取得用户明确同意。
4. 使用 argv 安全执行 marketplace 和 plugin 安装命令。
5. 安装后提醒用户新建任务，不在旧任务中声称 Skills 已加载。

Agent 不得静默安装 Node.js，不得把安装插件解释为初始化任意业务项目的授权。

### 3.3 Marketplace 结构

仓库继续使用 `.agents/plugins/marketplace.json` 和 `plugins/ezagent-spec/`。marketplace 的 `source.path` 保持 `./plugins/ezagent-spec`，因为它相对于 marketplace 根目录解析。只修改 marketplace 的公开名称和展示名称，不增加未实现的 MCP、Hook、App 或认证声明。

## 4. 开源许可证与第三方边界

仓库根新增标准 MIT `LICENSE`，年份为 2026，版权主体为 `EZagent Contributors`。以下元数据同步为 MIT：

- 根 `package.json`
- `plugins/ezagent-spec/.codex-plugin/plugin.json`
- README 的许可证段落

插件构建必须把根 `LICENSE` 复制到 `plugins/ezagent-spec/LICENSE`，并由确定性构建测试验证内容完全一致。这样从 marketplace 安装得到的独立插件缓存仍携带项目许可证，而不依赖用户同时保留仓库根目录。

Agency Agents 英文目录和中文翻译目录继续作为 MIT 许可的第三方材料处理，保留：

- `THIRD_PARTY_NOTICES.md`
- `licenses/agency-agents-MIT.txt`
- `licenses/agency-agents-zh-MIT.txt`
- 每条专家记录的来源仓库、Commit SHA、许可证与内容哈希

Trellis 的 AGPL-3.0 代码、模板、CLI 和运行时不进入本仓库。README 可以说明产品受到结构化 Spec 工作流思想启发并链接 Trellis，但必须继续明确这是独立实现，不宣称格式或运行时兼容。

## 5. 公开仓库文档

README 从“公司内部安装说明”改成公开项目首页，至少包含：

- 产品定位与当前 MVP 能力边界
- GitHub marketplace 安装、Agent 安装提示、升级和卸载
- 每项目一次性初始化及后续自动触发说明
- Node.js 22+、Codex 支持面和 macOS/Windows CI 状态
- Local-only 与 Codex 自身通信边界
- 第三方来源、Trellis 独立实现声明和 MIT License
- 开发、测试和贡献入口

新增：

- `CONTRIBUTING.md`：开发环境、验证命令、PR 要求、许可证贡献约定
- `SECURITY.md`：私下报告漏洞的方法、支持版本和不应公开提交的敏感信息

不强制增加行为准则、Issue 模板、网站或 npm 发布，这些可以在出现真实社区需求后补充。

## 6. 隐私与安全发布门

在切换 GitHub 可见性前必须通过：

1. 工作树与整个 Git 历史的常见密钥模式扫描，包括私钥、GitHub token、OpenAI key、AWS key、密码和 `.env` 内容。
2. 对绝对用户路径、公司内部域名、内网地址、个人邮箱和非公开业务名称进行扫描并人工判读。
3. `npm audit` 不存在 critical 或 high 漏洞；moderate/low 若存在必须记录是否影响发布运行时。
4. 第三方许可证文件、通知、专家来源锁和插件运行时许可证检查通过。
5. 插件包包含项目 `LICENSE`，且不得包含 `.git`、测试夹具、内部计划、vendor 源码或临时文件。

如果历史中发现真实秘密，停止公开流程：先吊销秘密，再清理历史并重新验证。不能用简单删除当前文件替代历史清理。

## 7. 测试与发布流程

本地发布门：

```bash
npm audit --audit-level=high
npm run plugin:verify
npm run verify
git diff --check
```

还需运行插件官方 validator、检查 marketplace 名称，并验证 README 中的公开安装命令与实际清单一致。所有改动先提交并推送到 private 仓库，让 macOS/Windows GitHub Actions 在公开前通过。

最后一步才执行 GitHub 可见性切换。切换后重新读取仓库可见性，并以匿名网络访问验证 README 与 marketplace 文件可获取；不自动创建 Release、不提交公共插件目录。

## 8. 失败处理与回滚

- 任一许可证、隐私、安全或 CI 门失败时，仓库保持 private。
- marketplace 安装验证失败时，修复清单或文档，不通过手工复制插件作为公开安装方案。
- 可见性切换成功但匿名读取失败时，立即检查组织策略和仓库状态；未经用户新授权不删除仓库或重写历史。
- GitHub 公开是外部状态变更，执行结果必须报告仓库 URL、最终可见性、提交 SHA 和 CI 运行链接。

## 9. 非目标

- 不发布 npm 包或系统级安装器。
- 不自动为用户安装 Node.js。
- 不提交 Codex 通用公共插件目录。
- 不加入 Trellis 代码、模板、CLI 或运行时。
- 不补齐尚未实现的 `capture`、`plan`、`replan` 和 Knowledge 生命周期。
- 不改变业务项目默认 Local-only、`gitTracking: none` 和无自动提交/上传策略。

## 10. 验收标准

- GitHub 仓库为 public，匿名用户可以读取。
- 根项目和插件清单均声明 MIT，根 `LICENSE` 与第三方通知完整。
- 独立插件分发包包含与仓库根完全一致的 MIT `LICENSE`。
- `codex plugin marketplace add zhujufeng/EZagent-Spec --ref main` 能识别名为 `ezagent` 的 marketplace。
- `codex plugin add ezagent-spec@ezagent` 能安装自足插件。
- README 清楚区分插件安装、项目初始化和普通自然语言使用。
- 密钥、内部信息、依赖、插件、完整测试和 macOS/Windows CI 发布门全部通过。
- 公开过程没有发布 npm、上传用户项目、自动安装软件或提交 Codex 通用公共目录。
