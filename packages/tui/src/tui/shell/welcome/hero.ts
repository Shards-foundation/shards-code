import { visibleWidth } from '../../rendering/text.js';
import { tuiChalk as chalk, tuiColors as colors } from '../../theme/runtime.js';
import { centerToWidth } from '../frame.js';
import {
  SHARDS_CODE_TERMINAL_MEDIUM_WORDMARK,
  SHARDS_CODE_TERMINAL_MICRO_WORDMARK,
  SHARDS_CODE_TERMINAL_WORDMARK,
  SHARDS_CODE_WELCOME_DESIGN,
} from './design.js';

export function renderTuiWelcomeHero(width: number): string[] {
  const { fullMinWidth, mediumMinWidth, microMinWidth, fallbackTitle } =
    SHARDS_CODE_WELCOME_DESIGN.hero;
  const source =
    width >= fullMinWidth
      ? SHARDS_CODE_TERMINAL_WORDMARK
      : width >= mediumMinWidth
        ? SHARDS_CODE_TERMINAL_MEDIUM_WORDMARK
        : width >= microMinWidth
          ? SHARDS_CODE_TERMINAL_MICRO_WORDMARK
          : [fallbackTitle];
  const isCharacterWordmark = source.length > 1;
  const sourceWidth = Math.max(...source.map((line) => visibleWidth(line)));
  const gradient = [
    colors.wordmarkHighlight,
    colors.wordmarkHighlight,
    colors.brand,
    colors.brand,
    colors.wordmarkShadow,
    colors.wordmarkShadow,
  ];

  return source.map((line, index) => {
    const canvasLine = line + ' '.repeat(Math.max(0, sourceWidth - visibleWidth(line)));
    const row = index % 7;
    const color = isCharacterWordmark ? (gradient[row] ?? colors.brand) : colors.brand;
    return centerToWidth(chalk.bold.hex(color)(canvasLine), width);
  });
}
