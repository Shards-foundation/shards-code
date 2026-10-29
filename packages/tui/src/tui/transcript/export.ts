import { simplifyAssistantContentForTerminal } from '../../application/assistant-content.js';
import { sanitizeTerminalText } from '../rendering/terminal-text.js';
import type { TranscriptCell } from './model.js';
import type { TranscriptProjectionSource } from './projection-window.js';
import { redactTuiSensitiveText } from '../../user-facing-failure.js';
import type { TuiMessage, TuiToolCall } from '../../runtime/stream-events.js';

export interface TuiTranscriptExportMetadata {
  readonly sessionId?: string;
  readonly title?: string;
  readonly exportedAtMs?: number;
}

export interface TuiSessionMarkdownExportMetadata {
  readonly sessionId: string;
  readonly title?: string;
  readonly exportedAtMs: number;
}

export function formatTuiTranscriptMarkdown(
  source: TranscriptProjectionSource,
  metadata: TuiTranscriptExportMetadata = {},
): string {
  const cells = Array.from({ length: source.length }, (_, index) => source.cellAt(index)).filter(
    (cell): cell is TranscriptCell => Boolean(cell && !cell.ephemeral),
  );
  const messages = cells.filter((cell) => cell.kind === 'user' || cell.kind === 'assistant');
  const title = cleanMarkdownText(
    redactTuiCredentials(metadata.title?.trim() || 'Shards Code Transcript'),
  );
  const lines = [`# ${title}`, ''];
  if (metadata.sessionId) {
    lines.push(`Session: ${cleanInline(redactTuiCredentials(metadata.sessionId))}`, '');
  }
  if (metadata.exportedAtMs !== undefined) {
    lines.push(`Exported: ${new Date(metadata.exportedAtMs).toISOString()}`, '');
  }
  for (const cell of messages) {
    const content = exportCellContent(cell);
    if (!content) continue;
    lines.push(cell.kind === 'user' ? '## You' : '## Assistant', '', content, '');
  }
  return `${lines.join('\n').trimEnd()}\n`;
}

/**
 * Render the durable Runtime Session history as a compact, human-readable
 * Markdown transcript. Unlike the TranscriptStore exporter above, this
 * formatter intentionally keeps only user-facing content and short activity
 * summaries so internal protocol payloads do not become part of a shared file.
 */
export function formatTuiSessionMarkdown(
  messages: readonly TuiMessage[],
  metadata: TuiSessionMarkdownExportMetadata,
): string {
  const visibleMessages = messages.filter(isUserFacingSessionMessage);
  const turns = groupSessionMessages(visibleMessages);
  const title = cleanMarkdownText(
    redactTuiCredentials(metadata.title?.trim() || 'Shards Code Session Export'),
  );
  const lines = [
    '---',
    'schema_version: 1',
    `session_id: ${yamlScalar(redactTuiCredentials(metadata.sessionId))}`,
    `title: ${yamlScalar(title)}`,
    `exported_at: ${new Date(metadata.exportedAtMs).toISOString()}`,
    '---',
    '',
    `# ${title}`,
    '',
    '## Overview',
    '',
    `- Turns: ${String(turns.length)}`,
    `- Messages: ${String(visibleMessages.length)}`,
    '',
    '---',
    '',
  ];

  turns.forEach((turn, index) => {
    lines.push(`## Turn ${String(index + 1)}`, '');
    for (const message of turn) {
      const content = exportSessionMessageContent(message);
      if (message.role === 'user') {
        lines.push('### User', '');
        if (content) lines.push(content, '');
        continue;
      }
      if (message.role === 'assistant') {
        if (content) lines.push('### Assistant', '', content, '');
      }

      const activity = formatSessionActivity(message);
      if (activity.length > 0) lines.push('### Activity', '', ...activity, '');
    }
  });

  return `${lines.join('\n').trimEnd()}\n`;
}

export function latestAssistantReply(source: TranscriptProjectionSource): string | undefined {
  for (let index = source.length - 1; index >= 0; index -= 1) {
    const cell = source.cellAt(index);
    if (!cell || cell.ephemeral || cell.kind !== 'assistant') continue;
    const content = exportCellContent(cell);
    if (content) return content;
  }
  return undefined;
}

function exportCellContent(cell: TranscriptCell): string {
  const visible =
    cell.kind === 'assistant' ? simplifyAssistantContentForTerminal(cell.content) : cell.content;
  const attachmentLines = (cell.attachments ?? []).map((attachment) => {
    const kind = attachment.type === 'image' ? 'Image' : 'File';
    const name = cleanInline(redactTuiCredentials(attachment.fileName)) || 'attachment';
    const mime = cleanInline(attachment.mimeType) || 'application/octet-stream';
    const size =
      attachment.sizeBytes === undefined ? '' : `, ${formatAttachmentBytes(attachment.sizeBytes)}`;
    return `- ${kind}: ${name} (${mime}${size})`;
  });
  return [attachmentLines.join('\n'), redactTuiCredentials(sanitizeTerminalText(visible))]
    .filter((value) => value.trim())
    .join('\n\n')
    .trim();
}

function formatAttachmentBytes(sizeBytes: number): string {
  if (sizeBytes < 1024) return `${String(sizeBytes)} B`;
  if (sizeBytes < 1024 * 1024) return `${formatAttachmentUnit(sizeBytes / 1024)} KB`;
  if (sizeBytes < 1024 * 1024 * 1024) {
    return `${formatAttachmentUnit(sizeBytes / (1024 * 1024))} MB`;
  }
  return `${formatAttachmentUnit(sizeBytes / (1024 * 1024 * 1024))} GB`;
}

function formatAttachmentUnit(value: number): string {
  return value >= 10 || Number.isInteger(value) ? value.toFixed(0) : value.toFixed(1);
}

function cleanMarkdownText(value: string): string {
  return cleanInline(value).replace(/^#+\s*/u, '');
}

function cleanInline(value: string): string {
  return sanitizeTerminalText(value).replace(/\s+/gu, ' ').trim();
}

export function redactTuiCredentials(value: string): string {
  return redactTuiSensitiveText(value);
}

function isUserFacingSessionMessage(message: TuiMessage): boolean {
  return message.role === 'user' || message.role === 'assistant';
}

function groupSessionMessages(messages: readonly TuiMessage[]): TuiMessage[][] {
  const turns: TuiMessage[][] = [];
  let current: TuiMessage[] | undefined;
  let currentTurnId: string | undefined;
  let currentHasUser = false;

  for (const message of messages) {
    const turnId = message.turnId?.trim();
    const startsTurn =
      !current ||
      (turnId !== undefined && currentTurnId !== undefined && turnId !== currentTurnId) ||
      (turnId === undefined && message.role === 'user' && currentHasUser);
    if (startsTurn) {
      current = [];
      turns.push(current);
      currentTurnId = turnId;
      currentHasUser = false;
    }
    if (!current) continue;
    current.push(message);
    currentHasUser ||= message.role === 'user';
  }
  return turns;
}

function exportSessionMessageContent(message: TuiMessage): string {
  const parts = message.parts
    ?.filter(
      (part): part is Extract<NonNullable<TuiMessage['parts']>[number], { type: 'text' }> =>
        part.type === 'text',
    )
    .map((part) => part.content)
    .filter((content) => content.trim());
  const content = parts?.length ? parts.join('\n\n') : (message.content ?? '');
  const visible =
    message.role === 'assistant' ? simplifyAssistantContentForTerminal(content) : content;
  const attachmentLines = (message.attachments ?? []).map((attachment) => {
    const kind = attachment.type === 'image' ? 'Image' : 'File';
    const name = cleanInline(redactTuiCredentials(attachment.fileName)) || 'attachment';
    const mime = cleanInline(attachment.mimeType) || 'application/octet-stream';
    const size =
      attachment.sizeBytes === undefined ? '' : `, ${formatAttachmentBytes(attachment.sizeBytes)}`;
    return `- ${kind}: ${name} (${mime}${size})`;
  });
  return [attachmentLines.join('\n'), redactTuiCredentials(sanitizeTerminalText(visible)).trim()]
    .filter((value) => value.trim())
    .join('\n\n')
    .trim();
}

function formatSessionActivity(message: TuiMessage): string[] {
  const activity: string[] = [];
  for (const toolCall of sessionToolCalls(message)) {
    const name = cleanInline(redactTuiCredentials(toolCall.name)) || 'tool';
    const status = formatToolStatus(toolCall);
    activity.push(`- \`${name}\` ${status}`);
  }
  if (message.error?.trim()) {
    activity.push(`- Error: ${redactTuiCredentials(sanitizeTerminalText(message.error)).trim()}`);
  }
  if (message.kind === 'compaction_start') activity.push('- Context compaction started');
  if (message.kind === 'compaction') activity.push('- Context compacted');
  if (message.kind === 'compaction_failed') activity.push('- Context compaction failed');
  if (message.finishReason === 'error') activity.push('- Response failed');
  if (message.finishReason === 'aborted' || message.finishReason === 'cancelled') {
    activity.push('- Response cancelled');
  }
  return activity;
}

function sessionToolCalls(message: TuiMessage): readonly TuiToolCall[] {
  if (message.toolCalls?.length) return message.toolCalls;
  return (
    message.parts
      ?.filter(
        (part): part is Extract<NonNullable<TuiMessage['parts']>[number], { type: 'tool' }> =>
          part.type === 'tool',
      )
      .map((part) => part.toolCall) ?? []
  );
}

function formatToolStatus(toolCall: TuiToolCall): string {
  if (toolCall.error) return 'failed';
  const status = String(toolCall.status ?? '').toLocaleLowerCase();
  if (status === '3' || status.includes('fail') || status.includes('error')) {
    return 'failed';
  }
  if (status.includes('cancel')) return 'cancelled';
  if (
    status === '1' ||
    status.includes('run') ||
    status.includes('pend') ||
    status.includes('progress')
  ) {
    return 'in progress';
  }
  return 'succeeded';
}

function yamlScalar(value: string): string {
  return JSON.stringify(value);
}
