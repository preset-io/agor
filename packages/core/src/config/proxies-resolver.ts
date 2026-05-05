/**
 * Proxies config resolver.
 *
 * Validates the `proxies` block at daemon startup so the operator gets a
 * clear, actionable error rather than a subtly-broken request at runtime.
 *
 * Five rules this module helps enforce:
 *   1. Pass-through bytes only — validation is structural, not semantic.
 *   2. No vendor library — yaml-driven only; we don't ship presets.
 *   3. Read-only default — `allowed_methods` defaults to `['GET']`.
 *   4. Off by default — empty/absent block returns `[]` and the daemon
 *      doesn't mount the route at all.
 *   5. No auth injection — the daemon never reads user env vars; auth
 *      stays in the artifact.
 */

import type { AgorConfig, AgorProxyConfig } from './types';

const ALLOWED_METHODS_SET = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD']);

/**
 * Vendor slug regex: lowercase alphanumerics and hyphens only.
 *
 * Constrains the path component `/proxies/<vendor>/...` to characters that
 * round-trip cleanly through URL parsing and don't collide with reserved
 * segments. Operators set this slug themselves; rejecting `..`, slashes,
 * and other path-control characters at startup is cheaper than auditing
 * the route handler for traversal.
 */
const VENDOR_SLUG = /^[a-z0-9][a-z0-9-]{0,63}$/;

export type ProxyMethod = NonNullable<AgorProxyConfig['allowed_methods']>[number];

/**
 * Resolved per-vendor proxy with defaults applied and `upstream` normalized
 * (no trailing slash). This is the shape the route handler reads.
 */
export interface ResolvedProxy {
  vendor: string;
  upstream: string;
  description?: string;
  docs_url?: string;
  allowed_methods: ProxyMethod[];
}

/**
 * Resolve and validate the `proxies` block.
 *
 * Throws `Error` with an operator-friendly message on any malformed entry —
 * the daemon should let this bubble up at startup so the misconfiguration
 * is visible in the boot log rather than as a 500 at request time.
 */
export function resolveProxies(config: AgorConfig): ResolvedProxy[] {
  const block = config.proxies;
  if (!block || typeof block !== 'object') return [];

  const resolved: ResolvedProxy[] = [];

  for (const [vendor, raw] of Object.entries(block)) {
    if (!VENDOR_SLUG.test(vendor)) {
      throw new Error(
        `proxies: vendor key "${vendor}" must be lowercase alphanumerics or hyphens ` +
          `(e.g. "shortcut", "linear", "atlassian-jira"), 1-64 characters.`
      );
    }

    if (!raw || typeof raw !== 'object') {
      throw new Error(`proxies.${vendor} must be an object with at least { upstream }.`);
    }

    if (typeof raw.upstream !== 'string' || !raw.upstream.trim()) {
      throw new Error(`proxies.${vendor}.upstream is required and must be a non-empty string.`);
    }

    const trimmedUpstream = raw.upstream.trim();
    let parsed: URL;
    try {
      parsed = new URL(trimmedUpstream);
    } catch {
      throw new Error(
        `proxies.${vendor}.upstream is not a valid URL: "${trimmedUpstream}". ` +
          `Expected scheme+host like "https://api.app.shortcut.com".`
      );
    }

    if (parsed.protocol !== 'https:') {
      throw new Error(
        `proxies.${vendor}.upstream must use https:// (got "${parsed.protocol}//"). ` +
          `Refusing to proxy plaintext traffic — even on a private network the ` +
          `daemon cannot tell whether the upstream link is trustworthy.`
      );
    }

    // Reject path / query / fragment on the upstream. The convention is
    // bare-origin only ("https://api.app.shortcut.com"), and the caller
    // appends the path on its end of the proxy mount
    // ("/proxies/shortcut/api/v3/..."). Allowing path prefixes here just
    // means two callers produce different upstream URLs for the same vendor
    // depending on where they slice the path — the resulting drift was
    // flagged in code review.
    const hasNonRootPath = parsed.pathname !== '' && parsed.pathname !== '/';
    if (hasNonRootPath || parsed.search || parsed.hash) {
      throw new Error(
        `proxies.${vendor}.upstream must be a bare origin without path, query, or ` +
          `fragment (got "${trimmedUpstream}"). The caller appends the path on the ` +
          `proxy mount, e.g. "/proxies/${vendor}/api/v3/...". Set upstream to ` +
          `"${parsed.origin}".`
      );
    }
    const upstream = parsed.origin;

    if (raw.description !== undefined && typeof raw.description !== 'string') {
      throw new Error(`proxies.${vendor}.description must be a string when set.`);
    }
    if (raw.docs_url !== undefined && typeof raw.docs_url !== 'string') {
      throw new Error(`proxies.${vendor}.docs_url must be a string when set.`);
    }

    let allowed: ProxyMethod[] = ['GET'];
    if (raw.allowed_methods !== undefined) {
      if (!Array.isArray(raw.allowed_methods) || raw.allowed_methods.length === 0) {
        throw new Error(
          `proxies.${vendor}.allowed_methods must be a non-empty array (e.g. ["GET", "POST"]).`
        );
      }
      const upper = raw.allowed_methods.map((m) =>
        typeof m === 'string' ? m.toUpperCase() : String(m)
      );
      for (const m of upper) {
        if (!ALLOWED_METHODS_SET.has(m)) {
          throw new Error(
            `proxies.${vendor}.allowed_methods contains "${m}". ` +
              `Allowed: ${[...ALLOWED_METHODS_SET].join(', ')}.`
          );
        }
      }
      allowed = upper as ProxyMethod[];
    }

    resolved.push({
      vendor,
      upstream,
      description: raw.description?.trim() || undefined,
      docs_url: raw.docs_url?.trim() || undefined,
      allowed_methods: allowed,
    });
  }

  return resolved;
}
