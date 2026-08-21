# Contributing to EZagent Spec

感谢你改进 EZagent Spec。提交贡献即表示你同意按项目的 MIT License 授权该贡献。

## 开发环境

- Node.js 22+
- npm（使用提交的 `package-lock.json`）
- macOS 或 Windows

```bash
npm ci
npm run plugin:verify
npm run verify
```

## 修改原则

- 保持 Local-only：不得默认增加遥测、网络请求、自动安装、Git 写入或上传。
- 不复制 Trellis 的代码、模板、提示词、CLI 或运行时。
- 更新专家目录时必须保留来源 Commit、内容哈希和许可证证明。
- 改变行为时先增加可失败的回归测试；不要直接编辑生成的插件文件而不更新构建源。
- 不提交密钥、真实项目数据、`.env`、私钥或内部地址。

## Pull Request

Pull Request 应说明问题、设计选择、验证命令和结果。所有测试、类型检查、确定性插件构建及 macOS/Windows CI 必须通过。
