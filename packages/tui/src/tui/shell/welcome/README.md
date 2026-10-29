# Welcome UI maintenance

Welcome separates design assets, layout, and terminal mechanics. Designers generally only need to edit this directory.

- `design.ts` is the single visual configuration entry point: character logo, wordmark, slogan, tips, news, and responsive hero thresholds.
- `component.ts` owns wide, stacked, and compact layouts, not theme detection or runtime lifecycle.
- `hero.ts` maps design assets to the current theme's gradient hero. Change it only when adjusting responsive selection or coloring.

Welcome and `/changelog` share the local changelog bundled with the package. `CHANGELOG.md` is the English default and fallback; `CHANGELOG.zh-CN.md` is the Chinese version. A system locale with language `zh` selects Chinese; other languages select English. For each release, keep version headings synchronized and provide at least three entries per language for Welcome.

The hero uses the seven-row `SHARDS CODE` bitmap at 91 columns or more, a three-row compact bitmap at 44–90 columns, and a diamond mark at 11–43 columns. Below 11 columns it falls back to `S`; below four columns the frame renders that initial directly. Keep the product name only once in the frame header when the frame is visible, and do not restore upstream wordmarks or stacked `MINI` / `MAX` / `CODE` layouts.

Shared colors live in `src/tui/theme/palettes.ts`; borders and terminal-width adaptation live in `src/tui/shell/frame.ts`. Initial theme detection and rendering gates belong to infrastructure in `src/tui/theme/render-binding.ts` and `src/tui/renderer/interactive-renderer.ts`. Do not add startup sequencing to Welcome.

Validate copy, colors, and artwork visually. For responsive layout, visibility, or state changes in this standalone repository, run the relevant test from the repository root:

```bash
pnpm exec vitest run --config vitest.oss.config.mjs packages/tui/test/unit/tui-shell-chrome.test.ts
```
