import { panelLayout } from '../../widgets/panel-frame.js';
import { decodePrintableKey, matchesKey } from '../../engine/public.js';
import type { Component } from '../../rendering/component.js';
import { truncateToWidth } from '../../rendering/text.js';
import {
  formatTuiCommandUsage,
  isTuiCommandDiscoverable,
  type TuiCommand,
} from '../../commands/catalog.js';
import {
  renderTuiActionHint,
  tuiChalk as chalk,
  tuiColors as colors,
} from '../../theme/runtime.js';
import {
  formatTuiKeybinding,
  getDefaultTuiKeybindingRegistry,
  type TuiKeybindingRegistry,
} from '../../shell/keybindings.js';

export interface TuiHelpPanelOptions {
  commands: readonly TuiCommand[];
  queueEnabled?: boolean;
  keybindings?: TuiKeybindingRegistry;
  maxRows?: number | (() => number);
  onCancel: () => void;
}

export class TuiHelpPanel implements Component {
  readonly fullscreenViewport = true;
  readonly handlesViewportKeys = true;
  private readonly commands: readonly TuiCommand[];
  private readonly options: TuiHelpPanelOptions;
  private scrollTop = 0;
  private viewportRows = 9;

  constructor(options: TuiHelpPanelOptions) {
    this.options = options;
    this.commands = dedupeCommands(options.commands)
      .filter(isTuiCommandDiscoverable)
      .sort((left, right) => left.name.localeCompare(right.name));
  }

  handleInput(data: string): void {
    const printable = decodePrintableKey(data) ?? data;
    if (
      matchesKey(data, 'escape') ||
      matchesKey(data, 'enter') ||
      matchesKey(data, 'ctrl+c') ||
      printable === 'q' ||
      printable === 'Q'
    ) {
      this.options.onCancel();
      return;
    }
    if (matchesKey(data, 'up')) {
      this.scrollTop = Math.max(0, this.scrollTop - 1);
      return;
    }
    if (matchesKey(data, 'down')) {
      this.scrollTop += 1;
      return;
    }
    if (matchesKey(data, 'pageUp')) {
      this.scrollTop = Math.max(0, this.scrollTop - this.pageStep());
      return;
    }
    if (matchesKey(data, 'pageDown')) {
      this.scrollTop += this.pageStep();
    }
  }

  invalidate(): void {}

  render(width: number): string[] {
    return this.renderViewport(width, this.currentMaxRows() ?? Infinity);
  }

  renderViewport(width: number, height: number): string[] {
    const initial = panelLayout(width, height, this.renderFooter());
    const content = this.renderContent(initial.contentWidth);
    const footer = this.renderFooter({
      first: content.length,
      last: content.length,
      total: content.length,
    });
    const layout = panelLayout(width, height, footer);
    const visibleRows = Math.max(1, layout.bodyHeight);
    this.viewportRows = Number.isFinite(visibleRows) ? visibleRows : content.length;
    this.scrollTop = Math.max(
      0,
      Math.min(this.scrollTop, Math.max(0, content.length - visibleRows)),
    );
    const visible = content.slice(this.scrollTop, this.scrollTop + visibleRows);
    const position =
      content.length > visibleRows
        ? {
            first: this.scrollTop + 1,
            last: this.scrollTop + visible.length,
            total: content.length,
          }
        : undefined;
    return panelLayout(width, height, this.renderFooter(position)).render({
      title: 'Help',
      body: visible,
    });
  }

  private renderContent(width: number): string[] {
    const queueEnabled = this.options.queueEnabled ?? true;
    const keybindings = this.options.keybindings ?? getDefaultTuiKeybindingRegistry();
    const shortcuts = [
      ...keybindings.helpRows(queueEnabled).map((row) => ({
        keys: row.keys,
        description: row.description,
      })),
      {
        keys: 'Enter',
        description: queueEnabled ? 'Send; while Shards Code works it sends next' : 'Send while idle',
      },
    ];
    const commandLabelWidth = columnWidth(this.commands.map(formatTuiCommandUsage), width, 12);
    const shortcutLabelWidth = columnWidth(
      shortcuts.map((shortcut) => shortcut.keys),
      width,
      8,
    );

    return [
      `  ${chalk.bold.hex(colors.text)('Keyboard shortcuts')}`,
      ...shortcuts.map((shortcut) =>
        formatHelpRow(shortcut.keys, shortcut.description, shortcutLabelWidth, width, (value) =>
          chalk.hex(colors.signal)(value),
        ),
      ),
      '',
      `  ${chalk.bold.hex(colors.text)('Slash commands')}`,
      ...this.commands.map((command) => {
        const usage = formatTuiCommandUsage(command);
        return formatHelpRow(usage, command.description, commandLabelWidth, width, (value) =>
          chalk.hex(colors.signal)(value),
        );
      }),
    ];
  }

  private renderFooter(position?: { first: number; last: number; total: number }): string {
    const keybindings = this.options.keybindings ?? getDefaultTuiKeybindingRegistry();
    const closeKey = formatTuiKeybinding('app.interrupt', keybindings);
    const close = closeKey === 'Esc' ? 'Esc close' : `Esc close · ${closeKey} to close`;
    const range = position
      ? `showing ${String(position.first)}-${String(position.last)} of ${String(position.total)}`
      : '';
    const scroll = `↑↓ / ${formatTuiKeybinding('interaction.scroll-up', keybindings)} / ${formatTuiKeybinding('interaction.scroll-down', keybindings)} scroll`;
    return renderTuiActionHint([range, scroll, close].filter(Boolean).join(' · '));
  }

  private pageStep(): number {
    return Math.max(1, this.viewportRows - 1);
  }

  private currentMaxRows(): number | undefined {
    const maxRows =
      typeof this.options.maxRows === 'function' ? this.options.maxRows() : this.options.maxRows;
    return maxRows === undefined ? undefined : Math.max(4, Math.floor(maxRows));
  }
}

function columnWidth(labels: readonly string[], width: number, minimum: number): number {
  const longest = Math.max(minimum, ...labels.map((label) => label.length));
  const available = Math.max(minimum, width - 6);
  return Math.min(longest, Math.max(minimum, Math.floor(available * 0.4)));
}

function formatHelpRow(
  label: string,
  description: string,
  labelWidth: number,
  width: number,
  colorLabel: (value: string) => string,
): string {
  const fittedLabel = truncateToWidth(label, labelWidth, '…');
  const paddedLabel = `${fittedLabel}${' '.repeat(Math.max(0, labelWidth - fittedLabel.length))}`;
  return truncateToWidth(
    `    ${colorLabel(paddedLabel)}  ${chalk.hex(colors.muted)(description)}`,
    width,
  );
}

function dedupeCommands(commands: readonly TuiCommand[]): TuiCommand[] {
  const seen = new Set<string>();
  return commands.filter((command) => {
    if (seen.has(command.name)) return false;
    seen.add(command.name);
    return true;
  });
}
