/**
 * Marketplace connect: install one catalog entry and hand back a session that
 * can use it.
 *
 * The request names a catalog entry and where the session should live, and
 * nothing else. URL, transport, and auth are read from the catalog entry —
 * accepting them from the client would make this a way to register any server
 * at all without passing the `mcp_member_policy` gate that guards
 * `POST /mcp-servers`.
 *
 * It also does not re-implement that gate. The server row is created through
 * the `mcp-servers` service and the session through `sessions`, with the
 * caller's own params, so policy, ownership stamping, the remote-transport
 * restriction, branch permissions, and execution identity all resolve exactly once,
 * in the places that already own them.
 *
 * Scope: remote transport. An endpoint that accepts an unauthenticated client
 * is installed ready to use; one that answers with an OAuth challenge is
 * installed configured-but-unauthenticated, for the user to complete through
 * the OAuth flow that already exists in Settings → MCP Servers. An endpoint
 * wanting an API key still needs a credential model that does not exist.
 */

import { BadRequest, NotFound } from '@agor/core/feathers';
import { probeRemoteAuthType } from '@agor/core/mcp-catalog';
import type {
  AuthenticatedParams,
  CreateMCPServerInput,
  MCPAuth,
  MCPCatalogConnectData,
  MCPCatalogConnectResult,
  MCPCatalogEntry,
  MCPCatalogProbedAuthType,
  MCPServer,
  MCPTransport,
  Session,
  UserID,
} from '@agor/core/types';
import { catalogDisplayName, catalogServerSlug } from '@agor/core/types';

/** Catalog transports, as `mcp_servers` names them. */
function toServerTransport(entry: MCPCatalogEntry): MCPTransport {
  return entry.transport === 'sse' ? 'sse' : 'http';
}

/**
 * Whether two endpoint URLs name the same place.
 *
 * Normalised through `URL` so a trailing slash, a default port, or a
 * differently-cased host does not read as a different server and cost somebody
 * their install. Anything unparseable falls back to an exact comparison rather
 * than guessing.
 */
function sameEndpoint(a: string | undefined, b: string): boolean {
  if (!a) return false;
  const normalize = (value: string): string => {
    try {
      const url = new URL(value.trim());
      url.pathname = url.pathname.replace(/\/+$/, '');
      return url.href;
    } catch {
      return value.trim();
    }
  };
  return normalize(a) === normalize(b);
}

/**
 * Auth fields a read of an `mcp_servers` row can carry without anyone having
 * configured them.
 *
 * The OAuth flow never writes to the server row: an access token, its refresh
 * token, and its expiry belong to one user and live in `user_mcp_oauth_tokens`,
 * keyed by `(user_id, mcp_server_id)`. But `mcp-servers` has a read hook that
 * hydrates the caller's own token onto the payload it returns, and
 * {@link MCPCatalogConnectService} finds existing installs through that service
 * — so these three arrive on exactly the rows that reuse is most important for,
 * the ones the caller already authenticated. Comparing them would make every
 * successful authentication look like drift and mint a second row beside the
 * working one.
 */
const RUNTIME_HYDRATED_AUTH_FIELDS = [
  'oauth_access_token',
  'oauth_refresh_token',
  'oauth_token_expires_at',
] as const satisfies readonly (keyof MCPAuth)[];

/**
 * Whether `auth` is the configuration `prescribed` describes, ignoring what the
 * read hook hydrated.
 *
 * Compared by difference rather than field by field: every key on the row that
 * is not runtime-hydrated must appear in the prescription with the same value,
 * and vice versa. A named-fields comparison would silently stop covering any
 * field later added to {@link MCPAuth} — and the fields most worth adding to an
 * auth block are the ones that route a credential. This way an unrecognised key
 * on the row is a mismatch, so a new field is excluded from reuse until someone
 * decides otherwise, rather than being waved through by omission.
 */
function isPrescribedAuth(auth: MCPAuth | undefined, prescribed: MCPAuth): boolean {
  const significant = (value: MCPAuth | undefined): Record<string, unknown> => {
    const entries = Object.entries(value ?? { type: 'none' }).filter(
      ([key, field]) =>
        field !== undefined && !(RUNTIME_HYDRATED_AUTH_FIELDS as readonly string[]).includes(key)
    );
    return Object.fromEntries(entries.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
  };
  return JSON.stringify(significant(auth)) === JSON.stringify(significant(prescribed));
}

/**
 * Whether `server` still carries the configuration the catalog described.
 *
 * The stamp records where a row came from; this asks whether it is still that.
 * The two come apart because a member may edit their own server — which is
 * theirs to do — so a stamp on its own would let an edited row stand in for
 * the catalog's, and reuse would hand the next caller something the catalog
 * never described. A stamp nobody but the install path can write (see
 * `authorizeMcpServerWrite`) closes the forged half; this closes the half
 * where a legitimately stamped row is changed afterwards.
 *
 * What is compared is everything that decides where the session's traffic goes
 * and what it carries: the endpoint, and the credential routing. `prescribed`
 * is the auth block this same connect just derived from the entry and the
 * probe, so the comparison is against what installing right now would produce
 * rather than against a fixed shape — which is what lets an OAuth entry be
 * reused at all, and what makes a row whose owner has since pointed
 * `oauth_token_url` at their own host fail to match. That field, and
 * `oauth_authorization_url` and `oauth_client_secret` with it, are ones connect
 * never sets, so on a catalog row their mere presence is the drift: they are
 * where an authorization code and a client credential get sent.
 *
 * It also means an entry whose endpoint has changed sides — installed while it
 * was open, now answering with an OAuth challenge — does not match its old
 * unauthenticated row, and the caller gets one configured the way the endpoint
 * now answers instead of a row that can no longer work.
 *
 * Custom headers are refused wholesale rather than screened for the
 * dangerous-looking ones. Agor redacts every custom header value on read and
 * documents them as secret-bearing; the only names it classifies are the
 * reserved ones it refuses to store at all. There is no notion of a harmless
 * header anywhere in the codebase, and reuse is the wrong place to invent one
 * — a rule that has to guess which headers carry secrets is a rule that will
 * eventually guess wrong.
 *
 * Genuinely cosmetic fields stay the owner's: name, labels, description, and
 * scope. A second row for a benign edit would be its own bug.
 */
function isInstallOf(
  server: MCPServer,
  entry: MCPCatalogEntry & { remote_url: string },
  prescribed: MCPAuth
): boolean {
  return (
    server.catalog_entry_name === entry.name &&
    server.transport === toServerTransport(entry) &&
    sameEndpoint(server.url, entry.remote_url) &&
    isPrescribedAuth(server.auth, prescribed) &&
    Object.keys(server.headers ?? {}).length === 0
  );
}

function assertConnectableEntry(entry: MCPCatalogEntry): asserts entry is MCPCatalogEntry & {
  remote_url: string;
} {
  // `has_remote` is derived from `remote_url`, so testing the URL tests both —
  // and is also what narrows the type.
  if (!entry.remote_url || entry.transport === 'stdio') {
    throw new BadRequest(
      `${catalogDisplayName(entry)} has no remote endpoint; locally-run MCP servers are configured by an admin`
    );
  }
}

/**
 * Refuse a connect whose caller did not carry the entry's own access
 * disclosure back with it.
 *
 * The disclosure states what the agent will be able to reach once the server is
 * attached, and it is the last thing shown before that happens. Leaving the
 * rule in the drawer would leave the endpoint open to any client that skipped
 * the drawer — the marketplace's own UI is not the only caller a Feathers
 * service has. Comparing the text, rather than accepting a boolean, also means
 * a client holding a disclosure the curator has since rewritten is told to
 * re-read it instead of connecting against the old one.
 */
function assertDisclosureAcknowledged(entry: MCPCatalogEntry, acknowledged: unknown): void {
  const stored = entry.permission_disclosure.trim();
  const shown = typeof acknowledged === 'string' ? acknowledged.trim() : '';
  if (!shown) {
    throw new BadRequest(
      `acknowledged_disclosure is required: connecting ${catalogDisplayName(entry)} must follow showing what it can access`
    );
  }
  if (shown !== stored) {
    throw new BadRequest(
      `The access disclosure for ${catalogDisplayName(entry)} has changed since it was shown; review it again before connecting`
    );
  }
}

/**
 * Record an endpoint that answered differently from what its entry states.
 *
 * `auth_type` is authored text about somebody else's server, and connecting is
 * the only moment anything compares it against that server. Without this the
 * claim is unfalsifiable: nothing in the running system can ever contradict it,
 * so an entry that was right when it was written stays "right" long after the
 * vendor changed the endpoint. The disagreement is a curation defect whose fix
 * is an edit to `curated.yaml`, so it is a warning and the connect carries on
 * to whatever the endpoint actually said.
 *
 * Only a verdict about credentials counts. `unreachable` and `unknown` mean the
 * endpoint disclosed nothing about authentication, and reporting those as a
 * wrong entry would fill the log with claims about hosts nothing was learned
 * from.
 */
function logProbeDisagreement(entry: MCPCatalogEntry, probed: MCPCatalogProbedAuthType): void {
  if (entry.auth_type === 'unknown' || probed === entry.auth_type) return;
  if (probed !== 'none' && probed !== 'oauth' && probed !== 'credentials') return;
  console.warn(
    '[mcp-catalog/connect] Catalog auth_type disagrees with the endpoint ' +
      `entry=${entry.name} stated=${entry.auth_type} probed=${probed}`
  );
}

/**
 * The auth block to install an OAuth-challenging entry with.
 *
 * Deliberately close to empty. A server implementing the MCP authorization spec
 * describes its own flow at the moment the flow runs — the `WWW-Authenticate`
 * challenge names its protected-resource metadata, that names its authorization
 * server, that publishes its endpoints and its registration endpoint, and
 * Dynamic Client Registration mints a client — so `oauth-start` needs nothing
 * from the row beyond `url`, `enabled`, and `auth.type === 'oauth'`. Anything
 * more stated here would be a copy of something the vendor will hand over
 * anyway, kept current by nobody.
 *
 * The two things it does state are the two the endpoint cannot supply:
 *
 * `oauth_mode` is fixed at `per_user`, not taken from the entry. Every
 * installer authenticates as themselves and gets a grant keyed to their own
 * user; `shared` would make one person's consent into everybody's access to
 * their account, which is a product decision nobody has made. Fixing it in code
 * rather than defaulting it means no catalog edit can turn it into `shared`
 * either.
 *
 * The rest is {@link MCPCatalogEntryOAuth} — the non-secret settings an entry
 * may state for a server that falls short of the spec. `curated.yaml` states
 * none of them today; each is spread only when present, so an entry that says
 * nothing produces the two-key block above and not a row full of `undefined`
 * that would then have to be compared around.
 */
function catalogOAuthConfig(entry: MCPCatalogEntry): MCPAuth {
  const stated = entry.oauth;
  return {
    type: 'oauth',
    oauth_mode: 'per_user',
    ...(stated?.scope ? { oauth_scope: stated.scope } : {}),
    ...(stated?.client_id ? { oauth_client_id: stated.client_id } : {}),
    ...(stated?.dcr_mode ? { oauth_dcr_mode: stated.dcr_mode } : {}),
    ...(stated?.compatibility_mode ? { oauth_compatibility_mode: stated.compatibility_mode } : {}),
  };
}

/**
 * Decide how the entry's endpoint wants to be talked to, and produce the auth
 * block to install it with — or refuse.
 *
 * Every connectable entry is probed, whatever it states. `auth_type` is a claim
 * about a third party's endpoint recorded when the file was last edited, and a
 * vendor can put a server behind an account, or take it out from behind one, at
 * any time. Believing the claim in either direction goes wrong, and one of the
 * two directions goes wrong silently and forever: a stale `none` produces an
 * install that fails on first use, which the user reports, while a stale
 * `oauth` produces a refusal nothing can contradict. So the file decides what
 * the marketplace renders, the endpoint decides what gets installed, and
 * {@link logProbeDisagreement} is what keeps the two from drifting apart
 * unnoticed.
 *
 * The three outcomes are three different questions, and only the last is a
 * dead end:
 *
 * - **A handshake completed.** Nothing is needed; install it open.
 * - **An OAuth challenge.** Authentication Agor can set up. The row is created
 *   configured for OAuth and holding no token, which is a state the product
 *   already has a name and a button for — the user signs in from the same place
 *   as any other OAuth server. Connect is not the flow and does not start it;
 *   it produces the row the flow completes.
 * - **A non-OAuth 401/403.** An API key, which nothing can obtain on the user's
 *   behalf and which there is nowhere safe to put — the catalog is public and
 *   shared, and connect takes no input beyond a catalog key. Still refused, and
 *   the message says which of the two kinds of authentication it is so it does
 *   not read as the OAuth case being broken.
 * - **Nothing identifiable answered.** Refused, unchanged.
 */
async function resolveAuthRequirement(
  entry: MCPCatalogEntry & { remote_url: string }
): Promise<MCPAuth> {
  const probed = await probeRemoteAuthType(entry.remote_url);
  logProbeDisagreement(entry, probed);

  if (probed === 'none') return { type: 'none' };
  if (probed === 'oauth') return catalogOAuthConfig(entry);
  if (probed === 'credentials') {
    throw new BadRequest(
      `${catalogDisplayName(entry)} needs an API key, which cannot be set up from the marketplace yet`
    );
  }

  throw new BadRequest(
    `${catalogDisplayName(entry)} could not be reached, so it cannot be connected`
  );
}

export interface MCPCatalogConnectService {
  create(
    data: MCPCatalogConnectData,
    params: AuthenticatedParams
  ): Promise<MCPCatalogConnectResult>;
}

export function createMCPCatalogConnectService(
  // biome-ignore lint/suspicious/noExplicitAny: Feathers app type is complex and varies
  app: any
): MCPCatalogConnectService {
  const service = (path: string) => app.service(path);

  /**
   * An install of this entry the caller can already use, if there is one.
   *
   * Matched on the catalog name. Both sides carry it verbatim, and it is what
   * the entry is unique on, so there is no second normalisation to keep in
   * step and an install survives every edit to the entry except a rename.
   *
   * The name alone does not settle it, though: see {@link isInstallOf}. A row
   * that no longer carries the entry's configuration is passed over rather
   * than handed back, so a caller who has one of those and a real install gets
   * the real one.
   *
   * A disabled row is passed over too, which is a different question with the
   * same answer. Reusing one would attach a server the session resolves away
   * (`enabledOnly`), reporting success while handing back an agent that never
   * sees it; re-enabling it would let a connect flip a decision somebody else
   * made deliberately about a possibly-shared row. Creating a fresh one grants
   * nothing the caller's `mcp_member_policy` did not already grant, and leaves
   * the disabled row exactly as its owner left it.
   */
  const findExistingInstall = async (
    entry: MCPCatalogEntry & { remote_url: string },
    prescribed: MCPAuth,
    userId: UserID | undefined,
    params: AuthenticatedParams
  ): Promise<MCPServer | undefined> => {
    const result = await service('mcp-servers').find({
      ...params,
      provider: undefined,
      query: { ...(userId ? { usableByUserId: userId } : {}), $limit: 1000 },
    });
    const servers = (Array.isArray(result) ? result : result.data) as MCPServer[];
    return servers.find((server) => server.enabled && isInstallOf(server, entry, prescribed));
  };

  return {
    async create(data, params) {
      if (!data?.catalog_key) throw new BadRequest('catalog_key is required');
      if (!data.branch_id) throw new BadRequest('branch_id is required');
      if (!data.agentic_tool) throw new BadRequest('agentic_tool is required');

      let entry: MCPCatalogEntry;
      try {
        entry = (await service('mcp-catalog').get(data.catalog_key, {
          ...params,
          query: {},
        })) as MCPCatalogEntry;
      } catch {
        throw new NotFound(`MCP catalog entry not found: ${data.catalog_key}`);
      }

      assertConnectableEntry(entry);
      assertDisclosureAcknowledged(entry, data.acknowledged_disclosure);
      // Derived from the entry and the live endpoint, never from `data`: the
      // request names a catalog key and nothing else, so there is no input a
      // caller could supply that reaches a URL or a credential endpoint here.
      const auth = await resolveAuthRequirement(entry);

      const userId = params.user?.user_id as UserID | undefined;
      const existing = await findExistingInstall(entry, auth, userId, params);

      const createInput: CreateMCPServerInput = {
        name: catalogServerSlug(entry.name),
        display_name: catalogDisplayName(entry),
        description: entry.benefit ?? entry.description,
        transport: toServerTransport(entry),
        url: entry.remote_url,
        auth,
        // Session scope: an install is for the session it launched, not
        // silently for every session its owner will ever start.
        scope: 'session',
        // Not `user`: nobody typed this configuration. It came from the
        // catalog, and `catalog_entry_name` below records which entry — the
        // same pairing `imported` has with `import_path`.
        source: 'catalog',
      };

      // Provenance is named on params rather than in the payload: the write
      // authorizer refuses a stamp that arrived from a request, so this is the
      // one path that can produce one. Saying so is also what makes the row
      // private to the caller — an install is theirs whatever the tenant's
      // `mcp_member_policy` says. See `McpCatalogInstallParams`.
      const mcpServer =
        existing ??
        ((await service('mcp-servers').create(createInput, {
          ...params,
          mcpCatalogInstall: { entry_name: entry.name },
        })) as MCPServer);

      // Three writes across three services, so there is no transaction to lean
      // on. A server nobody can see is the worst thing to leave behind — it is
      // configuration the user never asked to keep and cannot find to remove —
      // so a failure after this point takes back the row this request created.
      // A reused install is somebody's existing state and is left alone.
      try {
        const session = (await service('sessions').create(
          {
            branch_id: data.branch_id,
            agentic_tool: data.agentic_tool,
            status: 'idle',
            title: catalogDisplayName(entry),
          },
          params
        )) as Session;

        await service('/sessions/:id/mcp-servers').create(
          { mcpServerId: mcpServer.mcp_server_id },
          { ...params, route: { id: session.session_id } }
        );

        return {
          mcp_server: mcpServer,
          session,
          starter_prompt: entry.starter_prompt,
          reused_existing_server: Boolean(existing),
        };
      } catch (error) {
        if (!existing) {
          try {
            await service('mcp-servers').remove(mcpServer.mcp_server_id, {
              ...params,
              provider: undefined,
            });
          } catch (cleanupError) {
            console.warn(
              `[mcp-catalog/connect] Left ${mcpServer.mcp_server_id} behind after a failed connect:`,
              cleanupError instanceof Error ? cleanupError.message : cleanupError
            );
          }
        }
        throw error;
      }
    },
  };
}
