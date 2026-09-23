/**
 * One delivery engine, two MCP Slack lanes.
 *
 * `MCPSlackRecoveryNotice` (reactive: a mediated MCP call was refused with
 * `needs_reauth`, bound to the Task that failed) and `MCPSlackConnectDelivery`
 * (intent-initiated: an agent minted an `oauth` widget because somebody asked)
 * are two different authorization state machines. They are not merged here and
 * must not be. What they share is a *transport discipline* — one durable claim
 * held as a short lease, one `slack_message_ts` reconciled from Slack's own
 * message metadata when a crash lost it, a settlement CAS that must still own
 * the claim it started with, and a bounded retry with backoff — and two copies
 * of a discipline drift. They already had: the connect lane learned to retire
 * a post that lost its claim and the recovery lane never did.
 *
 * So this module owns the mechanics, and one authority question that is
 * genuinely common to both:
 *
 * - **Shared here:** claim construction and liveness, the failure/backoff
 *   transition, the repair-clamp, the lost-edit repaint transition, metadata
 *   reconciliation, orphan retirement, connector acquisition under a
 *   configuration change, and the timer bookkeeping.
 * - **Shared here, and it IS an authority decision:**
 *   {@link acquireSlackDeliveryConnector} refuses to deliver when the channel
 *   now belongs to a different Slack app (`teamId`) or when the recorded
 *   thread is no longer a permitted write target
 *   (`isSlackWriteTargetAllowed`). That is DELIVERY authority — may this
 *   daemon, as this app, write this card here — and both lanes ask it
 *   identically because it is a property of the channel rather than of either
 *   record. It is deliberately not OAuth or redemption authority: nothing
 *   here decides who may sign in, what a link grants, or whether one may be
 *   redeemed. Each lane takes the `app_moved` answer and does its own thing
 *   with it.
 * - **Deliberately NOT here:** which rendered state a record is in, what the
 *   card says, which token audience and binding set a link is sealed against,
 *   whether the record's generation predicates admit a re-issue, and whether
 *   completion repairs an active task or admits a new turn. Those are the two
 *   authority models, and they stay in their own lanes.
 *
 * The contract both lanes are held to is stated once, over both of them, in
 * `gateway-mcp-slack-delivery-contract.test.ts`.
 *
 * See `docs/internal/slack-mcp-oauth-connect-2026-09-16.md` §7.1.6.
 */

import { getCurrentTenantId } from '@agor/core/db';
import {
  type GatewayConnector,
  type GatewaySendReceipt,
  getConnector,
  isSlackWriteTargetAllowed,
  normalizeSendReceipt,
  SLACK_REQUEST_TIMEOUT_METADATA_KEY,
  type SlackAgorMessageMetadataEventType,
} from '@agor/core/gateway';
import type { GatewayChannel } from '@agor/core/types';
import { mcpSlackConnectBlocks } from './mcp-slack-connect-card.js';

/** Lease one daemon holds while posting or editing one card, in either lane. */
export const MCP_SLACK_DELIVERY_CLAIM_MS = 30_000;
/** How long a card in an active state may go unvisited before a repair tick. */
export const MCP_SLACK_ACTIVE_BACKSTOP_MS = 60_000;
/** Window within which a failing delivery keeps retrying at all. */
export const MCP_SLACK_DELIVERY_RETRY_WINDOW_MS = 15 * 60_000;
/** Attempts after which a card is permanently stranded and no sweep revisits it. */
export const MCP_SLACK_DELIVERY_MAX_ATTEMPTS = 6;
export const MCP_SLACK_DELIVERY_BACKOFF_MS = [
  5_000, 15_000, 30_000, 60_000, 120_000, 300_000,
] as const;
/** In-process repaints of a card whose render lost its claim. See §7.1.5. */
export const MCP_SLACK_REPAINT_ATTEMPTS = 2;

/**
 * How long either lane will wait on Slack for one card before giving up.
 *
 * Deliberately BELOW {@link MCP_SLACK_DELIVERY_CLAIM_MS}. A delivery that
 * outlives its own claim is not merely slow: another claimant may take the
 * expired lease, post the row that counts and release it, at which point this
 * one's receipt names a message nothing durable owns. The settlement CAS
 * already refuses to record that, and `retireOrphanedSlackCard` cleans it up —
 * but both are repairs for a race this deadline mostly prevents.
 *
 * A card write asks the connector for ONE attempt whose request timeout is
 * what is left of this budget (`SLACK_REQUEST_TIMEOUT_METADATA_KEY`), not the
 * shared client's five-retries-over-five-minutes ladder — a retried write
 * could otherwise land long after a later attempt settled the card. This
 * bounds the OPERATION, which is what a 30s lease actually needs. A send that trips it
 * raises, which lands in each lane's existing `catch` as
 * `slack_write_failed` and consumes one rung of the D1 ladder — a hang
 * becomes an already-tested failure rather than a caller that never returns.
 */
export const MCP_SLACK_SEND_TIMEOUT_MS = 15_000;

/**
 * Bound one outbound Slack operation.
 *
 * `Promise.race` cannot cancel the underlying request. What this guarantees is
 * that the CALLER stops waiting, which is the property every holder of a 30s
 * lease needs and the one nothing in either lane had.
 *
 * What it cannot guarantee is that the abandoned request does nothing. A
 * write Agor stopped waiting for can still land — and the shared web client's
 * `fiveRetriesInFiveMinutes` would keep retrying it for about five minutes,
 * long after a later attempt settled the card, which is why card writes do
 * not use that client (`SLACK_REQUEST_TIMEOUT_METADATA_KEY`). `onLate` is the handle on
 * that request: it runs with the value only if the operation resolves AFTER
 * the deadline won, so the caller can reconcile a receipt it had already
 * written off. A rejection after the deadline is dropped; it wrote nothing.
 */
export async function withSlackDeliveryDeadline<T>(
  operation: Promise<T>,
  timeoutMs: number = MCP_SLACK_SEND_TIMEOUT_MS,
  onLate?: (value: T) => void
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  let timedOut = false;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          timedOut = true;
          reject(new Error('Slack card delivery exceeded its deadline'));
        }, timeoutMs);
        timer.unref?.();
      }),
    ]);
  } catch (error) {
    if (timedOut && onLate) void operation.then(onLate, () => undefined);
    throw error;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** A card send that resolved after its deadline had already written it off. */
export interface LateSlackCardReceipt {
  receipt: GatewaySendReceipt;
  /** Set when the late send was an EDIT of this row; absent for a POST. */
  reconciledMessageTs?: string;
}

/**
 * What a lane does about a card write that landed after its deadline.
 *
 * The same two repairs a lost claim gets, because a timed-out send IS a send
 * whose claim was released: the lane recorded `slack_write_failed` and a later
 * attempt may already have settled the card.
 *
 *  - `repaint`: it EDITED the row the record owns, possibly over a newer state.
 *    Clearing `rendered_state` makes the next render repaint from the
 *    authority — a no-op when nothing newer had been rendered.
 *  - `retire`: it wrote a row the record does not own (a POST beside the owned
 *    one, or an edit of a row that is no longer this delivery's).
 *  - `adopt`: a POST and the record owns no row yet. Deleting it could race
 *    the next attempt, whose metadata lookup is what finds and adopts it.
 *  - `none`: the record already names the row it posted.
 */
export function lateSlackCardDisposition(
  late: LateSlackCardReceipt,
  current: { isThisDelivery: boolean; ownedTs?: string }
): 'repaint' | 'retire' | 'adopt' | 'none' {
  if (!current.isThisDelivery) return 'retire';
  if (late.reconciledMessageTs) {
    return late.reconciledMessageTs === current.ownedTs ? 'repaint' : 'retire';
  }
  if (!current.ownedTs) return 'adopt';
  return late.receipt.messageId === current.ownedTs ? 'none' : 'retire';
}

/** Durable ownership of one post/update attempt, across daemons. */
export interface SlackDeliveryClaim {
  claim_id: string;
  claimed_at: string;
  expires_at: string;
}

/**
 * The delivery fields both lane records carry, spelled identically.
 *
 * This is a structural constraint rather than a base type either record
 * extends: neither lane's record is defined in terms of the other, and the
 * point is to be able to run the shared mechanics over both without either
 * one acquiring the other's fields.
 */
export interface SlackDeliveryRecord {
  slack_message_ts?: string;
  rendered_state?: string;
  rendered_at?: string;
  delivery_claim?: SlackDeliveryClaim;
  delivery_attempt_count?: number;
  delivery_last_failed_at?: string;
  delivery_retry_until?: string;
  delivery_next_retry_at?: string;
  next_repair_at?: string;
}

/** Is somebody else still inside their lease on this record? */
export function slackDeliveryClaimIsLive(
  record: Pick<SlackDeliveryRecord, 'delivery_claim'> | undefined,
  now: number
): boolean {
  const claim = record?.delivery_claim;
  return !!claim && new Date(claim.expires_at).getTime() > now;
}

/** The claim this daemon is about to take, and the deadline it expires at. */
export function slackDeliveryClaim(claimId: string, now: number): SlackDeliveryClaim {
  return {
    claim_id: claimId,
    claimed_at: new Date(now).toISOString(),
    expires_at: new Date(now + MCP_SLACK_DELIVERY_CLAIM_MS).toISOString(),
  };
}

/**
 * When a card in an ACTIVE state should be looked at again.
 *
 * The clamp is shared; which states count as active is not — that is a
 * rendered-state predicate and belongs to the lane that owns the states. Each
 * lane passes the delay to its own expiry (the point at which the card stops
 * being able to offer its button) and gets back the sooner of that and the
 * backstop.
 */
export function slackDeliveryRepairAt(expiryDelay: number | undefined, now: number): string {
  return new Date(
    now + Math.min(expiryDelay ?? MCP_SLACK_ACTIVE_BACKSTOP_MS, MCP_SLACK_ACTIVE_BACKSTOP_MS)
  ).toISOString();
}

/**
 * Account for one failed Slack write, and decide whether to come back.
 *
 * Both lanes exhaust after `MCP_SLACK_DELIVERY_MAX_ATTEMPTS` inside a
 * 15-minute window opened by the first failure, after which the card is
 * stranded: the claim is released either way, but no next retry and no repair
 * deadline are recorded, so nothing revisits it.
 */
export function applySlackDeliveryFailure<TRecord extends SlackDeliveryRecord>(
  record: TRecord,
  now = new Date()
): TRecord {
  const attempt = (record.delivery_attempt_count ?? 0) + 1;
  const retryUntil = record.delivery_retry_until
    ? new Date(record.delivery_retry_until)
    : new Date(now.getTime() + MCP_SLACK_DELIVERY_RETRY_WINDOW_MS);
  const backoff =
    MCP_SLACK_DELIVERY_BACKOFF_MS[Math.min(attempt - 1, MCP_SLACK_DELIVERY_BACKOFF_MS.length - 1)]!;
  const next = new Date(now.getTime() + backoff);
  const canRetry =
    attempt < MCP_SLACK_DELIVERY_MAX_ATTEMPTS &&
    Number.isFinite(retryUntil.getTime()) &&
    next.getTime() <= retryUntil.getTime();
  return {
    ...record,
    delivery_claim: undefined,
    delivery_attempt_count: attempt,
    delivery_last_failed_at: now.toISOString(),
    delivery_retry_until: retryUntil.toISOString(),
    delivery_next_retry_at: canRetry ? next.toISOString() : undefined,
    next_repair_at: canRetry ? next.toISOString() : undefined,
  };
}

/**
 * Stop a record from claiming a render that was undone.
 *
 * The transition behind both lanes' lost-edit repaint: a delivery that EDITED
 * the recorded row orphans nothing, but it wrote a state a second claimant had
 * already superseded, and `rendered_state` is exactly what every later render
 * compares against — so the disagreement is self-sealing until the record
 * stops asserting it. Dropping the render and asking for an immediate repair
 * makes the next pass repaint from the authority (the task, or the widget row)
 * instead of skipping the card as a no-op.
 */
export function clearSlackRenderedState<TRecord extends SlackDeliveryRecord>(
  record: TRecord,
  now = new Date()
): TRecord {
  const { rendered_state: _state, rendered_at: _at, ...rest } = record;
  return { ...rest, next_repair_at: now.toISOString() } as TRecord;
}

/**
 * Has this record already been repainted onto `editedTs` with a state this
 * daemon no longer owns? A no-op when the winner happened to render the same
 * state, and fenced on the recorded `ts` so it can only ever unwind the
 * message this delivery actually wrote to.
 */
export function slackRenderWasLost(
  record: Pick<SlackDeliveryRecord, 'slack_message_ts' | 'rendered_state'> | undefined,
  editedTs: string,
  renderedState: string
): boolean {
  if (!record || record.slack_message_ts !== editedTs) return false;
  return record.rendered_state !== undefined && record.rendered_state !== renderedState;
}

/**
 * One key, one pending wake-up.
 *
 * Both lanes keep the same three kinds of timer — expiry, delivery retry, and
 * (recovery only) the OAuth start-claim repair — and every one of them was the
 * same five lines: don't double-schedule, drop the entry before running so the
 * work can re-schedule itself, `unref` so a pending card never holds the
 * process open, and clear the lot on dispose.
 *
 * Deliberately not a scheduler. It holds no tenant context, decides no delay,
 * and knows nothing about what it wakes; the lane supplies all three. A key
 * that is already waiting keeps its existing deadline rather than being pushed
 * out, which is what makes a repeated delivery attempt idempotent here.
 */
export class SlackDeliveryTimers {
  private timers = new Map<string, NodeJS.Timeout>();

  schedule(key: string, delay: number, run: () => void): void {
    if (this.timers.has(key)) return;
    const timer = setTimeout(() => {
      this.timers.delete(key);
      run();
    }, delay);
    timer.unref?.();
    this.timers.set(key, timer);
  }

  has(key: string): boolean {
    return this.timers.has(key);
  }

  cancel(key: string): void {
    const timer = this.timers.get(key);
    if (timer) clearTimeout(timer);
    this.timers.delete(key);
  }

  clear(): void {
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
  }
}

/**
 * Why one Slack delivery attempt failed, in Agor's own words.
 *
 * Chosen at the call site, never derived from the thrown value: an exception
 * from `@slack/web-api` carries a provider error code and often a message, and
 * `context/guidelines/logging.md` prohibits logging either. The call site
 * distinguishes the cases an operator would act on differently anyway.
 */
export type MCPSlackDeliveryFailureReason =
  /** No connector could be constructed for the channel's stored credentials. */
  | 'connector_unavailable'
  /** The connector was built but could not identify its own Slack app. */
  | 'app_identity_unavailable'
  /** The post or edit itself was refused. */
  | 'slack_write_failed'
  /**
   * An exception escaped the whole delivery while this pass held the claim.
   *
   * The one member that is not a decision: every other reason names something
   * the lane inspected and concluded, while this one names the absence of a
   * conclusion. It exists because an unclassified throw otherwise wrote
   * nothing at all — it leaks the claim, skips the accounting, and leaves an
   * overdue durable trigger to bring the same card back in thirty seconds
   * forever. A card reported this way did NOT reach Slack, and the sweep's
   * own tally carries the category of the exception on the same pass.
   */
  | 'unexpected_failure';

/** Which MCP Slack lane a delivery, failure or repair belongs to. */
export type MCPSlackLane = 'recovery' | 'connect';

/**
 * What the persisted retry decision says happens next to this card.
 *
 * Derived from the record the compare-and-set wrote, never re-decided here:
 * `applySlackDeliveryFailure` is the one place that decides whether a card
 * comes back, and reporting has to describe that decision rather than
 * approximate it from the attempt count.
 *
 * The two terminal answers are separated because the operator questions are
 * different. `attempts_exhausted` means the card was tried the full
 * {@link MCP_SLACK_DELIVERY_MAX_ATTEMPTS} times; `retry_window_exhausted`
 * means the 15-minute window closed FIRST — the next backoff would land past
 * `delivery_retry_until`, so the card is just as permanently stranded after,
 * say, four attempts. Counting to six was the old test for terminal, and it
 * reported that card as a routine, retryable `warn`.
 *
 * The two non-terminal answers are separated for the same reason: neither is
 * this daemon's failure to account for, and they are not the same event.
 */
export type SlackDeliveryRetryDisposition =
  /** Accounted, and a next attempt is scheduled. */
  | 'retrying'
  /** Accounted, and terminal: the attempt ceiling was reached. */
  | 'attempts_exhausted'
  /** Accounted, and terminal: the retry window closed before the ceiling. */
  | 'retry_window_exhausted'
  /** Not accounted: another claimant owns this record, so it is theirs to retry. */
  | 'ownership_lost'
  /** Not accounted: the durable write itself failed, so nothing is known. */
  | 'accounting_failed';

/** Terminal means nothing revisits the card — not that six attempts happened. */
export function slackDeliveryIsStranded(disposition: SlackDeliveryRetryDisposition): boolean {
  return disposition === 'attempts_exhausted' || disposition === 'retry_window_exhausted';
}

/**
 * Read the disposition off the write that accounted the failure.
 *
 * `delivery_next_retry_at` is the persisted decision: `applySlackDeliveryFailure`
 * sets it when and only when something will come back for this card, and
 * `recordSlackDeliveryFailure` schedules from the same field. So "will anything
 * revisit this?" is answered by the record, and the attempt count only says
 * WHICH terminal case it is.
 */
export function slackDeliveryRetryDisposition(
  write: SlackDeliveryWrite<SlackDeliveryRecord> | undefined
): SlackDeliveryRetryDisposition {
  if (!write) return 'accounting_failed';
  if (!write.changed || !write.record) return 'ownership_lost';
  if (write.record.delivery_next_retry_at) return 'retrying';
  return (write.record.delivery_attempt_count ?? 0) >= MCP_SLACK_DELIVERY_MAX_ATTEMPTS
    ? 'attempts_exhausted'
    : 'retry_window_exhausted';
}

/**
 * Report one failed Slack delivery attempt, and say when a card is stranded.
 *
 * Both lanes stop retrying at `MCP_SLACK_DELIVERY_MAX_ATTEMPTS` OR when the
 * 15-minute window closes, whichever comes first; after either the card is
 * permanently stranded and no sweep revisits it. That is the one outcome an
 * operator has to be able to see, so it is an `error` with `stranded=true`
 * rather than another indistinguishable `warn` — and the `disposition` field
 * says which of the four non-retrying endings this was, because "nobody is
 * coming back" and "somebody else owns it" are opposite instructions.
 *
 * Everything logged is Agor-owned: the operation, the entity ids needed to
 * correlate, the attempt count, a `reason` the daemon chose at the call site,
 * and the disposition it derived from its own record. No exception, message,
 * provider error code, thread id, channel id, server name, or URL —
 * `context/guidelines/logging.md` prohibits all of them, and the call site
 * already knows the more useful thing anyway.
 */
export function logSlackDeliveryFailure(
  lane: MCPSlackLane,
  reason: MCPSlackDeliveryFailureReason,
  ids: Record<string, string | undefined>,
  attempt: number | undefined,
  disposition: SlackDeliveryRetryDisposition
): void {
  const stranded = slackDeliveryIsStranded(disposition);
  const fields = [
    `event=mcp_slack_${lane}_delivery_failed`,
    `tenant_id=${getCurrentTenantId() ?? '<unknown>'}`,
    ...Object.entries(ids).map(([key, value]) => `${key}=${value ?? '<unknown>'}`),
    `reason=${reason}`,
    `attempt=${attempt ?? '<unknown>'}/${MCP_SLACK_DELIVERY_MAX_ATTEMPTS}`,
    `retrying=${disposition === 'retrying'}`,
    `stranded=${stranded}`,
    `disposition=${disposition}`,
  ].join(' ');
  if (stranded) console.error(`[gateway] ${fields}`);
  else console.warn(`[gateway] ${fields}`);
}

/** What acquiring a connector for one delivery produced. */
export type SlackDeliveryConnector =
  /**
   * Usable. `revalidated` is true when the channel's configuration generation
   * had moved since the record was written, and the app identity and write
   * target were therefore re-verified against freshly loaded credentials —
   * which is the point at which each lane has its own thing to say about a
   * link that was sealed against the old generation.
   */
  | { outcome: 'ready'; connector: GatewayConnector; revalidated: boolean }
  /** Accountable as a delivery attempt: retry with backoff, then strand. */
  | { outcome: 'failed'; reason: MCPSlackDeliveryFailureReason }
  /** The channel now belongs to a different Slack app, or may not write here. */
  | { outcome: 'app_moved' };

/**
 * Get the connector this delivery should go out through.
 *
 * A generation mismatch must never reuse the process-local listener: its
 * connector can still carry the pre-mutation token while a listener restart is
 * draining, so verification and delivery both happen on freshly loaded
 * credentials, and the freshly built connector is asked who it actually is
 * before anything is written.
 *
 * `generationCurrent` is the caller's, not this function's: the two lanes read
 * the sealed generation off different records and disagree about what an
 * absent one means, and that is a property of their records rather than of the
 * connector.
 */
export async function acquireSlackDeliveryConnector(
  channel: GatewayChannel,
  params: {
    generationCurrent: boolean;
    expectedTeamId: string;
    writeTargetChannel: string;
    activeListener: () => GatewayConnector | undefined;
  }
): Promise<SlackDeliveryConnector> {
  let connector: GatewayConnector;
  try {
    connector = params.generationCurrent
      ? (params.activeListener() ?? getConnector('slack', channel.config))
      : getConnector('slack', channel.config);
  } catch {
    return { outcome: 'failed', reason: 'connector_unavailable' };
  }
  if (params.generationCurrent) return { outcome: 'ready', connector, revalidated: false };

  let currentApp: Awaited<ReturnType<NonNullable<GatewayConnector['getAppInfo']>>> | undefined;
  try {
    // `getAppInfo` is an `auth.test` — a Slack call, made under the same 30s
    // claim the send below needs, and it is on the delivery path of BOTH
    // lanes. Bounded like the send: an identity check that does not answer in
    // time is `app_identity_unavailable`, a refusal both lanes already handle.
    currentApp = connector.getAppInfo
      ? await withSlackDeliveryDeadline(connector.getAppInfo())
      : undefined;
  } catch {
    return { outcome: 'failed', reason: 'app_identity_unavailable' };
  }
  if (
    currentApp?.teamId !== params.expectedTeamId ||
    !isSlackWriteTargetAllowed(channel.config, params.writeTargetChannel)
  ) {
    return { outcome: 'app_moved' };
  }
  return { outcome: 'ready', connector, revalidated: true };
}

/**
 * Post or edit the one Slack row this delivery owns, reconciling first.
 *
 * `findMessageByMetadata` is what stops a daemon that crashed between the post
 * and the `slack_message_ts` write from posting a second card with a second
 * live button: Slack's own message metadata carries the `delivery_id`, so the
 * row can be found again from the record alone. Only asked when the record has
 * no `ts` — once it does, that is the row, and this is an edit.
 *
 * Returns the reconciled `ts` alongside the receipt because the settlement CAS
 * needs to know which of the two this was: a fresh POST that loses its claim
 * orphaned a row nothing durable names, and an EDIT that loses its claim
 * repainted the row the record already names. Those are different repairs.
 */
export async function sendSlackCard(
  connector: GatewayConnector,
  params: {
    threadId: string;
    text: string;
    blocks: unknown[];
    eventType: SlackAgorMessageMetadataEventType;
    deliveryId: string;
    recordedTs?: string;
    /** Runs if the send lands after its deadline; see {@link lateSlackCardDisposition}. */
    onLateReceipt?: (late: LateSlackCardReceipt) => void;
  }
): Promise<{ receipt: GatewaySendReceipt; reconciledMessageTs?: string }> {
  // One budget over the whole card, not one per call: the reconciliation
  // lookup and the post/edit are two round-trips, and a deadline each would
  // let the pair outlast the 30s claim the caller is holding.
  const deadline = Date.now() + MCP_SLACK_SEND_TIMEOUT_MS;
  const remaining = (): number => Math.max(1, deadline - Date.now());
  let reconciledMessageTs = params.recordedTs;
  if (!reconciledMessageTs && connector.findMessageByMetadata) {
    // Already best-effort: a reconciliation that does not answer in time is
    // the same as one that failed, and the send below posts fresh.
    reconciledMessageTs = await withSlackDeliveryDeadline(
      connector.findMessageByMetadata({
        threadId: params.threadId,
        eventType: params.eventType,
        payloadKey: 'delivery_id',
        payloadValue: params.deliveryId,
        limit: 100,
      }),
      remaining()
    ).catch(() => undefined);
  }
  // One attempt, bounded by what is left of the budget, so the request is
  // dropped when Agor stops waiting rather than retried behind its back.
  const sendBudget = remaining();
  const sent = await withSlackDeliveryDeadline(
    connector.sendMessage({
      threadId: params.threadId,
      text: params.text,
      blocks: params.blocks,
      metadata: {
        [SLACK_REQUEST_TIMEOUT_METADATA_KEY]: sendBudget,
        ...(reconciledMessageTs ? { slack_update_ts: reconciledMessageTs } : {}),
        ...(!reconciledMessageTs
          ? {
              slack_message_metadata: {
                event_type: params.eventType,
                event_payload: { delivery_id: params.deliveryId },
              },
            }
          : {}),
      },
    }),
    sendBudget,
    params.onLateReceipt
      ? (late) =>
          params.onLateReceipt!({
            receipt: normalizeSendReceipt(late),
            ...(reconciledMessageTs ? { reconciledMessageTs } : {}),
          })
      : undefined
  );
  return {
    receipt: normalizeSendReceipt(sent),
    ...(reconciledMessageTs ? { reconciledMessageTs } : {}),
  };
}

/**
 * Retire a Slack row this daemon posted but turned out not to own.
 *
 * Shared by both MCP Slack lanes, because the lease is the same lease and
 * the mistake is the same mistake. A post that outlives its claim can land
 * after another claimant has already posted the row the record points at,
 * and this one's receipt then belongs to a second Slack message nothing
 * durable names. Repair only ever edits the recorded `ts`, so an orphan left
 * alone keeps whatever it was last rendered with — including a live button —
 * permanently. D7 accepted a stale card on the grounds that supersede
 * handles it; this is the case supersede cannot see, because the row is not
 * in the record.
 *
 * Deleting is the honest outcome: there is one card per widget (or per
 * notice) and this is not it. A connector that cannot delete gets an edit
 * instead, which at least takes the button away and points at the row that
 * is authoritative. Best effort throughout — the owned card is already
 * correct, and failing the delivery over a duplicate would only schedule
 * another one.
 */
export async function retireOrphanedSlackCard(
  connector: GatewayConnector,
  threadId: string,
  orphan: { orphanTs?: string; ownedTs?: string; text: string; lane: MCPSlackLane }
): Promise<void> {
  const { orphanTs, ownedTs, text } = orphan;
  if (!orphanTs || orphanTs === ownedTs) return;
  // Bounded like every other outbound card. This runs after a send that
  // already lost its claim, so the caller is past its lease and the owned card
  // is already correct — waiting here can only delay the next pass.
  try {
    if (connector.deleteMessage) {
      await withSlackDeliveryDeadline(connector.deleteMessage({ threadId, messageId: orphanTs }));
      return;
    }
    await withSlackDeliveryDeadline(
      connector.sendMessage({
        threadId,
        text,
        blocks: mcpSlackConnectBlocks({ text }),
        metadata: {
          [SLACK_REQUEST_TIMEOUT_METADATA_KEY]: MCP_SLACK_SEND_TIMEOUT_MS,
          slack_update_ts: orphanTs,
        },
      })
    );
  } catch {
    console.warn(`[gateway] MCP ${orphan.lane} duplicate Slack card could not be retired`);
  }
}

/** What one compare-and-set against a lane's delivery record resolved to. */
export interface SlackDeliveryWrite<TRecord extends SlackDeliveryRecord> {
  changed: boolean;
  /** The record as it stands AFTER the attempt, written or not. */
  record?: TRecord;
}

/**
 * Where one lane keeps its delivery record, and how to tell it is still the
 * one this delivery started on.
 *
 * The two lanes store the same discipline in two different places: the
 * recovery notice hangs off the Task's metadata and is written through
 * `TaskRepository.mutateMCPSlackRecoveryNotice`; the connect delivery hangs
 * off the widget MESSAGE's metadata and is written through
 * `mutateSlackConnectDelivery`. Both are compare-and-set inside one short row
 * lock, which is the only property the shared mechanics need.
 *
 * `TWrite` is open because the recovery lane's re-render needs the whole
 * mutated Task back — its rendered state reads the task's status, not just the
 * notice — while the connect lane re-reads everything from the widget row
 * anyway. An adapter may therefore hand back more than the record.
 *
 * `identifies` is the lane's, not the engine's: the recovery lane fences every
 * write on `notice_id` because a Task's notice can be REPLACED in place by a
 * later recovery generation, whereas a widget's delivery record is the widget's
 * for as long as the widget exists. Folding one lane's identity check onto the
 * other would be inventing a guarantee.
 */
export interface SlackDeliveryStore<
  TRecord extends SlackDeliveryRecord,
  TWrite extends SlackDeliveryWrite<TRecord> = SlackDeliveryWrite<TRecord>,
> {
  /** Agor-owned ids naming this record in a log line. Never a provider's. */
  readonly logIds: Record<string, string | undefined>;
  /** Is this still the record this delivery started on? */
  identifies(current: TRecord | undefined): boolean;
  /** Compare-and-set in one short row lock. Returning `null` writes nothing. */
  write(mutate: (current: TRecord | undefined) => TRecord | null): Promise<TWrite>;
}

/**
 * Account for one failed Slack write against the record that owns the claim.
 *
 * Fenced on the claim rather than merely on the record: the claim is a short
 * lease, so a write that outlives it can report a failure against an attempt
 * another daemon has since taken over, inflating a healthy card's attempt
 * count toward `stranded`.
 *
 * Best effort on the write itself — every caller is already reporting an
 * earlier failure and has nothing better to do with a second one — but never
 * silent: the log line goes out regardless, which is the §7.1.6 rule that a
 * repair failing before any Slack call still has to be visible.
 */
export async function recordSlackDeliveryFailure<TRecord extends SlackDeliveryRecord>(
  store: SlackDeliveryStore<TRecord, SlackDeliveryWrite<TRecord>>,
  params: {
    lane: MCPSlackLane;
    reason: MCPSlackDeliveryFailureReason;
    claimId: string;
    scheduleRetry: (delayMs: number) => void;
  }
): Promise<void> {
  const failed = await store
    .write((current) =>
      store.identifies(current) && current?.delivery_claim?.claim_id === params.claimId
        ? applySlackDeliveryFailure(current)
        : null
    )
    .catch(() => undefined);
  // Reported from the persisted decision, not re-derived: the write is the
  // only thing that knows whether this card comes back, and an exhausted retry
  // window strands a card that never reached the attempt ceiling.
  const disposition = slackDeliveryRetryDisposition(failed);
  const nextRetryAt =
    disposition === 'retrying' ? failed?.record?.delivery_next_retry_at : undefined;
  logSlackDeliveryFailure(
    params.lane,
    params.reason,
    store.logIds,
    failed?.record?.delivery_attempt_count,
    disposition
  );
  if (nextRetryAt) {
    params.scheduleRetry(Math.max(100, new Date(nextRetryAt).getTime() - Date.now()));
  }
}

/**
 * Stop the record claiming a render this daemon no longer owns.
 *
 * The durable half of both lanes' lost-edit repair; the caller decides whether
 * to re-render in process, because only it knows how many times it already has
 * and `MCP_SLACK_REPAINT_ATTEMPTS` bounds that. A `changed` result means the
 * record had a render that was undone; anything else is a no-op, including the
 * common case where the winning claimant happened to render the same state.
 */
export async function clearLostSlackRender<
  TRecord extends SlackDeliveryRecord,
  TWrite extends SlackDeliveryWrite<TRecord>,
>(
  store: SlackDeliveryStore<TRecord, TWrite>,
  editedTs: string,
  renderedState: string
): Promise<TWrite | undefined> {
  return store
    .write((current) =>
      store.identifies(current) && slackRenderWasLost(current, editedTs, renderedState)
        ? clearSlackRenderedState(current as TRecord)
        : null
    )
    .catch(() => undefined);
}
