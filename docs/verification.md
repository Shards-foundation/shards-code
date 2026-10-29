# Verification records

The earlier verification report covered source commit `f5ee71d66e0154686d1c6d79700c138474bc8092`, before the subsequent privacy changes that removed automatic telemetry and evaluation capture. Its test counts and limitations do not establish the status of this updated source snapshot. A fresh `pnpm verify` run on the committed updated source is required before reporting current results.

A full run attempted while the worktree was uncommitted stopped at `export source preview`, which requires committed changes. It did not reach the test gates and is not a passing verification result. The final report must name the tested revision, operating system and tool versions; give exact pass, fail and skip counts; and identify platform-specific gates that were not applicable or run. See [Release audit status](release-audit.md) for other outstanding review items.
