import { describe, expect, it, vi } from 'vitest';

import { TuiFeedbackService } from '../../src/runtime/feedback/service.js';

function ticketResponse(ticketId = 'ticket-1'): Response {
  return Response.json({
    ticket_id: ticketId,
    status: 1,
    created_at: 2_000,
    base_resp: { status_code: 0 },
  });
}

describe('TuiFeedbackService', () => {
  it('keeps credentials and upload state behind the TUI runtime adapter', async () => {
    const calls: string[] = [];
    const diagnosticLogUploader = vi.fn(async () => {
      calls.push('diagnostics');
      return { uploadId: 'upload-1' };
    });
    let requestBody: Record<string, unknown> | undefined;
    const service = new TuiFeedbackService({
      appVersion: '0.1.0-test',
      authContextGetter: () => ({ accessToken: 'managed-token', realUserID: 'user-1' }),
      diagnosticLogUploader,
      fetchImpl: vi.fn(async (_input, init) => {
        calls.push('ticket');
        requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return ticketResponse();
      }),
      nowMs: () => 2_000,
      platform: () => ({
        platform: 'test-os',
        arch: 'test-arch',
        nodeVersion: 'test-node',
        osVersion: '1.0',
      }),
      region: () => 'cn',
      buildEnv: () => 'test',
    });

    const preview = service.prepare({ description: 'Renderer froze', sessionId: 'session-1' });
    expect(preview.diagnosticBundleIncluded).toBe(false);
    expect(preview.included).not.toContain(
      'diagnostic counts from the selected Session subtree (including messages, snapshots, and report artifacts); original contents and filenames are omitted',
    );
    expect(preview.excluded).toContain(
      'canonical full conversation and tool-call history (messages.jsonl)',
    );
    const phases: string[] = [];
    await expect(
      service.submit(preview.draftId, {
        includeDiagnostics: true,
        onPhase: (phase) => phases.push(phase),
      }),
    ).resolves.toEqual({
      schemaVersion: 1,
      ticketId: 'ticket-1',
      uploadId: 'upload-1',
      status: 'processing',
      createdAtMs: 2_000,
    });
    expect(phases).toEqual(['preparing', 'uploading-diagnostics', 'creating-ticket', 'completed']);
    expect(calls).toEqual(['diagnostics', 'ticket']);
    expect(requestBody).toEqual({
      description: 'Renderer froze',
      contact: '',
      task_context: {
        session_id: 'session-1',
        client_type: 1,
        client_version: '0.1.0-test',
        os: 'test-os',
        os_version: '1.0',
      },
      screenshots: [],
      upload_diagnostic_log: true,
      diagnostic_log: { upload_id: 'upload-1' },
    });
  });

  it('does not upload diagnostics when a feedback draft is sent without explicit diagnostic consent', async () => {
    const diagnosticLogUploader = vi.fn(async () => ({ uploadId: 'must-not-upload' }));
    let requestBody: Record<string, unknown> | undefined;
    const service = new TuiFeedbackService({
      appVersion: '0.1.0-test',
      authContextGetter: () => ({ accessToken: 'managed-token', realUserID: 'user-1' }),
      diagnosticLogUploader,
      fetchImpl: vi.fn(async (_input, init) => {
        requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return ticketResponse();
      }),
    });

    const preview = service.prepare({ description: 'No diagnostics by default' });
    expect(preview.diagnosticBundleIncluded).toBe(false);
    expect(preview.included.join(' ')).not.toContain('diagnostic counts');
    await service.submit(preview.draftId);

    expect(diagnosticLogUploader).not.toHaveBeenCalled();
    expect(requestBody).toMatchObject({ upload_diagnostic_log: false });
    expect(requestBody).not.toHaveProperty('diagnostic_log');
  });

  it('keeps canonical Session history excluded when no diagnostic uploader is configured', () => {
    const service = new TuiFeedbackService({
      appVersion: '0.1.0-test',
      authContextGetter: () => ({ accessToken: 'managed-token', realUserID: 'user-1' }),
    });

    const preview = service.prepare({ description: 'Metadata only' });
    expect(preview.diagnosticBundleIncluded).toBe(false);
    expect(preview.excluded).toContain(
      'canonical full conversation and tool-call history (messages.jsonl)',
    );
  });

  it('accepts the nested receipt shape returned by the production feedback API', async () => {
    const service = new TuiFeedbackService({
      appVersion: '0.1.0-test',
      authContextGetter: () => ({ accessToken: 'managed-token', realUserID: 'user-1' }),
      fetchImpl: vi.fn(async () =>
        Response.json({
          base_resp: { status_code: 0, status_msg: 'ok' },
          data: {
            ticket_id: 'ticket-production-1',
            status: 1,
            created_at: 2_000,
          },
        }),
      ),
    });
    const preview = service.prepare({ description: 'Production receipt' });

    await expect(service.submit(preview.draftId)).resolves.toEqual({
      schemaVersion: 1,
      ticketId: 'ticket-production-1',
      status: 'processing',
      createdAtMs: 2_000,
    });
  });

  it('treats a successful response without optional receipt metadata as delivered', async () => {
    const service = new TuiFeedbackService({
      appVersion: '0.1.0-test',
      authContextGetter: () => ({ accessToken: 'managed-token', realUserID: 'user-1' }),
      fetchImpl: vi.fn(async () =>
        Response.json({
          base_resp: { status_code: 0, status_msg: 'ok' },
          data: {},
        }),
      ),
    });
    const preview = service.prepare({ description: 'Optional receipt metadata' });

    await expect(service.submit(preview.draftId)).resolves.toEqual({
      schemaVersion: 1,
      status: 'unknown',
    });
  });

  it('treats an empty successful response as delivered', async () => {
    const service = new TuiFeedbackService({
      appVersion: '0.1.0-test',
      authContextGetter: () => ({ accessToken: 'managed-token', realUserID: 'user-1' }),
      fetchImpl: vi.fn(async () => new Response(null, { status: 204 })),
    });
    const preview = service.prepare({ description: 'Empty successful response' });

    await expect(service.submit(preview.draftId)).resolves.toEqual({
      schemaVersion: 1,
      status: 'unknown',
    });
  });

  it('confirms a ticket created during an ambiguous failed response before offering retry', async () => {
    const requests: Array<{ method: string; url: URL; headers: Headers }> = [];
    const fetchImpl = vi.fn<typeof fetch>(async (input, init) => {
      requests.push({
        method: init?.method ?? 'GET',
        url: new URL(String(input)),
        headers: new Headers(init?.headers),
      });
      if (init?.method === 'POST') return new Response('upstream failed', { status: 502 });
      return Response.json({
        tickets: [
          {
            ticket_id: 'ticket-confirmed-after-502',
            description: 'Ambiguous delivery',
            status: 1,
            created_at: 10_000,
          },
        ],
        base_resp: { status_code: 0 },
      });
    });
    const service = new TuiFeedbackService({
      appVersion: '0.1.0-test',
      authContextGetter: () => ({ accessToken: 'managed-token', realUserID: 'user-1' }),
      fetchImpl,
      nowMs: () => 10_000,
    });
    const preview = service.prepare({ description: 'Ambiguous delivery' });

    await expect(service.submit(preview.draftId)).resolves.toEqual({
      schemaVersion: 1,
      ticketId: 'ticket-confirmed-after-502',
      status: 'processing',
      createdAtMs: 10_000,
    });
    expect(requests.map(({ method }) => method)).toEqual(['POST', 'GET']);
    expect(requests[1]?.url.searchParams.get('limit')).toBe('20');
    expect(requests[1]?.url.searchParams.has('token')).toBe(false);
    expect(requests[1]?.headers.get('authorization')).toBe('Bearer managed-token');
    expect(requests[1]?.headers.has('token')).toBe(false);
  });

  it('does not confirm an older ticket with the same description', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async (_input, init) => {
      if (init?.method === 'POST') return new Response('upstream failed', { status: 502 });
      return Response.json({
        tickets: [
          {
            ticket_id: 'ticket-too-old',
            description: 'Repeated description',
            status: 1,
            created_at: 1_000,
          },
        ],
        base_resp: { status_code: 0 },
      });
    });
    const service = new TuiFeedbackService({
      appVersion: '0.1.0-test',
      authContextGetter: () => ({ accessToken: 'managed-token', realUserID: 'user-1' }),
      fetchImpl,
      nowMs: () => 20_000,
    });
    const preview = service.prepare({ description: 'Repeated description' });

    await expect(service.submit(preview.draftId)).rejects.toMatchObject({
      code: 'feedback_upload_failed',
      statusCode: 502,
    });
  });

  it('keeps an explicit business rejection as a failed delivery', async () => {
    const service = new TuiFeedbackService({
      appVersion: '0.1.0-test',
      authContextGetter: () => ({ accessToken: 'managed-token', realUserID: 'user-1' }),
      fetchImpl: vi.fn(async () =>
        Response.json({
          statusInfo: { code: 1_000_048, message: 'login required' },
        }),
      ),
    });
    const preview = service.prepare({ description: 'Business rejection' });

    await expect(service.submit(preview.draftId)).rejects.toMatchObject({
      code: 'feedback_upload_failed',
      message: expect.stringContaining(
        'HTTP 200; statusInfo.code=1000048; statusInfo.message=login required',
      ),
    });
  });

  it('includes a redacted response body in an HTTP failure diagnostic', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async (_input, init) => {
      if (init?.method === 'GET') {
        return Response.json({ tickets: [], base_resp: { status_code: 0 } });
      }
      return Response.json(
        {
          error: 'upstream unavailable',
          token: 'must-not-leak',
          request_id: 'request-feedback-1',
        },
        { status: 503 },
      );
    });
    const service = new TuiFeedbackService({
      appVersion: '0.1.0-test',
      authContextGetter: () => ({ accessToken: 'managed-token', realUserID: 'user-1' }),
      fetchImpl,
    });
    const preview = service.prepare({ description: 'Detailed HTTP failure' });

    const error = await service.submit(preview.draftId).catch((value: unknown) => value);
    expect(error).toMatchObject({
      code: 'feedback_upload_failed',
      statusCode: 503,
      message: expect.stringContaining('Feedback POST returned HTTP 503'),
    });
    expect((error as Error).message).toContain('request-feedback-1');
    expect((error as Error).message).toContain('token":"[redacted]');
    expect((error as Error).message).not.toContain('must-not-leak');
  });

  it('requires login before diagnostics or ticket upload', async () => {
    const diagnosticLogUploader = vi.fn(async () => ({ uploadId: 'unused' }));
    const fetchImpl = vi.fn<typeof fetch>();
    const service = new TuiFeedbackService({
      appVersion: '0.1.0-test',
      authContextGetter: () => undefined,
      diagnosticLogUploader,
      fetchImpl,
    });
    const preview = service.prepare({ description: 'Login required' });

    await expect(service.submit(preview.draftId)).rejects.toMatchObject({
      code: 'feedback_login_required',
      retryable: true,
    });
    expect(diagnosticLogUploader).not.toHaveBeenCalled();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('reuses a successful diagnostic upload when ticket submission is retried', async () => {
    const diagnosticLogUploader = vi.fn(async () => ({ uploadId: 'upload-retry' }));
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response('unavailable', { status: 503 }))
      .mockResolvedValueOnce(Response.json({ tickets: [], base_resp: { status_code: 0 } }))
      .mockResolvedValueOnce(ticketResponse('ticket-retry'));
    const service = new TuiFeedbackService({
      appVersion: '0.1.0-test',
      authContextGetter: () => ({ accessToken: 'managed-token', realUserID: 'user-1' }),
      diagnosticLogUploader,
      fetchImpl,
    });
    const preview = service.prepare({ description: 'Retry me' });

    await expect(service.submit(preview.draftId, { includeDiagnostics: true })).rejects.toMatchObject({
      code: 'feedback_upload_failed',
      retryable: true,
    });
    await expect(service.submit(preview.draftId, { includeDiagnostics: true })).resolves.toMatchObject({
      ticketId: 'ticket-retry',
      uploadId: 'upload-retry',
    });
    expect(diagnosticLogUploader).toHaveBeenCalledOnce();
  });

  it('submits the feedback ticket without diagnostics when diagnostic upload fails', async () => {
    let requestBody: Record<string, unknown> | undefined;
    const service = new TuiFeedbackService({
      appVersion: '0.1.0-test',
      authContextGetter: () => ({ accessToken: 'managed-token', realUserID: 'user-1' }),
      diagnosticLogUploader: vi.fn(async () => {
        throw new Error('log rotated');
      }),
      fetchImpl: vi.fn(async (_input, init) => {
        requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return ticketResponse('ticket-without-diagnostics');
      }),
    });
    const preview = service.prepare({ description: 'Logs are unavailable' });

    await expect(service.submit(preview.draftId, { includeDiagnostics: true })).resolves.toMatchObject({
      ticketId: 'ticket-without-diagnostics',
    });
    expect(requestBody).toMatchObject({
      upload_diagnostic_log: false,
    });
    expect(requestBody).not.toHaveProperty('diagnostic_log');
  });

  it('refreshes a rejected ticket request once without invalidating shared login state', async () => {
    let auth = { accessToken: 'expired', realUserID: 'user-1' };
    const authContextResolver = vi.fn(async ({ forceRefresh }: { forceRefresh: boolean }) => {
      if (forceRefresh) auth = { accessToken: 'fresh', realUserID: 'user-1' };
      return auth;
    });
    const requests: Array<{ url: URL; headers: Headers }> = [];
    const service = new TuiFeedbackService({
      appVersion: '0.1.0-test',
      authContextGetter: () => auth,
      authContextResolver,
      diagnosticLogUploader: vi.fn(async () => ({ uploadId: 'upload-1' })),
      fetchImpl: vi.fn(async (input, init) => {
        requests.push({ url: new URL(String(input)), headers: new Headers(init?.headers) });
        return requests.length === 1
          ? new Response('expired', { status: 401 })
          : ticketResponse('ticket-after-refresh');
      }),
    });
    const preview = service.prepare({ description: 'Expired login' });

    await expect(service.submit(preview.draftId)).resolves.toMatchObject({
      ticketId: 'ticket-after-refresh',
    });
    expect(authContextResolver).toHaveBeenCalledWith(
      expect.objectContaining({ forceRefresh: true }),
    );
    expect(requests.map((request) => request.url.searchParams.has('token'))).toEqual([false, false]);
    expect(requests.map((request) => request.headers.get('authorization'))).toEqual([
      'Bearer expired',
      'Bearer fresh',
    ]);
    expect(requests.map((request) => request.headers.has('token'))).toEqual([false, false]);
  });

  it('does not treat feedback permission rejection as an expired login', async () => {
    const authContextResolver = vi.fn();
    const service = new TuiFeedbackService({
      appVersion: '0.1.0-test',
      authContextGetter: () => ({ accessToken: 'managed-token', realUserID: 'user-1' }),
      authContextResolver,
      fetchImpl: vi.fn(async () => new Response('forbidden', { status: 403 })),
    });
    const preview = service.prepare({ description: 'Forbidden feedback' });

    await expect(service.submit(preview.draftId)).rejects.toMatchObject({
      code: 'feedback_upload_failed',
      statusCode: 403,
    });
    expect(authContextResolver).not.toHaveBeenCalled();
  });

  it('resolves a token-only login before sending feedback and never sends user_id=0', async () => {
    const requests: URL[] = [];
    const service = new TuiFeedbackService({
      appVersion: '0.1.0-test',
      authContextGetter: () => ({ accessToken: 'managed-token' }),
      authContextResolver: vi.fn(async () => ({
        accessToken: 'managed-token',
        realUserID: 'resolved-user',
      })),
      fetchImpl: vi.fn(async (input) => {
        requests.push(new URL(String(input)));
        return ticketResponse('ticket-with-identity');
      }),
    });
    const preview = service.prepare({ description: 'Resolve identity' });

    await expect(service.submit(preview.draftId)).resolves.toMatchObject({
      ticketId: 'ticket-with-identity',
    });
    expect(requests[0]?.searchParams.get('user_id')).toBe('resolved-user');
    expect(requests[0]?.searchParams.get('user_id')).not.toBe('0');
  });
});
