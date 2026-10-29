export type MetricType = 'counter' | 'gauge' | 'histogram';

export type MetricLabels = Record<string, string>;

export type MetricPoint =
  | {
      type: 'counter';
      name: string;
      labels?: MetricLabels;
      value: number;
      updatedAt?: number;
    }
  | {
      type: 'gauge';
      name: string;
      labels?: MetricLabels;
      value: number;
      updatedAt?: number;
    }
  | {
      type: 'histogram';
      name: string;
      labels?: MetricLabels;
      count: number;
      sum: number;
      buckets: Record<string, number>;
      updatedAt?: number;
    };

export interface ReportMetricsBatchRequest {
  service: string;
  timestamp?: number;
  metrics: MetricPoint[];
}

export interface ReportMetricsBatchResponse {
  accepted?: number;
}

export interface MetricsBatchReporter {
  reportBatch(req: ReportMetricsBatchRequest): Promise<ReportMetricsBatchResponse>;
}

export interface MetricsReporterOptions {
  endpoint?: string;
  batchPath?: string;
  headers?: Record<string, string>;
  requestTimeoutMs?: number;
  fetch?: typeof fetch;
  reportMetric?: (
    metric: MetricPoint,
    context: { service: string; timestamp?: number },
  ) => Promise<void> | void;
}

export interface MetricsClientRetryOptions {
  maxAttempts?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  maxRetryBatches?: number;
  maxRetryMetrics?: number;
}

export interface MetricsClientOptions {
  reporter: MetricsBatchReporter;
  serviceName: string;
  flushIntervalMs?: number;
  maxBatchSize?: number;
  maxSeries?: number;
  maxLabelKeys?: number;
  maxLabelValueLength?: number;
  defaultLabels?: MetricLabels;
  histogramBuckets?: number[];
  histogramBucketsByName?: Record<string, number[]>;
  stickyGauge?: boolean;
  retry?: MetricsClientRetryOptions;
  onError?: (error: unknown) => void;
  now?: () => number;
  setTimer?: typeof setTimeout;
  clearTimer?: typeof clearTimeout;
}

export interface CreateMetricsClientOptions
  extends Omit<MetricsClientOptions, 'reporter' | 'serviceName'>, MetricsReporterOptions {
  serviceName: string;
}

interface MetricStorePoint {
  name: string;
  labels: MetricLabels;
  updatedAt: number;
}

interface CounterStorePoint extends MetricStorePoint {
  value: number;
}

interface GaugeStorePoint extends MetricStorePoint {
  value: number;
}

interface HistogramStorePoint extends MetricStorePoint {
  buckets: number[];
  bucketCounts: number[];
  count: number;
  sum: number;
}

interface RetryBatch {
  request: ReportMetricsBatchRequest;
  attempts: number;
}

const DEFAULT_FLUSH_INTERVAL_MS = 5_000;
const DEFAULT_MAX_BATCH_SIZE = 1_000;
const DEFAULT_MAX_SERIES = 50_000;
const DEFAULT_MAX_LABEL_KEYS = 20;
const DEFAULT_MAX_LABEL_VALUE_LENGTH = 512;
const DEFAULT_HISTOGRAM_BUCKETS = [1, 5, 10, 25, 50, 100, 250, 500, 1_000, 2_500, 5_000, 10_000];
const DEFAULT_RETRY = {
  maxAttempts: 3,
  baseDelayMs: 250,
  maxDelayMs: 5_000,
  maxRetryBatches: 100,
  maxRetryMetrics: 100_000,
};

const METRIC_NAME_RE = /^[a-zA-Z_:][a-zA-Z0-9_:]*$/;

export class MetricsReportError extends Error {
  readonly status?: number;
  readonly retryable: boolean;

  constructor(message: string, options: { status?: number; retryable: boolean }) {
    super(message);
    this.name = 'MetricsReportError';
    this.status = options.status;
    this.retryable = options.retryable;
  }
}

export class MetricsReporter implements MetricsBatchReporter {
  private readonly options: MetricsReporterOptions;

  constructor(options: MetricsReporterOptions) {
    this.options = {
      ...options,
      ...(options.endpoint
        ? {
            endpoint: options.endpoint.replace(/\/+$/, ''),
            batchPath: normalizeBatchPath(options.batchPath ?? ''),
          }
        : {}),
    };
  }

  async reportBatch(req: ReportMetricsBatchRequest): Promise<ReportMetricsBatchResponse> {
    if (!this.options.endpoint) {
      if (!this.options.reportMetric) {
        throw new MetricsReportError('Metrics reporter requires either endpoint or reportMetric', {
          retryable: false,
        });
      }

      for (const metric of req.metrics) {
        await this.options.reportMetric(metric, {
          service: req.service,
          timestamp: req.timestamp,
        });
      }

      return { accepted: req.metrics.length };
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.options.requestTimeoutMs ?? 3_000);

    try {
      const response = await (this.options.fetch ?? fetch)(
        `${this.options.endpoint}${this.options.batchPath}`,
        {
          method: 'POST',
          headers: {
            ...(this.options.headers ?? {}),
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(toReportBody(req)),
          signal: controller.signal,
        },
      );

      if (!response.ok) {
        throw new MetricsReportError(`Metrics report failed with HTTP ${response.status}`, {
          status: response.status,
          retryable: response.status === 429 || response.status >= 500,
        });
      }

      return (await response.json().catch(() => ({}))) as ReportMetricsBatchResponse;
    } catch (error) {
      if (error instanceof MetricsReportError) {
        throw error;
      }

      throw new MetricsReportError('Metrics report failed before a response was received', {
        retryable: true,
      });
    } finally {
      clearTimeout(timeout);
    }
  }
}

export class MetricsClient {
  private readonly reporter: MetricsBatchReporter;
  private readonly serviceName: string;
  private readonly flushIntervalMs: number;
  private readonly maxBatchSize: number;
  private readonly maxSeries: number;
  private readonly maxLabelKeys: number;
  private readonly maxLabelValueLength: number;
  private readonly defaultLabels: MetricLabels;
  private readonly histogramBuckets: number[];
  private readonly histogramBucketsByName: Record<string, number[]>;
  private readonly stickyGauge: boolean;
  private readonly retry: Required<MetricsClientRetryOptions>;
  private readonly onError?: (error: unknown) => void;
  private readonly now: () => number;
  private readonly setTimer: typeof setTimeout;
  private readonly clearTimer: typeof clearTimeout;
  private readonly counters = new Map<string, CounterStorePoint>();
  private readonly gauges = new Map<string, GaugeStorePoint>();
  private readonly histograms = new Map<string, HistogramStorePoint>();
  private readonly metricNameSeriesCounts = new Map<string, Set<string>>();
  private readonly retryBuffer: RetryBatch[] = [];
  private flushTimer: ReturnType<typeof setTimeout> | undefined;
  private flushInFlight: Promise<void> | undefined;
  private closed = false;

  constructor(options: MetricsClientOptions) {
    this.reporter = options.reporter;
    this.serviceName = options.serviceName;
    this.flushIntervalMs = options.flushIntervalMs ?? DEFAULT_FLUSH_INTERVAL_MS;
    this.maxBatchSize = options.maxBatchSize ?? DEFAULT_MAX_BATCH_SIZE;
    this.maxSeries = options.maxSeries ?? DEFAULT_MAX_SERIES;
    this.maxLabelKeys = options.maxLabelKeys ?? DEFAULT_MAX_LABEL_KEYS;
    this.maxLabelValueLength = options.maxLabelValueLength ?? DEFAULT_MAX_LABEL_VALUE_LENGTH;
    this.defaultLabels = normalizeLabels(options.defaultLabels ?? {});
    this.histogramBuckets = normalizeBuckets(options.histogramBuckets ?? DEFAULT_HISTOGRAM_BUCKETS);
    this.histogramBucketsByName = Object.fromEntries(
      Object.entries(options.histogramBucketsByName ?? {}).map(([name, buckets]) => [
        name,
        normalizeBuckets(buckets),
      ]),
    );
    this.stickyGauge = options.stickyGauge ?? false;
    this.retry = { ...DEFAULT_RETRY, ...(options.retry ?? {}) };
    this.onError = options.onError;
    this.now = options.now ?? Date.now;
    this.setTimer = options.setTimer ?? setTimeout;
    this.clearTimer = options.clearTimer ?? clearTimeout;

    if (this.flushIntervalMs > 0) {
      this.scheduleFlush();
    }
  }

  counter(name: string, delta = 1, labels: MetricLabels = {}): void {
    if (this.closed || !Number.isFinite(delta) || delta <= 0) return;
    const mergedLabels = this.validateAndMergeLabels('counter', name, labels);
    if (!mergedLabels) return;

    const key = buildMetricKey('counter', name, mergedLabels);
    const existing = this.counters.get(key);
    const updatedAt = this.now();
    if (existing) {
      existing.value += delta;
      existing.updatedAt = updatedAt;
    } else {
      this.counters.set(key, { name, labels: mergedLabels, value: delta, updatedAt });
    }
    this.flushWhenFull();
  }

  gauge(name: string, value: number, labels: MetricLabels = {}): void {
    if (this.closed || !Number.isFinite(value)) return;
    const mergedLabels = this.validateAndMergeLabels('gauge', name, labels);
    if (!mergedLabels) return;

    this.gauges.set(buildMetricKey('gauge', name, mergedLabels), {
      name,
      labels: mergedLabels,
      value,
      updatedAt: this.now(),
    });
    this.flushWhenFull();
  }

  histogram(name: string, value: number, labels: MetricLabels = {}): void {
    if (this.closed || !Number.isFinite(value)) return;
    const mergedLabels = this.validateAndMergeLabels('histogram', name, labels);
    if (!mergedLabels) return;

    const key = buildMetricKey('histogram', name, mergedLabels);
    const buckets = this.histogramBucketsByName[name] ?? this.histogramBuckets;
    let point = this.histograms.get(key);
    if (!point) {
      point = {
        name,
        labels: mergedLabels,
        buckets,
        bucketCounts: buckets.map(() => 0),
        count: 0,
        sum: 0,
        updatedAt: this.now(),
      };
      this.histograms.set(key, point);
    }

    point.count += 1;
    point.sum += value;
    point.updatedAt = this.now();
    for (let index = 0; index < point.buckets.length; index += 1) {
      const bucket = point.buckets[index];
      if (bucket !== undefined && value <= bucket) {
        point.bucketCounts[index] = (point.bucketCounts[index] ?? 0) + 1;
      }
    }
    this.flushWhenFull();
  }

  async flush(): Promise<void> {
    if (this.flushInFlight) {
      await this.flushInFlight;
    }

    this.flushInFlight = this.flushOnce().finally(() => {
      this.flushInFlight = undefined;
    });
    await this.flushInFlight;
  }

  async close(): Promise<void> {
    this.closed = true;
    if (this.flushTimer) {
      this.clearTimer(this.flushTimer);
      this.flushTimer = undefined;
    }
    await this.flush();
  }

  private async flushOnce(): Promise<void> {
    const snapshot = this.takeSnapshot();
    if (snapshot.length === 0 && this.retryBuffer.length === 0) return;

    await this.drainRetryBuffer();

    for (const metrics of chunk(snapshot, this.maxBatchSize)) {
      await this.sendOrBuffer({
        service: this.serviceName,
        timestamp: this.now(),
        metrics,
      });
    }
  }

  private async drainRetryBuffer(): Promise<void> {
    const pending = this.retryBuffer.splice(0, this.retryBuffer.length);
    for (const batch of pending) {
      await this.sendOrBuffer(batch.request, batch.attempts);
    }
  }

  private async sendOrBuffer(request: ReportMetricsBatchRequest, attempts = 0): Promise<void> {
    if (request.metrics.length === 0) return;

    try {
      await this.reporter.reportBatch(request);
    } catch (error) {
      if (isRetryableError(error) && attempts + 1 < this.retry.maxAttempts) {
        this.pushRetryBatch({ request, attempts: attempts + 1 });
      } else {
        this.onError?.(error);
      }
    }
  }

  private pushRetryBatch(batch: RetryBatch): void {
    this.retryBuffer.push(batch);

    while (
      this.retryBuffer.length > this.retry.maxRetryBatches ||
      this.retryBuffer.reduce((total, item) => total + item.request.metrics.length, 0) >
        this.retry.maxRetryMetrics
    ) {
      const dropped = this.retryBuffer.shift();
      if (!dropped) break;
      this.onError?.(
        new MetricsReportError('Metrics retry buffer exceeded its limit; dropped oldest batch', {
          retryable: false,
        }),
      );
    }
  }

  private takeSnapshot(): MetricPoint[] {
    const points: MetricPoint[] = [];

    for (const point of this.counters.values()) {
      points.push({
        type: 'counter',
        name: point.name,
        labels: point.labels,
        value: point.value,
        updatedAt: point.updatedAt,
      });
    }
    this.counters.clear();

    for (const point of this.gauges.values()) {
      points.push({
        type: 'gauge',
        name: point.name,
        labels: point.labels,
        value: point.value,
        updatedAt: point.updatedAt,
      });
    }
    if (!this.stickyGauge) {
      this.gauges.clear();
    }

    for (const point of this.histograms.values()) {
      points.push({
        type: 'histogram',
        name: point.name,
        labels: point.labels,
        count: point.count,
        sum: point.sum,
        buckets: Object.fromEntries(
          point.buckets.map((bucket, index) => [String(bucket), point.bucketCounts[index] ?? 0]),
        ),
        updatedAt: point.updatedAt,
      });
    }
    this.histograms.clear();

    return points;
  }

  private validateAndMergeLabels(
    type: MetricType,
    name: string,
    labels: MetricLabels,
  ): MetricLabels | null {
    if (!METRIC_NAME_RE.test(name)) {
      this.onError?.(new Error(`Invalid metric name: ${name}`));
      return null;
    }

    const merged = normalizeLabels({ ...this.defaultLabels, ...labels });
    const labelEntries = Object.entries(merged);
    if (labelEntries.length > this.maxLabelKeys) {
      this.onError?.(new Error(`Metric ${name} has too many label keys`));
      return null;
    }

    if (labelEntries.some(([, value]) => value.length > this.maxLabelValueLength)) {
      this.onError?.(new Error(`Metric ${name} has a label value exceeding max length`));
      return null;
    }

    const key = buildMetricKey(type, name, merged);
    if (!this.canAcceptSeries(name, key)) {
      this.onError?.(new Error(`Metric series limit exceeded for ${name}`));
      return null;
    }

    return merged;
  }

  private canAcceptSeries(name: string, key: string): boolean {
    if (this.counters.has(key) || this.gauges.has(key) || this.histograms.has(key)) {
      return true;
    }

    const currentSeries = this.counters.size + this.gauges.size + this.histograms.size;
    if (currentSeries >= this.maxSeries) {
      return false;
    }

    let nameSeries = this.metricNameSeriesCounts.get(name);
    if (!nameSeries) {
      nameSeries = new Set<string>();
      this.metricNameSeriesCounts.set(name, nameSeries);
    }
    nameSeries.add(key);
    return true;
  }

  private flushWhenFull(): void {
    const series = this.counters.size + this.gauges.size + this.histograms.size;
    if (series >= this.maxBatchSize) {
      void this.flush().catch((error) => this.onError?.(error));
    }
  }

  private scheduleFlush(): void {
    this.flushTimer = this.setTimer(() => {
      void this.flush()
        .catch((error) => this.onError?.(error))
        .finally(() => {
          if (!this.closed) {
            this.scheduleFlush();
          }
        });
    }, this.flushIntervalMs);
    this.flushTimer.unref?.();
  }
}

export function createMetricsClient(options: CreateMetricsClientOptions): MetricsClient {
  const reporter = new MetricsReporter(options);

  return new MetricsClient({
    ...options,
    reporter,
    serviceName: options.serviceName,
  });
}

export function buildMetricKey(type: MetricType, name: string, labels: MetricLabels = {}): string {
  const labelText = Object.keys(labels)
    .sort()
    .map((key) => `${key}=${labels[key]}`)
    .join(',');

  return `${type}:${name}{${labelText}}`;
}

function normalizeLabels(labels: MetricLabels): MetricLabels {
  return Object.fromEntries(
    Object.entries(labels)
      .filter(([key, value]) => key.length > 0 && value !== undefined)
      .sort(([left], [right]) => left.localeCompare(right)),
  );
}

function normalizeBuckets(buckets: number[]): number[] {
  return [...new Set(buckets.filter((bucket) => Number.isFinite(bucket)))].sort((a, b) => a - b);
}

function normalizeBatchPath(path: string): string {
  const trimmed = path.trim();
  if (!trimmed) return '';
  return trimmed.startsWith('/') ? trimmed : `/${trimmed}`;
}

function isRetryableError(error: unknown): boolean {
  return error instanceof MetricsReportError ? error.retryable : true;
}

function chunk<T>(items: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    chunks.push(items.slice(index, index + size));
  }
  return chunks;
}

function toReportBody(req: ReportMetricsBatchRequest): unknown {
  return {
    service: req.service,
    timestamp: req.timestamp,
    metrics: req.metrics.map((metric) => {
      if (metric.type === 'histogram') {
        return {
          metrics_type: metric.type,
          name: metric.name,
          labels: metric.labels,
          count: metric.count,
          sum: metric.sum,
          buckets: metric.buckets,
          updated_at: metric.updatedAt,
        };
      }

      return {
        metrics_type: metric.type,
        name: metric.name,
        labels: metric.labels,
        value: metric.value,
        updated_at: metric.updatedAt,
      };
    }),
  };
}
