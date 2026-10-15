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
 *  - `agor_widgets_request_oauth`       — connect a third-party MCP account
 *    (OAuth sign-in, or the catalog drawer's key form for an API-key entry).
 *
 * Security contract (§5.1 of the design doc): the agent never sees resolved
 * values. Tool inputs accept only NAMES and identities; secrets reach the
 * daemon directly from the browser (`POST /widgets/:widget_id/submit`) or
 * never touch the browser at all (the OAuth lane, where the provider redirects
 * to the daemon's own callback).
 */

import { getBaseUrl } from '@agor/core/config';
import { generateId, MessagesRepository } from '@agor/core/db';
import { findCatalogEntry, loadCatalog } from '@agor/core/mcp-catalog';
import type {
  AuthenticatedParams,
  ChannelType,
  EnvVarMetadata,
  EnvVarScope,
  GatewayChannel,
  MCPCatalogConnectResult,
  MCPCatalogEntry,
  MCPCatalogReadiness,
  MCPCatalogSharing,
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
  isGatewaySession,
  MCP_CONNECT_WIDGET_QUERY_PARAM,
  MessageRole,
  ROLES,
  readCredentialRequirement,
} from '@agor/core/types';
import { getSessionUrl } from '@agor/core/utils/url';
import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import {
  catalogServerTransport,
  isCurrentCatalogInstallOfEntry,
} from '../../services/mcp-catalog-install-policy.js';
import {
  mcpOAuthGrantIsConnected,
  resolveMCPOAuthGrantLiveness,
} from '../../services/mcp-oauth-grant-liveness.js';
import { appendSystemMessage } from '../../utils/append-system-message.js';
import { isBrowserReachableUrl } from '../../utils/browser-reachable-url.js';
import { widgetAutoResumeTaskId } from '../../utils/durable-task-id.js';
import {
  classifyGatewayReadFailure,
  type GatewayReadFailureCategory,
} from '../../utils/gateway-read-failure.js';
import {
  authorizeMcpServerWrite,
  isMcpServerUsableByCaller,
  type McpCatalogInstallParams,
} from '../../utils/mcp-server-authorization.js';
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
import {
  mayConfigureSessionMcpServers,
  OAUTH_PERMISSION_DISCLOSURE_MAX,
  type OAuthWidgetParams,
  type OAuthWidgetResultMeta,
  oauthNotAttachedGuidance,
  oauthParamsSchema,
} from '../../widgets/oauth/index.js';
import {
  authorizeWidgetMint,
  parseWidgetMintParams,
  type WidgetMintCtx,
} from '../../widgets/registry.js';
import {
  WIDGET_RESOLUTION_STORE_KEY,
  type WidgetResolutionStore,
} from '../../widgets/resolution-store.js';
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
 * It is also where a widget type's own `paramsSchema` and `authorizeMint` gate
 * run. Putting both on the seam every mint passes through — rather than at
 * each call site — is what stops a future minting path from silently skipping
 * a precondition, or freezing an unvalidated `params` blob onto a row three
 * surfaces render from.
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
    /**
     * Stamp the durable "this widget owes a gateway card" marker.
     *
     * Only meaningful while the row is `pending`, and only for a widget whose
     * session came from a gateway thread. The projection is Slack-only today
     * and clears the marker on its first visit for anything it can never post
     * — see `GatewayService.deliverMcpSlackConnectCard`.
     */
    gatewayCard?: boolean;
    /** Outcome for a row minted already terminal (the oauth shortcut's D6 `attached`). */
    resultMeta?: unknown;
  }
): Promise<MessageID> {
  const params = parseWidgetMintParams(input.widgetType as WidgetType, input.params);
  await authorizeWidgetMint(
    input.widgetType as WidgetType,
    widgetMintCtx(ctx, input.sessionId),
    params
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
          params,
          status: input.status,
          requested_at: requestedAt,
          ...(terminal ? { resolved_at: requestedAt } : {}),
          ...(terminal && input.resultMeta !== undefined ? { result_meta: input.resultMeta } : {}),
          auto_resume: input.autoResume,
          widget_id: widgetId,
          // Written in the SAME row insert as the widget, so the repair sweep
          // owns the first card from instant zero. Without it the only trigger
          // is `queueMcpSlackConnectCard`'s in-process defer, and a restart —
          // or any throw before the first `issueMCPOAuthConnectLink` commits —
          // orphans the widget's gateway face permanently and silently, after
          // the user was told to expect a card.
          ...(input.gatewayCard && !terminal ? { slack_connect_due_at: requestedAt } : {}),
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
 * Ask the gateway to project this widget into its Slack thread, if it has one.
 *
 * The gateway decides whether there is a thread at all — this tool does not
 * know and should not learn. Silent on every failure for the same reason the
 * store hook is: the widget row already carries `slack_connect_due_at`, so the
 * bounded repair sweep owns the card whether or not this defer ever runs. This
 * is the latency optimization on top of that, not the trigger.
 */
function queueMcpSlackConnectCard(ctx: McpContext, widgetId: MessageID): void {
  try {
    const gateway = ctx.app.service('gateway') as unknown as {
      syncMcpSlackConnectCardAfterCommit?: (id: MessageID, params?: unknown) => void;
    };
    gateway?.syncMcpSlackConnectCardAfterCommit?.(widgetId, ctx.baseServiceParams);
  } catch {
    console.warn('[widgets] MCP connect card projection could not be queued');
  }
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
 * Schema maxima `oauthParamsSchema` enforces, repeated here because the fields
 * they bound are decided before the parse runs — and, for the catalog install,
 * before a durable row exists to be orphaned by a late failure.
 */
const SERVER_NAME_MAX = 200;
const REASON_MAX = 200;
const CATALOG_ENTRY_NAME_MAX = 200;

/**
 * Clamp a DISPLAY string the daemon composes to what the widget schema accepts,
 * with an ellipsis so a reader can see it was cut.
 *
 * Only for fields whose job is to be read at a glance — a server's display
 * name, the one-line reason. Never for the permission disclosure: that one is
 * the consent, and losing its tail is losing the part of it a reader would most
 * want. See {@link OAUTH_PERMISSION_DISCLOSURE_MAX} and §5.4.
 */
function clampToSchemaMax(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`;
}

/**
 * A destination the `oauth` widget can be minted against, plus the catalog
 * provenance to show alongside it.
 */
type OAuthWidgetTarget =
  | {
      server: MCPServer;
      catalogEntryName?: string;
      permissionDisclosure?: string;
      /**
       * Set when the server came from the catalog but its disclosure cannot be
       * shown. Thrown only where a pending Connect button would be minted —
       * an already-connected server shows no button, so there is nothing for
       * the missing text to precede.
       */
      disclosureRefusal?: string;
    }
  /** The endpoint turned out to need no sign-in; there is nothing to authorize. */
  | {
      short_circuit: true;
      server: MCPServer;
      label: string;
      /** An existing keyed install, rather than an endpoint with no auth. */
      alreadyConnected?: true;
    }
  /**
   * The entry needs a credential the user must enter (an API key). Nothing is
   * installed: the card opens the catalog drawer, whose Connect is the install.
   */
  | { catalog_connect: true; entry: MCPCatalogEntry };

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
    return { short_circuit: true, server, label: server.display_name || server.name };
  }
  if (authType !== 'oauth') {
    throw new Error(
      `MCP server "${server.display_name || server.name}" uses ${authType} auth, not OAuth. ` +
        (server.catalog_entry_name
          ? `To have the user enter a new key, pass catalogEntryName "${server.catalog_entry_name}" instead.`
          : 'Ask the user to update it in Agor → Settings → MCP Servers.')
    );
  }
  if (!server.catalog_entry_name) return { server };
  return {
    server,
    catalogEntryName: server.catalog_entry_name,
    ...(await installedCatalogDisclosure(server)),
  };
}

/**
 * The disclosure for a server installed from the catalog, re-read from the entry.
 *
 * Pressing Connect is the consent, so the access statement has to be on the
 * card above that button. The row does not store it, so a later request by
 * `mcpServerId` — which supersedes the widget that carried it — has to fetch it
 * again, or the replacement button appears with no disclosure at all.
 *
 * An entry that has left the catalog, or cannot be read, yields a refusal
 * rather than a button with no disclosure or a generic one: the contract is
 * that the user reads what the entry discloses before connecting, and there is
 * no longer any text to show. The user can still connect the server
 * themselves from My Servers. The same length refusal as the catalog path
 * applies, for the same reason: Agor does not shorten what someone agrees to.
 */
async function installedCatalogDisclosure(
  server: MCPServer
): Promise<{ permissionDisclosure?: string; disclosureRefusal?: string }> {
  const serverLabel = server.display_name || server.name;
  let entry: MCPCatalogEntry;
  try {
    // The caller has already authorized this saved server. Hiding discovery
    // must not remove its reconnect disclosure; removed definitions still fail closed.
    const definition = findCatalogEntry(await loadCatalog(), server.catalog_entry_name as string);
    if (!definition) throw new Error('Catalog definition removed');
    entry = definition;
  } catch {
    return {
      disclosureRefusal:
        `"${serverLabel}" was installed from the MCP Catalog entry "${server.catalog_entry_name}", ` +
        `which Agor can no longer load, so it cannot show what it can access before you connect. ` +
        `Connect it from My Servers in Agor instead.`,
    };
  }
  if ((entry.permission_disclosure?.length ?? 0) > OAUTH_PERMISSION_DISCLOSURE_MAX) {
    return { disclosureRefusal: disclosureTooLongMessage(entry) };
  }
  return entry.permission_disclosure ? { permissionDisclosure: entry.permission_disclosure } : {};
}

/** Refusal for a disclosure past {@link OAUTH_PERMISSION_DISCLOSURE_MAX}; see §5.4. */
function disclosureTooLongMessage(entry: MCPCatalogEntry): string {
  return (
    `"${catalogDisplayName(entry)}" has a permission disclosure too long to show before ` +
    `connecting, and Agor will not shorten what you are agreeing to; report this entry.`
  );
}

/**
 * The caller's own (or shared) enabled install of `entry` that still matches
 * it — the same `isCurrentCatalogInstallOfEntry` the resolve lane accepts —
 * preferring one the caller owns.
 */
async function findUsableCatalogInstall(
  ctx: McpContext,
  entry: MCPCatalogEntry
): Promise<MCPServer | undefined> {
  if (!entry.remote_url) return undefined;
  const result = (await ctx.app.service('mcp-servers').find({
    ...ctx.baseServiceParams,
    query: {
      enabled: true,
      source: 'catalog',
      catalogEntryName: entry.name,
      usableByUserId: ctx.userId,
      $limit: 50,
    },
  })) as MCPServer[] | { data: MCPServer[] };
  const rows = (Array.isArray(result) ? result : result.data).filter(
    (server) =>
      isMcpServerUsableByCaller(server, ctx.baseServiceParams) &&
      isCurrentCatalogInstallOfEntry(server, entry as MCPCatalogEntry & { remote_url: string })
  );
  return rows.find((server) => server.owner_user_id === ctx.userId) ?? rows[0];
}

/**
 * Where a request for an entry the drawer connects ends up.
 *
 * An existing usable install wins, exactly as on the OAuth lane, where Connect
 * would reuse it: an open or keyed install is attached and resumed, and an
 * OAuth one goes through the ordinary pinned card (or attaches, if signed in).
 * Only with nothing installed is a drawer card minted — refused first if the
 * drawer's install would be. The OAuth lane learns member policy from its
 * mint-time install; this one asks the same side-effect-free write decision
 * and refuses with the same words, rather than minting a card whose Connect
 * the drawer then disables.
 */
async function catalogConnectTarget(
  ctx: McpContext,
  entry: MCPCatalogEntry
): Promise<OAuthWidgetTarget> {
  const existing = await findUsableCatalogInstall(ctx, entry);
  if (existing) {
    return existing.auth?.type === 'oauth'
      ? {
          server: existing,
          catalogEntryName: entry.name,
          ...(entry.permission_disclosure
            ? { permissionDisclosure: entry.permission_disclosure }
            : {}),
        }
      : {
          short_circuit: true,
          server: existing,
          label: catalogDisplayName(entry),
          ...(existing.auth?.type === 'bearer' ? { alreadyConnected: true as const } : {}),
        };
  }
  const installParams: AuthenticatedParams & McpCatalogInstallParams = {
    ...ctx.baseServiceParams,
    mcpCatalogInstall: { entry_name: entry.name },
  };
  await runWithMcpTenantDatabaseScope(ctx, (db) =>
    authorizeMcpServerWrite(db, installParams, {
      method: 'create',
      data: { transport: catalogServerTransport(entry) },
    })
  );
  return { catalog_connect: true, entry };
}

/**
 * Turn a catalog entry name into an installed, inert server row — or, for an
 * entry that needs something the user must type (a key, or their own OAuth
 * app's credentials), into a catalog-connect target with nothing installed
 * (see {@link mintCatalogConnectWidget}).
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
 * The disclosure is carried onto the widget and shown above Connect, which is
 * the point at which anything is actually granted — the same implied consent
 * the catalog drawer uses.
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
  // Everything the widget row will carry from this entry is checked BEFORE the
  // install, because the install is the first durable effect: an entry whose
  // fields exceed `oauthParamsSchema`'s limits used to leave an installed
  // server row behind and then fail the tool. Both checks refuse rather than
  // trim, here, where refusing still costs nothing:
  //
  //  - the entry NAME is an identity and cannot be shortened without
  //    corrupting it;
  //  - the DISCLOSURE is what the user consents to by pressing Connect, so
  //    quietly discarding its tail would hollow out that consent. An entry
  //    nobody can connect is a curation bug someone fixes; a disclosure with
  //    its last sentence missing is one nobody ever notices.
  if (entry.name.length > CATALOG_ENTRY_NAME_MAX) {
    throw new Error(
      `Catalog entry name "${entry.name}" is too long for a connect request; report this entry.`
    );
  }
  if ((entry.permission_disclosure?.length ?? 0) > OAUTH_PERMISSION_DISCLOSURE_MAX) {
    throw new Error(disclosureTooLongMessage(entry));
  }
  const permissionDisclosure = entry.permission_disclosure || undefined;
  // A key the user types can only go through the catalog drawer's own Connect,
  // so there is nothing to install here.
  if (entry.auth_type === 'credentials') return catalogConnectTarget(ctx, entry);
  // A customer-owned OAuth app is entered once, in the drawer, by whoever
  // creates the install; connect refuses without it. Only an existing shared
  // install already carries one — the same readiness answer the drawer reads to
  // decide `reusesSharedApp` — and then connect reuses it as `shared`.
  let sharing: MCPCatalogSharing | undefined;
  if (entry.oauth?.configured_client) {
    const readiness = (await ctx.app.service('mcp-catalog/readiness').get(entry.name, {
      ...ctx.baseServiceParams,
      query: { sharing: 'shared' },
    })) as MCPCatalogReadiness;
    if (!readiness.shared_configuration_available) return catalogConnectTarget(ctx, entry);
    sharing = 'shared';
  }

  // Caller params verbatim — in particular, KEEP `provider`. Connect stamps
  // catalog provenance only for a transport-bearing caller:
  // `resolveCatalogInstall` returns early when `provider` is absent, because an
  // internal caller is expected to write `catalog_entry_name` itself, and this
  // one delegates instead. An agent calling this tool IS an authenticated
  // external caller acting for a user, so it should meet exactly the
  // authorization the browser meets.
  let result: MCPCatalogConnectResult;
  try {
    result = (await ctx.app
      .service('mcp-catalog/connect')
      .create(
        { catalog_key: entry.name, ...(sharing ? { sharing } : {}) },
        ctx.baseServiceParams
      )) as MCPCatalogConnectResult;
  } catch (error) {
    // The live endpoint asked for a key the entry did not advertise. Same
    // answer as a `credentials` entry: the user enters it in the drawer.
    if (readCredentialRequirement(error) === 'required') return catalogConnectTarget(ctx, entry);
    throw error;
  }
  const server = result.mcp_server;

  const authType = server.auth?.type ?? 'none';
  if (authType === 'none') {
    return { short_circuit: true, server, label: catalogDisplayName(entry) };
  }
  if (authType !== 'oauth') {
    throw new Error(
      `"${catalogDisplayName(entry)}" asked for ${authType} credentials rather than OAuth. Connect it from the MCP Catalog in Agor.`
    );
  }
  return { server, catalogEntryName: entry.name, permissionDisclosure };
}

/**
 * What this mint can honestly tell the agent about where to send the user.
 *
 * Three answers, not two, and the third is the point. The previous shape
 * returned `string | null`, and `null` meant BOTH "canvas session, the user is
 * already looking at the transcript" and "gateway session, no link could be
 * built". The tool's own description then defined the absence of `session_url`
 * as the first of those — "you are in a thread where the user cannot see the
 * card" was the positive case — so a deployment that could not build a link
 * handed the agent a result that says, in the contract it was given, that the
 * user can see the card. On 2026-09-16 the agent did exactly what it was told
 * and promised a button nobody could see.
 */
type GatewaySessionConnectLink =
  /** Not a gateway session. The user is looking at the transcript already. */
  | { kind: 'not_gateway' }
  /** A link this session's user can open. */
  | { kind: 'url'; url: string }
  /** A gateway session with NO link. The one answer that used to be silent. */
  | { kind: 'unavailable'; reason: GatewayReadFailureCategory | 'not_browser_reachable' };

/**
 * Where a gateway user has to go to press Connect.
 *
 * The widget renders in the Agor transcript. For a session that came from
 * Slack, Discord, GitHub or Teams, that transcript is a page the user is not
 * looking at. Slack now gets a Block Kit card in its own thread (§7); every
 * other platform still does not, and even on Slack the card can be refused —
 * an unaligned channel, a moved binding, a deployment with no
 * `AGOR_MASTER_SECRET` or no public URL, or the operator kill switch. So a
 * gateway session can pass the alignment guard, mint a real widget, and still
 * have nothing to show for it.
 *
 * So EVERY gateway-sourced mint carries the session URL back to the agent, to
 * relay into the thread — including Slack's, where it is the fallback the card
 * degrades to rather than a duplicate of it. `unavailable` covers a hosted
 * tenant whose routing metadata has not landed (`getBaseUrl` answers `''`), a
 * resolution that threw, and a base URL that is a bind or loopback address
 * rather than somewhere else's browser can reach — the shared
 * `isBrowserReachableUrl` predicate the Slack card's `no_public_url` refusal
 * uses, for the same reason: a link nobody can open is worse than none,
 * because the agent will relay it.
 */
async function gatewaySessionConnectUrl(
  ctx: McpContext,
  session: Pick<Session, 'custom_context'>,
  sessionId: SessionID
): Promise<GatewaySessionConnectLink> {
  if (!isGatewaySession(session)) return { kind: 'not_gateway' };
  let url: string;
  try {
    // Hosted deployments resolve this from durable tenant routing, which needs
    // a tenant database scope — and an MCP tool boundary enters tenant CONTEXT
    // only. A bare `getBaseUrl()` here threw
    // "Tenant public links require a tenant database" straight into the catch
    // below, so every gateway mint on the cloud stack returned no
    // `session_url` and no `relay_to_user`: the agent was left promising a
    // button the Slack user could not see, and the kill-switch runbook's
    // "the deep link always still works" promise was not true on any platform.
    const baseUrl = await runWithMcpTenantDatabaseScope(ctx, (db) => getBaseUrl(db));
    url = getSessionUrl(sessionId, baseUrl);
  } catch (error) {
    // Admin-actionable detail stays HERE. The sentence the agent relays goes
    // into a Slack channel, so it names no configuration key and no hostname.
    console.warn(
      `[widgets] event=gateway_session_link_unavailable session_id=${sessionId} reason=${classifyGatewayReadFailure(
        error
      )}`
    );
    return { kind: 'unavailable', reason: classifyGatewayReadFailure(error) };
  }
  if (!isBrowserReachableUrl(url)) {
    console.warn(
      `[widgets] event=gateway_session_link_unavailable session_id=${sessionId} reason=not_browser_reachable`
    );
    return { kind: 'unavailable', reason: 'not_browser_reachable' };
  }
  return { kind: 'url', url };
}

/**
 * What to say in the thread when there is no link to give.
 *
 * Relayed verbatim into a Slack/Discord/GitHub conversation, so it names no
 * configuration key, no hostname and no internal category — those are in the
 * daemon log, where the person who can act on them is looking.
 */
const GATEWAY_SESSION_LINK_UNAVAILABLE_TEXT =
  'I could not get a link to this Agor session, so there is nothing for you to click here yet. ' +
  "Ask an Agor administrator to check this workspace's public link setup, then ask me again.";

/** The `session_url` / `link_unavailable` fields a gateway mint hands the agent. */
function gatewayRelayFields(
  link: GatewaySessionConnectLink,
  relay: (url: string) => string
): Record<string, unknown> {
  if (link.kind === 'url') return { session_url: link.url, relay_to_user: relay(link.url) };
  if (link.kind === 'unavailable') {
    return { link_unavailable: true, relay_to_user: GATEWAY_SESSION_LINK_UNAVAILABLE_TEXT };
  }
  return {};
}

/** The card's one-line reason; the widget schema requires a non-empty one. */
function widgetReason(reason: string | undefined, serverName: string): string {
  // `?? default` does not substitute for an empty string, so fall back on
  // anything blank. The fallback interpolates a name that is itself only
  // bounded at 200, so it is clamped too rather than trusted to fit.
  return clampToSchemaMax(
    reason?.trim() || `Connect ${serverName} so its tools are available in this session.`,
    REASON_MAX
  );
}

/**
 * Mint a Connect card for a catalog entry the user connects through the
 * catalog drawer — an entry that needs a key, or the user's own OAuth app
 * credentials, typed into the drawer's secure form.
 *
 * Nothing is installed or attached here. The card opens the same drawer the
 * MCP Catalog uses, whose Connect calls `mcp-catalog/connect` straight from the
 * browser, so member policy, egress, and secret storage are that path's and
 * no secret reaches this tool or the agent. The card then resolves with
 * the install it made, which the resolve handler accepts only if it is a
 * caller-usable install of this entry.
 *
 * No Slack card, because a secret cannot be typed into Slack: a gateway user gets
 * a session link that opens the drawer on arrival.
 */
async function mintCatalogConnectWidget(
  ctx: McpContext,
  session: Session,
  entry: MCPCatalogEntry,
  reason: string | undefined
) {
  const sessionId = session.session_id as SessionID;
  const serverName = clampToSchemaMax(catalogDisplayName(entry), SERVER_NAME_MAX);
  const params: OAuthWidgetParams = oauthParamsSchema.parse({
    serverName,
    oauthMode: 'per_user',
    reason: widgetReason(reason, serverName),
    catalogEntryName: entry.name,
    ...(entry.permission_disclosure ? { permissionDisclosure: entry.permission_disclosure } : {}),
  });
  await supersedePendingOAuthWidgets(ctx, sessionId, { catalogEntryName: entry.name });
  const widgetId = await mintWidgetMessage(ctx, {
    sessionId,
    widgetType: 'oauth',
    params,
    content: `Connect "${serverName}": ${params.reason}`,
    contentPreview: `Widget: oauth (${serverName})`,
    status: 'pending',
    autoResume: true,
  });
  const link = await gatewaySessionConnectUrl(ctx, session, sessionId);
  if (link.kind === 'url') {
    const deepLink = new URL(link.url);
    deepLink.searchParams.set(MCP_CONNECT_WIDGET_QUERY_PARAM, widgetId);
    link.url = deepLink.toString();
  }
  return textResult({
    widget_id: widgetId,
    status: 'requested',
    ...gatewayRelayFields(
      link,
      (url) =>
        `Open ${url} to connect "${serverName}". Please don't paste keys or secrets into this chat.`
    ),
  });
}

/**
 * Attach a server that needs no further authorization and wake the agent.
 *
 * Used by both short-circuits (already connected, or no auth at all). Records
 * a terminal `already_present` widget row so the transcript still shows what
 * happened — the same status the env_vars short-circuit uses.
 *
 * Same order as the resolve path (D6), because the failure is the same one:
 * a collaborator who may prompt a shared session may not change its MCP
 * servers, and the attach route refuses them. So permission is ASKED first
 * rather than learned from the attach throwing, and a caller who may not attach
 * still gets the `already_present` row — with `attached: false` and the same
 * "ask the owner" guidance the resolve path gives — instead of an exception
 * after the fact. Any other attach failure propagates, as it does there.
 *
 * Superseding comes LAST, once the replacement row exists. A stale Connect
 * button for a connection that already exists would run a full unnecessary
 * re-authorization; but retiring it before the outcome is known left a
 * failed attach with the button gone and nothing in its place.
 */
async function attachAndResume(
  ctx: McpContext,
  session: Session,
  server: MCPServer,
  outcome: { label: string; connected: 'needs no sign-in' | 'was already connected for you' }
) {
  const sessionId = session.session_id as SessionID;
  const serverName = clampToSchemaMax(server.display_name || server.name, SERVER_NAME_MAX);
  const oauthMode = (server.auth?.oauth_mode ?? 'per_user') as 'per_user' | 'shared';
  const attached = mayConfigureSessionMcpServers(
    { user_id: ctx.userId, role: ctx.authenticatedUser?.role },
    session
  );
  if (attached) {
    await ctx.app
      .service('/sessions/:id/mcp-servers')
      .create(
        { mcpServerId: server.mcp_server_id },
        { ...ctx.baseServiceParams, route: { id: sessionId } }
      );
  }
  const widgetId = await mintWidgetMessage(ctx, {
    sessionId,
    widgetType: 'oauth',
    params: {
      mcpServerId: server.mcp_server_id,
      serverName,
      oauthMode,
      reason: clampToSchemaMax(`Connect ${serverName}.`, REASON_MAX),
    } satisfies OAuthWidgetParams,
    content: `"${serverName}" is already connected.`,
    contentPreview: `Widget: oauth (${serverName}, already connected)`,
    status: 'already_present',
    autoResume: true,
    resultMeta: {
      mcp_server_id: server.mcp_server_id,
      name: serverName,
      oauth_mode: oauthMode,
      attached,
    } satisfies OAuthWidgetResultMeta,
  });
  await supersedePendingOAuthWidgets(ctx, sessionId, {
    mcpServerId: server.mcp_server_id,
    catalogEntryName: server.catalog_entry_name,
  });
  await queueWidgetAutoResume(
    ctx,
    sessionId,
    widgetId,
    attached
      ? `[Agor] "${outcome.label}" ${outcome.connected}. It is attached to this session; its tools are available on your next turn.`
      : `[Agor] "${outcome.label}" ${outcome.connected}, but it could not be attached to this session — ` +
          oauthNotAttachedGuidance(outcome.label)
  );
  return textResult({
    widget_id: widgetId,
    status: 'already_present',
    mcp_server_id: server.mcp_server_id,
    attached,
  });
}

/**
 * How far back the supersede sweep looks for a still-live Connect button.
 *
 * A pending oauth widget is one the user has not acted on yet, so it is near
 * the end of the transcript in every case that matters. The bound exists so the
 * sweep does not grow with a long session's whole message history; a card older
 * than this is one nobody is about to click.
 */
const OAUTH_SUPERSEDE_SCAN_LIMIT = 200;

/**
 * Retire any still-pending `oauth` widget for the same (session, server).
 *
 * Supersede rather than stack: two live Connect buttons drive the same
 * provider flow, and whichever the user ignores would sit in the transcript
 * forever. Marked `dismissed` WITHOUT queueing the dismissal prompt — the
 * agent is not being told "no", it is re-asking, and a "user declined" message
 * would be a lie.
 *
 * The write goes through `WidgetResolutionStore`, which is the only writer of
 * widget lifecycle state: writing `metadata.widget` through the repository
 * directly skipped the realtime patch, so a superseded Connect button stayed
 * live and clickable in every open browser until a reload, and then 403'd.
 *
 * Best-effort: failing to tidy an old row must not stop the new request.
 */
async function supersedePendingOAuthWidgets(
  ctx: McpContext,
  sessionId: SessionID,
  target: { mcpServerId?: string; catalogEntryName?: string }
): Promise<void> {
  // Either pin identifies the same connection: a pinned OAuth card for a
  // catalog install and a drawer card for that entry both drive one connect.
  const matches = (params: OAuthWidgetParams | undefined) =>
    (target.mcpServerId !== undefined && params?.mcpServerId === target.mcpServerId) ||
    (target.catalogEntryName !== undefined && params?.catalogEntryName === target.catalogEntryName);
  try {
    const store = (ctx.app as unknown as { get?: (key: string) => unknown }).get?.(
      WIDGET_RESOLUTION_STORE_KEY
    ) as WidgetResolutionStore | undefined;
    if (!store) {
      console.warn(
        '[widgets] no widget resolution store on this app; leaving superseded oauth widgets pending'
      );
      return;
    }
    const rows = await runWithMcpTenantDatabaseScope(ctx, (db) =>
      new MessagesRepository(db).findBySessionIdAndType(sessionId, 'widget_request', {
        limit: OAUTH_SUPERSEDE_SCAN_LIMIT,
        newestFirst: true,
      })
    );
    const resolvedAt = new Date().toISOString();
    for (const row of rows) {
      const widget = row.metadata?.widget;
      if (widget?.widget_type !== 'oauth' || widget.status !== 'pending') continue;
      if (!matches(widget.params as OAuthWidgetParams | undefined)) continue;
      // The store re-reads `pending` under the row lock, so a widget another
      // daemon claimed in the meantime is left alone.
      await store.supersede(row.message_id, resolvedAt);
    }
  } catch (err) {
    console.warn('[widgets] failed to supersede pending oauth widgets:', err);
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
        "Ask the user to connect a third-party MCP server account (Notion, Linear, GitHub, ...) by rendering an inline Connect card. For an OAuth server it runs the real sign-in in their browser; for a catalog entry that needs an API key, token, or the user's own OAuth app it opens the MCP Catalog's own secure form, so secrets go straight from the browser to Agor. " +
        'PREFER this tool whenever the user asks you to "connect me to X" or a task needs an MCP server they have not authorized: call it instead of telling them to open Settings or the MCP Catalog. ' +
        'Resolve the server FIRST: use `agor_mcp_catalog_list` to turn a product name into a `catalogEntryName` (e.g. "Notion" -> "com.notion/mcp"), or `agor_mcp_servers_list` for a server that already exists. NEVER invent a URL — pass exactly one of `mcpServerId` or `catalogEntryName`. ' +
        'FIRE-AND-FORGET: the widget renders inline at the end of your turn; end your turn after calling. You will receive a user-role message when it resolves. ' +
        'In a Slack/Discord/GitHub/Teams thread the user CANNOT see the inline card, so a link is the only thing that reaches them. ' +
        'If the result contains `session_url`, you MUST relay it in your reply (the `relay_to_user` sentence is ready to paste) or the user will never find the button. ' +
        'If the result contains `link_unavailable`, there is NO link to give: relay the `relay_to_user` sentence as written and do NOT tell the user to click, open or look for anything. ' +
        'If it contains neither, you are on the Agor canvas and the user is already looking at the card. ' +
        'This tool NEVER promises a message in the thread itself: a Slack card, where one is posted at all, is sent separately and may not arrive, so never say one is coming. A link is the only thing it can promise. ' +
        'If the account is already connected the tool attaches it and resumes you immediately (status "already_present") — no button is shown. Only the session owner or an admin can attach; otherwise the result says `attached: false` and you should ask them to attach it. ' +
        "Tokens and keys never enter your context or this tool's arguments: only the server name and OAuth mode do. Do NOT use agor_widgets_request_env_vars for an MCP server's key, and never ask for one in chat. The server is attached to this session only AFTER the user connects, so its tools appear on a later turn, not this one. " +
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
            'Reverse-DNS catalog name from `agor_mcp_catalog_list`, e.g. "com.notion/mcp". Works for OAuth and API-key entries; the user adds the entry if they do not have it yet.'
          ),
        reason: z
          .string()
          .min(1)
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
      if ('catalog_connect' in resolved) {
        return mintCatalogConnectWidget(ctx, session, resolved.entry, args.reason);
      }
      if ('short_circuit' in resolved) {
        // Nothing to sign in to — an open endpoint, or a key already on file.
        // Attach and resume rather than rendering a Connect button that would
        // open a flow nobody asked for.
        return attachAndResume(ctx, session, resolved.server, {
          label: resolved.label,
          connected: resolved.alreadyConnected
            ? 'was already connected for you'
            : 'needs no sign-in',
        });
      }
      const { server, catalogEntryName, permissionDisclosure, disclosureRefusal } = resolved;
      const oauthMode = (server.auth?.oauth_mode ?? 'per_user') as 'per_user' | 'shared';
      const serverName = clampToSchemaMax(server.display_name || server.name, SERVER_NAME_MAX);
      const params: OAuthWidgetParams = oauthParamsSchema.parse({
        mcpServerId: server.mcp_server_id,
        serverName,
        oauthMode,
        reason: widgetReason(args.reason, serverName),
        ...(catalogEntryName ? { catalogEntryName } : {}),
        ...(permissionDisclosure ? { permissionDisclosure } : {}),
      });

      // The full gate, now that the destination decided the OAuth mode. Same
      // hook `mintWidgetMessage` will run; called here so a refusal lands
      // before the already-connected branch can attach anything.
      await authorizeWidgetMint('oauth', widgetMintCtx(ctx, targetSessionId), params);

      // Already-connected short-circuit: a credential on file means there is
      // nothing to sign in to. Attach and resume immediately.
      //
      // `mcpOAuthGrantIsConnected`, not `live` — the same verdict
      // `agor_mcp_servers_auth_status` gave the agent that called this tool
      // (D4.1). A bound, expired, still-refreshable grant reads connected
      // there, so rendering a Connect button for it here would be Agor telling
      // the agent a server works and then offering to connect it. If the
      // refresh does fail at call time, the reactive recovery lane offers a
      // reconnect, which is what that lane is for; nothing is granted here.
      const liveness = await runWithMcpTenantDatabaseScope(ctx, (db) =>
        resolveMCPOAuthGrantLiveness(db, server.mcp_server_id, ctx.userId)
      );
      if (mcpOAuthGrantIsConnected(liveness)) {
        return attachAndResume(ctx, session, server, {
          label: serverName,
          connected: 'was already connected for you',
        });
      }

      // A Connect button is about to be minted, so the disclosure has to be
      // showable — refused here, before anything is superseded, so the widget
      // that still carries it stays live.
      if (disclosureRefusal) throw new Error(disclosureRefusal);

      // One live Connect button per (session, server). A second request
      // supersedes the first rather than stacking buttons that all drive the
      // same flow and would each queue their own auto-resume.
      await supersedePendingOAuthWidgets(ctx, targetSessionId, {
        mcpServerId: server.mcp_server_id,
        catalogEntryName,
      });

      const widgetId = await mintWidgetMessage(ctx, {
        sessionId: targetSessionId,
        widgetType: 'oauth',
        params,
        content: `Connect "${serverName}": ${params.reason}`,
        contentPreview: `Widget: oauth (${serverName})`,
        status: 'pending',
        autoResume: true,
        // Widest signal available at the seam: the Task's own
        // `gateway_task_source` is stripped from every `provider`-carrying
        // read (`mcp-recovery-redaction.ts`), so the session's origin is what
        // this side can see. Deliberately not narrowed to Slack here — the
        // projection is the thing that knows which platforms it serves, and
        // it retires the marker on its first look at one it cannot post.
        gatewayCard: isGatewaySession(session),
      });

      // A Slack-originated request also gets a tappable card in the thread it
      // was asked in. Fire-and-forget, after the mint has committed: the card
      // is a projection of the widget row, and the row was minted carrying
      // `slack_connect_due_at`, so a projection that never runs costs latency
      // — the bounded repair sweep still posts it. Every other platform — and
      // the canvas — is served by the deep link below, which stays regardless.
      //
      // Fire-and-forget is also why nothing in this result may promise a card:
      // this call returns before the sweep has looked at the widget once, so
      // the tool genuinely cannot know whether one will ever be posted.
      queueMcpSlackConnectCard(ctx, widgetId);

      // The card renders in the Agor transcript, which a gateway user is not
      // looking at. Hand the agent something it can say — including when the
      // honest answer is that there is nothing to click.
      const link = await gatewaySessionConnectUrl(ctx, session, targetSessionId);
      return textResult({
        widget_id: widgetId,
        status: 'requested',
        ...gatewayRelayFields(
          link,
          (url) => `Open ${url} and click Connect to sign in to "${serverName}".`
        ),
      });
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
          .min(1)
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
          args.reason?.trim() ||
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
