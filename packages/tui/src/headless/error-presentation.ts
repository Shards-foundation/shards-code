import { tuiErrorDiagnostic } from '../user-facing-failure.js';
import type { ExecResult } from './contract.js';
import { TuiExecError } from './exit-policy.js';

export function formatTuiExecFailure(error: TuiExecError): string {
  if (
    error.kind === 'invocation' ||
    error.kind === 'config' ||
    error.kind === 'cancelled' ||
    error.kind === 'brokenPipe'
  ) {
    return tuiErrorDiagnostic(error);
  }
  if (error.kind === 'runtime') {
    return `The run failed: ${tuiErrorDiagnostic(error)}. Retry after the connection recovers.`;
  }
  return `Shards Code encountered an internal error: ${tuiErrorDiagnostic(error)}. Retry; if it keeps happening, report it through an available support channel.`;
}

export function formatTuiExecResultFailure(result: ExecResult): string {
  if (result.status === 'timeout') {
    return 'The run timed out. Increase --timeout or retry.';
  }
  if (result.status === 'limit_exceeded') {
    return 'The run reached its step limit. Increase --max-steps or narrow the task.';
  }
  if (result.status === 'cancelled') return 'The run was cancelled.';
  if (result.error?.category === 'config') {
    const reason = result.error.message ? `: ${tuiErrorDiagnostic(result.error.message)}` : '';
    return `The run could not start with the current configuration${reason}. Open Shards Code and run /doctor.`;
  }
  if (result.error?.category === 'internal') {
    const reason = result.error.message ? `: ${tuiErrorDiagnostic(result.error.message)}` : '';
    return `Shards Code encountered an internal error${reason}. Retry; if it keeps happening, report it through an available support channel.`;
  }
  const reason = result.error?.message ? `: ${tuiErrorDiagnostic(result.error.message)}` : '';
  return `The run failed${reason}. Retry after the connection recovers.`;
}
