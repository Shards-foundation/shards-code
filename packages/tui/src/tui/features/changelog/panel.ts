import { getKeybindings, Markdown, Key, matchesKey } from '../../engine/public.js';
import type { Component } from '../../rendering/component.js';
import { truncateToWidth } from '../../rendering/text.js';
import { tuiMarkdownTheme } from '../../theme/runtime.js';
import { panelLayout, panelContentWidth, renderPanelFrame } from '../../widgets/panel-frame.js';

export { extractTuiChangelogMarkdown } from './content.js';

export interface TuiChangelogPanelOptions {
  readonly markdown: string;
  readonly version: string;
  readonly onClose: () => void;
  readonly requestRender: () => void;
}

export class TuiChangelogPanel implements Component {
  readonly fullscreenViewport = true;
  readonly handlesViewportKeys = true;
  private readonly markdown: Markdown;
  private viewportOffset = 0;
  private viewportRows = 0;
  private viewportLineCount = 0;

  constructor(private readonly options: TuiChangelogPanelOptions) {
    this.markdown = new Markdown(options.markdown, 0, 0, tuiMarkdownTheme);
  }

  handleInput(data: string): void {
    if (getKeybindings().matches(data, 'tui.select.cancel')) this.options.onClose();
    else if (matchesKey(data, Key.pageUp)) this.scrollByPage(-1);
    else if (matchesKey(data, Key.pageDown)) this.scrollByPage(1);
    else if (matchesKey(data, Key.up)) this.scrollByRows(-1);
    else if (matchesKey(data, Key.down)) this.scrollByRows(1);
  }

  invalidate(): void {
    this.markdown.invalidate();
  }

  render(width: number): string[] {
    const safeWidth = Math.max(0, Math.floor(width));
    if (safeWidth === 0) return [];
    return this.renderFrame(safeWidth, this.renderMarkdown(safeWidth));
  }

  renderViewport(width: number, rawHeight: number): readonly string[] {
    const safeWidth = Math.max(0, Math.floor(width));
    const height = Math.max(1, Math.floor(rawHeight));
    if (safeWidth === 0) return [];
    const lines = this.renderMarkdown(safeWidth);
    const closeLayout = panelLayout(safeWidth, height, 'Esc close');
    if (lines.length <= closeLayout.bodyHeight) {
      this.viewportOffset = 0;
      this.viewportRows = lines.length;
      this.viewportLineCount = lines.length;
      return this.renderFrame(safeWidth, lines, 'Esc close', height);
    }
    const count = lines.length;
    const layout = panelLayout(
      safeWidth,
      height,
      `Lines ${count}-${count} of ${count} · PgUp/PgDn scroll · Esc close`,
    );
    this.viewportRows = layout.bodyHeight;
    this.viewportLineCount = count;
    this.viewportOffset = clamp(this.viewportOffset, 0, Math.max(0, count - this.viewportRows));
    const end = Math.min(count, this.viewportOffset + this.viewportRows);
    return this.renderFrame(
      safeWidth,
      lines.slice(this.viewportOffset, end),
      `Lines ${this.viewportOffset + 1}-${end} of ${count} · PgUp/PgDn scroll · Esc close`,
      height,
    );
  }

  scrollByRows(delta: number): number {
    if (this.viewportRows === 0) return 0;
    const maximum = Math.max(0, this.viewportLineCount - this.viewportRows);
    const next = clamp(this.viewportOffset + Math.trunc(delta), 0, maximum);
    const scrolled = next - this.viewportOffset;
    if (scrolled !== 0) {
      this.viewportOffset = next;
      this.options.requestRender();
    }
    return scrolled;
  }

  scrollByPage(direction: -1 | 1): number {
    return this.scrollByRows(direction * Math.max(1, this.viewportRows - 1));
  }

  private renderMarkdown(width: number): string[] {
    const contentWidth = panelContentWidth(width);
    return this.markdown.render(contentWidth).map((line) => truncateToWidth(line, contentWidth));
  }

  private renderFrame(
    width: number,
    body: readonly string[],
    footer = 'Esc close',
    height?: number,
  ): string[] {
    return renderPanelFrame(
      {
        title: "What's New",
        meta: `Shards Code ${this.options.version}`,
        body,
        footer,
      },
      width,
      height,
    );
  }
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, value));
}
