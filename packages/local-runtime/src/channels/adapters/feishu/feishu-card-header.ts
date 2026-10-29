/**
 * Shared Feishu / Lark Card 2.0 header builder + default bot name.
 *
 * Kept in its own file so both `feishu-card.ts` (questionnaire / submitted /
 * expired cards) and `feishu-reply-card.ts` (reply / thinking cards) can
 * import the same primitive without crossing the 500-line layout budget.
 *
 * Pure data — no SDK / `axios` / `node:crypto` import here.
 */

/** Default bot display name shown in every card header. */
export const DEFAULT_BOT_NAME = 'Shards Code';

/**
 * Build a Card 2.0 `header` object with the standard `(title, template,
 * text_tag_list, [icon], [subtitle])` shape used across reply / thinking /
 * questionnaire / submitted / expired cards.
 */
export function makeHeader(opts: {
  title: string;
  subtitle?: string;
  template: string;
  icon?: string;
  tagText: string;
  tagColor: string;
}): Record<string, unknown> {
  const header: Record<string, unknown> = {
    title: { tag: 'plain_text', content: opts.title },
    template: opts.template,
    text_tag_list: [
      {
        tag: 'text_tag',
        text: { tag: 'plain_text', content: opts.tagText },
        color: opts.tagColor,
      },
    ],
  };
  if (opts.icon) header.icon = { tag: 'standard_icon', token: opts.icon };
  if (opts.subtitle) header.subtitle = { tag: 'plain_text', content: opts.subtitle };
  return header;
}
