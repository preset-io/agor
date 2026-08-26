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
  MCPCatalogCredentialRequirement,
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
  { label: 'Sort: Curated', value: 'popularity' },
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
 * Technical authentication copy follows the live endpoint verdict whenever
 * Connect has one. Catalog metadata is explicitly labelled as an unchecked
 * fallback so stale curation cannot contradict the primary status panel.
 */
export function catalogAuthenticationDetail(
  catalogAuthType: MCPCatalogAuthType,
  liveRequirement?: MCPCatalogCredentialRequirement | null
): string {
  switch (liveRequirement) {
    case 'required':
      return 'Bearer credential · Live endpoint check';
    case 'oauth':
      return 'OAuth · Live endpoint check';
    case 'not_accepted':
      return 'No credential accepted · Live endpoint check';
    case 'unsupported':
      return 'Unsupported credential scheme · Live endpoint check';
    default:
      switch (catalogAuthType) {
        case 'none':
          return 'Catalog metadata: no account stated · Live endpoint not checked yet';
        case 'oauth':
          return 'Catalog metadata: OAuth · Live endpoint not checked yet';
        case 'credentials':
          return 'Catalog metadata: bearer credential · Live endpoint not checked yet';
        default:
          return 'Unknown · Checked live when you connect';
      }
  }
}

/**
 * What a user would find out by pressing Connect, said before they press it.
 *
 * `unknown` is its own case rather than being folded into either side:
 * connecting checks the endpoint and may well succeed, but an entry that does
 * not say cannot promise it will. It is what an entry naming an endpoint and
 * stating no `auth_type` reads as, which is what curation is told to write
 * wherever nobody has established one.
 *
 * `sign-in` is separate from `ready` for the same reason: both connect, but one
 * of them opens the provider's sign-in popup, and a card
 * promising "no account needed" for a server that needs their Notion account is
 * the promise this vocabulary exists to keep. It is not `blocked` — the sign-in
 * happens, it just happens after connecting rather than instead of it.
 *
 * `api-key` is the third of those, and the one that asks something of the user
 * *before* connecting rather than after. It stopped being `blocked` when the
 * drawer gained somewhere to paste a key: `blocked` means the marketplace
 * cannot install this at all and the drawer removes the form entirely, which is
 * the opposite of what an entry needing a key now wants. Keeping it in the same
 * enum rather than adding a parallel flag is what makes the card, the drawer
 * and the "connectable now" filter agree — they all read this one value, and
 * the last time two of them disagreed a card advertised a connect that the
 * drawer then refused.
 */
export type ConnectReadiness = 'ready' | 'sign-in' | 'api-key' | 'unchecked' | 'blocked';

export interface ConnectStatus {
  readiness: ConnectReadiness;
  /** Short enough for a card tag. */
  label: string;
  /** A sentence, for the drawer. */
  detail: string;
}

const CONNECT_STATUSES = {
  /**
   * An entry with no endpoint to dial.
   *
   * This used to read "Runs locally — an admin configures it directly", which
   * described a capability that does not exist: the two entries it applied to
   * carried no package or command data either, so there was no path to
   * installing them for an admin or anyone else. The copy is gone with them,
   * and the loader now refuses such an entry outright
   * (`assertEntryIsServable`), so nothing served can reach this.
   *
   * The branch stays because `MCPCatalogEntry.remote_url` is optional and these
   * entries arrive over the wire — the UI does not get to assume the loader
   * that produced them was this one. What it must not do is describe the entry
   * as a working feature; it says the marketplace cannot install it, which is
   * true whatever produced it. If local servers are ever offered they arrive
   * with fields describing how the server is run, and an affordance designed
   * against those — not this string.
   */
  unavailable: {
    readiness: 'blocked',
    label: 'Not installable',
    detail: 'This entry names no endpoint to connect to, so it cannot be installed.',
  },
  signIn: {
    readiness: 'sign-in',
    label: 'Connect with your account',
    detail:
      'This server uses your own account. Connecting opens the provider sign-in in a secure popup and creates the new session; the starter prompt appears only after sign-in succeeds.',
  },
  needsKey: {
    readiness: 'api-key',
    label: 'Needs a bearer access token',
    detail:
      'This server needs a bearer access token from your own account. Paste one when you connect — Agor stores it for you alone, and never shows it again.',
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
 * The same rule the cards state: `none` is stated open, `oauth` signs the user
 * in with their own account in the automatic popup, `credentials` takes a reviewed bearer token the
 * user pastes into the drawer, and `unknown` is simply unstated — connecting
 * checks the endpoint. An entry that says nothing is worth offering, so a
 * filter demanding `none` would hide entries the card beside it called
 * connectable.
 *
 * Every value is now on this list, which is the point: after the API-key field
 * there is no stated auth type the marketplace refuses outright. The list stays
 * rather than collapsing into `true` because the enum can gain a member, and a
 * new one should have to be added here deliberately rather than inheriting
 * "connectable" from a constant that stopped distinguishing anything.
 *
 * Exported so the toolbar's filter and `connectStatus` cannot drift into
 * disagreeing about what "connectable" means.
 */
export const CONNECTABLE_AUTH_TYPES: MCPCatalogAuthType[] = [
  'none',
  'oauth',
  'credentials',
  'unknown',
];

export function connectStatus(entry: MCPCatalogEntry): ConnectStatus {
  // `has_remote` is derived from `remote_url`, so testing the URL tests both.
  // Unreachable for anything the loader served; see `unavailable` above.
  if (!entry.remote_url || entry.transport === 'stdio') return CONNECT_STATUSES.unavailable;
  if (entry.auth_type === 'credentials') return CONNECT_STATUSES.needsKey;
  if (entry.auth_type === 'oauth') return CONNECT_STATUSES.signIn;
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
