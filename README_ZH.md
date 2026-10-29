<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/assets/wordmark-dark.svg">
    <source media="(prefers-color-scheme: light)" srcset="docs/assets/wordmark-light.svg">
    <img src="docs/assets/wordmark-light.svg" alt="Shards Code" width="760">
  </picture>
</p>

<h1 align="center">Shards Code</h1>
<p align="center">在终端中规划、修改、测试并持续改进真实项目；模型提供方由你选择。</p>
<p align="center"><strong>Shards Code 是由 Shards Foundation 维护的 MiniMax Code 源码独立分支，与 MiniMax 无关联、未获 MiniMax 认可，也非 MiniMax 官方产品。</strong></p>
<p align="center">
  <a href="#从源码构建">快速开始</a> ·
  <a href="docs/README.md">文档</a> ·
  <a href="docs/examples.md">示例</a> ·
  <a href="CONTRIBUTING.md">贡献指南</a>
</p>
<p align="center"><a href="README.md">English</a> · <strong>简体中文</strong></p>
<p align="center">
  <img src="docs/assets/source-preview.svg" alt="Shards Code 源码预览">
  <img src="docs/assets/node.svg" alt="兼容版本：Node.js 22.19+、24.2+、25 和 26">
  <a href="LICENSE-STATUS.md"><img src="docs/assets/license.svg" alt="首方代码默认许可证：MIT"></a>
</p>

Shards Code 在终端中运行：探索代码库、修改代码、运行测试并继续迭代。它提供交互式界面、用于脚本和 CI 的无头模式，以及面向兼容编辑器的 Agent Client Protocol（ACP）服务端。

**当前源码快照不提供由 Shards 托管的安装器或已发布的 npm 包。** 在经过审核的 Shards 版本发布前，请按下方步骤从源码构建和运行。请勿使用 MiniMax 官方安装器，也不要把 MiniMax 的分发渠道当作 Shards Code 下载来源。

## 从源码构建

需要 Git、Node.js **22.19+（22.x）、24.2+（24.x）、25 或 26**，以及 **pnpm 9.12.0**。首次构建需要访问公共 npm。Windows 用户请将代码库放在本地 NTFS 卷中并避开云同步目录；安装依赖前运行卷检查。

```bash
git clone https://github.com/Shards-foundation/shards-code.git
cd shards-code
corepack enable
corepack prepare pnpm@9.12.0 --activate
# 仅 Windows 运行：
node scripts/check-windows-source-location.mjs
pnpm install --frozen-lockfile
pnpm build
pnpm shards-code --help
```

在项目目录中启动交互会话：

```bash
cd /path/to/your/project
node /absolute/path/to/shards-code/dist/cli.js
```

也可以直接提交任务：

```bash
node /absolute/path/to/shards-code/dist/cli.js "Find a failing test, fix the implementation, and run the relevant tests."
```

在源码目录开发时，`pnpm shards-code` 会运行构建后的 CLI。`mcode` 仍作为兼容别名保留，供现有脚本和集成使用。源码构建细节、数据目录兼容性与安全移除方式见[安装指南](docs/installation.md)。

## 选择模型提供方

项目支持 OpenAI 兼容的 Completions / Responses API，以及 Anthropic 兼容的 Messages API。使用 API Key 时，请先在 shell 中设置环境变量，再添加提供方，不要把密钥直接写入命令：

```bash
export MY_PROVIDER_API_KEY="your-key"
pnpm shards-code provider add --name my-provider --base-url https://example.com/v1 \
  --api-format openai-completions --model my-model \
  --api-key-env MY_PROVIDER_API_KEY --use
```

请将示例地址、模型和变量名替换成实际值。`--use` 会先测试第一个模型，成功后再保存并选为默认模型。连接检查、模型限制和支持格式见[模型示例](docs/examples.md#2-choose-your-own-model)。

MiniMax 模型和 API 仍作为提供方兼容能力保留。选择 MiniMax 账号或 API 功能时，身份验证与服务请求会发往 MiniMax 服务；Shards Code 不是 MiniMax 账号，该分支也未获 MiniMax 认可。现有 `~/.minimax` 数据布局以及 `MINIMAX_DATA_DIR` / `MAVIS_DATA_DIR` 设置仍然有效，以便继续访问早期源码构建的数据；详见[账号与数据](docs/installation.md#minimax-account-and-api-compatibility)。

## 示例与能力

- [构建 Pocket Pet 示例](examples/pocket-pet)，并按照[示例演练](docs/demo.md)操作。
- [修复一个小型代码示例](examples/clamp)。
- 使用交互式 TUI、无头 `exec` 模式，或兼容客户端的 ACP 接口。
- 在[文档索引](docs/README.md)中查看内置工具、模型配置、插件和服务边界。

项目可以读取和编辑文件、运行 Shell 命令与测试，并连接已配置的工具。请先审阅变更建议和权限提示，再决定是否允许访问文件或执行命令。

## 许可证与署名

首方代码默认使用 MIT 许可证，但仍受现有文件级和包级条款约束。原始 MiniMax 版权与署名、必须保留的第三方声明及上游来源信息均会继续保留。详见[许可证状态](LICENSE-STATUS.md)、[NOTICE](NOTICE)和[第三方声明](THIRD_PARTY_NOTICES.md)。

## 贡献与安全

请参阅[贡献指南](CONTRIBUTING.md)，并通过 Shards Code 仓库的[问题跟踪器](https://github.com/Shards-foundation/shards-code/issues)参与项目讨论。安全报告说明见[安全政策](SECURITY.md)。MiniMax 的支持渠道不属于此分支的支持渠道。
