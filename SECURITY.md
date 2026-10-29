# Security

**OWNER REVIEW DRAFT — delivery of one test email was confirmed in the owner's inbox on 2026-10-29. Continuous monitoring and a response-time commitment have not been established.**

**Proposed reporting contact:** `Shards-inc@engineer.com` (a test message to this address was confirmed in the owner's inbox on 2026-10-29).

That confirmation covers the test message only. Do not describe this address as a continuously monitored security-reporting route or promise a response time. This draft does not establish an active, continuously monitored Shards security inbox.

Shards Code is an independent fork and is not affiliated with or endorsed by MiniMax. Do not send vulnerability details to MiniMax or publish exploit details, credentials, or real user data in a public issue.

If GitHub's **Private vulnerability reporting** feature is enabled for the Shards Code repository, use that private channel. If it is unavailable, ask the repository owner to confirm a private reporting route before sharing sensitive details. The owner should configure and test a private reporting channel before a public software release.

Include the affected revision, operating system and Node.js version, a minimal reproduction, the expected and actual permission boundaries, and only necessary redacted evidence. Use synthetic files and dedicated test accounts; do not test other people's accounts or infrastructure.

## Data and service boundaries

- The default account-data directory remains `~/.minimax` for compatibility and can contain login state, provider configuration (including API keys in `config.yaml`), caches and sessions. Environment overrides and profiles may select another location. Follow [Accounts and data](docs/installation.md#minimax-account-and-api-compatibility) to identify it; installation directories do not identify stored credentials. Restrict local access to every data directory you have used and keep them out of Git.
- MiniMax models, account features and API endpoints remain provider integrations. Requests to those services are governed by MiniMax's terms and authorization; source access does not grant an account or third-party resources.
- Models, plugins, connectors, search, media and feedback can contact external services. The `/feedback` path must remain reviewable before sending; optional diagnostics must be unchecked and excluded by default, and included only after explicit user selection and send confirmation.
- `mcode-tools` obtains short-lived access tokens through the host's lease broker. Never pass refresh tokens to tool processes.
- Permissions and sandboxing do not replace review of untrusted plugins, MCP servers and shell commands. If automatic permission classification is unavailable, retain user confirmation rather than allowing operations by default.
- If credentials leak, revoke or rotate them with the service first, then remediate files and Git history. Deleting the current file does not remove historical copies.

Scan source, Git history and build artifacts separately. A passing scan does not guarantee the absence of unknown vulnerabilities.
