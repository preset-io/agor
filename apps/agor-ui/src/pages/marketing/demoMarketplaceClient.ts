// Fixture catalog + a demo-only stub AgorClient for the "marketplace" scene.
//
// CatalogTab (and the hooks it composes — useCatalogSearch, useCatalogReadiness,
// useConnectTargets, useMcpMemberPolicy) are wired to a real `AgorClient` and
// call `client.service(path).find()/.get()/.create()` for their data, same as
// production. Everywhere else on this demo route `client={null}` is enough
// because those surfaces read the store directly — but the Marketplace is
// deliberately NOT store-hydrated (see CatalogTab's own comment), so there is
// no client-free path to real catalog browsing. This stub answers exactly the
// handful of service calls that subtree makes, synchronously and from fixture
// data, so the REAL component tree renders and the REAL Connect flow runs.
//
// A handful of entries copied from packages/core/src/mcp-catalog/curated.yaml
// (Clerk and Hugging Face are `auth_type: none`, so Connect never needs an
// OAuth popup or a pasted key — the simplest path through the real form).

import type { Branch, MCPCatalogEntry, MCPMemberPolicySetting, User } from '@agor-live/client';
import { ROLES } from '@agor-live/client';
import { demoBranches } from './fixtureData';

export const DEMO_CATALOG_ENTRIES: MCPCatalogEntry[] = [
  {
    name: 'io.github.clerk/mcp-server',
    title: 'Clerk',
    category: 'dev-tools',
    capabilities: ['docs', 'code-search'],
    benefit:
      "Pull Clerk's own SDK snippets for the framework you are in, so auth code compiles against the current API rather than a remembered one.",
    starter_prompt:
      'Show Clerk’s current pattern for protecting a server route in the framework I am using and check my implementation against it.',
    permission_disclosure:
      'Reads Clerk’s public documentation and SDK code snippets. No account, application, or end-user data is accessed.',
    icon_url: 'https://www.google.com/s2/favicons?domain=clerk.com&sz=64',
    popularity_rank: 50,
    remote_url: 'https://mcp.clerk.com/mcp',
    has_remote: true,
    transport: 'streamable-http',
    auth_type: 'none',
  },
  {
    name: 'app.linear/linear',
    title: 'Linear',
    category: 'dev-tools',
    capabilities: ['issues', 'projects', 'notes'],
    benefit:
      'Turn a conversation into tracked Linear issues, and let an agent pick its next task off the board.',
    starter_prompt:
      'List the issues assigned to me in the current cycle and draft a short status update for each.',
    permission_disclosure:
      'Reads and writes issues, projects, and comments in the Linear workspaces you authorise.',
    icon_url: 'https://api.smithery.ai/servers/linear/icon',
    popularity_rank: 2,
    remote_url: 'https://mcp.linear.app/mcp',
    has_remote: true,
    transport: 'streamable-http',
    auth_type: 'oauth',
  },
  {
    name: 'com.datadoghq/mcp',
    title: 'Datadog',
    category: 'observability',
    capabilities: ['metrics', 'logs', 'alerts', 'traces', 'incidents'],
    benefit:
      'Give an agent the dashboards and logs it needs to explain an incident rather than speculate about one.',
    starter_prompt:
      'Show the monitors that alerted in the last day and correlate them with error logs from the same window.',
    permission_disclosure:
      'Reads metrics, logs, traces, monitors, and incidents from the Datadog organisations you authorise.',
    icon_url: 'https://www.google.com/s2/favicons?domain=datadoghq.com&sz=64',
    popularity_rank: 14,
    remote_url: 'https://mcp.datadoghq.com/api/unstable/mcp-server/mcp',
    has_remote: true,
    transport: 'streamable-http',
    auth_type: 'credentials',
    credentials: {
      scheme: 'bearer',
      label: 'Personal or service account access token',
      acquisition_url: 'https://docs.datadoghq.com/mcp_server/setup/',
    },
  },
  {
    name: 'co.huggingface/hf-mcp-server',
    title: 'Hugging Face',
    category: 'data-storage',
    capabilities: ['datasets', 'web-search'],
    benefit: 'Search models and datasets and read their cards without leaving the session.',
    starter_prompt:
      'Find recent models suited to the task I describe and compare their model cards.',
    permission_disclosure:
      'Reads public models, datasets, and Spaces. Authorising an account also exposes your private repositories.',
    icon_url: 'https://api.smithery.ai/servers/huggingface/icon',
    popularity_rank: 21,
    remote_url: 'https://huggingface.co/mcp',
    has_remote: true,
    transport: 'streamable-http',
    auth_type: 'none',
  },
];

export const DEMO_MARKETPLACE_USER = {
  user_id: 'demo-user-marketplace',
  name: 'Devon',
  email: 'devon@example.com',
  emoji: '🛠️',
  role: ROLES.ADMIN,
} as unknown as User;

const noop = () => undefined;
const emitter = () => ({ on: noop, off: noop, removeListener: noop });

/**
 * Minimal `AgorClient`-shaped stub covering exactly the service calls the
 * Marketplace catalog subtree makes (see file header). Everything not listed
 * here throws loudly rather than silently resolving to nothing, so a future
 * hook change surfaces as a console error in an interactive `?play=1` pass
 * instead of a card that quietly never finishes loading.
 */
export function createDemoMarketplaceClient() {
  const service = (path: string) => {
    switch (path) {
      case 'mcp-catalog':
        return { find: async () => DEMO_CATALOG_ENTRIES, ...emitter() };
      case 'mcp-catalog/readiness':
        return {
          get: async (entryKey: string) => ({ catalog_key: entryKey, state: 'no_auth' }),
          ...emitter(),
        };
      case 'mcp-catalog/connect':
        return {
          // Never resolves. A real success here ends with `navigate(sessionPath(...))`
          // — CatalogTab's own useNavigate(), scoped to the app's real ambient
          // Router (this page can't nest a MemoryRouter under it; React Router
          // throws on a Router inside a Router). That navigate would swap
          // MarketingVideoPage out for a live session route mid-capture, so the
          // scene's story stops at the Connect button showing its loading state
          // instead of ever reaching a response.
          create: () => new Promise(() => undefined),
          ...emitter(),
        };
      case 'mcp-member-policy':
        return {
          find: async (): Promise<MCPMemberPolicySetting> => ({
            policy: 'use_existing_only',
            can_configure: true,
          }),
          patch: async (): Promise<MCPMemberPolicySetting> => ({
            policy: 'use_existing_only',
            can_configure: true,
          }),
          ...emitter(),
        };
      case 'mcp-servers':
        return { find: async () => [] as unknown[], ...emitter() };
      case 'branches':
        return { findAll: async (): Promise<Branch[]> => demoBranches, ...emitter() };
      default:
        throw new Error(`demoMarketplaceClient: unstubbed service "${path}"`);
    }
  };

  return {
    service,
    io: emitter(),
  };
}
