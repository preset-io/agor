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
 * So this module owns the mechanics and nothing else:
 *
 * - **Shared here:** claim construction and liveness, the failure/backoff
 *   transition, the repair-clamp, the lost-edit repaint transition, metadata
 *   reconciliation, orphan retirement, connector acquisition under a
 *   configuration change, and the timer bookkeeping.
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
