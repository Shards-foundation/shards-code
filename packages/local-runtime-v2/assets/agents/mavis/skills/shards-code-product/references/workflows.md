# Shards Code CLI/TUI workflows

Use this reference for questions about the command-line and terminal user-interface workflows present in the Shards Code source tree.

## Stable facts

- The canonical terminal command is `shards-code`; `mcode` remains a compatibility alias.
- This fork's documented behavior is defined by the current repository, not by MiniMax Code desktop or web documentation.
- Configuration, provider availability, permissions, and runtime state may affect what is available in a particular session.

## Local sources of truth

- Installation and source build: `docs/installation.md`
- TUI capabilities: `docs/tui-capabilities.md`
- Usage examples: `docs/examples.md`
- Architecture and runtime boundaries: `docs/architecture.md`

## Diagnostic workflow

1. Identify the command and installed/source version the user is running.
2. Read the relevant local documentation and inspect the current implementation when a detail is not documented.
3. Check the user's configuration, provider, permissions, and runtime state before attributing an unavailable feature to the product.
4. Do not infer desktop, web, account, subscription, or release behavior from upstream MiniMax Code.
5. Give the shortest supported next action and distinguish repository facts from environment-specific state.

## Boundaries

Do not bypass permission prompts, claim an action succeeded without runtime evidence, or expose credentials and private runtime endpoints. For MiniMax model/API questions, route to `account-models.md` and keep the provider integration distinct from product ownership.
