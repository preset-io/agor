/**
 * URL validation utilities for security-sensitive operations.
 */

/**
 * Validates that a health check URL targets an allowed destination.
 *
 * Blocks:
 * - Non-HTTP(S) protocols (file://, gopher://, etc.)
 * - Cloud metadata endpoints (169.254.x.x link-local range)
 * - IPv6 link-local addresses (fe80::)
 *
 * Allows localhost/127.0.0.1 since health checks legitimately target local services.
 */
export function isAllowedHealthCheckUrl(urlString: string): boolean {
  try {
    const url = new URL(urlString);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return false;
    const hostname = url.hostname;
    if (hostname.startsWith('169.254.')) return false;
    if (hostname.startsWith('[fe80:') || hostname === 'fe80') return false;
    return true;
  } catch {
    return false;
  }
}
