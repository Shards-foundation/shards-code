# Shards Code source status

Shards Code is an independently maintained fork by Shards Foundation. It is not affiliated with, endorsed by, or an official product of MiniMax. The current source is based on the public [MiniMax-AI/minimax-code](https://github.com/MiniMax-AI/minimax-code) repository at upstream commit [`da22f11c55d4748155d7162c1030414228a00565`](https://github.com/MiniMax-AI/minimax-code/commit/da22f11c55d4748155d7162c1030414228a00565).

The owner authorized the public source-review destination `Shards-foundation/shards-code` and an initial push so the owner can review it. This authorization is not a software-release approval. The root and TUI versions in this snapshot are **0.6.5**; the intended CLI package name is `@shards-foundation/shards-code`, and the ACP helper name is `@shards-foundation/shards-code-acp`. The workspace manifests are private, and no Shards npm release, installer, or archive is available from this snapshot.

## Included source

The project contains an interactive terminal interface, headless CLI, Agent Client Protocol (ACP) server, build/release tooling, tests, examples and documentation. It is not the MiniMax Desktop product or its support service.

MiniMax model catalog entries, authentication and API endpoints remain available as provider compatibility. These integrations still communicate with MiniMax systems under the user's own account and authorization. The default `~/.minimax` data layout and `MINIMAX_DATA_DIR` / `MAVIS_DATA_DIR` settings remain for compatibility; see [Installation](installation.md#minimax-account-and-api-compatibility).

The pinned `mcode-tools` 0.0.4 component is extracted from public `@minimax-ai/code@0.3.11` and remains unchanged with its notices. The root MIT license and NOTICE retain the legally required original attribution. Other dependencies, vendored code and assets remain governed by their own licenses and notices; see [License status](../LICENSE-STATUS.md) and [Third-party notices](../THIRD_PARTY_NOTICES.md).

## Publication and evidence

The authorized initial public source push is for review of this branch only; it does not constitute owner approval of the exact diff or a software release. The proposed security reporting contact and CODEOWNERS entry are explicitly unverified drafts. See [Publication scope](publication-authorization.md).

Upstream test, product-demo, support and live-service records are not Shards acceptance evidence. Current Shards verification results must identify the exact tested commit, environment, gate results and test pass/fail/skip counts in [Verification records](verification.md). Cross-platform, provider-live and account-specific behavior must be marked not run unless it was actually tested.
