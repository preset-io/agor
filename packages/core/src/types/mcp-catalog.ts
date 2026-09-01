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
import type { MCPOAuthCompatibilityMode, MCPOAuthDCRMode, MCPServer } from './mcp';
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
 * - `credentials` — a reviewed bearer credential is the catalog's supported
 *                   route. Normally the endpoint answers with a non-OAuth
 *                   challenge; a rare reviewed exception may also advertise
 *                   OAuth while accepting bearer tokens.
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

  /** Reviewed instructions for a non-OAuth credential. Generic 401/403 responses never imply a scheme. */
  credentials?: MCPCatalogEntryCredentials;

  /**
   * Per-server OAuth settings, for the endpoints discovery cannot fully
   * describe. See {@link MCPCatalogEntryOAuth}. Omitted by every entry that
   * does not need one, which is the intended state.
   */
  oauth?: MCPCatalogEntryOAuth;
}

export interface MCPCatalogEntryCredentials {
  /** The only marketplace credential scheme currently supported. */
  scheme: 'bearer';
  /** Vendor documentation for creating the bearer access token. */
  acquisition_url: string;
  /** Vendor-specific label, e.g. "personal access token". */
  label?: string;
  /**
   * The endpoint advertises OAuth, but the vendor also officially supports a
   * bearer token and its OAuth server cannot register an Agor client safely.
   * Connect still verifies the token with a pinned initialize request. This is
   * deliberately opt-in: an OAuth challenge never implies API-key support.
   */
  oauth_challenge_compatible?: true;
}

/**
 * The non-secret half of an OAuth client configuration, as an entry may state
 * it.
 *
 * Everything here is optional and nothing here is normally needed. A server
 * that implements the MCP authorization spec is set up entirely from what it
 * publishes: the `WWW-Authenticate` challenge names its protected-resource
 * metadata (RFC 9728), that names its authorization server, that publishes its
 * endpoints and registration endpoint (RFC 8414), and Dynamic Client
 * Registration (RFC 7591) mints the client. Connect declares none of that, and
 * entries should normally state nothing here, because a fact fetched from the
 * vendor at the moment of use cannot go stale and an authored one silently can
 * — and nothing sweeps this file for rot. A reviewed explicit `strict` opt-in
 * is useful when the production discovery boundary proves a provider supports
 * the complete strict contract.
 *
 * So this is an escape hatch for the servers that fall short of that, not a
 * place to restate what discovery already returns. Each field is here because
 * it reaches something at runtime that no request can otherwise supply:
 *
 * - `scope` becomes the `scope` parameter of the authorization request and of
 *   the DCR registration. Discovery covers it only when the resource metadata
 *   publishes `scopes_supported` *and* the client is being registered
 *   dynamically; a server that publishes neither grants a default scope that
 *   may be empty, and the flow completes with a token that can do nothing.
 * - `client_id` becomes the `client_id` of the authorization request, for a
 *   server that pre-registers one public client for MCP clients instead of
 *   running DCR. It is public by construction — RFC 6749 §2.2, and it travels
 *   in the browser's address bar during the flow.
 * - `dcr_mode` decides whether registration may fall back to an unadvertised
 *   `/register`, for a server that runs DCR without publishing the endpoint.
 * - `compatibility_mode` is an explicit `strict` or `legacy` opt-in. Omission
 *   uses the daemon's marketplace-only interoperability profile: standard and
 *   OIDC discovery fallbacks with same-origin resource binding, issuer
 *   validation, and PKCE S256 retained.
 *
 * What is deliberately absent is as load-bearing as what is here:
 *
 * - **No client secret.** `curated.yaml` is checked into a public repository
 *   and is byte-identical for every tenant, so a secret in it is a published
 *   secret shared by everyone. A server that cannot work without a confidential
 *   client cannot be a catalog entry.
 * - **No `authorization_url` / `token_url`.** These are where an authorization
 *   code and a client credential are sent, so a stale one does not fail closed
 *   — it delivers a live grant to whatever now answers at that hostname. They
 *   are also the two facts discovery is most reliable about, and the runtime
 *   requires them as a set with `client_id` anyway. Declaring them would take
 *   the one part of the flow that must not drift and make it the part this file
 *   is responsible for keeping current.
 *
 * None of this is user-specific: an entry is the same for every installer, and
 * the credential each installer obtains is per-user and lives outside the
 * server row entirely.
 */
export interface MCPCatalogEntryOAuth {
  /** Space-separated OAuth scopes to request. */
  scope?: string;
  /** A pre-registered *public* client id. Never a confidential one. */
  client_id?: string;
  /** Dynamic Client Registration policy; defaults to `advertised`. */
  dcr_mode?: MCPOAuthDCRMode;
  /** Explicit authorization-metadata policy; omission uses marketplace interoperability. */
  compatibility_mode?: MCPOAuthCompatibilityMode;
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
 * server name the agent saw was often the word "mcp". One rule, two
 * formattings — never two rules.
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
 * These are exactly the toolbar's controls. The catalog is a bounded set of
 * frozen objects the browser already holds, so applying them is a pass over an
 * array, not a request — which is why there is no `limit`/`offset` here: paging
 * a list you hold is a `slice`, and it is the grid's business rather than a
 * filter's.
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
 * A catalog key, where the session should live, and — for an endpoint that asks
 * for one — the caller's own API key. Nothing else. URL, transport, and the
 * *kind* of auth still come from the catalog entry and the live endpoint
 * server-side, so this cannot be used to register an arbitrary server, and a
 * client cannot name the destination its own credential is sent to.
 */
export interface MCPCatalogConnectData {
  /** The entry's reverse-DNS catalog name. */
  catalog_key: string;
  branch_id: string;
  agentic_tool: AgenticToolName;
  /**
   * An API key for an endpoint that answers unauthenticated clients with a
   * non-OAuth challenge.
   *
   * The one secret this request carries, and the only field on it that is the
   * caller's rather than the catalog's — precisely because it is the one thing
   * a checked-in, publicly readable, every-tenant-identical file must never
   * hold. It is stored as `auth.token` on the installed server row, which is
   * where every other bearer credential in Agor lives and therefore what the
   * read-path redaction already covers.
   *
   * Required when the endpoint asks for credentials, refused when it does not:
   * a key sent to a server that never asked for one would be a secret written
   * to a row with no reason to carry it.
   */
  bearer_token?: string;
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
  /** Why this server row was selected. Credential peers retain their own lifecycle. */
  reuse_kind:
    | 'new_catalog_install'
    | 'catalog_install'
    | 'credential_peer'
    | 'refreshed_credential_peer';
  /** Effective, secret-free OAuth compatibility policy for the attached row. */
  effective_oauth_policy?: NonNullable<MCPServer['oauth_compatibility_policy']>;
}

/**
 * Cheap, advisory answer for the Marketplace drawer before Connect is pressed.
 *
 * Readiness never probes a vendor, refreshes a grant, creates a row, or starts
 * a Session. It describes only durable local state plus the checked-in catalog
 * claim. `mcp-catalog/connect` remains authoritative and repeats every relevant
 * check at the write boundary.
 */
export const MCP_CATALOG_READINESS_STATES = [
  'no_auth',
  'bearer_required',
  'oauth_required',
  'installed_ready',
  'reusable_oauth',
] as const;

export type MCPCatalogReadinessState = (typeof MCP_CATALOG_READINESS_STATES)[number];

export interface MCPCatalogReadiness {
  /** Echo of the catalog identity that was evaluated. */
  catalog_key: string;
  state: MCPCatalogReadinessState;
}

/**
 * What the live endpoint turned out to want, on a connect refused over the API
 * key.
 *
 * The catalog file is presentational and the endpoint decides — which is the
 * right layering, and is exactly what strands a client that built its form from
 * the file. A drawer showing a key field because the entry says `credentials`
 * cannot submit when the endpoint has since opened up, because the daemon
 * refuses every keyed request; a drawer showing no field because the entry says
 * `none` cannot submit when the endpoint has since closed, because the daemon
 * demands a key there is nowhere to type. Both are dead ends, and both are
 * reachable from a `curated.yaml` nobody has got round to correcting.
 *
 * `logProbeDisagreement` already records the disagreement, but a `warn` line is
 * addressed to whoever maintains the file. This is the same fact addressed to
 * the person standing in front of the form, in a shape a client can act on
 * without parsing prose: the daemon knows what the endpoint asked for at the
 * moment it refuses, so it says so, and the refusal becomes one extra round trip
 * instead of an impasse.
 *
 * Two values rather than a boolean, because "no requirement was in question"
 * has to stay distinguishable from both — every other refusal carries none of
 * this, and a client must not read a missing field as `not_accepted`.
 */
export const MCP_CATALOG_CREDENTIAL_REQUIREMENTS = [
  'required',
  'not_accepted',
  'oauth',
  'unsupported',
] as const;

export type MCPCatalogCredentialRequirement = (typeof MCP_CATALOG_CREDENTIAL_REQUIREMENTS)[number];

/** The machine-readable half of a connect refusal. Rides on `error.data`. */
export interface MCPCatalogConnectErrorData {
  credential_requirement: MCPCatalogCredentialRequirement;
}

/**
 * The endpoint's key requirement carried by a failed connect, if it stated one.
 *
 * Lives beside the type it reads rather than in the browser bundle, so the
 * daemon that writes this field and the drawer that reacts to it are looking at
 * one definition. The alternative — a client-side `err.data.credential_requirement`
 * spelled out at the call site — is a string literal that no longer matches the
 * moment anybody renames the field, and it fails by silently doing nothing,
 * which is indistinguishable from the endpoint not having stated a requirement.
 *
 * Defensive about its input because it is handed whatever a `catch` caught:
 * a Feathers error, a `TypeError` from a dropped socket, or a string.
 */
export function readCredentialRequirement(
  error: unknown
): MCPCatalogCredentialRequirement | undefined {
  const data = (error as { data?: unknown } | null | undefined)?.data;
  const requirement = (data as MCPCatalogConnectErrorData | undefined)?.credential_requirement;
  return MCP_CATALOG_CREDENTIAL_REQUIREMENTS.includes(
    requirement as MCPCatalogCredentialRequirement
  )
    ? (requirement as MCPCatalogCredentialRequirement)
    : undefined;
}
