# Maintainers and contribution workflow

## Responsibility and current setup

Shards Code is maintained independently by Shards Foundation and is not affiliated with or endorsed by MiniMax. This source snapshot does not identify individual maintainers, promise a response SLA, or configure GitHub administration. The repository owner must confirm reviewers, private security reporting, issue labels, branch protection and release permissions before presenting those as active services. The guidance below is a review policy, not evidence that a particular setting is enabled.

## Issue triage

The public issue tracker is for Shards Code source, CLI, TUI, ACP and repository-tooling reports. The project does not announce an official chat group, on-call rota or response time in this source snapshot. Do not put secrets, account data, session identifiers, exploit details or real user content in public issues; see [Security](../SECURITY.md).

Use labels independently:

| Category | Labels and meaning |
| --- | --- |
| Type | `bug`: reported malfunction; `enhancement`: requested improvement; `documentation`: missing or incorrect docs; `question`: usage or project-policy question |
| Product | `cli`: standalone CLI, ACP and build tooling; `tui`: interactive-terminal behavior, used together with `cli` |
| Triage | `needs-triage`: awaiting assessment; `needs-info`: a maintainer asked for specific missing information |

A type label describes the report and does not confirm a defect or commit to implementation. Ask for the specific version, reproduction or expected behavior when information is missing. Once assessed, record the next step in a comment. Classification alone does not promise a fix or release date.

## Pull request labels

| Axis | Labels and meaning |
| --- | --- |
| Change type | `bug`, `enhancement`, `documentation`, or `dependencies`, according to the primary change |
| Product | `cli` for the standalone CLI/runtime/build; add `tui` for interactive-terminal behavior |
| Verification | `perf:full` selects the full performance suite when required by the [performance rules](../CONTRIBUTING.md#performance-checks) |

Classify behavior and scope rather than only the title or changed paths. Keep `perf:full` until merge when the performance rules require it. GitHub labels, reviewers and required checks must be configured in the live repository; this source file does not apply administrative settings.

## Review and merge

1. Discuss substantial scope in a public issue when useful; submit a focused pull request from a feature branch.
2. A reviewer other than the author should review correctness, tests, capability boundaries, licenses and publication scope.
3. Record user-visible behavior, checks, live-service or platform validation not run, and documentation impact in the PR template.
4. Require current approval, resolved review conversations and successful configured verification checks before merging. A cancelled or absent check is not a pass.
5. Preserve contributor attribution and applicable license notices. Do not bypass checks to unblock a release.

The committed [branch-protection baseline](../.github/branch-protection.json) is only a reference. Applying it requires repository administration access, review of existing rules, and a read-back of the effective settings; committing the file does not activate it. Populate [CODEOWNERS](../.github/CODEOWNERS) with confirmed maintainers or teams before requiring code-owner review.

## Contributions and licenses

Contributors must have permission to submit changes under the existing license applicable to each changed file or package. Preserve original authorship and notices, identify imported material and its provenance, and do not include credentials or third-party personal data. This process introduces no separate CLA, DCO bot or copyright assignment. If a contribution needs different terms, resolve them before merging.

When adapting upstream-derived code, use public source material only, record its provenance, and review conflicts and deletions. Never import another repository's private history, private review artifacts or internal implementation details. Keep Shards-specific adaptations intact; preserve factual MiniMax provider/API compatibility identifiers and legally required copyright notices.

## Release handoff

No Shards Code release is implied by this source snapshot. Before any source, archive or npm publication, review the exact commit and diff, verify the applicable source and release gates, scan history and artifacts for secrets, confirm the final package name and license texts, and record known limits. See [Releasing](releasing.md) and [Publication scope](publication-authorization.md). Source verification does not establish live-service acceptance or configure repository settings.
