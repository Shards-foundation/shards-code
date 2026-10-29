<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/assets/wordmark-dark.svg">
    <source media="(prefers-color-scheme: light)" srcset="docs/assets/wordmark-light.svg">
    <img src="docs/assets/wordmark-light.svg" alt="Shards Code" width="760">
  </picture>
</p>

<h1 align="center">Shards Code</h1>
<p align="center">A terminal coding agent to plan, edit, test, and iterate on real projects—with the model provider you choose.</p>
<p align="center"><strong>Shards Code is an independent fork of the MiniMax Code source, maintained by Shards Foundation. It is not affiliated with, endorsed by, or an official product of MiniMax.</strong></p>
<p align="center">
  <a href="#build-from-source">Get started</a> ·
  <a href="docs/README.md">Documentation</a> ·
  <a href="docs/examples.md">Examples</a> ·
  <a href="CONTRIBUTING.md">Contributing</a>
</p>
<p align="center"><strong>English</strong> · <a href="README_ZH.md">简体中文</a></p>
<p align="center">
  <img src="docs/assets/source-preview.svg" alt="Shards Code source preview">
  <img src="docs/assets/node.svg" alt="Compatibility: Node.js 22.19+, 24.2+, 25, and 26">
  <a href="LICENSE-STATUS.md"><img src="docs/assets/license.svg" alt="First-party default license: MIT"></a>
</p>

Shards Code works in your terminal: explore a codebase, make a change, run its tests, and keep iterating. It includes an interactive interface, a headless mode for scripts and CI, and an Agent Client Protocol (ACP) server for compatible editors.

**The source snapshot does not provide a Shards-hosted installer or published npm package.** Until a reviewed Shards release is available, build and run it from source using the steps below. Do not use MiniMax’s installer or treat MiniMax distribution channels as Shards Code downloads.

## Build from source

You need Git, Node.js **22.19+ (22.x), 24.2+ (24.x), 25, or 26**, and **pnpm 9.12.0**. The first build needs access to public npm. On Windows, keep the checkout on a local NTFS volume and outside cloud-synced folders; run the volume preflight before installing dependencies.

```bash
git clone https://github.com/Shards-foundation/shards-code.git
cd shards-code
corepack enable
corepack prepare pnpm@9.12.0 --activate
# Windows only:
node scripts/check-windows-source-location.mjs
pnpm install --frozen-lockfile
pnpm build
pnpm shards-code --help
```

Start an interactive session from a project directory:

```bash
cd /path/to/your/project
node /absolute/path/to/shards-code/dist/cli.js
```

You can also pass a task directly:

```bash
node /absolute/path/to/shards-code/dist/cli.js "Find a failing test, fix the implementation, and run the relevant tests."
```

For development from inside the checkout, `pnpm shards-code` runs the built CLI. `mcode` remains as a compatibility alias for existing scripts and integrations. See the [installation guide](docs/installation.md) for source-build details, data-directory compatibility, and safe removal.

## Choose a model provider

The project supports custom providers using OpenAI-compatible Completions or Responses APIs and Anthropic-compatible Messages APIs. For a provider that uses an API key, set an environment variable in your shell and add it without placing the secret directly in the command:

```bash
export MY_PROVIDER_API_KEY="your-key"
pnpm shards-code provider add --name my-provider --base-url https://example.com/v1 \
  --api-format openai-completions --model my-model \
  --api-key-env MY_PROVIDER_API_KEY --use
```

Replace the example URL, model, and variable name with your provider’s values. `--use` tests the first model before saving and selecting it. See [model examples](docs/examples.md#2-choose-your-own-model) for connection checks, model limits, and supported formats.

MiniMax models and APIs remain supported as provider compatibility. If you choose MiniMax account or API features, authentication and service requests go to MiniMax services; Shards Code is not a MiniMax account, and this fork is not endorsed by MiniMax. The existing `~/.minimax` data layout and `MINIMAX_DATA_DIR` / `MAVIS_DATA_DIR` settings are retained so earlier source-build data remains available; see [Accounts and data](docs/installation.md#minimax-account-and-api-compatibility).

## Examples and capabilities

- [Build the Pocket Pet example](examples/pocket-pet) and follow the [example walkthrough](docs/demo.md).
- [Repair a small code example](examples/clamp).
- Use the interactive TUI, headless `exec` mode, or ACP with compatible clients.
- Explore built-in tools, model configuration, plugins, and service boundaries in the [documentation index](docs/README.md).

The project can read and edit files, run shell commands and tests, and connect to configured tools. Review proposed changes and permission prompts before granting access to your files or running commands.

## License and attribution

First-party code uses the MIT license subject to existing file-level and package-level terms. The original MiniMax copyright and attribution, mandatory third-party notices, and upstream provenance remain in place. See [license status](LICENSE-STATUS.md), [NOTICE](NOTICE), and [third-party notices](THIRD_PARTY_NOTICES.md).

## Contributing and security

Use the [contribution guide](CONTRIBUTING.md) and the Shards Code repository’s [issue tracker](https://github.com/Shards-foundation/shards-code/issues) for project discussions. Security reporting instructions are in [SECURITY.md](SECURITY.md). MiniMax-owned support channels are not support channels for this fork.
