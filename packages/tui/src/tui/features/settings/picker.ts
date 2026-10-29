import { getKeybindings, type TuiMode } from '../../engine/public.js';
import type { Component } from '../../rendering/component.js';
import { truncateToWidth, visibleWidth } from '../../rendering/text.js';
import { tuiChalk as chalk, tuiColors as colors } from '../../theme/runtime.js';
import {
  questionnaireFrameContentWidth,
  renderQuestionnaireFrame,
} from '../interaction/decision-frame.js';

const TUI_MODES = ['regular', 'fullscreen'] as const satisfies readonly TuiMode[];

const TUI_MODE_DESCRIPTIONS: Record<TuiMode, string> = {
  regular: 'Uses terminal scrollback, selection, and copy.',
  fullscreen: 'Keeps Shards Code in a fixed viewport with in-app scrolling.',
};

export class TuiSettingsPicker implements Component {
  private selectedIndex: number;

  constructor(
    private currentMode: TuiMode,
    private readonly onTuiModeChange: (mode: TuiMode) => boolean,
    private readonly onClose: () => void,
  ) {
    this.selectedIndex = TUI_MODES.indexOf(currentMode);
  }

  handleInput(data: string): void {
    const keybindings = getKeybindings();
    if (keybindings.matches(data, 'tui.select.up')) {
      this.selectedIndex = this.selectedIndex === 0 ? TUI_MODES.length - 1 : this.selectedIndex - 1;
      return;
    }
    if (keybindings.matches(data, 'tui.select.down')) {
      this.selectedIndex = (this.selectedIndex + 1) % TUI_MODES.length;
      return;
    }
    if (keybindings.matches(data, 'tui.select.confirm')) {
      const selectedMode = TUI_MODES[this.selectedIndex];
      if (!selectedMode || selectedMode === this.currentMode) {
        this.onClose();
        return;
      }
      if (this.onTuiModeChange(selectedMode)) {
        this.currentMode = selectedMode;
        this.onClose();
      } else {
        this.selectedIndex = TUI_MODES.indexOf(this.currentMode);
      }
      return;
    }
    if (keybindings.matches(data, 'tui.select.cancel')) this.onClose();
  }

  invalidate(): void {}

  render(width: number): string[] {
    const safeWidth = Math.max(0, Math.floor(width));
    if (safeWidth === 0) return [];
    const contentWidth = questionnaireFrameContentWidth(safeWidth);
    const compact = contentWidth < 56;
    const currentMode = formatTuiMode(this.currentMode);
    return renderQuestionnaireFrame(
      {
        title: safeWidth < 42 ? `Settings · ${currentMode}` : 'Settings',
        ...(safeWidth >= 42 ? { meta: `TUI mode · ${currentMode}` } : {}),
        body: [
          chalk.hex(colors.muted)(
            compact
              ? 'Choose how Shards Code fills this terminal.'
              : 'Choose how Shards Code uses this terminal.',
          ),
          '',
          ...TUI_MODES.flatMap((mode, index) =>
            renderMode(mode, {
              active: mode === this.currentMode,
              focused: index === this.selectedIndex,
              compact,
              width: contentWidth,
            }),
          ),
        ],
        footer:
          safeWidth < 42 ? '↑/↓ move · Enter · Esc close' : '↑/↓ select · Enter apply · Esc cancel',
      },
      safeWidth,
      'signal',
    );
  }
}

function renderMode(
  mode: TuiMode,
  options: {
    readonly active: boolean;
    readonly focused: boolean;
    readonly compact: boolean;
    readonly width: number;
  },
): string[] {
  const prefix = options.focused ? chalk.bold.hex(colors.signal)('›') : ' ';
  const label = (options.focused ? chalk.bold.hex(colors.signal) : chalk.hex(colors.text))(
    formatTuiMode(mode).padEnd(10),
  );
  const status = options.active ? chalk.hex(colors.signal)('● current') : '';
  const description = chalk.hex(colors.muted)(TUI_MODE_DESCRIPTIONS[mode]);
  const heading = `${prefix} ${label}`;

  if (options.compact) {
    return [
      fitWithRightMeta(heading, status, options.width),
      truncateToWidth(`  ${description}`, options.width, ''),
    ];
  }
  return [fitWithRightMeta(`${heading}  ${description}`, status, options.width)];
}

function formatTuiMode(mode: TuiMode): string {
  return mode === 'regular' ? 'Regular' : 'Fullscreen';
}

function fitWithRightMeta(content: string, meta: string, width: number): string {
  if (!meta) return truncateToWidth(content, width, '');
  const gap = width - visibleWidth(content) - visibleWidth(meta);
  if (gap >= 2) return `${content}${' '.repeat(gap)}${meta}`;
  const contentWidth = Math.max(0, width - visibleWidth(meta) - 2);
  return `${truncateToWidth(content, contentWidth, '')}  ${meta}`;
}
