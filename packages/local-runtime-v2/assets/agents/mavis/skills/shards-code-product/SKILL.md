---
name: shards-code-product
description: >-
  Use for questions about the Shards Code source project, its CLI/TUI and ACP surfaces,
  installation, releases, local configuration, agent capabilities, plugins, MCP, and compatibility
  with MiniMax provider APIs. Use repository evidence; do not assume upstream MiniMax Code product
  surfaces or account services exist in this independent fork.
descriptions:
  zh-Hans: >-
    用于回答 Shards Code 源码项目、CLI/TUI 与 ACP、安装、发布、本地配置、Agent 能力、插件、MCP
    以及 MiniMax 提供方 API 兼容性问题。依据本仓库事实，不要假设上游 MiniMax Code 产品界面或账户服务
    也存在于此独立分支中。
---

# Shards Code project identity and routing

## Identity and boundaries

- Shards Code is an independent fork of MiniMax Code, not affiliated with or endorsed by MiniMax.
- The canonical terminal command is `shards-code`. The `mcode` alias remains available for compatibility.
- References to MiniMax models, provider APIs, environment variables, or legacy data paths describe compatibility only; they do not make Shards Code a MiniMax product.
- Do not infer that this fork provides MiniMax Code's upstream desktop/web product, account, subscription, credit, billing, update, or support services.

## Local sources of truth

Check the current checkout's README, package manifests, and docs before answering product questions. Useful references include:

- Installation and source use: `docs/installation.md`
- Terminal capabilities and workflows: `docs/tui-capabilities.md`, `docs/examples.md`
- Architecture and extension behavior: `docs/architecture.md`, `docs/plugins/README.md`
- Open-source scope, telemetry, and publication policy: `docs/open-source-status.md`, `docs/telemetry.md`, `docs/publication-authorization.md`

The source tree is authoritative for Shards Code behavior. Upstream MiniMax Code product docs are not authoritative for this fork.

## Provider compatibility

For questions about MiniMax model or API compatibility, read `references/account-models.md` and inspect the current provider/catalog implementation. MiniMax Open Platform documentation may be used for provider API details only; label it as upstream provider documentation and do not present it as Shards Code product documentation.

## Route to a reference

- CLI/TUI usage and source workflows → `references/workflows.md`
- Agent roles and capability gates → `references/agents.md`
- Skills, plugins, and MCP → `references/extensions.md`
- MiniMax model/provider/API compatibility → `references/account-models.md`

## Response rules

Lead with the conclusion, cite the local source file or documentation that supports it, and distinguish verified source behavior from runtime/account state. Never invent Shards-hosted accounts, plans, prices, quotas, releases, downloads, or support channels. Do not expose credentials or private runtime endpoints.
