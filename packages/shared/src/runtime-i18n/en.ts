export const EN_RUNTIME_TRANSLATIONS = {
  'plan.entry.title': 'Enter Plan Mode',
  'plan.entry.question': 'Enter Plan Mode for this task?',
  'plan.entry.confirm.label': 'Confirm',
  'plan.entry.confirm.description': 'Investigate and prepare a plan before implementation.',
  'plan.entry.decline.label': 'Decline',
  'plan.entry.decline.description': 'Continue without entering Plan Mode.',
  'plan.implementation.display': 'Implement this plan',
  'questionnaire.noAnswer': 'No answer',
  'questionnaire.others': 'Others',
  'update.versionedInstalled':
    'Shards Code {version} is installed. New Shards Code sessions will use it; running sessions can continue normally.',
} as const;

export type RuntimeTranslationKey = keyof typeof EN_RUNTIME_TRANSLATIONS;
export type RuntimeTranslations = Readonly<Record<RuntimeTranslationKey, string>>;
