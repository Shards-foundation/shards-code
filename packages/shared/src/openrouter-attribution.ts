export const OPENROUTER_ATTRIBUTION_HEADERS = {
  'HTTP-Referer': 'https://github.com/Shards-foundation/shards-code',
  'X-OpenRouter-Title': 'Shards Code',
  'X-OpenRouter-Categories': 'cli-agent',
} as const;

export function isOpenRouterApiUrl(value: string | undefined): boolean {
  if (!value) return false;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && url.hostname.toLowerCase() === 'openrouter.ai';
  } catch {
    return false;
  }
}

/**
 * OpenRouter attributes usage per request. Product-owned values intentionally
 * win case-insensitively over user/provider headers so every Shards Code call
 * to the official endpoint is recorded under the same application identity.
 */
export function withOpenRouterAttributionHeaders(
  baseUrl: string | undefined,
  headers?: Readonly<Record<string, string>>,
): Record<string, string> | undefined {
  if (!isOpenRouterApiUrl(baseUrl)) {
    return headers ? { ...headers } : undefined;
  }

  const merged = new Map<string, { name: string; value: string }>();
  for (const [name, value] of Object.entries(headers ?? {})) {
    merged.set(name.toLowerCase(), { name, value });
  }
  for (const [name, value] of Object.entries(OPENROUTER_ATTRIBUTION_HEADERS)) {
    merged.set(name.toLowerCase(), { name, value });
  }
  return Object.fromEntries([...merged.values()].map(({ name, value }) => [name, value]));
}
