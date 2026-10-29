import { getConfig, isManagedRuntime } from "@mavis/config";

import { LocalRuntimeApiHost } from "../api/host.js";
import { copyV2LayoutMigrationReceipt } from "../persistence/migration/v2-migration.js";
import type { LocalRuntimeConfig } from "../config/types.js";
import { logger } from "../common/logger.js";
import type { MetricsClient } from "../common/metrics.js";
import { LocalSkillHubStore } from "../skills/hub-api.js";
import type { AgentReferenceResolver } from "../agent/port.js";
import type { LocalAgentRuntimePort } from "../agent/runtime-port.js";
import { LocalSessionController } from "../sessions/controller.js";
import {
  createLocalRuntimeTelemetrySink,
  createMatrixToolLogger,
  createObservabilityEventSink,
  createThreadGoalObservabilityEventSink,
  JsonlFileObservabilitySink,
  type ObservabilityLogger,
} from "../observability/index.js";
import {
  formatV2TimestampParts,
  resolveV2EventDir,
} from "../persistence/layout/v2-paths.js";
import {
  SqliteLocalMessageStore,
  SqliteLocalQueueStore,
  SqliteLocalSessionStore,
} from "../persistence/sqlite-persistence.js";
import { FileSessionLedgerStore } from "../sessions/ledger/index.js";
import { SqliteLocalSessionProjectionStore } from "../sessions/projection/index.js";
import { FileSessionSnapshotStore } from "../sessions/snapshot/index.js";
import {
  LedgerBackedLocalSessionStore,
  LiveSessionWriter,
} from "../sessions/writer/index.js";
import { buildLocalRuntimeMetricsClient } from "./host-metrics.js";
import { LocalBashCompletionCorrelation } from "./bash-completion-correlation.js";
import {
  composeTelemetrySinks,
  createLocalRuntimeMetricsReporter,
} from "./observability-host-wiring.js";
import type {
  CreatedLocalRuntimeHost,
  CreateLocalRuntimeHostOptions,
} from "./host-factory-types.js";

export type {
  CreateConversationCompatibilityHostOptions,
  CreatedLocalRuntimeHost,
  CreateLocalRuntimeHostOptions,
  LocalRuntimeProductHostOptions,
} from "./host-factory-types.js";

export function createLocalRuntimeHost(
  options: CreateLocalRuntimeHostOptions,
): CreatedLocalRuntimeHost {
  const { dataDir, nowMs } = options;

  // Expose resolved dataDir so skill content template variables
  // ({{DATA_DIR}}) resolve correctly regardless of entry point
  // (Electron, CLI, daemon).
  process.env.MINIMAX_DATA_DIR = dataDir;

  const runtimeNowMs = nowMs ?? (() => Date.now());
  const observability =
    options.observability ??
    createObservabilityEventSink({
      component: "local-runtime",
      context: {
        dataDir,
        runtimeOwnerKind: options.runtimeOwnerKind,
        ...(options.runtimeMode ? { runtimeMode: options.runtimeMode } : {}),
      },
      nowMs,
      sinks: [
        new JsonlFileObservabilitySink({
          dir: () => resolveV2EventDir(dataDir, runtimeNowMs()),
          dateStamp: (epochMs) => formatV2TimestampParts(epochMs).date,
          filePrefix: "runtime-events",
          nowMs,
        }),
      ],
    });
  const telemetry = composeTelemetrySinks(
    options.telemetry,
    createLocalRuntimeTelemetrySink(observability),
  );
  const metricsClient =
    options.metricsClient ?? buildLocalRuntimeMetricsClient(options);
  const bashCompletionCorrelation = new LocalBashCompletionCorrelation(
    metricsClient,
  );
  // Runtime-start beacon: one bare-name counter per host boot (stored as
  // `local_runtime_started_total` — the server prepends the service name).
  metricsClient.counter("started_total", 1);
  const metricsReporter = createLocalRuntimeMetricsReporter(metricsClient);
  const configGetter =
    options.configGetter ?? (() => getConfig() as LocalRuntimeConfig);
  // Read the warnings off the config this host actually runs on, not off the
  // global `getConfig()`. Both product entries derive their getter from
  // `getConfig()`, so a clamped `goal` key still surfaces here; tests that
  // inject a hand-built config carry no warnings and stay silent without this
  // needing to know whether the getter was injected.
  for (const warning of configGetter().goalWarnings ?? []) {
    logger.warn({ warning }, "Goal config fell back to a safe default");
  }
  // Agent state is owned by the composed Agent service. This compatibility
  // factory only constructs Session/queue and other local runtime stores.
  const messageStore = new SqliteLocalMessageStore(dataDir);
  const ledgerStore = new FileSessionLedgerStore(dataDir, { metricsClient });
  const projectionStore = new SqliteLocalSessionProjectionStore(dataDir);
  const snapshotStore = new FileSessionSnapshotStore(dataDir, {
    metricsClient,
  });
  const sessionWriter = new LiveSessionWriter({
    ledgerStore,
    messageStore,
    projectionStore,
    snapshotStore,
  });
  const sessionStore = new LedgerBackedLocalSessionStore({
    delegate: new SqliteLocalSessionStore(dataDir),
    writer: sessionWriter,
  });
  const queuedMessageStore = new SqliteLocalQueueStore(dataDir);
  const legacyOpencodeEnabled = options.legacyOpencodeEnabled ?? false;
  const skillHubStore = new LocalSkillHubStore({
    dataDir: () => configGetter().dataDir,
    nowMs: runtimeNowMs,
    remoteEnabled: () => shouldUseRemoteSkillHub(options),
    fetch: options.fetchImpl,
    authContextGetter: options.authContextGetter,
    routingContextGetter: options.routingContextGetter,
  });
  const controller = new LocalSessionController({
    store: sessionStore,
    legacyOpencodeEnabled: () => legacyOpencodeEnabled,
    telemetry,
    nowMs,
    authContextGetter: options.authContextGetter,
    routingContextGetter: options.routingContextGetter,
    metricsClient,
    fetchImpl: options.fetchImpl,
    observeLLMRequest: bashCompletionCorrelation.observeLLMRequest,
    assertTurnStartAllowed: () => assertConversationUnavailable("turn-start"),
    assertSessionMutationAllowed: (operation) =>
      assertConversationUnavailable(`session-controller-${operation}`),
  });

  const apiHostOptions = copyV2LayoutMigrationReceipt(options, {
    controller,
    messageStore,
    ledgerStore,
    projectionStore,
    snapshotStore,
    sessionWriter,
    queuedMessageStore,
    runtimeMode: options.runtimeMode,
    capabilities: options.capabilities,
    shellFamily: options.shellFamily,
    capabilityProfile: options.capabilityProfile,
    mavisCronAdapterProvider: options.mavisCronAdapterProvider,
    deleteAgentCronTasks: options.deleteAgentCronTasks,
    cronConsumerEnabled: options.cronConsumerEnabled,
    runtimeConversation: options.runtimeConversation,
    reviewPromptDir: options.reviewPromptDir,
    deferChannelStartup: options.deferChannelStartup,
    globalEventPublisher: options.globalEventPublisher,
    agentResolver: options.agentResolver,
    agentRuntimePort: options.agentRuntimePort,
    promptSnapshots: options.promptSnapshots,
    disableLegacyConversation: options.disableLegacyConversation,
    deferQuestionnaireRecovery: options.deferQuestionnaireRecovery,
    runLegacyImCredentialMigration: options.runLegacyImCredentialMigration,
    runtimeOwnerKind: options.runtimeOwnerKind,
    runtimeStartupToken: options.runtimeStartupToken,
    startupExecutionPolicy: options.startupExecutionPolicy,
    configGetter,
    modelResolver: options.modelResolver,
    authContextGetter: options.authContextGetter,
    authContextInvalidator: options.authContextInvalidator,
    routingContextGetter: options.routingContextGetter,
    isContextWindowUsageEnabled: options.isContextWindowUsageEnabled,
    fetchImpl: options.fetchImpl,
    bashCompletionCorrelation,
    configUpdater: options.configUpdater,
    hostDiagnosticsProvider: options.hostDiagnosticsProvider,
    skillRegistryDiagnostics: options.skillRegistryDiagnostics,
    skillEnabledState: options.skillEnabledState,
    cliSunsetNotice: options.cliSunsetNotice,
    defaultWorkspaceDir: options.defaultWorkspaceDir,
    legacyOpencodeEnabled,
    skillHubStore,
    telemetry,
    threadGoalRuntimeEventSink: createThreadGoalObservabilityEventSink(
      observability,
    ),
    matrixLogger: createMatrixToolLogger(observability),
    nowMs,
    metricsReporter,
    metricsClient,
    ...(options.mcpRuntime ? { mcpService: options.mcpRuntime } : {}),
    ...(options.wechatRuntimeSdk
      ? { wechatRuntimeSdk: options.wechatRuntimeSdk }
      : {}),
  });
  const apiHost = new LocalRuntimeApiHost(apiHostOptions);
  if (options.sandboxOperationsFactory) {
    const buildOwnerTurnToolSources =
      apiHost.buildOwnerTurnToolSources.bind(apiHost);
    apiHost.buildOwnerTurnToolSources = (input) =>
      buildOwnerTurnToolSources({
        ...input,
        sandboxOperationsFactory: options.sandboxOperationsFactory,
      });
  }
  const ready = Promise.resolve();

  return {
    apiHost,
    controller,
    dataDir,
    ready,
    metricsClient,
    observability,
  };
}

function assertConversationUnavailable(operation: string): never {
  throw new Error(`Local Runtime V1 Conversation is unavailable: ${operation}`);
}

function shouldUseRemoteSkillHub(
  options: CreateLocalRuntimeHostOptions,
): boolean {
  if (options.configGetter?.().skillHub?.enabled === false) return false;
  if (process.env.__MAVIS_RUNTIME_MANAGED === "0") return false;
  return (
    options.runtimeOwnerKind === "electron" ||
    options.capabilities?.electronHost === true ||
    isManagedRuntime()
  );
}
