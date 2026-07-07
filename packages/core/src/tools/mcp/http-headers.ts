/**
 * Utilities for MCP remote-transport HTTP headers.
 *
 * Custom headers can be secret-bearing (for service-account access) and may
 * coexist with Agor-managed auth headers. Authorization is intentionally
 * reserved for the `auth` config so custom headers cannot accidentally shadow
 * OAuth/JWT/bearer credentials.
 */

import { isUserEnvPlaceholder } from '../../mcp/template-resolver';

export const MCP_HEADER_REDACTED_SENTINEL = '••••••••';

export const RESERVED_MCP_CUSTOM_HEADER_NAMES = new Set([
  'authorization',
  // Hop-by-hop / transport-controlled headers. These are managed by fetch,
  // the MCP SDK transport, or the auth configuration and should not be stored
  // as custom MCP service-account headers.
  'connection',
  'content-length',
  'cookie',
  'host',
  'mcp-session-id',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
]);

const HEADER_NAME_RE = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;

export function isValidMCPHeaderName(name: string): boolean {
  return HEADER_NAME_RE.test(name);
}

export function isReservedMCPCustomHeaderName(name: string): boolean {
  return RESERVED_MCP_CUSTOM_HEADER_NAMES.has(name.toLowerCase());
}

export function normalizeMCPCustomHeaders(
  headers?: Record<string, string>
): Record<string, string> | undefined {
  if (!headers) return undefined;

  const normalized: Record<string, string> = {};
  for (const [rawName, rawValue] of Object.entries(headers)) {
    const name = rawName.trim();
    if (!name || !isValidMCPHeaderName(name)) continue;
    if (isReservedMCPCustomHeaderName(name)) continue;
    if (typeof rawValue !== 'string') continue;
    normalized[name] = rawValue;
  }

  return Object.keys(normalized).length > 0 ? normalized : undefined;
}

export function redactMCPCustomHeaders(
  headers?: Record<string, string>
): Record<string, string> | undefined {
  const normalized = normalizeMCPCustomHeaders(headers);
  if (!normalized) return undefined;
  return Object.fromEntries(
    Object.entries(normalized).map(([key, value]) => [
      key,
      // Leave a bare `{{ user.env.NAME }}` placeholder intact so executor-side
      // session-scoping can resolve it against the user's env; redacting it to
      // the sentinel would send `••••••••` as the literal header value. Raw
      // secrets — and partial/multiple/helper expressions that can carry secret
      // material — are still redacted.
      isUserEnvPlaceholder(value) ? value : MCP_HEADER_REDACTED_SENTINEL,
    ])
  );
}

export function restoreRedactedMCPCustomHeaders(options: {
  current?: Record<string, string>;
  next?: Record<string, string>;
}): Record<string, string> | undefined {
  if (!options.next) return undefined;

  const restored: Record<string, string> = {};
  for (const [key, value] of Object.entries(options.next)) {
    restored[key] =
      value === MCP_HEADER_REDACTED_SENTINEL && options.current?.[key] !== undefined
        ? options.current[key]
        : value;
  }

  return normalizeMCPCustomHeaders(restored);
}

export function mergeMCPRemoteHeaders(options: {
  base?: Record<string, string>;
  custom?: Record<string, string>;
  auth?: Record<string, string>;
}): Record<string, string> | undefined {
  const merged: Record<string, string> = {
    ...(options.base ?? {}),
    ...(normalizeMCPCustomHeaders(options.custom) ?? {}),
    ...(options.auth ?? {}),
  };
  return Object.keys(merged).length > 0 ? merged : undefined;
}
