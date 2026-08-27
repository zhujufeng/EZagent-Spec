# Node.js 自助准备

仅当 Initialize 已证明 `node --version` 缺失、无法解析或 major 低于 22 时读取本文件。目标是在不修改业务项目的前提下，经用户明确批准补齐受支持的 Node.js；不得把插件安装、项目初始化或其他批准复用为系统软件安装批准。项目初始化批准不得复用为系统软件安装批准。

全平台统一顺序是：只读安装器发现 → 展示精确计划 → 获得独立批准 → 安装 → 在新进程中复检。任何一步无法可靠完成都保持项目不变并关闭失败。

## 共同安全边界

1. 只执行当前操作系统对应的只读发现命令。命令不存在只表示渠道不可用，不得因此修改系统。
2. 找到方案后展示：检测结果、安装器与包来源、将执行的精确 argv、联网范围、管理员权限、安装范围、预计下载量、可能需要重启宿主，以及失败后的停止点。
3. 只有用户明确同意这份计划后才执行一次。失败时保留原始错误并停止，不得静默换源、提权或重试。
4. 不得执行 `curl | sh`、远程安装脚本、第三方镜像或自行添加软件源；不得自动安装新的包管理器。
5. 不得在聊天、stdin、argv、日志或临时文件中请求、传递或保存密码。宿主没有受审批的管理员执行能力时，交给操作系统图形界面或 IT。
6. 安装结束后用新的非交互进程重新执行 `node --version`。命令仍不可见或版本不足时不得调用 EZagent CLI，也不得修改 `PATH` 或 shell profile；说明结果并请用户重启宿主或联系 IT。

## Windows

只读确认 `winget` 可用，并查看精确官方包的元数据；包不存在、来源不是 `winget`、版本 major 低于 22 或元数据含糊时关闭失败：

```json
["winget", "--version"]
```

```json
["winget", "show", "--exact", "--id", "OpenJS.NodeJS.LTS", "--source", "winget"]
```

批准后安装官方 LTS 包。该包通常触发 Windows UAC；标准用户可能需要管理员协助：

```json
["winget", "install", "--exact", "--id", "OpenJS.NodeJS.LTS", "--source", "winget", "--accept-package-agreements", "--accept-source-agreements"]
```

不得使用 `--force`、`--ignore-security-hash` 或本地 manifest。安装完成后重新执行 `node --version`；当前宿主仍看不到新 PATH 时请求重启宿主，不得猜测成功。

## macOS

### 已有 Homebrew

先确认 Homebrew 和官方 `node` formula 可用，并从只读 JSON 元数据确认 stable major 至少为 22：

```json
["brew", "--version"]
```

```json
["brew", "info", "--json=v2", "node"]
```

批准后执行：

```json
["brew", "install", "node"]
```

不得为了安装 Node 自动安装 Homebrew，也不得使用 `sudo brew`。

### 没有 Homebrew

回退到 Node.js 官方 macOS 通用 `.pkg`，不得要求用户先安装包管理器。

先取得用户对访问 `https://nodejs.org` 的联网同意，再只读获取 `https://nodejs.org/dist/index.json`，选择最新、`lts` 非 false 且 major 至少为 22 的版本。不得使用 `latest`、搜索结果、第三方镜像或把当前版本硬编码进 Skill。用同一精确版本目录构造：

- `node-v<exact-version>.pkg`
- `SHASUMS256.txt`

在项目外新建权限受限的操作系统临时目录。执行前展示精确版本、两个 URL、临时路径、下载量、系统级 Node/npm 写入范围和管理员授权要求。批准后使用独立 argv 下载，不得使用 shell 重定向：

```json
["curl", "--fail", "--location", "--proto", "=https", "--tlsv1.2", "--output", "<absolute-temp-pkg-path>", "<exact-nodejs-pkg-url>"]
```

```json
["curl", "--fail", "--location", "--proto", "=https", "--tlsv1.2", "--output", "<absolute-temp-shasums-path>", "<exact-nodejs-shasums-url>"]
```

把本地 `.pkg` 的 SHA-256 与 `SHASUMS256.txt` 中该精确文件名的唯一记录做精确等值判断，并要求 macOS 同时接受包签名和 Gatekeeper 安装评估：

```json
["shasum", "-a", "256", "<absolute-temp-pkg-path>"]
```

```json
["pkgutil", "--check-signature", "<absolute-temp-pkg-path>"]
```

```json
["spctl", "--assess", "--type", "install", "--verbose=4", "<absolute-temp-pkg-path>"]
```

任一检查缺失、含糊或失败就清理临时文件并关闭失败，不得打开或安装。默认打开已验证的包，让 macOS 系统 UI 收集管理员授权：

```json
["open", "<absolute-temp-pkg-path>"]
```

只有宿主明确提供受审批的系统级执行能力，且用户已经批准同一精确包、目标 `/` 和管理员影响时，才可不用图形界面执行系统安装器；不得自行添加 `sudo`：

```json
["/usr/sbin/installer", "-pkg", "<absolute-temp-pkg-path>", "-target", "/"]
```

用户取消、安装器状态未知或退出失败时不得假定成功。确认安装结束后清理临时目录，再重新检测 Node。

## Linux

只使用已存在的系统包管理器：

```json
["apt-get", "--version"]
```

```json
["dnf", "--version"]
```

```json
["pacman", "--version"]
```

```json
["zypper", "--version"]
```

只执行与已发现管理器对应的一组元数据命令，确认 `nodejs` 的精确候选版本和既有仓库来源：

```json
["apt-cache", "policy", "nodejs"]
```

```json
["dnf", "info", "nodejs"]
```

```json
["pacman", "--sync", "--info", "nodejs"]
```

```json
["zypper", "info", "nodejs"]
```

候选 major 必须至少为 22。候选不足、包名不确定、来源不明或需要新增第三方仓库时关闭自动安装，给出 Node.js 官方安装页并请用户或 IT 处理。

用户批准精确计划后，只执行对应的一条安装命令：

```json
["apt-get", "install", "--yes", "nodejs"]
```

```json
["dnf", "install", "--assumeyes", "nodejs"]
```

```json
["pacman", "--sync", "--needed", "--noconfirm", "nodejs"]
```

```json
["zypper", "--non-interactive", "install", "nodejs"]
```

向用户展示该系统的精确安装 argv 和管理员影响。不要为了 EZagent 额外安装 npm、pnpm、yarn、编译工具链或项目依赖。需要管理员权限但宿主没有安全的提权通道时停止，不得索取密码或自行添加 `sudo`。
