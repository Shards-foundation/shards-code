import { createHash } from 'node:crypto';

import type { LocalRuntimeAuthContextSnapshot, MavisBuildEnv, MavisRegion } from '@mavis/config';

import type { TuiTokenPlanQuota, TuiTokenPlanSummary } from '../runtime/port.js';

const MATRIX_ORIGINS: Readonly<Record<MavisRegion, Record<MavisBuildEnv, string>>> = {
  cn: {
    prod: 'https://agent.minimaxi.com',
    staging: 'https://matrix-pre.example.invalid',
    test: 'https://matrix-test.example.invalid',
    dev: 'https://matrix-test.example.invalid',
  },
  en: {
    prod: 'https://agent.minimax.io',
    staging: 'https://matrix-overseas-pre.example.invalid',
    test: 'https://matrix-overseas-test.example.invalid',
    dev: 'https://matrix-overseas-test.example.invalid',
  },
};

const USER_EXTRA_INFO_PATH = '/matrix/api/v1/user/get_user_extra_info';
const MEMBERSHIP_INFO_PATH = '/matrix/api/v1/commerce/get_membership_info';
const USER_INFO_PATH = '/v1/api/user/info';
const TOKEN_PLAN_REMAINS_PATH = '/v1/api/openplatform/coding_plan/remains';
const TOKEN_RENEWAL_PATH = '/v1/api/user/renewal';
const DEFAULT_TIMEOUT_MS = 3_000;
const DEFAULT_MEMBERSHIP_CACHE_TTL_MS = 30_000;
const DEFAULT_QUOTA_CACHE_TTL_MS = 5_000;
const NEED_LOGIN_ERROR_CODE = 1_000_048;

// Requests below carry `yy` / `x-timestamp` / `x-signature` client attribution
// headers built from two inline literals.
//
// Those literals tag a request as coming from a first-party MiniMax client. They are
// shared across clients and are not credentials or a security boundary: request
// authorization is the `Authorization: Bearer` token sent on the same request.
//
// Changing either value requires a coordinated server-side rollout, so treat them as
// wire-protocol constants.

const OPEN_PLATFORM_ORIGINS: Readonly<Record<MavisRegion, Record<MavisBuildEnv, string>>> = {
  cn: {
    prod: 'https://www.minimaxi.com',
    staging: 'https://open-platform-for-online-test.example.invalid',
    test: 'https://openplatform-test.example.invalid',
    dev: 'https://openplatform-test.example.invalid',
  },
  en: {
    prod: 'https://platform.minimax.io',
    staging: 'https://mmx-pre.example.invalid',
    test: 'https://mmx-test.example.invalid',
    dev: 'https://mmx-test.example.invalid',
  },
};

export type TuiAccountIdentity = LocalRuntimeAuthContextSnapshot;

export interface TuiTokenPlanMembership {
  readonly hasTokenPlan?: boolean;
  readonly opGroupId?: string;
  readonly summary?: TuiTokenPlanSummary;
}

export interface TuiTokenPlanAccountStatus extends TuiTokenPlanMembership {
  readonly quotaState?: 'available' | 'not-subscribed' | 'unavailable';
  readonly quota?: TuiTokenPlanQuota;
}

export interface TuiTokenPlanAccountStatusOptions {
  readonly forceRefresh?: boolean;
}

export interface TuiMatrixAccountClientOptions {
  readonly authContextGetter: () => TuiAccountIdentity | undefined;
  readonly routingContextGetter?: () => { readonly bedrockLane?: string } | undefined;
  readonly region: MavisRegion;
  readonly buildEnv: MavisBuildEnv;
  readonly fetchImpl?: typeof fetch;
  readonly timeoutMs?: number;
  readonly membershipCacheTtlMs?: number;
  readonly quotaCacheTtlMs?: number;
  readonly now?: () => number;
  readonly timezoneOffsetSeconds?: () => number;
}

interface ResolvedTokenPlanBillingContext {
  readonly membership: TuiTokenPlanMembership;
  readonly accessToken?: string;
  readonly personalOpGroupId?: string;
}

interface PersonalWorkspaceContext {
  readonly workspaceId: number | string;
  readonly membership: TuiTokenPlanMembership;
}

interface BillingContextCacheEntry {
  readonly key: string;
  readonly expiresAtMs: number;
  readonly value: ResolvedTokenPlanBillingContext;
}

interface QuotaCacheEntry {
  readonly key: string;
  readonly expiresAtMs: number;
  readonly value: TuiTokenPlanQuota | undefined;
}

interface PendingRequest<T> {
  readonly key: string;
  readonly promise: Promise<T>;
}

export class TuiMatrixAccountClient {
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  private readonly now: () => number;
  private readonly timezoneOffsetSeconds: () => number;
  private readonly membershipCacheTtlMs: number;
  private readonly quotaCacheTtlMs: number;
  private resolvedIdentity: TuiAccountIdentity | undefined;
  private billingContextCache: BillingContextCacheEntry | undefined;
  private billingContextRequest: PendingRequest<ResolvedTokenPlanBillingContext> | undefined;
  private quotaCache: QuotaCacheEntry | undefined;
  private quotaRequest: PendingRequest<TuiTokenPlanQuota | undefined> | undefined;

  constructor(private readonly options: TuiMatrixAccountClientOptions) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.membershipCacheTtlMs = normalizeCacheTtl(
      options.membershipCacheTtlMs,
      DEFAULT_MEMBERSHIP_CACHE_TTL_MS,
    );
    this.quotaCacheTtlMs = normalizeCacheTtl(options.quotaCacheTtlMs, DEFAULT_QUOTA_CACHE_TTL_MS);
    this.now = options.now ?? Date.now;
    this.timezoneOffsetSeconds =
      options.timezoneOffsetSeconds ?? (() => new Date().getTimezoneOffset() * -60);
  }

  async getTokenPlanMembership(signal?: AbortSignal): Promise<TuiTokenPlanMembership> {
    return (await this.resolveTokenPlanBillingContext(signal)).membership;
  }

  async getRealUserID(signal?: AbortSignal): Promise<string | undefined> {
    const auth = this.options.authContextGetter();
    const accessToken = auth?.accessToken?.trim();
    if (!accessToken) return undefined;
    return this.resolveRealUserID(accessToken, auth?.realUserID, signal);
  }

  async getRealUserIDForAuth(
    auth: TuiAccountIdentity,
    signal?: AbortSignal,
  ): Promise<string | undefined> {
    return (await this.getAuthContextForAuth(auth, signal))?.realUserID;
  }

  async getAuthContextForAuth(
    auth: TuiAccountIdentity,
    signal?: AbortSignal,
  ): Promise<TuiAccountIdentity | undefined> {
    const accessToken = auth.accessToken?.trim();
    if (!accessToken) return undefined;
    return { accessToken, ...(await this.fetchAccountIdentity(accessToken, signal)) };
  }

  async getTokenPlanAccountStatus(
    signal?: AbortSignal,
    options: TuiTokenPlanAccountStatusOptions = {},
  ): Promise<TuiTokenPlanAccountStatus> {
    const signedIn = Boolean(this.options.authContextGetter()?.accessToken?.trim());
    let resolved: ResolvedTokenPlanBillingContext;
    try {
      resolved = await this.resolveTokenPlanBillingContext(signal, options.forceRefresh === true);
    } catch (error) {
      if (signal?.aborted) throw error;
      return signedIn ? { quotaState: 'unavailable' } : {};
    }
    const { membership, accessToken, personalOpGroupId } = resolved;
    if (membership.hasTokenPlan === false) {
      return { ...membership, quotaState: 'not-subscribed' };
    }
    if (!accessToken) return membership;
    if (!personalOpGroupId) return { ...membership, quotaState: 'unavailable' };
    const quota = await this.getTokenPlanQuota(
      accessToken,
      personalOpGroupId,
      signal,
      options.forceRefresh === true,
    ).catch(() => undefined);
    return {
      ...membership,
      quotaState: quota ? 'available' : 'unavailable',
      ...(quota ? { quota } : {}),
    };
  }

  private async resolveTokenPlanBillingContext(
    signal?: AbortSignal,
    forceRefresh = false,
  ): Promise<ResolvedTokenPlanBillingContext> {
    const auth = this.options.authContextGetter();
    const accessToken = auth?.accessToken?.trim();
    if (!accessToken) return { membership: {} };
    const cacheKey = accessToken;
    if (!signal) {
      const cached = this.billingContextCache;
      if (!forceRefresh && cached?.key === cacheKey && cached.expiresAtMs > this.now()) {
        return cached.value;
      }
      if (this.billingContextRequest?.key === cacheKey) {
        return this.billingContextRequest.promise;
      }
    }

    const request = this.resolveTokenPlanBillingContextUncached(
      accessToken,
      auth?.realUserID,
      signal,
    );
    if (signal) return request;

    this.billingContextRequest = { key: cacheKey, promise: request };
    void request
      .then(
        (value) => {
          if (this.billingContextRequest?.promise !== request) return;
          this.billingContextCache = {
            key: cacheKey,
            expiresAtMs: this.now() + this.membershipCacheTtlMs,
            value,
          };
        },
        () => undefined,
      )
      .then(() => {
        if (this.billingContextRequest?.promise === request) {
          this.billingContextRequest = undefined;
        }
      });
    return request;
  }

  private async resolveTokenPlanBillingContextUncached(
    accessToken: string,
    configuredRealUserID: string | undefined,
    signal?: AbortSignal,
  ): Promise<ResolvedTokenPlanBillingContext> {
    const realUserID = await this.resolveRealUserID(accessToken, configuredRealUserID, signal);

    let personalWorkspace: PersonalWorkspaceContext | undefined;
    try {
      const userExtra = await this.postMatrixJson(
        USER_EXTRA_INFO_PATH,
        {},
        accessToken,
        realUserID,
        'workspace lookup',
        signal,
      );
      personalWorkspace = projectPersonalWorkspace(userExtra);
    } catch (error) {
      if (signal?.aborted) throw error;
      const fallback = await this.postMatrixJson(
        MEMBERSHIP_INFO_PATH,
        {},
        accessToken,
        realUserID,
        'membership request',
        signal,
      );
      return { membership: projectMembership(fallback), accessToken };
    }

    if (!personalWorkspace) return { membership: {}, accessToken };

    const personalMembership = personalWorkspace.membership;
    const personalOpGroupId = personalMembership.opGroupId;
    try {
      const scopedMembership = await this.postMatrixJson(
        MEMBERSHIP_INFO_PATH,
        { workspace_id: personalWorkspace.workspaceId },
        accessToken,
        realUserID,
        'membership request',
        signal,
      );
      return {
        membership: mergeMembership(personalMembership, projectMembership(scopedMembership)),
        accessToken,
        ...(personalOpGroupId ? { personalOpGroupId } : {}),
      };
    } catch (error) {
      if (signal?.aborted) throw error;
      return {
        membership: personalMembership,
        accessToken,
        ...(personalOpGroupId ? { personalOpGroupId } : {}),
      };
    }
  }

  private async resolveRealUserID(
    accessToken: string,
    configuredRealUserID: string | undefined,
    signal?: AbortSignal,
  ): Promise<string> {
    const configured = configuredRealUserID?.trim();
    if (configured) return configured;
    const resolvedRealUserID = this.resolvedIdentity?.realUserID?.trim();
    if (this.resolvedIdentity?.accessToken === accessToken && resolvedRealUserID) {
      return resolvedRealUserID;
    }

    return (await this.fetchAccountIdentity(accessToken, signal)).realUserID;
  }

  private async fetchAccountIdentity(
    accessToken: string,
    signal?: AbortSignal,
  ): Promise<TuiAccountIdentity & { readonly realUserID: string }> {
    const requestTime = this.now();
    const url = this.buildUrl(USER_INFO_PATH, requestTime);
    const pathWithSearch = `${url.pathname}${url.search}`;
    const second = Math.floor(requestTime / 1_000);
    const scopedSignal = createScopedSignal(signal, this.timeoutMs);
    try {
      const response = await this.fetchImpl(url, {
        method: 'GET',
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/json',
          'User-Agent': 'MiniMaxCode',
          Authorization: `Bearer ${accessToken}`,
          ...this.routingHeaders(),
          yy: md5(`${encodeURIComponent(pathWithSearch)}_{}${md5(String(requestTime))}ooui`),
          'x-timestamp': String(second),
          'x-signature': md5(`${second}I*7Cf%WZ#S&%1RlZJ&C2`),
        },
        signal: scopedSignal.signal,
      });
      if (response.status === 401 || response.status === 403) {
        throw new TuiAuthenticationError(response.status);
      }
      if (!response.ok) {
        throw new Error(`Shards Code account identity request failed with HTTP ${response.status}`);
      }
      const body = asRecord(await response.json());
      if (!body) throw new Error('Shards Code account identity request returned an invalid response');
      assertSuccessfulResponse(body, 'account identity request');
      const data = asRecord(body.data);
      const userInfo =
        asRecord(data?.userInfo) ??
        asRecord(data?.user_info) ??
        asRecord(body.userInfo) ??
        asRecord(body.user_info);
      const realUserID =
        readString(userInfo, undefined, 'realUserID') ??
        readString(userInfo, undefined, 'real_user_id');
      if (!realUserID) {
        throw new Error('Shards Code account identity request returned no account ID');
      }
      const identity = {
        realUserID,
        ...optionalIdentityField(userInfo, 'userEmail', 'email', 'userMail', 'user_email'),
        ...optionalIdentityField(userInfo, 'userName', 'name', 'userName', 'user_name'),
        ...optionalIdentityField(userInfo, 'subUserName', 'subUserName', 'sub_user_name'),
      };
      this.resolvedIdentity = { accessToken, ...identity };
      return identity;
    } finally {
      scopedSignal.dispose();
    }
  }

  private async postMatrixJson(
    pathname: string,
    payload: Record<string, unknown>,
    accessToken: string,
    realUserId: string | undefined,
    operation: string,
    signal?: AbortSignal,
  ): Promise<Record<string, unknown>> {
    const requestTime = this.now();
    const url = this.buildUrl(pathname, requestTime, realUserId);
    const pathWithSearch = `${url.pathname}${url.search}`;
    const second = Math.floor(requestTime / 1_000);
    const body = JSON.stringify(payload);
    const scopedSignal = createScopedSignal(signal, this.timeoutMs);

    try {
      const response = await this.fetchImpl(url, {
        method: 'POST',
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/json',
          'User-Agent': 'MiniMaxCode',
          Authorization: `Bearer ${accessToken}`,
          ...this.routingHeaders(),
          yy: md5(`${encodeURIComponent(pathWithSearch)}_${body}${md5(String(requestTime))}ooui`),
          'x-timestamp': String(second),
          'x-signature': md5(`${second}I*7Cf%WZ#S&%1RlZJ&C2${body}`),
        },
        body,
        signal: scopedSignal.signal,
      });
      if (!response.ok) {
        throw new Error(`Shards Code ${operation} failed with HTTP ${response.status}`);
      }
      const responseBody = asRecord(await response.json());
      if (!responseBody) throw new Error(`Shards Code ${operation} returned an invalid response`);
      assertSuccessfulResponse(responseBody, operation);
      return responseBody;
    } finally {
      scopedSignal.dispose();
    }
  }

  async renewAccessToken(signal?: AbortSignal): Promise<string | undefined> {
    const auth = this.options.authContextGetter();
    const accessToken = auth?.accessToken?.trim();
    if (!accessToken) return undefined;

    const requestTime = this.now();
    const url = this.buildUrl(TOKEN_RENEWAL_PATH, requestTime, auth?.realUserID);
    const pathWithSearch = `${url.pathname}${url.search}`;
    const second = Math.floor(requestTime / 1_000);
    const scopedSignal = createScopedSignal(signal, this.timeoutMs);
    try {
      const response = await this.fetchImpl(url, {
        method: 'POST',
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/json',
          'User-Agent': 'MiniMaxCode',
          Authorization: `Bearer ${accessToken}`,
          ...this.routingHeaders(),
          yy: md5(`${encodeURIComponent(pathWithSearch)}_{}${md5(String(requestTime))}ooui`),
          'x-timestamp': String(second),
          'x-signature': md5(`${second}I*7Cf%WZ#S&%1RlZJ&C2`),
        },
        signal: scopedSignal.signal,
      });
      if (response.status === 401 || response.status === 403) {
        throw new TuiAuthenticationError(response.status);
      }
      if (!response.ok) {
        throw new Error(`Shards Code token renewal failed with HTTP ${response.status}`);
      }
      const body = asRecord(await response.json());
      if (!body) throw new Error('Shards Code token renewal returned an invalid response');
      assertSuccessfulResponse(body, 'token renewal');
      const token = readString(asRecord(body.data), body, 'token');
      if (!token) throw new Error('Shards Code token renewal returned no access token');
      return token;
    } finally {
      scopedSignal.dispose();
    }
  }

  private buildUrl(pathname: string, requestTime: number, realUserId?: string): URL {
    const url = new URL(pathname, MATRIX_ORIGINS[this.options.region][this.options.buildEnv]);
    const language = this.options.region === 'cn' ? 'zh' : 'en';
    url.search = new URLSearchParams({
      device_platform: 'mcode',
      biz_id: '3',
      app_id: '3001',
      version_code: '22201',
      unix: String(requestTime),
      timezone_offset: String(this.timezoneOffsetSeconds()),
      sys_language: language,
      lang: language,
      device_id: '0',
      os_name: process.platform,
      browser_name: 'mcode',
      user_id: realUserId?.trim() || '0',
      client: 'mcode',
    }).toString();
    return url;
  }

  private routingHeaders(): Record<string, string> {
    if (this.options.buildEnv !== 'test' && this.options.buildEnv !== 'staging') return {};
    const lane = this.options.routingContextGetter?.()?.bedrockLane?.trim();
    return lane ? { lane, bedrock_lane: lane, 'bedrock-lane': lane } : {};
  }

  private async getTokenPlanQuota(
    accessToken: string,
    opGroupId: string | undefined,
    signal?: AbortSignal,
    forceRefresh = false,
  ): Promise<TuiTokenPlanQuota | undefined> {
    const cacheKey = `${accessToken}\u0000${opGroupId ?? ''}`;
    if (!signal) {
      const cached = this.quotaCache;
      if (!forceRefresh && cached?.key === cacheKey && cached.expiresAtMs > this.now()) {
        return cached.value;
      }
      if (this.quotaRequest?.key === cacheKey) return this.quotaRequest.promise;
    }

    const request = this.fetchTokenPlanQuota(accessToken, opGroupId, signal);
    if (signal) return request;
    this.quotaRequest = { key: cacheKey, promise: request };
    void request
      .then(
        (value) => {
          if (this.quotaRequest?.promise !== request) return;
          this.quotaCache = {
            key: cacheKey,
            expiresAtMs: this.now() + this.quotaCacheTtlMs,
            value,
          };
        },
        () => undefined,
      )
      .then(() => {
        if (this.quotaRequest?.promise === request) this.quotaRequest = undefined;
      });
    return request;
  }

  private async fetchTokenPlanQuota(
    accessToken: string,
    opGroupId: string | undefined,
    signal?: AbortSignal,
  ): Promise<TuiTokenPlanQuota | undefined> {
    const origin = OPEN_PLATFORM_ORIGINS[this.options.region][this.options.buildEnv];
    const scopedSignal = createScopedSignal(signal, this.timeoutMs);
    try {
      const response = await this.fetchImpl(`${origin}${TOKEN_PLAN_REMAINS_PATH}`, {
        method: 'GET',
        headers: {
          Accept: 'application/json',
          Authorization: `Bearer ${accessToken}`,
          ...(opGroupId ? { 'X-Group-Id': opGroupId } : {}),
        },
        signal: scopedSignal.signal,
      });
      if (!response.ok) return undefined;
      const body = asRecord(await response.json());
      if (!body) return undefined;
      const baseResponse = asRecord(body.base_resp);
      if (typeof baseResponse?.status_code === 'number' && baseResponse.status_code !== 0) {
        return undefined;
      }
      const modelRemains = Array.isArray(body.model_remains)
        ? body.model_remains.map(asRecord).filter((item) => item !== undefined)
        : [];
      const primary = modelRemains[0];
      if (!primary) return undefined;
      const video = modelRemains.find(
        (item) =>
          /video/iu.test(readString(item, undefined, 'model_name') ?? '') &&
          (finiteNumber(item.current_interval_total_count) ?? 0) > 0,
      );
      return {
        fiveHour: readQuotaWindow(primary, 'interval'),
        weekly: readQuotaWindow(primary, 'weekly'),
        ...(video ? { video: readVideoQuota(video) } : {}),
      };
    } finally {
      scopedSignal.dispose();
    }
  }
}

function normalizeCacheTtl(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isFinite(value) && value >= 0 ? value : fallback;
}

function optionalIdentityField(
  source: Record<string, unknown> | undefined,
  target: 'userEmail' | 'userName' | 'subUserName',
  ...candidates: string[]
): Partial<TuiAccountIdentity> {
  for (const candidate of candidates) {
    const value = readString(source, undefined, candidate);
    if (value) return { [target]: value };
  }
  return {};
}

export class TuiAuthenticationError extends Error {
  override readonly name = 'TuiAuthenticationError';

  constructor(readonly status: 401 | 403) {
    super('MiniMax sign-in expired. Run /login, then retry.');
  }
}

function assertSuccessfulResponse(body: Record<string, unknown>, operation: string): void {
  const statusInfo = asRecord(body.statusInfo);
  if (typeof statusInfo?.code === 'number' && statusInfo.code !== 0) {
    if (statusInfo.code === NEED_LOGIN_ERROR_CODE) throw new TuiAuthenticationError(401);
    throw new Error(`Shards Code ${operation} failed with status ${statusInfo.code}`);
  }
  const baseResponse = asRecord(body.base_resp);
  if (typeof baseResponse?.status_code === 'number' && baseResponse.status_code !== 0) {
    throw new Error(`Shards Code ${operation} failed with status ${baseResponse.status_code}`);
  }
}

function projectMembership(body: Record<string, unknown>): TuiTokenPlanMembership {
  const data = asRecord(body.data);
  const hasTokenPlan = readBoolean(body, data, 'has_token_plan');
  const opGroupId = readString(body, data, 'op_group_id');
  const tier = readString(body, data, 'token_plan_tier');
  const expiresAtMs = readPositiveNumber(body, data, 'token_plan_expires_at');
  const creditSummary = asRecord(body.op_credit_summary) ?? asRecord(data?.op_credit_summary);
  const creditBalance =
    readString(creditSummary, undefined, 'total_remaining_amount') ??
    readNumberishString(body, data, 'opcredit_balance');
  const summary = compactSummary({ tier, expiresAtMs, creditBalance });
  return {
    ...(hasTokenPlan !== undefined ? { hasTokenPlan } : {}),
    ...(opGroupId ? { opGroupId } : {}),
    ...(summary ? { summary } : {}),
  };
}

function projectPersonalWorkspace(
  body: Record<string, unknown>,
): PersonalWorkspaceContext | undefined {
  const data = asRecord(body.data);
  const workspaces = Array.isArray(body.workspaces)
    ? body.workspaces
    : Array.isArray(data?.workspaces)
      ? data.workspaces
      : [];
  for (const value of workspaces) {
    const workspace = asRecord(value);
    if (!workspace || finiteNumber(workspace.workspace_type) !== 0) continue;
    const workspaceId = readWorkspaceId(workspace.workspace_id);
    if (workspaceId === undefined) continue;
    return { workspaceId, membership: projectMembership(workspace) };
  }
  return undefined;
}

function mergeMembership(
  personal: TuiTokenPlanMembership,
  scoped: TuiTokenPlanMembership,
): TuiTokenPlanMembership {
  const hasTokenPlan =
    personal.hasTokenPlan === true || scoped.hasTokenPlan === true
      ? true
      : personal.hasTokenPlan === false || scoped.hasTokenPlan === false
        ? false
        : undefined;
  const summary = compactSummary({
    ...personal.summary,
    ...scoped.summary,
  });
  return {
    ...(hasTokenPlan !== undefined ? { hasTokenPlan } : {}),
    ...(personal.opGroupId || scoped.opGroupId
      ? { opGroupId: personal.opGroupId ?? scoped.opGroupId }
      : {}),
    ...(summary ? { summary } : {}),
  };
}

function readWorkspaceId(value: unknown): number | string | undefined {
  if (typeof value === 'number' && Number.isFinite(value) && value >= 0) return value;
  if (typeof value === 'string' && value.trim()) return value.trim();
  return undefined;
}

function readQuotaWindow(
  value: Record<string, unknown>,
  kind: 'interval' | 'weekly',
): TuiTokenPlanQuota['fiveHour'] {
  const prefix = kind === 'interval' ? 'current_interval' : 'current_weekly';
  const status = finiteNumber(value[`${prefix}_status`]);
  const unlimited = status === 3;
  const remaining = finiteNumber(value[`${prefix}_remaining_percent`]);
  const total = finiteNumber(value[`${prefix}_total_count`]);
  const legacyRemaining = finiteNumber(value[`${prefix}_usage_count`]);
  const calculated =
    remaining ??
    (total !== undefined && total > 0 && legacyRemaining !== undefined
      ? (legacyRemaining / total) * 100
      : undefined);
  const resetAtMs = finiteNumber(value[kind === 'interval' ? 'end_time' : 'weekly_end_time']);
  return {
    ...(unlimited || calculated === undefined
      ? {}
      : { remainingPercent: Math.round(Math.min(100, Math.max(0, calculated))) }),
    ...(resetAtMs !== undefined && resetAtMs > 0 ? { resetAtMs } : {}),
    unlimited,
  };
}

function readVideoQuota(value: Record<string, unknown>): NonNullable<TuiTokenPlanQuota['video']> {
  const status = finiteNumber(value.current_interval_status);
  const totalCount = finiteNumber(value.current_interval_total_count);
  const remainingCount = finiteNumber(value.current_interval_usage_count);
  const resetAtMs = finiteNumber(value.end_time);
  return {
    ...(remainingCount === undefined ? {} : { remainingCount: Math.max(0, remainingCount) }),
    ...(totalCount === undefined ? {} : { totalCount: Math.max(0, totalCount) }),
    ...(resetAtMs !== undefined && resetAtMs > 0 ? { resetAtMs } : {}),
    unlimited: status === 3,
  };
}

function createScopedSignal(
  upstream: AbortSignal | undefined,
  timeoutMs: number,
): { signal: AbortSignal; dispose(): void } {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  return {
    signal: upstream ? AbortSignal.any([upstream, controller.signal]) : controller.signal,
    dispose: () => clearTimeout(timer),
  };
}

function compactSummary(summary: TuiTokenPlanSummary): TuiTokenPlanSummary | undefined {
  return summary.tier || summary.expiresAtMs || summary.creditBalance ? summary : undefined;
}

function readBoolean(
  primary: Record<string, unknown> | undefined,
  fallback: Record<string, unknown> | undefined,
  key: string,
): boolean | undefined {
  const value = primary?.[key] ?? fallback?.[key];
  return typeof value === 'boolean' ? value : undefined;
}

function readString(
  primary: Record<string, unknown> | undefined,
  fallback: Record<string, unknown> | undefined,
  key: string,
): string | undefined {
  const value = primary?.[key] ?? fallback?.[key];
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function readPositiveNumber(
  primary: Record<string, unknown> | undefined,
  fallback: Record<string, unknown> | undefined,
  key: string,
): number | undefined {
  const value = primary?.[key] ?? fallback?.[key];
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined;
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function readNumberishString(
  primary: Record<string, unknown> | undefined,
  fallback: Record<string, unknown> | undefined,
  key: string,
): string | undefined {
  const value = primary?.[key] ?? fallback?.[key];
  return typeof value === 'string' || typeof value === 'number' ? String(value).trim() : undefined;
}

function md5(value: string): string {
  return createHash('md5').update(value).digest('hex');
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}
