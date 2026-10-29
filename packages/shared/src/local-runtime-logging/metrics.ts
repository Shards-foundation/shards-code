import {
  MetricsClient,
  type MetricLabels,
  type MetricsBatchReporter,
} from '../metrics-proxy.js';

/**
 * local-runtime metrics facade.
 *
 * Per `.harness/docs/local-runtime-observability.md` — local-runtime business
 * code MUST obtain a `MetricsClient` from this module (typically via host
 * injection) and never construct `MetricsClient` / `MetricsReporter`
 * directly. Metric names are emitted BARE (e.g. `started_total`): the
 * metrics server prepends `<service>_` on ingest and the service is
 * `local_runtime`, so a stored series reads `local_runtime_started_total`.
 * Hardcoding the prefix in code would double it up
 * (`local_runtime_local_runtime_*`). Labels must stay low-cardinality (no
 * sessionId / turnId / traceId / file path / error message as label values —
 * those belong in logger fields).
 *
 * Allowed APIs on the returned client: `counter`, `gauge`, `histogram`.
 */

export type LocalMetricLabels = MetricLabels;

const SERVICE_NAME = 'local_runtime';
const SERVER_APPLIED_PREFIX = 'local_runtime_';

export interface LocalRuntimeMetricsClientOptions {
  /**
   * Runtime owner classification — typically `'electron'` / `'cli'`. Becomes
   * a default label on every emitted metric so the same time-series carries
   * the runtime origin without callers repeating it.
   */
  runtimeOwnerKind: string;
  /**
   * Optional runtime mode — `'clean'`, `'compatibility'`, etc. Added as a
   * default label when present.
   */
  runtimeMode?: string;
  /**
   * Product/app version stamped as the `appVersion` default label. Comes
   * from `app.getVersion()` (Electron) or the CLI build define; defaults to
   * `'unknown'` when absent or unrecognized. Only release versions and the
   * preview/inside/test/staging channels are retained; build suffixes are
   * omitted from this metric label only.
   */
  appVersion?: string;
  /**
   * Per-metric histogram bucket overrides, keyed by BARE metric name. Used
   * for long-tail latency series (turn duration, LLM first token, …) whose
   * distributions exceed the shared default buckets.
   */
  histogramBucketsByName?: Record<string, number[]>;
  /**
   * Optional explicitly injected reporter. The default reporter is a local no-op.
   */
  reporter?: MetricsBatchReporter;
  onError?: (error: unknown) => void;
  /** Override clock for deterministic testing. */
  now?: () => number;
}

class NoopMetricsReporter implements MetricsBatchReporter {
  async reportBatch(): Promise<{ accepted: number }> {
    return { accepted: 0 };
  }
}

/**
 * Build a `MetricsClient` for the `local_runtime` service with the
 * conventional default labels. Host code wires the resulting client into
 * modules that need to emit counters / histograms; business code never
 * instantiates one.
 */
export function createLocalRuntimeMetricsClient(
  options: LocalRuntimeMetricsClientOptions,
): MetricsClient {
  const appVersion = options.appVersion ?? 'unknown';
  const metricAppVersion = /^\d+\.\d+\.\d+$/u.test(appVersion)
    ? appVersion
    : (appVersion.match(/^(\d+\.\d+\.\d+-(?:preview|inside|test|staging))(?:[.+-].*)?$/u)?.[1] ??
      'unknown');
  const defaultLabels: MetricLabels = {
    runtimeOwnerKind: options.runtimeOwnerKind,
    appVersion: metricAppVersion,
    ...(options.runtimeMode ? { runtimeMode: options.runtimeMode } : {}),
  };

  return new MetricsClient({
    serviceName: SERVICE_NAME,
    reporter: options.reporter ?? new NoopMetricsReporter(),
    defaultLabels,
    ...(options.histogramBucketsByName
      ? { histogramBucketsByName: options.histogramBucketsByName }
      : {}),
    ...(options.onError ? { onError: options.onError } : {}),
    ...(options.now ? { now: options.now } : {}),
  });
}

/**
 * Runtime-time guard so accidental `metrics.counter('local_runtime_x', …)`
 * misuse fails fast in tests instead of storing double-prefixed prod
 * time-series: the metrics server already prepends the service name
 * (`local_runtime_`), so client-side names must be BARE. Production code
 * paths can call `assertLocalMetricName` inside their own helpers when they
 * want belt-and-suspenders coverage.
 */
export function assertLocalMetricName(name: string): void {
  if (name.startsWith(SERVER_APPLIED_PREFIX)) {
    throw new Error(
      `local-runtime metric '${name}' must NOT start with '${SERVER_APPLIED_PREFIX}' — ` +
        `the metrics server prepends the service name ('${SERVICE_NAME}') to every metric.`,
    );
  }
}

/**
 * Shared port shape used by every local-runtime module wiring layer
 * (`hooks/api.ts`, `cron/api.ts`, etc.) when it forwards an injected
 * `MetricsReporter` to the underlying `@mavis/cron` / hooks engine
 * `host-utils.ts`. Keeping the shape here means new wiring sites can
 * import a single canonical type from the facade instead of redeclaring
 * an identical interface beside every consumer.
 *
 * NOTE: `packages/agent-modules/cron/src/host-utils.ts` and
 * `packages/agent-modules/team/src/host-utils.ts` still declare their own
 * structurally-identical `MetricsReporter` interface — those are
 * agent-modules-internal ports and intentionally do not import from
 * local-runtime. Structural typing makes this `ModuleMetricsReporter`
 * assignable to them; the duplication stays inside agent-modules.
 */
export interface ModuleMetricsReporter {
  incr(name: string, tags?: Record<string, string>): void;
  gauge(name: string, value: number, tags?: Record<string, string>): void;
  latency(name: string, durationMs: number, tags?: Record<string, string>): void;
}

/**
 * Time an async block and emit `<name>{status=ok|error}` latency through the
 * optional reporter. Errors are rethrown untouched; without a reporter the
 * wrapper is behaviorally a plain passthrough.
 */
export async function timeRouteDuration<T>(
  metrics: ModuleMetricsReporter | undefined,
  name: string,
  run: () => Promise<T>,
): Promise<T> {
  const startMs = Date.now();
  try {
    const result = await run();
    metrics?.latency(name, Date.now() - startMs, { status: 'ok' });
    return result;
  } catch (err) {
    metrics?.latency(name, Date.now() - startMs, { status: 'error' });
    throw err;
  }
}

export type { MetricsClient, MetricLabels, MetricsBatchReporter };
