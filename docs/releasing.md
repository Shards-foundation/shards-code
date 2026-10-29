# Releasing Shards Code

## Current status

This rebrand snapshot has not been published. No Shards Code repository, npm package, installer, GitHub release or source archive has been created from this local work. The root and TUI package versions are **0.6.5**; the workspace package manifests remain `private: true`.

Do not treat the planned repository name, package manifest or release workflow as evidence that a public distribution is available. The owner must review the exact final diff, commit and verification report and explicitly authorize each public release action. See [Publication scope](publication-authorization.md).

## Local verification and packaging

Run the repository's complete verification profile from a clean local checkout before considering any release. Review its full report, exact test pass/fail/skip counts, platform-specific skips, lint, typecheck, build and source/secret-scan results. Upstream results and provider-live checks are not Shards evidence; record checks against the exact Shards commit in [Verification records](verification.md).

The packaging script can create a local `shards-code-X.Y.Z.tar.gz` archive outside the checkout for inspection. Local packaging does not publish a release or npm package. Keep generated output and review reports outside the repository unless they are deliberately approved source artifacts. Check the archive contents, executable names, package metadata, native dependencies, `LICENSE`, `NOTICE`, third-party notices, and checksum before any separate publication.

## Public release review

Before creating a tag, repository, release, package or installer:

1. Review the exact commit and complete diff, including deleted files and generated manifests.
2. Confirm the source inventory, package ownership, executable aliases, independence disclaimer, license texts and third-party notices.
3. Run final-revision lint, typecheck, build, tests, verifier and secret scans. Report executed tests as exact pass/fail/skip counts and meet the project acceptance threshold.
4. Verify that no credentials, private account data, private review material or MiniMax-owned product-support claims are included. Preserve only necessary legal attribution and factual compatibility identifiers.
5. Document distribution channels, update behavior, supported platforms, known limits and checks that were not run.
6. Obtain the owner's explicit approval for the exact public write before using GitHub credentials or publishing anything.

A local verification pass is not evidence of GitHub Actions success, a live provider request, a published package, or release availability. See [Release audit status](release-audit.md) and [Source status](open-source-status.md).
