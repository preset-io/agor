// MCP catalog types
//
// The catalog is a browsable index of MCP servers users can connect. It is a
// curated overlay joined onto a mirror of the official MCP registry: the
// registry supplies breadth and reverse-DNS identity, `curated.yaml` supplies
// the presentation metadata the registry has no concept of (category,
// capabilities, benefit copy, starter prompt, permission disclosure).
//
// The catalog holds no tenant data — every field originates from a public HTTP
// registry or from a file checked into this repository — so the table is
// deliberately global. See `packages/core/src/db/tenant-deletion-manifest.ts`.

import type { AgenticToolName } from './agentic-tool';
import type { UUID } from './id';
import type { MCPServer } from './mcp';
import type { Session } from './session';

/**
 * MCP catalog entry ID (branded UUID).
 *
 * Row identity, not server identity. A row deleted and re-created — which a
 * registry withdrawal followed by a republication does — gets a fresh
 * `generateId()`, so anything outside this table that needs to point at a
 * catalog entry must reference `name`, the registry's stable natural key.
 */
export type MCPCatalogEntryID = UUID & { readonly __brand: 'MCPCatalogEntryID' };

/**
 * Curation categories. Deliberately a small closed set: the point of the
 * overlay is that a user can scan six shelves, not five hundred tags.
 */
export const MCP_CATALOG_CATEGORIES = [
  'dev-tools',
  'data-storage',
  'productivity',
  'messaging',
  'observability',
  'search',
] as const;

export type MCPCatalogCategory = (typeof MCP_CATALOG_CATEGORIES)[number];

/**
 * Capability tags, also a closed set.
 *
 * These are facets a user filters by ("show me things that can read logs"), so
 * the vocabulary has to be small enough that every value has several entries
 * behind it. An open string field produced 118 tags across 50 entries, most
 * with a single member — a filter nobody could usefully click, and one typo
 * away from a silently empty facet.
 */
export const MCP_CATALOG_CAPABILITIES = [
  // Building software
  'code-repos',
  'issues',
  'pull-requests',
  'ci-cd',
  'deployments',
  'code-search',
  'docs',
  'design',
  'security-scan',
  // Data
  'databases',
  'sql',
  'schema',
  'files',
  'datasets',
  // Getting work done
  'tasks',
  'projects',
  'notes',
  'crm',
  'payments',
  'content-cms',
  'automations',
  // Talking to people
  'messages',
  'channels',
  'email',
  // Knowing what is happening
  'metrics',
  'logs',
  'traces',
  'alerts',
  'incidents',
  'analytics',
  'feature-flags',
  // Finding things out
  'web-search',
  'web-scrape',
  'network-checks',
] as const;

export type MCPCatalogCapability = (typeof MCP_CATALOG_CAPABILITIES)[number];

/**
 * Result of an unauthenticated `initialize` probe against a remote MCP URL.
 *
 * The registry does not declare whether a server needs auth, so the connect UI
 * would otherwise have to discover it after the user clicks. Each value picks a
 * different connect affordance, which is why "needs a key" and "we could not
 * reach it" are distinct rather than both collapsing into `unknown`:
 *
 * - `none`        — an unauthenticated JSON-RPC `initialize` handshake
 *                   succeeded; connect directly. A 2xx alone does not qualify:
 *                   any web page can return one.
 * - `oauth`       — 401 with an OAuth challenge; run the browser flow.
 * - `credentials` — 401/403 with a non-OAuth challenge; ask for an API key.
 * - `unreachable` — the host did not answer, or answered 5xx.
 * - `unknown`     — never probed, or refused by the outbound-URL filter.
 *
 * Nothing but `none` may be read as "this server is open".
 */
export const MCP_CATALOG_PROBED_AUTH_TYPES = [
  'none',
  'oauth',
  'credentials',
  'unreachable',
  'unknown',
] as const;

export type MCPCatalogProbedAuthType = (typeof MCP_CATALOG_PROBED_AUTH_TYPES)[number];

/** Transport a catalog entry can be connected over. */
export type MCPCatalogTransport = 'streamable-http' | 'sse' | 'stdio';

/** A remote endpoint as published by the registry. */
export interface MCPCatalogRemote {
  type: string;
  url: string;
}

/** An installable package as published by the registry. */
export interface MCPCatalogPackage {
  registry_type: string;
  identifier: string;
  version?: string;
  runtime_hint?: string;
  transport_type?: string;
}

/**
 * What one writer published for the columns both writers can fill.
 *
 * Each side is kept verbatim so the effective row is derived rather than
 * accumulated. Storing only the winner plus a marker saying who won cannot
 * survive a withdrawal: when curation drops a field there is nothing left to
 * fall back to, and the registry will not rewrite it unless it happens to
 * republish. Everything outside this shape belongs to exactly one writer by
 * construction — `benefit` is only ever curated, `version` only ever mirrored.
 */
export interface MCPCatalogSourceValues {
  title?: string;
  description?: string;
  website_url?: string;
  remote_url?: string;
  transport?: MCPCatalogTransport;
}

/**
 * Everything about an entry that is neither filtered nor sorted, stored in the
 * row's JSON blob following the `mcp_servers` convention.
 */
export interface MCPCatalogEntryData {
  /** Every remote the registry publishes, not just the primary one. */
  remotes?: MCPCatalogRemote[];
  /** Every package the registry publishes. */
  packages?: MCPCatalogPackage[];
  /** Registry-supplied icon URLs (present on ~10% of entries). */
  registry_icons?: string[];
  /**
   * Set once the registry mirror has written this row.
   *
   * Distinguishes a row the registry publishes from one that exists only
   * because `curated.yaml` named it, which decides whether dropping the entry
   * from that file should leave a row behind or remove it.
   */
  registry_mirrored?: boolean;
  /** Curated capability tags in display order (also materialized for search). */
  capabilities?: string[];
  /** Registry `repository.source`, e.g. `github`. */
  repository_source?: string;
  /** Challenge scheme from a `credentials` probe verdict, e.g. `Basic`. */
  probed_auth_scheme?: string;
  /** What the registry last published for the shared columns. */
  registry?: MCPCatalogSourceValues;
  /** What `curated.yaml` last supplied for the shared columns. */
  curation?: MCPCatalogSourceValues;
  /**
   * The URL the cached probe verdict describes.
   *
   * The verdict is about an endpoint, not about a row. When a republication or
   * a curation edit moves `remote_url`, this is what makes the difference
   * visible instead of leaving the new endpoint wearing the old one's answer.
   */
  probed_url?: string;
}

/**
 * A catalog entry as returned by the `/mcp-catalog` service.
 */
export interface MCPCatalogEntry {
  catalog_entry_id: MCPCatalogEntryID;
  created_at: Date;
  updated_at: Date;

  /** Reverse-DNS registry identity, e.g. `io.github.github/github-mcp-server`. */
  name: string;
  version?: string;
  /** `_meta["io.modelcontextprotocol.registry/official"].updatedAt`. */
  registry_updated_at?: Date;

  title?: string;
  description?: string;
  website_url?: string;
  repository_url?: string;

  transport?: MCPCatalogTransport;
  /** Primary remote URL, materialized so the connect branch is a single read. */
  remote_url?: string;
  has_remote: boolean;
  has_package: boolean;

  // Curation overlay
  curated: boolean;
  category?: MCPCatalogCategory;
  capabilities?: string[];
  /** One-line "why you'd want this" copy. */
  benefit?: string;
  /** A prompt that demonstrates the server, offered after connecting. */
  starter_prompt?: string;
  /** Plain-language statement of what connecting grants access to. */
  permission_disclosure?: string;
  icon_url?: string;
  verified: boolean;
  /** 1 = most popular. Null for uncurated registry entries. */
  popularity_rank?: number;

  // Auth probe
  probed_auth_type: MCPCatalogProbedAuthType;
  probed_at?: Date;
  /** The endpoint the cached verdict describes. */
  probed_url?: string;
  /** Origin of the authorization server discovered during the probe. */
  auth_server_origin?: string;

  remotes?: MCPCatalogRemote[];
  packages?: MCPCatalogPackage[];
  registry_icons?: string[];
  registry_status?: string;
  repository_source?: string;
  probed_auth_scheme?: string;
}

/**
 * Reverse-DNS labels that name the protocol rather than the publisher.
 *
 * Vendors routinely register the server under one — `com.figma.mcp/mcp` — so
 * the trailing label of either half is frequently the word "mcp" rather than
 * anything identifying.
 */
const GENERIC_CATALOG_NAME_LABELS = new Set(['mcp', 'mcp-server', 'server', 'api', 'www']);

/**
 * The identifying half of a reverse-DNS catalog name, lowercased.
 *
 * `com.deepwiki/mcp` → `deepwiki`, `io.github.github/github-mcp-server` →
 * `github`, `io.sanity.www/mcp` → `sanity`. Undefined when every label is
 * generic, which callers resolve their own way rather than guessing here.
 *
 * Shared because both sides of the wire need this and disagreed: the catalog
 * UI derived the publisher while connect took the last path segment, so the
 * server name the agent saw was the word "mcp" for 38 of 50 curated entries.
 * One rule, two formattings — never two rules.
 *
 * The publisher is the identity only while what is connectable is curated.
 * `io.github.<user>/<repo>` inverts it — every server one GitHub user
 * publishes shares a publisher and differs only in the path — so the day
 * uncurated registry entries become installable, this needs a disambiguating
 * suffix rather than a special case. `curated-loader.test.ts` holds the
 * uniqueness invariant that would otherwise notice too late.
 */
function catalogPublisherSegment(name: string): string | undefined {
  const [domain = ''] = name.split('/');
  return domain
    .split('.')
    .filter((label) => label && !GENERIC_CATALOG_NAME_LABELS.has(label.toLowerCase()))
    .pop()
    ?.toLowerCase();
}

/**
 * What to call a catalog entry on screen.
 *
 * A curated title wins. Otherwise the publisher stands in, because `title` is
 * the registry mirror's column and registry sync is off by default — rendering
 * `name` would label the whole catalog with reverse-DNS strings.
 *
 * It cannot recover casing: `com.deepwiki` reads "Deepwiki", not "DeepWiki".
 * Curated titles are the fix for that, not more derivation.
 */
export function catalogDisplayName(entry: Pick<MCPCatalogEntry, 'name' | 'title'>): string {
  const title = entry.title?.trim();
  if (title) return title;
  const publisher = catalogPublisherSegment(entry.name);
  if (!publisher) return entry.name;
  return publisher.charAt(0).toUpperCase() + publisher.slice(1);
}

/**
 * The name an installed server carries into the agent's tool namespace.
 *
 * This is the `<name>` in every `mcp__<name>__<tool>` the model reads, so it
 * has to identify the server: two installs sharing one produce tool names
 * nothing can tell apart. The path segment is the wrong half of the identity —
 * it is usually the protocol's own name — so the publisher supplies it, and the
 * path segment is only a fallback for a name with no publisher left in it.
 */
export function catalogServerSlug(name: string): string {
  const slugify = (value: string): string =>
    value
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '');

  const fromPublisher = slugify(catalogPublisherSegment(name) ?? '');
  if (fromPublisher) return fromPublisher;

  // The path segment only helps when it is not the same generic word, or the
  // fallback would reintroduce exactly the collision this exists to avoid.
  const segment = name.split('/').pop() ?? '';
  const fromSegment = GENERIC_CATALOG_NAME_LABELS.has(segment.toLowerCase())
    ? ''
    : slugify(segment);
  return fromSegment || 'mcp-server';
}

/** Sort keys the catalog service accepts. */
export type MCPCatalogSort = 'popularity' | 'name' | 'recently_updated' | 'relevance';

/**
 * Filters pushed into SQL by `MCPCatalogRepository.findAll`.
 *
 * Every field here narrows the read before rows leave the database. The
 * service's `fetchData` seam maps the Feathers query onto this shape.
 */
export interface MCPCatalogFilters {
  /** Exact row identity, so a caller holding an id can narrow in SQL. */
  catalog_entry_id?: string;
  /** Case-insensitive substring match over name, title, and description. */
  search?: string;
  category?: MCPCatalogCategory;
  /** Matches entries carrying this capability tag. */
  capability?: string;
  verified?: boolean;
  curated?: boolean;
  has_remote?: boolean;
  probed_auth_type?: MCPCatalogProbedAuthType;
  /** Exact registry lifecycle state. */
  registry_status?: string;
  /**
   * Exclude rows whose registry lifecycle state matches, so the browse read can
   * drop withdrawn servers without naming every state that is still live.
   */
  exclude_registry_status?: string;
  /**
   * Match any one of several probe verdicts.
   *
   * "Not known to need an account" spans two verdicts — probed open, and never
   * probed — and a single-value filter cannot say that. Callers that mean a set
   * pass one; the singular field stays for callers that mean exactly one.
   */
  probed_auth_types?: MCPCatalogProbedAuthType[];
  names?: string[];
  sort?: MCPCatalogSort;
  limit?: number;
  offset?: number;
}

/** Fields the registry ingestion job owns. Curation fields are never touched. */
export interface MCPCatalogRegistryUpsert {
  name: string;
  version?: string;
  registry_updated_at?: Date;
  title?: string;
  description?: string;
  website_url?: string;
  repository_url?: string;
  repository_source?: string;
  transport?: MCPCatalogTransport;
  remote_url?: string;
  remotes?: MCPCatalogRemote[];
  packages?: MCPCatalogPackage[];
  registry_icons?: string[];
  registry_status?: string;
}

/** Fields `curated.yaml` owns. Registry fields are only used as a fallback. */
export interface MCPCatalogCurationUpsert {
  name: string;
  category: MCPCatalogCategory;
  capabilities: MCPCatalogCapability[];
  benefit: string;
  starter_prompt: string;
  permission_disclosure: string;
  title?: string;
  description?: string;
  icon_url?: string;
  website_url?: string;
  verified: boolean;
  popularity_rank?: number;
  /** Used when the registry has not (yet) published the server. */
  remote_url?: string;
  transport?: MCPCatalogTransport;
}

/**
 * Request body of `POST /mcp-catalog/connect`.
 *
 * A catalog key and where the session should live, and nothing else. URL,
 * transport, and auth come from the catalog row server-side, so this cannot be
 * used to register an arbitrary server.
 */
export interface MCPCatalogConnectData {
  /** Catalog entry UUID or its reverse-DNS registry name. */
  catalog_key: string;
  branch_id: string;
  agentic_tool: AgenticToolName;
  /**
   * The `permission_disclosure` the user was shown and accepted.
   *
   * Connecting a server puts its tools, and their descriptions, inside every
   * prompt of the session it is attached to, so the disclosure is the last
   * thing between a user and that decision. A client-side checkbox cannot be
   * the only place that rule lives: the endpoint would accept a connect from
   * any caller that never rendered it. Sending back the text — rather than a
   * bare `true` — means a client cannot satisfy the check without having had
   * the disclosure in hand, and a stale one no longer matches the row.
   *
   * It does not prove a human read the words. It proves the protocol ran.
   */
  acknowledged_disclosure: string;
}

/** What a successful connect hands back to the caller. */
export interface MCPCatalogConnectResult {
  mcp_server: MCPServer;
  session: Session;
  /** The entry's curated demonstration prompt, for the new session's composer. */
  starter_prompt?: string;
  /** True when an existing install was reused rather than a second row created. */
  reused_existing_server: boolean;
}

/** Result of probing one entry, written back onto the row. */
export interface MCPCatalogProbeResult {
  probed_auth_type: MCPCatalogProbedAuthType;
  probed_at: Date;
  /** The endpoint this verdict describes. Stored so a moved URL is detectable. */
  probed_url: string;
  auth_server_origin?: string;
  /** Challenge scheme seen on a `credentials` verdict, e.g. `Basic`, `ApiKey`. */
  probed_auth_scheme?: string;
}
