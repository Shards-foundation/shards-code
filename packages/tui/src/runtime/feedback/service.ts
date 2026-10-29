import { randomUUID } from 'node:crypto';
import { release } from 'node:os';

import { getRuntimeRegion, type MavisBuildEnv, type MavisRegion } from '@mavis/config';

import type {
  TuiFeedbackPhase,
  TuiFeedbackPreview,
  TuiFeedbackReceipt,
  TuiFeedbackSubmitOptions,
} from '../port.js';
import {
  cleanFeedbackText,
  confirmFeedbackReceipt,
  feedbackEndpoint,
  feedbackHttpDiagnostic,
  feedbackListRequest,
  feedbackPayload,
  feedbackReceipt,
  feedbackRequest,
  readUploadId,
} from './ticket.js';

export interface TuiFeedbackServiceOptions {
  readonly appVersion: string;
  readonly authContextGetter: () =>
    | { readonly accessToken?: string; readonly realUserID?: string }
    | undefined;
  readonly authContextResolver?: (options: {
    readonly forceRefresh: boolean;
    readonly signal: AbortSignal;
  }) => Promise<{ readonly accessToken?: string; readonly realUserID?: string } | undefined>;
  readonly diagnosticLogUploader?: (input: {
    readonly description: string;
    readonly sessionId?: string;
    readonly signal: AbortSignal;
  }) => Promise<{ readonly uploadId: string }>;
  readonly fetchImpl?: typeof fetch;
  readonly endpoint?: string;
  readonly timeoutMs?: number;
  readonly draftTtlMs?: number;
  readonly nowMs?: () => number;
  readonly createDraftId?: () => string;
  readonly platform?: () => PlatformSnapshot;
  readonly region?: () => MavisRegion;
  readonly buildEnv?: () => MavisBuildEnv;
}

interface PlatformSnapshot {
  readonly platform: string;
  readonly arch: string;
  readonly nodeVersion: string;
  readonly osVersion: string;
}

interface FeedbackDraft {
  readonly preview: TuiFeedbackPreview;
  readonly sessionId?: string;
  readonly platform: PlatformSnapshot;
  receipt?: TuiFeedbackReceipt;
  diagnosticUploadId?: string;
  activeController?: AbortController;
  cancelled: boolean;
}

export class TuiFeedbackError extends Error {
  override readonly name = 'TuiFeedbackError';

  constructor(
    message: string,
    readonly code: string,
    readonly statusCode: number,
    readonly retryable: boolean,
  ) {
    super(message);
  }
}

const DEFAULT_TIMEOUT_MS = 180_000;
const DEFAULT_DRAFT_TTL_MS = 15 * 60_000;
const MAX_ACTIVE_DRAFTS = 32;
const FEEDBACK_CONFIRMATION_LIMIT = 20;

export class TuiFeedbackService {
  private readonly drafts = new Map<string, FeedbackDraft>();
  private readonly fetchImpl: typeof fetch;
  private readonly nowMs: () => number;
  private readonly createDraftId: () => string;
  private readonly timeoutMs: number;
  private readonly draftTtlMs: number;
  private readonly platform: () => PlatformSnapshot;

  constructor(private readonly options: TuiFeedbackServiceOptions) {
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch;
    this.nowMs = options.nowMs ?? Date.now;
    this.createDraftId = options.createDraftId ?? (() => `feedback_${randomUUID()}`);
    this.timeoutMs = positiveMs(options.timeoutMs, DEFAULT_TIMEOUT_MS);
    this.draftTtlMs = positiveMs(options.draftTtlMs, DEFAULT_DRAFT_TTL_MS);
    this.platform =
      options.platform ??
      (() => ({
        platform: process.platform,
        arch: process.arch,
        nodeVersion: process.versions.node,
        osVersion: release(),
      }));
  }

  prepare(input: {
    readonly description: string;
    readonly sessionId?: string;
  }): TuiFeedbackPreview {
    this.pruneExpiredDrafts();
    const description = normalizeDescription(input.description);
    const sessionId = normalizeSessionId(input.sessionId);
    const platform = this.platform();
    const createdAtMs = this.nowMs();
    const draftId = this.uniqueDraftId();
    const preview: TuiFeedbackPreview = {
      schemaVersion: 1,
      draftId,
      description,
      diagnostics: [
        { label: 'Client', value: `mcode ${cleanFeedbackText(this.options.appVersion)}` },
        { label: 'Runtime', value: 'clean · cli' },
        {
          label: 'Platform',
          value: `${cleanFeedbackText(platform.platform)} ${cleanFeedbackText(platform.arch)} · Node ${cleanFeedbackText(platform.nodeVersion)}`,
        },
        { label: 'OS', value: cleanFeedbackText(platform.osVersion) },
        { label: 'Session', value: sessionId ?? 'not included' },
      ],
      diagnosticBundleIncluded: Boolean(this.options.diagnosticLogUploader),
      included: [
        'reviewed feedback description with recognized credentials redacted',
        'bounded client, Runtime, platform, and optional Session metadata',
        ...(this.options.diagnosticLogUploader
          ? [
              'diagnostic counts from the selected Session subtree (including messages, snapshots, and report artifacts); original contents and filenames are omitted',
              'bounded diagnostic counts from Runtime, CLI, and terminal logs and events from the last 2 days',
              'only known roles, states, error types/codes, HTTP statuses, and parse/omission counts are retained',
            ]
          : []),
      ],
      excluded: [
        'stored credentials and authentication files',
        'raw attachments, prompts, conversation text, tool arguments/results, local paths, file contents, and free-text errors',
        ...(this.options.diagnosticLogUploader
          ? ['unrelated sessions, workspace files, and config files']
          : [
              'canonical full conversation and tool-call history (messages.jsonl)',
              'file contents and diagnostic log bodies',
              'workspace and config file contents',
            ]),
      ],
      expiresAtMs: createdAtMs + this.draftTtlMs,
    };
    this.makeDraftCapacity();
    this.drafts.set(draftId, {
      preview,
      ...(sessionId ? { sessionId } : {}),
      platform,
      cancelled: false,
    });
    return structuredClone(preview);
  }

  async submit(
    draftId: string,
    options: TuiFeedbackSubmitOptions = {},
  ): Promise<TuiFeedbackReceipt> {
    const draft = this.requireDraft(draftId);
    if (draft.receipt) return structuredClone(draft.receipt);
    if (draft.activeController)
      throw feedbackError(
        'Feedback upload is already in progress.',
        'feedback_upload_failed',
        409,
        true,
      );
    reportFeedbackPhase(options, 'preparing');
    const signal = options.signal;
    let auth = this.options.authContextGetter();
    let token = auth?.accessToken?.trim();
    if (!token)
      throw feedbackError(
        'Shards Code sign-in is required. Run /login, then retry.',
        'feedback_login_required',
        401,
        true,
      );
    const controller = new AbortController();
    draft.activeController = controller;
    draft.cancelled = false;
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      controller.abort(new DOMException('Feedback upload timed out.', 'TimeoutError'));
    }, this.timeoutMs);
    timeout.unref?.();
    const abort = () => controller.abort(signal?.reason);
    if (signal?.aborted) abort();
    else signal?.addEventListener('abort', abort, { once: true });
    let submittedAtMs: number | undefined;
    let confirmationToken: string | undefined;
    let confirmationUserID: string | undefined;
    try {
      if (!auth?.realUserID?.trim() && this.options.authContextResolver) {
        auth = await this.options.authContextResolver({
          forceRefresh: false,
          signal: controller.signal,
        });
        token = auth?.accessToken?.trim();
      }
      const realUserID = auth?.realUserID?.trim();
      if (!token)
        throw feedbackError(
          'Shards Code sign-in is required. Run /login, then retry.',
          'feedback_login_required',
          401,
          true,
        );
      if (!realUserID)
        throw feedbackError(
          'Shards Code account identity is not ready. Check the connection, then retry.',
          'feedback_upload_failed',
          503,
          true,
        );
      confirmationToken = token;
      confirmationUserID = realUserID;
      if (this.options.diagnosticLogUploader) {
        reportFeedbackPhase(options, 'uploading-diagnostics');
      }
      await this.uploadDiagnostics(draft, controller.signal);
      reportFeedbackPhase(options, 'creating-ticket');
      const payload = feedbackPayload(
        {
          description: draft.preview.description,
          ...(draft.sessionId ? { sessionId: draft.sessionId } : {}),
          platform: draft.platform,
          ...(draft.diagnosticUploadId ? { diagnosticUploadId: draft.diagnosticUploadId } : {}),
        },
        this.options.appVersion,
      );
      submittedAtMs = this.nowMs();
      let response = await this.submitTicket(payload, token, realUserID, controller.signal);
      if (response.status === 401 && this.options.authContextResolver) {
        const refreshedAuth = await this.options.authContextResolver({
          forceRefresh: true,
          signal: controller.signal,
        });
        const refreshedToken = refreshedAuth?.accessToken?.trim();
        const refreshedUserID = refreshedAuth?.realUserID?.trim();
        if (refreshedToken && refreshedUserID) {
          confirmationToken = refreshedToken;
          confirmationUserID = refreshedUserID;
          response = await this.submitTicket(
            payload,
            refreshedToken,
            refreshedUserID,
            controller.signal,
          );
        }
      }
      if (!response.ok) {
        throw await httpError(response);
      }
      const receipt = await feedbackReceipt(response);
      draft.receipt = {
        ...receipt,
        ...(draft.diagnosticUploadId ? { uploadId: draft.diagnosticUploadId } : {}),
      };
      reportFeedbackPhase(options, 'completed');
      return structuredClone(draft.receipt);
    } catch (error) {
      const deliveryDiagnostic = feedbackFailureDiagnostic(error);
      if (
        submittedAtMs !== undefined &&
        confirmationToken &&
        confirmationUserID &&
        !timedOut &&
        !draft.cancelled &&
        !signal?.aborted
      ) {
        const receipt = await this.confirmSubmittedTicket(
          draft,
          submittedAtMs,
          confirmationToken,
          confirmationUserID,
          controller.signal,
        );
        if (receipt) {
          draft.receipt = {
            ...receipt,
            ...(draft.diagnosticUploadId ? { uploadId: draft.diagnosticUploadId } : {}),
          };
          reportFeedbackPhase(options, 'completed');
          return structuredClone(draft.receipt);
        }
      }
      if (error instanceof TuiFeedbackError) throw error;
      if (timedOut)
        throw feedbackError(
          'Feedback upload timed out. Press Enter to retry.',
          'feedback_timeout',
          504,
          true,
        );
      if (draft.cancelled || signal?.aborted)
        throw feedbackError('Feedback upload was cancelled.', 'feedback_cancelled', 499, false);
      if (error instanceof TypeError)
        throw feedbackError(
          `Feedback POST network error: ${deliveryDiagnostic}`,
          'feedback_offline',
          503,
          true,
        );
      throw feedbackError(
        deliveryDiagnostic || 'Feedback upload failed without an error detail.',
        'feedback_upload_failed',
        502,
        true,
      );
    } finally {
      clearTimeout(timeout);
      signal?.removeEventListener('abort', abort);
      draft.activeController = undefined;
    }
  }

  private async submitTicket(
    payload: Record<string, unknown>,
    token: string,
    realUserID: string,
    signal: AbortSignal,
  ): Promise<Response> {
    const request = feedbackRequest({
      endpoint: feedbackEndpoint(this.options),
      payload,
      token,
      realUserID,
      appVersion: this.options.appVersion,
      region: (this.options.region ?? getRuntimeRegion)(),
      nowMs: this.nowMs(),
    });
    return this.fetchImpl(request.url, {
      method: 'POST',
      headers: request.headers,
      body: request.body,
      signal,
    });
  }

  private async confirmSubmittedTicket(
    draft: FeedbackDraft,
    submittedAtMs: number,
    token: string,
    realUserID: string,
    signal: AbortSignal,
  ): Promise<TuiFeedbackReceipt | undefined> {
    try {
      const nowMs = this.nowMs();
      const request = feedbackListRequest({
        endpoint: feedbackEndpoint(this.options),
        token,
        realUserID,
        appVersion: this.options.appVersion,
        region: (this.options.region ?? getRuntimeRegion)(),
        nowMs,
        limit: FEEDBACK_CONFIRMATION_LIMIT,
      });
      const response = await this.fetchImpl(request.url, {
        method: 'GET',
        headers: request.headers,
        signal,
      });
      return confirmFeedbackReceipt(response, {
        description: draft.preview.description,
        submittedAtMs,
        nowMs,
      });
    } catch {
      return undefined;
    }
  }

  cancel(draftId: string): boolean {
    const draft = this.drafts.get(draftId);
    if (!draft) return false;
    draft.cancelled = true;
    draft.activeController?.abort(new DOMException('Feedback upload cancelled.', 'AbortError'));
    this.drafts.delete(draftId);
    return true;
  }

  private async uploadDiagnostics(draft: FeedbackDraft, signal: AbortSignal): Promise<void> {
    if (!this.options.diagnosticLogUploader || draft.diagnosticUploadId) return;
    try {
      const upload = await this.options.diagnosticLogUploader({
        description: draft.preview.description,
        ...(draft.sessionId ? { sessionId: draft.sessionId } : {}),
        signal,
      });
      const uploadId = readUploadId(upload.uploadId);
      if (!uploadId) throw new Error('Feedback diagnostic upload returned an invalid receipt.');
      draft.diagnosticUploadId = uploadId;
    } catch (error) {
      if (signal.aborted) throw error;
    }
  }

  private requireDraft(draftId: string): FeedbackDraft {
    this.pruneExpiredDrafts();
    const draft = this.drafts.get(draftId);
    if (!draft)
      throw feedbackError(
        'Feedback draft was not found or has expired.',
        'feedback_not_found',
        404,
        false,
      );
    return draft;
  }

  private uniqueDraftId(): string {
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const draftId = this.createDraftId();
      if (draftId && !this.drafts.has(draftId)) return draftId;
    }
    return `feedback_${randomUUID()}`;
  }

  private pruneExpiredDrafts(): void {
    const nowMs = this.nowMs();
    for (const [draftId, draft] of this.drafts) {
      if (draft.preview.expiresAtMs > nowMs) continue;
      this.cancel(draftId);
    }
  }

  private makeDraftCapacity(): void {
    while (this.drafts.size >= MAX_ACTIVE_DRAFTS) {
      const draftId = this.drafts.keys().next().value as string | undefined;
      if (!draftId) return;
      this.cancel(draftId);
    }
  }
}

function normalizeDescription(value: string): string {
  const description = cleanFeedbackText(value.trim());
  if (!description)
    throw feedbackError(
      'Feedback description is required.',
      'feedback_invalid_request',
      400,
      false,
    );
  if (Array.from(description).length > 4_000)
    throw feedbackError(
      'Feedback description must be 4000 characters or fewer.',
      'feedback_invalid_request',
      400,
      false,
    );
  return description;
}

function normalizeSessionId(value: string | undefined): string | undefined {
  const sessionId = value === undefined ? undefined : cleanFeedbackText(value.trim());
  if (!sessionId) return undefined;
  if (Array.from(sessionId).length > 256)
    throw feedbackError('Feedback session id is too long.', 'feedback_invalid_request', 400, false);
  return sessionId;
}

async function httpError(response: Response): Promise<TuiFeedbackError> {
  const status = response.status;
  const diagnostic = await feedbackHttpDiagnostic(response);
  if (status === 401)
    return feedbackError(
      `${diagnostic} Run /login, then retry.`,
      'feedback_login_required',
      status,
      true,
    );
  if (status === 403)
    return feedbackError(
      `${diagnostic} Feedback submission is not available for this account or environment.`,
      'feedback_upload_failed',
      status,
      false,
    );
  if (status === 408 || status === 504)
    return feedbackError(
      `${diagnostic} Feedback upload timed out.`,
      'feedback_timeout',
      status,
      true,
    );
  return feedbackError(
    diagnostic,
    'feedback_upload_failed',
    status,
    status === 429 || status >= 500,
  );
}

function feedbackFailureDiagnostic(error: unknown): string {
  return cleanFeedbackText(error instanceof Error ? error.message : String(error));
}

function feedbackError(
  message: string,
  code: string,
  statusCode: number,
  retryable: boolean,
): TuiFeedbackError {
  return new TuiFeedbackError(message, code, statusCode, retryable);
}

function positiveMs(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}

function reportFeedbackPhase(options: TuiFeedbackSubmitOptions, phase: TuiFeedbackPhase): void {
  try {
    options.onPhase?.(phase);
  } catch {
    // Presentation observers must not change feedback delivery or outcome.
  }
}
