/**
 * The only supported product-facing import boundary for the TUI Engine during migration.
 * Keep Shards Code product code out of the upstream-shaped implementation modules.
 */
export * from './index.js';
export { decodePrintableKey } from './keys.js';
export { getLayoutNode, LAYOUT_NODE, type LayoutNode } from './layout-node.js';
export {
  dispatchLayoutMouseEvent,
  renderLayoutFrame,
  type LayoutFrame,
  type TuiMouseEvent,
} from './layout.js';
export type { InputOptions } from './components/input.js';
export { KillRing } from './kill-ring.js';
export { UndoStack } from './undo-stack.js';
export {
  findWordBackward,
  findWordForward,
  type WordNavigationOptions,
} from './word-navigation.js';
export {
  applyBackgroundToLine,
  cjkBreakRegex,
  extractAnsiCode,
  extractSegments,
  getGraphemeSegmenter,
  getWordSegmenter,
  isPunctuationChar,
  isWhitespaceChar,
  normalizeTerminalOutput,
  PUNCTUATION_REGEX,
  sliceWithWidth,
} from './utils.js';
