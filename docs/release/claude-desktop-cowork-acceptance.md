# Claude Desktop（Cowork 实验性验收）

Claude Desktop 不是 Claude Code 的另一个皮肤。当前版本只把 Cowork 列为实验性支持，而且本项目维护者没有 Claude Desktop 设备；下面的流程是给有桌面版的同事做真实宿主验收，不是已经完成的认证。

## 安装插件

Claude 插件目前要求付费计划；公司 Team / Enterprise 账号还可能被管理员限制个人插件或 Marketplace。请让同事使用最新版 Claude Desktop：

1. 打开 Claude Desktop，进入 `Customize → Plugins`。
2. 在 Personal plugins 区域点击 `+`，选择 `Add marketplace`。
3. 选择从 GitHub repository 或 git URL 添加，输入 `https://github.com/zhujufeng/EZagent-Spec`。
4. 在新出现的 Marketplace 中安装 `ezagent-spec`，确认显示名为 `EZagent Work Harness`、版本为 `0.7.1`。
5. 完全退出并重开 Claude Desktop，再新建一个 Cowork 任务。

如果界面没有 Plugins、Add marketplace 或 Cowork，先检查账号计划、桌面版更新和组织管理员策略；不要把仓库文件手动复制进未知的 Claude 配置目录。Claude Desktop 的 `.mcpb` Desktop Extension 是本地 MCP 的另一种分发格式，EZagent 当前是 Claude Plugin，不需要改名或伪装成 `.mcpb`。

## 用一次性文件夹验收

第一次不要连接真实业务项目、客户资料、生产凭据或已经存在 `.ezagent` 的目录。新建一个可以随时删除的空文件夹，在 Cowork 中只连接这个文件夹，然后按顺序发送：

1. “告诉我当前界面是 Chat 还是 Cowork、已连接文件夹的绝对路径、EZagent 插件版本和可用 Skills；不要修改任何文件。”
2. “请在当前文件夹启用 EZagent Work Harness，先做 Node 和初始化预检，只展示计划，不要安装软件，不要写入文件。”
3. 检查批准前文件夹完全不变，并记录 Node 版本、操作系统检测结果和 CLI 路径。Cowork 可能运行在隔离环境中，检测到的系统不一定等于电脑宿主系统；第一次验收如果提示安装 Node，先不要批准，把完整计划回传给维护者。
4. 路径和预览正确时回复“确认初始化”，随后确认只新增 `.ezagent/**`、`AGENTS.md` 受管区块和必要的受管 Agent 文件。
5. 新建 Cowork 任务并重新连接同一个文件夹，发送“只恢复 EZagent 状态，不要创建新工作项”；应看到 `activeWorkItem: null`，证明跨任务持久化有效。
6. 发送一个只读问题，应走 Consult；再要求修正一个临时文本文件中的错字，应走 Quick。
7. 发送“为这个临时项目整理一份可恢复的交接手册，先给 Work Preview，不要直接实施”；批准前不应出现业务交付物。
8. 发送“请增加一位没有参与实现的独立 reviewer 做审查”；若 Cowork 支持所需 sub-agent，应出现计划匹配、真实 dispatch 和 receipt。若宿主不提供 sub-agent，EZagent 必须明确 blocked，不得由主 Agent 冒充 Specialist。
9. 验证一次“恢复当前工作项”和“取消当前工作项并保留历史”。不要在本轮测试发送消息、发布内容或操作任何真实外部系统。

## 把结果回传给维护者

请同事复制下面模板填写；错误时保留原始文字和截图，但先删除账号、绝对用户名、客户数据、token 和其他敏感信息：

```text
Claude Desktop 版本：
操作系统与版本：
账号计划：Pro / Max / Team / Enterprise
测试界面：Chat / Cowork
EZagent 版本：
Marketplace 安装：通过 / 失败
Node 预检：通过 / 失败；检测到的版本与系统：
批准前零写入：通过 / 失败
初始化：通过 / 失败
新 Cowork 任务恢复：通过 / 失败
Consult：通过 / 失败
Quick：通过 / 失败
Brief Work Preview：通过 / 失败
Specialist 真实 sub-agent：通过 / blocked / 失败
取消后 activeWorkItem 为空：通过 / 失败
实际新增或修改的路径：
完整错误信息（已脱敏）：
```

至少获得一台 macOS 和一台 Windows 的完整回报，并确认初始化、跨任务恢复和 Specialist 行为后，维护者才能把 Cowork 从“实验性支持”提升为“正式支持”。Claude Desktop Chat 即使能加载 Skills，也仍应单独评估，不能继承 Cowork 或 Claude Code 的结论。
