/**
 * Display vocabulary for the catalog's closed enums.
 *
 * The stored values are machine tags (`dev-tools`, `pull-requests`); these are
 * what a user reads. Kept beside the marketplace rather than in `@agor/core`
 * because they are presentation, not part of the catalog contract.
 */

import type {
  MCPCatalogAuthType,
  MCPCatalogCategory,
  MCPCatalogEntry,
  MCPCatalogSort,
} from '@agor/core/types';
import { catalogDisplayName, MCP_CATALOG_CATEGORIES } from '@agor/core/types';

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
 * installs. `popularity` is the catalog's hand-assigned-rank ordering, so it is
 * the default and is labelled for what it actually is.
 */
export const SORT_OPTIONS: Array<{ label: string; value: MCPCatalogSort }> = [
  { label: 'Sort: Recommended', value: 'popularity' },
  { label: 'Sort: A–Z', value: 'name' },
];

export const DEFAULT_SORT: MCPCatalogSort = 'popularity';

/**
 * Display name for an entry.
 *
 * The rule lives in `@agor/core` because connect needs it too — it names the
 * created server and writes the refusals a user reads. Two derivations of "what
 * is this server called" is how the agent ended up seeing `mcp__mcp__<tool>`.
 */
export const entryTitle = catalogDisplayName;

/**
 * What a user would find out by pressing Connect, said before they press it.
 *
 * Only the no-auth branch is wired, and most entries need an account — so
 * without this the default experience is accepting a disclosure and then being
 * refused. `unknown` is its own case rather than being folded into either side:
 * connecting checks the endpoint and may well succeed, but an entry that does
 * not say cannot promise it will.
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

/**
 * Auth types that are not a refusal.
 *
 * The same rule the cards state: `none` is stated open, and `unknown` is simply
 * unstated — connecting checks the endpoint and stops cleanly if it turns out
 * to need an account. An entry that says nothing is worth offering, so a filter
 * demanding `none` would hide entries the card beside it called connectable.
 *
 * Exported so the toolbar's filter and `connectStatus` cannot drift into
 * disagreeing about what "connectable" means.
 */
export const CONNECTABLE_AUTH_TYPES: MCPCatalogAuthType[] = ['none', 'unknown'];

export function connectStatus(entry: MCPCatalogEntry): ConnectStatus {
  if (!entry.has_remote || !entry.remote_url || entry.transport === 'stdio') {
    return CONNECT_STATUSES.local;
  }
  if (entry.auth_type === 'oauth' || entry.auth_type === 'credentials') {
    return CONNECT_STATUSES.needsAccount;
  }
  if (entry.auth_type !== 'none') return CONNECT_STATUSES.unchecked;
  return CONNECT_STATUSES.ready;
}

/** Whether the "connectable now" filter would keep this entry. */
export function isConnectable(entry: MCPCatalogEntry): boolean {
  return (
    connectStatus(entry).readiness !== 'blocked' && CONNECTABLE_AUTH_TYPES.includes(entry.auth_type)
  );
}

/** Why connecting is refused outright, or `undefined` when it may proceed. */
export function connectBlockedReason(entry: MCPCatalogEntry): string | undefined {
  const status = connectStatus(entry);
  return status.readiness === 'blocked' ? status.detail : undefined;
}
