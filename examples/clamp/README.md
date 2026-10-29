# Fix the clamp function

This intentionally incorrect function is a small Shards Code coding exercise. Copy this directory to a temporary location before trying it. Running `node --test` on the original version produces two failing tests.

Ask Shards Code to read the function and tests, reproduce the failure, fix the function, and run the tests again. Do not change the tests to make them pass.

Expected behavior: `clamp(5, 0, 10)` returns `5`, `clamp(-3, 0, 10)` returns `0`, and `clamp(14, 0, 10)` returns `10`.

See the [local example walkthrough](../../docs/demo.md).
