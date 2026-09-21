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
import { isBrowserReachableUrl } from '../utils/browser-reachable-url.js';
import {
  issueMCPOAuthConnectToken,
  MCP_OAUTH_CONNECT_TOKEN_TTL_MS,
  mcpOAuthConnectClaimsMatchDelivery,
  verifyMCPOAuthConnectToken,
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
  const widget = readOAuthConnectWidget(message);
  return widget?.widget.status === 'pending' ? widget : null;
}

/**
 * Read a message as an `oauth` widget in ANY state.
 *
 * The Slack card outlives the moment a tap can do anything: a resolved or
 * superseded widget still owns a posted row that has to be edited to say so.
 * Callers that grant something use `readPendingOAuthConnectWidget`; callers
 * that only render use this.
 */
export function readOAuthConnectWidget(
  message: Message | null | undefined
): PendingOAuthConnectWidget | null {
  if (message?.type !== 'widget_request') return null;
  const widget = message.metadata?.widget;
  if (widget?.widget_type !== 'oauth') return null;
  if (widget.widget_id !== message.message_id) return null;
  const params = widget.params as OAuthWidgetParams | undefined;
  if (!params?.mcpServerId || !params.oauthMode) return null;
  return { widget, params };
}

/**
 * The Slack coordinates of the Task that minted a widget, or `null` when it
 * was not a Slack prompt.
 *
 * Read separately from the authority because a card whose authority has moved
 * still has to be edited in the thread it was posted to — the two questions
 * ("where does this live" and "may it still offer a link") have different
 * answers and different lifetimes.
 */
export function readSlackConnectCoordinates(
  task: Task | null | undefined
): SlackConnectCoordinates | null {
  const source = task?.metadata?.gateway_task_source;
  if (source?.channel_type !== 'slack') return null;
  const { slack_team_id: teamId, slack_channel_id: channelId } = source;
  if (!teamId || !channelId || !source.provider_user_id) return null;
  return {
    gatewayChannelId: source.gateway_channel_id,
    teamId,
    channelId,
    threadId: source.thread_id,
    userId: source.provider_user_id,
    ...(source.slack_conversation_type ? { conversationType: source.slack_conversation_type } : {}),
  };
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
 * Why a widget has no Slack connect link to offer.
 *
 * The projection needs the reason, not just the absence: a channel that
 * stopped aligning its Slack users must say so on the card, while a widget
 * that was never Slack-delivered must say nothing at all. Collapsing both to
 * `null` would make the second indistinguishable from the first, and the card
 * would either go silent on a real block or narrate a block that never applied.
 */
export type SlackConnectBindingRefusal =
  /** No `AGOR_MASTER_SECRET`, so no link can be sealed anywhere in this deployment. */
  | 'no_secret'
  /**
   * No base URL a browser elsewhere could open, so the button would lead
   * nowhere.
   *
   * Two conditions, one refusal, because the card cannot tell them apart and
   * neither can be fixed from here. `''` is a hosted tenant whose durable
   * routing has not landed (or whose resolution threw and was tolerated);
   * `http://localhost:3030` is the static fallback a deployment that never
   * configured a public URL gets, which reads as a perfectly good URL and
   * works for nobody but the daemon's own machine.
   *
   * Reversible on purpose: routing lands, or an administrator sets the public
   * base URL, and the next backoff posts the card. Refusing costs one binding
   * read; posting would burn a one-use token on a Block Kit button Slack
   * either rejects outright (`''`) or renders as a dead link.
   */
  | 'no_public_url'
  /** Not a still-pending `oauth` widget — resolved, dismissed, or another type. */
  | 'not_connectable'
  /** The Task that minted the widget did not come from a Slack thread. */
  | 'not_slack'
  /** `align_slack_users` is not `true` on the channel; see §5.3. */
  | 'unaligned'
  /** The channel, session, server, or a user role moved under the card. */
  | 'authority_moved';

/** Where a connect card lives, once every optional field has been proven. */
export interface SlackConnectCoordinates {
  gatewayChannelId: string;
  teamId: string;
  channelId: string;
  threadId: string;
  /** Slack user who sent the prompt that minted the widget. */
  userId: string;
  /** `im` | `mpim` | `channel` | `group`, when the inbound event recorded it. */
  conversationType?: string;
}

export type SlackConnectBinding =
  | {
      ok: true;
      message: Message;
      params: OAuthWidgetParams;
      widget: WidgetMessageMetadata;
      task: Task;
      /** The Slack coordinates, narrowed to the ones proven present. */
      slack: SlackConnectCoordinates;
      authority: SlackMCPOAuthAuthoritySnapshot;
    }
  | {
      ok: false;
      reason: SlackConnectBindingRefusal;
      message: Message | null;
      /** Present once the card's thread is known, even though no link may be offered. */
      slack?: SlackConnectCoordinates;
      params?: OAuthWidgetParams;
      widget?: WidgetMessageMetadata;
    };

/**
 * Re-prove everything a Slack connect link depends on, without issuing one.
 *
 * Split out of `issueMCPOAuthConnectLink` because the card projection asks the
 * same question for a different purpose — it renders whatever the answer is,
 * including the refusals — and two copies of this list is exactly the drift
 * `mcp-slack-oauth-authority.ts` exists to prevent one level down.
 */
export async function resolveSlackConnectBinding(
  deps: MCPOAuthConnectLinkDeps,
  widgetId: MessageID
): Promise<SlackConnectBinding> {
  const message = await deps.messages.findById(widgetId);
  const found = readOAuthConnectWidget(message);
  if (!found || !message?.task_id) return { ok: false, reason: 'not_connectable', message };
  const { widget, params } = found;

  const task = await deps.tasks.findById(message.task_id);
  const slack = readSlackConnectCoordinates(task);
  if (!task || !slack) return { ok: false, reason: 'not_slack', message, widget, params };
  const refuse = (reason: SlackConnectBindingRefusal): SlackConnectBinding => ({
    ok: false,
    reason,
    message,
    slack,
    widget,
    params,
  });

  if (!deps.masterSecret) return refuse('no_secret');
  // Beside `no_secret`, and for the same reason: both are the deployment
  // failing to supply an ingredient of a link, and neither is this widget's
  // fault. See `no_public_url` above for why an unusable URL is refused rather
  // than posted.
  if (!isBrowserReachableUrl(deps.baseUrl)) return refuse('no_public_url');
  // `resolving` is admitted as well as `pending`, and it is not a widening of
  // what may be granted.
  //
  // A `resolving` widget is a pending one with a claim on it — and when that
  // claim has been abandoned long enough for `submissions.ts` to take it over,
  // the card's honest state is `finish_required`, with a button that makes the
  // POST which does exactly that. `mcpSlackConnectRenderedState` has always
  // said so; refusing the binding here is what made that branch unreachable,
  // so a resolve POST whose browser died mid-flight left a card reading
  // "sign-in is in progress … this message updates when it lands" with nothing
  // coming.
  //
  // Nothing here mints. The only caller that does, `issueMCPOAuthConnectLink`,
  // re-checks `status === 'pending'` under the row lock before it writes, so a
  // claimed widget still cannot get a fresh link — it can only have the link
  // it already has re-sealed, which grants strictly less.
  if (widget.status !== 'pending' && widget.status !== 'resolving') {
    return refuse('not_connectable');
  }

  const authority = await readSlackMCPOAuthAuthority(deps.repositories, {
    principalUserId: task.created_by as UserID,
    credentialUserId: task.created_by as UserID,
    sessionId: message.session_id as SessionID,
    gatewayChannelId: slack.gatewayChannelId,
    // Issue time: there is no earlier claim to compare against, and pinning
    // whatever is stored right now is exactly what makes a later change
    // invalidate the link. Said in the type rather than by re-reading the row
    // and handing its own value back — that spelling reads as a check while
    // being `x !== x`. The link already sealed against an OLDER generation is
    // caught below, from the delivery record, which is the only thing that
    // remembers it.
    gatewayConfigGeneration: 'current',
    slackChannelId: slack.channelId,
    slackThreadId: slack.threadId,
    mcpServerId: params.mcpServerId as MCPServerID,
    mcpServerConfigVersion: 'current',
  });
  if (!authority) return refuse('authority_moved');

  // Defence in depth against the exposure `agor_widgets_request_oauth` already
  // refuses at mint: with alignment off, every message in the channel prompts
  // as the channel's "Post messages as" account, so this link would mint a
  // credential the whole channel can drive. The card turns this into visible
  // copy naming the setting; this is the floor beneath it, which refuses
  // whether or not anything is rendered.
  if (authority.channel.config.align_slack_users !== true) return refuse('unaligned');

  // The redeem-time server precondition, applied at issue as well: the pure
  // ownership predicate, never the params-shaped caller variant, which would
  // classify this daemon-side call as internal and always allow it.
  // A link already sealed against an older channel configuration would be
  // refused at redemption, because the token pins the generation and the
  // authority re-read compares it. Catch that HERE rather than at delivery:
  // the authority read above is deliberately `'current'` (it has no earlier
  // claim to compare against at issue time), so the only record of what the
  // live link was sealed against is the delivery row.
  const sealedGeneration = widget.slack_connect?.gateway_config_generation;
  if (
    sealedGeneration !== undefined &&
    sealedGeneration !== authority.channel.provider_config_generation
  ) {
    return refuse('authority_moved');
  }
  if (!isMCPServerUsableBy(authority.server, task.created_by)) return refuse('authority_moved');
  if ((authority.server.auth?.oauth_mode ?? 'per_user') !== params.oauthMode) {
    return refuse('authority_moved');
  }

  return { ok: true, message, params, widget, task, slack, authority };
}

/**
 * Rebuild the link for a delivery record that ALREADY has one, without
 * touching the record.
 *
 * The finish card needs a URL and has no business minting a new link: the
 * user's sign-in is done, the one-use token behind it has already been
 * consumed doing exactly that, and a re-issue would clear the very
 * `oauth_succeeded_at` that says so. So this re-seals the claims the live
 * record still describes — same `delivery_id`, same generation, same `jti`,
 * same `issued_at`/`expires_at`, which is what `mcpOAuthConnectClaimsMatchDelivery`
 * compares — and grants strictly less than an issue: nothing is minted,
 * nothing is invalidated, and the result dies on the original clock.
 *
 * Returns `null` whenever it cannot produce a link redemption would accept —
 * the clock has run out, or the record is not one an acceptable token can be
 * built from (see the check at the end). There is deliberately no extension: a
 * finish link that cannot be offered is `finish_stalled`, whose answer is to
 * ask again in the thread, which costs no second sign-in.
 *
 * The authority-derived claims (`session_owner_user_id`, the server's
 * `config_version`) come from the binding proved for THIS call rather than
 * from whatever they were at issue, because the record does not remember them.
 * That is the same derivation an issue performs, and the token is not what
 * authorizes the finish in any case: `/oauth-resolve` re-reads the server, the
 * mode, the caller's usability and the grant before it resolves anything.
 */
export function resealMCPOAuthConnectLink(
  deps: Pick<MCPOAuthConnectLinkDeps, 'masterSecret' | 'baseUrl'>,
  binding: Extract<SlackConnectBinding, { ok: true }>,
  tenantId: string,
  now = new Date()
): string | null {
  const delivery = binding.widget.slack_connect;
  if (!delivery || !deps.masterSecret) return null;
  const issuedAt = new Date(delivery.issued_at);
  const expiresAt = new Date(delivery.expires_at);
  if (!Number.isFinite(issuedAt.getTime()) || !Number.isFinite(expiresAt.getTime())) return null;
  if (expiresAt.getTime() <= now.getTime()) return null;
  const { params, task, slack, authority, message } = binding;
  const token = issueMCPOAuthConnectToken(
    {
      type: 'mcp-oauth-connect',
      tid: tenantId,
      sub: task.created_by as UserID,
      credential_user_id: task.created_by as UserID,
      slack_user_id: slack.userId,
      slack_team_id: slack.teamId,
      gateway_channel_id: slack.gatewayChannelId,
      gateway_config_generation: authority.channel.provider_config_generation,
      slack_channel_id: slack.channelId,
      slack_thread_id: slack.threadId,
      task_id: task.task_id,
      session_id: message.session_id as SessionID,
      session_owner_user_id: authority.session.created_by as UserID,
      widget_id: binding.widget.widget_id,
      mcp_server_id: params.mcpServerId as MCPServerID,
      mcp_server_config_version: authority.server.config_version ?? 1,
      oauth_mode: params.oauthMode,
      delivery_id: delivery.delivery_id,
      delivery_generation: delivery.delivery_generation,
      jti: delivery.token_jti,
      expiresAt,
    },
    deps.masterSecret,
    issuedAt
  );

  // Prove the link before offering it, using redemption's own two steps rather
  // than a second opinion about what they will say.
  //
  // The card's whole promise in this state is that it never shows a finish
  // `/oauth-resolve` would refuse, and that promise rests here on an invariant
  // this function cannot see: `mcpOAuthConnectClaimsMatchDelivery` compares
  // whole-second `iat`/`exp` for EQUALITY against the record's ISO timestamps,
  // so a record whose clocks carry milliseconds yields a token refused every
  // time. `issueMCPOAuthConnectLink` second-aligns its clock for exactly that
  // reason — one function away, in a comment, with nothing binding the two
  // together. Re-reading what we just sealed makes the promise structural
  // instead: any record this cannot produce an acceptable link for degrades to
  // `finish_stalled`, whose answer — ask again in the thread, at no second
  // sign-in — is true and recoverable, rather than to a button that fails.
  try {
    if (
      !mcpOAuthConnectClaimsMatchDelivery(
        verifyMCPOAuthConnectToken(token, deps.masterSecret, now),
        delivery,
        tenantId
      )
    ) {
      return null;
    }
  } catch {
    return null;
  }
  return `${getMcpOAuthConnectUrl(deps.baseUrl)}#token=${encodeURIComponent(token)}`;
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
 * action that deserves a diagnosis. A caller that needs the diagnosis calls
 * `resolveSlackConnectBinding` and passes the proven binding back in.
 */
export async function issueMCPOAuthConnectLink(
  deps: MCPOAuthConnectLinkDeps,
  input: {
    tenantId: string;
    widgetId: MessageID;
    now?: Date;
    /** A binding this caller already proved. Re-proved here when absent. */
    binding?: SlackConnectBinding;
    /**
     * Take (or keep) this delivery claim in the same write that mints the
     * link. The first card a widget ever gets has no record to claim
     * beforehand, so without this two daemons minting concurrently would each
     * create a link and each post a card. A claim already held by this caller
     * is kept; one held by anyone else refuses the mint.
     */
    claim?: { claimId: string; expiresAt: string };
  }
): Promise<MCPOAuthConnectLinkResult | null> {
  // Second-aligned on purpose. The sealed claims carry `iat`/`exp` in whole
  // seconds (JWT-shaped), while the delivery record stores ISO timestamps, and
  // redemption compares the two for equality. Minting at a wall clock with
  // millisecond precision makes that comparison fail for every link — found by
  // driving the real lane, not by a unit test that reused one clock.
  const now = new Date(Math.floor((input.now ?? new Date()).getTime() / 1_000) * 1_000);

  const binding = input.binding ?? (await resolveSlackConnectBinding(deps, input.widgetId));
  if (!binding.ok) return null;
  const { message, task, slack, authority, params } = binding;

  const expiresAt = new Date(now.getTime() + MCP_OAUTH_CONNECT_TOKEN_TTL_MS);
  const issued = await mutateSlackConnectDelivery(
    deps.messages,
    input.widgetId,
    (current, widget) => {
      // Re-check liveness under the row lock. The snapshot above was read
      // outside it, and a resolution may have landed since.
      if (widget.widget_type !== 'oauth' || widget.status !== 'pending') return null;
      const heldByAnother =
        !!current?.delivery_claim &&
        new Date(current.delivery_claim.expires_at).getTime() > now.getTime() &&
        current.delivery_claim.claim_id !== input.claim?.claimId;
      if (heldByAnother) return null;
      return {
        // Re-issue keeps the card — `slack_message_ts` and the delivery
        // identity — and replaces the link. Dropping the posted `ts` here
        // would leave the old row in the thread offering a token that no
        // longer matches the record, beside a new row that does.
        ...current,
        delivery_id: current?.delivery_id ?? generateId(),
        delivery_generation: (current?.delivery_generation ?? 0) + 1,
        token_jti: generateId(),
        issued_at: now.toISOString(),
        expires_at: expiresAt.toISOString(),
        gateway_config_generation: authority.channel.provider_config_generation,
        ...(input.claim
          ? {
              delivery_claim: {
                claim_id: input.claim.claimId,
                claimed_at: now.toISOString(),
                expires_at: input.claim.expiresAt,
              },
              next_repair_at: input.claim.expiresAt,
            }
          : {}),
        // The previous link's one-use consume and its provider outcome belong
        // to the previous generation. Carrying them forward would render the
        // new card as a sign-in that already happened.
        token_consumed_at: undefined,
        oauth_attempt_id: undefined,
        oauth_start_claimed_at: undefined,
        oauth_start_claim_expires_at: undefined,
        oauth_started_at: undefined,
        oauth_succeeded_at: undefined,
        oauth_failed_at: undefined,
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
    slack_user_id: slack.userId,
    slack_team_id: slack.teamId,
    gateway_channel_id: slack.gatewayChannelId,
    gateway_config_generation: authority.channel.provider_config_generation,
    slack_channel_id: slack.channelId,
    slack_thread_id: slack.threadId,
    task_id: task.task_id,
    session_id: message.session_id as SessionID,
    session_owner_user_id: authority.session.created_by as UserID,
    widget_id: input.widgetId,
    mcp_server_id: params.mcpServerId as MCPServerID,
    mcp_server_config_version: authority.server.config_version ?? 1,
    oauth_mode: params.oauthMode,
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
