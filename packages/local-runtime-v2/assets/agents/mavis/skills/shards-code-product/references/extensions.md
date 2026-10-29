# Shards Code skills, plugins, and MCP

Use this reference for extension behavior implemented by Shards Code. A local source component or bundled skill is not automatically an independently distributed product or a feature of the upstream MiniMax Code service.

## Local sources of truth

- Plugin format and examples: `docs/plugins/README.md`, `docs/plugins/package-format-v1.md`, `docs/plugins/showcases.md`
- Plugin host bindings: `docs/plugins/host-bindings.md`
- Bundled local skills: `packages/local-runtime/assets/skills/`
- Built-in Agent skill assets: `packages/local-runtime-v2/assets/agents/`
- Extension-related architecture: `docs/architecture.md`

## Diagnostic workflow

1. Identify whether the user means a built-in skill, a plugin, an MCP server, or an external tool integration.
2. Check the relevant local docs and implementation for the current format, discovery rules, and capability gates.
3. Distinguish a catalog entry from an installed, loaded, selected, or executed extension.
4. For runtime failures, verify configuration, permissions, and server health before suggesting a change.
5. Describe the concrete next step and separate verified source behavior from environment-specific state.

## Safety

Never request or repeat passwords, API keys, OAuth secrets, tokens, or verification codes in chat. Do not bypass consent, permission, or provider validation. Avoid asserting features not present in the current checkout.
