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
  MCPServerID,
  Session,
  UserID,
} from '@agor/core/types';
import { catalogDisplayName, catalogServerSlug } from '@agor/core/types';
import {
  catalogOAuthConfig,
  catalogServerTransport,
  isCurrentCatalogInstall,
  sameCatalogEndpoint,
} from './mcp-catalog-install-policy.js';

/**
 * Auth fields that decide where an authorization code or a client credential is
 * sent, and which connect itself never sets.
 *
 * A row carrying any of them is describing a flow the catalog did not: the
 * grant behind it was minted through somebody's own host. That is a legitimate
 * thing for a member to configure and use, and reusing it would expose nothing
 * the owner does not already hold — but it would quietly make a marketplace
 * install route somewhere the entry never named, which is a different promise
 * from the one the disclosure made. Cheaper to decline than to explain.
 */
const CREDENTIAL_ROUTING_OVERRIDES = [
  'oauth_authorization_url',
  'oauth_token_url',
  'oauth_client_secret',
] as const satisfies readonly (keyof MCPAuth)[];

/**
 * The cheap half of the identity test: whether `server` is configured to talk
 * to the place this entry names, on terms this entry would ask for.
 *
 * This is deliberately *not* the whole answer, and the comment that once said
 * it was described a check that did not exist. What an access token is scoped
 * to is a protected resource — the `resource` of RFC 9728 — not a vendor, and
 * certainly not a catalog `name`, which is a label this repository chose and
 * which no OAuth provider has ever seen. Comparing the row's configuration
 * cannot establish that; only the grant can, and the grant is read separately
 * in {@link findReusableCredential} via {@link MCPCatalogConnectDeps}.
 *
 * What this half does establish is where the credential would be *sent*, which
 * is the boundary that decides who ends up holding it. Reuse pins the row's
 * endpoint to the entry's endpoint, and refuses any row overriding the
 * authorization or token endpoint, so an access token reused here can only ever
 * travel to `entry.remote_url` and a refresh can only ever go to the token
 * endpoint recorded when the grant was minted. Neither can be redirected to a
 * party the user did not already consent to.
 *
 * `per_user` is required, not defaulted-into: a `shared` row's grant is keyed
 * `(NULL, server)` and provisioned by an admin for everyone, so hydrating it
 * here would let a member ride somebody else's consent into a new install.
 * Whether the marketplace should ever install onto a shared grant is an open
 * product question; until it is answered the safe reading is that it does not.
 *
 * Scope is compared as *requested* scope, which is the honest best available:
 * nothing records what the provider actually granted (`user_mcp_oauth_tokens`
 * has no scope column, and a provider may downscope silently), so the closest
 * true statement is "this grant was asked for on the same terms this entry
 * asks". Where they differ, reuse would hand over a token that fails at
 * tool-call time with an error naming neither cause, so it declines and the
 * user consents afresh. Today every entry states no scope and this compares
 * `undefined` to `undefined`; it starts mattering the moment one does.
 */
function isCredentialPeerOf(
  server: MCPServer,
  entry: MCPCatalogEntry & { remote_url: string },
  prescribed: MCPAuth
): boolean {
  const auth = server.auth;
  if (auth?.type !== 'oauth' || prescribed.type !== 'oauth') return false;
  if ((auth.oauth_mode ?? 'per_user') !== 'per_user') return false;
  if (CREDENTIAL_ROUTING_OVERRIDES.some((field) => auth[field])) return false;
  if ((auth.oauth_scope ?? undefined) !== (prescribed.oauth_scope ?? undefined)) return false;
  return (
    server.transport === catalogServerTransport(entry) &&
    sameCatalogEndpoint(server.url, entry.remote_url) &&
    Object.keys(server.headers ?? {}).length === 0
  );
}

/**
 * Whether the caller holds a grant on this row that is usable right now.
 *
 * Read off the row rather than out of `user_mcp_oauth_tokens`, and that is the
 * load-bearing decision in this file. `mcp-servers` find runs
 * `injectPerUserOAuthTokens`, which looks up `getToken(callerId, serverId)`,
 * rejects a grant whose binding no longer matches the row, rejects one mid
 * refresh, rejects an expired one, and only then writes the token onto the
 * payload. Every question reuse needs answered is one that hook has already
 * answered, correctly, for this exact caller.
 *
 * Re-deriving the answer here would mean a second copy of that rule, free to
 * drift from the first — and the direction it would drift is the expensive one,
 * because a reuse rule that is looser than the hydration rule hands back a row
 * the request path will then refuse to put a token on. So the invariant is:
 * **reuse is admitted exactly where the read path would hydrate.** Never
 * looser, so reuse cannot reach a credential a plain `GET /mcp-servers` could
 * not. Never tighter, so it does not silently stop firing.
 *
 * It also settles "whose credential" without a comparison to get wrong. The
 * hook keys the lookup on the authenticated caller, so another user's grant is
 * not rejected here — it is never fetched. There is no branch to reach it by.
 *
 * The token itself is a redaction sentinel by the time it arrives, which is
 * why only its presence is read. Expiry is not redacted and is compared with
 * `<=`, matching the daemon's own boundary and the UI's `mcpServerNeedsAuth`,
 * so all three agree on the millisecond.
 *
 * **This verdict is weaker on SQLite than on PostgreSQL, and cannot currently
 * be otherwise.** The hook re-checks `grant_binding_fingerprint` only under
 * `isPostgresDatabaseHandle`, which reads like an oversight and is not:
 * bindings are minted from a pending-flow *durable record*, that authority
 * exists only on PostgreSQL, and `persistOAuthToken` therefore passes
 * `grantBinding` only when one is present. A SQLite grant has no fingerprint to
 * check — requiring one would not harden standalone Agor, it would switch reuse
 * off there entirely.
 *
 * So on PostgreSQL a grant is additionally proven to have been minted against
 * this row's current URL and auth block, and on SQLite it is not: a row whose
 * URL was edited after consent would be reused there. What narrows that gap on
 * both dialects is the resource comparison in {@link findReusableCredential},
 * which reads what the endpoint declared itself to be at consent time and is
 * recorded on every grant regardless of dialect. It is unauthenticated on
 * SQLite — but forging it needs database write access, which on a standalone
 * deployment is already game over.
 */
function hasLiveCallerGrant(server: MCPServer, now: number): boolean {
  const auth = server.auth;
  if (!auth?.oauth_access_token) return false;
  const expiresAt = auth.oauth_token_expires_at;
  return !(expiresAt && expiresAt <= now);
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
 * may state after the production discovery boundary is reviewed. Each is
 * spread only when present, so an entry that says nothing produces the two-key
 * block above and not a row full of `undefined` that would then have to be
 * compared around.
 */
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

/**
 * The one thing connect cannot answer through a service call.
 *
 * Credential reuse has to know which protected resource a grant was actually
 * minted for, and that is a column on `user_mcp_oauth_tokens`
 * (`oauth_resource_uri`) which no read path puts on an `mcp_servers` payload —
 * the hydrate hook copies the token and its expiry and nothing else. Rather
 * than give this service a database handle and a tenant scope of its own, the
 * daemon injects the one read, so everything else here stays service calls.
 *
 * Required rather than optional, though only credential reuse reads it. An
 * optional version was written first and had exactly the failure mode this
 * whole change exists to fix: a caller that constructed the service without it
 * silently lost reuse, with nothing to notice. The compiler is a better place
 * to catch that than a bug report about consenting twice.
 */
export interface MCPCatalogConnectDeps {
  /**
   * The protected resource the *calling user's own* grant on `serverId` was
   * minted for, or undefined when they hold no grant or it records none.
   *
   * Per-user by construction: implementations key on `params.user`, never on a
   * shared grant, so there is no argument here by which one user could name
   * another's credential.
   */
  readGrantResourceUri(
    serverId: MCPServerID,
    params: AuthenticatedParams
  ): Promise<string | undefined>;
}

/**
 * How many stale grants one connect may try to revive.
 *
 * Each attempt is a token request to a third party, and the candidate list is
 * every server the caller can use, so an uncapped loop turns one click into a
 * fan-out. Three is enough for the real shape of the problem — a couple of rows
 * left over from earlier experiments at the same endpoint — and a connect that
 * hits the cap says so rather than reporting "nothing to reuse".
 */
const MAX_REVIVAL_ATTEMPTS = 3;

export function createMCPCatalogConnectService(
  // biome-ignore lint/suspicious/noExplicitAny: Feathers app type is complex and varies
  app: any,
  deps: MCPCatalogConnectDeps
): MCPCatalogConnectService {
  const service = (path: string) => app.service(path);

  /**
   * An install of this entry the caller can already use, if there is one.
   *
   * Matched on the catalog name. Both sides carry it verbatim, and it is what
   * the entry is unique on, so there is no second normalisation to keep in
   * step and an install survives every edit to the entry except a rename.
   *
   * The name alone does not settle it, though: see
   * {@link isCurrentCatalogInstall}. A row
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
    const install = servers.find(
      (server) =>
        server.enabled &&
        isCurrentCatalogInstall(server, entry, prescribed, {
          reconcileMissingCompatibilityMode: true,
        })
    );
    return install ?? (await findReusableCredential(entry, prescribed, servers, params));
  };

  /**
   * A row the caller has already authenticated for this entry's resource, if
   * there is one — the answer to "I signed into this vendor last week, why am I
   * signing in again".
   *
   * Runs only when {@link findExistingInstall} found no install of the entry
   * itself, so nothing above this changes. Where that predicate asks "is this
   * row still what the catalog described", this one asks the different and
   * looser question "is this row somewhere my existing credential already
   * works" — looser because it must match a row nobody installed from this
   * entry, or from any entry, which is exactly the case the requirement is
   * about. `catalog_entry_name` is therefore not compared, on purpose: a
   * hand-configured row in Settings holds a perfectly good Linear grant, and
   * refusing to see it is how the user ends up consenting twice.
   *
   * Nothing is copied. The grant stays on its own row under its own
   * `(user_id, mcp_server_id)` key, and reuse means the session is pointed at
   * that row instead of at a second one. That is why this cannot widen access:
   * the row was already in the caller's `usableByUserId` set, already readable
   * with their token hydrated onto it, and already attachable by hand to any
   * session they create. Reuse removes clicks, not restrictions.
   *
   * A candidate whose grant has expired is offered a refresh before being given
   * up on, because an access token that outlives the hour is the exception and
   * reuse that only fired inside one would be a feature nobody ever sees. The
   * refresh goes through `/mcp-servers/oauth-refresh` rather than
   * `refreshAndPersistToken` directly: that endpoint already keys per-user
   * grants to the authenticated caller, already refuses a shared grant to a
   * non-admin, already drops a grant whose binding stopped matching, and
   * already turns the vendor's `invalid_grant` into `needs_reauth`. Reaching
   * past it to the primitive would mean restating all four.
   *
   * That same call is what makes revocation partly answerable. A vendor that
   * revoked the grant fails the refresh, and this moves on — the broken install
   * never happens. It is not a general revocation check: a still-unexpired
   * token revoked out of band is not detectable without spending an
   * authenticated request on every connect, and it is not detected today for
   * any already-installed server either. That case reuses, fails on first tool
   * call, and recovers through the re-auth banner that already exists.
   *
   * Candidates are tried in id order until one yields a usable credential, not
   * abandoned after the first. One row holding a dead grant with no refresh
   * token sitting in front of another that would have refreshed cleanly is an
   * ordinary way for a workspace to end up, and giving up there would send the
   * user through consent while a working credential sat one row further down.
   * Deterministic order keeps two identical connects from disagreeing.
   */
  const findReusableCredential = async (
    entry: MCPCatalogEntry & { remote_url: string },
    prescribed: MCPAuth,
    servers: MCPServer[],
    params: AuthenticatedParams
  ): Promise<MCPServer | undefined> => {
    if (prescribed.type !== 'oauth') return undefined;

    const candidates = servers
      .filter((server) => server.enabled && isCredentialPeerOf(server, entry, prescribed))
      .sort((a, b) => (a.mcp_server_id < b.mcp_server_id ? -1 : 1));

    /**
     * Whether the caller's grant on this row was minted for the resource this
     * entry names.
     *
     * The half {@link isCredentialPeerOf} cannot answer. `oauth_resource_uri`
     * is what the endpoint declared itself to be when consent happened, so
     * comparing it to the entry's endpoint catches a row whose URL has been
     * repointed since — the case where the row says one thing today and the
     * credential on it was minted for another.
     *
     * A grant recording no resource at all is refused rather than waved
     * through: grants predating the column exist, and "cannot tell" is not
     * "yes". The cost of being wrong here is one consent screen. A read that
     * fails outright is the same answer for the same reason.
     */
    const grantIsForThisResource = async (server: MCPServer): Promise<boolean> => {
      try {
        const resourceUri = await deps.readGrantResourceUri(server.mcp_server_id, params);
        return sameCatalogEndpoint(resourceUri, entry.remote_url);
      } catch (error) {
        console.warn(
          `[mcp-catalog/connect] Could not read the grant on ${server.mcp_server_id}; not reusing it:`,
          error instanceof Error ? error.message : error
        );
        return false;
      }
    };

    // Pass one: a grant that is already live costs nothing to confirm, so no
    // refresh is spent while one of those exists anywhere in the list.
    for (const candidate of candidates) {
      if (!hasLiveCallerGrant(candidate, Date.now())) continue;
      if (await grantIsForThisResource(candidate)) return candidate;
    }

    // Pass two: revive a stale one.
    let attempts = 0;
    for (const candidate of candidates) {
      if (hasLiveCallerGrant(candidate, Date.now())) continue;
      if (!(await grantIsForThisResource(candidate))) continue;
      if (attempts >= MAX_REVIVAL_ATTEMPTS) {
        console.warn(
          '[mcp-catalog/connect] Stopped reviving grants at the cap; installing fresh instead ' +
            `entry=${entry.name} tried=${attempts}`
        );
        break;
      }
      attempts++;
      try {
        const refreshed = (await service('/mcp-servers/oauth-refresh').create(
          { mcp_server_id: candidate.mcp_server_id },
          params
        )) as { success?: boolean };
        if (!refreshed?.success) continue;
      } catch {
        // A refresh that could not even be attempted is not a reason to fail
        // the connect, nor to stop looking at the rest of the list.
        continue;
      }

      // Re-read rather than trusting the refresh's own report: the hydrate hook
      // is what decides a grant is usable, and this asks it the same question
      // it will be asked on every later read of this row.
      const revived = (await service('mcp-servers').get(
        candidate.mcp_server_id,
        params
      )) as MCPServer;
      if (hasLiveCallerGrant(revived, Date.now())) return revived;
    }

    return undefined;
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
        transport: catalogServerTransport(entry),
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
