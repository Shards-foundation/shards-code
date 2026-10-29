import { Key, matchesKey } from '../../engine/public.js';
import type { Component, Focusable } from '../../rendering/component.js';
import { sanitizeTerminalText } from '../../rendering/terminal-text.js';
import { truncateToWidth, wrapTextWithAnsi } from '../../rendering/text.js';
import {
  renderTuiActionHint,
  tuiChalk as chalk,
  tuiColors as colors,
} from '../../theme/runtime.js';
import type {
  TuiFeedbackPhase,
  TuiFeedbackPreview,
  TuiFeedbackReceipt,
  TuiFeedbackSubmitOptions,
} from '../../../runtime/port.js';
import { presentTuiFailure } from '../../../user-facing-failure.js';
import {
  decisionContentWidth,
  renderDecisionFrame,
  renderDecisionHeading,
} from '../interaction/decision-frame.js';

const FEEDBACK_ANIMATION_INTERVAL_MS = 80;
const FEEDBACK_SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'] as const;

type FeedbackPanelState =
  | { status: 'review' }
  | {
      status: 'submitting';
      startedAtMs: number;
      phase: TuiFeedbackPhase;
      cancelRequested: boolean;
    }
  | { status: 'cancelled' }
  | { status: 'failed'; message: string; diagnostic?: string }
  | { status: 'succeeded'; receipt: TuiFeedbackReceipt };

export interface TuiFeedbackPanelOptions {
  readonly preview: TuiFeedbackPreview;
  readonly maxRows?: number | (() => number);
  readonly submit: (
    draftId: string,
    options?: TuiFeedbackSubmitOptions,
  ) => Promise<TuiFeedbackReceipt>;
  readonly cancel: (draftId: string) => Promise<unknown>;
  readonly requestRender: () => void;
  readonly onClose: () => void;
  readonly now?: () => number;
}

/** Explicit consent and progress surface for the Runtime-owned feedback draft. */
export class TuiFeedbackPanel implements Component, Focusable {
  private state: FeedbackPanelState = { status: 'review' };
  private detailsExpanded = false;
  private diagnosticsIncluded: boolean;
  private frameIndex = 0;
  private animationTimer: ReturnType<typeof setInterval> | undefined;
  private closed = false;
  private disposed = false;
  focused = false;

  constructor(private readonly options: TuiFeedbackPanelOptions) {
    this.diagnosticsIncluded =
      options.preview.diagnosticBundleAvailable && options.preview.diagnosticBundleIncluded;
  }

  handleInput(data: string): void {
    if (this.state.status === 'submitting') {
      if (matchesKey(data, 'd')) this.toggleDetails();
      if (
        !this.state.cancelRequested &&
        (matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl('c')))
      ) {
        this.requestCancel();
      }
      return;
    }
    if (matchesKey(data, 'd')) {
      this.toggleDetails();
      return;
    }
    if (
      matchesKey(data, 'i') &&
      this.options.preview.diagnosticBundleAvailable &&
      (this.state.status === 'review' || this.state.status === 'failed')
    ) {
      this.diagnosticsIncluded = !this.diagnosticsIncluded;
      this.options.requestRender();
      return;
    }
    if (matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl('c'))) {
      if (this.state.status === 'succeeded' || this.state.status === 'cancelled') this.close();
      else this.cancelAndClose();
      return;
    }
    if (!matchesKey(data, Key.enter)) return;
    if (this.state.status === 'review' || this.state.status === 'failed') {
      void this.submit();
    } else if (this.state.status === 'succeeded' || this.state.status === 'cancelled') {
      this.close();
    }
  }

  invalidate(): void {}

  render(width: number): string[] {
    const contentWidth = decisionContentWidth(width);
    if (contentWidth === 0) return renderDecisionFrame([''], width, this.tone());
    const lines =
      this.state.status === 'review'
        ? this.renderReview(contentWidth)
        : this.state.status === 'submitting'
          ? this.renderSubmitting(contentWidth)
          : this.state.status === 'cancelled'
            ? this.renderCancelled(contentWidth)
            : this.state.status === 'failed'
              ? this.renderFailure(contentWidth)
              : this.renderSuccess(contentWidth);
    return renderDecisionFrame(limitRows(lines, this.options.maxRows), width, this.tone());
  }

  dispose(): void {
    this.disposed = true;
    this.stopAnimation();
  }

  private async submit(): Promise<void> {
    if (this.state.status === 'submitting' || this.closed || this.disposed) return;
    this.frameIndex = 0;
    this.setState({
      status: 'submitting',
      startedAtMs: this.now(),
      phase: 'preparing',
      cancelRequested: false,
    });
    try {
      const receipt = await this.options.submit(this.options.preview.draftId, {
        includeDiagnostics: this.includesDiagnostics(),
        onPhase: (phase) => this.acceptPhase(phase),
      });
      if (!this.closed && !this.disposed) this.setState({ status: 'succeeded', receipt });
    } catch (error) {
      if (this.closed || this.disposed) return;
      if (this.cancelWasRequested()) {
        this.setState({ status: 'cancelled' });
        return;
      }
      const presentation = presentTuiFailure(error, {
        summary: "Feedback couldn't be sent.",
        nextStep: 'Retry, or close this panel and try again later.',
        preservation: 'The reviewed draft is still available.',
      });
      this.detailsExpanded = false;
      this.setState({
        status: 'failed',
        message: presentation.message,
        ...(presentation.diagnostic ? { diagnostic: presentation.diagnostic } : {}),
      });
    }
  }

  private requestCancel(): void {
    if (this.state.status !== 'submitting' || this.state.cancelRequested) return;
    this.setState({ ...this.state, cancelRequested: true });
    void this.options.cancel(this.options.preview.draftId).catch(() => undefined);
  }

  private cancelAndClose(): void {
    if (this.closed) return;
    this.closed = true;
    this.stopAnimation();
    void this.options.cancel(this.options.preview.draftId).catch(() => undefined);
    this.options.onClose();
  }

  private close(): void {
    if (this.closed) return;
    this.closed = true;
    this.stopAnimation();
    this.options.onClose();
  }

  private acceptPhase(phase: TuiFeedbackPhase): void {
    if (
      this.disposed ||
      this.state.status !== 'submitting' ||
      this.state.cancelRequested ||
      phase === 'completed'
    ) {
      return;
    }
    this.setState({ ...this.state, phase });
  }

  private renderReview(width: number): string[] {
    const includesDiagnostics = this.includesDiagnostics();
    return [
      renderDecisionHeading('Review feedback', 'Ready to send', width, 'signal'),
      ...renderWrapped(this.options.preview.description, width, colors.text, true),
      '',
      chalk.hex(colors.dim)('What will be sent'),
      ...renderWrapped(
        `Feedback text, bounded device and Runtime details${includesDiagnostics ? ', and diagnostic counts with original contents omitted' : ''}.`,
        width,
        colors.muted,
      ),
      ...renderWrapped(
        includesDiagnostics
          ? 'No raw attachments, conversation text, prompts, tool output, paths, or free-text logs are uploaded. Review your feedback text before sending.'
          : 'Credentials, canonical messages.jsonl history, and workspace files stay out.',
        width,
        colors.success,
      ),
      ...renderWrapped(
        this.options.preview.diagnosticBundleAvailable
          ? `Diagnostics: ${includesDiagnostics ? 'included (minimized counts only)' : 'unchecked (not included)'}`
          : 'Diagnostics: unavailable and not included',
        width,
        includesDiagnostics ? colors.signal : colors.success,
      ),
      ...this.renderDetails(width),
      '',
      chalk.bold.hex(colors.signal)('› Send feedback'),
      renderTuiActionHint(
        fit(
          `Enter send · ${this.options.preview.diagnosticBundleAvailable ? 'i diagnostics · ' : ''}d details · Esc cancel`,
          width,
        ),
      ),
    ];
  }

  private renderSubmitting(width: number): string[] {
    const frame = FEEDBACK_SPINNER_FRAMES[this.frameIndex] ?? FEEDBACK_SPINNER_FRAMES[0];
    const state = this.state.status === 'submitting' ? this.state : undefined;
    if (!state) return [];
    const elapsedSeconds = Math.max(0, Math.floor((this.now() - state.startedAtMs) / 1_000));
    if (state.cancelRequested) {
      return [
        renderDecisionHeading(
          `${frame} Cancelling safely`,
          elapsedSeconds > 0 ? `${elapsedSeconds}s` : undefined,
          width,
          'signal',
        ),
        ...renderWrapped(
          'Stopping the active upload and waiting for the Runtime to confirm cancellation.',
          width,
          colors.muted,
        ),
        ...this.renderDetails(width),
        '',
        renderTuiActionHint(fit('Please wait · d details', width)),
      ];
    }
    return [
      renderDecisionHeading(
        `${frame} Sending feedback`,
        elapsedSeconds > 0 ? `${elapsedSeconds}s` : undefined,
        width,
        'signal',
      ),
      ...this.renderProgress(state.phase, width),
      '',
      ...renderWrapped(phaseDescription(state.phase), width, colors.muted),
      ...this.renderDetails(width),
      '',
      renderTuiActionHint(fit('Esc cancel safely · d details', width)),
    ];
  }

  private renderCancelled(width: number): string[] {
    return [
      renderDecisionHeading('✓ Upload cancelled', undefined, width, 'success'),
      ...renderWrapped(
        'The upload was stopped. If cancellation happened late, check My Feedback before retrying.',
        width,
        colors.muted,
      ),
      '',
      renderTuiActionHint(fit('Enter/Esc close', width)),
    ];
  }

  private renderFailure(width: number): string[] {
    const state = this.state.status === 'failed' ? this.state : undefined;
    if (!state) return [];
    return [
      renderDecisionHeading('× Feedback not sent', undefined, width, 'error'),
      ...renderWrapped(state.message, width, colors.error),
      ...(state.diagnostic ? renderWrapped(state.diagnostic, width, colors.muted) : []),
      ...this.renderDetails(width),
      '',
      chalk.bold.hex(colors.signal)('› Retry'),
      renderTuiActionHint(fit('Enter retry · d details · Esc close', width)),
    ];
  }

  private renderSuccess(width: number): string[] {
    const receipt = this.state.status === 'succeeded' ? this.state.receipt : undefined;
    if (!receipt) return [];
    return [
      renderDecisionHeading('✓ Feedback sent', receipt.status, width, 'success'),
      ...(receipt.ticketId
        ? [
            chalk.bold.hex(colors.text)(
              fit(`Ticket ${sanitizeTerminalText(receipt.ticketId)}`, width),
            ),
          ]
        : []),
      ...renderWrapped('Your feedback was created successfully.', width, colors.muted),
      ...this.renderDetails(width, receipt),
      '',
      renderTuiActionHint(fit('Enter/Esc close · d details', width)),
    ];
  }

  private renderProgress(phase: TuiFeedbackPhase, width: number): string[] {
    const steps: ReadonlyArray<{ phase: TuiFeedbackPhase; label: string }> = [
      { phase: 'preparing', label: 'Preparing details' },
      ...(this.includesDiagnostics()
        ? [{ phase: 'uploading-diagnostics' as const, label: 'Uploading diagnostics' }]
        : []),
      { phase: 'creating-ticket', label: 'Creating ticket' },
    ];
    const currentIndex = Math.max(
      0,
      steps.findIndex((step) => step.phase === phase),
    );
    return steps.map((step, index) => {
      if (index < currentIndex) return chalk.hex(colors.success)(fit(`✓ ${step.label}`, width));
      if (index === currentIndex) {
        return chalk.bold.hex(colors.signal)(fit(`● ${step.label}`, width));
      }
      return chalk.hex(colors.dim)(fit(`○ ${step.label}`, width));
    });
  }

  private renderDetails(width: number, receipt?: TuiFeedbackReceipt): string[] {
    if (!this.detailsExpanded) return [];
    const included = [...this.options.preview.included];
    const excluded = [...this.options.preview.excluded];
    if (this.options.preview.diagnosticBundleAvailable) {
      const target = this.includesDiagnostics() ? included : excluded;
      target.push(
        this.includesDiagnostics()
          ? 'minimized diagnostic counts from selected local records'
          : 'optional minimized diagnostic counts (not included)',
      );
    }
    const diagnostics = this.options.preview.diagnostics.flatMap((row) =>
      renderWrapped(
        `${sanitizeTerminalText(row.label)}  ${sanitizeTerminalText(row.value)}`,
        width,
        colors.muted,
      ),
    );
    return [
      '',
      chalk.hex(colors.dim)('Details'),
      ...diagnostics,
      ...(receipt?.uploadId
        ? renderWrapped(`Upload ID  ${sanitizeTerminalText(receipt.uploadId)}`, width, colors.muted)
        : []),
      chalk.hex(colors.dim)('Included'),
      ...renderWrapped(
        included.map(sanitizeTerminalText).join(' · '),
        width,
        colors.muted,
      ),
      chalk.hex(colors.dim)('Excluded'),
      ...renderWrapped(
        excluded.map(sanitizeTerminalText).join(' · '),
        width,
        colors.success,
      ),
    ];
  }

  private includesDiagnostics(): boolean {
    return this.diagnosticsIncluded;
  }

  private cancelWasRequested(): boolean {
    return this.state.status === 'submitting' && this.state.cancelRequested;
  }

  private setState(state: FeedbackPanelState): void {
    this.state = state;
    if (state.status === 'submitting') this.startAnimation();
    else this.stopAnimation();
    this.options.requestRender();
  }

  private startAnimation(): void {
    if (this.animationTimer) return;
    this.animationTimer = setInterval(() => {
      this.frameIndex = (this.frameIndex + 1) % FEEDBACK_SPINNER_FRAMES.length;
      this.options.requestRender();
    }, FEEDBACK_ANIMATION_INTERVAL_MS);
    this.animationTimer.unref?.();
  }

  private stopAnimation(): void {
    if (!this.animationTimer) return;
    clearInterval(this.animationTimer);
    this.animationTimer = undefined;
  }

  private toggleDetails(): void {
    this.detailsExpanded = !this.detailsExpanded;
    this.options.requestRender();
  }

  private tone(): 'signal' | 'error' | 'success' {
    if (this.state.status === 'failed') return 'error';
    if (this.state.status === 'succeeded' || this.state.status === 'cancelled') return 'success';
    return 'signal';
  }

  private now(): number {
    return this.options.now?.() ?? Date.now();
  }
}

function phaseDescription(phase: TuiFeedbackPhase): string {
  if (phase === 'uploading-diagnostics')
    return 'Uploading the reviewed, redacted diagnostic bundle.';
  if (phase === 'creating-ticket')
    return 'Creating the feedback ticket and waiting for its receipt.';
  return 'Checking the reviewed data and account before upload.';
}

function renderWrapped(value: string, width: number, color: string, bold = false): string[] {
  const text = bold ? chalk.bold.hex(color)(value) : chalk.hex(color)(value);
  return wrapTextWithAnsi(text, Math.max(1, width)).map((line) => fit(line, width));
}

function fit(value: string, width: number): string {
  return truncateToWidth(value, Math.max(0, width), '…');
}

function limitRows(
  lines: readonly string[],
  maxRowsOption: number | (() => number) | undefined,
): readonly string[] {
  if (maxRowsOption === undefined) return lines;
  const maxRows = Math.max(
    4,
    Math.floor(typeof maxRowsOption === 'function' ? maxRowsOption() : maxRowsOption),
  );
  if (lines.length <= maxRows) return lines;
  return [...lines.slice(0, maxRows - 2), chalk.hex(colors.dim)('…'), lines.at(-1) ?? ''];
}
