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
 * are why it resolves through `resolveFromOAuthCallback` rather than
 * `applySubmit`:
 *
 *  1. **There is no form body.** The credential never passes through the
 *     browser at all: the provider redirects to the daemon's own callback,
 *     which exchanges the code and persists the grant. The browser's POST is a
 *     notification, not a payload.
 *  2. **So the browser's word is worth nothing.** A client that simply POSTs
 *     "I signed in" must not resolve the widget. The handler below re-reads
 *     the persisted grant (`resolveMCPOAuthGrantLiveness`) and refuses when
 *     there isn't one, which puts the widget back to `pending` for a retry.
 *
 * The attach happens HERE, after the grant lands — never at mint time. An
 * attached-but-unauthorized OAuth server is not inert in direct egress mode:
 * `packages/core/src/mcp/scoping.ts` marks it `oauthAuthResolution:
 * 'unavailable'` and still hands it to the agent's MCP client with no bearer,
 * so the client 401s and the agent sees an empty tool list every turn
 * (#2585 / #2182). Attaching at resolution also means the agent's next turn is
 * the first turn where the server both exists and is authorized, which avoids
 * needing the runtime to hot-reload transports mid-turn.
 *
 * See `docs/internal/slack-mcp-oauth-connect-2026-09-16.md`.
 */

import type { TenantScopeAwareDatabase } from '@agor/core/db';
import { Forbidden } from '@agor/core/feathers';
import { isMCPServerUsableBy } from '@agor/core/mcp';
import type { MCPServer, MCPServerID, UserID } from '@agor/core/types';
import { hasMinimumRole, ROLES } from '@agor/core/types';
import { z } from 'zod';
import { resolveMCPOAuthGrantLiveness } from '../../services/mcp-oauth-grant-liveness.js';
import {
  registerWidget,
  type WidgetOAuthCallbackEvidence,
  type WidgetRegistryEntry,
  type WidgetSubmitCtx,
} from '../registry.js';

/** The app-held database handle; tenant resolution comes from the scope. */
type GrantLookupDatabase = TenantScopeAwareDatabase;

/**
 * Agent-provided params, validated when the MCP tool fires and then frozen
 * onto the widget row.
 *
 * `mcpServerId` is pinned here at mint time and is the ONLY destination this
 * widget can ever resolve against. That is the whole anti-confused-deputy
 * story for the resolve endpoint: the request carries no server id, no URL,
 * and no catalog key, so a tampered client cannot aim a resolution at a
 * different server it happens to hold a grant for.
 *
 * Everything else is presentational. Nothing here is secret — see §5.1 of the
 * widgets design doc.
 */
export const oauthParamsSchema = z
  .object({
    mcpServerId: z
      .string()
      .min(1)
      .describe('MCP server row this widget authorizes. Pinned by the daemon at mint time.'),
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
      .max(1000)
      .optional()
      .describe('The catalog entry’s plain-language statement of what connecting grants.'),
  })
  .strict();

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

/**
 * Attach the now-authorized server to the host session.
 *
 * Tolerates exactly one failure — the caller not being allowed to configure
 * this session's MCP set — and reports it as `attached: false` rather than
 * failing the whole resolution. Failing would reopen the widget and invite the
 * user to repeat a browser flow that already succeeded, which would not fix
 * anything: the missing thing is someone else's permission, not their grant.
 * Every other error propagates and reopens the widget for a real retry.
 */
async function attachToSession(
  ctx: WidgetSubmitCtx,
  mcpServerId: string
): Promise<{ attached: boolean }> {
  const service = ctx.app.service(
    '/sessions/:id/mcp-servers'
  ) as unknown as SessionMcpServersService;
  try {
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
  } catch (error) {
    if (error instanceof Forbidden) {
      console.warn(
        `[widgets] oauth widget: grant landed but attach was refused for session ${ctx.sessionId}: ` +
          (error instanceof Error ? error.message : String(error))
      );
      return { attached: false };
    }
    throw error;
  }
}

/**
 * Resolve the widget from a completed browser OAuth flow.
 *
 * `evidence.attempt_id` is logged for correlation and otherwise unused: the
 * decision below comes entirely from rows this daemon owns.
 */
async function resolveOAuthWidgetFromCallback(
  ctx: WidgetSubmitCtx,
  evidence: WidgetOAuthCallbackEvidence,
  params: OAuthWidgetParams
): Promise<OAuthWidgetResultMeta> {
  assertOAuthWidgetRoleFloor(ctx.submitterRole, params.oauthMode);

  // a. The pinned server must still exist, still be usable by this caller, and
  // still be an enabled OAuth server. A server that was disabled or converted
  // to bearer auth between mint and resolve is not something to attach.
  const serversService = ctx.app.service('mcp-servers') as unknown as McpServersGetService;
  const server = await serversService.get(params.mcpServerId, {
    user: { user_id: ctx.submitterUserId, role: ctx.submitterRole },
  });
  // The pure ownership predicate, not the params-shaped `isMcpServerUsableByCaller`:
  // that one reads `params.provider` to classify the caller and would treat
  // this provider-less daemon-side call as INTERNAL, i.e. always allowed. The
  // resolver may be a shared-session collaborator rather than the actor who
  // minted the widget, so this has to be a real check.
  const isAdmin = hasMinimumRole(ctx.submitterRole, ROLES.ADMIN);
  if (!isAdmin && !isMCPServerUsableBy(server, ctx.submitterUserId)) {
    throw new Forbidden('That MCP server is not available to you');
  }
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

  // b. THE check. Credentials belong to the prompt actor resolving this
  // widget, not to the Session owner (`mcp-egress/gateway.ts`,
  // `register-routes.ts`), so the grant is looked up under the resolver.
  //
  // Fails closed if the database handle is missing: unlike the env_vars
  // widget's optional session-selection write, this read IS the authorization,
  // so a missing handle must refuse rather than skip.
  const db = (ctx.app as unknown as { get?: (key: string) => unknown }).get?.('database') as
    | GrantLookupDatabase
    | undefined;
  if (!db) {
    throw new Forbidden('MCP OAuth status is unavailable on this daemon; try Connect again.');
  }
  const liveness = await ctx.runInTenantDatabaseScope(() =>
    resolveMCPOAuthGrantLiveness(db, params.mcpServerId as MCPServerID, ctx.submitterUserId)
  );
  if (!liveness.live) {
    console.info(
      `[widgets] event=oauth_widget_unverified server_id=${params.mcpServerId} attempt_id=${evidence.attempt_id ?? 'none'}`
    );
    throw new Forbidden(
      `Sign-in to "${params.serverName}" has not completed. Finish the provider sign-in, then try Connect again.`
    );
  }

  // c. Only now — the grant exists, so the server is useful the moment the
  // agent sees it.
  const { attached } = await attachToSession(ctx, params.mcpServerId);

  return {
    mcp_server_id: params.mcpServerId,
    name: server.display_name || server.name || params.serverName,
    oauth_mode: params.oauthMode,
    attached,
  };
}

export const oauthWidget: WidgetRegistryEntry<OAuthWidgetParams, never, OAuthWidgetResultMeta> = {
  type: 'oauth',
  resolution: 'oauth_callback',
  schemaVersion: 1,
  paramsSchema: oauthParamsSchema,
  resolveFromOAuthCallback: resolveOAuthWidgetFromCallback,
  buildAutoResumePrompt: (rm, params) => {
    const name = rm.name || params.serverName;
    if (!rm.attached) {
      return (
        `[Agor] User connected "${name}", but it could not be attached to this session — ` +
        `only the session owner or an admin can change this session's MCP servers. ` +
        `Ask them to attach "${name}", then continue.`
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
