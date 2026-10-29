import { Text, matchesKey } from '../../engine/public.js';
import type { Component, Focusable } from '../../rendering/component.js';
import { truncateToWidth, visibleWidth } from '../../rendering/text.js';
import { Input } from '../../widgets/input.js';
import { SelectList, type SelectListTheme } from '../../widgets/select-list.js';
import { sanitizeTerminalText } from '../../rendering/terminal-text.js';
import type { TuiPendingPermission, TuiPermissionDecision } from '../../../runtime/port.js';
import {
  renderTuiActionHint,
  tuiChalk as chalk,
  tuiColors as colors,
  tuiSelectListTheme as baseSelectTheme,
} from '../../theme/runtime.js';
import { renderTuiStructuredPreview } from '../../transcript/presentation/structured-preview.js';
import {
  questionnaireFrameContentWidth,
  renderDecisionFrame,
  renderQuestionnaireFrame,
  type TuiDecisionTone,
} from './decision-frame.js';
import { highlightTuiShellCommand, resolveTuiShellCommand } from '../../theme/shell-command.js';

const DEFAULT_PERMISSION_CONTEXT_LINES = 6;

interface PermissionContextPresentation {
  readonly lines: readonly string[];
  readonly totalLines: number;
  readonly expandable: boolean;
  readonly expanded: boolean;
}

interface PermissionViewportRange {
  readonly start: number;
  readonly end: number;
  readonly visibleTotal: number;
}

interface PermissionFrameModel {
  readonly title: string;
  readonly meta?: string;
  readonly tone: TuiDecisionTone;
  readonly leading: readonly string[];
  readonly evidence: readonly string[];
  readonly trailing: readonly string[];
  readonly footer?: string;
  readonly statusLine?: (range?: PermissionViewportRange) => string | undefined;
}

/**
 * A decision surface deliberately owns focus while it is mounted. The
 * composer stays intact underneath it, so closing a surface never loses a
 * partially typed prompt.
 */
export class TuiPermissionPicker implements Component, Focusable {
  private readonly list: SelectList;
  private readonly decisions: TuiPermissionDecision[];
  private _focused = false;
  private confirmAlways = false;
  private denyFeedback = false;
  private detailsExpanded = false;
  private detailsExpandable = false;
  private submitting: TuiPermissionDecision | undefined;
  private viewportOffset = 0;
  private viewportEvidenceRows = 0;
  private viewportEvidenceLineCount = 0;
  private readonly denyInput = new Input();

  get focused(): boolean {
    return this._focused;
  }

  set focused(value: boolean) {
    this._focused = value;
    this.syncDenyInputFocus();
  }

  constructor(
    private readonly request: TuiPendingPermission,
    private readonly onSelect: (decision: TuiPermissionDecision, feedback?: string) => void,
    private readonly onStop: () => void,
  ) {
    const decisions: Array<{
      value: TuiPermissionDecision;
      label: string;
    }> = [
      {
        value: 'allowOnce',
        label: '1 Allow for this conversation',
      },
      ...(request.allowAlwaysSupported === false
        ? []
        : [
            {
              value: 'allowAlways' as const,
              label: '2 Always allow matching actions',
            },
          ]),
      {
        value: 'deny',
        label:
          request.allowAlwaysSupported === false
            ? '2 Deny and guide Shards Code'
            : '3 Deny and guide Shards Code',
      },
    ];
    this.decisions = decisions.map((item) => item.value);
    this.list = new SelectList(decisions, decisions.length, permissionSelectTheme(), {
      minPrimaryColumnWidth: 22,
      maxPrimaryColumnWidth: 34,
      truncatePrimary: ({ item, maxWidth }) =>
        fitPermissionDecisionLabel(
          item.value as TuiPermissionDecision,
          this.decisions.indexOf(item.value as TuiPermissionDecision) + 1,
          maxWidth,
        ),
    });
    this.list.onSelect = (item) => this.choose(item.value as TuiPermissionDecision);
    this.list.onCancel = () => this.onSelect('deny');
    this.denyInput.onSubmit = (value) => this.onSelect('deny', value.trim() || undefined);
    this.denyInput.onEscape = () => {
      this.denyFeedback = false;
      this.syncDenyInputFocus();
      this.resetViewport();
    };
  }

  handleInput(data: string): void {
    if (this.submitting) return;
    if (matchesKey(data, 'ctrl+c')) {
      this.onStop();
      return;
    }
    if (
      !this.confirmAlways &&
      matchesKey(data, 'ctrl+e') &&
      (this.detailsExpandable || this.detailsExpanded)
    ) {
      this.detailsExpanded = !this.detailsExpanded;
      this.resetViewport();
      return;
    }
    if (this.denyFeedback) {
      this.denyInput.handleInput(data);
      return;
    }
    if (this.confirmAlways) {
      if (matchesKey(data, 'enter')) this.onSelect('allowAlways');
      else if (matchesKey(data, 'escape') || matchesKey(data, 'left')) {
        this.confirmAlways = false;
        this.resetViewport();
      }
      return;
    }

    // The numbered actions are intentionally direct: approval should not
    // require a user to hunt for a focus ring when a tool is waiting.
    if (/^[1-9]$/u.test(data)) {
      const index = Number(data) - 1;
      const decision = this.decisions[index];
      if (decision) this.choose(decision);
      return;
    }
    this.list.handleInput(data);
  }

  invalidate(): void {
    this.list.invalidate();
    this.denyInput.invalidate();
  }

  beginSubmitting(decision: TuiPermissionDecision): void {
    this.submitting = decision;
    this.syncDenyInputFocus();
    this.resetViewport();
    this.invalidate();
  }

  render(width: number): string[] {
    const safeWidth = Math.max(0, Math.floor(width));
    if (safeWidth === 0) return [];
    return renderPermissionFrame(this.buildFrameModel(safeWidth), safeWidth);
  }

  renderViewport(width: number, rawHeight: number): readonly string[] {
    const safeWidth = Math.max(0, Math.floor(width));
    const height = Math.max(1, Math.floor(rawHeight));
    if (safeWidth === 0) return [];

    const model = this.buildFrameModel(safeWidth);
    const rendered = renderPermissionFrame(model, safeWidth);
    if (rendered.length <= height) {
      this.resetViewport();
      return rendered;
    }

    const compactModel: PermissionFrameModel = {
      ...model,
      leading: trimTrailingBlankLines(model.leading),
      trailing: trimLeadingBlankLines(model.trailing),
    };
    if (compactModel.evidence.length === 0) {
      return renderCompactPermissionFrame(compactModel, safeWidth).slice(0, height);
    }

    const placeholderRange: PermissionViewportRange = {
      start: 1,
      end: 1,
      visibleTotal: compactModel.evidence.length,
    };
    const fixedRows = renderPermissionFrame(compactModel, safeWidth, [], placeholderRange).length;
    if (fixedRows >= height) {
      this.resetViewport();
      return renderCompactPermissionFrame(compactModel, safeWidth).slice(0, height);
    }

    const evidenceRows = height - fixedRows;
    this.viewportEvidenceRows = evidenceRows;
    this.viewportEvidenceLineCount = compactModel.evidence.length;
    this.viewportOffset = clamp(
      this.viewportOffset,
      0,
      Math.max(0, compactModel.evidence.length - evidenceRows),
    );
    const end = Math.min(compactModel.evidence.length, this.viewportOffset + evidenceRows);
    const range: PermissionViewportRange = {
      start: this.viewportOffset + 1,
      end,
      visibleTotal: compactModel.evidence.length,
    };
    return renderPermissionFrame(
      compactModel,
      safeWidth,
      compactModel.evidence.slice(this.viewportOffset, end),
      range,
    ).slice(0, height);
  }

  scrollByRows(delta: number): number {
    if (this.viewportEvidenceRows === 0) return 0;
    const maximum = Math.max(0, this.viewportEvidenceLineCount - this.viewportEvidenceRows);
    if (maximum === 0) return 0;
    const next = clamp(this.viewportOffset + Math.trunc(delta), 0, maximum);
    const scrolledRows = next - this.viewportOffset;
    this.viewportOffset = next;
    return scrolledRows;
  }

  scrollByPage(direction: -1 | 1): number {
    return this.scrollByRows(direction * Math.max(1, this.viewportEvidenceRows - 1));
  }

  private buildFrameModel(width: number): PermissionFrameModel {
    const contentWidth = questionnaireFrameContentWidth(width);
    const toolName = sanitizeTerminalText(this.request.toolName ?? 'unknown');
    const toolLabel = formatPermissionToolLabel(toolName);
    const tone = permissionDecisionTone(toolName);
    this.detailsExpandable = false;

    if (this.submitting) {
      return {
        title: '◌ Applying permission…',
        meta: toolLabel,
        tone,
        leading: [
          ...new Text(
            chalk.bold.hex(colors.text)(formatPendingPermissionDecision(this.submitting)),
            0,
            0,
          ).render(Math.max(1, contentWidth)),
          ...new Text(
            chalk.hex(colors.muted)('Waiting for Runtime to commit the decision.'),
            0,
            0,
          ).render(Math.max(1, contentWidth)),
        ],
        evidence: [],
        trailing: [],
      };
    }

    if (this.confirmAlways) {
      const rules = renderPermissionRules(this.request, contentWidth);
      return {
        title: '◆ Save permission rule',
        meta: toolLabel,
        tone: 'warning',
        leading: [chalk.bold.hex(colors.text)('Always allow matching actions?'), ''],
        evidence: rules,
        trailing: [
          '',
          ...new Text(
            chalk.hex(colors.muted)('Future matching actions will continue without asking.'),
            0,
            0,
          ).render(Math.max(1, contentWidth)),
        ],
        footer: buildAlwaysConfirmationFooter(contentWidth),
        statusLine: (range) =>
          range ? buildViewportStatus('Scope', range, rules.length, contentWidth) : undefined,
      };
    }

    if (this.denyFeedback) {
      const context = renderPermissionContext(this.request, contentWidth, this.detailsExpanded);
      this.detailsExpandable = context.expandable;
      return {
        title: '× Deny action',
        meta: toolLabel,
        tone: 'warning',
        leading: [chalk.bold.hex(colors.text)('Deny this action?'), ''],
        evidence: context.lines,
        trailing: [
          '',
          chalk.hex(colors.muted)('Add guidance for Shards Code, or leave this blank.'),
          ...this.denyInput
            .render(Math.max(1, contentWidth))
            .map((line) => fitLine(line, contentWidth)),
        ],
        footer: buildDenyFooter(contentWidth),
        statusLine: createPermissionContextStatusLine(context, contentWidth),
      };
    }

    const context = renderPermissionContext(this.request, contentWidth, this.detailsExpanded);
    this.detailsExpandable = context.expandable;
    return {
      title: '◆ Approval required',
      meta: toolLabel,
      tone,
      leading: [chalk.bold.hex(colors.text)(permissionPromptTitle(toolName)), ''],
      evidence: context.lines,
      trailing: ['', ...this.renderDecisionOptions(contentWidth)],
      footer: buildPermissionFooter(contentWidth),
      statusLine: createPermissionContextStatusLine(context, contentWidth),
    };
  }

  private renderDecisionOptions(width: number): string[] {
    const rendered = this.list.render(Math.max(1, width));
    const selected = this.list.getSelectedItem()?.value as TuiPermissionDecision | undefined;
    const selectedIndex = selected ? this.decisions.indexOf(selected) : -1;
    if (!selected || selectedIndex < 0) return rendered;

    const detailWidth = Math.max(1, width - 4);
    const detail = new Text(chalk.hex(colors.muted)(permissionDecisionDetail(selected)), 0, 0)
      .render(detailWidth)
      .map((line) => fitLine(`    ${line}`, width));
    return [
      ...rendered.slice(0, selectedIndex + 1),
      ...detail,
      ...rendered.slice(selectedIndex + 1),
    ];
  }

  private resetViewport(): void {
    this.viewportOffset = 0;
    this.viewportEvidenceRows = 0;
    this.viewportEvidenceLineCount = 0;
  }

  private choose(decision: TuiPermissionDecision): void {
    if (decision === 'allowAlways') {
      this.confirmAlways = true;
      this.resetViewport();
      return;
    }
    if (decision === 'deny') {
      this.denyFeedback = true;
      this.denyInput.setValue('');
      this.syncDenyInputFocus();
      this.resetViewport();
      return;
    }
    this.onSelect(decision);
  }

  private syncDenyInputFocus(): void {
    this.denyInput.focused = this._focused && this.denyFeedback && this.submitting === undefined;
  }
}

function renderPermissionFrame(
  model: PermissionFrameModel,
  width: number,
  evidence: readonly string[] = model.evidence,
  viewportRange?: PermissionViewportRange,
): string[] {
  const status = model.statusLine?.(viewportRange);
  return renderQuestionnaireFrame(
    {
      title: model.title,
      meta: model.meta,
      body: [
        ...model.leading,
        ...evidence,
        ...(status ? [renderTuiActionHint(status)] : []),
        ...model.trailing,
      ],
      footer: model.footer,
    },
    width,
    model.tone,
  );
}

function renderCompactPermissionFrame(model: PermissionFrameModel, width: number): string[] {
  return renderDecisionFrame(
    [
      chalk.bold.hex(colors[model.tone])(model.title),
      ...trimTrailingBlankLines(model.leading),
      ...trimLeadingBlankLines(model.trailing),
      ...(model.footer ? [renderTuiActionHint(model.footer)] : []),
    ],
    width,
    model.tone,
  );
}

function renderPermissionContext(
  request: TuiPendingPermission,
  width: number,
  expanded = false,
): PermissionContextPresentation {
  const previewLines: string[] = [];
  if (request.structuredPreview) {
    previewLines.push(
      ...renderTuiStructuredPreview(request.structuredPreview, width, {
        maxBodyLines: Number.MAX_SAFE_INTEGER,
      }),
    );
  } else if (request.toolInput) {
    previewLines.push(...renderPermissionPreview(request, width));
  }
  const noteLines: string[] = [];
  if (
    request.toolDescription &&
    request.toolDescription !== request.toolName &&
    request.toolDescription !== request.toolInput
  ) {
    noteLines.push(...renderPermissionNote(request.toolDescription, width));
  }
  if (
    request.reason &&
    request.reason !== request.toolDescription &&
    request.reason !== request.toolInput
  ) {
    noteLines.push(...renderPermissionNote(`Why · ${request.reason}`, width));
  }

  const allLines = [...previewLines, ...noteLines];
  const expandable = allLines.length > DEFAULT_PERMISSION_CONTEXT_LINES;
  const isExpanded = expanded && expandable;
  const previewBudget = Math.min(
    previewLines.length,
    Math.max(1, DEFAULT_PERMISSION_CONTEXT_LINES - Math.min(noteLines.length, 3)),
  );
  const compactLines = [
    ...previewLines.slice(0, previewBudget),
    ...noteLines.slice(0, DEFAULT_PERMISSION_CONTEXT_LINES - previewBudget),
  ];
  return {
    lines: isExpanded ? allLines : compactLines,
    totalLines: allLines.length,
    expandable,
    expanded: isExpanded,
  };
}

function permissionPromptTitle(toolName: string): string {
  const normalized = toolName.toLocaleLowerCase().replaceAll('-', '_');
  if (normalized === 'bash' || normalized.includes('shell') || normalized.includes('exec')) {
    return 'Run this command?';
  }
  if (normalized.includes('write') || normalized.includes('create_file')) return 'Write this file?';
  if (normalized.includes('edit') || normalized.includes('patch')) return 'Apply these edits?';
  if (normalized.includes('delete') || normalized.includes('remove')) return 'Delete this item?';
  return `Allow ${toolName}?`;
}

function formatPermissionToolLabel(toolName: string): string {
  const words = toolName.replaceAll(/[-_]+/gu, ' ').trim();
  if (!words) return 'Unknown';
  return words.replace(/^\p{Ll}/u, (letter) => letter.toLocaleUpperCase());
}

function permissionDecisionTone(toolName: string): TuiDecisionTone {
  const normalized = toolName.toLocaleLowerCase().replaceAll('-', '_');
  return normalized.includes('delete') || normalized.includes('remove') ? 'error' : 'warning';
}

function formatPendingPermissionDecision(decision: TuiPermissionDecision): string {
  if (decision === 'allowAlways') return 'Saving the permission rule and allowing this action…';
  if (decision === 'deny') return 'Denying this action…';
  return 'Allowing for this conversation…';
}

function permissionDecisionDetail(decision: TuiPermissionDecision): string {
  if (decision === 'allowAlways') return 'Review the exact saved scope next';
  if (decision === 'deny') return 'Add guidance before denying this action';
  return 'Shards Code asks again in a new conversation';
}

function permissionSelectTheme(): SelectListTheme {
  return {
    ...baseSelectTheme,
    selectedPrefix: (text) => chalk.bold.hex(colors.signal)(text),
    selectedText: (text) => {
      const label = text.startsWith('→ ') ? text.slice(2) : text.trimStart();
      return `${chalk.bold.hex(colors.signal)('›')} ${chalk.bold.hex(colors.signal)(label)}`;
    },
  };
}

function fitPermissionDecisionLabel(
  decision: TuiPermissionDecision,
  index: number,
  width: number,
): string {
  const prefix = String(Math.max(1, index));
  const candidates =
    decision === 'allowOnce'
      ? [
          `${prefix} Allow for this conversation`,
          `${prefix} Allow this conversation`,
          `${prefix} Allow conversation`,
          `${prefix} Allow`,
        ]
      : decision === 'allowAlways'
        ? [
            `${prefix} Always allow matching actions`,
            `${prefix} Always allow matching`,
            `${prefix} Always allow`,
          ]
        : [`${prefix} Deny and guide Shards Code`, `${prefix} Deny and guide`, `${prefix} Deny`];
  return (
    candidates.find((candidate) => visibleWidth(candidate) <= width) ??
    truncateToWidth(candidates.at(-1) ?? prefix, Math.max(1, width), '')
  );
}

function buildPermissionFooter(width: number): string {
  const candidates = [
    '↑/↓ choose · Enter confirm · Esc deny · Ctrl+C stop',
    '↑/↓ · Enter confirm · Esc deny · Ctrl+C stop',
    'Enter confirm · Esc deny · Ctrl+C stop',
    'Enter · Esc deny · Ctrl+C',
  ];
  return candidates.find((candidate) => visibleWidth(candidate) <= width) ?? 'Enter · Esc';
}

function buildAlwaysConfirmationFooter(width: number): string {
  const candidates = [
    'Enter save and allow · Esc go back · Ctrl+C stop',
    'Enter save · Esc go back · Ctrl+C stop',
    'Enter save · Esc back',
  ];
  return candidates.find((candidate) => visibleWidth(candidate) <= width) ?? 'Enter · Esc';
}

function buildDenyFooter(width: number): string {
  const candidates = [
    'Enter deny · Esc go back · Ctrl+C stop',
    'Enter deny · Esc back · Ctrl+C stop',
    'Enter deny · Esc back',
  ];
  return candidates.find((candidate) => visibleWidth(candidate) <= width) ?? 'Enter · Esc';
}

function createPermissionContextStatusLine(
  context: PermissionContextPresentation,
  width: number,
): (range?: PermissionViewportRange) => string | undefined {
  return (range) => {
    if (!range && !context.expandable) return undefined;
    const detailAction = context.expanded ? 'Ctrl+E collapse' : 'Ctrl+E review all';
    if (!range) {
      const visible = context.lines.length;
      return chooseStatusLine(
        [
          `Details ${String(visible)} of ${String(context.totalLines)} lines · ${detailAction}`,
          `${String(visible)}/${String(context.totalLines)} lines · ${detailAction}`,
          `${String(visible)}/${String(context.totalLines)} · Ctrl+E`,
        ],
        width,
      );
    }

    const rangeLabel = `${String(range.start)}-${String(range.end)}`;
    const candidates =
      context.expandable && !context.expanded
        ? [
            `Details ${rangeLabel} of ${String(range.visibleTotal)} shown · ${String(context.totalLines)} total · PgUp/PgDn scroll · ${detailAction}`,
            `${rangeLabel}/${String(range.visibleTotal)} shown · ${String(context.totalLines)} total · PgUp/PgDn · Ctrl+E`,
            `${rangeLabel}/${String(range.visibleTotal)} · PgUp/PgDn · Ctrl+E`,
          ]
        : [
            `Details ${rangeLabel} of ${String(context.totalLines)} · PgUp/PgDn scroll${context.expandable ? ` · ${detailAction}` : ''}`,
            `${rangeLabel}/${String(context.totalLines)} · PgUp/PgDn${context.expandable ? ' · Ctrl+E' : ''}`,
          ];
    return chooseStatusLine(candidates, width);
  };
}

function buildViewportStatus(
  label: string,
  range: PermissionViewportRange,
  totalLines: number,
  width: number,
): string {
  const rangeLabel = `${String(range.start)}-${String(range.end)}`;
  return chooseStatusLine(
    [
      `${label} ${rangeLabel} of ${String(totalLines)} · PgUp/PgDn scroll`,
      `${label} ${rangeLabel}/${String(totalLines)} · PgUp/PgDn`,
      `${rangeLabel}/${String(totalLines)} · PgUp/PgDn`,
    ],
    width,
  );
}

function chooseStatusLine(candidates: readonly string[], width: number): string {
  return (
    candidates.find((candidate) => visibleWidth(candidate) <= width) ??
    truncateToWidth(candidates.at(-1) ?? '', Math.max(0, width), '')
  );
}

function renderPermissionPreview(request: TuiPendingPermission, width: number): string[] {
  const toolName = request.toolName?.toLocaleLowerCase() ?? '';
  const isShellCommand =
    toolName === 'bash' || toolName.includes('shell') || toolName.includes('exec');
  const shellCommand = isShellCommand ? resolveTuiShellCommand(request.toolInput) : undefined;
  const marker = shellCommand ? '$' : '›';
  const contentWidth = Math.max(1, width - 4);
  const input = sanitizeTerminalText(shellCommand ?? request.toolInput ?? '');
  const rendered = new Text(
    shellCommand ? highlightTuiShellCommand(input) : chalk.hex(colors.text)(input),
    0,
    0,
  ).render(contentWidth);
  return rendered.map((line, index) =>
    fitLine(`  ${index === 0 ? chalk.hex(colors.accent)(marker) : ' '} ${line}`, width),
  );
}

function renderPermissionNote(value: string, width: number): string[] {
  const contentWidth = Math.max(1, width - 2);
  return new Text(chalk.hex(colors.muted)(sanitizeTerminalText(value)), 0, 0)
    .render(contentWidth)
    .map((line) => fitLine(`  ${line}`, width));
}

function renderPermissionRules(request: TuiPendingPermission, width: number): string[] {
  const rules =
    request.ruleContents && request.ruleContents.length > 0
      ? request.ruleContents
      : ['Exact saved scope is unavailable.'];
  return renderPermissionRows(
    'Scope',
    rules.map((rule) => `- ${rule}`),
    width,
  );
}

function renderPermissionRows(label: string, values: readonly string[], width: number): string[] {
  const labelWidth = Math.min(12, Math.max(4, Math.floor(width / 3)));
  const plainPrefix = `  ${label.slice(0, labelWidth).padEnd(labelWidth)} `;
  const bodyWidth = Math.max(1, width - plainPrefix.length);
  const bodyLines = values.flatMap((value) =>
    new Text(chalk.hex(colors.text)(sanitizeTerminalText(value)), 0, 0).render(bodyWidth),
  );
  return bodyLines.map((line, index) => {
    const prefix =
      index === 0
        ? `  ${chalk.bold.hex(colors.muted)(label.slice(0, labelWidth).padEnd(labelWidth))} `
        : ' '.repeat(plainPrefix.length);
    return fitLine(`${prefix}${line}`, width);
  });
}

function fitLine(line: string, width: number): string {
  return truncateToWidth(line, Math.max(0, width), '');
}

function trimTrailingBlankLines(lines: readonly string[]): readonly string[] {
  let end = lines.length;
  while (end > 0 && lines[end - 1] === '') end -= 1;
  return lines.slice(0, end);
}

function trimLeadingBlankLines(lines: readonly string[]): readonly string[] {
  let start = 0;
  while (start < lines.length && lines[start] === '') start += 1;
  return lines.slice(start);
}

function clamp(value: number, minimum: number, maximum: number): number {
  if (!Number.isFinite(value)) return minimum;
  return Math.min(maximum, Math.max(minimum, Math.floor(value)));
}
