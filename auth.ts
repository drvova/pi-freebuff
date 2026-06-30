/**
 * Token management for Freebuff/Codebuff.
 * Caches auth tokens in memory with TTL.
 */

// ----------------------------------------------------------------------------
// Types
// ----------------------------------------------------------------------------

export interface CachedToken {
  token: string;
  expiresAt: number;
}

// ----------------------------------------------------------------------------
// In-memory cache
// ----------------------------------------------------------------------------

let cache: CachedToken | null = null;
let cacheKey: string | null = null;
let cacheEpoch = 0;

function flightKey(apiKey: string, host: string): string {
  return `${host}\x1f${apiKey}`;
}

export function getCachedToken(apiKey: string, host: string): string | null {
  const now = Date.now();
  const key = flightKey(apiKey, host);
  if (cache && cacheKey === key && cache.expiresAt > now + 60_000) {
    return cache.token;
  }
  return null;
}

export function setCachedToken(apiKey: string, host: string, token: string, expiresInSeconds: number): void {
  const key = flightKey(apiKey, host);
  cache = {
    token,
    expiresAt: Date.now() + expiresInSeconds * 1000,
  };
  cacheKey = key;
}

export function clearCachedToken(): void {
  cache = null;
  cacheKey = null;
  cacheEpoch++;
}

// ----------------------------------------------------------------------------
// Token refresh (placeholder — actual refresh depends on auth flow)
// ----------------------------------------------------------------------------

export async function getOrRefreshToken(
  apiKey: string,
  host: string,
  signal?: AbortSignal,
): Promise<string> {
  const cached = getCachedToken(apiKey, host);
  if (cached) return cached;

  // Token not cached — caller should refresh via OAuth
  throw new Error("No cached token. Run /freebuff-login to authenticate.");
}
