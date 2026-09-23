/**
 * The shared delivery mechanics, tested once.
 *
 * `gateway-mcp-slack-delivery-contract.test.ts` states what both lanes must do
 * and drives them end to end; this file states what the engine underneath them
 * does, so a change to the mechanics fails here with a small, readable
 * diagnosis rather than only as a lane-level symptom. The two are
 * complementary: the contract suite is deliberately blind to how a lane
 * satisfies it, and is left byte-identical across the extraction for exactly
 * that reason.
 */

import { SLACK_REQUEST_TIMEOUT_METADATA_KEY } from '@agor/core/gateway';
import type { GatewayChannel } from '@agor/core/types';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const connectorFactory = vi.hoisted(() => ({
  build: vi.fn(() => ({ channelType: 'slack' }) as never),
}));

vi.mock('@agor/core/gateway', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('@agor/core/gateway');
  return { ...actual, getConnector: (...args: unknown[]) => connectorFactory.build(...args) };
});

import {
  acquireSlackDeliveryConnector,
  applySlackDeliveryFailure,
  clearLostSlackRender,
  clearSlackRenderedState,
  lateSlackCardDisposition,
  MCP_SLACK_DELIVERY_BACKOFF_MS,
  MCP_SLACK_DELIVERY_CLAIM_MS,
  MCP_SLACK_DELIVERY_MAX_ATTEMPTS,
  MCP_SLACK_SEND_TIMEOUT_MS,
  recordSlackDeliveryFailure,
  type SlackDeliveryRecord,
  type SlackDeliveryStore,
  SlackDeliveryTimers,
  sendSlackCard,
  slackDeliveryClaim,
  slackDeliveryClaimIsLive,
  slackDeliveryRepairAt,
  slackDeliveryRetryDisposition,
  slackRenderWasLost,
  withSlackDeliveryDeadline,
} from './mcp-slack-delivery-engine.js';

const CHANNEL = {
  id: 'gateway-1',
  enabled: true,
  channel_type: 'slack',
  provider_config_generation: 7,
  config: { bot_token: 'redacted', allowed_channel_ids: ['C1'] },
} as unknown as GatewayChannel;

beforeEach(() => {
  connectorFactory.build.mockReset();
  connectorFactory.build.mockImplementation(() => ({ channelType: 'slack' }) as never);
});

// ---------------------------------------------------------------------------
// Failure accounting and backoff
// ---------------------------------------------------------------------------

describe('applySlackDeliveryFailure', () => {
  const now = new Date('2026-09-18T12:00:00.000Z');

  it('opens a retry window on the first failure and releases the claim', () => {
    const next = applySlackDeliveryFailure(
      { delivery_claim: { claim_id: 'c1', claimed_at: '', expires_at: '' } },
      now
    );
    expect(next.delivery_claim).toBeUndefined();
    expect(next.delivery_attempt_count).toBe(1);
    expect(next.delivery_last_failed_at).toBe(now.toISOString());
    // The window is anchored to the FIRST failure, so a card cannot extend its
    // own eligibility by failing again.
    expect(new Date(next.delivery_retry_until!).getTime() - now.getTime()).toBe(15 * 60_000);
    expect(next.delivery_next_retry_at).toBe(
      new Date(now.getTime() + MCP_SLACK_DELIVERY_BACKOFF_MS[0]).toISOString()
    );
    // The repair deadline tracks the retry, so the sweep is the backstop for a
    // daemon that dies before its own timer fires.
    expect(next.next_repair_at).toBe(next.delivery_next_retry_at);
  });

  it('keeps the original window across later failures', () => {
    const first = applySlackDeliveryFailure({}, now);
    const later = new Date(now.getTime() + 60_000);
    const second = applySlackDeliveryFailure(first, later);
    expect(second.delivery_retry_until).toBe(first.delivery_retry_until);
    expect(second.delivery_attempt_count).toBe(2);
    expect(second.delivery_next_retry_at).toBe(
      new Date(later.getTime() + MCP_SLACK_DELIVERY_BACKOFF_MS[1]).toISOString()
    );
  });

  it('strands the card once the attempts are spent', () => {
    let record: SlackDeliveryRecord = {};
    let at = now;
    for (let i = 0; i < MCP_SLACK_DELIVERY_MAX_ATTEMPTS; i += 1) {
      record = applySlackDeliveryFailure(record, at);
      at = new Date(at.getTime() + 1_000);
    }
    expect(record.delivery_attempt_count).toBe(MCP_SLACK_DELIVERY_MAX_ATTEMPTS);
    // Nothing revisits it: no timer, and no due work for the sweep.
    expect(record.delivery_next_retry_at).toBeUndefined();
    expect(record.next_repair_at).toBeUndefined();
  });

  it('strands a card whose next backoff would land past the window', () => {
    const record = applySlackDeliveryFailure(
      { delivery_retry_until: new Date(now.getTime() + 1_000).toISOString() },
      now
    );
    expect(record.delivery_attempt_count).toBe(1);
    expect(record.delivery_next_retry_at).toBeUndefined();
    expect(record.next_repair_at).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Claims
// ---------------------------------------------------------------------------

describe('delivery claims', () => {
  it('leases for the shared claim window', () => {
    const now = Date.parse('2026-09-18T12:00:00.000Z');
    const claim = slackDeliveryClaim('c1', now);
    expect(claim.claim_id).toBe('c1');
    expect(new Date(claim.expires_at).getTime() - now).toBe(MCP_SLACK_DELIVERY_CLAIM_MS);
  });

  it('treats an absent, expired or exactly-due claim as free', () => {
    const now = 1_000_000;
    expect(slackDeliveryClaimIsLive(undefined, now)).toBe(false);
    expect(slackDeliveryClaimIsLive({}, now)).toBe(false);
    const at = (offset: number) => ({
      delivery_claim: {
        claim_id: 'c1',
        claimed_at: '',
        expires_at: new Date(now + offset).toISOString(),
      },
    });
    expect(slackDeliveryClaimIsLive(at(-1), now)).toBe(false);
    expect(slackDeliveryClaimIsLive(at(0), now)).toBe(false);
    expect(slackDeliveryClaimIsLive(at(1), now)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Repair scheduling
// ---------------------------------------------------------------------------

describe('slackDeliveryRepairAt', () => {
  const now = Date.parse('2026-09-18T12:00:00.000Z');

  it('falls back to the backstop when nothing expires sooner', () => {
    expect(new Date(slackDeliveryRepairAt(undefined, now)).getTime() - now).toBe(60_000);
  });

  it('comes back at the expiry when that is sooner', () => {
    expect(new Date(slackDeliveryRepairAt(5_000, now)).getTime() - now).toBe(5_000);
  });

  it('never waits longer than the backstop for a distant expiry', () => {
    expect(new Date(slackDeliveryRepairAt(10 * 60_000, now)).getTime() - now).toBe(60_000);
  });
});

// ---------------------------------------------------------------------------
// Lost renders
// ---------------------------------------------------------------------------

describe('lost render detection', () => {
  const recorded = { slack_message_ts: 'ts-1', rendered_state: 'cancelled' };

  it('only ever unwinds the message this delivery wrote to', () => {
    expect(slackRenderWasLost(recorded, 'ts-2', 'expired')).toBe(false);
    expect(slackRenderWasLost(undefined, 'ts-1', 'expired')).toBe(false);
  });

  it('is a no-op when the winner rendered the same state', () => {
    expect(slackRenderWasLost(recorded, 'ts-1', 'cancelled')).toBe(false);
  });

  it('is a no-op when no render is recorded at all', () => {
    expect(slackRenderWasLost({ slack_message_ts: 'ts-1' }, 'ts-1', 'expired')).toBe(false);
  });

  it('fires when the record asserts a render this delivery undid', () => {
    expect(slackRenderWasLost(recorded, 'ts-1', 'expired')).toBe(true);
  });

  it('drops the render and asks for an immediate repair', () => {
    const cleared = clearSlackRenderedState(
      { ...recorded, rendered_at: 'then', next_repair_at: undefined },
      new Date('2026-09-18T12:00:00.000Z')
    );
    expect(cleared.rendered_state).toBeUndefined();
    expect(cleared.rendered_at).toBeUndefined();
    expect(cleared.slack_message_ts).toBe('ts-1');
    expect(cleared.next_repair_at).toBe('2026-09-18T12:00:00.000Z');
  });
});

// ---------------------------------------------------------------------------
// Connector acquisition
// ---------------------------------------------------------------------------

describe('acquireSlackDeliveryConnector', () => {
  const listener = { channelType: 'slack', tag: 'listener' } as never;
  const base = {
    expectedTeamId: 'T1',
    writeTargetChannel: 'C1',
    activeListener: () => listener,
  };

  it('reuses the process-local listener while the generation is current', async () => {
    const result = await acquireSlackDeliveryConnector(CHANNEL, {
      ...base,
      generationCurrent: true,
    });
    expect(result).toEqual({ outcome: 'ready', connector: listener, revalidated: false });
    expect(connectorFactory.build).not.toHaveBeenCalled();
  });

  it('builds from stored credentials when there is no local listener', async () => {
    const result = await acquireSlackDeliveryConnector(CHANNEL, {
      ...base,
      generationCurrent: true,
      activeListener: () => undefined,
    });
    expect(result.outcome).toBe('ready');
    expect(connectorFactory.build).toHaveBeenCalledWith('slack', CHANNEL.config);
  });

  it('never reuses a draining listener across a generation change', async () => {
    // The listener's connector can still carry the pre-mutation token, which
    // is the whole reason a rotated channel re-loads credentials.
    connectorFactory.build.mockReturnValue({
      channelType: 'slack',
      getAppInfo: async () => ({ teamId: 'T1' }),
    } as never);
    const result = await acquireSlackDeliveryConnector(CHANNEL, {
      ...base,
      generationCurrent: false,
    });
    expect(result).toMatchObject({ outcome: 'ready', revalidated: true });
    expect(connectorFactory.build).toHaveBeenCalledWith('slack', CHANNEL.config);
  });

  it('refuses when the freshly loaded credentials name a different Slack app', async () => {
    connectorFactory.build.mockReturnValue({
      channelType: 'slack',
      getAppInfo: async () => ({ teamId: 'T2' }),
    } as never);
    const result = await acquireSlackDeliveryConnector(CHANNEL, {
      ...base,
      generationCurrent: false,
    });
    expect(result).toEqual({ outcome: 'app_moved' });
  });

  it('refuses when the reconfigured channel may no longer write to the thread', async () => {
    connectorFactory.build.mockReturnValue({
      channelType: 'slack',
      getAppInfo: async () => ({ teamId: 'T1' }),
    } as never);
    const result = await acquireSlackDeliveryConnector(CHANNEL, {
      ...base,
      generationCurrent: false,
      writeTargetChannel: 'C9',
    });
    expect(result).toEqual({ outcome: 'app_moved' });
  });

  it('accounts a connector that cannot be built as a delivery failure', async () => {
    connectorFactory.build.mockImplementation(() => {
      throw new Error('bad credentials');
    });
    const result = await acquireSlackDeliveryConnector(CHANNEL, {
      ...base,
      generationCurrent: true,
      activeListener: () => undefined,
    });
    expect(result).toEqual({ outcome: 'failed', reason: 'connector_unavailable' });
  });

  it('accounts an app identity that cannot be read as a delivery failure', async () => {
    connectorFactory.build.mockReturnValue({
      channelType: 'slack',
      getAppInfo: async () => {
        throw new Error('rate limited');
      },
    } as never);
    const result = await acquireSlackDeliveryConnector(CHANNEL, {
      ...base,
      generationCurrent: false,
    });
    expect(result).toEqual({ outcome: 'failed', reason: 'app_identity_unavailable' });
  });
});

// ---------------------------------------------------------------------------
// Send and reconcile
// ---------------------------------------------------------------------------

describe('withSlackDeliveryDeadline', () => {
  it('hands a late resolution to onLate, and only a late one', async () => {
    vi.useFakeTimers();
    try {
      const onLate = vi.fn();
      let resolveLate!: (value: string) => void;
      const late = withSlackDeliveryDeadline(
        new Promise<string>((resolve) => {
          resolveLate = resolve;
        }),
        1_000,
        onLate
      );
      const rejected = expect(late).rejects.toThrow('exceeded its deadline');
      await vi.advanceTimersByTimeAsync(1_001);
      await rejected;
      expect(onLate).not.toHaveBeenCalled();

      resolveLate('ts-late');
      await vi.advanceTimersByTimeAsync(0);
      expect(onLate).toHaveBeenCalledWith('ts-late');

      // In time: the caller gets the value and there is nothing late about it.
      const inTime = vi.fn();
      await expect(withSlackDeliveryDeadline(Promise.resolve('ts'), 1_000, inTime)).resolves.toBe(
        'ts'
      );
      expect(inTime).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('drops a rejection that arrives after the deadline; it wrote nothing', async () => {
    vi.useFakeTimers();
    try {
      const onLate = vi.fn();
      let rejectLate!: (error: Error) => void;
      const late = withSlackDeliveryDeadline(
        new Promise<string>((_resolve, reject) => {
          rejectLate = reject;
        }),
        1_000,
        onLate
      );
      const rejected = expect(late).rejects.toThrow('exceeded its deadline');
      await vi.advanceTimersByTimeAsync(1_001);
      await rejected;
      rejectLate(new Error('socket hang up'));
      await vi.advanceTimersByTimeAsync(0);
      expect(onLate).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('lateSlackCardDisposition', () => {
  const posted = { receipt: { messageId: 'ts-late' } };
  const edited = { receipt: { messageId: 'ts-owned' }, reconciledMessageTs: 'ts-owned' };

  it('repaints a late edit of the row the record owns', () => {
    expect(lateSlackCardDisposition(edited, { isThisDelivery: true, ownedTs: 'ts-owned' })).toBe(
      'repaint'
    );
  });

  it('retires a late write the record does not own', () => {
    expect(lateSlackCardDisposition(posted, { isThisDelivery: true, ownedTs: 'ts-owned' })).toBe(
      'retire'
    );
    expect(lateSlackCardDisposition(edited, { isThisDelivery: true, ownedTs: 'ts-other' })).toBe(
      'retire'
    );
    expect(lateSlackCardDisposition(edited, { isThisDelivery: false })).toBe('retire');
  });

  it('leaves a late post the record has not named yet for the next attempt to adopt', () => {
    // Deleting it could race that attempt's metadata lookup, which finds this
    // exact row by its delivery id and edits it.
    expect(lateSlackCardDisposition(posted, { isThisDelivery: true })).toBe('adopt');
  });

  it('does nothing once the record already names the row it posted', () => {
    expect(lateSlackCardDisposition(posted, { isThisDelivery: true, ownedTs: 'ts-late' })).toBe(
      'none'
    );
  });
});

describe('sendSlackCard', () => {
  function connector(found?: string) {
    const sends: Record<string, unknown>[] = [];
    const lookups: Record<string, unknown>[] = [];
    return {
      sends,
      lookups,
      connector: {
        channelType: 'slack' as const,
        findMessageByMetadata: async (request: Record<string, unknown>) => {
          lookups.push(request);
          return found;
        },
        sendMessage: async (request: Record<string, unknown>) => {
          sends.push(request);
          return 'ts-new';
        },
      } as never,
    };
  }

  const params = {
    threadId: 'C1-1.1',
    text: 'card',
    blocks: [],
    eventType: 'agor_mcp_connect' as const,
    deliveryId: 'delivery-1',
  };

  it('stamps its own delivery id on a first post so the row can be found again', async () => {
    const harness = connector(undefined);
    const result = await sendSlackCard(harness.connector, params);
    expect(harness.lookups[0]).toMatchObject({
      eventType: 'agor_mcp_connect',
      payloadKey: 'delivery_id',
      payloadValue: 'delivery-1',
    });
    expect(harness.sends[0]!.metadata).toEqual({
      [SLACK_REQUEST_TIMEOUT_METADATA_KEY]: expect.any(Number),
      slack_message_metadata: {
        event_type: 'agor_mcp_connect',
        event_payload: { delivery_id: 'delivery-1' },
      },
    });
    expect(result.receipt.messageId).toBe('ts-new');
    expect(result.reconciledMessageTs).toBeUndefined();
  });

  it('edits the row a crash lost the receipt for instead of posting a second', async () => {
    const harness = connector('ts-reconciled');
    const result = await sendSlackCard(harness.connector, params);
    expect(harness.sends[0]!.metadata).toEqual({
      [SLACK_REQUEST_TIMEOUT_METADATA_KEY]: expect.any(Number),
      slack_update_ts: 'ts-reconciled',
    });
    // The caller needs this to know it EDITED: a lost claim on a post orphans
    // a row, a lost claim on an edit repaints one. Different repairs.
    expect(result.reconciledMessageTs).toBe('ts-reconciled');
  });

  it('does not ask Slack anything once the record names its row', async () => {
    const harness = connector('ts-reconciled');
    const result = await sendSlackCard(harness.connector, { ...params, recordedTs: 'ts-1' });
    expect(harness.lookups).toHaveLength(0);
    expect(harness.sends[0]!.metadata).toEqual({
      [SLACK_REQUEST_TIMEOUT_METADATA_KEY]: expect.any(Number),
      slack_update_ts: 'ts-1',
    });
    expect(result.reconciledMessageTs).toBe('ts-1');
  });

  it('asks for one attempt bounded by the card budget, never the shared retry ladder', async () => {
    const harness = connector(undefined);
    await sendSlackCard(harness.connector, params);
    const budget = harness.sends[0]!.metadata as Record<string, number>;
    expect(budget[SLACK_REQUEST_TIMEOUT_METADATA_KEY]).toBeGreaterThan(0);
    expect(budget[SLACK_REQUEST_TIMEOUT_METADATA_KEY]).toBeLessThanOrEqual(
      MCP_SLACK_SEND_TIMEOUT_MS
    );
  });

  it('hands a send that lands after its deadline to onLateReceipt, edit or post', async () => {
    vi.useFakeTimers();
    try {
      let land!: (ts: string) => void;
      const onLateReceipt = vi.fn();
      const pending = sendSlackCard(
        {
          channelType: 'slack',
          sendMessage: () =>
            new Promise<string>((resolve) => {
              land = resolve;
            }),
        } as never,
        { ...params, recordedTs: 'ts-owned', onLateReceipt }
      );
      const rejected = expect(pending).rejects.toThrow('exceeded its deadline');
      await vi.advanceTimersByTimeAsync(MCP_SLACK_SEND_TIMEOUT_MS + 1);
      await rejected;

      land('ts-owned');
      await vi.advanceTimersByTimeAsync(0);
      expect(onLateReceipt).toHaveBeenCalledWith({
        receipt: { messageId: 'ts-owned' },
        reconciledMessageTs: 'ts-owned',
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('posts without reconciling against a connector that cannot search', async () => {
    const sends: Record<string, unknown>[] = [];
    const result = await sendSlackCard(
      {
        channelType: 'slack',
        sendMessage: async (request: Record<string, unknown>) => {
          sends.push(request);
          return 'ts-new';
        },
      } as never,
      params
    );
    expect(result.reconciledMessageTs).toBeUndefined();
    expect(sends[0]!.metadata).toHaveProperty('slack_message_metadata');
  });
});

// ---------------------------------------------------------------------------
// Storage adapters
// ---------------------------------------------------------------------------

/** Stands in for either lane: a record behind a compare-and-set. */
function store(
  initial: SlackDeliveryRecord | undefined,
  identity: (current: SlackDeliveryRecord | undefined) => boolean = (c) => !!c
): SlackDeliveryStore<SlackDeliveryRecord> & { current(): SlackDeliveryRecord | undefined } {
  let record = initial;
  return {
    logIds: { entity_id: 'entity-1' },
    identifies: identity,
    current: () => record,
    write: async (mutate) => {
      const next = mutate(record);
      if (!next) return { changed: false, record };
      record = next;
      return { changed: true, record };
    },
  };
}

describe('recordSlackDeliveryFailure', () => {
  const claim = { claim_id: 'c1', claimed_at: '', expires_at: '' };

  it('accounts the failure and schedules the retry it just decided on', async () => {
    const target = store({ delivery_claim: claim });
    const retries: number[] = [];
    await recordSlackDeliveryFailure(target, {
      lane: 'connect',
      reason: 'slack_write_failed',
      claimId: 'c1',
      scheduleRetry: (delay) => retries.push(delay),
    });
    expect(target.current()!.delivery_attempt_count).toBe(1);
    expect(retries).toHaveLength(1);
    expect(retries[0]!).toBeGreaterThan(0);
  });

  it('will not account a failure against a claim it no longer holds', async () => {
    // The claim is a short lease: a write that outlives it would otherwise
    // inflate a healthy card's attempt count toward `stranded`.
    const target = store({ delivery_claim: { ...claim, claim_id: 'c2' } });
    const retries: number[] = [];
    await recordSlackDeliveryFailure(target, {
      lane: 'recovery',
      reason: 'slack_write_failed',
      claimId: 'c1',
      scheduleRetry: (delay) => retries.push(delay),
    });
    expect(target.current()!.delivery_attempt_count).toBeUndefined();
    expect(retries).toHaveLength(0);
  });

  it('will not account a failure against another record on the same row', async () => {
    const target = store({ delivery_claim: claim }, () => false);
    await recordSlackDeliveryFailure(target, {
      lane: 'recovery',
      reason: 'slack_write_failed',
      claimId: 'c1',
      scheduleRetry: () => undefined,
    });
    expect(target.current()!.delivery_attempt_count).toBeUndefined();
  });

  it('schedules nothing once the card is stranded', async () => {
    const target = store({
      delivery_claim: claim,
      delivery_attempt_count: MCP_SLACK_DELIVERY_MAX_ATTEMPTS - 1,
    });
    const retries: number[] = [];
    await recordSlackDeliveryFailure(target, {
      lane: 'connect',
      reason: 'slack_write_failed',
      claimId: 'c1',
      scheduleRetry: (delay) => retries.push(delay),
    });
    expect(target.current()!.delivery_attempt_count).toBe(MCP_SLACK_DELIVERY_MAX_ATTEMPTS);
    expect(retries).toHaveLength(0);
  });

  it('reports an exhausted retry window as stranded, before the attempt ceiling', async () => {
    // The laundering this closes: terminal was tested by counting to six, but
    // `applySlackDeliveryFailure` also gives up when the next backoff would
    // land past `delivery_retry_until`. A card stranded that way — nothing
    // reschedules it, nothing revisits it — was reported as a routine `warn`
    // with `stranded=false`, indistinguishable from a first transient failure.
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const target = store({
      delivery_claim: claim,
      delivery_attempt_count: 1,
      // The window closes in a second; the next backoff is fifteen.
      delivery_retry_until: new Date(Date.now() + 1_000).toISOString(),
    });
    const retries: number[] = [];
    await recordSlackDeliveryFailure(target, {
      lane: 'connect',
      reason: 'slack_write_failed',
      claimId: 'c1',
      scheduleRetry: (delay) => retries.push(delay),
    });

    expect(target.current()!.delivery_next_retry_at).toBeUndefined();
    expect(retries).toHaveLength(0);
    expect(warn).not.toHaveBeenCalled();
    const line = error.mock.calls.at(-1)?.[0] as string;
    expect(line).toContain('stranded=true');
    expect(line).toContain('disposition=retry_window_exhausted');
    // Two attempts, not six: the count is not what made it terminal.
    expect(line).toContain(`attempt=2/${MCP_SLACK_DELIVERY_MAX_ATTEMPTS}`);
    error.mockRestore();
    warn.mockRestore();
  });

  it('distinguishes lost ownership and failed accounting from an ending', async () => {
    // Neither is terminal for the CARD, and neither is this daemon's to
    // report as one: another claimant will retry the first, and the second
    // leaves the claim to expire. They were both `stranded=false retrying=false`
    // — the same line an exhausted card used to produce.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const foreign = store({ delivery_claim: { ...claim, claim_id: 'c2' } });
    await recordSlackDeliveryFailure(foreign, {
      lane: 'connect',
      reason: 'slack_write_failed',
      claimId: 'c1',
      scheduleRetry: () => undefined,
    });
    expect(warn.mock.calls.at(-1)?.[0]).toContain('disposition=ownership_lost');

    const broken: SlackDeliveryStore<SlackDeliveryRecord> = {
      logIds: { entity_id: 'entity-1' },
      identifies: () => true,
      write: async () => {
        throw new Error('row lock lost');
      },
    };
    await recordSlackDeliveryFailure(broken, {
      lane: 'recovery',
      reason: 'slack_write_failed',
      claimId: 'c1',
      scheduleRetry: () => undefined,
    });
    const line = warn.mock.calls.at(-1)?.[0] as string;
    expect(line).toContain('disposition=accounting_failed');
    expect(line).toContain('stranded=false');
    warn.mockRestore();
  });

  it('derives the disposition from the persisted record alone', () => {
    // The unit underneath the three cases above: no re-decision, no clock.
    expect(slackDeliveryRetryDisposition(undefined)).toBe('accounting_failed');
    expect(slackDeliveryRetryDisposition({ changed: false, record: {} })).toBe('ownership_lost');
    expect(
      slackDeliveryRetryDisposition({
        changed: true,
        record: { delivery_attempt_count: 2, delivery_next_retry_at: 'later' },
      })
    ).toBe('retrying');
    expect(
      slackDeliveryRetryDisposition({ changed: true, record: { delivery_attempt_count: 2 } })
    ).toBe('retry_window_exhausted');
    expect(
      slackDeliveryRetryDisposition({
        changed: true,
        record: { delivery_attempt_count: MCP_SLACK_DELIVERY_MAX_ATTEMPTS },
      })
    ).toBe('attempts_exhausted');
  });

  it('still reports a failure the durable write could not record', async () => {
    // §7.1.6: a repair that throws before any Slack call has no attempt, no
    // backoff and — until this — no log line either.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const broken: SlackDeliveryStore<SlackDeliveryRecord> = {
      logIds: { entity_id: 'entity-1' },
      identifies: () => true,
      write: async () => {
        throw new Error('row lock lost');
      },
    };
    await recordSlackDeliveryFailure(broken, {
      lane: 'connect',
      reason: 'connector_unavailable',
      claimId: 'c1',
      scheduleRetry: () => undefined,
    });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]![0]).toContain('event=mcp_slack_connect_delivery_failed');
    expect(warn.mock.calls[0]![0]).toContain('reason=connector_unavailable');
    // Never the exception, and never anything the provider said.
    expect(warn.mock.calls[0]![0]).not.toContain('row lock lost');
    warn.mockRestore();
  });
});

describe('clearLostSlackRender', () => {
  it('clears the render and reports the write to the caller', async () => {
    const target = store({ slack_message_ts: 'ts-1', rendered_state: 'cancelled' });
    const result = await clearLostSlackRender(target, 'ts-1', 'expired');
    expect(result?.changed).toBe(true);
    expect(target.current()!.rendered_state).toBeUndefined();
    expect(target.current()!.next_repair_at).toBeDefined();
  });

  it('leaves a record it does not identify alone', async () => {
    const target = store({ slack_message_ts: 'ts-1', rendered_state: 'cancelled' }, () => false);
    const result = await clearLostSlackRender(target, 'ts-1', 'expired');
    expect(result?.changed).toBe(false);
    expect(target.current()!.rendered_state).toBe('cancelled');
  });

  it('swallows a failed write rather than failing the delivery over it', async () => {
    const broken: SlackDeliveryStore<SlackDeliveryRecord> = {
      logIds: {},
      identifies: () => true,
      write: async () => {
        throw new Error('row lock lost');
      },
    };
    await expect(clearLostSlackRender(broken, 'ts-1', 'expired')).resolves.toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Timers
// ---------------------------------------------------------------------------

describe('SlackDeliveryTimers', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    return () => vi.useRealTimers();
  });

  it('keeps the earlier deadline when a key is scheduled twice', async () => {
    const timers = new SlackDeliveryTimers();
    const fired: string[] = [];
    timers.schedule('k', 10, () => fired.push('first'));
    timers.schedule('k', 1_000, () => fired.push('second'));
    await vi.advanceTimersByTimeAsync(1_100);
    expect(fired).toEqual(['first']);
  });

  it('frees the key before running, so the work can re-schedule itself', async () => {
    const timers = new SlackDeliveryTimers();
    const fired: string[] = [];
    timers.schedule('k', 10, () => {
      fired.push('first');
      timers.schedule('k', 10, () => fired.push('second'));
    });
    await vi.advanceTimersByTimeAsync(100);
    expect(fired).toEqual(['first', 'second']);
  });

  it('cancels and clears without firing', async () => {
    const timers = new SlackDeliveryTimers();
    const fired: string[] = [];
    timers.schedule('a', 10, () => fired.push('a'));
    timers.schedule('b', 10, () => fired.push('b'));
    expect(timers.has('a')).toBe(true);
    timers.cancel('a');
    expect(timers.has('a')).toBe(false);
    timers.clear();
    await vi.advanceTimersByTimeAsync(100);
    expect(fired).toEqual([]);
  });
});
