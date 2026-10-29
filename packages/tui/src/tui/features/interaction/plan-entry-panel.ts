import { decodePrintableKey, matchesKey } from '../../engine/public.js';
import type { Component } from '../../rendering/component.js';
import { truncateToWidth } from '../../rendering/text.js';
import { tuiChalk as chalk, tuiColors as colors } from '../../theme/runtime.js';
import { questionnaireFrameContentWidth, renderQuestionnaireFrame } from './decision-frame.js';

export type TuiPlanEntryAction = 'confirm' | 'decline';

const OPTIONS = ['Continue with plan', 'Deny'] as const;

export class TuiPlanEntryPanel implements Component {
  private selectedIndex = 0;
  private submitting: TuiPlanEntryAction | undefined;

  constructor(
    private readonly onAction: (action: TuiPlanEntryAction) => void,
    private readonly requestRender: () => void,
    private readonly availableActions: ReadonlySet<TuiPlanEntryAction> = new Set([
      'confirm',
      'decline',
    ]),
  ) {}

  handleInput(data: string): void {
    if (this.submitting) return;
    if (matchesKey(data, 'up') || matchesKey(data, 'down')) {
      this.selectedIndex = this.selectedIndex === 0 ? 1 : 0;
      this.requestRender();
      return;
    }
    const printable = decodePrintableKey(data) ?? data;
    if (printable === '1') {
      this.submit('confirm');
      return;
    }
    if (printable === '2' || matchesKey(data, 'escape')) {
      this.submit('decline');
      return;
    }
    if (matchesKey(data, 'enter')) this.submit(this.selectedIndex === 0 ? 'confirm' : 'decline');
  }

  beginSubmitting(action: TuiPlanEntryAction): void {
    this.submitting = action;
    this.requestRender();
  }

  restore(): void {
    this.submitting = undefined;
    this.requestRender();
  }

  invalidate(): void {}

  render(width: number): string[] {
    const safeWidth = Math.max(0, width);
    if (safeWidth === 0) return [];
    const contentWidth = questionnaireFrameContentWidth(safeWidth);
    if (this.submitting) {
      return renderQuestionnaireFrame(
        {
          title: 'Plan mode',
          body: [
            chalk.bold.hex(colors.text)(
              this.submitting === 'confirm' ? 'Continuing with plan…' : 'Keeping Default mode…',
            ),
            chalk.hex(colors.muted)('Waiting for Shards Code to continue the conversation.'),
          ],
        },
        safeWidth,
        'signal',
      );
    }
    return renderQuestionnaireFrame(
      {
        title: 'Use Plan mode?',
        body: [
          truncateToWidth(
            chalk.hex(colors.muted)('Plan mode structures complex tasks before execution.'),
            contentWidth,
          ),
          '',
          ...OPTIONS.map((label, index) => {
            const action = index === 0 ? 'confirm' : 'decline';
            const available = this.availableActions.has(action);
            const renderedLabel = available ? label : `${label} (unavailable)`;
            return index === this.selectedIndex
              ? `${chalk.bold.hex(colors.signal)('›')} ${chalk.bold.hex(available ? colors.text : colors.muted)(renderedLabel)}`
              : `  ${chalk.hex(colors.muted)(renderedLabel)}`;
          }),
        ],
        footer: '↑/↓ select · Enter confirm · Esc deny',
      },
      safeWidth,
      'signal',
    );
  }

  private submit(action: TuiPlanEntryAction): void {
    if (!this.availableActions.has(action)) return;
    this.beginSubmitting(action);
    this.onAction(action);
  }
}
