/**
 * Widgets MCP Tools — agent-facing tools for in-conversation widget primitives.
 *
 * Three tools, one shape. Each is FIRE-AND-FORGET: the handler returns
 * immediately with `{ widget_id, status }` and the agent ends its turn. When
 * the user resolves the widget the daemon performs the side-effect, queues a
 * system-authored auto-resume prompt via the existing `/sessions/:id/prompt`
 * route, and the agent picks up where it left off on its next turn.
 *
 *  - `agor_widgets_request_env_vars`    — collect env vars / API keys.
 *  - `agor_widgets_request_gateway_token` — collect a gateway channel's tokens.
 *  - `agor_widgets_request_oauth`       — connect a third-party MCP account.
 *
 * Security contract (§5.1 of the design doc): the agent never sees resolved
 * values. Tool inputs accept only NAMES and identities; secrets reach the
 * daemon directly from the browser (`POST /widgets/:widget_id/submit`) or
 * never touch the browser at all (the OAuth lane, where the provider redirects
 * to the daemon's own callback).
 *
 * See `docs/internal/in-conversation-widgets-design-2026-05-19.md` and
 * `docs/internal/slack-mcp-oauth-connect-2026-09-16.md`.
 */

import { generateId, MessagesRepository } from '@agor/core/db';
import type {
  ChannelType,
  EnvVarMetadata,
  EnvVarScope,
  GatewayChannel,
  MCPCatalogConnectResult,
  MCPCatalogEntry,
  MCPServer,
  MessageID,
  Session,
  SessionID,
  TaskID,
  User,
  WidgetMessageMetadata,
  WidgetType,
} from '@agor/core/types';
import {
  catalogDisplayName,
  getRequiredSecretFields,
  hasMinimumRole,
  MessageRole,
  ROLES,
} from '@agor/core/types';
import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { resolveMCPOAuthGrantLiveness } from '../../services/mcp-oauth-grant-liveness.js';
import { appendSystemMessage } from '../../utils/append-system-message.js';
import { widgetAutoResumeTaskId } from '../../utils/durable-task-id.js';
import { isMcpServerUsableByCaller } from '../../utils/mcp-server-authorization.js';
import { findHostTaskForSession } from '../../utils/session-tasks.js';
import {
  type EnvVarsParams,
  envVarsParamsSchema,
  normalizeEnvVarsParams,
} from '../../widgets/env-vars/index.js';
import {
  type GatewayTokenParams,
  gatewayTokenParamsSchema,
  isSupportedGatewayTokenChannelType,
} from '../../widgets/gateway-token/index.js';
import type { OAuthWidgetParams } from '../../widgets/oauth/index.js';
import { oauthParamsSchema } from '../../widgets/oauth/index.js';
import { authorizeWidgetMint, type WidgetMintCtx } from '../../widgets/registry.js';
import { resolveSessionId } from '../resolve-ids.js';
import type { McpContext } from '../server.js';
import { sessionContextRequiredResult, textResult } from '../server.js';
import { runWithMcpTenantDatabaseScope } from '../tenant-scope.js';

function requireAdmin(ctx: McpContext, action: string): void {
  if (!hasMinimumRole(ctx.authenticatedUser?.role, ROLES.ADMIN)) {
    throw new Error(`Access denied: admin role required to ${action}`);
  }
}

/**
 * Build a short, user-visible message body for the widget transcript row.
 * Falls back to a generic phrasing when there's only one or many names; agents
 * rarely look at this string but it's what shows above the form.
 */
function widgetContentPreview(params: EnvVarsParams): string {
  const list = params.names.join(', ');
  const noun = params.names.length === 1 ? 'variable' : 'variables';
  return `Please provide ${noun} ${list}: ${params.reason}`;
}

/**
 * Check whether the user already has ALL requested names set in the chosen
 * scope. The `already_present` short-circuit (D4 in the design doc) fires
 * when this returns true.
 */
function allNamesPresentInScope(
  envVarsMeta: Record<string, EnvVarMetadata> | undefined,
  names: string[],
  scope: EnvVarScope
): boolean {
  if (!envVarsMeta) return false;
  for (const name of names) {
    const meta = envVarsMeta[name];
    if (!meta || meta.scope !== scope) return false;
  }
  return true;
}

/**
 * The context a widget type's `authorizeMint` gate decides from.
 *
 * `userId` is the PROMPT ACTOR, not the session owner — for a credential
 * widget that is the identity the credential would land under (D2).
 */
function widgetMintCtx(ctx: McpContext, sessionId: SessionID): WidgetMintCtx {
  return {
    app: ctx.app,
    sessionId,
    userId: ctx.userId,
    role: ctx.authenticatedUser?.role,
    serviceParams: ctx.baseServiceParams,
  };
}

/**
 * Create the transcript row that IS the widget.
 *
 * Every widget tool needs the same three steps and they are easy to get subtly
 * wrong, so they live here once:
 *
 *  1. Bind the message to the session's host task. `loadTaskMessages(taskId)`
 *     queries by `task_id`, so a widget message without one is orphaned —
 *     persisted, resolvable, and invisible in the conversation pane.
 *  2. Mint the widget id BEFORE the create, so the row's shared id (message id
 *     == widget id) is final and no realtime consumer ever observes a
 *     placeholder submit URL.
 *  3. Extend the host task's `message_range.end_index` so the widget falls
 *     inside the task's window (mirrors the daemon-restart injection path at
 *     `startup.ts`). Non-fatal: the widget still renders via the task_id
 *     lookup.
 *
 * It is also where a widget type's own `authorizeMint` gate runs. Putting the
 * gate on the seam every mint passes through — rather than at each call site —
 * is what stops a future minting path (stage 3's Slack projection, a new tool)
 * from silently skipping a precondition it never knew about.
 */
async function mintWidgetMessage(
  ctx: McpContext,
  input: {
    sessionId: SessionID;
    widgetType: string;
    params: unknown;
    content: string;
    contentPreview: string;
    status: WidgetMessageMetadata['status'];
    autoResume: boolean;
  }
): Promise<MessageID> {
  await authorizeWidgetMint(
    input.widgetType as WidgetType,
    widgetMintCtx(ctx, input.sessionId),
    input.params
  );
  const requestedAt = new Date().toISOString();
  const terminal = input.status !== 'pending';
  const hostTask = await findHostTaskForSession(ctx.app, input.sessionId, ctx.baseServiceParams);
  const hostTaskId = hostTask?.task_id as TaskID | undefined;
  const widgetId = generateId() as MessageID;

  const created = await runWithMcpTenantDatabaseScope(ctx, (db) =>
    appendSystemMessage({
      app: ctx.app,
      db,
      sessionId: input.sessionId,
      taskId: hostTaskId,
      content: input.content,
      contentPreview: input.contentPreview,
      type: 'widget_request',
      role: MessageRole.SYSTEM,
      messageId: widgetId,
      metadata: {
        widget: {
          widget_type: input.widgetType,
          schema_version: 1,
          params: input.params,
          status: input.status,
          requested_at: requestedAt,
          ...(terminal ? { resolved_at: requestedAt } : {}),
          auto_resume: input.autoResume,
          widget_id: widgetId,
        } satisfies WidgetMessageMetadata,
      },
    })
  );

  if (hostTask?.message_range) {
    try {
      await ctx.app.service('tasks').patch(
        hostTask.task_id,
        {
          message_range: {
            start_index: hostTask.message_range.start_index,
            end_index: created.index,
          },
        },
        { ...ctx.baseServiceParams, provider: undefined }
      );
    } catch (err) {
      // Non-fatal — widget will still render via task_id lookup.
      console.warn(`[widgets] failed to extend task.message_range for widget ${widgetId}:`, err);
    }
  }

  return widgetId;
}

/**
 * Queue the system-authored prompt that wakes the agent back up.
 *
 * Used by the short-circuit paths only — the ordinary path queues this from
 * `widgets/submissions.ts` when the user actually resolves the widget. The
 * durable idempotency id is keyed on the widget so a retried short-circuit
 * cannot double-prompt.
 */
async function queueWidgetAutoResume(
  ctx: McpContext,
  sessionId: SessionID,
  widgetId: MessageID,
  prompt: string
): Promise<void> {
  await ctx.app.service('/sessions/:id/prompt').create(
    {
      prompt,
      messageSource: 'agor',
      idempotencyTaskId: widgetAutoResumeTaskId(widgetId),
      metadata: { system_authored: true, widget_id: widgetId },
    },
    { ...ctx.baseServiceParams, provider: undefined, route: { id: sessionId } }
  );
}

/**
 * A destination the `oauth` widget can be minted against, plus the catalog
 * provenance to show alongside it.
 */
type OAuthWidgetTarget =
  | { server: MCPServer; catalogEntryName?: string; permissionDisclosure?: string }
  /** The endpoint turned out to need no sign-in; there is nothing to authorize. */
  | { short_circuit: true; server: MCPServer; reasonText: string };

/** Load and validate an MCP server the agent named directly. */
async function loadExistingOAuthServer(
  ctx: McpContext,
  mcpServerId: string
): Promise<OAuthWidgetTarget> {
  const server = (await ctx.app
    .service('mcp-servers')
    .get(mcpServerId, ctx.baseServiceParams)) as MCPServer;
  if (!isMcpServerUsableByCaller(server, ctx.baseServiceParams)) {
    // Never turn a caller-supplied id into an existence oracle.
    throw new Error('MCP server not found');
  }
  if (!server.enabled) {
    throw new Error(
      `MCP server "${server.display_name || server.name}" is disabled; enable it before connecting.`
    );
  }
  const authType = server.auth?.type ?? 'none';
  if (authType === 'none') {
    return {
      short_circuit: true,
      server,
      reasonText: `[Agor] "${server.display_name || server.name}" needs no sign-in. It is attached to this session; its tools are available on your next turn.`,
    };
  }
  if (authType !== 'oauth') {
    throw new Error(
      `MCP server "${server.display_name || server.name}" uses ${authType} auth, not OAuth. ` +
        `Use agor_widgets_request_env_vars for a key the user must paste, or connect it from the MCP Catalog.`
    );
  }
  return { server, catalogEntryName: server.catalog_entry_name };
}

/**
 * Turn a catalog entry name into an installed, inert server row.
 *
 * Goes through `mcp-catalog/connect`, which is the only reviewed path that
 * probes the endpoint, derives the auth prescription from the live answer
 * rather than the file, and stamps catalog provenance. Reusing it is also what
 * keeps this tool from being a way to register an arbitrary URL: the request
 * carries a catalog key and nothing else, so the destination is whatever the
 * checked-in file already points at.
 *
 * The install is inert on purpose. It is `scope: 'session'`, private to the
 * caller, and deliberately UNATTACHED — attaching an unauthorized OAuth server
 * is not harmless in direct egress mode (see the widget's module docs). The
 * attach happens when the grant lands, not here.
 *
 * `acknowledged_disclosure` is satisfied with the entry's own text because
 * this caller is the daemon, not a browser that skipped the drawer; the
 * disclosure is carried onto the widget and shown before the user clicks
 * Connect, which is the point at which anything is actually granted. See the
 * design doc's security section.
 */
async function installCatalogOAuthServer(
  ctx: McpContext,
  catalogEntryName: string
): Promise<OAuthWidgetTarget> {
  let entry: MCPCatalogEntry;
  try {
    entry = (await ctx.app
      .service('mcp-catalog')
      .get(catalogEntryName, ctx.baseServiceParams)) as MCPCatalogEntry;
  } catch {
    throw new Error(
      `No MCP catalog entry named "${catalogEntryName}". Use agor_mcp_catalog_list to find the exact name.`
    );
  }
  if (!entry.has_remote || !entry.remote_url) {
    throw new Error(
      `"${catalogDisplayName(entry)}" has no remote endpoint; locally-run MCP servers are configured by an admin.`
    );
  }
  if (entry.auth_type === 'credentials') {
    throw new Error(
      `"${catalogDisplayName(entry)}" is connected with an API key, not OAuth. Connect it from the MCP Catalog in Agor.`
    );
  }

  // Caller params verbatim — in particular, KEEP `provider`. Connect stamps
  // catalog provenance only for a transport-bearing caller:
  // `resolveCatalogInstall` returns early when `provider` is absent, because an
  // internal caller is expected to write `catalog_entry_name` itself, and this
  // one delegates instead. An agent calling this tool IS an authenticated
  // external caller acting for a user, so it should meet exactly the
  // authorization the browser meets.
  const result = (await ctx.app.service('mcp-catalog/connect').create(
    {
      catalog_key: entry.name,
      acknowledged_disclosure: entry.permission_disclosure,
    },
    ctx.baseServiceParams
  )) as MCPCatalogConnectResult;
  const server = result.mcp_server;

  const authType = server.auth?.type ?? 'none';
  if (authType === 'none') {
    return {
      short_circuit: true,
      server,
      reasonText: `[Agor] "${catalogDisplayName(entry)}" needs no sign-in and is attached to this session; its tools are available on your next turn.`,
    };
  }
  if (authType !== 'oauth') {
    throw new Error(
      `"${catalogDisplayName(entry)}" asked for ${authType} credentials rather than OAuth. Connect it from the MCP Catalog in Agor.`
    );
  }
  return {
    server,
    catalogEntryName: entry.name,
    permissionDisclosure: entry.permission_disclosure,
  };
}

/**
 * Attach a server that needs no further authorization and wake the agent.
 *
 * Used by both short-circuits (already connected, or no auth at all). Records
 * a terminal `already_present` widget row so the transcript still shows what
 * happened — the same status the env_vars short-circuit uses.
 */
async function attachAndResume(
  ctx: McpContext,
  sessionId: SessionID,
  server: MCPServer,
  prompt: string
) {
  const serverName = server.display_name || server.name;
  await ctx.app
    .service('/sessions/:id/mcp-servers')
    .create(
      { mcpServerId: server.mcp_server_id },
      { ...ctx.baseServiceParams, route: { id: sessionId } }
    );
  const widgetId = await mintWidgetMessage(ctx, {
    sessionId,
    widgetType: 'oauth',
    params: {
      mcpServerId: server.mcp_server_id,
      serverName,
      oauthMode: (server.auth?.oauth_mode ?? 'per_user') as 'per_user' | 'shared',
      reason: `Connect ${serverName}.`,
    } satisfies OAuthWidgetParams,
    content: `"${serverName}" is already connected.`,
    contentPreview: `Widget: oauth (${serverName}, already connected)`,
    status: 'already_present',
    autoResume: true,
  });
  await queueWidgetAutoResume(ctx, sessionId, widgetId, prompt);
  return textResult({
    widget_id: widgetId,
    status: 'already_present',
    mcp_server_id: server.mcp_server_id,
  });
}

/**
 * Retire any still-pending `oauth` widget for the same (session, server).
 *
 * Supersede rather than stack: two live Connect buttons drive the same
 * provider flow, and whichever the user ignores would sit in the transcript
 * forever. Marked `dismissed` WITHOUT queueing the dismissal prompt — the
 * agent is not being told "no", it is re-asking, and a "user declined" message
 * would be a lie.
 *
 * Best-effort: failing to tidy an old row must not stop the new request.
 */
async function supersedePendingOAuthWidgets(
  ctx: McpContext,
  sessionId: SessionID,
  mcpServerId: string
): Promise<void> {
  try {
    await runWithMcpTenantDatabaseScope(ctx, async (db) => {
      const repo = new MessagesRepository(db);
      const rows = await repo.findBySessionIdAndType(sessionId, 'widget_request');
      const resolvedAt = new Date().toISOString();
      for (const row of rows) {
        const widget = row.metadata?.widget;
        if (widget?.widget_type !== 'oauth' || widget.status !== 'pending') continue;
        if ((widget.params as OAuthWidgetParams | undefined)?.mcpServerId !== mcpServerId) continue;
        await repo.mutateMetadataLocked(row.message_id, (metadata) => {
          const current = metadata?.widget;
          // Re-read under the row lock: another daemon may have claimed it in
          // the meantime, and a `resolving` claim must never be stolen.
          if (current?.status !== 'pending') return null;
          return {
            ...metadata,
            widget: { ...current, status: 'dismissed', resolved_at: resolvedAt },
          };
        });
      }
    });
  } catch (err) {
    console.warn(
      `[widgets] failed to supersede pending oauth widgets for server ${mcpServerId}:`,
      err
    );
  }
}

export function registerWidgetTools(server: McpServer, ctx: McpContext): void {
  server.registerTool(
    'agor_widgets_request_env_vars',
    {
      description:
        'Ask the user to provide one or more environment variables via a compact in-conversation form. ' +
        'PREFER this tool whenever you need an env var, API key, or token the user has not set: call it instead of telling the user to open Settings → Environment Variables or asking them to paste a value into chat. ' +
        'FIRE-AND-FORGET: the widget renders inline; end your turn after calling. You will receive a user-role message ("[Agor] User submitted ...") when the user responds. ' +
        'Values never enter your context — only the variable NAMES do. Do NOT ask the user to paste values into chat. ' +
        'Keep `reason` to ONE short sentence (≤200 chars) — it shows as a small muted line; do not restate what the widget does or describe the security contract (the UI handles that).',
      annotations: { destructiveHint: false, openWorldHint: false },
      inputSchema: envVarsParamsSchema,
    },
    async (args) => {
      if (!ctx.sessionId) return sessionContextRequiredResult();
      const currentSessionId = ctx.sessionId;
      // Validated by Zod via the SDK; parse here too so defaults are applied
      // in direct callers and tests. Keep ordering normalization outside the
      // schema because Zod transforms degrade MCP JSON Schema discovery.
      const toolParams = normalizeEnvVarsParams(envVarsParamsSchema.parse(args));

      // MCP session tokens are minted for the current prompt's actor. Use that
      // same identity for environment variables even when the actor is
      // prompting a shared Session owned by someone else.
      const promptActor = (await ctx.app
        .service('users')
        .get(ctx.userId, ctx.baseServiceParams)) as User;

      const params: EnvVarsParams = toolParams;

      // `already_present` short-circuit: if every requested name is already
      // set globally for this user, skip the form entirely and auto-resume
      // the agent. Global-only check is intentional — session-scoped values
      // depend on session_env_selections which we don't read here.
      const presentEverywhere = allNamesPresentInScope(
        promptActor.env_vars,
        params.names,
        'global' as EnvVarScope
      );

      const widgetId = await mintWidgetMessage(ctx, {
        sessionId: currentSessionId,
        widgetType: 'env_vars',
        params,
        content: widgetContentPreview(params),
        contentPreview: `Widget: env_vars (${params.names.join(', ')})`,
        status: presentEverywhere ? 'already_present' : 'pending',
        autoResume: params.auto_resume,
      });

      if (presentEverywhere) {
        // Short-circuit: no form render. Auto-queue a "values already
        // configured" task (unless the agent opted out via auto_resume:false).
        if (params.auto_resume) {
          const namesList = params.names.join(', ');
          const verb = params.names.length === 1 ? 'was' : 'were';
          await queueWidgetAutoResume(
            ctx,
            currentSessionId,
            widgetId,
            `[Agor] ${namesList} ${verb} already configured. You can proceed.`
          );
        }
        return textResult({ widget_id: widgetId, status: 'already_present' });
      }

      return textResult({ widget_id: widgetId, status: 'requested' });
    }
  );

  server.registerTool(
    'agor_widgets_request_oauth',
    {
      description:
        'Ask the user to connect a third-party MCP server account (Notion, Linear, Sentry, ...) by rendering an inline Connect button that runs the real OAuth sign-in in their browser. ' +
        'PREFER this tool whenever the user asks you to "connect me to X" or a task needs an MCP server they have not authorized: call it instead of telling them to open Settings or the MCP Catalog. ' +
        'Resolve the server FIRST: use `agor_mcp_catalog_list` to turn a product name into a `catalogEntryName` (e.g. "Notion" -> "com.notion/mcp"), or `agor_mcp_servers_list` for a server that already exists. NEVER invent a URL — pass exactly one of `mcpServerId` or `catalogEntryName`. ' +
        'FIRE-AND-FORGET: the widget renders inline at the end of your turn; end your turn after calling. You will receive a user-role message when it resolves. ' +
        'If the account is already connected the tool attaches it and resumes you immediately (status "already_present") — no button is shown. ' +
        'Tokens never enter your context: only the server name and OAuth mode do. The server is attached to this session only AFTER the grant lands, so its tools appear on a later turn, not this one. ' +
        'Keep `reason` to ONE short sentence (<=200 chars).',
      annotations: { destructiveHint: false, openWorldHint: false },
      inputSchema: z.strictObject({
        mcpServerId: z
          .string()
          .min(1)
          .optional()
          .describe('An existing MCP server to authorize (UUIDv7 or short ID).'),
        catalogEntryName: z
          .string()
          .min(1)
          .optional()
          .describe(
            'Reverse-DNS catalog name from `agor_mcp_catalog_list`, e.g. "com.notion/mcp". Installs the entry if the user does not have it yet.'
          ),
        reason: z
          .string()
          .max(200)
          .optional()
          .describe('One short sentence explaining why the connection is needed.'),
        sessionId: z
          .string()
          .min(1)
          .optional()
          .describe('Target session. Defaults to the current session.'),
      }),
    },
    async (args) => {
      // Exactly one destination. Accepting both would leave the daemon
      // choosing which the agent meant; accepting neither leaves it inventing
      // one, which is the failure mode this tool exists to remove.
      const named = [args.mcpServerId, args.catalogEntryName].filter(Boolean).length;
      if (named !== 1) {
        throw new Error(
          'Pass exactly one of mcpServerId or catalogEntryName. Use agor_mcp_catalog_list to resolve a product name to a catalog entry.'
        );
      }
      const targetSessionId = args.sessionId
        ? ((await resolveSessionId(ctx, args.sessionId)) as SessionID)
        : ctx.sessionId;
      if (!targetSessionId) return sessionContextRequiredResult();

      const session = (await ctx.app
        .service('sessions')
        .get(targetSessionId, ctx.baseServiceParams)) as Session;

      // Minting into someone else's session would put a Connect button in
      // their transcript for a server only they can attach. Same floor the
      // attach itself applies (`checkSessionOwnerOrAdmin`).
      if (
        targetSessionId !== ctx.sessionId &&
        session.created_by !== ctx.userId &&
        !hasMinimumRole(ctx.authenticatedUser?.role, ROLES.ADMIN)
      ) {
        throw new Error(
          'Only the session owner or an admin can request a connection for another session.'
        );
      }

      // Run the widget type's own mint gate EARLY, before resolving a
      // destination. `mintWidgetMessage` runs it again with the full params and
      // is the enforcement point — this call exists only so a refusal (an
      // unaligned gateway channel, say) happens before a catalog install puts
      // an orphan server row in the database. Skipping it would cost an orphan,
      // not a missed check.
      await authorizeWidgetMint('oauth', widgetMintCtx(ctx, targetSessionId));

      // Resolve the destination server row. Both branches end with an enabled
      // OAuth server row owned/usable by the caller, or a refusal.
      const resolved = args.mcpServerId
        ? await loadExistingOAuthServer(ctx, args.mcpServerId)
        : await installCatalogOAuthServer(ctx, args.catalogEntryName as string);
      if ('short_circuit' in resolved) {
        // The entry needs no sign-in at all. Attach and resume rather than
        // rendering a Connect button that would open a flow nobody asked for.
        return attachAndResume(ctx, targetSessionId, resolved.server, resolved.reasonText);
      }
      const { server, catalogEntryName, permissionDisclosure } = resolved;
      const oauthMode = (server.auth?.oauth_mode ?? 'per_user') as 'per_user' | 'shared';
      const serverName = server.display_name || server.name;
      const params: OAuthWidgetParams = oauthParamsSchema.parse({
        mcpServerId: server.mcp_server_id,
        serverName,
        oauthMode,
        reason: args.reason ?? `Connect ${serverName} so its tools are available in this session.`,
        ...(catalogEntryName ? { catalogEntryName } : {}),
        ...(permissionDisclosure ? { permissionDisclosure } : {}),
      });

      // The full gate, now that the destination decided the OAuth mode. Same
      // hook `mintWidgetMessage` will run; called here so a refusal lands
      // before the already-connected branch can attach anything.
      await authorizeWidgetMint('oauth', widgetMintCtx(ctx, targetSessionId), params);

      // Already-connected short-circuit: a live grant means there is nothing
      // to sign in to. Attach and resume immediately.
      const liveness = await runWithMcpTenantDatabaseScope(ctx, (db) =>
        resolveMCPOAuthGrantLiveness(db, server.mcp_server_id, ctx.userId)
      );
      if (liveness.live) {
        return attachAndResume(
          ctx,
          targetSessionId,
          server,
          `[Agor] "${serverName}" was already connected for you. It is attached to this session; its tools are available on your next turn.`
        );
      }

      // One live Connect button per (session, server). A second request
      // supersedes the first rather than stacking buttons that all drive the
      // same flow and would each queue their own auto-resume.
      await supersedePendingOAuthWidgets(ctx, targetSessionId, server.mcp_server_id);

      const widgetId = await mintWidgetMessage(ctx, {
        sessionId: targetSessionId,
        widgetType: 'oauth',
        params,
        content: `Connect "${serverName}": ${params.reason}`,
        contentPreview: `Widget: oauth (${serverName})`,
        status: 'pending',
        autoResume: true,
      });

      return textResult({ widget_id: widgetId, status: 'requested' });
    }
  );

  server.registerTool(
    'agor_widgets_request_gateway_token',
    {
      description:
        "Ask an admin to securely provide a gateway channel's platform credentials (Slack xoxb-/xapp- tokens, Discord bot token, GitHub private key, Teams app password) via a compact form that appears at the end of your message. Never ask for any secret in chat. " +
        'PREFER this tool over telling the admin to open Settings and paste tokens manually: it collects and verifies the credentials inline. ' +
        'FIRE-AND-FORGET: the widget renders inline at the end of your turn; end your turn after calling. You will receive a user-role message when it is resolved. ' +
        'Token values never enter your context — only the channel identity and field NAMES do. ' +
        'Admin-only: a non-admin agent cannot mint this widget. Keep `reason` to ONE short sentence (≤200 chars).',
      annotations: { destructiveHint: false, openWorldHint: false },
      inputSchema: z.object({
        gatewayChannelId: z
          .string()
          .min(1)
          .describe('Gateway channel ID (UUIDv7 or short ID) whose tokens are being set.'),
        reason: z
          .string()
          .max(200)
          .optional()
          .describe('One short sentence explaining why the tokens are needed.'),
      }),
    },
    async (args) => {
      if (!ctx.sessionId) return sessionContextRequiredResult();
      const currentSessionId = ctx.sessionId;
      requireAdmin(ctx, 'set gateway channel tokens');

      // Redacted read — secrets come back as sentinels, but the non-secret
      // fields we need (type, name, connection_mode) are intact.
      const channel = (await ctx.app
        .service('gateway-channels')
        .get(args.gatewayChannelId, ctx.baseServiceParams)) as GatewayChannel;
      const hostSession = (await ctx.app
        .service('sessions')
        .get(currentSessionId, ctx.baseServiceParams)) as Session;
      if (!hostSession.branch_id || channel.target_branch_id !== hostSession.branch_id) {
        throw new Error("Gateway channel is not bound to this session's target branch");
      }
      const channelType = channel.channel_type as ChannelType;
      if (!isSupportedGatewayTokenChannelType(channelType)) {
        throw new Error(
          `Gateway channel type "${channelType}" does not support token entry via this widget.`
        );
      }
      const fields = getRequiredSecretFields(channelType, channel.config);
      if (fields.length === 0) {
        throw new Error(
          `Gateway channel "${channel.name}" has no required secret fields to collect.`
        );
      }

      const params: GatewayTokenParams = gatewayTokenParamsSchema.parse({
        gatewayChannelId: channel.id,
        channelType,
        channelName: channel.name,
        fields,
        reason:
          args.reason ??
          `Provide the ${channelType} credentials to finish connecting "${channel.name}".`,
      });

      const widgetId = await mintWidgetMessage(ctx, {
        sessionId: currentSessionId,
        widgetType: 'gateway_token',
        params,
        content: `Please provide the ${channelType} tokens for "${channel.name}": ${params.reason}`,
        contentPreview: `Widget: gateway_token (${channel.name})`,
        status: 'pending',
        autoResume: true,
      });

      return textResult({ widget_id: widgetId, status: 'requested' });
    }
  );
}
