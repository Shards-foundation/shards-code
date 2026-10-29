import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createTuiIncidentReporter, resolveTuiIncidentDirectory } from '../../src/observability/incident-reporter.js';
import type { TuiIncidentReporter } from '../../src/observability/incident-reporter.js';

const privateText = 'Unannounced acquisition of Example Company /home/private/client-plan.txt';
const directories: string[] = [];
const reporters: TuiIncidentReporter[] = [];
const fetchRequest = vi.fn<typeof fetch>();
vi.stubGlobal('fetch', fetchRequest);

afterEach(() => {
  for (const reporter of reporters.splice(0)) reporter.completeRun();
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
  fetchRequest.mockReset();
});

function fixture() {
  const dataDir = mkdtempSync(join(tmpdir(), 'tui-incident-local-only-'));
  directories.push(dataDir);
  const reporter = createTuiIncidentReporter({ dataDir, appVersion: '0.4.12' });
  reporters.push(reporter);
  return { reporter, directory: resolveTuiIncidentDirectory(dataDir) };
}

describe('TUI incident local-only privacy boundary', () => {
  it('stores minimized incident data locally and never sends it over the network', async () => {
    const { reporter, directory } = fixture();
    reporter.capture({
      eventType: 'cli_runtime_bridge_error',
      error: new Error(privateText),
      component: privateText,
      operation: privateText,
      codeLocation: privateText,
      context: { prompt: privateText, path: privateText },
    });
    await reporter.drain();

    expect(fetchRequest).not.toHaveBeenCalled();
    const files = readdirSync(directory);
    expect(files.some((name) => name.startsWith('local-'))).toBe(true);
    expect(files.some((name) => name.startsWith('pending-') || name.startsWith('sent-'))).toBe(false);
    const records = files
      .filter((name) => name.startsWith('local-'))
      .map((name) => readFileSync(join(directory, name), 'utf8'));
    expect(records.join('\n')).not.toContain(privateText);
  });
});
