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

Each proxy forwards requests from /proxies/<vendor>/X to <upstream>/X. They exist so Sandpack artifacts can call APIs (Shortcut, Linear, Jira, etc.) that don't return CORS headers.

Use the returned 'url' as the base URL in your artifact. Auth headers are YOUR responsibility — set them in agor.config.js using {{ user.env.X }} and forward them on every request. The daemon does not inject auth.

Example artifact usage:
  // /agor.config.js
  export const shortcut = "{{ agor.proxies.shortcut.url }}";
  export const token = "{{ user.env.SHORTCUT_TOKEN }}";

  // App.js
  fetch(shortcut + "/api/v3/projects", { headers: { 'Shortcut-Token': token } })`,
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
