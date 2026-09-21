/**
 * What one Slack MCP connect card says, and when it should be looked at again.
 *
 * Everything here is a pure function of durable state — the widget row, its
 * delivery record, and why (if at all) no link can be offered. The stateful
 * half — claiming a delivery, talking to Slack, scheduling repair — lives in
 * `services/gateway.ts` beside the recovery lane it copies.
 *
 * The split exists because the card's *meaning* is the part worth pinning in
 * tests: the recovery lane's presentation functions are the only part of that
 * lane a test can assert without a connector, and this lane has more states
 * than that one. See `docs/internal/slack-mcp-oauth-connect-2026-09-16.md` §7.
 */

import type { SlackAgorMessageMetadataEventType } from '@agor/core/gateway';
import type {
  MCPOAuthMode,
  MCPSlackConnectDelivery,
  MCPSlackConnectRenderedState,
  Message,
  MessageID,
  WidgetMessageMetadata,
} from '@agor/core/types';
import type { OAuthWidgetResultMeta } from '../widgets/oauth/index.js';
import { WIDGET_RECLAIM_ABANDONED_AFTER_MS } from '../widgets/submissions.js';
import type { SlackConnectBindingRefusal } from './mcp-oauth-connect-delivery.js';

/** Slack's own upper bound on a button label. */
const BUTTON_TEXT_MAX = 75;

/**
 * Metadata `event_type` for the card, so a daemon that crashed after sending
 * but before recording the `ts` can find its own row instead of posting twice.
 *
 * Typed against the connector's own allowlist, not merely written to match it:
 * `sendMessage` drops a metadata request whose `event_type` it does not
 * recognise, so a value only this file knew would post the card bare and leave
 * `findMessageByMetadata` permanently unable to match it. Typecheck now says so.
 */
export const MCP_SLACK_CONNECT_EVENT_TYPE: SlackAgorMessageMetadataEventType = 'agor_mcp_connect';

/** Thread-map metadata key for the once-per-conversation shared-thread notice. */
export const MCP_SLACK_CONNECT_SHARED_WARNING_KEY = 'mcp_connect_shared_thread_warned_at';

export interface MCPSlackConnectStateInput {
  widget: WidgetMessageMetadata;
  delivery?: MCPSlackConnectDelivery;
  /** Why no link can be offered, when the binding refused. */
  refusal?: SlackConnectBindingRefusal;
  /** The caller is about to mint a fresh link, clearing the previous outcome. */
  willReissue?: boolean;
  /**
   * The credential this widget was minted for is on file and expected to work,
   * read by the caller through `resolveMCPOAuthGrantLiveness` and
   * `mcpOAuthGrantIsConnected`.
   *
   * Read from the grant rather than from `oauth_succeeded_at` on purpose: the
   * delivery record remembers that a browser round-trip finished, which is a
   * different fact from a credential being on file — the round-trip can
   * succeed and the grant be revoked, and the grant can be on file from the
   * Catalog drawer with no round-trip here at all. The card is about what the
   * user still has to do, so it follows the credential. Same rule and same
   * function as the resolve gate, so the card cannot offer a finish the
   * resolver would refuse.
   *
   * It counts `refreshable` for the same reason the resolve gate does (D4.1),
   * and the direction of that fix matters here: keying this on `live` alone
   * meant a card that had said *Finish connecting* reverted to a buttonless
   * "sign-in in progress" the moment an hour-lived access token lapsed —
   * withholding a finish from the very user this lane exists for, whose
   * sign-in landed and who then went away.
   */
  grantConnected?: boolean;
}

/**
 * Project the durable state of one connect widget into the single thing its
 * Slack card currently says.
 *
 * The **widget row is authoritative for the lifecycle** and is therefore read
 * first: a resolved widget is connected no matter what the link record says,
 * because the resolution is the daemon's own re-read of the persisted grant
 * (D3) while the link record only describes a browser round-trip. The
 * delivery record decides only what a still-pending card offers.
 */
export function mcpSlackConnectRenderedState(
  input: MCPSlackConnectStateInput,
  now = Date.now()
): MCPSlackConnectRenderedState {
  const { widget, delivery, refusal } = input;

  if (widget.status === 'submitted' || widget.status === 'already_present') {
    // `attached` carries exactly one meaning — the resolver was not the
    // session owner or an admin (D6) — so the card may state it plainly.
    const meta = widget.result_meta as OAuthWidgetResultMeta | undefined;
    return meta?.attached === false ? 'connected_not_attached' : 'connected';
  }
  if (widget.status === 'dismissed') return 'cancelled';

  if (delivery?.binding_invalidated_at) return 'unavailable';
  if (refusal === 'unaligned' || refusal === 'authority_moved') return 'unavailable';

  // One clock, deliberately: the connect token's own `expires_at`. D7 declined
  // a second, widget-level TTL precisely so there is nothing to reconcile
  // here. An abandoned sign-in ages out on the link's clock, not its own.
  //
  // Read here rather than where it used to be read — below the
  // `oauth_succeeded_at` branch — because whether a link can still be TAPPED
  // is now a question two states ask, and the previous order let a finished
  // round-trip mask the answer.
  const expiresAt = delivery ? new Date(delivery.expires_at).getTime() : Number.NaN;
  const linkLapsed = !!delivery && (!Number.isFinite(expiresAt) || expiresAt <= now);

  // The credential is on file and the widget is not resolved: the user's
  // remaining work is a POST, not a sign-in. This outranks every pending state
  // below — including an in-flight claim, once that claim is old enough for
  // `submissions.ts` to take it over, which is the point at which the card's
  // button would actually do something.
  //
  // Two things have to be true of the claim, not one. Age says `submissions.ts`
  // is willing to take a claim over; the claim's ACTION says it would take over
  // *this* one. Its reclaim gate requires `resolution_claim.action ===
  // action.kind`, and this card's button submits `oauth_callback` — so an
  // abandoned `dismiss` claim (the user tapped "Not now" and the resolver died)
  // is old enough by the clock and still refused by name. Offering a finish
  // there is the offer/refuse disagreement this lane has produced twice and
  // forbids: the card must never offer what the resolver would refuse.
  const claim = widget.resolution_claim;
  const claimIsAbandoned =
    widget.status === 'resolving' &&
    claim?.action === 'oauth_callback' &&
    now - new Date(claim.claimed_at).getTime() >= WIDGET_RECLAIM_ABANDONED_AFTER_MS;
  if (input.grantConnected && (widget.status === 'pending' || claimIsAbandoned)) {
    // No delivery record yet means the first card has not been posted, and the
    // caller can mint a link for it — the same one `connect_required` gets.
    return linkLapsed ? 'finish_stalled' : 'finish_required';
  }

  // A claim is held by whoever took it; the card should not offer a second
  // button while one resolution is in flight, wherever it was started.
  if (widget.status === 'resolving') return 'sign_in_pending';

  if (input.willReissue) return 'connect_required';
  if (!delivery) return 'connect_required';
  if (linkLapsed) return 'expired';
  // The round-trip finished and no usable credential is on file — it was
  // revoked, it no longer binds to the server's configuration, or a refresh of
  // unknown outcome is in flight with nothing spendable behind it. Still
  // pending from this card's point of view, and the link has not lapsed, so
  // the thread waits.
  if (delivery.oauth_succeeded_at) return 'sign_in_pending';
  if (delivery.oauth_failed_at) return 'expired';
  if (delivery.token_consumed_at) return 'sign_in_pending';
  return 'connect_required';
}

/**
 * May this card be re-offered with a freshly minted link?
 *
 * Only after a sign-in that durably failed, and only while the previous link's
 * own clock is still running. Closing the provider window is the ordinary way
 * this happens, and "ask the agent again" is a poor answer to it. The rule is
 * self-limiting rather than counted: a re-issue clears `oauth_failed_at`, so
 * another failure — which takes another human attempt — is required before
 * another re-issue.
 */
export function mcpSlackConnectMayReissue(
  widget: WidgetMessageMetadata,
  delivery: MCPSlackConnectDelivery | undefined,
  now = Date.now()
): boolean {
  if (widget.status !== 'pending' || !delivery) return false;
  if (!delivery.oauth_failed_at || delivery.oauth_succeeded_at) return false;
  const expiresAt = new Date(delivery.expires_at).getTime();
  return Number.isFinite(expiresAt) && expiresAt > now;
}

export interface MCPSlackConnectCopyContext {
  serverName: string;
  reason: string;
  oauthMode: MCPOAuthMode;
  refusal?: SlackConnectBindingRefusal;
}

/**
 * The words on the card.
 *
 * Written to be read by someone who is in Slack and not looking at Agor, and —
 * for `connected_not_attached` and the unaligned case — to be relayable
 * verbatim, because the person who can act on either is usually not the person
 * reading it.
 */
export function mcpSlackConnectCardCopy(
  state: MCPSlackConnectRenderedState,
  context: MCPSlackConnectCopyContext
): { text: string; button?: string } {
  const { serverName, reason, oauthMode } = context;
  const shared =
    oauthMode === 'shared'
      ? ` This is a workspace-wide connection: everyone in this Agor workspace will use the account you sign in with.`
      : '';
  switch (state) {
    case 'connect_required':
      return {
        text:
          `*Connect ${serverName}*\n${reason}\n` +
          `Sign in through Agor to continue. The link works only for you, and only for the next 10 minutes.${shared}`,
        button: clampButton(`Connect ${serverName}`),
      };
    case 'sign_in_pending':
      // Two arrivals share this state, so the instruction is conditional. The
      // common one is a sign-in actually in flight. The other is a resolution
      // somebody started and abandoned that this card can never finish — most
      // visibly a "Not now" whose resolver died, which holds a `dismiss` claim
      // the finish button's `oauth_callback` may not take over (§7.1.13, B3).
      // That reader has no browser tab, and telling them to go back to one is
      // the only thing this copy could get wrong: the card offers nothing
      // either way. A separate state would say it better and would mean a new
      // persisted `rendered_state` value for a copy difference.
      return {
        text:
          `*Connecting ${serverName}*\nAgor is still working on this request. If you started a ` +
          `sign-in, finish it in the browser tab Agor opened — this message updates when it lands.`,
      };
    case 'finish_required':
      return {
        // Never "connect": the sign-in is done and saying otherwise sends the
        // reader back through a provider flow they have already completed.
        text:
          `*Finish connecting ${serverName}*\nYou are signed in — Agor still has to attach it here ` +
          `and wake the conversation. That takes one tap and no second sign-in.`,
        button: clampButton(`Finish connecting ${serverName}`),
      };
    case 'finish_stalled':
      return {
        text:
          `*${serverName} is signed in, but not finished*\nAgor has your sign-in and did not get to ` +
          `attach it to this conversation. Ask again in this thread — Agor will finish it, and you ` +
          `will not have to sign in again.`,
      };
    case 'connected':
      return {
        text: `*${serverName} connected*\nIt is attached to this session, and its tools are available on the next turn.`,
      };
    case 'connected_not_attached':
      return {
        text:
          `*${serverName} connected*\nYour account is connected. Attaching a server to this session needs the session owner or an Agor admin, ` +
          `so ask one of them to attach "${serverName}" — then continue here.`,
      };
    case 'expired':
      return {
        // "Agor has no usable connection", not "nothing was connected": this
        // state is also reached after a round-trip that reported success and
        // left no spendable grant, and telling that reader nothing happened is
        // both false and unhelpful.
        text: `*Connect ${serverName}*\nThis link expired or the sign-in did not finish, and Agor has no usable connection. Ask again in this thread and Agor will send a new one.`,
      };
    case 'cancelled':
      return {
        text: `*Connect ${serverName}*\nThis request was replaced or cancelled. Nothing was connected.`,
      };
    case 'unavailable':
      return {
        text:
          context.refusal === 'unaligned'
            ? `*Connect ${serverName}*\nAgor cannot offer a sign-in link in this channel. The channel does not map Slack users to Agor accounts, so a sign-in started here would be stored under the channel's shared account and every member could then use it. An Agor admin can turn on "Align Slack users" for this channel.`
            : `*Connect ${serverName}*\nThis request no longer applies — the channel, session, or server setup changed. Nothing was connected. Ask again in this thread if you still need it.`,
      };
  }
}

/**
 * What a duplicate card says once it is no longer the card.
 *
 * A post that outlives its delivery lease can land beside the row that won,
 * leaving two messages for one widget. The words have to hold whatever the
 * widget did next — connected, cancelled, still waiting — so they describe
 * only this message's own standing and point at the row that is authoritative.
 * Used only where the message cannot be deleted outright.
 */
export function mcpSlackConnectDuplicateCardText(serverName: string): string {
  return (
    `*Connect ${serverName}*\nThis is a duplicate message and is no longer in use. ` +
    'See the other Agor message in this thread for the current status.'
  );
}

/**
 * The one-time notice that this is not a DM.
 *
 * §4.8 allows channels rather than restricting the lane to DMs, because
 * credentials belong to the prompt actor in both egress modes (D2) and there
 * is therefore no credential-borrowing path. What a channel does change is who
 * can *read* what the connected account returns, and that is worth saying once
 * — per (session, conversation), not per connect, which is the difference
 * between a useful warning and noise.
 */
export function mcpSlackConnectSharedThreadWarning(): string {
  return (
    'Heads up — this is a shared conversation. Anything the assistant reads from an account ' +
    'connected here can appear in this thread and in this session, for everyone who can see them. ' +
    'Use a DM with Agor if that is not what you want.'
  );
}

/**
 * Is this Slack conversation a one-to-one DM?
 *
 * Prefers the conversation kind the inbound event recorded. Tasks created
 * before that was persisted fall back to Slack's channel-id prefix, which
 * answers `D` for an IM and something else for every room. The fallback is
 * chosen to fail toward warning: an unrecognised id is treated as shared.
 */
export function slackConversationIsDirectMessage(
  slackChannelId: string,
  conversationType?: string
): boolean {
  if (conversationType) return conversationType === 'im';
  return slackChannelId.startsWith('D');
}

/** Block Kit body for one card. The button is a plain link, never a callback. */
export function mcpSlackConnectBlocks(copy: { text: string; button?: string }, url?: string) {
  return [
    { type: 'section', text: { type: 'mrkdwn', text: copy.text } },
    ...(url && copy.button
      ? [
          {
            type: 'actions',
            elements: [
              {
                type: 'button',
                text: { type: 'plain_text', text: copy.button },
                url,
                // Slack requires an action_id even for URL buttons. Agor does
                // not register an interaction handler for it: the link is the
                // whole mechanism, and nothing is granted until the browser
                // completes a provider flow.
                action_id: 'agor_mcp_connect_link',
                accessibility_label: 'Connect this MCP server in Agor',
                style: 'primary',
              },
            ],
          },
        ]
      : []),
    {
      type: 'context',
      elements: [{ type: 'mrkdwn', text: 'Return here after using Agor.' }],
    },
  ];
}

/**
 * How long until this card's own state changes on its own.
 *
 * Only the live states age: a card offering a button becomes `expired` (or,
 * for a finish, `finish_stalled`) when its link does, and a sign-in in flight
 * does the same. Everything else is terminal and must never hold a timer open.
 *
 * `finish_stalled` deliberately does not: its link is already gone, and
 * re-minting one on a timer would edit the same Slack row every ten minutes
 * for a day. The way out of it is to ask again, which costs no sign-in.
 */
export function mcpSlackConnectExpiryDelay(
  state: MCPSlackConnectRenderedState,
  delivery: MCPSlackConnectDelivery | undefined,
  now = Date.now()
): number | undefined {
  if (state !== 'connect_required' && state !== 'sign_in_pending' && state !== 'finish_required') {
    return undefined;
  }
  if (!delivery) return undefined;
  const expiresAt = new Date(delivery.expires_at).getTime();
  if (!Number.isFinite(expiresAt) || expiresAt <= now) return undefined;
  return expiresAt - now + 1_000;
}

/**
 * How long a first-card marker waits after a refusal an administrator can undo.
 *
 * Five minutes rather than the sweep's own 30s tick, because none of the
 * reversible refusals (`unaligned`, `authority_moved`, `no_secret`,
 * `no_public_url`) changes without a human doing something, and rather than an
 * hour, because the human who changes it is usually waiting on the card.
 */
export const MCP_SLACK_CONNECT_MARKER_BACKOFF_MS = 5 * 60_000;

/**
 * The window a mint-time marker is eligible for repair at all, matching the
 * sweep's own horizon. A marker is stamped at mint and the sweep only reads
 * the last day of due work, so this is the age at which one silently stopped
 * being visited before rescheduling existed.
 */
export const MCP_SLACK_CONNECT_MARKER_MAX_AGE_MS = 24 * 60 * 60_000;

/**
 * When the sweep should look again at a first card it just refused to post.
 *
 * The marker is the only durable trigger a widget has before a delivery record
 * exists, and the reversible refusals deliberately keep it: an administrator
 * can switch `align_slack_users` back on, re-enable a channel, or restore a
 * role, and the card the user was promised has nothing else to wake it.
 *
 * What must NOT be kept is the marker's queue position. The sweep reads the
 * oldest page of due work, so a marker left at its original, permanently
 * overdue timestamp sits at the front of that page for as long as the refusal
 * lasts — and enough of them starve every healthy card behind them of its
 * first delivery and of every repair. Moving it forward keeps the trigger and
 * gives up the position.
 *
 * Ageing out is preserved exactly rather than traded away: the reschedule is
 * capped at `requested_at + MCP_SLACK_CONNECT_MARKER_MAX_AGE_MS`, the same
 * point the sweep's horizon used to drop the row, and past that the marker is
 * pinned back to its anchor where the horizon excludes it for good. A marker
 * that keeps refreshing its own due time would otherwise be immortal.
 *
 * Returns `undefined` when there is nothing to write.
 */
export function mcpSlackConnectRefusedMarkerDueAt(
  widget: Pick<WidgetMessageMetadata, 'slack_connect_due_at' | 'requested_at'>,
  now = Date.now()
): string | undefined {
  const dueAt = widget.slack_connect_due_at;
  if (!dueAt) return undefined;
  const anchorSource = widget.requested_at ?? dueAt;
  const anchor = new Date(anchorSource).getTime();
  if (!Number.isFinite(anchor)) return undefined;
  const anchorIso = new Date(anchor).toISOString();
  const next = Math.min(
    now + MCP_SLACK_CONNECT_MARKER_BACKOFF_MS,
    anchor + MCP_SLACK_CONNECT_MARKER_MAX_AGE_MS
  );
  // Past the horizon the marker stays on the row — the refusals it is waiting
  // on are still reversible — but at an anchor the sweep can no longer see,
  // which is what it did before this function existed.
  return next <= now ? anchorIso : new Date(next).toISOString();
}

/**
 * Cheap guard run against every `messages` event before any repository read.
 *
 * A widget that was never Slack-delivered has no `slack_connect` record and
 * therefore no card; the projection must not wake for the far larger number of
 * canvas-only widgets, let alone for ordinary transcript rows.
 */
export function messageMayNeedMcpSlackConnectSync(message: unknown): boolean {
  if (!message || typeof message !== 'object') return false;
  const candidate = message as Message;
  if (candidate.type !== 'widget_request') return false;
  const widget = candidate.metadata?.widget;
  return widget?.widget_type === 'oauth' && !!widget.slack_connect;
}

/** Clamp a button label to Slack's limit without emitting a bare ellipsis. */
function clampButton(text: string): string {
  return text.length <= BUTTON_TEXT_MAX ? text : `${text.slice(0, BUTTON_TEXT_MAX - 1)}…`;
}

/**
 * Nudge the Slack card after a widget lifecycle transition, if it has one.
 *
 * Hooked into `WidgetResolutionStore`'s change callback — the single writer of
 * widget lifecycle state — rather than onto a global `messages` listener, so
 * the projection wakes for widget transitions and not for every transcript row
 * the daemon writes. The guard runs before the service lookup because most
 * widgets never acquire a `slack_connect` record at all.
 *
 * Deliberately silent on every failure: a card that missed one edit is
 * repaired by the bounded sweep, while a throw here would fail the widget
 * resolution that has already committed.
 */
export function notifyMcpSlackConnectCard(
  app: { service: (path: string) => unknown },
  message: unknown,
  params?: unknown
): void {
  if (!messageMayNeedMcpSlackConnectSync(message)) return;
  const widgetId = (message as Message).message_id;
  try {
    const gateway = app.service('gateway') as {
      syncMcpSlackConnectCardAfterCommit?: (id: MessageID, params?: unknown) => void;
    };
    gateway?.syncMcpSlackConnectCardAfterCommit?.(widgetId as MessageID, params);
  } catch {
    console.warn('[widgets] MCP connect card notification failed');
  }
}
