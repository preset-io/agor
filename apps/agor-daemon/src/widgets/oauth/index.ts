/**
 * `oauth` widget — registry entry and registration.
 *
 * Concrete widget type: the agent has decided the user needs a third-party MCP
 * account connected ("connect me to Notion"), and renders an inline Connect
 * button instead of telling them to go and find the Marketplace. Clicking it
 * runs the ordinary browser MCP OAuth flow — the same `oauth-start` endpoint,
 * popup, and durable attempt poll the Marketplace drawer and the Slack
 * recovery page use — and the browser then asks the daemon to resolve the
 * widget.
 *
 * Two properties make this different from every other widget type, and both
 * are why it resolves through `resolveFromDaemonVerification` rather than
 * `applySubmit`:
 *
 *  1. **There is no form body.** The credential never passes through the
 *     browser at all: the provider redirects to the daemon's own callback,
 *     which exchanges the code and persists the grant. The browser's POST is a
 *     notification, not a payload.
 *  2. **So the browser's word is worth nothing.** A client that simply POSTs
 *     "I signed in" must not resolve the widget. The handler below re-reads
 *     the persisted grant (`resolveMCPOAuthGrantLiveness`, through
 *     `mcpOAuthGrantIsConnected` — the same verdict the mint gate asks) and
 *     refuses when there isn't one, which puts the widget back to `pending`
 *     for a retry.
 *
 * The attach happens HERE, after the grant lands — never at mint time. An
 * attached-but-unauthorized OAuth server is not inert in direct egress mode:
 * `packages/core/src/mcp/scoping.ts` marks it `oauthAuthResolution:
 * 'unavailable'` and still hands it to the agent's MCP client with no bearer,
 * so the client 401s and the agent sees an empty tool list every turn
 * (#2585 / #2182). Attaching at resolution also means the agent's next turn is
 * the first turn where the server both exists and is authorized, which avoids
 * needing the runtime to hot-reload transports mid-turn.
 */

import type { TenantScopeAwareDatabase } from '@agor/core/db';
import type { Application } from '@agor/core/feathers';
import { Forbidden } from '@agor/core/feathers';
import { isMCPServerUsableBy } from '@agor/core/mcp';
import { findCatalogEntry, loadCatalog } from '@agor/core/mcp-catalog';
import type {
  GatewayChannel,
  MCPCatalogEntry,
  MCPServer,
  MCPServerID,
  Session,
  UserID,
} from '@agor/core/types';
import { hasMinimumRole, ROLES } from '@agor/core/types';
import { z } from 'zod';
import { isCurrentCatalogInstallOfEntry } from '../../services/mcp-catalog-install-policy.js';
import {
  mcpOAuthGrantIsConnected,
  resolveMCPOAuthGrantLiveness,
} from '../../services/mcp-oauth-grant-liveness.js';
import { checkSessionOwnerOrAdmin } from '../../utils/branch-authorization.js';
import {
  gatewayIdentityRefusalMessage,
  resolveGatewayPromptIdentity,
} from '../../utils/gateway-prompt-identity.js';
import {
  registerWidget,
  type WidgetDaemonVerifiedEvidence,
  type WidgetMintCtx,
  type WidgetRegistryEntry,
  type WidgetSubmitCtx,
} from '../registry.js';

/** The app-held database handle; tenant resolution comes from the scope. */
type GrantLookupDatabase = TenantScopeAwareDatabase;

/**
 * How long to let an in-flight token refresh settle before refusing.
 *
 * Short on purpose: this is a resolve request a browser is waiting on, and the
 * refusal is recoverable (the widget reopens and Connect works again). One
 * look is enough to turn the common race — the JIT refresh firing between the
 * provider callback and this POST — into a success instead of advice to redo
 * a sign-in that already worked.
 */
const GRANT_REFRESH_SETTLE_MS = 400;

/**
 * Agent-provided params, validated when the MCP tool fires and then frozen
 * onto the widget row.
 *
 * The pin is the whole anti-confused-deputy story for the resolve endpoint.
 * When `mcpServerId` is pinned it is the ONLY destination this widget can ever
 * resolve against, and the request's server id is ignored. When only
 * `catalogEntryName` is pinned (an entry the user connects through the catalog
 * drawer, e.g. with an API key, so no row exists at mint time), the request
 * names the install the drawer just made and the daemon accepts it only if it
 * is a caller-usable catalog install of exactly that entry — whose URL,
 * transport and auth recipe the catalog fixes — so a tampered client cannot aim
 * the resolution anywhere the entry does not already point.
 *
 * Everything else is presentational. Nothing here is secret — see §5.1 of the
 * widgets design doc.
 */
/**
 * Upper bound on the disclosure carried onto a widget row.
 *
 * Generous rather than tight, and the difference matters: this field is the
 * CONSENT: the text travels onto the widget and is rendered above the Connect
 * button, so the person reads it before the only moment anything is granted.
 * A bound that silently shortened it would take that away one sentence at a
 * time — quietly, since the tail of a paragraph is exactly where "and can
 * delete" tends to live.
 *
 * So the bound exists only to stop an unbounded blob reaching a message row,
 * and a catalog entry that exceeds it is REFUSED before anything is installed
 * rather than trimmed to fit (`mcp/tools/widgets.ts`). The longest reviewed
 * entry today is 808 characters.
 */
export const OAUTH_PERMISSION_DISCLOSURE_MAX = 4_000;

export const oauthParamsSchema = z
  .object({
    mcpServerId: z
      .string()
      .min(1)
      .optional()
      .describe(
        'MCP server row this widget authorizes, pinned by the daemon at mint time. Absent when the user connects a catalog entry through the catalog drawer, where `catalogEntryName` is the pin.'
      ),
    serverName: z
      .string()
      .min(1)
      .max(200)
      .describe('Human-readable server name for the card heading and prompts.'),
    oauthMode: z
      .enum(['per_user', 'shared'])
      .describe('Whether the grant is the caller’s own or the workspace-wide shared one.'),
    reason: z
      .string()
      .min(1)
      .max(200)
      .describe('One sentence explaining why the connection is needed. Renders as a muted line.'),
    catalogEntryName: z
      .string()
      .min(1)
      .max(200)
      .optional()
      .describe('Reverse-DNS catalog identity, when this server came from the MCP Catalog.'),
    permissionDisclosure: z
      .string()
      .max(OAUTH_PERMISSION_DISCLOSURE_MAX)
      .optional()
      .describe('The catalog entry’s plain-language statement of what connecting grants.'),
  })
  .strict()
  .refine((params) => params.mcpServerId || params.catalogEntryName, {
    message: 'An oauth widget must pin an MCP server or a catalog entry',
  });

export type OAuthWidgetParams = z.infer<typeof oauthParamsSchema>;

/**
 * Sanitized post-resolution data written to the message row and fed into the
 * auto-resume prompt.
 *
 * Names and labels only. No token, no expiry, no scope string, no provider
 * account id — requirement 1 of the widgets design. `account_label` is present
 * for the shape's sake and is currently never populated: Agor persists no
 * provider-side account identity for an MCP grant
 * (`UserMCPOAuthToken` carries none), so there is nothing truthful to put in
 * it. Stage 3 may fill it if the landing page learns one.
 */
export interface OAuthWidgetResultMeta {
  mcp_server_id: string;
  name: string;
  oauth_mode: 'per_user' | 'shared';
  account_label?: string;
  /**
   * Whether the server was also attached to the host session.
   *
   * Attaching is `checkSessionOwnerOrAdmin`-gated, so a collaborator who is
   * allowed to prompt a shared session may legitimately complete the sign-in
   * and still not be allowed to change what that session's agent can reach.
   * The grant is real either way; this is what lets the auto-resume prompt say
   * which of the two happened instead of guessing.
   */
  attached: boolean;
}

/** Shape of the session-attach route this widget calls. */
interface SessionMcpServersService {
  create(
    data: { mcpServerId: string },
    params: { user: { user_id: UserID; role: string | undefined }; route: { id: string } }
  ): Promise<unknown>;
}

interface McpServersGetService {
  get(id: string, params?: unknown): Promise<MCPServer>;
}

/**
 * Shared-mode grants are workspace-wide credentials, so minting or resolving
 * one is admin-only — the same floor `oauth-start` itself applies
 * ("Shared MCP OAuth grants can only be started by an admin"). Per-user
 * grants need only the member floor the resolve route already enforces.
 *
 * `role` may be undefined, which normalizes to member and therefore fails
 * closed. Exported so the MCP tool applies the identical rule at mint time
 * rather than a second, drifting copy.
 */
export function assertOAuthWidgetRoleFloor(
  role: string | undefined,
  oauthMode: 'per_user' | 'shared'
): void {
  if (oauthMode === 'shared' && !hasMinimumRole(role, ROLES.ADMIN)) {
    throw new Forbidden('Only admins can connect a shared MCP OAuth server');
  }
}

/** Shape of the two reads both gates need, as far as they need them. */
interface WidgetGateGetService<T> {
  get(id: string, params?: unknown): Promise<T>;
}

/**
 * Fail closed when the Session's prompts do not carry their real sender.
 *
 * An unaligned gateway channel resolves every inbound message to the channel's
 * "Post messages as" account, so a grant minted from such a prompt belongs to
 * that one identity and everyone in the channel can then drive it. This is the
 * only precondition of this widget that is a property of the SESSION rather
 * than of the destination, which is why both the mint gate and the resolve gate
 * call it: the flag can be switched off while a card sits pending, and a card
 * whose Connect button still works would mint exactly the credential the mint
 * gate refused.
 */
async function assertGatewayPromptIdentityAligned(
  app: Application,
  sessionId: string,
  serviceParams: unknown
): Promise<void> {
  const session = await (app.service('sessions') as unknown as WidgetGateGetService<Session>).get(
    sessionId,
    serviceParams
  );
  const channels = app.service('gateway-channels') as unknown as WidgetGateGetService<
    GatewayChannel | undefined
  >;
  const verdict = await resolveGatewayPromptIdentity(session, async (channelId) => {
    const channel = await channels.get(channelId, serviceParams);
    return channel ? { channel_type: channel.channel_type, config: channel.config } : undefined;
  });
  if (!verdict.aligned) throw new Forbidden(gatewayIdentityRefusalMessage(verdict));
}

/**
 * May this caller change the host session's MCP server set?
 *
 * Asked BEFORE the attach rather than inferred from its failure. The attach
 * route answers this with `authorizeMcpSessionConfigAccess`, which for a
 * provider-less call carrying no executor scope reduces to exactly
 * `checkSessionOwnerOrAdmin` — so this reproduces the one refusal D6 reasons
 * about, and nothing else.
 *
 * The old shape caught every `Forbidden` the attach could raise, which also
 * swallowed "that MCP server is private to another user", tenant write-gate
 * refusals, and member-policy refusals — and then told the user and the agent
 * that the session owner could fix it. For a server private to a third user
 * the session owner cannot attach it either, so the agent was sent to loop on
 * something structurally impossible.
 */
async function canConfigureSessionMcpServers(ctx: WidgetSubmitCtx): Promise<boolean> {
  const session = await (
    ctx.app.service('sessions') as unknown as WidgetGateGetService<Session>
  ).get(ctx.sessionId, { provider: undefined });
  return mayConfigureSessionMcpServers(
    { user_id: ctx.submitterUserId, role: ctx.submitterRole },
    session as Pick<Session, 'created_by'>
  );
}

/**
 * D6's one question, shared by every path that attaches a connected server:
 * the resolve path above and the tool's already-connected / no-auth shortcut.
 * `checkSessionOwnerOrAdmin` is what the attach route reduces to for these
 * callers, so asking it first is asking the route.
 */
export function mayConfigureSessionMcpServers(
  user: { user_id: string; role: string | undefined },
  session: Pick<Session, 'created_by'>
): boolean {
  try {
    checkSessionOwnerOrAdmin(user, session);
    return true;
  } catch (error) {
    if (error instanceof Forbidden) return false;
    throw error;
  }
}

/** What the agent is told when a connected server could not be attached (D6). */
export function oauthNotAttachedGuidance(name: string): string {
  return (
    `only the session owner or an admin can change this session's MCP servers. ` +
    `Ask them to attach "${name}", then continue.`
  );
}

/**
 * Attach the now-authorized server to the host session.
 *
 * Degrades to `attached: false` for exactly one cause — the resolver not being
 * allowed to configure this session's MCP set — because that is the one where
 * the grant is real, the failure is someone else's permission, and reopening
 * the widget would invite the user to repeat a browser flow that already
 * worked. It is decided by asking, not by classifying an exception, so no other
 * refusal can be mistaken for it. Every other error propagates and reopens the
 * widget for a real retry.
 */
async function attachToSession(
  ctx: WidgetSubmitCtx,
  mcpServerId: string
): Promise<{ attached: boolean }> {
  if (!(await canConfigureSessionMcpServers(ctx))) {
    console.warn(
      `[widgets] oauth widget: grant landed but ${ctx.submitterUserId} may not configure ` +
        `MCP servers on session ${ctx.sessionId}; recording attached=false`
    );
    return { attached: false };
  }
  const service = ctx.app.service(
    '/sessions/:id/mcp-servers'
  ) as unknown as SessionMcpServersService;
  // Provider-less (internal) so the route's own role hook does not re-gate a
  // daemon-initiated call, but carrying the resolver's real identity so
  // `checkSessionOwnerOrAdmin` still decides. Attach is idempotent at the
  // repository (unique index + onConflictDoNothing), so a retry is safe.
  await service.create(
    { mcpServerId },
    {
      user: { user_id: ctx.submitterUserId, role: ctx.submitterRole },
      route: { id: ctx.sessionId },
    }
  );
  return { attached: true };
}

/** What either resolve lane hands the shared tail: a server ready to check. */
interface ResolvedTarget {
  server: MCPServer;
  mcpServerId: MCPServerID;
  oauthMode: OAuthWidgetParams['oauthMode'];
}

/** Ownership the resolver needs for any server it is about to attach. */
function assertUsableByResolver(ctx: WidgetSubmitCtx, server: MCPServer): void {
  // The pure ownership predicate, not the params-shaped `isMcpServerUsableByCaller`:
  // that one reads `params.provider` to classify the caller and would treat
  // this provider-less daemon-side call as INTERNAL, i.e. always allowed. The
  // resolver may be a shared-session collaborator rather than the actor who
  // minted the widget, so this has to be a real check.
  const isAdmin = hasMinimumRole(ctx.submitterRole, ROLES.ADMIN);
  if (!isAdmin && !isMCPServerUsableBy(server, ctx.submitterUserId)) {
    throw new Forbidden('That MCP server is not available to you');
  }
}

function loadServerForResolver(ctx: WidgetSubmitCtx, mcpServerId: string): Promise<MCPServer> {
  const serversService = ctx.app.service('mcp-servers') as unknown as McpServersGetService;
  return serversService.get(mcpServerId, {
    user: { user_id: ctx.submitterUserId, role: ctx.submitterRole },
  });
}

/**
 * Pinned lane: the server named at mint time, and only it. It must still be an
 * enabled OAuth server in the mode it was minted for; the browser's server id
 * is ignored.
 */
async function resolvePinnedServer(
  ctx: WidgetSubmitCtx,
  params: OAuthWidgetParams & { mcpServerId: string }
): Promise<ResolvedTarget> {
  const server = await loadServerForResolver(ctx, params.mcpServerId);
  assertUsableByResolver(ctx, server);
  if (!server.enabled || server.auth?.type !== 'oauth') {
    throw new Forbidden(
      `"${params.serverName}" is no longer an enabled OAuth MCP server; reconfigure it and ask again.`
    );
  }
  if ((server.auth.oauth_mode ?? 'per_user') !== params.oauthMode) {
    throw new Forbidden(
      `"${params.serverName}" changed OAuth mode since this request was made; ask again.`
    );
  }
  return {
    server,
    mcpServerId: params.mcpServerId as MCPServerID,
    oauthMode: params.oauthMode,
  };
}

/**
 * Catalog lane: the install the Catalog drawer reports, accepted only while it
 * is still a current install of the pinned entry — the entry's endpoint,
 * transport, no custom headers, and an auth prescription Connect could have
 * written (`isCurrentCatalogInstallOfEntry`). Provenance fields alone survive
 * ordinary edits, so a row retargeted elsewhere or switched to no auth is
 * refused here rather than attached.
 */
async function resolveCatalogInstall(
  ctx: WidgetSubmitCtx,
  params: OAuthWidgetParams,
  mcpServerId: string | undefined
): Promise<ResolvedTarget> {
  if (!mcpServerId) {
    throw new Forbidden(`Connect "${params.serverName}" from the card first, then try again.`);
  }
  const server = await loadServerForResolver(ctx, mcpServerId);
  assertUsableByResolver(ctx, server);
  const entry = params.catalogEntryName
    ? findCatalogEntry(await loadCatalog(), params.catalogEntryName)
    : undefined;
  if (
    !server.enabled ||
    !entry?.remote_url ||
    !isCurrentCatalogInstallOfEntry(server, entry as MCPCatalogEntry & { remote_url: string })
  ) {
    throw new Forbidden(
      `That MCP server is not a current catalog install of "${params.serverName}"`
    );
  }
  const oauthMode = (server.auth?.oauth_mode ?? 'per_user') as OAuthWidgetParams['oauthMode'];
  if (server.auth?.type === 'oauth') assertOAuthWidgetRoleFloor(ctx.submitterRole, oauthMode);
  return { server, mcpServerId: mcpServerId as MCPServerID, oauthMode };
}

/**
 * The grant check both lanes share for an OAuth server. Credentials belong to
 * the prompt actor resolving this widget, not to the Session owner
 * (`mcp-egress/gateway.ts`, `register-routes.ts`), so the grant is looked up
 * under the resolver.
 *
 * Fails closed if the database handle is missing: unlike the env_vars widget's
 * optional session-selection write, this read IS the authorization, so a
 * missing handle must refuse rather than skip.
 */
async function assertResolverGrantConnected(
  ctx: WidgetSubmitCtx,
  mcpServerId: MCPServerID,
  serverName: string,
  attemptId: string | undefined
): Promise<void> {
  const db = (ctx.app as unknown as { get?: (key: string) => unknown }).get?.('database') as
    | GrantLookupDatabase
    | undefined;
  if (!db) {
    throw new Forbidden('MCP OAuth status is unavailable on this daemon; try Connect again.');
  }
  const readLiveness = () =>
    ctx.runInTenantDatabaseScope(() =>
      resolveMCPOAuthGrantLiveness(db, mcpServerId, ctx.submitterUserId)
    );
  let liveness = await readLiveness();

  // `mcpOAuthGrantIsConnected`, not `live` — the same verdict the mint gate
  // asks (D4.1). This gate completes an attach-and-resume against a credential
  // that already exists; it issues nothing, seals nothing, and talks to no
  // provider. What makes it the security boundary is that the decision comes
  // from a grant row this daemon owns, read under the RESOLVER's identity (D3)
  // — not the age of that grant's access token. Requiring `live` here while
  // the mint gate accepts a refreshable grant would refuse a finish for the
  // exact user the mint gate would have connected for free: someone who signs
  // in and comes back after an hour-lived access token has lapsed.
  //
  // A refresh this daemon started can still be in flight at exactly the moment
  // the browser POSTs; one short look turns that race into a success instead
  // of advice to redo a sign-in that worked.
  if (!mcpOAuthGrantIsConnected(liveness) && liveness.reason === 'refreshing') {
    await new Promise((resolve) => setTimeout(resolve, GRANT_REFRESH_SETTLE_MS));
    liveness = await readLiveness();
  }

  if (!mcpOAuthGrantIsConnected(liveness)) {
    console.info(
      `[widgets] event=oauth_widget_unverified server_id=${mcpServerId} reason=${liveness.reason} attempt_id=${attemptId ?? 'none'}`
    );
    // "You have not signed in" and "you have, and Agor is still finishing"
    // need different instructions; both reopen the widget for a retry.
    throw new Forbidden(
      liveness.reason === 'refreshing'
        ? `Agor is still finishing the connection to "${serverName}". Wait a moment, then press Connect again — you should not need to sign in again.`
        : `Sign-in to "${serverName}" has not completed. Finish the provider sign-in, then try Connect again.`
    );
  }
}

/**
 * Resolve the widget from a completed browser connect — an OAuth sign-in, or a
 * catalog-drawer connect for an entry pinned by name.
 *
 * `evidence.attempt_id` is logged for correlation and otherwise unused.
 * `evidence.mcp_server_id` is read only by the catalog lane, and then only
 * names a candidate it accepts or refuses: the decision comes entirely from
 * rows this daemon owns.
 */
async function resolveOAuthWidgetFromCallback(
  ctx: WidgetSubmitCtx,
  evidence: WidgetDaemonVerifiedEvidence,
  params: OAuthWidgetParams
): Promise<OAuthWidgetResultMeta> {
  // The role floor and the gateway identity question are both re-asked by
  // `authorizeOAuthWidgetResolve`, which `submissions.ts` runs before the
  // claim. Repeating the role floor here keeps this function safe to call
  // directly (tests do) and costs nothing.
  assertOAuthWidgetRoleFloor(ctx.submitterRole, params.oauthMode);

  const { server, mcpServerId, oauthMode } = params.mcpServerId
    ? await resolvePinnedServer(ctx, { ...params, mcpServerId: params.mcpServerId })
    : await resolveCatalogInstall(ctx, params, evidence.mcp_server_id);

  // Catalog connect writes a bearer or open row only after the live endpoint
  // accepted it, so such a current install is ready as it stands. OAuth needs
  // the grant.
  if (server.auth?.type === 'oauth') {
    await assertResolverGrantConnected(ctx, mcpServerId, params.serverName, evidence.attempt_id);
  }

  // Only now is the server useful the moment the agent sees it.
  const { attached } = await attachToSession(ctx, mcpServerId);
  return {
    mcp_server_id: mcpServerId,
    name: server.display_name || server.name || params.serverName,
    oauth_mode: oauthMode,
    attached,
  };
}

/**
 * Mint gate — may this widget be created at all?
 *
 * Both checks belong to the widget type rather than to whichever caller is
 * minting, which is the point: a caller cannot skip a precondition it never
 * knew about. `agor_widgets_request_oauth`'s two mint paths — the pending
 * widget and the `already_present` short-circuit — inherit both without
 * deciding to, which is exactly how the short-circuit path kept getting the
 * gate while it was quietly missing the params schema until
 * `parseWidgetMintParams` joined it on the same seam.
 *
 * `params` is absent when a caller runs this early, before it has resolved a
 * destination — the identity question needs no params and is worth answering
 * before installing anything, while the role floor waits for the `oauthMode`
 * the destination turns out to have.
 */
export async function authorizeOAuthWidgetMint(
  ctx: WidgetMintCtx,
  params?: OAuthWidgetParams
): Promise<void> {
  await assertGatewayPromptIdentityAligned(ctx.app, ctx.sessionId, ctx.serviceParams);
  if (params) assertOAuthWidgetRoleFloor(ctx.role, params.oauthMode);
}

/**
 * Resolve gate — is the mint-time answer still true?
 *
 * A pending card is a standing invitation with no expiry (deliberately — see
 * D7 in the design doc), so the window here is long: an admin can switch
 * `align_slack_users` off, or demote the resolver, between the button being
 * rendered and being pressed. §5.2 already required the role floor to hold at
 * both ends; the identity question has the same shape and a longer window, and
 * a widget minted while aligned must not still mint a shared-account credential
 * afterwards.
 *
 * This gate, and the pinned-destination and grant checks in the handler, are
 * WHY the absent expiry is only a stale-card problem: nothing a pending card
 * carries is authority, so age adds none.
 */
export async function authorizeOAuthWidgetResolve(
  ctx: WidgetSubmitCtx,
  params: OAuthWidgetParams
): Promise<void> {
  assertOAuthWidgetRoleFloor(ctx.submitterRole, params.oauthMode);
  await assertGatewayPromptIdentityAligned(ctx.app, ctx.sessionId, {
    user: { user_id: ctx.submitterUserId, role: ctx.submitterRole },
  });
}

export const oauthWidget: WidgetRegistryEntry<OAuthWidgetParams, never, OAuthWidgetResultMeta> = {
  type: 'oauth',
  resolution: 'daemon_verified',
  /**
   * An interrupted resolution of THIS widget may be finished later.
   *
   * Stated explicitly rather than inherited, because the generic policy is the
   * opposite one and is right for the widgets it protects. What makes this
   * lane different is that the provider callback completes only the FIRST of
   * three milestones — grant persisted — while the other two (this widget
   * resolved and the server attached, the agent resumed) depend on a browser
   * coming back to POST. Returning from consent and closing the tab therefore
   * used to leave a real, usable credential behind a card that still said
   * Connect, an agent that never woke, and no path to either except redoing a
   * sign-in that had already worked.
   *
   * The replay is safe by construction, not by hope:
   * `resolveFromDaemonVerification` re-reads the grant (it decides nothing
   * from the request), re-attaches through a unique-index upsert, and the
   * auto-resume Task carries `widgetAutoResumeTaskId`, so a second run of the
   * whole handler converges on the same three rows. Nothing here talks to the
   * provider, writes a secret, or restarts anything.
   */
  recovery: 'reclaimable',
  schemaVersion: 1,
  paramsSchema: oauthParamsSchema,
  authorizeMint: authorizeOAuthWidgetMint,
  authorizeResolve: authorizeOAuthWidgetResolve,
  resolveFromDaemonVerification: resolveOAuthWidgetFromCallback,
  buildAutoResumePrompt: (rm, params) => {
    const name = rm.name || params.serverName;
    if (!rm.attached) {
      return (
        `[Agor] User connected "${name}", but it could not be attached to this session — ` +
        oauthNotAttachedGuidance(name)
      );
    }
    return (
      `[Agor] User connected "${name}" and it is now attached to this session. ` +
      `Its tools become available on your next turn — use them to continue.`
    );
  },
  buildDismissedPrompt: (params) =>
    `[Agor] User declined to connect "${params.serverName}". Don't immediately re-ask — ` +
    `continue without it, or ask whether there is another way to do this.`,
};

/** Idempotent registration helper, safe to call at every daemon boot. */
export function registerOAuthWidget(): void {
  registerWidget(oauthWidget);
}
