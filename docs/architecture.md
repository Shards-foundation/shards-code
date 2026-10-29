# Source boundaries

`TUI / exec / ACP → CliService → local Applications → Session / Turn / Agent services → Pi / model providers / local tools`.

- `packages/tui` owns terminal interaction and the headless and ACP adapters.
- `packages/local-runtime-v2/src/local` is the in-process product entry point. Session query views and queue contracts derive from local service types and converters.
- `packages/local-runtime-v2/src/application` handles sessions, queues, and interactions. It does not instantiate DesktopService, an HTTP front door, or cloud handoff services.
- `packages/protocol/src/local.ts` contains CLI data structures; `runtime.ts` contains agent configuration and events. Neither includes RPC envelopes, service routing, authentication headers, or an IDL generation chain. Some numeric enums preserve compatibility with existing saved sessions.
- `packages/local-runtime` supplies reused host facilities such as databases, file tools, permissions, and storage. Historical readers only read old session files; they do not proxy to a daemon or fall back to a legacy executor.
- `third_party/pi-mono` supplies agent, model-protocol, and terminal infrastructure. `third_party/sandbox-runtime` retains the actual sandbox fork, native helpers, and corresponding source.

`@mavis/*` names identify private workspace packages in this repository. The build resolves their source directly rather than downloading them from an internal registry. These packages are not independently published npm APIs.

The unused `@mavis/team` cycle engine is excluded from this projection. TUI delegation uses the current runtime task services. Legacy queue, lock-owner and run-location files retain only the types consumed by shared adapters; V2 owns their execution and persistence.

`release/public-source.json` explicitly lists delivered files. `check:source` checks that inventory, canonical root license text, internal addresses, retired modules, obvious credentials, and workspace exports. `check:standalone` separately checks the actual build dependency graph. New files require explicit inventory updates; absence from the bundle alone does not make source suitable for publication.

## Managed capabilities and tool integration

The TUI continues to use the same runtime through local applications and services. MiniMax account authentication manages MiniMax credentials, refresh and logout; it is a separate service integration, not a Shards Foundation identity service. The third-party `mcode-tools` component provides short-lived access tokens to tool subprocesses through a local lease broker. MiniMax catalog, connector, account and search features use their external service clients without restoring DesktopService or an HTTP front door.

Headless model overrides are passed to a read-only account-state check so authentication requirements follow the model selected for that run. The check does not change global configuration or the session model; execution still uses the existing model resolver, permissions, and tools.

The public distribution configures production regional services only. Non-production environments retained in shared types use reserved `.example.invalid` placeholders. The public CLI rejects internal environment switches and provides no default connection to internal services.
