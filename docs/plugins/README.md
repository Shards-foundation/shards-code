# 编写 Shards Code Plugin

本文介绍如何创建并校验兼容的 Plugin 包。校验只检查本地文件结构与 schema；它不会将 Plugin 发布到任何目录，也不代表 Shards 提供了 Marketplace 服务。

## 1. 准备环境

在当前本地 checkout 中运行：

```bash
pnpm install --frozen-lockfile
pnpm verify --profile docs
```

如果 Shards Foundation 之后公开 `Shards-foundation/shards-code`，新用户可从该仓库克隆；当前 rebrand 尚未创建或发布该远端仓库。

## 2. 创建一个 Plugin 包

Plugin 是独立目录，根目录必须包含 `.minimax-plugin/plugin.json`。这是为兼容既有 Plugin 格式而保留的协议命名，不表示 Shards Code 与 MiniMax 有关联，也不意味着 Plugin 会进入 MiniMax 或 Shards 的官方目录。

```text
my-plugin/
  .minimax-plugin/plugin.json
  skills/research/SKILL.md
  my-tool.mcp.json
```

最小 manifest：

```json
{
  "schemaVersion": 1,
  "name": "my-plugin",
  "version": "0.1.0",
  "description": "一句话说明这个 Plugin 做什么。",
  "author": "你的名字或组织",
  "icon": "icon.png",
  "category": "Code",
  "exampleQueries": ["用它做一件具体的事"],
  "apps": [],
  "mcpServers": ["my-tool.mcp.json"],
  "skills": ["skills/research/SKILL.md"]
}
```

`name` 必须与目录名一致。`category` 只能取 `Office`、`Studio`、`Design & Sites`、`Code`、`Business`、`Sales`、`Productivity`、`Science & Healthcare`、`Education`、`Other`。`apps`、`mcpServers`、`skills`、`hooks` 至少有一项非空。

完整字段与约束见 [Plugin 包格式 V1](package-format-v1.md)。

## 3. 本地校验

```bash
node tools/plugins/validate-plugin.mjs path/to/my-plugin
```

或运行仓库脚本：

```bash
pnpm check:plugin path/to/my-plugin
```

校验命令与 `pnpm verify --profile docs` 使用同一套代码。它会检查：

- manifest 是否符合 `schemas/plugins/plugin-v1.schema.json`；
- 被引用的 App / MCP / Hook 文件是否存在且满足各自 schema；
- 每个 Skill 的 frontmatter 是否包含与目录一致的 `name` 和非空 `description`；
- 路径是否为 V1 允许的 portable ASCII path（禁止绝对路径、`..`、反斜杠和 Windows 保留名）。

退出码 `0` 表示通过，`1` 表示发现问题，`2` 表示用法错误。

## 4. 提交与目录发布

校验通过只表示本地包格式符合 schema，不代表代码审查、发布授权或目录收录。Shards Code 目前没有宣布 Plugin Marketplace 或目录发布流程。提交到代码仓库前，请先查看 [贡献指南](../../CONTRIBUTING.md) 并通过项目的 issue/PR 流程进行审阅。

## 5. 本地校验不覆盖什么

本地校验不覆盖任何外部目录资格、服务端内容审核、归档限制、`content_digest` 计算、icon / Showcase 媒体字节校验或安全审查。不要将校验通过宣传为可上架或获得 Shards / MiniMax 认可。

## 6. 参考

| 主题 | 文档 |
| --- | --- |
| 包格式、路径契约、安全上限、digest | [package-format-v1.md](package-format-v1.md) |
| Host Binding 扩展 | [host-bindings.md](host-bindings.md) |
| Showcase 案例配置 | [showcases.md](showcases.md) |
| JSON Schema | `schemas/plugins/` |
| 路径与 digest 参考向量 | `test-vectors/plugins/` |
