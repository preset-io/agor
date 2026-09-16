/**
 * Durable delivery state for a Slack-delivered MCP connect link.
 *
 * The reactive recovery lane keeps its notice on the Task it is recovering.
 * This lane keeps its delivery on the **widget message**, because the widget
 * is what the link resolves and because a widget message is already
 * daemon-owned end to end: `widgets/message-boundary.ts` refuses every
 * external patch of a widget message outright, and `mutateMetadataLocked` is
 * the same row lock the widget's own resolution claim uses. One row, one lock,
 * one lifecycle.
 *
 * The record holds NO Slack routing and no principal identity — only the
 * one-use identity, the issue epoch, and the provider-attempt lease. Every
 * binding the redemption verifies is re-read from its own authority and
 * compared against the sealed token's claims, so there is no second copy here
 * to fall out of step with the rows that govern it.
 *
 * See `docs/internal/slack-mcp-oauth-connect-2026-09-16.md` §7.
 */

import { generateId, type MessagesRepository } from '@agor/core/db';
import { isMCPServerUsableBy } from '@agor/core/mcp';
import type {
  MCPOAuthConnectTokenClaims,
  MCPServerID,
  MCPSlackConnectDelivery,
  Message,
  MessageID,
  SessionID,
  Task,
  UserID,
  WidgetMessageMetadata,
} from '@agor/core/types';
import { getMcpOAuthConnectUrl } from '@agor/core/utils/url';
import {
  issueMCPOAuthConnectToken,
  MCP_OAUTH_CONNECT_TOKEN_TTL_MS,
} from '../utils/mcp-oauth-connect-token.js';
import type { OAuthWidgetParams } from '../widgets/oauth/index.js';
import {
  readSlackMCPOAuthAuthority,
  type SlackMCPOAuthAuthorityRepositories,
  type SlackMCPOAuthAuthoritySnapshot,
} from './mcp-slack-oauth-authority.js';

/** An `oauth` widget row that is still awaiting a human. */
export interface PendingOAuthConnectWidget {
  widget: WidgetMessageMetadata;
  params: OAuthWidgetParams;
}

/**
 * Read a message as a still-pending `oauth` widget, or return `null`.
 *
 * `status === 'pending'` is the liveness gate for the whole lane: a widget
 * that is `resolving`, `submitted`, `dismissed`, or `already_present` has
 * nothing left for a Slack tap to do, and every redemption path re-checks this
 * after its consume CAS rather than trusting the snapshot it started from.
 */
export function readPendingOAuthConnectWidget(
  message: Message | null | undefined
): PendingOAuthConnectWidget | null {
  if (message?.type !== 'widget_request') return null;
  const widget = message.metadata?.widget;
  if (widget?.widget_type !== 'oauth' || widget.status !== 'pending') return null;
  if (widget.widget_id !== message.message_id) return null;
  const params = widget.params as OAuthWidgetParams | undefined;
  if (!params?.mcpServerId || !params.oauthMode) return null;
  return { widget, params };
}

/** Compare-and-set the widget's delivery record inside one short row lock. */
export async function mutateSlackConnectDelivery(
  messages: Pick<MessagesRepository, 'mutateMetadataLocked'>,
  widgetId: MessageID,
  mutate: (
    current: MCPSlackConnectDelivery | undefined,
    widget: WidgetMessageMetadata,
    message: Message
  ) => MCPSlackConnectDelivery | null
): Promise<{ changed: boolean; message: Message; delivery?: MCPSlackConnectDelivery }> {
  const result = await messages.mutateMetadataLocked(widgetId, (metadata, message) => {
    const widget = metadata?.widget;
    if (!widget) return null;
    const next = mutate(widget.slack_connect, widget, message);
    if (!next) return null;
    return { ...metadata, widget: { ...widget, slack_connect: next } };
  });
  return {
    changed: result.changed,
    message: result.message,
    delivery: result.message.metadata?.widget?.slack_connect,
  };
}

/**
 * Does the Task that minted this widget still record the Slack sender the
 * token was issued for?
 *
 * This is the "pin and verify `slack_user_id`" check. Alignment being on at
 * mint time proves the channel resolves senders to real Agor accounts; it does
 * not prove that the person who tapped the button in a shared thread is the
 * person who asked. The durable `gateway_task_source` is the only record of
 * who actually sent the prompt, so the token's Slack identity is compared
 * against it — and the caller must separately be the Agor user that prompt was
 * attributed to (`task.created_by`), checked by the redemption path.
 */
export function gatewaySourceMatchesConnectClaims(
  task: Task | null | undefined,
  claims: MCPOAuthConnectTokenClaims
): boolean {
  const source = task?.metadata?.gateway_task_source;
  return (
    !!task &&
    !!source &&
    source.channel_type === 'slack' &&
    source.gateway_channel_id === claims.gateway_channel_id &&
    source.thread_id === claims.slack_thread_id &&
    source.provider_user_id === claims.slack_user_id &&
    source.slack_team_id === claims.slack_team_id &&
    source.slack_channel_id === claims.slack_channel_id &&
    task.session_id === claims.session_id &&
    task.created_by === claims.credential_user_id
  );
}

export interface MCPOAuthConnectLinkDeps {
  repositories: SlackMCPOAuthAuthorityRepositories;
  messages: Pick<MessagesRepository, 'findById' | 'mutateMetadataLocked'>;
  tasks: { findById(id: string): Promise<Task | null> };
  masterSecret: string;
  baseUrl: string;
}

export interface MCPOAuthConnectLinkResult {
  url: string;
  delivery: MCPSlackConnectDelivery;
  claims: MCPOAuthConnectTokenClaims;
  authority: SlackMCPOAuthAuthoritySnapshot;
}

/**
 * Issue (or re-issue) the Slack deep link for one pending `oauth` widget.
 *
 * Re-issuing bumps `delivery_generation`, which is compared at redemption, so
 * an older link stops working the moment a newer one is posted. That is the
 * same supersede-don't-stack rule the widget mint already applies to Connect
 * buttons, extended to the thing the button turns into in Slack.
 *
 * Returns `null` rather than throwing on any authority failure: the caller is
 * a projection loop deciding whether there is a link to post, not a user
 * action that deserves a diagnosis.
 */
export async function issueMCPOAuthConnectLink(
  deps: MCPOAuthConnectLinkDeps,
  input: { tenantId: string; widgetId: MessageID; now?: Date }
): Promise<MCPOAuthConnectLinkResult | null> {
  if (!deps.masterSecret) return null;
  // Second-aligned on purpose. The sealed claims carry `iat`/`exp` in whole
  // seconds (JWT-shaped), while the delivery record stores ISO timestamps, and
  // redemption compares the two for equality. Minting at a wall clock with
  // millisecond precision makes that comparison fail for every link — found by
  // driving the real lane, not by a unit test that reused one clock.
  const now = new Date(Math.floor((input.now ?? new Date()).getTime() / 1_000) * 1_000);

  const message = await deps.messages.findById(input.widgetId);
  const pending = readPendingOAuthConnectWidget(message);
  if (!pending || !message?.task_id) return null;

  const task = await deps.tasks.findById(message.task_id);
  const source = task?.metadata?.gateway_task_source;
  if (!task || !source || source.channel_type !== 'slack') return null;
  if (!source.slack_team_id || !source.slack_channel_id || !source.provider_user_id) return null;

  const authority = await readSlackMCPOAuthAuthority(deps.repositories, {
    principalUserId: task.created_by as UserID,
    credentialUserId: task.created_by as UserID,
    sessionId: message.session_id as SessionID,
    gatewayChannelId: source.gateway_channel_id,
    gatewayConfigGeneration: await currentChannelGeneration(deps, source.gateway_channel_id),
    slackChannelId: source.slack_channel_id,
    slackThreadId: source.thread_id,
    mcpServerId: pending.params.mcpServerId as MCPServerID,
    mcpServerConfigVersion: await currentServerConfigVersion(
      deps,
      pending.params.mcpServerId as MCPServerID
    ),
  });
  if (!authority) return null;

  // Defence in depth against the exposure `agor_widgets_request_oauth` already
  // refuses at mint: with alignment off, every message in the channel prompts
  // as the channel's "Post messages as" account, so this link would mint a
  // credential the whole channel can drive. Stage 3 owns the user-facing hard
  // block and its explanatory copy; this is the silent floor beneath it.
  if (authority.channel.config.align_slack_users !== true) return null;

  // The redeem-time server precondition, applied at issue as well: the pure
  // ownership predicate, never the params-shaped caller variant, which would
  // classify this daemon-side call as internal and always allow it.
  if (!isMCPServerUsableBy(authority.server, task.created_by)) return null;
  if ((authority.server.auth?.oauth_mode ?? 'per_user') !== pending.params.oauthMode) return null;

  const expiresAt = new Date(now.getTime() + MCP_OAUTH_CONNECT_TOKEN_TTL_MS);
  const issued = await mutateSlackConnectDelivery(
    deps.messages,
    input.widgetId,
    (current, widget) => {
      // Re-check liveness under the row lock. The snapshot above was read
      // outside it, and a resolution may have landed since.
      if (widget.widget_type !== 'oauth' || widget.status !== 'pending') return null;
      return {
        delivery_id: current?.delivery_id ?? generateId(),
        delivery_generation: (current?.delivery_generation ?? 0) + 1,
        token_jti: generateId(),
        issued_at: now.toISOString(),
        expires_at: expiresAt.toISOString(),
      };
    }
  );
  if (!issued.changed || !issued.delivery) return null;
  const delivery = issued.delivery;

  const claims: Omit<MCPOAuthConnectTokenClaims, 'aud' | 'iss' | 'iat' | 'exp'> = {
    type: 'mcp-oauth-connect',
    tid: input.tenantId,
    sub: task.created_by as UserID,
    credential_user_id: task.created_by as UserID,
    slack_user_id: source.provider_user_id,
    slack_team_id: source.slack_team_id,
    gateway_channel_id: source.gateway_channel_id,
    gateway_config_generation: authority.channel.provider_config_generation,
    slack_channel_id: source.slack_channel_id,
    slack_thread_id: source.thread_id,
    task_id: task.task_id,
    session_id: message.session_id as SessionID,
    session_owner_user_id: authority.session.created_by as UserID,
    widget_id: input.widgetId,
    mcp_server_id: pending.params.mcpServerId as MCPServerID,
    mcp_server_config_version: authority.server.config_version ?? 1,
    oauth_mode: pending.params.oauthMode,
    delivery_id: delivery.delivery_id,
    delivery_generation: delivery.delivery_generation,
    jti: delivery.token_jti,
  };
  const token = issueMCPOAuthConnectToken({ ...claims, expiresAt }, deps.masterSecret, now);
  return {
    url: `${getMcpOAuthConnectUrl(deps.baseUrl)}#token=${encodeURIComponent(token)}`,
    delivery,
    claims: {
      ...claims,
      iat: Math.floor(now.getTime() / 1_000),
      exp: Math.floor(expiresAt.getTime() / 1_000),
      aud: 'agor:mcp-oauth-connect',
      iss: 'agor',
    },
    authority,
  };
}

/**
 * The generation/version the authority read must agree with is whatever is
 * stored right now: at issue time there is no earlier claim to compare
 * against, and pinning the current value is exactly what makes a later change
 * invalidate the link.
 */
async function currentChannelGeneration(
  deps: MCPOAuthConnectLinkDeps,
  channelId: string
): Promise<number> {
  const channel = await deps.repositories.channels.findById(channelId);
  return channel?.provider_config_generation ?? -1;
}

async function currentServerConfigVersion(
  deps: MCPOAuthConnectLinkDeps,
  serverId: MCPServerID
): Promise<number> {
  const server = await deps.repositories.servers.findById(serverId);
  return server?.config_version ?? 1;
}
