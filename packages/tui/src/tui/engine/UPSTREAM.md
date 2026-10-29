# Shards Code TUI Engine fork baseline

- Upstream repository: https://github.com/earendil-works/pi.git
- Upstream source: `packages/tui/src`
- Upstream ref: `main`
- Upstream commit: `836aee6d38f60428ab6bd2679f93dce43a55dab3`
- Upstream package version: `0.84.2`
- Imported at: `2026-08-18`
- Fork established: `2026-08-19`
- Local baseline adaptation: relative `.ts` import suffixes are rewritten to `.js` for the Shards Code
  NodeNext build; no product behavior is added.

This directory is Shards Code-owned source. `BASELINE.json` preserves exact per-file upstream and adapted
hashes, while `LOCAL_CHANGES.md` records the fork delta. Pi is provenance and a future
selective-sync input, not a runtime boundary.

The exact imported baseline remains Pi `0.84.2`. The selective Pi `0.84.4` maintenance changes are
recorded as local deltas L017-L021 with their source commits in `LOCAL_CHANGES.md`; this is not a
claim that the whole Engine snapshot has moved to `0.84.4`.

The engine is compiled by the Shards Code package and is the only terminal/input/render foundation used by
the product startup path. Product code may only import `public.ts`; direct imports into
implementation files are forbidden. Shards Code product composition lives outside this directory and does
not change the upstream baseline digest. Validate the exact imported baseline independently with:

```bash
node packages/tui/scripts/verify-tui-engine-baseline.mjs --upstream-root /path/to/pi/packages/tui/src
pnpm --filter @minimax/code exec tsc --noEmit --pretty false
```

For future syncs, compare:

```bash
git log <previous-commit>..<next-commit> -- packages/tui
```

Then refresh this snapshot and review the relevant Pi TUI commits before changing Shards Code adapters.
