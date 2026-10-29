export const SHARDS_CODE_WELCOME_PASTE_IMAGE_SHORTCUT = '{paste-image-shortcut}';
const SHARDS_CODE_WELCOME_CHECKIN_TIP = '/checkin claims the daily reward.';

export const SHARDS_CODE_WELCOME_DESIGN = {
  sectionTitles: {
    tips: 'Tips for getting started',
    news: "What's new · /changelog for history",
  },
  tipPool: [
    'Say what you want and how to verify it.',
    `Use @ for files; ${SHARDS_CODE_WELCOME_PASTE_IMAGE_SHORTCUT} for images.`,
    'Run /init to teach Shards Code about this repo.',
    'Use /plan before a change that needs design or investigation.',
    'Use /context to check the current Session context budget.',
    'Use /sessions to resume earlier work.',
    'Use /history to review and branch from earlier prompts.',
    'Use /goal to keep long-running work focused on a finish line.',
    'Use /permission to choose how Shards Code handles tool approvals.',
    'Use /feedback to preview a redacted report before upload.',
    SHARDS_CODE_WELCOME_CHECKIN_TIP,
  ],
  wide: {
    tips: [
      'Say what you want and how to verify it.',
      `Use @ for files; ${SHARDS_CODE_WELCOME_PASTE_IMAGE_SHORTCUT} for images.`,
      'Run /init to teach Shards Code about this repo.',
      SHARDS_CODE_WELCOME_CHECKIN_TIP,
    ],
    news: [
      'Send follow-ups while Shards Code works.',
      '/context shows read-only session context.',
      '/feedback previews before upload.',
    ],
  },
  stacked: {
    tips: [
      'Say what you want and how to verify it.',
      `@ files · ${SHARDS_CODE_WELCOME_PASTE_IMAGE_SHORTCUT} images · /init guidance`,
      '/checkin daily reward',
    ],
    news: ['Follow-ups wait while Shards Code works.', '/context budget · /feedback preview'],
  },
  compact: {
    tips: [
      `@ files · ${SHARDS_CODE_WELCOME_PASTE_IMAGE_SHORTCUT} images`,
      '/init repo guidance',
      '/checkin reward',
    ],
    news: ['Follow-ups wait', '/context · /feedback'],
  },
  hero: {
    fullMinWidth: 91,
    mediumMinWidth: 44,
    microMinWidth: 11,
    fallbackTitle: 'S',
  },
} as const;

const FULL_LETTERS: Record<string, readonly string[]> = {
  S: ['01111', '10000', '10000', '01110', '00001', '00001', '11110'],
  H: ['10001', '10001', '10001', '11111', '10001', '10001', '10001'],
  A: ['01110', '10001', '10001', '11111', '10001', '10001', '10001'],
  R: ['11110', '10001', '10001', '11110', '10100', '10010', '10001'],
  D: ['11110', '10001', '10001', '10001', '10001', '10001', '11110'],
  C: ['01110', '10001', '10000', '10000', '10000', '10001', '01110'],
  O: ['01110', '10001', '10001', '10001', '10001', '10001', '01110'],
  E: ['11111', '10000', '10000', '11110', '10000', '10000', '11111'],
};
const MEDIUM_LETTERS: Record<string, readonly string[]> = {
  S: ['111', '100', '111'],
  H: ['101', '111', '101'],
  A: ['010', '101', '111'],
  R: ['110', '101', '110'],
  D: ['110', '101', '110'],
  C: ['111', '100', '111'],
  O: ['111', '101', '111'],
  E: ['111', '110', '111'],
};

function renderWordmark(letters: Record<string, readonly string[]>): readonly string[] {
  const height = Math.max(...Object.values(letters).map((rows) => rows.length));
  return Array.from({ length: height }, (_, row) =>
    [...'SHARDS', ' ', ...'CODE']
      .map((letter) => (letter === ' ' ? (letters === FULL_LETTERS ? '   ' : '   ') : (letters[letter]?.[row] ?? '')))
      .join(' ')
      .replaceAll('0', ' ')
      .replaceAll('1', '█')
      .trimEnd(),
  );
}

export const SHARDS_CODE_TERMINAL_WORDMARK = renderWordmark(FULL_LETTERS);
export const SHARDS_CODE_TERMINAL_MEDIUM_WORDMARK = renderWordmark(MEDIUM_LETTERS);
export const SHARDS_CODE_TERMINAL_MICRO_WORDMARK = ['◆'] as const;
