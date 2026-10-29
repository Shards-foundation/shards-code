# 项目级 MCP 配置

本地 Runtime 按当前 session 的主工作目录读取 `.mcp.json`，Desktop、Shards Code 交互式 TUI、`mcode exec`、`mcode acp` 和使用同一 Runtime 的 CLI 共用这一能力。无需导入，也不设置 MCP 专属批准或配置摘要授权。

```json
{
  "mcpServers": {
    "repo-tools": {
      "command": "node",
      "args": ["./tools/mcp-server.js"],
      "env": { "API_TOKEN": "${REPO_API_TOKEN}" }
    },
    "docs": {
      "type": "http",
      "url": "${DOCS_MCP_URL:-https://example.com/mcp}",
      "headers": { "Authorization": "Bearer ${DOCS_TOKEN}" }
    }
  }
}
```

## 自动加载与连接

- Runtime 从 session 的 canonical `workspaceDir` 读取配置。不会因为客户端类型不同而跳过项目文件；项目路径不依赖启动 Runtime 进程时的 cwd。
- 读取配置或展示列表不会启动 MCP。实际 turn 工具发现或调用时，Runtime 自动连接有效且未禁用的 server。
- stdio 连接会执行项目配置里的命令，远程连接会访问配置的 URL；这是项目配置自动加载的产品约定。工具调用仍走原有权限策略，但工具权限确认发生在连接之后，不替代进程启动控制。
- 工具发现和调用前重新读取配置。文件内容或展开后的环境变量变化时，中止旧 project 调用、关闭旧连接，后续请求自动使用新配置，不再弹出批准窗口。
- 可以在 `.mcp.json` 中设置 `enabled: false` 停用条目。删除文件或整份文件无效时，移除项目层并恢复同名 profile 配置。
- 文件始终只读，不会导入或写回 profile 的 `mcp.json`，不持久化项目配置授权。

## 项目边界与格式

- 只读取主工作目录的 `.mcp.json`，不向上搜索、不扫描 `/add-dir`。从子目录启动且 session 主目录就是该子目录时，只读取子目录内的文件。
- 支持 stdio、`http`、`streamable-http`、`sse`；不支持的 transport 显示错误。
- `command`、`args`、`env`、`url`、`headers` 支持 `${VAR}`、`${VAR:-default}`。变量缺失时停用该 server 并显示变量名，不回显变量值。
- 支持正整数 `timeout`（毫秒）。Runtime 内部字段（builtin、tools、metadata 等）不会从项目文件加载。
- stdio cwd 与 MCP `roots/list` 都使用 canonical 主项目目录。远程 MCP 也收到该 root；HTTP 凭据禁止跨 origin 重定向携带。
- 文件最大 1 MiB，必须为项目内普通文件；允许指向项目内文件的 symlink。坏 JSON、读失败或名字归一化冲突使整份文件失效；单个 server 的错误不会阻止其他有效 server。项目目录已删除时，profile 和 builtin 仍可使用。

## 同名规则与状态

普通配置同名按 **ACP session > project > profile** 整条替换，不跨来源拼接 URL、command、env 或 headers。禁用或错误的 project entry 仍遮蔽同名 profile entry，避免悄悄连接另一个目标；保留的 builtin 名称不能被项目配置覆盖。插件仍由插件 Runtime 独立管理。

配置、连接与错误状态按 session、canonical 项目目录和配置版本隔离；清除 ACP 客户端注入不会清除项目文件配置。会话删除通过公共 Runtime 生命周期清理项目及客户端连接。

- TUI `/mcp`：显示当前 session 的 Built-in、User-configured、Project、Client session 配置和状态。
- TUI `/mcp reload`：重新读取并展示；`/mcp <filter>` 按 server 名过滤。没有 `approve` / `deny` 操作，它们可作为普通过滤词。
- ACP `/mcp <filter>`：列出当前 ACP session 的有效配置。
- 检查接口不回显 args、env、headers、URL query。全局 MCP 管理继续操作 profile 文件；项目文件的变更直接在项目中进行。

连接成功后状态为 `available`；未连接为 `configured`；禁用或无效时为 `disabled` / `error`。没有 `pending_approval` 状态。
