# Verification records

## Full Linux verification after privacy changes

`pnpm verify` completed successfully on commit `c50b15b7623c1e7a8d7602af5474ffff2995343e` before this verification record was added. The full profile exited 0: **14 gates passed, 0 failed, and 3 were skipped** on Linux.

- Environment: Ubuntu 24.04.4 LTS, Linux 6.18.38+, x86_64
- Node.js: `v24.19.0`
- pnpm: `9.12.0`
- Passing gates: `check:source`, `check:tsconfig`, `export source preview`, `test:release-tools`, `lint:tui`, `typecheck`, `build`, `check:standalone`, `test:artifact`, `test:capabilities`, `test:status-contract`, `test:smoke`, `test:byok`, and `test:policy`
- Skipped gates: `test:windows` (not applicable on Linux), `test:sandbox` (macOS-only), and `test:release-package` (requires an npm release archive)

The test suites reported **5,784 passed, 0 failed, and 20 skipped** (99.66% passed among executed tests; 5,804 cases total when skips are included).

| Test gate | Passed | Failed | Skipped |
|---|---:|---:|---:|
| `test:release-tools` | 67 | 0 | 1 |
| `test:artifact` | 11 | 0 | 0 |
| `test:capabilities` | 5,531 | 0 | 18 |
| `test:status-contract` | 9 | 0 | 0 |
| `test:smoke` | 20 | 0 | 1 |
| `test:byok` | 4 | 0 | 0 |
| `test:policy` | 142 | 0 | 0 |
| **Total** | **5,784** | **0** | **20** |

The artifact suite includes regression checks that the known automatic MiniMax telemetry and evaluation-capture channels are absent from production source and the built distribution, while the explicit feedback path remains. It also covers the packed ACP launcher and public artifacts.

### Warning and limits

The pnpm commands emitted a non-failing warning that the root `package.json` `pnpm` field is no longer read; `pnpm.onlyBuiltDependencies` and `pnpm.overrides` were ignored. The run used the dependencies already installed in this environment. Move those settings to `pnpm-workspace.yaml` and verify a clean locked install before a release.

This run does not establish Windows or macOS behavior, npm release-package verification, GitHub Actions success, live provider/account behavior, or paid-service behavior. A separate source, Git-history, and built-artifact secret scan was not run; the source inventory and artifact checks are not an exhaustive secret scan. The proposed security contact and CODEOWNERS candidate remain unverified drafts pending owner review. See [Release audit status](release-audit.md) and [Publication scope](publication-authorization.md).
