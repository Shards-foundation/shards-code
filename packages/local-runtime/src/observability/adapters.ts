import type { ToolDiagnosticLogger as MatrixToolLogger } from "./tool-logger.js";

import type { LocalRuntimeTelemetrySink } from "../sessions/router.js";
import type { ObservabilityLogger } from "./types.js";
import type { ThreadGoalRuntimeEventSink } from "../thread-goal/events.js";

export function createLocalRuntimeTelemetrySink(
  logger: ObservabilityLogger,
): LocalRuntimeTelemetrySink {
  const runtimeLogger = logger.child({ component: "local-runtime.session" });
  return (event) => {
    const fields = {
      runtime: event.runtime,
      phase: event.phase,
      ...(event.message ? { reason: event.message } : {}),
    };
    const child = runtimeLogger.child({
      sessionId: event.sessionId,
      ...(event.turnId ? { turnId: event.turnId } : {}),
    });
    if (event.phase === "failure") {
      child.error(`runtime turn ${event.phase}`, fields);
    } else if (event.phase === "disabled") {
      child.warn(`runtime turn ${event.phase}`, fields);
    } else {
      child.info(`runtime turn ${event.phase}`, fields);
    }
  };
}

/** Records one safe local Goal event together with its best-effort Session Clio outcome. */
export function createThreadGoalObservabilityEventSink(
  logger: ObservabilityLogger,
): ThreadGoalRuntimeEventSink {
  const goalLogger = logger.child({ component: "local-runtime.thread-goal" });
  return (event) => {
    const payload = event.payload as Record<string, unknown>;
    const child = goalLogger.child({
      sessionId: event.payload.sessionId,
      ...(typeof payload.turnId === "string" ? { turnId: payload.turnId } : {}),
    });
    child.info("Thread Goal runtime decision", {
      schema: "mavis.goal_runtime_event.v1",
      eventType: event.type,
      eventAtMs: event.at,
      payload,
    });
  };
}

export function createMatrixToolLogger(
  logger: ObservabilityLogger,
): MatrixToolLogger {
  const matrixLogger = logger.child({
    component: "local-runtime.matrix-tools",
  });
  return {
    info: (ctx, message) =>
      matrixLogger
        .child({
          sessionId: ctx.sessionId,
          turnId: ctx.turnId,
          workspaceDir: ctx.workspaceRoot,
        })
        .info(message),
    warn: (ctx, message) =>
      matrixLogger
        .child({
          sessionId: ctx.sessionId,
          turnId: ctx.turnId,
          workspaceDir: ctx.workspaceRoot,
        })
        .warn(message),
    debug: (ctx, message) =>
      matrixLogger
        .child({
          sessionId: ctx.sessionId,
          turnId: ctx.turnId,
          workspaceDir: ctx.workspaceRoot,
        })
        .debug(message),
  };
}
