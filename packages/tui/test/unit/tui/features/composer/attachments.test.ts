import { mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  formatTuiAttachments,
  resolveTuiAttachment,
} from '../../../../../src/tui/features/composer/attachments.js';

describe('Shards Code TUI attachments', () => {
  it('resolves relative image paths against the workspace with safe metadata', async () => {
    const workspaceDir = await mkdtemp(join(tmpdir(), 'minimax-code-attachment-'));
    const imagePath = join(workspaceDir, 'diagram.png');
    await writeFile(imagePath, Buffer.from([0x89, 0x50, 0x4e, 0x47]));

    await expect(resolveTuiAttachment('diagram.png', { workspaceDir })).resolves.toEqual({
      type: 'image',
      filePath: imagePath,
      fileName: 'diagram.png',
      mimeType: 'image/png',
      sizeBytes: 4,
    });
  });

  it.each([
    ['clip.mp4', 'video/mp4'],
    ['clip.avi', 'video/x-msvideo'],
    ['clip.mov', 'video/quicktime'],
    ['clip.mkv', 'video/x-matroska'],
  ])('preserves the native video MIME for %s', async (fileName, mimeType) => {
    const workspaceDir = await mkdtemp(join(tmpdir(), 'minimax-code-video-attachment-'));
    const videoPath = join(workspaceDir, fileName);
    await writeFile(videoPath, Buffer.from([0, 1, 2, 3]));

    await expect(resolveTuiAttachment(fileName, { workspaceDir })).resolves.toEqual({
      type: 'file',
      filePath: videoPath,
      fileName,
      mimeType,
      sizeBytes: 4,
    });
  });

  it('expands home paths and rejects directories', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'minimax-code-home-'));
    const workspaceDir = await mkdtemp(join(tmpdir(), 'minimax-code-workspace-'));
    const textPath = join(homeDir, 'notes.md');
    await writeFile(textPath, '# Notes');

    await expect(
      resolveTuiAttachment('~/notes.md', { workspaceDir, homeDir }),
    ).resolves.toMatchObject({
      type: 'file',
      filePath: textPath,
      fileName: 'notes.md',
      mimeType: 'text/markdown',
    });
    await expect(
      resolveTuiAttachment(workspaceDir, { workspaceDir, homeDir }),
    ).rejects.toThrow('not a file');
  });

  it.skipIf(process.platform === 'win32')('prefers an existing literal backslash in a pasted file name', async () => {
    const workspaceDir = await mkdtemp(join(tmpdir(), 'minimax-code-attachment-'));
    const literalPath = join(workspaceDir, 'Screenshot\\ 2026.png');
    const spacePath = join(workspaceDir, 'Screenshot 2026.png');
    try {
      await writeFile(literalPath, 'literal');
      await writeFile(spacePath, 'space');
      await expect(
        resolveTuiAttachment(literalPath, { workspaceDir, source: 'terminal-paste' }),
      ).resolves.toMatchObject({ filePath: literalPath, sizeBytes: 7 });
    } finally {
      await rm(workspaceDir, { recursive: true, force: true });
    }
  });

  it.skipIf(process.platform === 'win32')('attaches a valid filename whose escaped form exceeds NAME_MAX', async () => {
    const workspaceDir = await mkdtemp(join(tmpdir(), 'minimax-code-attachment-'));
    const fileName = `${'x '.repeat(125)}x.png`;
    const filePath = join(workspaceDir, fileName);
    const escapedPath = filePath.replaceAll(' ', '\\ ');
    try {
      await writeFile(filePath, 'image');
      await expect(stat(escapedPath)).rejects.toMatchObject({ code: 'ENAMETOOLONG' });
      await expect(
        resolveTuiAttachment(escapedPath, { workspaceDir, source: 'terminal-paste' }),
      ).resolves.toMatchObject({ filePath, fileName, type: 'image' });
    } finally {
      await rm(workspaceDir, { recursive: true, force: true });
    }
  });

  it.skipIf(process.platform === 'win32')('attaches the intended file when both backslashes and spaces are escaped', async () => {
    const workspaceDir = await mkdtemp(join(tmpdir(), 'minimax-code-attachment-'));
    const filePath = join(workspaceDir, 'Screenshot\\ 2026.png');
    const otherPath = filePath.replaceAll('\\', '\\\\');
    const escapedPath = otherPath.replaceAll(' ', '\\ ');
    try {
      await writeFile(filePath, 'intended');
      await writeFile(otherPath, 'different file');
      await expect(
        resolveTuiAttachment(escapedPath, { workspaceDir, source: 'terminal-paste' }),
      ).resolves.toMatchObject({ filePath, sizeBytes: 8 });
    } finally {
      await rm(workspaceDir, { recursive: true, force: true });
    }
  });

  it.skipIf(process.platform === 'win32')('keeps quoted paths, references and directories literal', async () => {
    const workspaceDir = await mkdtemp(join(tmpdir(), 'minimax-code-attachment-'));
    const spacePath = join(workspaceDir, 'Screenshot 2026.png');
    const escapedPath = spacePath.replaceAll(' ', '\\ ');
    try {
      await writeFile(spacePath, 'image');
      for (const reference of [spacePath, `'${spacePath}'`, `"${spacePath}"`]) {
        await expect(
          resolveTuiAttachment(reference, { workspaceDir, source: 'terminal-paste' }),
        ).resolves.toMatchObject({ filePath: spacePath });
      }
      await expect(resolveTuiAttachment(escapedPath, { workspaceDir })).rejects.toThrow('ENOENT');
      for (const reference of [`'${escapedPath}'`, `"${escapedPath}"`]) {
        await expect(
          resolveTuiAttachment(reference, { workspaceDir, source: 'terminal-paste' }),
        ).rejects.toThrow('ENOENT');
      }
      await mkdir(escapedPath);
      await expect(
        resolveTuiAttachment(escapedPath, { workspaceDir, source: 'terminal-paste' }),
      ).rejects.toThrow('not a file');
    } finally {
      await rm(workspaceDir, { recursive: true, force: true });
    }
  });

  it('formats queued attachments without exposing control sequences', () => {
    expect(
      formatTuiAttachments([
        {
          type: 'image',
          filePath: '/workspace/diagram.png',
          fileName: 'diagram\u001b[31m.png',
          mimeType: 'image/png',
          sizeBytes: 2048,
        },
      ]),
    ).toBe('1. diagram.png · image/png · 2 KB');
  });
});
