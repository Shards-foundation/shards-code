import {
  validateClaimSigninData,
  validateSigninPanel,
  type ClaimSigninData,
  type SigninPanel,
} from '@mavis/shared/daily-signin';
import {
  getRuntimeBuildEnv,
  getRuntimeRegion,
  type MavisBuildEnv,
  type MavisRegion,
} from '@mavis/config';

import { createPublicGatewayRequest, publicGatewayOrigin } from '../runtime/public-gateway.js';
import type { TuiDailyCheckinGateway } from './application.js';

const STATUS_PATH = '/minimax-cloud/api/v1/signin/status';
const CLAIM_PATH = '/minimax-cloud/api/v1/signin/claim';

interface CheckinAuthContext {
  readonly accessToken?: string;
  readonly realUserID?: string;
}

export interface TuiDailyCheckinHttpGatewayOptions {
  readonly appVersion: string;
  readonly authContextGetter: () => CheckinAuthContext | undefined;
  readonly authContextResolver?: (options: {
    readonly forceRefresh: boolean;
    readonly signal: AbortSignal;
  }) => Promise<CheckinAuthContext | undefined>;
  readonly fetchImpl?: typeof fetch;
  readonly timeoutMs?: number;
  readonly nowMs?: () => number;
  readonly region?: () => MavisRegion;
  readonly buildEnv?: () => MavisBuildEnv;
  readonly origin?: string;
}

export class TuiDailyCheckinHttpGateway implements TuiDailyCheckinGateway {
  private readonly fetchImpl: typeof fetch;
  private readonly nowMs: () => number;
  private readonly timeoutMs: number;
  private statusAccountKey: string | undefined;

  constructor(private readonly options: TuiDailyCheckinHttpGatewayOptions) {
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch;
    this.nowMs = options.nowMs ?? Date.now;
    this.timeoutMs = options.timeoutMs ?? 30_000;
  }

  async getSigninPanel(): Promise<SigninPanel> {
    const { data, accountKey: statusAccountKey } = await this.request(STATUS_PATH, 'GET');
    this.statusAccountKey = statusAccountKey;
    return validateSigninPanel(data);
  }

  async claimSignin(): Promise<ClaimSigninData> {
    const response = await this.request(CLAIM_PATH, 'POST', this.statusAccountKey);
    this.statusAccountKey = undefined;
    return validateClaimSigninData(response.data);
  }

  private async request(
    path: string,
    method: 'GET' | 'POST',
    expectedAccountKey?: string,
  ): Promise<{ readonly data: unknown; readonly accountKey: string }> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    timeout.unref?.();
    try {
      let auth = await this.resolveAuth(false, controller.signal);
      assertExpectedAccount(auth, expectedAccountKey);
      let response = await this.fetch(path, method, auth, controller.signal);
      if (response.status === 401 && this.options.authContextResolver) {
        auth = await this.resolveAuth(true, controller.signal);
        assertExpectedAccount(auth, expectedAccountKey);
        response = await this.fetch(path, method, auth, controller.signal);
      }
      if (!response.ok) {
        throw new Error(`Daily check-in request failed with HTTP ${response.status}.`);
      }
      const body = (await response.json()) as {
        readonly base_resp?: { readonly status_code?: number; readonly status_msg?: string };
        readonly data?: unknown;
      };
      this.assertCurrentAccount(auth);
      const statusCode = body.base_resp?.status_code;
      if (typeof statusCode === 'number' && statusCode !== 0) {
        throw new Error(body.base_resp?.status_msg || 'Daily check-in request failed.');
      }
      if (body.data === null || body.data === undefined) {
        throw new Error('Daily check-in response data is missing.');
      }
      return { data: body.data, accountKey: accountKey(auth) };
    } finally {
      clearTimeout(timeout);
    }
  }

  private async resolveAuth(
    forceRefresh: boolean,
    signal: AbortSignal,
  ): Promise<{ readonly accessToken: string; readonly realUserID: string }> {
    let auth = forceRefresh ? undefined : this.options.authContextGetter();
    if ((forceRefresh || !auth?.realUserID?.trim()) && this.options.authContextResolver) {
      auth = await this.options.authContextResolver({ forceRefresh, signal });
    }
    const accessToken = auth?.accessToken?.trim();
    const realUserID = auth?.realUserID?.trim();
    if (!accessToken || !realUserID) {
      throw new Error('Shards Code sign-in is required. Run /login, then retry /checkin.');
    }
    return { accessToken, realUserID };
  }

  private fetch(
    path: string,
    method: 'GET' | 'POST',
    auth: { readonly accessToken: string; readonly realUserID: string },
    signal: AbortSignal,
  ): Promise<Response> {
    const region = (this.options.region ?? getRuntimeRegion)();
    const origin =
      this.options.origin ??
      publicGatewayOrigin({
        region: () => region,
        buildEnv: this.options.buildEnv ?? getRuntimeBuildEnv,
      });
    const body = method === 'POST' ? '{}' : undefined;
    const request = createPublicGatewayRequest({
      endpoint: `${origin}${path}`,
      token: auth.accessToken,
      realUserID: auth.realUserID,
      appVersion: this.options.appVersion,
      region,
      nowMs: this.nowMs(),
      ...(body ? { body } : {}),
    });
    return this.fetchImpl(request.url, {
      method,
      headers: request.headers,
      ...(request.body ? { body: request.body } : {}),
      signal,
    });
  }

  private assertCurrentAccount(auth: { readonly realUserID: string }): void {
    const current = this.options.authContextGetter();
    if (!current?.accessToken?.trim() || current.realUserID?.trim() !== auth.realUserID) {
      throw new Error('MiniMax account changed during daily check-in. Retry /checkin.');
    }
  }
}

function accountKey(auth: { readonly accessToken: string; readonly realUserID: string }): string {
  return auth.realUserID;
}

function assertExpectedAccount(
  auth: { readonly accessToken: string; readonly realUserID: string },
  expectedAccountKey: string | undefined,
): void {
  if (expectedAccountKey && accountKey(auth) !== expectedAccountKey) {
    throw new Error('MiniMax account changed during daily check-in. Retry /checkin.');
  }
}
