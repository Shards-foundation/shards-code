import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import JSZip from 'jszip';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SessionReportService } from '@mavis/session-report';

import { uploadTuiFeedbackDiagnostics } from '../../src/runtime/feedback/diagnostic-upload.js';
import { TuiFeedbackService } from '../../src/runtime/feedback/service.js';
import { TuiFeedbackPanel } from '../../src/tui/features/feedback/panel.js';

const PRIVATE = 'SYNTHETIC_PRIVATE_29fa';
const tempDirs: string[] = [];
afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});
async function directory() {
  const dir = await mkdtemp(join(tmpdir(), 'feedback-privacy-'));
  tempDirs.push(dir);
  return dir;
}
function transport() {
  let uploaded: Uint8Array | undefined;
  const fetchImpl = vi.fn<typeof fetch>(async (url, init) => {
    if (String(url).endsWith('/matrix/api/v1/log/upload')) {
      return Response.json({
        upload_id: 'synthetic-upload',
        upload_url: 'https://upload.example.test/capture',
      });
    }
    expect(init?.method).toBe('PUT');
    uploaded = new Uint8Array(await new Response(init?.body).arrayBuffer());
    return new Response(null, { status: 200 });
  });
  return {
    fetchImpl,
    async archive() {
      expect(uploaded).toBeDefined();
      const zip = await JSZip.loadAsync(uploaded!);
      const files = await Promise.all(
        Object.values(zip.files)
          .filter((file) => !file.dir)
          .map(async (file) => ({
            name: file.name,
            text: await file.async('string'),
          })),
      );
      return {
        zip,
        files,
        text: JSON.stringify(files),
        summaries: files
          .filter((file) => file.name !== 'diagnostic-manifest.json')
          .map((file) => JSON.parse(file.text)),
      };
    },
  };
}

describe('feedback diagnostic upload privacy', () => {
  it('keeps diagnostics unchecked in the preview and sends them only after the user toggles consent', async () => {
    const submit = vi.fn(async () => ({ schemaVersion: 1 as const, status: 'unknown' as const }));
    const panel = new TuiFeedbackPanel({
      preview: {
        schemaVersion: 1,
        draftId: 'draft-1',
        description: 'Synthetic feedback',
        diagnostics: [],
        diagnosticBundleAvailable: true,
        diagnosticBundleIncluded: false,
        included: ['reviewed feedback description'],
        excluded: ['diagnostic counts and raw session files'],
        expiresAtMs: Date.now() + 60_000,
      },
      submit,
      cancel: async () => undefined,
      requestRender() {},
      onClose() {},
    });

    expect(panel.render(120).join('\n')).toMatch(/diagnostics.*unchecked/iu);
    panel.handleInput('i');
    expect(panel.render(120).join('\n')).toMatch(/diagnostics.*included/iu);
    panel.handleInput('\r');
    await vi.waitFor(() => expect(submit).toHaveBeenCalled());
    expect(submit).toHaveBeenCalledWith(
      'draft-1',
      expect.objectContaining({ includeDiagnostics: true }),
    );
    panel.dispose();
  });

  it('runs review, real session collection, packaging and intercepted PUT with synthetic sensitive artifacts', async () => {
    const dataDir = await directory();
    const root = join(dataDir, 'session-root');
    const child = join(dataDir, 'session-child');
    const logs = join(dataDir, 'v2', 'observability', 'logs');
    const auth = join(dataDir, 'auth');
    await Promise.all([root, child, logs, auth].map((dir) => mkdir(dir, { recursive: true })));
    const message = JSON.stringify({
      role: 'user',
      content: `${PRIVATE}\nquoted "prompt"`,
      token: PRIVATE,
      properties: {
        error: {
          statusCode: 429,
          message: PRIVATE,
          headers: { authorization: PRIVATE },
        },
      },
    });
    const fixtures: Record<string, string> = {
      'manifest.json': JSON.stringify({
        status: 'failed',
        cwd: PRIVATE,
        title: PRIVATE,
      }),
      'messages.jsonl': `${message}\n`,
      'display.jsonl': `${JSON.stringify({ role: 'assistant', content: PRIVATE })}\n`,
      'snapshot.json': JSON.stringify({
        messages: [JSON.parse(message)],
        prompt: PRIVATE,
      }),
      'llm-call.json': JSON.stringify({
        systemPrompt: PRIVATE,
        tools: [{ description: PRIVATE }],
        error: { code: 'ECONNRESET', cause: { message: PRIVATE } },
      }),
      [`${PRIVATE}.bin`]: PRIVATE,
      'broken.json': `{"content":"${PRIVATE}`,
    };
    await Promise.all(
      Object.entries(fixtures).map(([name, content]) => writeFile(join(root, name), content)),
    );
    await writeFile(join(child, 'messages.jsonl'), `${message}\n`);
    await writeFile(join(child, 'manifest.json'), '{"status":"completed"}');
    await writeFile(
      join(logs, `runtime-${PRIVATE}.log`),
      `${PRIVATE}\n${JSON.stringify({ level: 'error', prompt: PRIVATE, error: { status: 503 } })}\n`,
    );
    await writeFile(join(auth, 'auth.json'), JSON.stringify({ accessToken: PRIVATE }));
    const reports = new SessionReportService({
      sessions: {
        listChildren: async (id) => (id === 'root' ? [{ sessionId: 'child' }] : []),
        getTaskAgentBinding: async () => ({
          definition: { prompt: PRIVATE, description: PRIVATE },
        }),
      },
      locations: {
        inspectSession: async (id) => ({
          session: {
            sessionId: id,
            sessionKind: id === 'child' ? 'task' : 'root',
          },
          paths: {
            sessionDir: id === 'root' ? root : child,
            snapshots: join(root, 'snapshots'),
          },
        }),
      },
    });
    const capture = transport();
    const service = new TuiFeedbackService({
      appVersion: '0.4.12',
      authContextGetter: () => ({
        accessToken: 'synthetic-account-token',
        realUserID: 'synthetic-user',
      }),
      diagnosticLogUploader: (input) =>
        uploadTuiFeedbackDiagnostics(input, {
          dataDir,
          appVersion: '0.4.12',
          fetchImpl: capture.fetchImpl,
          collectSessionReport: (id) => reports.collect(id),
        }),
      fetchImpl: vi.fn<typeof fetch>(async (_url, init) => {
        expect(JSON.parse(String(init?.body))).toMatchObject({
          description: 'Synthetic feedback',
          diagnostic_log: { upload_id: 'synthetic-upload' },
        });
        return Response.json({ ticket_id: 'synthetic-ticket' });
      }),
    });
    const preview = service.prepare({
      description: 'Synthetic feedback',
      sessionId: 'root',
    });
    expect(preview.diagnosticBundleAvailable).toBe(true);
    expect(preview.diagnosticBundleIncluded).toBe(false);
    const panel = new TuiFeedbackPanel({
      preview,
      submit: (id, options) => service.submit(id, options),
      cancel: async (id) => service.cancel(id),
      requestRender() {},
      onClose() {},
    });
    expect(panel.render(120).join('\n')).toContain('Diagnostics: unchecked (not included)');
    panel.handleInput('i');
    expect(panel.render(120).join('\n')).toContain('No raw attachments');
    await service.submit(preview.draftId, { includeDiagnostics: true });
    panel.dispose();
    const archive = await capture.archive();
    expect(archive.text).not.toContain(PRIVATE);
    expect(archive.text).not.toContain(dataDir);
    expect(archive.text).not.toContain('synthetic-account-token');
    expect(archive.summaries).toContainEqual(
      expect.objectContaining({
        sourceKind: 'messages.jsonl',
        counts: expect.objectContaining({
          role: { user: 1 },
          httpStatus: { '429': 1 },
        }),
      }),
    );
    expect(archive.summaries).toContainEqual(
      expect.objectContaining({
        counts: expect.objectContaining({
          level: { error: 1 },
          httpStatus: { '503': 1 },
        }),
      }),
    );
    expect(archive.summaries.every((summary) => summary.contentOmitted === true)).toBe(true);
    expect(
      archive.summaries.some((summary) => summary.sourceKind === 'task-agent-definition.json'),
    ).toBe(true);
    // Redaction affects the upload projection only; local canonical evidence stays intact.
    expect(await readFile(join(root, 'messages.jsonl'), 'utf8')).toBe(`${message}\n`);
  });

  it('never forwards malformed JSON, binary content, unknown keys or nested free text', async () => {
    const dataDir = await directory();
    const capture = transport();
    const contents = [
      PRIVATE,
      `{"bad":"${PRIVATE}`,
      JSON.stringify({
        [PRIVATE]: { prompt: PRIVATE },
        error: {
          cause: {
            properties: { headers: [['authorization', PRIVATE]], status: 500 },
          },
        },
      }),
      JSON.stringify({ payload: PRIVATE.repeat(200_000) }),
    ];
    await uploadTuiFeedbackDiagnostics(
      {
        description: 'Synthetic',
        sessionId: PRIVATE,
        signal: new AbortController().signal,
      },
      {
        dataDir,
        appVersion: PRIVATE,
        fetchImpl: capture.fetchImpl,
        collectSessionReport: async () => ({
          schemaVersion: 1,
          rootSessionId: PRIVATE,
          sessionIds: [PRIVATE],
          artifacts: contents.map((content, index) => ({
            name: `session/${PRIVATE}/${index}.json`,
            content,
            bytes: Buffer.byteLength(content),
            required: true,
          })),
        }),
      },
    );
    const archive = await capture.archive();
    expect(archive.text).not.toContain(PRIVATE);
    expect(archive.summaries).toHaveLength(4);
    expect(archive.summaries[2].counts.httpStatus).toEqual({ '500': 1 });
    expect(archive.summaries[0].omittedRecords).toBe(1);
  });

  it.each(['missing', 'oversized', 'collector'] as const)(
    'keeps safe partial diagnostics when evidence is %s',
    async (failure) => {
      const dataDir = await directory();
      const logs = join(dataDir, 'v2', 'observability', 'logs');
      await mkdir(logs, { recursive: true });
      await writeFile(join(logs, 'runtime-test.log'), '{"level":"error"}\n');
      const capture = transport();
      await uploadTuiFeedbackDiagnostics(
        {
          description: 'Partial',
          sessionId: 'root',
          signal: new AbortController().signal,
        },
        {
          dataDir,
          appVersion: '0.4.12',
          fetchImpl: capture.fetchImpl,
          collectSessionReport: async () => {
            if (failure === 'collector') throw new Error(PRIVATE);
            return {
              schemaVersion: 1,
              rootSessionId: 'root',
              sessionIds: ['root'],
              artifacts: [
                {
                  name: `session/${PRIVATE}/messages.jsonl`,
                  path: join(dataDir, PRIVATE),
                  bytes: failure === 'oversized' ? 17 * 1024 * 1024 : 10,
                  required: true,
                },
              ],
            };
          },
        },
      );
      const archive = await capture.archive();
      expect(archive.text).not.toContain(PRIVATE);
      const manifest = JSON.parse(
        archive.files.find((file) => file.name === 'diagnostic-manifest.json')!.text,
      );
      expect(manifest.skipped).toHaveLength(1);
      expect(archive.summaries[0].counts).toEqual({ level: { error: 1 } });
    },
  );

  it('does not inspect unrelated session manifests or credentials', async () => {
    const dataDir = await directory();
    const unrelated = join(
      dataDir,
      'v2',
      'sessions',
      '2026',
      '09',
      '18',
      '10-00-00-000-session_c2Vz',
    );
    await mkdir(unrelated, { recursive: true });
    await writeFile(join(unrelated, 'manifest.json'), '{"status":"failed"}');
    const capture = transport();
    await uploadTuiFeedbackDiagnostics(
      { description: 'No session', signal: new AbortController().signal },
      { dataDir, appVersion: '0.4.12', fetchImpl: capture.fetchImpl },
    );
    expect((await capture.archive()).summaries).toHaveLength(0);
  });

  it('summarizes all log sources, reads the tail of rotated logs, and keeps whole JSON as one record', async () => {
    const dataDir = await directory();
    const capture = transport();
    const files = [
      [
        'v2/observability/logs/archived/runtime-large.log',
        `${`${PRIVATE}\n`.repeat(150_000)}{"level":"error"}\n`,
      ],
      [
        'v2/observability/mcode/mcode-observability-test.jsonl',
        '{"level":"warn","password":"hidden"}\n',
      ],
      [
        'v2/observability/events/2026/09/18/runtime-events-2026-09-18.jsonl',
        '{"status":"failed"}\n',
      ],
      [
        'v2/observability/cli/incidents/pending-test.json',
        '{\n  "status": "error",\n  "eventLog": "private"\n}',
      ],
      ['logs/cli.log', '{"level":"fatal"}\n'],
      ['logs/tui-terminal-test.log', '{"level":"info"}\n'],
      ['logs/runtime-legacy.log', '{"level":"debug"}\n'],
    ];
    for (const [name, content] of files) {
      const path = join(dataDir, name!);
      await mkdir(path.slice(0, path.lastIndexOf('/')), { recursive: true });
      await writeFile(path, content!);
    }
    const flushLogs = vi.fn(async () => undefined);
    await uploadTuiFeedbackDiagnostics(
      { description: 'Synthetic', signal: new AbortController().signal },
      { dataDir, appVersion: '0.4.12', fetchImpl: capture.fetchImpl, flushLogs },
    );
    expect(flushLogs).toHaveBeenCalledOnce();
    const archive = await capture.archive();
    expect(archive.text).not.toContain(PRIVATE);
    expect(archive.summaries).toHaveLength(6);
    for (const level of ['error', 'warn', 'fatal', 'info']) {
      expect(archive.summaries.some((summary) => summary.counts.level?.[level] === 1)).toBe(true);
    }
    expect(
      archive.summaries.some(
        (summary) => summary.counts.status?.error === 1 && summary.parsedRecords === 1,
      ),
    ).toBe(true);
    expect(archive.text).not.toContain('debug');
  });

  it('retains more than 64 prioritized summaries and bounds adversarial nesting', async () => {
    const dataDir = await directory();
    const capture = transport();
    const artifacts = Array.from({ length: 65 }, (_, index) => {
      const content = JSON.stringify({ role: 'assistant', content: PRIVATE });
      return {
        name: `session/root/${index}.json`,
        content,
        bytes: Buffer.byteLength(content),
        required: true as const,
      };
    });
    const nested = `${'{"data":'.repeat(100)}{"status":500,"prompt":"${PRIVATE}"}${'}'.repeat(100)}`;
    artifacts.push({
      name: 'session/root/deep.json',
      content: nested,
      bytes: Buffer.byteLength(nested),
      required: true,
    });
    await uploadTuiFeedbackDiagnostics(
      { description: 'Synthetic', sessionId: 'root', signal: new AbortController().signal },
      {
        dataDir,
        appVersion: '0.4.12',
        fetchImpl: capture.fetchImpl,
        collectSessionReport: async () => ({
          schemaVersion: 1,
          rootSessionId: 'root',
          sessionIds: ['root'],
          artifacts,
        }),
      },
    );
    const archive = await capture.archive();
    expect(archive.text).not.toContain(PRIVATE);
    expect(archive.summaries).toHaveLength(66);
    expect(archive.summaries.at(-1).limited).toBe(true);
  });

  it('rejects invalid upload receipts and aborts before network transfer', async () => {
    const dataDir = await directory();
    const fetchImpl = vi.fn<typeof fetch>(async () =>
      Response.json({ upload_url: 'https://upload.example.test' }),
    );
    await expect(
      uploadTuiFeedbackDiagnostics(
        { description: 'Synthetic', signal: new AbortController().signal },
        { dataDir, appVersion: '0.4.12', fetchImpl },
      ),
    ).rejects.toThrow('invalid upload receipt');
    expect(fetchImpl).toHaveBeenCalledOnce();
    fetchImpl.mockClear();
    await expect(
      uploadTuiFeedbackDiagnostics(
        { description: 'Synthetic', signal: AbortSignal.abort() },
        { dataDir, appVersion: '0.4.12', fetchImpl },
      ),
    ).rejects.toThrow();
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
