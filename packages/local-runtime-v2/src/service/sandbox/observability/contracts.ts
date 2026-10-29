import type { LocalSandboxInvocationIdentity } from '@mavis/agent-tools/desktop';
import type { SandboxErrorCode } from '../sandbox-errors.js';

/** Only bounded policy summaries belong here; never commands, paths, domains or environment. */
export type SandboxObservation = Readonly<Record<string, unknown>>;

export interface SandboxRuntimeEvent {
  readonly schema: 'mavis.sandbox_runtime_event.v1';
  readonly event_id: string;
  readonly runtime_instance_id: string;
  readonly sequence: number;
  readonly event_type: string;
  readonly event_at_ms: number;
  readonly session_id?: string;
  readonly turn_id?: string;
  readonly tool_call_id?: string;
  readonly invocation_id?: string;
  readonly task_id?: string;
  readonly operation_class?: LocalSandboxInvocationIdentity['operationClass'];
  readonly payload: SandboxObservation;
}

export type SandboxEventSink = (
  event: SandboxRuntimeEvent,
  delivery: 'batched' | 'immediate',
) => 'queued' | 'disabled' | 'unavailable' | void;

type SandboxTermination =
  | 'exited_zero'
  | 'exited_nonzero'
  | 'aborted'
  | 'timed_out'
  | 'spawn_failed'
  | 'not_started'
  | 'unknown';

export interface SandboxInvocationOutcome {
  readonly termination: SandboxTermination;
  readonly exitCode?: number | null;
  readonly reasonCode: string;
  readonly errorCode?: SandboxErrorCode;
  readonly errorStage?: string;
  readonly cleanup?: 'success' | 'failure';
}

export interface SandboxTraceStage {
  readonly stage: string;
  readonly offset_ms: number;
  readonly details?: SandboxObservation;
}

export type SandboxViolationOperation =
  | 'delete_denied'
  | 'write_denied'
  | 'read_denied'
  | 'network_denied'
  | 'local_access_denied'
  | 'unknown';

export type SandboxViolationSource = 'profile' | 'proxy' | 'backend' | 'runtime';

export type SandboxViolationTarget =
  | 'workspace'
  | 'git'
  | 'runtime-data'
  | 'session-temp'
  | 'filesystem-other'
  | 'network'
  | 'local-service'
  | 'unknown';

export interface SanitizedSandboxViolation {
  readonly sequence: number;
  readonly timestampMs: number;
  readonly invocationId?: string;
  readonly sessionId?: string;
  readonly turnId?: string;
  readonly toolCallId?: string;
  readonly taskId?: string;
  readonly effectiveGeneration?: number;
  readonly operation: SandboxViolationOperation;
  readonly source: SandboxViolationSource;
  readonly target: SandboxViolationTarget;
  readonly withinInvocationRoots?: boolean;
}
