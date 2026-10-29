# @shards-foundation/shards-code-acp

Single-bin launcher for Shards Code's Agent Client Protocol (ACP) server. It forwards arguments, standard input/output, signals, and the exit code to the canonical `shards-code` executable.

```sh
npx -y @shards-foundation/shards-code-acp@<version> acp
```

The Shards Code package also includes `mcode` as a compatibility alias. This wrapper selects `shards-code` explicitly so `npx` does not have to choose between multiple package binaries.

Publish this package at the same version as `@shards-foundation/shards-code`, with its dependency pinned to that exact release. This is an independent fork; it is not affiliated with or endorsed by MiniMax.
