import {
  LocalRuntimeHost,
  type LocalRuntimeTurnInput,
  type LocalRuntimeTurnOutput,
  type LocalToolContext,
} from '../runtime/host.js';
import type { Api, Context, Model } from '@earendil-works/pi-ai';
import type { PiLLMRequestObserver } from '@mavis/agent-core/pi-turn-runner';
import type { MetricsClient } from '../common/metrics.js';
import type { ContextUsageToolCalibration } from '../context/context-usage-calibration.js';
import type { LocalRuntimeAuthContext } from '../runtime/model-resolver.js';
import type { LocalRuntimeRoutingContext } from '../runtime/routing-headers.js';
import type { ResolvedLocalRunLocation } from '../runtime/run-location.js';
import {
  DEFAULT_LOCAL_APP_MODE,
  resolveLocalAppMode,
  type LocalAppMode,
} from '../runtime/app-mode.js';
import { LocalSessionRouter, type LocalRuntimeTelemetrySink } from './router.js';
import {
  LocalActiveTurnTimingRegistry,
  type LocalActiveTurnTiming,
  type LocalActiveTurnTimingReader,
} from '../turns/active-turn-timing.js';
import { applyLocalSessionListOptions } from './record-list-options.js';
import type { LocalModelThinkingSelection } from '../model-provider/model-selection.js';

export { applyLocalSessionListOptions } from './record-list-options.js';

export type LocalSessionRuntime = 'pi-agent' | 'opencode';
export type LocalSessionType = 'root' | 'branch';
/**
 * Which runtime lineage produced the session's persisted data. Distinct from
 * `LocalSessionOrigin` (creation provenance: user vs root-repair).
 */
export type LocalSessionDataOrigin = 'local-runtime' | 'legacy-opencode' | 'unknown';

/**
 * Bump when the per-session persisted data shape gains a new invariant.
 * Version 2 = sessions whose display-message writes maintain the session
 * asset index incrementally. Version 3 = branch sessions capture the effective
 * application mode used by the runtime; root sessions intentionally retain
 * their existing shape. Branch records without the field remain compatible
 * and resolve to the Coding default at the policy boundary.
 */
export const CURRENT_SESSION_DATA_VERSION = 3;
export type LocalSessionStatus =
  | 'idle'
  | 'started'
  | 'finished'
  | 'error'
  | 'aborted'
  | 'interrupted';

export type LocalSessionTerminalUpdate = Pick<
  LocalSessionRecord,
  'status' | 'errorMessage' | 'errorCode' | 'errorSource' | 'errorDetail' | 'errorProviderId'
>;

export interface LocalSessionTurnResult {
  sessionStatus: LocalSessionStatus;
  waitingForUser?: boolean;
  /**
   * The runtime retracted the whole Turn after content-safety review.
   * This is deliberately orthogonal to `sessionStatus`: the ordinary
   * session still finishes cleanly, while Thread Goal must stop continuing.
   */
  retracted?: boolean;
  /**
   * Terminal session state derived from this Turn. The Thread Goal
   * orchestrator defers applying it until the full multi-Turn loop exits.
   */
  sessionUpdate?: LocalSessionTerminalUpdate;
}

export interface LocalSessionRecord {
  sessionId: string;
  agentName: string;
  workspaceDir: string;
  isDefaultWorkspace?: boolean;
  runtime: LocalSessionRuntime;
  sessionType: LocalSessionType;
  /** Stable domain classification used by product projections such as task workers. */
  sessionKind?: string;
  archived: boolean;
  title?: string | null;
  parentSessionId?: string | null;
  visibility?: 'visible' | 'hidden';
  purpose?: string;
  runLocation?: ResolvedLocalRunLocation;
  /** Effective product mode. Present on v3 branch sessions; omitted on roots. */
  appMode?: LocalAppMode;
  status: LocalSessionStatus;
  errorMessage?: string;
  errorCode?: number;
  errorSource?: string;
  errorDetail?: string;
  errorProviderId?: string;
  canRetry?: boolean;
  effectiveModel?: string | null;
  effectiveModelVariant?: string | null;
  effectiveModelThinking?: LocalModelThinkingSelection | null;
  scratchpadPath?: string;
  /**
   * Creation provenance. `'user'` marks sessions minted by an explicit user
   * action (UI create, IM `/new`) — the legacy migrator must NEVER
   * phantom-import legacy history into these. `'root-repair'` marks empty
   * shells materialised by boot root-repair paths (dangling
   * `agents.main_session_id`) — the legitimate phantom-fallback targets.
   * Absent on records created before this field existed (pre-existing shells
   * keep their fallback) and on legacy-migrated sessions.
   */
  origin?: LocalSessionOrigin;
  sessionDataVersion?: number;
  sessionOrigin?: LocalSessionDataOrigin;
  createdAtMs: number;
  updatedAtMs: number;
}

export type LocalSessionOrigin = 'user' | 'root-repair';

export interface LocalSessionListOptions {
  /** Read-only owner family filter. When present it supersedes `agentName`. */
  agentNames?: readonly string[];
  agentName?: string;
  archived?: boolean;
  includeHidden?: boolean;
  excludePurposePrefix?: string;
  includePurposePrefix?: string;
  sessionType?: LocalSessionType;
  search?: string;
  cursor?: string;
  offset?: number;
  limit?: number;
  /** Storage scan cap before filtering; distinct from page `limit`. */
  scanLimit?: number;
}

export interface LocalSessionStore {
  get(sessionId: string): Promise<LocalSessionRecord | undefined>;
  upsert(record: LocalSessionRecord): Promise<void>;
  delete(sessionId: string): Promise<void>;
  list(options?: LocalSessionListOptions): Promise<LocalSessionRecord[]>;
}

export class InMemoryLocalSessionStore implements LocalSessionStore {
  private readonly records = new Map<string, LocalSessionRecord>();

  async get(sessionId: string): Promise<LocalSessionRecord | undefined> {
    return this.records.get(sessionId);
  }

  async upsert(record: LocalSessionRecord): Promise<void> {
    this.records.set(record.sessionId, { ...record });
  }

  async delete(sessionId: string): Promise<void> {
    this.records.delete(sessionId);
  }

  async list(options?: LocalSessionListOptions): Promise<LocalSessionRecord[]> {
    return applyLocalSessionListOptions(
      [...this.records.values()].map((record) => ({ ...record })),
      options,
    );
  }
}

export class LocalSessionResumeError extends Error {
  constructor(sessionId: string) {
    super(`Local session ${sessionId} cannot resume into a new turn.`);
    this.name = 'LocalSessionResumeError';
  }
}

export interface LocalSessionControllerOptions {
  store?: LocalSessionStore;
  runtimeHost?: LocalRuntimeHost;
  router?: LocalSessionRouter;
  legacyOpencodeEnabled?: () => boolean;
  telemetry?: LocalRuntimeTelemetrySink;
  nowMs?: () => number;
  /** Optional deterministic registry seam for lifecycle/integration tests. */
  turnTimings?: LocalActiveTurnTimingRegistry;
  /**
   * Live login auth context, threaded into the default `LocalRuntimeHost` so
   * the output-safety call authenticates with the current access token. Ignored
   * when an explicit `runtimeHost` is supplied (that instance owns its own auth).
   */
  authContextGetter?: () => LocalRuntimeAuthContext | undefined;
  routingContextGetter?: () => LocalRuntimeRoutingContext | undefined;
  /**
   * Host-level MetricsClient, threaded into the default `LocalRuntimeHost`
   * so its `PiTurnRunner` can emit turn metrics. Ignored when an explicit
   * `runtimeHost` is supplied (that instance owns its own wiring).
   */
  metricsClient?: MetricsClient;
  /**
   * Custom fetch implementation for outbound safety-review HTTP calls. In
   * Electron, pass `net.fetch` (Chromium network stack) so VPN proxy and
   * enterprise certificate trust work correctly. Ignored when an explicit
   * `runtimeHost` is supplied. Falls back to `globalThis.fetch`.
   */
  fetchImpl?: typeof fetch;
  /** Host-owned observer for each physical LLM request lifecycle. */
  observeLLMRequest?: PiLLMRequestObserver;
  /** Production v2 composition uses this to fail closed before legacy Turn writes. */
  assertTurnStartAllowed?: () => void;
  /** Production v2 composition uses this to fail closed before legacy Session writes. */
  assertSessionMutationAllowed?: (operation: 'create' | 'update' | 'delete') => void;
}

export type LocalSessionTurnInput<TCtx extends LocalToolContext = LocalToolContext> = Omit<
  LocalRuntimeTurnInput<TCtx>,
  'sessionId' | 'agentName' | 'workspaceDir'
> & {
  sessionId: string;
};

export class LocalSessionController {
  private readonly store: LocalSessionStore;
  private readonly router: LocalSessionRouter;
  private readonly nowMs: () => number;
  private readonly turnTimings: LocalActiveTurnTimingRegistry;
  private readonly assertTurnStartAllowed: () => void;
  private readonly assertSessionMutationAllowed: (
    operation: 'create' | 'update' | 'delete',
  ) => void;

  constructor(options: LocalSessionControllerOptions = {}) {
    this.nowMs = options.nowMs ?? (() => Date.now());
    this.turnTimings = options.turnTimings ?? new LocalActiveTurnTimingRegistry(this.nowMs);
    this.assertTurnStartAllowed = options.assertTurnStartAllowed ?? (() => undefined);
    this.assertSessionMutationAllowed = options.assertSessionMutationAllowed ?? (() => undefined);
    this.store = options.store ?? new InMemoryLocalSessionStore();
    this.router =
      options.router ??
      new LocalSessionRouter({
        runtimeHost:
          options.runtimeHost ??
          new LocalRuntimeHost({
            authContextGetter: options.authContextGetter,
            routingContextGetter: options.routingContextGetter,
            ...(options.metricsClient ? { metricsClient: options.metricsClient } : {}),
            fetchImpl: options.fetchImpl,
            ...(options.observeLLMRequest ? { observeLLMRequest: options.observeLLMRequest } : {}),
          }),
        legacyOpencodeEnabled: options.legacyOpencodeEnabled,
        telemetry: options.telemetry,
      });
  }

  getCachedContextUsageToolCalibration(input: {
    context: Context;
    model: Model<Api>;
  }): ContextUsageToolCalibration | undefined {
    return this.router.getCachedContextUsageToolCalibration(input);
  }

  async createPiSession(input: {
    sessionId: string;
    agentName: string;
    workspaceDir: string;
    isDefaultWorkspace?: boolean;
    sessionType?: LocalSessionType;
    title?: string | null;
    parentSessionId?: string | null;
    visibility?: 'visible' | 'hidden';
    purpose?: string;
    runLocation?: ResolvedLocalRunLocation;
    appMode?: LocalAppMode;
    effectiveModel?: string | null;
    effectiveModelVariant?: string | null;
    effectiveModelThinking?: LocalModelThinkingSelection | null;
    archived?: boolean;
    status?: LocalSessionStatus;
    origin?: LocalSessionOrigin;
    sessionOrigin?: LocalSessionDataOrigin;
    createdAtMs?: number;
    updatedAtMs?: number;
  }): Promise<LocalSessionRecord> {
    this.assertSessionMutationAllowed('create');
    const now = this.nowMs();
    const createdAtMs = input.createdAtMs ?? now;
    const updatedAtMs = input.updatedAtMs ?? createdAtMs;
    const sessionType = input.sessionType ?? 'branch';
    const record: LocalSessionRecord = {
      sessionId: input.sessionId,
      agentName: input.agentName,
      workspaceDir: input.workspaceDir,
      ...(input.isDefaultWorkspace !== undefined
        ? { isDefaultWorkspace: input.isDefaultWorkspace }
        : {}),
      runtime: 'pi-agent',
      sessionType,
      archived: input.archived ?? false,
      ...(input.title !== undefined ? { title: input.title } : {}),
      ...(input.parentSessionId !== undefined ? { parentSessionId: input.parentSessionId } : {}),
      ...(input.visibility !== undefined ? { visibility: input.visibility } : {}),
      ...(input.purpose !== undefined ? { purpose: input.purpose } : {}),
      ...(input.runLocation !== undefined ? { runLocation: input.runLocation } : {}),
      ...(sessionType === 'branch' ? { appMode: resolveLocalAppMode(input.appMode) } : {}),
      ...(input.effectiveModel !== undefined ? { effectiveModel: input.effectiveModel } : {}),
      ...(input.effectiveModelVariant !== undefined
        ? { effectiveModelVariant: input.effectiveModelVariant }
        : {}),
      ...(input.effectiveModelThinking !== undefined
        ? { effectiveModelThinking: input.effectiveModelThinking }
        : {}),
      ...(input.origin !== undefined ? { origin: input.origin } : {}),
      status: input.status ?? 'idle',
      sessionDataVersion: CURRENT_SESSION_DATA_VERSION,
      sessionOrigin: input.sessionOrigin ?? 'local-runtime',
      createdAtMs,
      updatedAtMs,
    };
    await this.store.upsert(record);
    return record;
  }

  async registerLegacyOpencodeSession(input: {
    sessionId: string;
    agentName: string;
    workspaceDir: string;
    isDefaultWorkspace?: boolean;
    archived?: boolean;
    title?: string | null;
    sessionType?: LocalSessionType;
    parentSessionId?: string | null;
    status?: LocalSessionStatus;
    createdAtMs?: number;
    updatedAtMs?: number;
  }): Promise<LocalSessionRecord> {
    this.assertSessionMutationAllowed('create');
    const now = this.nowMs();
    const sessionType = input.sessionType ?? 'branch';
    const record: LocalSessionRecord = {
      sessionId: input.sessionId,
      agentName: input.agentName,
      workspaceDir: input.workspaceDir,
      ...(input.isDefaultWorkspace !== undefined
        ? { isDefaultWorkspace: input.isDefaultWorkspace }
        : {}),
      runtime: 'opencode',
      sessionType,
      archived: input.archived ?? false,
      ...(input.title !== undefined ? { title: input.title } : {}),
      ...(input.parentSessionId !== undefined ? { parentSessionId: input.parentSessionId } : {}),
      status: input.status ?? 'finished',
      ...(sessionType === 'branch' ? { appMode: DEFAULT_LOCAL_APP_MODE } : {}),
      sessionDataVersion: CURRENT_SESSION_DATA_VERSION,
      sessionOrigin: 'legacy-opencode',
      createdAtMs: input.createdAtMs ?? now,
      updatedAtMs: input.updatedAtMs ?? now,
    };
    await this.store.upsert(record);
    return record;
  }

  async getSession(sessionId: string): Promise<LocalSessionRecord | undefined> {
    return this.store.get(sessionId);
  }

  async listSessions(options?: LocalSessionListOptions): Promise<LocalSessionRecord[]> {
    return this.store.list(options);
  }

  async updateSession(
    sessionId: string,
    fields: Partial<
      Pick<
        LocalSessionRecord,
        | 'title'
        | 'sessionType'
        | 'parentSessionId'
        | 'archived'
        | 'status'
        | 'errorMessage'
        | 'errorCode'
        | 'errorSource'
        | 'errorDetail'
        | 'errorProviderId'
        | 'canRetry'
        | 'effectiveModel'
        | 'effectiveModelVariant'
        | 'effectiveModelThinking'
        | 'updatedAtMs'
      >
    >,
  ): Promise<LocalSessionRecord | undefined> {
    this.assertSessionMutationAllowed('update');
    const session = await this.store.get(sessionId);
    if (!session) return undefined;
    const clearsStaleError = fields.status !== undefined && fields.status !== 'error';
    const updated: LocalSessionRecord = {
      ...session,
      ...fields,
      ...(clearsStaleError && !Object.hasOwn(fields, 'errorMessage')
        ? { errorMessage: undefined }
        : {}),
      ...(clearsStaleError && !Object.hasOwn(fields, 'errorCode') ? { errorCode: undefined } : {}),
      ...(clearsStaleError && !Object.hasOwn(fields, 'canRetry') ? { canRetry: undefined } : {}),
      updatedAtMs: fields.updatedAtMs ?? this.nowMs(),
    };
    await this.store.upsert(updated);
    return updated;
  }

  async deleteSession(sessionId: string): Promise<void> {
    this.assertSessionMutationAllowed('delete');
    await this.store.delete(sessionId);
  }

  get activeTurnTimingReader(): LocalActiveTurnTimingReader {
    return this.turnTimings;
  }

  getActiveTurnTiming(sessionId: string): LocalActiveTurnTiming | undefined {
    return this.turnTimings.getBySession(sessionId);
  }

  getTurnTiming(sessionId: string, turnId: string): LocalActiveTurnTiming | undefined {
    return this.turnTimings.getByTurn(sessionId, turnId);
  }

  elapsedTurnSeconds(timing: LocalActiveTurnTiming): number {
    return this.turnTimings.elapsedSeconds(timing);
  }

  beginTurnTiming(sessionId: string, turnId: string, source?: string): void {
    this.turnTimings.begin(sessionId, turnId, source);
  }

  markTurnTimingSettling(sessionId: string, turnId: string): void {
    this.turnTimings.markSettling(sessionId, turnId);
  }

  finishTurnTiming(sessionId: string, turnId: string): void {
    this.turnTimings.finish(sessionId, turnId);
  }

  async startTurn<TCtx extends LocalToolContext = LocalToolContext>(
    input: LocalSessionTurnInput<TCtx>,
  ): Promise<LocalRuntimeTurnOutput> {
    this.assertTurnStartAllowed();
    const session = await this.store.get(input.sessionId);
    if (!session) {
      throw new Error(`Local session ${input.sessionId} not found.`);
    }
    if (session.archived) {
      throw new LocalSessionResumeError(input.sessionId);
    }

    this.turnTimings.begin(input.sessionId, input.turnId);
    let output: LocalRuntimeTurnOutput;
    try {
      output = await this.router.startTurn<TCtx>(session, input);
    } finally {
      // Freeze immediately when the agent loop settles. Session projection and
      // outer Goal accounting may still perform async work after this point.
      this.turnTimings.markSettling(input.sessionId, input.turnId);
    }
    const latest = await this.store.get(input.sessionId);
    if (latest) {
      await this.store.upsert({
        ...latest,
        updatedAtMs: this.nowMs(),
      });
    }
    return output;
  }
}
