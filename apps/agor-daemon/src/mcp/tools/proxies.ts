/**
 * Proxies MCP Tools
 *
 * Read-only discovery for HTTP proxies the daemon mounts at
 * `/proxies/<vendor>/...`. Lets agents authoring artifacts find out which
 * vendors are configured and what URL to call, without poking the
 * filesystem or guessing the daemon hostname.
 *
 * Sanitization rule: this tool MUST NOT expose internal config (rate limit
 * settings, max body size, etc.). If those fields ever land in
 * `ResolvedProxy`, filter them out at the boundary here — agents and
 * artifact code are not the place to surface operator-tuning knobs.
 */

import { getBaseUrl, loadConfig, type ResolvedProxy, resolveProxies } from '@agor/core/config';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { McpContext } from '../server.js';
import { coerceString, textResult } from '../server.js';

interface ProxyDescriptor {
  vendor: string;
  description?: string;
  url: string;
  upstream: string;
  allowed_methods: string[];
  docs_url?: string;
}

async function describe(proxy: ResolvedProxy): Promise<ProxyDescriptor> {
  const baseUrl = await getBaseUrl();
  const origin = new URL(baseUrl).origin;
  return {
    vendor: proxy.vendor,
    description: proxy.description,
    url: `${origin}/proxies/${proxy.vendor}`,
    upstream: proxy.upstream,
    allowed_methods: [...proxy.allowed_methods],
    docs_url: proxy.docs_url,
  };
}

export function registerProxyTools(server: McpServer, _ctx: McpContext): void {
  // Tool 1: agor_proxies_list
  server.registerTool(
    'agor_proxies_list',
    {
      description: `List HTTP proxies the daemon is configured to expose for third-party APIs.

Each proxy forwards requests from /proxies/<vendor>/X to <upstream>/X so Sandpack artifacts (which run in *.codesandbox.io iframes) can call APIs that don't return CORS headers — Shortcut, Linear, Jira, GitHub Enterprise, etc.

# Two-token model (read this carefully)

EVERY request to a proxy needs TWO credentials, in the same headers object:

  1. Authorization: Bearer <agor.token>     ← daemon JWT, protects the proxy from being an open relay
  2. <Vendor's auth header>                  ← whatever the upstream API actually wants

Both render via Handlebars in /agor.config.js — the daemon mints {{ agor.token }} per-user at view time (15-min TTL). Vendor secrets come from {{ user.env.NAME }} (configured by the user in Settings → Environment Variables).

# Canonical example

  // /agor.config.js
  export const shortcutUrl = "{{ agor.proxies.shortcut.url }}";
  export const agorToken   = "{{ agor.token }}";
  export const scToken     = "{{ user.env.SHORTCUT_API_TOKEN }}";

  // App.js
  import { shortcutUrl, agorToken, scToken } from "./agor.config.js";

  if (!scToken) {
    // Render a "configure SHORTCUT_API_TOKEN in Settings" prompt — missing
    // env vars render as empty string, not undefined.
    return <ConfigurePrompt name="SHORTCUT_API_TOKEN" />;
  }

  const r = await fetch(\`\${shortcutUrl}/api/v3/member\`, {
    headers: {
      Authorization: \`Bearer \${agorToken}\`,
      "Shortcut-Token": scToken,
    },
  });

# Operational caps your code must respect

  - Response body cap: 5 MB. Endpoints that can return more (e.g. Shortcut /workflows, big search results) must use vendor pagination — the proxy will not page for you. Past the cap the connection is closed mid-stream and the browser sees a truncated body.
  - Upstream timeout: 30 s. Slow endpoints return HTTP 502 {error:"upstream_error"}.
  - Rate limit: 600 req/min per (user, vendor). Bursts past this return HTTP 429 {error:"rate_limited"} with no queueing.
  - Methods: 'allowed_methods' on each descriptor is authoritative. Default is read-only [GET]. Other methods require operator yaml config; calling them otherwise yields HTTP 405 {error:"method_not_allowed", allowed:[...]}.

# Error envelope to handle in fetch wrappers

  401 {error:"unauthorized"}          ← missing/expired agor.token (refresh by reloading the artifact)
  404 {error:"unknown_vendor"}        ← vendor not configured on this daemon
  405 {error:"method_not_allowed"}    ← method not in allowed_methods
  413 {error:"request_too_large"}     ← request body > 5 MB
  429 {error:"rate_limited"}
  502 {error:"upstream_error"}        ← upstream timeout / network failure
  502 {error:"upstream_too_large"}    ← upstream Content-Length > 5 MB

Always check r.ok before JSON.parse, and surface the error JSON to the user — opaque "failed to fetch" hangs are usually one of the above.

# What the proxy does NOT do

  - No auth injection: the daemon does not read {{ user.env.X }} for you and does not add vendor headers. You forward them yourself on every request.
  - No transformation: bytes pass through unchanged. No JSON re-encoding, no schema validation.
  - No caching, no retries.
  - No 'pageThrough' helper for pagination.

# Cookies & headers

  - Outbound: cookie / host / connection / content-length / accept-encoding are stripped. Anything else you set is forwarded.
  - Inbound: set-cookie / transfer-encoding / connection / content-length / content-encoding are stripped. Don't rely on cookie-based session auth — pass tokens explicitly.

# Discovery flow for an agent building an artifact

  1. Call agor_proxies_list to see what vendors are configured.
  2. For each vendor you'll use, write its url, the daemon Authorization header, and the vendor-specific auth header into /agor.config.js as Handlebars references (never hardcode secrets).
  3. Wire up a fetch wrapper that includes both headers on every call and renders the error envelope above on !r.ok.
  4. If the user hasn't configured the env var, the secret renders as "" — detect this and prompt them, don't make the API call.`,
      annotations: { readOnlyHint: true },
      inputSchema: z.object({}),
    },
    async () => {
      const config = await loadConfig();
      const proxies = resolveProxies(config);
      const out = await Promise.all(proxies.map(describe));
      return textResult({ proxies: out });
    }
  );

  // Tool 2: agor_proxies_get
  server.registerTool(
    'agor_proxies_get',
    {
      description:
        'Get details for a single configured HTTP proxy by vendor slug. Returns 404 if the vendor is not configured.',
      annotations: { readOnlyHint: true },
      inputSchema: z.object({
        vendor: z
          .string()
          .describe('Vendor slug as it appears in the route path, e.g. "shortcut" or "linear".'),
      }),
    },
    async (args) => {
      const vendor = coerceString(args.vendor);
      if (!vendor) throw new Error('vendor is required');
      const config = await loadConfig();
      const proxies = resolveProxies(config);
      const match = proxies.find((p) => p.vendor === vendor);
      if (!match) {
        throw new Error(`Unknown proxy vendor "${vendor}". Use agor_proxies_list to enumerate.`);
      }
      return textResult(await describe(match));
    }
  );
}
