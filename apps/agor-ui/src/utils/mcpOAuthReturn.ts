import { mcpOAuthReturnPath } from '@agor/core/utils/url';

/**
 * The provider response the daemon's OAuth callback forwards to the return
 * page in the URL fragment (`#state=…&code=…`).
 *
 * Captured once at boot, before the auth gate and any router run, like
 * `captureMcpConnectIntent`: a signed-out browser renders the login screen
 * instead of the return page, and the login screen copies the current address
 * into its launch `return_to`. The fragment is therefore removed from the
 * address immediately and held in sessionStorage, which also lets the return
 * page finish the sign-in after the user signs in. The stored value is
 * short-lived and removed when the page submits it.
 */
const STORAGE_KEY = 'agor:mcp-oauth-return';
const MAX_AGE_MS = 10 * 60_000;

export interface MCPOAuthProviderResponse {
  state: string;
  code?: string;
  iss?: string;
  error?: string;
}

function parseProviderResponse(fragment: string): MCPOAuthProviderResponse | null {
  const params = new URLSearchParams(fragment.replace(/^#/, ''));
  const state = params.get('state')?.trim();
  const code = params.get('code')?.trim() || undefined;
  const error = params.get('error')?.trim() || undefined;
  if (!state || (!code && !error)) return null;
  const iss = params.get('iss')?.trim() || undefined;
  return { state, ...(code ? { code } : {}), ...(iss ? { iss } : {}), ...(error ? { error } : {}) };
}

function isReturnPath(pathname: string): boolean {
  return pathname.replace(/\/+$/, '').endsWith(mcpOAuthReturnPath());
}

export function captureMcpOAuthReturn(): void {
  if (typeof window === 'undefined') return;
  const { pathname, search, hash } = window.location;
  if (!hash || !isReturnPath(pathname)) return;
  window.history.replaceState(window.history.state, document.title, `${pathname}${search}`);
  const response = parseProviderResponse(hash);
  try {
    if (response) {
      window.sessionStorage.setItem(
        STORAGE_KEY,
        JSON.stringify({ response, capturedAt: Date.now() })
      );
    } else {
      window.sessionStorage.removeItem(STORAGE_KEY);
    }
  } catch {
    // Storage unavailable: the return page reports there is nothing to finish.
  }
}

/** The captured response, if one is stored and still fresh. Does not remove it. */
export function readMcpOAuthReturn(): MCPOAuthProviderResponse | null {
  try {
    const raw = window.sessionStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const stored = JSON.parse(raw) as {
      response?: Record<string, unknown>;
      capturedAt?: unknown;
    };
    // Re-parse through the same rules, so only the four known fields survive.
    const response =
      typeof stored.capturedAt === 'number' &&
      Date.now() - stored.capturedAt <= MAX_AGE_MS &&
      stored.response
        ? parseProviderResponse(
            new URLSearchParams(
              Object.entries(stored.response).filter(
                (entry): entry is [string, string] => typeof entry[1] === 'string'
              )
            ).toString()
          )
        : null;
    if (!response) window.sessionStorage.removeItem(STORAGE_KEY);
    return response;
  } catch {
    return null;
  }
}

export function clearMcpOAuthReturn(): void {
  try {
    window.sessionStorage.removeItem(STORAGE_KEY);
  } catch {
    // Nothing stored.
  }
}
