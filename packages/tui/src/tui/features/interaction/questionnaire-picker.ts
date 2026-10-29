import { Text, matchesKey } from '../../engine/public.js';
import type { Component, Focusable } from '../../rendering/component.js';
import {
  applyBackgroundToLine,
  stripAnsi,
  truncateToWidth,
  visibleWidth,
  wrapTextWithAnsi,
} from '../../rendering/text.js';
import { Input } from '../../widgets/input.js';
import type { ActiveTuiQuestionnaire } from '../../interaction/questionnaire.js';
import { isQuestionnaireComplete } from '../../interaction/questionnaire.js';
import { sanitizeTerminalText } from '../../rendering/terminal-text.js';
import { tuiChalk as chalk, tuiColors as colors } from '../../theme/runtime.js';
import { questionnaireFrameContentWidth, renderQuestionnaireFrame } from './decision-frame.js';

export interface TuiQuestionnairePickerOptions {
  /** Called immediately after the final answer is recorded. */
  onSubmit?: () => void;
  /** Optional explicit dismiss action. */
  onDismiss?: () => void;
  /** Force a redraw when a confirmation-only state changes without changing focus. */
  requestRender?: (force?: boolean) => void;
  /** Injectable clock for deterministic countdown rendering. */
  now?: () => number;
}

type QuestionnairePickerMode = 'answer' | 'text';

const GOAL_AUTO_REPLY_COUNTDOWN_TICK_MS = 1_000;
const SECONDS_PER_MINUTE = 60;

export class TuiQuestionnairePicker implements Component, Focusable {
  private stepIndex: number;
  private mode: QuestionnairePickerMode;
  private readonly input = new Input();
  private _focused = false;
  private readonly multiSelected = new Set<number>();
  private readonly textDrafts = new Map<number, string>();
  private singleIndex = 0;
  private multiIndex = 0;
  private confirmDismiss = false;
  private dismissing = false;
  private submitting = false;
  private viewportOptionRows: number | undefined;
  private readonly onSubmit?: () => void;
  private readonly onDismiss?: () => void;
  private readonly requestRender?: (force?: boolean) => void;
  private readonly now: () => number;
  private countdownTimer: ReturnType<typeof setInterval> | undefined;

  get focused(): boolean {
    return this._focused;
  }

  set focused(value: boolean) {
    this._focused = value;
    this.syncInputFocus();
  }

  constructor(
    private readonly state: ActiveTuiQuestionnaire,
    private readonly onAnswer: (stepIndex: number, answer: string) => void,
    private readonly onCancel: () => void,
    options: TuiQuestionnairePickerOptions = {},
  ) {
    this.onSubmit = options.onSubmit;
    this.onDismiss = options.onDismiss;
    this.requestRender = options.requestRender;
    this.now = options.now ?? Date.now;
    this.stepIndex = resolveInitialQuestionIndex(state);
    this.mode = 'answer';
    this.configureStep();
    this.startCountdown();
    this.input.onSubmit = (value) => {
      if (this.mode !== 'text') return;
      const answer = value.trim();
      if (answer) this.commitAnswer(answer);
    };
    this.input.onEscape = () => {
      if (this.mode === 'text' && (this.step?.options?.length ?? 0) > 0) {
        this.rememberTextDraft();
        this.mode = 'answer';
        this.configureStep();
      } else {
        this.requestDismissConfirmation();
      }
    };
  }

  handleInput(data: string): void {
    if (this.dismissing || this.submitting) return;
    if (matchesKey(data, 'ctrl+c')) {
      this.onCancel();
      return;
    }
    if (this.confirmDismiss) {
      if (matchesKey(data, 'enter')) {
        this.confirmDismiss = false;
        this.syncInputFocus();
        this.invalidate();
        this.requestRender?.(true);
        this.onDismiss?.();
      } else if (matchesKey(data, 'escape')) {
        this.confirmDismiss = false;
        this.syncInputFocus();
        this.invalidate();
        this.requestRender?.(true);
      }
      return;
    }
    if (!this.step) {
      if (matchesKey(data, 'escape')) this.requestDismissConfirmation();
      return;
    }
    if (matchesKey(data, 'tab') || (this.mode !== 'text' && matchesKey(data, 'right'))) {
      this.moveStep(1);
      return;
    }
    if (
      (matchesKey(data, 'shift+tab') || (this.mode !== 'text' && matchesKey(data, 'left'))) &&
      allowsBackNavigation(this.state)
    ) {
      this.moveStep(-1);
      return;
    }
    if (this.mode === 'text') {
      this.input.handleInput(data);
      return;
    }
    if (!isMultipleSelection(this.step.selectionMode)) {
      const options = this.step.options ?? [];
      const choiceCount = options.length + (this.step.allowOther ? 1 : 0);
      if (matchesKey(data, 'up')) {
        this.singleIndex = this.singleIndex === 0 ? choiceCount - 1 : this.singleIndex - 1;
        return;
      }
      if (matchesKey(data, 'down')) {
        this.singleIndex = this.singleIndex === choiceCount - 1 ? 0 : this.singleIndex + 1;
        return;
      }
      if (/^[1-9]$/u.test(data)) {
        const index = Number(data) - 1;
        if (index >= 0 && index < options.length) {
          this.commitAnswer(String(index + 1));
          return;
        }
        if (this.step.allowOther && index === options.length) {
          this.openTextInput();
          return;
        }
      }
      if (matchesKey(data, 'enter')) {
        if (this.singleIndex < options.length) this.commitAnswer(String(this.singleIndex + 1));
        else if (this.step.allowOther) this.openTextInput();
        return;
      }
      if (this.step.allowOther && data.toLocaleLowerCase() === 'o') {
        this.openTextInput();
        return;
      }
      if (matchesKey(data, 'escape')) this.requestDismissConfirmation();
      return;
    }

    const options = this.step.options ?? [];
    const choiceCount = options.length + (this.step.allowOther ? 1 : 0);
    if (matchesKey(data, 'up')) {
      if (choiceCount > 0) {
        this.multiIndex = this.multiIndex === 0 ? choiceCount - 1 : this.multiIndex - 1;
      }
      return;
    }
    if (matchesKey(data, 'down')) {
      if (choiceCount > 0) {
        this.multiIndex = this.multiIndex === choiceCount - 1 ? 0 : this.multiIndex + 1;
      }
      return;
    }
    if (/^[1-9]$/u.test(data)) {
      const index = Number(data) - 1;
      if (index >= 0 && index < options.length) {
        this.multiIndex = index;
        this.toggleMultiChoice(index);
      }
      return;
    }
    if (matchesKey(data, 'space')) {
      if (this.multiIndex < options.length) this.toggleMultiChoice(this.multiIndex);
      else if (this.step.allowOther) this.openTextInput();
      return;
    }
    if (matchesKey(data, 'enter')) {
      if (this.multiIndex === options.length && this.step.allowOther) {
        this.openTextInput();
      } else if (this.multiSelected.size === 0 && options[this.multiIndex]) {
        this.commitAnswer(String(this.multiIndex + 1));
      } else if (this.multiSelected.size > 0) {
        this.commitAnswer(
          [...this.multiSelected]
            .sort((left, right) => left - right)
            .map((index) => String(index + 1))
            .join(','),
        );
      }
      return;
    }
    if (this.step.allowOther && data.toLocaleLowerCase() === 'o') {
      this.mode = 'text';
      this.configureTextInput();
      return;
    }
    if (matchesKey(data, 'escape')) this.requestDismissConfirmation();
  }

  invalidate(): void {
    this.input.invalidate();
  }

  beginDismiss(): boolean {
    if (this.dismissing) return false;
    this.confirmDismiss = false;
    this.dismissing = true;
    this.stopCountdown();
    this.syncInputFocus();
    this.invalidate();
    this.requestRender?.(true);
    return true;
  }

  beginSubmitting(): void {
    this.submitting = true;
    this.stopCountdown();
    this.syncInputFocus();
    this.invalidate();
    this.requestRender?.(true);
  }

  render(width: number): string[] {
    const safeWidth = Math.max(0, width);
    if (safeWidth === 0) return [];
    const contentWidth = questionnaireFrameContentWidth(safeWidth);
    const progressMeta = renderQuestionnaireProgressMeta(this.state, this.stepIndex);
    if (this.submitting) {
      return renderQuestionnaireFrame(
        {
          title: 'Ask',
          meta: progressMeta,
          body: [
            chalk.bold.hex(colors.text)('Sending answers…'),
            chalk.hex(colors.muted)('Waiting for Shards Code to continue the conversation.'),
          ],
        },
        safeWidth,
        'signal',
      );
    }
    if (this.dismissing) {
      return renderQuestionnaireFrame(
        {
          title: 'Ask',
          meta: progressMeta,
          body: [
            chalk.bold.hex(colors.text)('Closing question…'),
            fitLine(
              chalk.hex(colors.muted)('Waiting for Shards Code to dismiss the pending request.'),
              contentWidth,
            ),
          ],
        },
        safeWidth,
        'signal',
      );
    }
    if (this.confirmDismiss) {
      return renderQuestionnaireFrame(
        {
          title: 'Cancel this question?',
          body: [
            fitLine(
              chalk.hex(colors.muted)(
                'The pending request and its unsent answers will be discarded.',
              ),
              contentWidth,
            ),
          ],
          footer: fitLine('Enter cancel question · Esc keep answering', contentWidth),
        },
        safeWidth,
        'warning',
      );
    }
    if (!this.step) {
      return renderQuestionnaireFrame(
        {
          title: 'Ask',
          meta: progressMeta,
          body: [
            fitLine(chalk.hex(colors.muted)('All questionnaire steps are answered.'), contentWidth),
          ],
        },
        safeWidth,
        'signal',
      );
    }

    const heading = this.step.header ?? this.state.request.title;
    const answered = this.state.answers.get(this.step.id);
    const progress = renderQuestionnaireProgress(this.state, this.stepIndex, contentWidth);
    const autoReplyRemainingSeconds = this.goalAutoReplyRemainingSeconds();
    const showHeading = Boolean(heading) && progress.length === 0;
    const lines = [
      ...(showHeading && heading
        ? new Text(chalk.hex(colors.muted)(sanitizeTerminalText(heading)), 0, 0).render(
            contentWidth,
          )
        : []),
      ...new Text(
        chalk.bold.hex(colors.text)(sanitizeTerminalText(this.step.question)),
        0,
        0,
      ).render(contentWidth),
      ...(this.step.description
        ? new Text(
            chalk.hex(colors.muted)(sanitizeTerminalText(this.step.description)),
            0,
            0,
          ).render(contentWidth)
        : []),
      ...(autoReplyRemainingSeconds !== undefined
        ? renderGoalAutoReplyCountdown(autoReplyRemainingSeconds, contentWidth)
        : []),
      ...(answered
        ? [
            fitLine(
              chalk.hex(colors.success)(`Saved answer · ${sanitizeTerminalText(answered.rawText)}`),
              contentWidth,
            ),
          ]
        : []),
      '',
    ];

    if (this.mode === 'text') {
      return renderQuestionnaireFrame(
        {
          title: 'Ask',
          meta: progressMeta,
          navigation: progress,
          body: [
            ...lines,
            ...this.input.render(contentWidth).map((line) => fitLine(line, contentWidth)),
          ],
          footer: fitLine(
            `Type your answer · Enter ${
              isLastUnansweredQuestion(this.state, this.step.id) ? 'send' : 'next'
            } · Esc ${(this.step.options?.length ?? 0) > 0 ? 'back' : 'cancel'}`,
            contentWidth,
          ),
        },
        safeWidth,
        'signal',
      );
    }
    if (!isMultipleSelection(this.step.selectionMode)) {
      return renderQuestionnaireFrame(
        {
          title: 'Ask',
          meta: progressMeta,
          navigation: progress,
          body: [...lines, ...this.renderSingleOptions(this.step.options ?? [], contentWidth)],
          footer: fitLine(
            buildQuestionnaireFooter(
              contentWidth,
              `↑↓ move · 1-${Math.min(
                9,
                (this.step.options?.length ?? 0) + (this.step.allowOther ? 1 : 0),
              )} select · Enter ${
                isLastUnansweredQuestion(this.state, this.step.id) ? 'send' : 'next'
              }`,
              allowsBackNavigation(this.state),
            ),
            contentWidth,
          ),
        },
        safeWidth,
        'signal',
      );
    }

    const options = this.step.options ?? [];
    return renderQuestionnaireFrame(
      {
        title: 'Ask',
        meta: progressMeta,
        navigation: progress,
        body: [
          ...lines,
          ...this.renderMultiOptions(options, contentWidth),
          ...(this.step.allowOther ? [this.renderMultiOther(options.length, contentWidth)] : []),
        ],
        footer: fitLine(
          buildQuestionnaireFooter(
            contentWidth,
            `↑↓ move · Space toggle · Enter ${
              isLastUnansweredQuestion(this.state, this.step.id) ? 'send' : 'next'
            }`,
            allowsBackNavigation(this.state),
          ),
          contentWidth,
        ),
      },
      safeWidth,
      'signal',
    );
  }

  renderViewport(width: number, rawHeight: number): readonly string[] {
    const safeWidth = Math.max(0, Math.floor(width));
    const height = Math.max(1, Math.floor(rawHeight));
    if (safeWidth === 0) return [];
    this.viewportOptionRows = Math.max(1, height - 9);
    try {
      return clipQuestionnaireViewport(this.render(safeWidth), height);
    } finally {
      this.viewportOptionRows = undefined;
    }
  }

  dispose(): void {
    this.stopCountdown();
  }

  private renderSingleOptions(
    options: readonly NonNullable<
      ActiveTuiQuestionnaire['request']['steps'][number]['options']
    >[number][],
    width: number,
  ): string[] {
    const choices = [
      ...options.map((option, index) => ({
        label: this.optionLabel(option),
        description: option.description,
        number: index + 1,
      })),
      ...(this.step?.allowOther
        ? [
            {
              label: 'Other…',
              description: this.step.otherPlaceholder ?? 'Type another answer',
              number: options.length + 1,
            },
          ]
        : []),
    ];
    const visibleChoices = questionnaireChoiceWindow(
      choices,
      this.singleIndex,
      this.viewportOptionRows,
    );
    const lines: string[] = [];
    const labelColumnWidth = questionOptionLabelColumnWidth(
      visibleChoices.items.map((choice) => choice.label),
      width,
    );
    if (visibleChoices.start > 0) {
      lines.push(fitLine(chalk.hex(colors.dim)(`  … ${visibleChoices.start} more above`), width));
    }
    for (const [offset, choice] of visibleChoices.items.entries()) {
      const index = visibleChoices.start + offset;
      const selected = index === this.singleIndex;
      const prefix = `${selected ? '›' : ' '} ${choice.number}  `;
      lines.push(
        ...renderQuestionnaireOptionRow({
          prefix,
          label: choice.label,
          description: this.viewportOptionRows === undefined ? choice.description : undefined,
          width,
          labelColumnWidth,
          focused: selected,
        }),
      );
    }
    if (visibleChoices.end < choices.length) {
      lines.push(
        fitLine(
          chalk.hex(colors.dim)(`  … ${choices.length - visibleChoices.end} more below`),
          width,
        ),
      );
    }
    return lines;
  }

  private renderMultiOptions(
    options: readonly NonNullable<
      ActiveTuiQuestionnaire['request']['steps'][number]['options']
    >[number][],
    width: number,
  ): string[] {
    const maxVisible = Math.max(1, Math.min(6, this.viewportOptionRows ?? 6));
    const start = Math.max(
      0,
      Math.min(this.multiIndex - Math.floor(maxVisible / 2), options.length - maxVisible),
    );
    const end = Math.min(options.length, start + maxVisible);
    const lines: string[] = [];
    const labelColumnWidth = questionOptionLabelColumnWidth(
      options.slice(start, end).map((option) => this.optionLabel(option)),
      width,
    );
    if (start > 0) lines.push(fitLine(chalk.hex(colors.dim)(`  … ${start} more above`), width));
    for (let index = start; index < end; index += 1) {
      const option = options[index];
      if (!option) continue;
      const cursor = index === this.multiIndex ? '→' : ' ';
      const checked = this.multiSelected.has(index) ? '●' : '○';
      lines.push(
        ...renderQuestionnaireOptionRow({
          prefix: `${cursor} ${checked} ${index + 1}  `,
          label: this.optionLabel(option),
          description: this.viewportOptionRows === undefined ? option.description : undefined,
          width,
          labelColumnWidth,
          focused: index === this.multiIndex,
        }),
      );
    }
    if (end < options.length) {
      lines.push(fitLine(chalk.hex(colors.dim)(`  … ${options.length - end} more below`), width));
    }
    return lines;
  }

  private renderMultiOther(index: number, width: number): string {
    const selected = index === this.multiIndex;
    const prefix = `${selected ? '→' : ' '}   o  `;
    const label = 'Other…';
    return highlightQuestionnaireOption(
      selected
        ? `${chalk.bold.hex(colors.signal)(prefix)}${chalk.bold.hex(colors.signal)(label)}`
        : chalk.hex(colors.muted)(`${prefix}${label}`),
      width,
      selected,
    );
  }

  private get step(): ActiveTuiQuestionnaire['request']['steps'][number] | undefined {
    return this.state.request.steps[this.stepIndex];
  }

  private optionLabel(
    option: NonNullable<ActiveTuiQuestionnaire['request']['steps'][number]['options']>[number],
  ): string {
    return this.goalAutoReplyRemainingSeconds() !== undefined && option.recommended === true
      ? `${option.label} (Recommended)`
      : option.label;
  }

  private configureStep(): void {
    const step = this.step;
    this.multiSelected.clear();
    this.singleIndex = 0;
    this.multiIndex = 0;
    this.syncInputFocus();
    if (!step || this.mode === 'text') return;

    const options = step.options ?? [];
    const draft = this.state.answers.get(step.id);
    if (isMultipleSelection(step.selectionMode)) {
      const selectedIds = new Set(draft?.answer.selectedOptionIds ?? []);
      for (const [index, option] of options.entries()) {
        if (selectedIds.has(option.id)) this.multiSelected.add(index);
      }
      const firstSelected = [...this.multiSelected][0];
      this.multiIndex = draft?.answer.selectedOther
        ? options.length
        : Math.min(options.length - 1, Math.max(0, firstSelected ?? 0));
      return;
    }
    if (options.length === 0) {
      this.mode = 'text';
      this.configureTextInput();
      return;
    }
    this.input.setValue('');
    const selectedId = draft?.answer.selectedOptionIds?.[0];
    const selectedIndex = selectedId
      ? options.findIndex((option) => option.id === selectedId)
      : draft?.answer.selectedOther
        ? options.length
        : 0;
    this.singleIndex = Math.max(0, selectedIndex);
  }

  private openTextInput(): void {
    this.mode = 'text';
    this.configureTextInput();
  }

  private requestDismissConfirmation(): void {
    if (!this.onDismiss) {
      this.onCancel();
      return;
    }
    this.confirmDismiss = true;
    this.syncInputFocus();
    this.invalidate();
    this.requestRender?.(true);
  }

  private configureTextInput(): void {
    const draft = this.state.answers.get(this.step?.id ?? '');
    this.input.setValue(this.textDrafts.get(this.stepIndex) ?? draft?.answer.otherText ?? '');
    this.syncInputFocus();
  }

  private commitAnswer(answer: string): void {
    this.onAnswer(this.stepIndex, answer);
    if (isQuestionnaireComplete(this.state)) {
      this.input.focused = false;
      this.onSubmit?.();
      return;
    }
    this.stepIndex = findNextQuestionIndex(this.state, this.stepIndex);
    this.mode = 'answer';
    this.configureStep();
  }

  private syncInputFocus(): void {
    this.input.focused =
      this._focused &&
      this.mode === 'text' &&
      !this.confirmDismiss &&
      !this.dismissing &&
      !this.submitting;
  }

  private moveStep(direction: -1 | 1): void {
    const count = this.state.request.steps.length;
    if (count === 0) return;
    this.rememberTextDraft();
    this.stepIndex = (this.stepIndex + direction + count) % count;
    this.mode = 'answer';
    this.configureStep();
  }

  private rememberTextDraft(): void {
    if (this.mode !== 'text' || !this.step) return;
    this.textDrafts.set(this.stepIndex, this.input.getValue());
  }

  private toggleMultiChoice(index: number): void {
    if (this.multiSelected.has(index)) this.multiSelected.delete(index);
    else this.multiSelected.add(index);
  }

  private goalAutoReplyDeadline(): number | undefined {
    const expiresAt = this.state.request.expiresAt;
    return this.state.request.purpose === 'goal' &&
      typeof expiresAt === 'number' &&
      Number.isFinite(expiresAt)
      ? expiresAt
      : undefined;
  }

  private goalAutoReplyRemainingSeconds(): number | undefined {
    const deadline = this.goalAutoReplyDeadline();
    if (deadline === undefined) return undefined;
    return Math.max(0, Math.ceil((deadline - this.now()) / GOAL_AUTO_REPLY_COUNTDOWN_TICK_MS));
  }

  private startCountdown(): void {
    const deadline = this.goalAutoReplyDeadline();
    if (deadline === undefined || deadline <= this.now() || !this.requestRender) return;
    this.countdownTimer = setInterval(() => {
      this.requestRender?.();
      if (deadline <= this.now()) this.stopCountdown();
    }, GOAL_AUTO_REPLY_COUNTDOWN_TICK_MS);
    this.countdownTimer.unref();
  }

  private stopCountdown(): void {
    if (!this.countdownTimer) return;
    clearInterval(this.countdownTimer);
    this.countdownTimer = undefined;
  }
}

function renderGoalAutoReplyCountdown(remainingSeconds: number, width: number): string[] {
  const message =
    remainingSeconds === 0
      ? `${chalk.hex(colors.orbit)('◷')} ${chalk.hex(colors.muted)(
          'Time is up · applying the recommended option…',
        )}`
      : `${chalk.hex(colors.orbit)('◷')} ${chalk.hex(colors.muted)(
          'Auto-continue in ',
        )}${chalk.bold.hex(colors.text)(formatCountdown(remainingSeconds))}${chalk.hex(
          colors.muted,
        )(' with the recommended option')}`;
  return new Text(message, 0, 0).render(width);
}

function formatCountdown(seconds: number): string {
  const minutes = Math.floor(seconds / SECONDS_PER_MINUTE);
  const remainingSeconds = seconds % SECONDS_PER_MINUTE;
  return `${minutes}:${remainingSeconds.toString().padStart(2, '0')}`;
}

function renderQuestionnaireProgressMeta(
  state: ActiveTuiQuestionnaire,
  currentStepIndex: number,
): string | undefined {
  if (state.request.presentation?.showProgress === false) return undefined;
  const total = state.request.steps.length;
  if (total <= 1) return `${Math.min(total, currentStepIndex + 1)} of ${total}`;
  return `${state.answers.size}/${total} answered`;
}

function renderQuestionnaireProgress(
  state: ActiveTuiQuestionnaire,
  currentStepIndex: number,
  width: number,
): string[] {
  if (
    state.request.presentation?.showProgress === false ||
    state.request.steps.length <= 1 ||
    width < 52
  ) {
    return [];
  }
  const steps = state.request.steps;
  const maxVisible = Math.max(1, Math.min(steps.length, Math.floor((width + 1) / 19)));
  const start = Math.max(
    0,
    Math.min(currentStepIndex - Math.floor(maxVisible / 2), steps.length - maxVisible),
  );
  const end = Math.min(steps.length, start + maxVisible);
  const availableWidth = width - (start > 0 ? 2 : 0) - (end < steps.length ? 2 : 0);
  const chipWidth = Math.max(
    8,
    Math.min(18, Math.floor((availableWidth - maxVisible + 1) / maxVisible)),
  );
  const items = steps.slice(start, end).map((step, offset) => {
    const index = start + offset;
    const label = sanitizeTerminalText(step.header ?? `Question ${index + 1}`).trim();
    const marker = index === currentStepIndex ? '●' : state.answers.has(step.id) ? '✓' : '○';
    const truncatedLabel = truncateToWidth(label, Math.max(1, chipWidth - 4), '');
    const rendered = ` ${marker} ${truncatedLabel} `;
    const padded = `${rendered}${' '.repeat(Math.max(0, chipWidth - visibleWidth(rendered)))}`;
    if (index === currentStepIndex) {
      return applyBackgroundToLine(
        ` ${chalk.bold.hex(colors.signal)(marker)} ${chalk.bold.hex(colors.signal)(truncatedLabel)} `,
        chipWidth,
        chalk.bgHex(colors.userMessageBg),
      );
    }
    if (state.answers.has(step.id)) return chalk.hex(colors.success)(padded);
    return chalk.hex(colors.dim)(padded);
  });
  const prefix = start > 0 ? chalk.hex(colors.dim)('… ') : '';
  const suffix = end < steps.length ? chalk.hex(colors.dim)(' …') : '';
  return [`${prefix}${items.join(' ')}${suffix}`];
}

interface QuestionnaireOptionRow {
  readonly prefix: string;
  readonly label: string;
  readonly description?: string;
  readonly width: number;
  readonly labelColumnWidth: number;
  readonly focused: boolean;
}

function renderQuestionnaireOptionRow(row: QuestionnaireOptionRow): string[] {
  const label = sanitizeTerminalText(row.label);
  const description = row.description ? sanitizeTerminalText(row.description) : undefined;
  const styledLabel = row.focused
    ? `${chalk.bold.hex(colors.signal)(row.prefix)}${chalk.bold.hex(colors.signal)(label)}`
    : chalk.hex(colors.text)(`${row.prefix}${label}`);
  const prefixWidth = visibleWidth(row.prefix);
  const canUseColumns =
    Boolean(description) && row.width >= 64 && row.width - prefixWidth - row.labelColumnWidth >= 24;
  if (description && canUseColumns) {
    const descriptionWidth = Math.max(1, row.width - prefixWidth - row.labelColumnWidth - 2);
    const descriptionLines = wrapTextWithAnsi(description, descriptionWidth);
    const labelPadding = ' '.repeat(Math.max(0, row.labelColumnWidth - visibleWidth(label)));
    const indent = ' '.repeat(prefixWidth + row.labelColumnWidth + 2);
    return descriptionLines.map((line, index) => {
      const content =
        index === 0
          ? `${styledLabel}${labelPadding}  ${chalk.hex(colors.muted)(line)}`
          : `${indent}${chalk.hex(colors.muted)(line)}`;
      return highlightQuestionnaireOption(content, row.width, row.focused);
    });
  }

  const lines = [highlightQuestionnaireOption(styledLabel, row.width, row.focused)];
  if (description) {
    const descriptionWidth = Math.max(1, row.width - prefixWidth);
    for (const line of wrapTextWithAnsi(description, descriptionWidth)) {
      lines.push(
        highlightQuestionnaireOption(
          `${' '.repeat(prefixWidth)}${chalk.hex(colors.muted)(line)}`,
          row.width,
          row.focused,
        ),
      );
    }
  }
  return lines;
}

function questionOptionLabelColumnWidth(labels: readonly string[], width: number): number {
  const longest = Math.max(0, ...labels.map((label) => visibleWidth(sanitizeTerminalText(label))));
  return Math.min(longest, Math.max(12, Math.floor(width * 0.32)));
}

function highlightQuestionnaireOption(line: string, width: number, focused: boolean): string {
  const fitted = fitLine(line, width);
  if (!focused) return fitted;
  return applyBackgroundToLine(fitted, width, chalk.bgHex(colors.userMessageBg));
}

function fitLine(line: string, width: number): string {
  return truncateToWidth(line, Math.max(0, width), '');
}

function questionnaireChoiceWindow<T>(
  choices: readonly T[],
  selectedIndex: number,
  rowBudget: number | undefined,
): { readonly items: readonly T[]; readonly start: number; readonly end: number } {
  if (rowBudget === undefined || choices.length <= rowBudget) {
    return { items: choices, start: 0, end: choices.length };
  }
  const visibleCount = Math.max(1, rowBudget - 2);
  const start = Math.max(
    0,
    Math.min(selectedIndex - Math.floor(visibleCount / 2), choices.length - visibleCount),
  );
  const end = Math.min(choices.length, start + visibleCount);
  return { items: choices.slice(start, end), start, end };
}

function clipQuestionnaireViewport(lines: readonly string[], height: number): string[] {
  if (lines.length <= height) return [...lines];
  const selectedRows = new Set<number>();
  const headRows = Math.min(5, Math.max(1, height - 3));
  const tailRows = Math.min(2, Math.max(0, height - headRows));
  for (let index = 0; index < headRows; index += 1) selectedRows.add(index);
  for (let index = Math.max(headRows, lines.length - tailRows); index < lines.length; index += 1) {
    selectedRows.add(index);
  }

  const anchor = lines.findIndex((line) => /[›→]/u.test(stripAnsi(line)));
  if (anchor >= 0) {
    for (let distance = 0; selectedRows.size < height; distance += 1) {
      const before = anchor - distance;
      const after = anchor + distance;
      if (before >= headRows && before < lines.length - tailRows) selectedRows.add(before);
      if (after >= headRows && after < lines.length - tailRows) selectedRows.add(after);
      if (before < headRows && after >= lines.length - tailRows) break;
    }
  }
  for (
    let index = headRows;
    selectedRows.size < height && index < lines.length - tailRows;
    index += 1
  ) {
    selectedRows.add(index);
  }
  return [...selectedRows]
    .sort((left, right) => left - right)
    .slice(0, height)
    .map((index) => lines[index] ?? '');
}

function isMultipleSelection(selectionMode: unknown): boolean {
  return selectionMode === 1 || selectionMode === 'multiple';
}

function allowsBackNavigation(state: ActiveTuiQuestionnaire): boolean {
  return (
    state.request.steps.length > 1 && state.request.presentation?.allowBackNavigation !== false
  );
}

function buildQuestionnaireFooter(width: number, primary: string, canGoBack: boolean): string {
  const primaryAction = /Enter (?:send|next)/u.exec(primary)?.[0] ?? 'Enter';
  const full = `${primary}${canGoBack ? ' · Tab/←/→ questions' : ''} · Esc cancel`;
  const compact = `${primary} · Esc cancel`;
  const narrow = `${primaryAction} · Esc cancel`;
  const narrower = 'Enter · Esc cancel';
  const tiny = 'Enter · Esc';
  return (
    [full, compact, narrow, narrower, tiny].find((candidate) => visibleWidth(candidate) <= width) ??
    tiny
  );
}

function isLastUnansweredQuestion(state: ActiveTuiQuestionnaire, stepId: string): boolean {
  return state.request.steps.every((step) => step.id === stepId || state.answers.has(step.id));
}

function resolveInitialQuestionIndex(state: ActiveTuiQuestionnaire): number {
  const firstUnanswered = state.request.steps.findIndex((step) => !state.answers.has(step.id));
  return firstUnanswered >= 0 ? firstUnanswered : Math.max(0, state.request.steps.length - 1);
}

function findNextQuestionIndex(state: ActiveTuiQuestionnaire, current: number): number {
  const count = state.request.steps.length;
  for (let offset = 1; offset <= count; offset += 1) {
    const index = (current + offset) % count;
    const step = state.request.steps[index];
    if (step && !state.answers.has(step.id)) return index;
  }
  return Math.max(0, Math.min(current, count - 1));
}
