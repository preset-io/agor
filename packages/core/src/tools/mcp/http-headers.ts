/**
 * Utilities for MCP remote-transport HTTP headers.
 *
 * Custom headers can be secret-bearing (for service-account access) and may
 * coexist with Agor-managed auth headers. Authorization is intentionally
 * reserved for the `auth` config so custom headers cannot accidentally shadow
 * OAuth/JWT/bearer credentials.
 */

export const RESERVED_MCP_CUSTOM_HEADER_NAMES = new Set(['authorization']);

const HEADER_NAME_RE = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;

export function normalizeMCPCustomHeaders(
  headers?: Record<string, string>
): Record<string, string> | undefined {
  if (!headers) return undefined;

  const normalized: Record<string, string> = {};
  for (const [rawName, rawValue] of Object.entries(headers)) {
    const name = rawName.trim();
    if (!name || !HEADER_NAME_RE.test(name)) continue;
    if (RESERVED_MCP_CUSTOM_HEADER_NAMES.has(name.toLowerCase())) continue;
    if (typeof rawValue !== 'string') continue;
    normalized[name] = rawValue;
  }

  return Object.keys(normalized).length > 0 ? normalized : undefined;
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
