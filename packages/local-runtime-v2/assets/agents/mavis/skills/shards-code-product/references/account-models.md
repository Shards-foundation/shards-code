# MiniMax provider and API compatibility

Use this reference only for questions about MiniMax as an upstream model provider or its API compatibility with Shards Code. It does not describe a Shards Code account, subscription, credit balance, or billing plan.

## Stable boundaries

- MiniMax model names and API support are provider/API compatibility facts, not evidence of product ownership or affiliation.
- Provider credentials, quotas, billing, and model availability are governed by the provider account and current provider documentation; do not imply they are Shards Code entitlements.
- Inspect the repository's current provider registry, model catalog, and API adapter before claiming which models or operations are supported.
- A model's presence in a catalog does not prove that a user's credential, region, account, or requested operation can access it.

## Verification workflow

1. Identify whether the question concerns a provider/model identifier, API endpoint, credential format, or Shards Code product behavior.
2. For local support, inspect the matching code under `packages/config/` and the relevant runtime/provider adapter.
3. For current MiniMax API semantics, consult MiniMax Open Platform documentation and label it as upstream provider documentation.
4. Keep provider account/billing facts separate from Shards Code behavior; mark account-specific availability as unverified unless there is direct runtime evidence.
5. Report the conclusion first, then the local implementation or upstream provider source, and any remaining uncertainty.

## Safety

Never expose or ask a user to paste API keys, passwords, OAuth secrets, or verification codes. Do not promise a model or media operation is enabled for a particular account without evidence, and do not bypass provider or permission restrictions.
