// MCP catalog types
//
// The catalog is a browsable index of MCP servers users can connect. Its
// contents are `curated.yaml`, a file checked into this repository: every entry
// is reviewed, versioned, and rolled back like any other change, and the
// catalog offers exactly what that file names.
//
// Nothing here originates with a tenant, a user, or a request. An entry is
// authored text plus the transport details needed to dial the server.

import type { AgenticToolName } from './agentic-tool';
import type { MCPServer } from './mcp';
import type { Session } from './session';

/**
 * Curation categories. Deliberately a small closed set: the point of the
 * catalog is that a user can scan six shelves, not five hundred tags.
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
 * What an entry states about the credentials its endpoint requires.
 *
 * Each value picks a different connect affordance, which is why "needs a key"
 * and "needs a browser flow" are distinct rather than both collapsing into one
 * "needs auth":
 *
 * - `none`        — an unauthenticated JSON-RPC `initialize` handshake is
 *                   accepted; connect can proceed.
 * - `oauth`       — the endpoint answers 401 with an OAuth challenge.
 * - `credentials` — the endpoint answers 401/403 with a non-OAuth challenge,
 *                   so it wants an API key.
 * - `unknown`     — `curated.yaml` does not state one.
 *
 * Every value here is a claim about a third party's endpoint that a checked-in
 * file cannot keep current on its own, so this decides what the marketplace
 * renders and nothing more. Connect probes the endpoint whatever the entry
 * states, and takes the answer. See {@link MCPCatalogProbedAuthType}.
 */
export const MCP_CATALOG_AUTH_TYPES = ['none', 'oauth', 'credentials', 'unknown'] as const;

export type MCPCatalogAuthType = (typeof MCP_CATALOG_AUTH_TYPES)[number];

/**
 * The subset an entry may state for itself.
 *
 * `unknown` is absent from this list because it is what omitting the key means,
 * not something to write. An entry claiming to be un-stated would be a
 * different way of spelling silence.
 */
export const MCP_CATALOG_AUTHORED_AUTH_TYPES = ['none', 'oauth', 'credentials'] as const;

export type MCPCatalogAuthoredAuthType = (typeof MCP_CATALOG_AUTHORED_AUTH_TYPES)[number];

/**
 * Verdict of an unauthenticated `initialize` probe against a remote MCP URL.
 *
 * A superset of {@link MCPCatalogAuthType}: a live request can also find that
 * nothing answered, which is a statement about one moment and therefore
 * something only a probe can report. An entry cannot carry this verdict — it
 * exists to be acted on immediately, at the point of connecting.
 */
export type MCPCatalogProbedAuthType = 'none' | 'oauth' | 'credentials' | 'unreachable' | 'unknown';

/** Transport a catalog entry can be connected over. */
export type MCPCatalogTransport = 'streamable-http' | 'sse' | 'stdio';

/**
 * A catalog entry as returned by the `/mcp-catalog` service.
 *
 * `name` is the identity. It is the reverse-DNS name the server is published
 * under, it is unique across the file, and it is what an installed server
 * records in `catalog_entry_name` — so it is also the key a caller connects by.
 * There is no second identifier to keep in step with it.
 */
export interface MCPCatalogEntry {
  /** Reverse-DNS identity, e.g. `io.github.github/github-mcp-server`. */
  name: string;

  title?: string;
  description?: string;
  website_url?: string;

  transport?: MCPCatalogTransport;
  remote_url?: string;
  /** Whether the entry names an endpoint that can be dialled over the network. */
  has_remote: boolean;

  category: MCPCatalogCategory;
  capabilities: string[];
  /** One-line "why you'd want this" copy. */
  benefit: string;
  /** A prompt that demonstrates the server, offered after connecting. */
  starter_prompt: string;
  /** Plain-language statement of what connecting grants access to. */
  permission_disclosure: string;
  icon_url?: string;
  /** 1 = most popular. Absent sorts last. */
  popularity_rank?: number;

  auth_type: MCPCatalogAuthType;
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
 * server name the agent saw was the word "mcp" for 38 of 50 entries. One rule,
 * two formattings — never two rules.
 *
 * The publisher identifies the server only while every name is hand-reviewed.
 * `io.github.<user>/<repo>` inverts it — every server one GitHub user publishes
 * shares a publisher and differs only in the path — so a catalog that ever
 * admits names nobody vetted needs a disambiguating suffix rather than a
 * special case. `curated-loader.test.ts` holds the uniqueness invariant that
 * would otherwise notice too late.
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
 * A stated title wins. Otherwise the publisher stands in, because rendering
 * `name` would label the catalog with reverse-DNS strings.
 *
 * It cannot recover casing: `com.deepwiki` reads "Deepwiki", not "DeepWiki".
 * Stating `title` is the fix for that, not more derivation.
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
export type MCPCatalogSort = 'popularity' | 'name';

/**
 * What the Marketplace narrows the catalog by.
 *
 * These are exactly the toolbar's controls. The catalog is a few dozen frozen
 * objects the browser already holds, so applying them is a pass over an array,
 * not a request — which is why there is no `limit`/`offset` here: paging a list
 * you hold is a `slice`, and it is the grid's business rather than a filter's.
 */
export interface MCPCatalogFilters {
  /** Case-insensitive substring match over name, title, and description. */
  search?: string;
  category?: MCPCatalogCategory;
  /** Matches entries carrying this capability tag. */
  capability?: string;
  /**
   * Match any one of several auth types.
   *
   * "Not known to need an account" spans two values — stated open, and not
   * stated — and a single-value filter cannot say that, which is why the
   * toolbar's one auth control passes a set.
   */
  auth_types?: MCPCatalogAuthType[];
  sort?: MCPCatalogSort;
}

/**
 * Request body of `POST /mcp-catalog/connect`.
 *
 * A catalog key and where the session should live, and nothing else. URL,
 * transport, and auth come from the catalog entry server-side, so this cannot
 * be used to register an arbitrary server.
 */
export interface MCPCatalogConnectData {
  /** The entry's reverse-DNS catalog name. */
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
   * the disclosure in hand, and a stale one no longer matches the entry.
   *
   * It does not prove a human read the words. It proves the protocol ran.
   */
  acknowledged_disclosure: string;
}

/** What a successful connect hands back to the caller. */
export interface MCPCatalogConnectResult {
  mcp_server: MCPServer;
  session: Session;
  /** The entry's demonstration prompt, for the new session's composer. */
  starter_prompt?: string;
  /** True when an existing install was reused rather than a second row created. */
  reused_existing_server: boolean;
}
