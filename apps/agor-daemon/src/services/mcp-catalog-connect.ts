/**
 * Marketplace connect: install one catalog entry and hand back a session that
 * can use it.
 *
 * The request names a catalog entry, where the session should live, and — for
 * an endpoint that asks for one — the caller's own bearer access token. Nothing else. URL,
 * transport, and the kind of auth are read from the catalog entry and the live
 * endpoint. Accepting those from the client would make this a way to register
 * any server at all without passing the `mcp_member_policy` gate that guards
 * `POST /mcp-servers`, and — now that a request can carry a credential — a way
 * to name the destination that credential is sent to. A client that supplies
 * both a URL and a key is a client that can post its own key to its own server;
 * one that supplies only the key can only ever send it where the catalog
 * already points.
 *
 * It also does not re-implement that gate. The server row is created through
 * the `mcp-servers` service and the session through `sessions`, with the
 * caller's own params, so policy, ownership stamping, the remote-transport
 * restriction, branch permissions, and execution identity all resolve exactly once,
 * in the places that already own them. The key rides along on that same row as
 * `auth.token`, which is where every bearer credential in Agor lives — so it
 * inherits the read-path redaction, the ownership rules, and the write
 * authorizer without any of them learning that the marketplace exists.
 *
 * Scope: remote transport. An endpoint that accepts an unauthenticated client
 * is installed ready to use; one that answers with an OAuth challenge is
 * installed configured-but-unauthenticated, for the user to complete through
 * the OAuth flow that already exists in Settings → MCP Servers; one that asks
 * for a bearer access token is installed with the key the caller pasted after
 * that key has been tried against the endpoint.
 */

import { isDatabaseUniqueConstraintError } from '@agor/core/db';
import { BadRequest, NotAuthenticated, NotFound } from '@agor/core/feathers';
import { sanitizeMCPExternalError } from '@agor/core/mcp';
import { probeRemoteAuthType, probeRemoteBearerToken } from '@agor/core/mcp-catalog';
import { MCP_AUTH_SECRET_FIELDS, redactMCPAuthSecrets } from '@agor/core/tools/mcp/auth-secrets';
import { MCP_HEADER_REDACTED_SENTINEL } from '@agor/core/tools/mcp/http-headers';
import type {
  AuthenticatedParams,
  CreateMCPServerInput,
  MCPAuth,
  MCPCatalogConnectData,
  MCPCatalogConnectErrorData,
  MCPCatalogConnectResult,
  MCPCatalogEntry,
  MCPCatalogProbedAuthType,
  MCPCatalogServerCandidate,
  MCPServer,
  MCPServerID,
  Session,
  UserID,
} from '@agor/core/types';
import { catalogDisplayName, catalogServerSlug, isCanonicalFullUuid } from '@agor/core/types';
import { hasLiveCallerOAuthGrant, selectCatalogCandidate } from './mcp-catalog-credential-match.js';
import {
  catalogOAuthConfig,
  catalogServerTransport,
  isCurrentCatalogInstall,
} from './mcp-catalog-install-policy.js';
import type { MCPServersService } from './mcp-servers.js';

/**
 * A closed, daemon-authored control-plane response. Unlike provider/library
 * exceptions, this is safe to preserve across the public service boundary and
 * its credential_requirement value drives the Marketplace retry form.
 */
class CatalogConnectControlError extends BadRequest {}

class CatalogCredentialRequirementError extends CatalogConnectControlError {
  constructor(
    message: string,
    credentialRequirement: MCPCatalogConnectErrorData['credential_requirement']
  ) {
    super(message, { credential_requirement: credentialRequirement });
  }
}

function isCatalogConnectControlError(error: unknown): error is CatalogConnectControlError {
  try {
    return error instanceof CatalogConnectControlError;
  } catch {
    return false;
  }
}

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
/**
 * Reconcile catalog-owned configuration without erasing the owner's explicit
 * OAuth compatibility choice.
 *
 * Endpoint, transport, scope, headers, and every other auth field still come
 * from the current catalog prescription. `strict` and `legacy` are different:
 * they are the two validated public overrides the Settings UI can persist, and
 * the OAuth resolver treats either as authoritative over the derived
 * Marketplace profile. Replacing the whole auth object with `prescribed`
 * would silently turn an explicit Strict row back into Marketplace whenever
 * the catalog omits `compatibility_mode` (and similarly erase Legacy).
 *
 * Preserve only those two validated public values: Strict retains the narrow
 * policy, while Legacy remains the explicit, deliberately broader operator
 * override. A malformed database value is not carried forward through
 * reconciliation.
 */
function preserveExplicitOAuthCompatibility(server: MCPServer, prescribed: MCPAuth): MCPAuth {
  if (server.auth?.type !== 'oauth' || prescribed.type !== 'oauth') return prescribed;
  const explicitMode = server.auth.oauth_compatibility_mode;
  if (explicitMode !== 'strict' && explicitMode !== 'legacy') return prescribed;
  return { ...prescribed, oauth_compatibility_mode: explicitMode };
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
 * Current SQLite OAuth flows also mint versioned configuration fingerprints,
 * and hydration verifies them. Only grants created before that authority was
 * introduced (or inserted directly by an operator) are unbound. Those legacy
 * grants remain readable for migration compatibility; direct write access to
 * a standalone SQLite database is part of the deployment trust boundary.
 * What narrows that legacy case on both dialects is the resource comparison in
 * {@link findReusableCredential},
 * which reads what the endpoint declared itself to be at consent time and is
 * recorded on every grant regardless of dialect. It is unauthenticated on
 * SQLite — but forging it needs database write access, which on a standalone
 * deployment is already game over.
 */
const RUNTIME_HYDRATED_AUTH_FIELDS = [
  'oauth_access_token',
  'oauth_refresh_token',
  'oauth_token_expires_at',
] as const satisfies readonly (keyof MCPAuth)[];

function carriesRowLevelSecret(auth: MCPAuth | undefined): boolean {
  const redacted = redactMCPAuthSecrets(auth);
  if (!redacted) return false;
  return MCP_AUTH_SECRET_FIELDS.filter(
    (field) => !(RUNTIME_HYDRATED_AUTH_FIELDS as readonly string[]).includes(field)
  ).some((field) => redacted[field] !== undefined);
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
 * - **A non-OAuth 401/403.** An bearer access token, which nothing can obtain on the user's
 *   behalf — so the user supplies it, and {@link resolveBearerTokenAuth} decides
 *   whether it works before anything is written.
 * - **Nothing identifiable answered.** Refused, unchanged.
 *
 * A key offered to either of the first two is refused rather than dropped. The
 * endpoint did not ask for one, so storing it would put a live secret on a row
 * that has no use for it and no reason to be read as holding one; and silently
 * discarding it would leave a user believing a key they pasted is in use. Both
 * are reachable honestly — an entry stating `credentials` whose vendor has
 * since opened the endpoint up, or moved it behind OAuth — so the message says
 * what changed rather than accusing the caller.
 */
async function resolveAuthRequirement(
  entry: MCPCatalogEntry & { remote_url: string },
  bearerToken: string | undefined
): Promise<MCPAuth> {
  const probed = await probeRemoteAuthType(entry.remote_url);
  logProbeDisagreement(entry, probed);

  if (probed === 'none' || probed === 'oauth') {
    if (bearerToken !== undefined) {
      throw new CatalogCredentialRequirementError(
        `${catalogDisplayName(entry)} is not asking for a bearer access token${
          probed === 'oauth' ? '; it signs you in with your own account' : ''
        }. Connect it again without one.`,
        // The client asked with a key because the entry said to. Telling it
        // what the endpoint actually wants is what lets the form drop the
        // field and the user retry, rather than being held at a button that
        // submits something the daemon will refuse again.
        probed === 'oauth' ? 'oauth' : 'not_accepted'
      );
    }
    return probed === 'none' ? { type: 'none' } : catalogOAuthConfig(entry);
  }

  if (probed === 'credentials') {
    if (entry.credentials?.scheme !== 'bearer') {
      throw new CatalogCredentialRequirementError(
        `${catalogDisplayName(entry)} requires credentials, but its reviewed credential scheme is not supported by Marketplace`,
        'unsupported'
      );
    }
    return resolveBearerTokenAuth(entry, bearerToken);
  }

  throw new CatalogConnectControlError(
    `${catalogDisplayName(entry)} could not be reached, so it cannot be connected`
  );
}

/**
 * The auth block to install a bearer-token-requiring entry with, or the refusal.
 *
 * The key is tried against the endpoint before the row exists. Not for form:
 * a wrong key installs a server whose every tool fails, and it fails later and
 * somewhere else — the agent reports a broken tool rather than a bad
 * credential, and the row sits in Settings looking configured. That is the
 * exact failure this marketplace declined to ship servers with, so producing it
 * from a typo would be shipping it anyway. The endpoint has already answered
 * once by this point, so the check costs one more `initialize` on a request a
 * user is already waiting on.
 *
 * A `rejected` verdict is the user's to fix and says so. `unusable` is not:
 * the endpoint answered the first probe and then did not answer this one as an
 * MCP server, which is a fact about the endpoint, and reporting it as a bad key
 * would send somebody to rotate a credential that is fine. Neither installs
 * anything, because the only thing worse than refusing a good key is accepting
 * a bad one.
 *
 * The key is never in the sentence. There is no branch here that puts it in a
 * message, and the probe does not log its request — an error string is the
 * easiest place for a secret to end up, since it travels to the client, into
 * daemon logs, and into whatever collects them.
 */
async function resolveBearerTokenAuth(
  entry: MCPCatalogEntry & { remote_url: string },
  bearerToken: string | undefined
): Promise<MCPAuth> {
  const name = catalogDisplayName(entry);
  if (bearerToken === undefined) {
    throw new CatalogCredentialRequirementError(
      `${name} needs a bearer access token; paste one to connect it`,
      // The mirror of the `not_accepted` case: the client asked without a key
      // because the entry said none was needed, and the endpoint disagreed.
      // Without this the drawer has no field to offer and the sentence above is
      // an instruction the user cannot follow.
      'required'
    );
  }

  const verdict = await probeRemoteBearerToken(entry.remote_url, bearerToken);
  if (verdict === 'accepted') return { type: 'bearer', token: bearerToken };
  if (verdict === 'rejected') {
    // Still `required` — the endpoint wants a key, this one was just wrong. A
    // client that has already revealed the field keeps it revealed, which is
    // what lets a typo be corrected in place.
    throw new CatalogCredentialRequirementError(
      `${name} did not accept that bearer access token; check it and try again`,
      'required'
    );
  }
  throw new CatalogConnectControlError(
    `${name} did not answer as an MCP server when that bearer access token was tried, so it was not connected`
  );
}

/**
 * The bearer access token as the request carried it, or `undefined` for a request that
 * carried none.
 *
 * Whitespace-only is `undefined`, not a key: a client that sends an untouched
 * input field has supplied nothing, and treating that as a credential would
 * install a server authenticating with a blank string. Trimmed because a key
 * pasted from a terminal or a vendor's dashboard routinely arrives with a
 * trailing newline, and `Bearer sk-…\n` is not a header value any server
 * accepts — a paste that fails for an invisible reason is the worst kind.
 *
 * A non-string is refused rather than coerced. `String(value)` on an object
 * produces `[object Object]`, which is a credential-shaped thing nobody typed.
 */
function readBearerToken(value: unknown, entry: MCPCatalogEntry): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') {
    throw new BadRequest(`bearer_token must be a string to connect ${catalogDisplayName(entry)}`);
  }
  const trimmed = value.trim();
  if (trimmed === '') return undefined;

  // The redaction sentinel is not a key. It is what a read path puts where a
  // key was, so a request carrying it is a client echoing back the absence of
  // a value — never a value.
  //
  // This is the rule #2374 enforces on the write path, at the boundary it does
  // not cover. There it is a stale edit form resubmitting what it was shown;
  // here it is a paste out of a redacted response. Both end the same way: the
  // row authenticates with a literal `••••••••`, and — the part that makes it
  // worse than an ordinary bad key — every later read of that row shows the
  // sentinel too, so a credential that cannot work is indistinguishable on
  // screen from a real one that is being correctly hidden. Nothing in the
  // product could tell the user which they have.
  //
  // Refused before the probe rather than left to it, because a probe is a fact
  // about the endpoint: a server that accepts any syntactically-present bearer
  // on `initialize` would answer `accepted` and the sentinel would be stored as
  // the credential. The rule does not depend on how strict a vendor happens to
  // be.
  //
  // {@link MCP_HEADER_REDACTED_SENTINEL} is imported rather than restated, so
  // this boundary and #2374's cannot come to disagree about what the sentinel
  // is. There is no shared predicate to reuse — #2374 adds none, comparing
  // against the same exported constant inline — so the constant is the whole of
  // what the two sides share, and it is enough.
  if (trimmed === MCP_HEADER_REDACTED_SENTINEL) {
    throw new BadRequest(
      `That is the placeholder Agor shows in place of a hidden key, not a key. Paste the real ${catalogDisplayName(entry)} bearer access token.`
    );
  }

  return trimmed;
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
  listCandidates(userId: UserID, params: AuthenticatedParams): Promise<MCPCatalogServerCandidate[]>;
  getCandidate(
    userId: UserID,
    serverId: MCPServerID,
    params: AuthenticatedParams
  ): Promise<MCPCatalogServerCandidate | undefined>;
  /** Performs binding validation internally and returns no credential data. */
  isGrantAuthorized(
    candidate: MCPCatalogServerCandidate,
    params: AuthenticatedParams
  ): Promise<boolean>;
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
type ExistingSelection = {
  server: MCPServer;
  candidate: MCPCatalogServerCandidate;
  kind: 'catalog_install' | 'credential_peer' | 'refreshed_credential_peer';
};

/**
 * Closed connect response projection. Candidate reads never contain raw
 * secrets; this second boundary whitelists fields and uses the same sentinel
 * external MCP reads use when a credential is configured.
 */
async function presentConnectServer(
  candidate: MCPCatalogServerCandidate,
  params: AuthenticatedParams,
  deps: MCPCatalogConnectDeps
): Promise<MCPServer> {
  const value = candidate.server;
  let auth = redactMCPAuthSecrets(value.auth);
  if (
    auth?.type === 'oauth' &&
    (await hasLiveCallerOAuthGrant(candidate, Date.now(), {
      isGrantAuthorized: (selected) => deps.isGrantAuthorized(selected, params),
    }))
  ) {
    auth = {
      ...auth,
      oauth_access_token: MCP_HEADER_REDACTED_SENTINEL,
      ...(candidate.grant?.expires_at
        ? { oauth_token_expires_at: candidate.grant.expires_at }
        : {}),
    };
  }
  return {
    mcp_server_id: value.mcp_server_id,
    name: value.name,
    ...(value.display_name ? { display_name: value.display_name } : {}),
    ...(value.description ? { description: value.description } : {}),
    transport: value.transport,
    ...(value.url ? { url: value.url } : {}),
    headers: { ...(value.headers ?? {}) },
    ...(auth ? { auth } : {}),
    scope: value.scope,
    ...(value.owner_user_id ? { owner_user_id: value.owner_user_id } : {}),
    source: value.source,
    ...(value.catalog_entry_name ? { catalog_entry_name: value.catalog_entry_name } : {}),
    enabled: value.enabled,
    ...(value.tools ? { tools: structuredClone(value.tools) } : {}),
    ...(value.resources ? { resources: structuredClone(value.resources) } : {}),
    ...(value.prompts ? { prompts: structuredClone(value.prompts) } : {}),
    ...(value.tool_permissions ? { tool_permissions: { ...value.tool_permissions } } : {}),
    created_at: new Date(value.created_at),
    updated_at: new Date(value.updated_at),
  };
}

function candidateFromExternalServer(value: MCPServer): MCPCatalogServerCandidate {
  const auth = redactMCPAuthSecrets(value.auth);
  if (auth?.type === 'oauth') {
    delete auth.oauth_access_token;
    delete auth.oauth_refresh_token;
    delete auth.oauth_token_expires_at;
  }
  return {
    server: {
      ...value,
      headers: Object.fromEntries(
        Object.keys(value.headers ?? {}).map((name) => [name, MCP_HEADER_REDACTED_SENTINEL])
      ),
      ...(auth ? { auth } : {}),
    },
    has_row_secret: carriesRowLevelSecret(value.auth),
  };
}

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
   *
   * And a row that keeps a credential in its own columns is reusable only by
   * the user who owns it. This is the one rule the API-key install adds, and it
   * is the whole of what stops the feature from being a credential leak between
   * colleagues.
   *
   * The search is already narrowed by `usableByUserId`, which resolves to
   * "shared rows, plus private rows owned by this user" — and every marketplace
   * install is stamped private to its installer under every policy and at every
   * role (`resolveCatalogInstall`), so on today's data a second user genuinely
   * cannot see the first one's row. That is a conclusion drawn from three
   * separate mechanisms holding at once, though, and the failure it prevents is
   * silent: reuse handing B a row carrying A's key looks exactly like the
   * feature working. `usableByUserId` widening, one internally-created unowned
   * row carrying a `catalog_entry_name`, or a later policy that publishes an
   * install would each turn a working marketplace into one that lends out
   * credentials, with nothing failing to mark the moment.
   *
   * So the property is asserted here rather than inferred from over there. It
   * costs an ownership comparison, it is expressed in terms of what the row
   * carries rather than which entry it came from, and it applies to any future
   * auth type that puts a secret in a column. Sharing stays available for the
   * cases where it is sound — an unauthenticated server, or an OAuth one, whose
   * grants are per-user in `user_mcp_oauth_tokens` and so are not the row's to
   * lend.
   */
  const findExistingInstall = async (
    entry: MCPCatalogEntry & { remote_url: string },
    prescribed: MCPAuth,
    userId: UserID,
    params: AuthenticatedParams
  ): Promise<ExistingSelection | undefined> => {
    const candidates = await deps.listCandidates(userId, params);
    const selected = await selectCatalogCandidate(
      entry,
      prescribed,
      candidates,
      userId,
      Date.now(),
      { isGrantAuthorized: (candidate) => deps.isGrantAuthorized(candidate, params) }
    );
    if (selected.live) {
      return {
        server: selected.live.server,
        candidate: selected.live,
        kind: selected.liveKind!,
      };
    }
    const revived = await findReusableCredential(entry, selected.compatibleOAuth, userId, params);
    if (revived) return revived;
    if (selected.ownedCatalog) {
      return {
        server: selected.ownedCatalog.server,
        candidate: selected.ownedCatalog,
        kind: 'catalog_install',
      };
    }
    return undefined;
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
    candidates: MCPCatalogServerCandidate[],
    userId: UserID,
    params: AuthenticatedParams
  ): Promise<ExistingSelection | undefined> => {
    // Pass one: a grant that is already live costs nothing to confirm, so no
    // refresh is spent while one of those exists anywhere in the list.
    for (const candidate of candidates) {
      if (
        !(await hasLiveCallerOAuthGrant(candidate, Date.now(), {
          isGrantAuthorized: (value) => deps.isGrantAuthorized(value, params),
        }))
      )
        continue;
      return { server: candidate.server, candidate, kind: 'credential_peer' };
    }

    // Pass two: revive a stale one.
    let attempts = 0;
    for (const candidate of candidates) {
      if (
        await hasLiveCallerOAuthGrant(candidate, Date.now(), {
          isGrantAuthorized: (value) => deps.isGrantAuthorized(value, params),
        })
      )
        continue;
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
          { mcp_server_id: candidate.server.mcp_server_id },
          params
        )) as { success?: boolean };
        if (!refreshed?.success) continue;
      } catch {
        // A refresh that could not even be attempted is not a reason to fail
        // the connect, nor to stop looking at the rest of the list.
        continue;
      }

      try {
        const revived = await deps.getCandidate(userId, candidate.server.mcp_server_id, params);
        if (
          revived &&
          (await hasLiveCallerOAuthGrant(revived, Date.now(), {
            isGrantAuthorized: (value) => deps.isGrantAuthorized(value, params),
          }))
        ) {
          return {
            server: revived.server,
            candidate: revived,
            kind: 'refreshed_credential_peer',
          };
        }
      } catch {
        // The row may be deleted or lose visibility after refresh. Continue;
        // a concurrent lifecycle change must not abort the whole connect.
      }
    }

    return undefined;
  };

  /**
   * Write the key the caller just pasted onto the install being reused.
   *
   * Rotation is the ordinary life of an bearer access token, and re-connecting from the
   * marketplace is where a user would do it — so the alternative is a connect
   * that reports success while the server keeps authenticating with the key the
   * user just replaced. Nothing surfaces that: the row reads back redacted, so
   * both keys look identical from every screen, and the failure arrives later
   * as a tool that stopped working.
   *
   * Written unconditionally rather than only when it changed, because "changed"
   * is not knowable here — the row arrives with the sentinel in place of its
   * token, by design. Writing the same key twice costs one update; skipping a
   * write because the two might be equal costs the rotation.
   *
   * Through the service with the caller's own params, so the write authorizer
   * decides it: the caller owns this row — {@link findExistingInstall} would not
   * have offered it otherwise — and the after hook redacts what comes back, so
   * the key does not travel out on the reply. It also means a patch the tenant's
   * policy refuses fails here rather than half-installing.
   *
   * Called last, once the session and the attachment have both succeeded. This
   * is the only write here that overwrites something a previous connect left
   * behind, so it is also the only one whose failure cannot be compensated by a
   * further write — see the call site for why ordering is the answer rather
   * than a rollback.
   */
  const finalizeReusedInstall = async (
    server: MCPServer,
    reconcile: boolean,
    createInput: CreateMCPServerInput,
    prescribed: MCPAuth,
    params: AuthenticatedParams,
    generation?: { ownerUserId: string; catalogEntryName: string; value: number }
  ): Promise<void> => {
    const reconciledAuth = reconcile
      ? preserveExplicitOAuthCompatibility(server, prescribed)
      : prescribed;
    // Both arms carry a complete catalog-authored auth object, not a public
    // partial edit. Make that authority explicit so same-mode fields omitted
    // by today's prescription cannot survive from an older install. The only
    // retained field is the validated compatibility override selected above.
    const updates = reconcile
      ? {
          enabled: true,
          transport: createInput.transport,
          scope: createInput.scope,
          url: createInput.url,
          headers: {},
          auth: reconciledAuth,
          replace_auth: true,
        }
      : { auth: prescribed, replace_auth: true };
    if (!generation) {
      await service('mcp-servers').patch(server.mcp_server_id, updates, {
        ...params,
      });
      return;
    }
    await service('mcp-servers').patch(server.mcp_server_id, updates, {
      ...params,
      mcpCatalogConnectGeneration: generation,
    } as AuthenticatedParams);
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
      // Derived from the entry and the live endpoint, never from `data` — with
      // one deliberate exception, read here and nowhere else. The request may
      // name a secret; it may not name where the secret goes, what transport
      // carries it, or which kind of credential it is. Every one of those still
      // comes from the entry the catalog resolved and the answer the endpoint
      // gave, so a caller holding a key can only ever aim it at the URL the
      // checked-in file already points to.
      const authenticatedUserId = params.user?.user_id;
      if (!authenticatedUserId) throw new NotAuthenticated('Authentication required');
      // Every authentication strategy hydrates params.user from the users
      // table, so this is already the canonical persistence key. A short or
      // arbitrary value means the authentication invariant was broken; never
      // reinterpret it through public short-ID lookup semantics here.
      if (!isCanonicalFullUuid(authenticatedUserId)) {
        throw new NotAuthenticated('Authenticated user identity must be a canonical full UUID');
      }
      const userId = authenticatedUserId as UserID;
      const bearerToken = readBearerToken(data.bearer_token, entry);
      // Every connect claims an operation generation, not only bearer
      // rotation. Compensation must not delete a just-created row after a
      // newer concurrent connect has selected it but before that request has
      // attached it. The same generation lock used for bearer fencing makes
      // that adoption authoritative without hydrating the row.
      const operationGeneration = {
        ownerUserId: userId,
        catalogEntryName: entry.name,
        value: await (
          service('mcp-servers') as unknown as MCPServersService
        ).claimCatalogConnectGeneration(userId, entry.name),
      };
      const connectGeneration = bearerToken === undefined ? undefined : operationGeneration;
      let auth: MCPAuth;
      try {
        auth = await resolveAuthRequirement(entry, bearerToken);
      } catch (error) {
        if (isCatalogConnectControlError(error)) throw error;
        const safe = sanitizeMCPExternalError(error, { stage: 'discovery' });
        console.error(
          `[mcp-catalog/connect] event=mcp_external_failure stage=discovery category=${safe.category} type=${safe.diagnostic.type}`
        );
        throw new BadRequest(safe.message, { category: safe.category });
      }

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
      let selection = existing;
      let mcpServer = selection?.server;
      let createdServer = false;
      if (!mcpServer) {
        try {
          mcpServer = (await service('mcp-servers').create(createInput, {
            ...params,
            mcpCatalogInstall: { entry_name: entry.name },
          })) as MCPServer;
          createdServer = true;
        } catch (error) {
          // The database identity constraint is the serialization point. A
          // concurrent connect may win between our targeted read and create;
          // recover its row rather than creating a second credential copy.
          if (!isDatabaseUniqueConstraintError(error)) throw error;
          selection = await findExistingInstall(entry, auth, userId, params);
          if (!selection) throw error;
          mcpServer = selection.server;
        }
      }
      const reusedExisting = !createdServer;
      const needsReconciliation =
        reusedExisting &&
        selection?.kind === 'catalog_install' &&
        (!mcpServer.enabled ||
          !isCurrentCatalogInstall(mcpServer, entry, auth, {
            reconcileMissingCompatibilityMode: true,
          }));
      const preservedCompatibilityOverride =
        selection?.kind === 'catalog_install' &&
        mcpServer.auth?.type === 'oauth' &&
        auth.type === 'oauth' &&
        (mcpServer.auth.oauth_compatibility_mode === 'strict' ||
          mcpServer.auth.oauth_compatibility_mode === 'legacy') &&
        mcpServer.auth.oauth_compatibility_mode !== auth.oauth_compatibility_mode
          ? mcpServer.auth.oauth_compatibility_mode
          : undefined;

      // Four writes across three services, so there is no transaction to lean
      // on. What this request created, it takes back on failure: a server or a
      // session nobody can see is configuration the user never asked to keep
      // and cannot find to remove, and a retry that leaves one behind each time
      // is worse than the failure it followed. A reused install is somebody's
      // existing state and is left alone — see the `catch`.
      // Held outside the `try` so the cleanup below can see it. A failure at
      // the attachment or the rotation happens after this exists, and what is
      // left behind is the difference between a retry that converges and one
      // that adds a session each time.
      let session: Session | undefined;
      try {
        session = (await service('sessions').create(
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

        // Rotation is last, after everything that can fail has succeeded.
        //
        // It is the one write in this method that changes state a *previous*
        // connect established, and it is not undoable in any way worth trusting:
        // there is no transaction here, so undoing it means a second write that
        // can itself fail. Ordering removes the need. Done earlier, a connect
        // whose session or attachment then failed told the caller it had failed
        // while having already replaced their working key — every session still
        // relying on the old one broken, and nothing anywhere saying so.
        //
        // Nothing between here and the top needs the new key: the session is a
        // row, the attachment is a pair of ids, and neither opens the server's
        // transport. So the only thing later ordering costs is the case where
        // this patch itself fails — and that leaves the install exactly as its
        // owner had it, working with the key it already held, beside a session
        // the caller was told they did not get. That is a state the product can
        // survive and a user can retry out of, which the alternative is not.
        // Reconciliation, like credential rotation, overwrites state from a
        // previous connect and therefore happens only after the new session
        // and attachment are established. If either earlier write fails, the
        // reused row has not been touched; cleanup can remove only this
        // request's new session. One final patch applies drift repair and the
        // newly validated credential together, so there is no intermediate
        // enabled/rerouted row carrying the old auth policy or secret.
        const finalized = Boolean(
          connectGeneration ||
            (reusedExisting && (needsReconciliation || carriesRowLevelSecret(auth)))
        );
        if (finalized) {
          await finalizeReusedInstall(
            mcpServer,
            needsReconciliation,
            createInput,
            auth,
            params,
            connectGeneration
          );
        }
        const finalCandidate = createdServer
          ? candidateFromExternalServer(mcpServer)
          : !finalized && selection?.candidate
            ? selection.candidate
            : await deps.getCandidate(userId, mcpServer.mcp_server_id, params);
        if (!finalCandidate) {
          throw new Error('Connected MCP server is no longer available');
        }
        const installed = await presentConnectServer(finalCandidate, params, deps);

        return {
          mcp_server: installed,
          session,
          starter_prompt: entry.starter_prompt,
          reused_existing_server: reusedExisting,
          reuse_kind: selection?.kind ?? 'new_catalog_install',
          effective_oauth_policy:
            auth.type === 'oauth'
              ? {
                  effective_mode:
                    preservedCompatibilityOverride ??
                    entry.oauth?.compatibility_mode ??
                    'marketplace',
                  managed_by_catalog:
                    (!selection || selection.kind === 'catalog_install') &&
                    preservedCompatibilityOverride === undefined,
                }
              : undefined,
        };
      } catch (error) {
        // Take back everything this request created, so a retry lands where the
        // first attempt meant to rather than beside it.
        //
        // Ordering the writes cannot fix this on its own. There are four writes
        // across three services and no transaction, so every ordering leaves
        // some window open — moving the rotation to the end closed the one where
        // a failed connect had already replaced a working key, and opened one
        // where a failed rotation left a session and an attachment the caller
        // was told they did not get. The second attempt then made another, and
        // the first stayed pinned to the old-key server. Accumulation, not a
        // window, is the thing a user actually meets.
        //
        // Deleting is right here and reuse is not, which is worth saying plainly
        // because reuse is what the server row does. A session is deliberately
        // *not* deduplicated: connecting the same entry twice is an ordinary
        // success that reuses the install and opens a second session, so there
        // is no stable key to match a previous one on, and matching one would
        // hand the caller somebody's earlier conversation. What this removes is
        // a session created seconds ago by this request, never returned to
        // anyone, holding no messages — the same argument the server row below
        // already makes, applied to the other row this method creates.
        //
        // The session goes first: `session_mcp_servers.session_id` is
        // `onDelete: 'cascade'`, so removing it takes the attachment with it and
        // there is no third thing to undo. Internal params, because this is the
        // daemon undoing its own write moments later rather than a new request
        // to authorize.
        if (session) {
          try {
            await service('sessions').remove(session.session_id, {
              ...params,
              provider: undefined,
            });
          } catch (cleanupError) {
            const safe = sanitizeMCPExternalError(cleanupError, { stage: 'runtime' });
            console.warn(
              `[mcp-catalog/connect] compensation_failed resource=session session_id=${session.session_id} category=${safe.category} type=${safe.diagnostic.type}`
            );
          }
        }
        if (createdServer) {
          try {
            // Atomic liveness/adoption check. A concurrent unique-conflict
            // loser may now be using this row; in that case it owns the row's
            // continued life and compensation must leave it in place.
            await service('mcp-servers').removeIfUnattached(
              mcpServer.mcp_server_id,
              operationGeneration
            );
          } catch (cleanupError) {
            const safe = sanitizeMCPExternalError(cleanupError, { stage: 'runtime' });
            console.warn(
              `[mcp-catalog/connect] compensation_failed resource=mcp_server server_id=${mcpServer.mcp_server_id} category=${safe.category} type=${safe.diagnostic.type}`
            );
          }
        }

        // A compensating write can itself fail, and these two are the last
        // chance to notice. Both are logged with the id rather than swallowed,
        // because the residual — an orphan session or an orphan server row — is
        // then something an operator can find and remove by hand. That is the
        // documented floor: no ordering removes it, only a transaction would.
        throw error;
      }
    },
  };
}
