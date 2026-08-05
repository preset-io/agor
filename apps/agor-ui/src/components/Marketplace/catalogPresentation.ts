/**
 * Display vocabulary for the catalog's closed enums.
 *
 * The stored values are machine tags (`dev-tools`, `pull-requests`); these are
 * what a user reads. Kept beside the marketplace rather than in `@agor/core`
 * because they are presentation, not part of the catalog contract.
 */

import type { MCPCatalogCategory, MCPCatalogEntry, MCPCatalogSort } from '@agor/core/types';
import { MCP_CATALOG_CATEGORIES } from '@agor/core/types';

export const CATEGORY_LABELS: Record<MCPCatalogCategory, string> = {
  'dev-tools': 'Dev tools',
  'data-storage': 'Data & storage',
  productivity: 'Productivity',
  messaging: 'Messaging',
  observability: 'Observability',
  search: 'Search',
};

export const ALL_CATEGORIES = 'all' as const;

export type CategoryFilter = MCPCatalogCategory | typeof ALL_CATEGORIES;

export const CATEGORY_OPTIONS: Array<{ label: string; value: CategoryFilter }> = [
  { label: 'All', value: ALL_CATEGORIES },
  ...MCP_CATALOG_CATEGORIES.map((category) => ({
    label: CATEGORY_LABELS[category],
    value: category as CategoryFilter,
  })),
];

/**
 * Capability tags, grouped the way the closed set is grouped in
 * `@agor/core/types`. A flat 30-entry dropdown is unscannable; the groups are
 * the same "what is this for" split the vocabulary was designed around.
 */
export const CAPABILITY_GROUPS: Array<{ label: string; capabilities: string[] }> = [
  {
    label: 'Building software',
    capabilities: [
      'code-repos',
      'issues',
      'pull-requests',
      'ci-cd',
      'deployments',
      'code-search',
      'docs',
      'design',
      'security-scan',
    ],
  },
  {
    label: 'Data',
    capabilities: ['databases', 'sql', 'schema', 'files', 'datasets'],
  },
  {
    label: 'Getting work done',
    capabilities: ['tasks', 'projects', 'notes', 'crm', 'payments', 'content-cms', 'automations'],
  },
  {
    label: 'Talking to people',
    capabilities: ['messages', 'channels', 'email'],
  },
  {
    label: 'Knowing what is happening',
    capabilities: [
      'metrics',
      'logs',
      'traces',
      'alerts',
      'incidents',
      'analytics',
      'feature-flags',
    ],
  },
  {
    label: 'Finding things out',
    capabilities: ['web-search', 'web-scrape', 'network-checks'],
  },
];

/** `pull-requests` → `Pull requests`. */
export function capabilityLabel(capability: string): string {
  const spaced = capability.replace(/-/g, ' ');
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

/**
 * Sort options.
 *
 * The spec's "Most installs" default has no data source: nothing counts
 * installs, and the registry publishes no popularity signal. `popularity` is
 * the repository's curated-first, hand-assigned-rank ordering, so it is the
 * default and is labelled for what it actually is.
 */
export const SORT_OPTIONS: Array<{ label: string; value: MCPCatalogSort }> = [
  { label: 'Sort: Recommended', value: 'popularity' },
  { label: 'Sort: Recently updated', value: 'recently_updated' },
  { label: 'Sort: A–Z', value: 'name' },
];

export const DEFAULT_SORT: MCPCatalogSort = 'popularity';

/**
 * Display name for an entry.
 *
 * `title` is owned by the registry mirror, and curation deliberately leaves it
 * alone — so on an install with registry sync off (the default) no entry has
 * one, and rendering `name` directly would label the whole catalog with
 * reverse-DNS strings like `com.deepwiki/mcp`. The publisher label carries the
 * identity a user recognizes, so it stands in until a real title arrives.
 *
 * It cannot recover casing: `com.deepwiki` reads "Deepwiki", not "DeepWiki".
 * Curated titles are the fix for that, not more derivation.
 */
export function entryTitle(entry: MCPCatalogEntry): string {
  const title = entry.title?.trim();
  if (title) return title;

  const [domain = ''] = entry.name.split('/');
  // Publishers routinely register the server under a subdomain — `com.figma.mcp`
  // — so the trailing label is often the protocol's name rather than theirs.
  const publisher = domain
    .split('.')
    .filter((label) => label && !GENERIC_NAME_LABELS.has(label.toLowerCase()))
    .pop();
  if (!publisher) return entry.name;
  return publisher.charAt(0).toUpperCase() + publisher.slice(1);
}

const GENERIC_NAME_LABELS = new Set(['mcp', 'mcp-server', 'server', 'api', 'www']);

/**
 * What a user would find out by pressing Connect, said before they press it.
 *
 * Only the no-auth branch is wired, and most curated entries need an account —
 * so without this the default experience is accepting a disclosure and then
 * being refused. `unknown` is its own case rather than being folded into
 * either side: the endpoint probes on demand and may well succeed, but a
 * catalog that has never been probed cannot promise it will.
 */
export type ConnectReadiness = 'ready' | 'unchecked' | 'blocked';

export interface ConnectStatus {
  readiness: ConnectReadiness;
  /** Short enough for a card tag. */
  label: string;
  /** A sentence, for the drawer. */
  detail: string;
}

const CONNECT_STATUSES = {
  notReviewed: {
    readiness: 'blocked',
    label: 'Not reviewed',
    detail: 'Only servers reviewed by Preset can be connected from the marketplace.',
  },
  local: {
    readiness: 'blocked',
    label: 'Runs locally',
    detail:
      'This server runs locally rather than over the network. An admin configures it directly.',
  },
  needsAccount: {
    readiness: 'blocked',
    label: 'Needs an account',
    detail: 'This server needs an account. Signing in from the marketplace is not available yet.',
  },
  unreachable: {
    readiness: 'blocked',
    label: 'Unreachable',
    detail: 'This server could not be reached the last time Agor checked.',
  },
  undisclosed: {
    readiness: 'blocked',
    label: 'No access statement',
    detail: 'This server has not stated what it can access, so it cannot be connected yet.',
  },
  unchecked: {
    readiness: 'unchecked',
    label: 'Not checked yet',
    detail:
      'Agor has not checked this endpoint, so it may ask for an account. Connecting checks it — and stops there if it does.',
  },
  ready: {
    readiness: 'ready',
    label: 'No account needed',
    detail: 'This server needs no account, so connecting it takes one step.',
  },
} as const satisfies Record<string, ConnectStatus>;

export function connectStatus(entry: MCPCatalogEntry): ConnectStatus {
  if (!entry.curated) return CONNECT_STATUSES.notReviewed;
  if (!entry.has_remote || !entry.remote_url || entry.transport === 'stdio') {
    return CONNECT_STATUSES.local;
  }
  if (entry.probed_auth_type === 'oauth' || entry.probed_auth_type === 'credentials') {
    return CONNECT_STATUSES.needsAccount;
  }
  if (entry.probed_auth_type === 'unreachable') return CONNECT_STATUSES.unreachable;
  // Curation requires a disclosure, so this is unreachable today — but it is
  // what keeps a curation gap from offering a connect that could only fail.
  if (!entry.permission_disclosure?.trim()) return CONNECT_STATUSES.undisclosed;
  if (entry.probed_auth_type !== 'none') return CONNECT_STATUSES.unchecked;
  return CONNECT_STATUSES.ready;
}

/** Why connecting is refused outright, or `undefined` when it may proceed. */
export function connectBlockedReason(entry: MCPCatalogEntry): string | undefined {
  const status = connectStatus(entry);
  return status.readiness === 'blocked' ? status.detail : undefined;
}
