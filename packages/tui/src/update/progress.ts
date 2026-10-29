export type McodeUpdatePhase =
  | 'checking'
  | 'downloading'
  | 'staging'
  | 'installing'
  | 'validating'
  | 'activating'
  | 'completed';

export interface McodeUpdatePhaseEvent {
  readonly phase: McodeUpdatePhase;
  readonly cancellable: boolean;
}

export interface McodeUpdateOperationOptions {
  readonly signal?: AbortSignal;
  readonly onOutput?: (chunk: string) => void;
  readonly onPhase?: (event: McodeUpdatePhaseEvent) => void;
}

export class McodeUpdateCancelledError extends Error {
  constructor(message = 'Shards Code update cancelled; the previous installation remains active.') {
    super(message);
    this.name = 'McodeUpdateCancelledError';
  }
}

export class McodeUpdateAdmissionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'McodeUpdateAdmissionError';
  }
}

export function throwIfMcodeUpdateCancelled(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new McodeUpdateCancelledError();
}

export function reportMcodeUpdatePhase(
  options: Pick<McodeUpdateOperationOptions, 'onPhase'>,
  phase: McodeUpdatePhase,
  cancellable: boolean,
): void {
  try {
    options.onPhase?.({ phase, cancellable });
  } catch {
    // Presentation observers must not change update safety or outcome.
  }
}

export function isMcodeUpdateCancelledError(error: unknown): error is McodeUpdateCancelledError {
  return error instanceof McodeUpdateCancelledError;
}

export function isMcodeUpdateAdmissionError(error: unknown): error is McodeUpdateAdmissionError {
  return error instanceof McodeUpdateAdmissionError;
}
