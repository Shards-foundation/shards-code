import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildLocalRuntimeMetricsClient } from '../../src/runtime/host-metrics.js';
import type { MetricsBatchReporter, MetricsClient } from '../../src/common/metrics.js';

const clients: MetricsClient[] = [];
const fetchRequest = vi.fn<typeof fetch>();
vi.stubGlobal('fetch', fetchRequest);

afterEach(async () => {
  for (const client of clients.splice(0)) await client.close();
  fetchRequest.mockReset();
  vi.unstubAllEnvs();
});

function fixture(metricsReporter?: MetricsBatchReporter) {
  const client = buildLocalRuntimeMetricsClient({
    runtimeOwnerKind: 'tui',
    appVersion: '0.4.12',
    ...(metricsReporter ? { metricsReporter } : {}),
  });
  clients.push(client);
  return client;
}

describe('local runtime metrics privacy', () => {
  it('keeps runtime metrics local when no reporter is explicitly injected', async () => {
    vi.stubEnv('__MAVIS_RUNTIME_MANAGED', '1');
    vi.stubEnv('MAVIS_BUILD_ENV', 'prod');
    vi.stubEnv('MAVIS_REGION', 'en');
    const client = fixture();

    client.counter('started_total', 1);
    await client.flush();

    expect(fetchRequest).not.toHaveBeenCalled();
  });

  it('preserves an explicitly supplied non-network metrics reporter integration', async () => {
    const reportBatch = vi.fn(async () => ({ accepted: 1 }));
    const client = fixture({ reportBatch });

    client.counter('started_total', 1);
    await client.flush();

    expect(reportBatch).toHaveBeenCalledOnce();
    expect(fetchRequest).not.toHaveBeenCalled();
  });
});
