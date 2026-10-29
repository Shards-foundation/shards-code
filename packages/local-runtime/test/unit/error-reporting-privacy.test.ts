import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const errorReportingDirectory = fileURLToPath(new URL('../../src/error-reporting', import.meta.url));

describe('automatic error reporting privacy boundary', () => {
  it('does not include the former automatic upload implementation in local-runtime source', () => {
    expect(existsSync(errorReportingDirectory)).toBe(false);
  });
});
