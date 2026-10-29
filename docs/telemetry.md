# Automatic reporting and feedback

Shards Code does not automatically send MiniMax product-usage telemetry, runtime metrics, error diagnostics, or evaluation-capture data. Those automatic reporting and evaluation-capture paths, along with their telemetry CLI controls, have been removed. There are no supported `telemetry` settings that turn those channels back on.

This does not disable other network activity. Actions such as signing in, making provider requests, checking for updates, and submitting feedback may contact external services as part of those separate features.

## User-submitted feedback

The `/feedback` command is an explicit review-and-send flow. Review the proposed feedback before submission. Optional diagnostics are unchecked and excluded by default; they are included only if you opt in and confirm sending. The feedback endpoint remains for compatibility with the MiniMax service. Do not include sensitive information in the feedback text, and review the diagnostic preview before opting in.

This repository does not establish backend retention, access, or ingestion policies for submitted feedback or opted-in diagnostics. See [TUI capability coverage](tui-capabilities.md) for the documented scope and [verification records](verification.md) for local test coverage and limitations.
