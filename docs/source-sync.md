# Working with upstream-derived source

Shards Code is an independent fork based on the public MiniMax Code repository at upstream revision [`da22f11c55d4748155d7162c1030414228a00565`](https://github.com/MiniMax-AI/minimax-code/commit/da22f11c55d4748155d7162c1030414228a00565). No automatic upstream synchronization or private source feed is part of this project.

When adapting a later public upstream change, record the source repository and full commit hash in the review. Inspect the full diff, including deletions and generated files, for license obligations, third-party material, credentials, account data, internal addresses or protocols, and changes that are not appropriate to this fork. Preserve Shards-specific behavior and do not overwrite it as a mechanical sync.

The presence of an upstream commit link does not establish that a change is compatible, legally reusable, safe to distribute, or tested by Shards. Do not include another project's private review documents, private Git history, unreleased material or credentials. Keep the required MIT attribution and third-party notices; keep MiniMax names only where required by law or where they truthfully identify provider/API compatibility.

After a selective upstream-derived change, update the source inventory if paths changed, regenerate generated metadata only through its documented scripts, and run the verification profile and secret/license scans required for the changed surface. Record Shards results separately from upstream evidence. The [release audit status](release-audit.md) and [verification records](verification.md) explain the current evidence boundary.
