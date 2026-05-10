/**
 * Bind-host classification.
 *
 * Helpers for deciding whether the daemon is reachable only from the local
 * machine (loopback) or also from the network. Used by the startup security
 * check that gates anonymous-auth on whether unauthenticated traffic could
 * arrive from outside the host.
 *
 * Loopback forms recognised:
 *   - 'localhost' (case-insensitive, optional trailing dot)
 *   - any IPv4 in 127.0.0.0/8
 *   - '::1' (IPv6 loopback)
 *   - '::ffff:127.x.x.x' (IPv4-mapped IPv6 loopback, on dual-stack hosts)
 *
 * Non-loopback forms (NOT loopback): '0.0.0.0', '::', '192.168.x.y',
 * 'mybox.local', any external hostname.
 */

const IPV4_LOOPBACK_RE = /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/;
// IPv4-mapped IPv6 loopback as written by the user: '::ffff:127.x.y.z'.
const IPV4_MAPPED_LOOPBACK_RE = /^::ffff:127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/;
// IPv4-mapped IPv6 loopback after WHATWG URL canonicalization, e.g.
// 'http://[::ffff:127.0.0.1]' → hostname '::ffff:7f00:1'. The IPv4 octets get
// repacked into two hex words, the high one always starting with '7f'.
const IPV4_MAPPED_COMPRESSED_LOOPBACK_RE = /^::ffff:7f[0-9a-f]{0,2}:[0-9a-f]{1,4}$/;

export function isLoopbackBindHost(host: string): boolean {
  const normalized = host.trim().toLowerCase().replace(/\.$/, '');
  if (normalized === 'localhost') return true;
  if (normalized === '::1') return true;
  if (IPV4_LOOPBACK_RE.test(normalized)) return true;
  if (IPV4_MAPPED_LOOPBACK_RE.test(normalized)) return true;
  if (IPV4_MAPPED_COMPRESSED_LOOPBACK_RE.test(normalized)) return true;
  return false;
}

/**
 * Classify a configured base URL as loopback or network-reachable.
 *
 * Returns `null` for empty/invalid input so callers can distinguish "not
 * configured" from "configured to a public host". This matches the security
 * check's intent: only flag a *configured* public URL, not the absence of one.
 */
export function isLoopbackUrl(url: string | undefined | null): boolean | null {
  if (!url) return null;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  // WHATWG URL wraps IPv6 hostnames in brackets ('[::1]'); the bind-host
  // classifier expects the bare form.
  const hostname = parsed.hostname.replace(/^\[|\]$/g, '');
  return isLoopbackBindHost(hostname);
}
