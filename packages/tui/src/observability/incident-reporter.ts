import { createHash, randomUUID } from 'node:crypto';
import {
  chmodSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { arch, platform } from 'node:os';
import { basename, join } from 'node:path';

export type TuiIncidentPhase = 'startup' | 'runtime' | 'shutdown';
export type TuiIncidentSeverity = 'fatal' | 'error' | 'warning';
export type TuiIncidentImpact = 'exit' | 'screen_unavailable' | 'action_failed' | 'degraded';
export type TuiIncidentEventType =
  | 'cli_process_error'
  | 'cli_startup_error'
  | 'cli_render_error'
  | 'cli_interaction_error'
  | 'cli_runtime_bridge_error'
  | 'cli_terminal_error'
  | 'cli_persistence_error'
  | 'cli_shutdown_error'
  | 'cli_unclean_exit';

type TuiIncidentPrimitive = string | number | boolean | null;

export interface TuiIncidentCapture {
  readonly eventType: TuiIncidentEventType;
  readonly error: unknown;
  readonly component: string;
  readonly operation: string;
  readonly codeLocation: string;
  readonly severity?: TuiIncidentSeverity;
  readonly impact?: TuiIncidentImpact;
  readonly handled?: boolean;
  readonly phase?: TuiIncidentPhase;
  readonly context?: Readonly<Record<string, TuiIncidentPrimitive | undefined>>;
}

export interface TuiIncidentSink {
  capture(input: TuiIncidentCapture): string | undefined;
  breadcrumb(
    name: string,
    details?: Readonly<Record<string, TuiIncidentPrimitive | undefined>>,
  ): void;
}

export interface TuiIncidentReporter extends TuiIncidentSink {
  readonly runId: string;
  readonly hasFatalIncident: boolean;
  setPhase(phase: TuiIncidentPhase): void;
  drain(): Promise<void>;
  flush(timeoutMs?: number): Promise<void>;
  completeRun(): void;
}

export interface CreateTuiIncidentReporterOptions {
  readonly dataDir: string;
  readonly appVersion: string;
  readonly nowMs?: () => number;
  readonly pid?: number;
  readonly isProcessAlive?: (pid: number) => boolean;
  readonly platform?: NodeJS.Platform;
  readonly architecture?: string;
  readonly nodeVersion?: string;
  readonly osVersion?: string;
  readonly terminal?: string;
  readonly tuiMode?: string;
}

interface TuiIncidentBreadcrumb {
  readonly occurredAtMs: number;
  readonly name: string;
  readonly details?: Readonly<Record<string, TuiIncidentPrimitive>>;
}

interface TuiIncidentErrorSnapshot {
  readonly name: string;
  readonly code?: string;
  readonly status?: number;
}

interface TuiStoredIncident {
  readonly schemaVersion: 2;
  readonly incidentId: string;
  readonly eventType: TuiIncidentEventType;
  readonly occurredAtMs: number;
  readonly codeLocation: string;
  readonly eventLog: string;
}

interface TuiRunMarker {
  readonly schemaVersion: 1;
  readonly runId: string;
  readonly pid: number;
  readonly startedAtMs: number;
  readonly updatedAtMs: number;
  readonly phase: TuiIncidentPhase;
  readonly appVersion: string;
}

const INCIDENT_DIRECTORY = ['v2', 'observability', 'cli', 'incidents'] as const;
// Version 1 records contain arbitrary private text and must never be replayed.
const INCIDENT_SCHEMA_VERSION = 2;
const MAX_INCIDENT_FILES = 200;
const MAX_NON_FATAL_INCIDENTS_PER_RUN = 100;
const MAX_BREADCRUMBS = 20;
const RETENTION_MS = 7 * 24 * 60 * 60 * 1_000;
const NON_FATAL_DEDUPE_MS = 60_000;
const FATAL_DEDUPE_MS = 2_000;

export function resolveTuiIncidentDirectory(dataDir: string): string {
  return join(dataDir, ...INCIDENT_DIRECTORY);
}

export function createTuiIncidentReporter(
  options: CreateTuiIncidentReporterOptions,
): TuiIncidentReporter {
  try {
    return new LocalTuiIncidentReporter(options);
  } catch {
    return noopTuiIncidentReporter;
  }
}

export const noopTuiIncidentReporter: TuiIncidentReporter = Object.freeze({
  runId: '',
  hasFatalIncident: false,
  capture: () => undefined,
  breadcrumb: () => undefined,
  setPhase: () => undefined,
  drain: async () => undefined,
  flush: async () => undefined,
  completeRun: () => undefined,
});

export function captureTuiIncidentBestEffort(
  sink: TuiIncidentSink | undefined,
  input: TuiIncidentCapture,
): string | undefined {
  try {
    return sink?.capture(input);
  } catch {
    return undefined;
  }
}

class LocalTuiIncidentReporter implements TuiIncidentReporter {
  readonly runId = randomUUID();
  private readonly directory: string;
  private readonly markerPath: string;
  private readonly nowMs: () => number;
  private readonly pid: number;
  private readonly startedAtMs: number;
  private readonly isProcessAlive: (pid: number) => boolean;
  private readonly breadcrumbs: TuiIncidentBreadcrumb[] = [];
  private readonly recentFingerprints = new Map<string, number>();
  private phase: TuiIncidentPhase = 'startup';
  private nonFatalIncidentCount = 0;
  private fatalIncidentCaptured = false;
  private completed = false;

  constructor(private readonly options: CreateTuiIncidentReporterOptions) {
    this.directory = resolveTuiIncidentDirectory(options.dataDir);
    this.nowMs = options.nowMs ?? Date.now;
    this.pid = options.pid ?? process.pid;
    this.startedAtMs = this.nowMs();
    this.isProcessAlive = options.isProcessAlive ?? defaultIsProcessAlive;
    this.markerPath = join(this.directory, `active-${this.runId}.json`);
    ensurePrivateDirectory(this.directory);
    this.prune();
    this.recoverUncleanRuns();
    this.writeRunMarker();
    this.breadcrumb('cli.run.started', { phase: this.phase });
  }

  get hasFatalIncident(): boolean {
    return this.fatalIncidentCaptured;
  }

  setPhase(phase: TuiIncidentPhase): void {
    if (this.completed || this.phase === phase) return;
    this.phase = phase;
    this.breadcrumb('cli.phase.changed', { phase });
    this.writeRunMarker();
  }

  breadcrumb(
    name: string,
    details?: Readonly<Record<string, TuiIncidentPrimitive | undefined>>,
  ): void {
    try {
      const cleanName = allowedString(name, BREADCRUMB_NAMES);
      if (!cleanName) return;
      const phase = allowedString(details?.phase, PHASES);
      this.breadcrumbs.push({
        occurredAtMs: Math.floor(this.nowMs()),
        name: cleanName,
        ...(phase ? { details: { phase } } : {}),
      });
      while (this.breadcrumbs.length > MAX_BREADCRUMBS) this.breadcrumbs.shift();
    } catch {
      // Incident context must remain fail-open.
    }
  }

  capture(input: TuiIncidentCapture): string | undefined {
    try {
      const eventType = allowedString(input.eventType, EVENT_TYPES);
      if (!eventType) return undefined;
      const severity = allowedString(input.severity, SEVERITIES) ?? 'error';
      if (severity !== 'fatal' && this.nonFatalIncidentCount >= MAX_NON_FATAL_INCIDENTS_PER_RUN) {
        return undefined;
      }
      const occurredAtMs = Math.floor(this.nowMs());
      const error = snapshotError(input.error);
      const fingerprint = incidentFingerprint(eventType, error);
      const dedupeKey = `${eventType}:${fingerprint}`;
      const previousAtMs = this.recentFingerprints.get(dedupeKey);
      const dedupeWindowMs = severity === 'fatal' ? FATAL_DEDUPE_MS : NON_FATAL_DEDUPE_MS;
      if (previousAtMs !== undefined && occurredAtMs - previousAtMs < dedupeWindowMs) {
        return undefined;
      }
      this.recentFingerprints.set(dedupeKey, occurredAtMs);
      if (severity === 'fatal') this.fatalIncidentCaptured = true;
      else this.nonFatalIncidentCount += 1;

      const incidentId = randomUUID();
      const eventLog = minimizeEventLog(
        {
          incidentId,
          runId: this.runId,
          phase: input.phase ?? this.phase,
          severity,
          impact: input.impact ?? (severity === 'fatal' ? 'exit' : 'action_failed'),
          handled: input.handled ?? severity !== 'fatal',
          error,
          // Caller context, terminal names, OS strings and free-form operation/location
          // labels are deliberately excluded, even if they look like credentials were redacted.
          context: {
            appVersion: this.options.appVersion,
            platform: this.options.platform ?? platform(),
            arch: this.options.architecture ?? arch(),
            nodeVersion: this.options.nodeVersion ?? process.versions.node,
          },
          breadcrumbs: this.breadcrumbs,
        },
        eventType,
      );

      const stored: TuiStoredIncident = {
        schemaVersion: INCIDENT_SCHEMA_VERSION,
        incidentId,
        eventType,
        occurredAtMs,
        codeLocation: `tui.${eventType}`,
        eventLog,
      };
      writeJsonAtomically(
        this.directory,
        join(this.directory, `local-${occurredAtMs}-${incidentId}.json`),
        stored,
      );
      this.prune();
      return incidentId;
    } catch {
      return undefined;
    }
  }

  drain(): Promise<void> {
    return Promise.resolve();
  }

  async flush(_timeoutMs?: number): Promise<void> {
    return Promise.resolve();
  }

  completeRun(): void {
    if (this.completed) return;
    this.completed = true;
    try {
      rmSync(this.markerPath, { force: true });
    } catch {
      // A stale marker is recoverable on the next launch.
    }
  }

  private recoverUncleanRuns(): void {
    for (const entry of safeReadDirectory(this.directory)) {
      if (!entry.startsWith('active-') || !entry.endsWith('.json')) continue;
      const path = join(this.directory, entry);
      const marker = readRunMarker(path);
      if (!marker) {
        safeRemove(path);
        continue;
      }
      if (marker.pid !== this.pid && this.isProcessAlive(marker.pid)) continue;
      this.capture({
        eventType: 'cli_unclean_exit',
        error: new Error(`Previous TUI run ended without completing ${marker.phase}.`),
        component: 'process',
        operation: 'recover-unclean-run',
        codeLocation: 'src/observability/incident-reporter.ts#recoverUncleanRuns',
        severity: 'error',
        impact: 'exit',
        handled: true,
        phase: marker.phase,
        context: {
          previousRunId: marker.runId,
          previousPid: marker.pid,
          previousAppVersion: marker.appVersion,
          previousStartedAtMs: marker.startedAtMs,
          previousUpdatedAtMs: marker.updatedAtMs,
        },
      });
      safeRemove(path);
    }
  }

  private writeRunMarker(): void {
    if (this.completed) return;
    const marker: TuiRunMarker = {
      schemaVersion: 1,
      runId: this.runId,
      pid: this.pid,
      startedAtMs: this.startedAtMs,
      updatedAtMs: Math.floor(this.nowMs()),
      phase: this.phase,
      appVersion: numericVersion(this.options.appVersion) ?? 'unknown',
    };
    try {
      writeFileSync(this.markerPath, `${JSON.stringify(marker)}\n`, {
        encoding: 'utf8',
        mode: 0o600,
      });
      ensurePrivateFile(this.markerPath);
    } catch {
      // Incident reporting cannot affect TUI startup or phase transitions.
    }
  }

  private prune(): void {
    const nowMs = this.nowMs();
    const incidentFiles = safeReadDirectory(this.directory)
      .filter((entry) => /^(?:pending|sent|local)-.*\.json$/u.test(entry))
      .flatMap((entry) => {
        const path = join(this.directory, entry);
        try {
          return [{ path, modifiedAtMs: statSync(path).mtimeMs }];
        } catch {
          return [];
        }
      })
      .sort((left, right) => left.modifiedAtMs - right.modifiedAtMs);
    for (const file of incidentFiles) {
      try {
        if (JSON.parse(readFileSync(file.path, 'utf8')).schemaVersion !== INCIDENT_SCHEMA_VERSION) {
          safeRemove(file.path);
        }
      } catch {
        safeRemove(file.path);
      }
      if (nowMs - file.modifiedAtMs > RETENTION_MS) safeRemove(file.path);
    }
    const retained = incidentFiles.filter((file) => nowMs - file.modifiedAtMs <= RETENTION_MS);
    const deletionOrder = [
      ...retained.filter((file) => basename(file.path).startsWith('local-')),
      ...retained.filter((file) => basename(file.path).startsWith('sent-')),
      ...retained.filter((file) => basename(file.path).startsWith('pending-')),
    ];
    for (const file of deletionOrder.slice(0, Math.max(0, retained.length - MAX_INCIDENT_FILES))) {
      safeRemove(file.path);
    }
  }
}

// Explicit finite vocabularies, not character-pattern redaction. Unknown labels
// never become diagnostic text. Keep this projection shared with disk replay.
const EVENT_TYPES = [
  'cli_process_error',
  'cli_startup_error',
  'cli_render_error',
  'cli_interaction_error',
  'cli_runtime_bridge_error',
  'cli_terminal_error',
  'cli_persistence_error',
  'cli_shutdown_error',
  'cli_unclean_exit',
] as const;
const PHASES = ['startup', 'runtime', 'shutdown'] as const;
const SEVERITIES = ['fatal', 'error', 'warning'] as const;
const IMPACTS = ['exit', 'screen_unavailable', 'action_failed', 'degraded'] as const;
const ERROR_NAMES = [
  'Error',
  'TypeError',
  'RangeError',
  'SyntaxError',
  'ReferenceError',
  'URIError',
  'EvalError',
  'AggregateError',
  'AbortError',
] as const;
const ERROR_CODES = [
  'ECONNRESET',
  'ECONNREFUSED',
  'ETIMEDOUT',
  'ENOTFOUND',
  'EAI_AGAIN',
  'EPIPE',
  'ENOENT',
  'EACCES',
  'EPERM',
  'ENOSPC',
  'ABORT_ERR',
] as const;
const BREADCRUMB_NAMES = [
  'cli.run.started',
  'cli.phase.changed',
  'cli.runtime.events.reconnected',
  'cli.runtime.events.connected',
  'cli.runtime.events.disconnected',
  'cli.runtime.initialize.started',
  'cli.runtime.initialize.succeeded',
  'cli.auth.context.changed',
  'cli.first-frame.rendered',
  'cli.shutdown.started',
] as const;

function allowedString<T extends string>(value: unknown, allowed: readonly T[]): T | undefined {
  return typeof value === 'string' && allowed.includes(value as T) ? (value as T) : undefined;
}

function ownValue(value: unknown, key: string): unknown {
  if (!value || typeof value !== 'object') return undefined;
  // Do not invoke error getters, toJSON or string coercion while collecting diagnostics.
  return Object.getOwnPropertyDescriptor(value, key)?.value;
}

function snapshotError(value: unknown): TuiIncidentErrorSnapshot {
  const name =
    allowedString(ownValue(value, 'name'), ERROR_NAMES) ??
    ([AggregateError, TypeError, RangeError, SyntaxError, ReferenceError, URIError, EvalError, Error]
      .find((constructor) => value instanceof constructor)?.name ?? 'unknown');
  const code = allowedString(ownValue(value, 'code'), ERROR_CODES);
  const status = ownValue(value, 'status') ?? ownValue(value, 'statusCode');
  return {
    name,
    ...(code ? { code } : {}),
    ...(typeof status === 'number' && Number.isInteger(status) && status >= 100 && status <= 599
      ? { status }
      : {}),
  };
}

function numericVersion(value: unknown): string | undefined {
  return typeof value === 'string' && /^\d{1,4}\.\d{1,4}\.\d{1,4}$/u.test(value)
    ? value
    : undefined;
}

function incidentFingerprint(eventType: string, error: TuiIncidentErrorSnapshot): string {
  return createHash('sha256')
    .update(JSON.stringify([eventType, error]))
    .digest('hex')
    .slice(0, 24);
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
}

function uuid(value: unknown): string | undefined {
  return typeof value === 'string' &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u.test(value)
    ? value
    : undefined;
}

function timestamp(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function minimizeEventLog(value: unknown, eventType: string): string {
  const log = record(value);
  const context = record(log.context);
  const error = snapshotError(log.error);
  // An already minimized unknown thrown value stays unknown after disk replay.
  const breadcrumbs = (Array.isArray(log.breadcrumbs) ? log.breadcrumbs : [])
    .slice(-MAX_BREADCRUMBS)
    .flatMap((breadcrumb) => {
      const crumb = record(breadcrumb);
      const name = allowedString(crumb.name, BREADCRUMB_NAMES);
      const phase = allowedString(record(crumb.details).phase, PHASES);
      return name && timestamp(crumb.occurredAtMs)
        ? [
            {
              name,
              occurredAtMs: crumb.occurredAtMs,
              ...(phase ? { details: { phase } } : {}),
            },
          ]
        : [];
    });
  return JSON.stringify({
    schemaVersion: INCIDENT_SCHEMA_VERSION,
    incidentId: uuid(log.incidentId),
    runId: uuid(log.runId),
    source: 'cli',
    phase: allowedString(log.phase, PHASES) ?? 'runtime',
    severity: allowedString(log.severity, SEVERITIES) ?? 'error',
    impact: allowedString(log.impact, IMPACTS) ?? 'action_failed',
    handled: typeof log.handled === 'boolean' ? log.handled : true,
    fingerprint: incidentFingerprint(eventType, error),
    error,
    context: {
      appVersion: numericVersion(context.appVersion),
      platform: allowedString(context.platform, [
        'darwin',
        'linux',
        'win32',
        'freebsd',
        'openbsd',
        'aix',
        'sunos',
      ]),
      arch: allowedString(context.arch, [
        'arm64',
        'x64',
        'arm',
        'ia32',
        'riscv64',
        'ppc64',
        's390x',
      ]),
      nodeVersion: numericVersion(context.nodeVersion),
    },
    breadcrumbs,
  });
}

function readRunMarker(path: string): TuiRunMarker | undefined {
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as Partial<TuiRunMarker>;
    if (
      parsed.schemaVersion !== 1 ||
      typeof parsed.runId !== 'string' ||
      typeof parsed.pid !== 'number' ||
      typeof parsed.startedAtMs !== 'number' ||
      typeof parsed.updatedAtMs !== 'number' ||
      (parsed.phase !== 'startup' && parsed.phase !== 'runtime' && parsed.phase !== 'shutdown') ||
      typeof parsed.appVersion !== 'string'
    ) {
      return undefined;
    }
    return parsed as TuiRunMarker;
  } catch {
    return undefined;
  }
}

function writeJsonAtomically(directory: string, target: string, value: unknown): void {
  const temporaryPath = join(directory, `.incident-${process.pid}-${randomUUID()}.tmp`);
  try {
    writeFileSync(temporaryPath, `${JSON.stringify(value)}\n`, {
      encoding: 'utf8',
      mode: 0o600,
      flag: 'wx',
    });
    renameSync(temporaryPath, target);
    ensurePrivateFile(target);
  } catch (error) {
    safeRemove(temporaryPath);
    throw error;
  }
}

function ensurePrivateDirectory(path: string): void {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  try {
    chmodSync(path, 0o700);
  } catch {
    // Windows may not apply POSIX permission bits.
  }
}

function ensurePrivateFile(path: string): void {
  try {
    chmodSync(path, 0o600);
  } catch {
    // Windows may not apply POSIX permission bits.
  }
}

function safeReadDirectory(path: string): string[] {
  try {
    return readdirSync(path);
  } catch {
    return [];
  }
}

function safeRemove(path: string): void {
  try {
    rmSync(path, { force: true });
  } catch {
    // Best-effort retention and state cleanup.
  }
}

function defaultIsProcessAlive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0 || pid === process.pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}
