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

import type { UUID } from './id';

/** MCP catalog entry ID (branded UUID) */
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
 * - `none`        — an unauthenticated handshake succeeded; connect directly.
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
  /** `_meta["io.modelcontextprotocol.registry/official"].status`. */
  registry_status?: string;
  /** Curated capability tags in display order (also materialized for search). */
  capabilities?: string[];
  /** Registry `repository.source`, e.g. `github`. */
  repository_source?: string;
  /** Challenge scheme from a `credentials` probe verdict, e.g. `Basic`. */
  probed_auth_scheme?: string;
  /**
   * Which writer owns the stored `remote_url` / `transport` pair.
   *
   * Without it the two writers cannot tell "curation supplied this" from
   * "the registry supplied this", so neither can safely update it: curation
   * could not correct its own URL, and the registry could not tell a gap it
   * should fill from a value it must not clobber.
   */
  connect_surface_source?: 'registry' | 'curation';
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
  /** Origin of the authorization server discovered during the probe. */
  auth_server_origin?: string;

  remotes?: MCPCatalogRemote[];
  packages?: MCPCatalogPackage[];
  registry_icons?: string[];
  registry_status?: string;
  repository_source?: string;
  probed_auth_scheme?: string;
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
  /** Case-insensitive substring match over name, title, and description. */
  search?: string;
  category?: MCPCatalogCategory;
  /** Matches entries carrying this capability tag. */
  capability?: string;
  verified?: boolean;
  curated?: boolean;
  has_remote?: boolean;
  probed_auth_type?: MCPCatalogProbedAuthType;
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

/** Result of probing one entry, written back onto the row. */
export interface MCPCatalogProbeResult {
  probed_auth_type: MCPCatalogProbedAuthType;
  probed_at: Date;
  auth_server_origin?: string;
  /** Challenge scheme seen on a `credentials` verdict, e.g. `Basic`, `ApiKey`. */
  probed_auth_scheme?: string;
}
