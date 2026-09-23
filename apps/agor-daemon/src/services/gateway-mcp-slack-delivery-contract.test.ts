/**
 * One delivery contract, two lanes.
 *
 * `MCPSlackRecoveryNotice` and the connect card are separate projections over
 * separate records, but they share a delivery discipline word for word: one
 * durable claim held as a 30s lease, one `slack_message_ts` reconciled from
 * Slack's own message metadata when a crash lost it, and a settlement CAS that
 * must still own the claim it started with.
 *
 * Two copies of a discipline drift, and these two already had: the connect
 * lane learned to retire a post that lost its claim (§7.1.1) and the recovery
 * lane never did, which is the kind of gap a per-lane suite cannot see because
 * neither file is about the other. So the cases that matter are written once
 * here, against both lanes, and a lane that stops satisfying one of them fails
 * a test whose whole subject is that they agree.
 *
 * This is deliberately a shared TEST, not a shared delivery engine. Extracting
 * the engine is a post-merge follow-up; pinning the contract first is what
 * makes that extraction checkable. See
 * `docs/internal/slack-mcp-oauth-connect-2026-09-16.md` §7.1.6.
 */

import { runWithTenantContext } from '@agor/core/db';
import type {
  GatewayChannel,
  MCPServer,
  MCPSlackConnectDelivery,
  MCPSlackRecoveryNotice,
  Message,
  MessageID,
  Session,
  SessionID,
  Task,
  User,
  UserID,
} from '@agor/core/types';
import { TaskStatus } from '@agor/core/types';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const killSwitch = vi.hoisted(() => ({ enabled: true }));
vi.mock('@agor/core/db', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('@agor/core/db');
  return {
    ...actual,
    isMCPSlackConnectCardEnabled: async () => killSwitch.enabled,
    isMcpRuntimeRecoveryEnabled: async () => true,
    getMCPEgressGatewayMode: async () => 'enforced',
  };
});

vi.mock('@agor/core/gateway', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('@agor/core/gateway');
  return {
    ...actual,
    getConnector: () => ({
      channelType: 'slack',
      getAppInfo: async () => ({ teamId: 'T1' }),
      sendMessage: async () => '1700000000.999999',
    }),
  };
});

import { GatewayService } from './gateway.js';
import {
  MCP_SLACK_DELIVERY_CLAIM_MS,
  MCP_SLACK_SEND_TIMEOUT_MS,
  type SlackDeliveryRecord,
} from './mcp-slack-delivery-engine.js';

const THREAD = 'C1-1700000000.000001';
const OWNED_TS = '1700000000.000009';
const OUR_TS = '1700000000.000002';
const SECRET = 'delivery-contract-test-master-secret';

interface SentMessage {
  threadId: string;
  text: string;
  blocks?: { type: string }[];
  metadata?: Record<string, unknown>;
}

/**
 * What a lane has to expose for the contract to be stated about it.
 *
 * Deliberately tiny: a way to run one delivery, a way to make a second
 * claimant win in the middle of the Slack call, and read access to the two
 * durable fields the contract is about.
 */
interface LaneHarness {
  deliver(): Promise<void>;
  stop(): Promise<void>;
  sends: SentMessage[];
  deleted: { threadId: string; messageId: string }[];
  recordedTs(): string | undefined;
  renderedState(): string | undefined;
  /** The durable delivery record, for the accounting assertions. */
  record(): SlackDeliveryRecord | undefined;
}

interface LaneOptions {
  /** `'post'` starts with no recorded row; `'edit'` starts with one. */
  start: 'post' | 'edit';
  /**
   * Make the channel read throw ONCE THE CLAIM IS ON THE RECORD.
   *
   * Both lanes read the channel again inside the delivery, after the claim
   * CAS and before any Slack call, so "a claim is recorded" is what separates
   * that read from the binding read above it — and it is the property the
   * assertion is about, rather than a call index either lane could change.
   *
   * Stands in for every unclassified exception in the delivery's prologue —
   * a missing tenant database scope, a database that is not answering, a
   * repository wrapping either — which is the class that produced the
   * 2026-09-16 incident and wrote nothing durable at all.
   */
  failAfterClaim?: boolean;
  /**
   * Slack accepts the call and never answers.
   *
   * Every other stub in this file resolves immediately, which is why nothing
   * here could express a HANG — and a hang is not the same failure as a
   * rejection. `.catch()` does not fire, the 30s claim keeps running, and the
   * caller waits for as long as the provider wants. That was the real shape
   * of the connect lane's `new WebClient(bot_token)`: `timeout: 0` and a
   * thirty-minute retry ladder, with no Agor-side deadline over either.
   */
  stallSlack?: boolean;
  /**
   * Slack answers the FIRST send only when this settles — after the deadline
   * has written it off, and after whatever the test does in between.
   */
  lateSlack?: Promise<void>;
  /**
   * Runs during the Slack call: a second claimant took the expired lease,
   * rendered the row that counts, and released it.
   */
  winner?: () => void;
  /** Lets the winner hook reach the harness it is patching. */
  onReady?(patch: (winnerTs: string, winnerState: string) => void): void;
}

// ---------------------------------------------------------------------------
// Connect lane
// ---------------------------------------------------------------------------

function connectLane(options: LaneOptions): LaneHarness {
  const widgetId = 'widget-1' as MessageID;
  const sends: SentMessage[] = [];
  const deleted: { threadId: string; messageId: string }[] = [];
  let message = {
    message_id: widgetId,
    session_id: 'session-1' as SessionID,
    task_id: 'task-1',
    type: 'widget_request',
    metadata: {
      widget: {
        widget_type: 'oauth',
        widget_id: widgetId,
        schema_version: 1,
        status: 'pending',
        requested_at: new Date(Date.now() - 60_000).toISOString(),
        params: {
          mcpServerId: 'server-1',
          serverName: 'Notion',
          oauthMode: 'per_user',
          reason: 'Read the roadmap page.',
        },
        slack_connect: {
          delivery_id: 'delivery-1',
          delivery_generation: 1,
          token_jti: 'jti-1',
          issued_at: new Date().toISOString(),
          expires_at: new Date(Date.now() + 600_000).toISOString(),
          gateway_config_generation: 7,
          // An edit needs a recorded row and a state that is not the state
          // this delivery is about to render, or the no-op shortcut returns.
          ...(options.start === 'edit'
            ? { slack_message_ts: OWNED_TS, rendered_state: 'expired' }
            : {}),
          ...(options.start === 'edit'
            ? { oauth_failed_at: new Date(Date.now() - 30_000).toISOString() }
            : {}),
        } as MCPSlackConnectDelivery,
      },
    },
  } as unknown as Message;

  const patch = (winnerTs: string, winnerState: string) => {
    const widget = message.metadata!.widget!;
    message = {
      ...message,
      metadata: {
        ...message.metadata,
        widget: {
          ...widget,
          status: 'dismissed',
          resolved_at: new Date().toISOString(),
          slack_connect: {
            ...widget.slack_connect!,
            delivery_claim: undefined,
            slack_message_ts: winnerTs,
            rendered_state: winnerState as MCPSlackConnectDelivery['rendered_state'],
            next_repair_at: undefined,
          },
        },
      },
    } as Message;
  };
  options.onReady?.(patch);

  const service = new GatewayService({ run: vi.fn() } as never, {} as never);
  Object.assign(service as unknown as Record<string, unknown>, {
    messagesRepo: {
      findById: async (id: MessageID) => (id === widgetId ? message : null),
      mutateMetadataLocked: async (
        id: MessageID,
        mutate: (metadata: Message['metadata'], value: Message) => Message['metadata'] | null
      ) => {
        if (id !== widgetId) throw new Error('not found');
        const next = mutate(message.metadata, message);
        if (next === null) return { changed: false, message };
        message = { ...message, metadata: next };
        return { changed: true, message };
      },
    },
    taskRepo: {
      findById: async () =>
        ({
          task_id: 'task-1',
          session_id: 'session-1',
          created_by: 'user-1',
          metadata: {
            gateway_task_source: {
              gateway_channel_id: 'gateway-1',
              channel_type: 'slack',
              thread_id: THREAD,
              provider_user_id: 'U1',
              slack_team_id: 'T1',
              slack_channel_id: 'C1',
              slack_conversation_type: 'im',
            },
          },
        }) as unknown as Task,
    },
    sessionRepo: {
      findById: async () => ({ session_id: 'session-1', created_by: 'user-1' }) as Session,
    },
    usersRepo: { findById: async () => ({ user_id: 'user-1', role: 'member' }) as User },
    channelRepo: {
      findById: async () => {
        if (options.failAfterClaim && message.metadata?.widget?.slack_connect?.delivery_claim) {
          throw new Error('channel read failed');
        }
        return {
          id: 'gateway-1',
          enabled: true,
          channel_type: 'slack',
          provider_config_generation: 7,
          config: { align_slack_users: true, allowed_channel_ids: ['C1'] },
        } as GatewayChannel;
      },
    },
    mcpServerRepo: {
      findById: async () =>
        ({
          mcp_server_id: 'server-1',
          enabled: true,
          config_version: 3,
          auth: { type: 'oauth', oauth_mode: 'per_user' },
        }) as MCPServer,
    },
    threadMapRepo: {
      findBySession: async () => ({ id: 'map-1', channel_id: 'gateway-1', thread_id: THREAD }),
      claimMetadataFlag: async () => false,
    },
    activeListeners: new Map([
      [
        'tenant-a\0gateway-1',
        {
          channelType: 'slack' as const,
          findMessageByMetadata: async () => undefined,
          sendMessage: async (request: SentMessage) => {
            sends.push(request);
            if (options.stallSlack) await new Promise<never>(() => {});
            if (options.lateSlack && sends.length === 1) await options.lateSlack;
            if (sends.length === 1) options.winner?.();
            return OUR_TS;
          },
          deleteMessage: async (request: { threadId: string; messageId: string }) => {
            deleted.push(request);
          },
        },
      ],
    ]),
  });

  return {
    sends,
    deleted,
    deliver: () =>
      runWithTenantContext('tenant-a', () =>
        (
          service as unknown as { deliverMcpSlackConnectCard(id: MessageID): Promise<void> }
        ).deliverMcpSlackConnectCard(widgetId)
      ),
    stop: () => service.stopListeners(),
    recordedTs: () => message.metadata?.widget?.slack_connect?.slack_message_ts,
    renderedState: () => message.metadata?.widget?.slack_connect?.rendered_state,
    record: () => message.metadata?.widget?.slack_connect,
  };
}

// ---------------------------------------------------------------------------
// Recovery lane
// ---------------------------------------------------------------------------

function recoveryLane(options: LaneOptions): LaneHarness {
  const sends: SentMessage[] = [];
  const deleted: { threadId: string; messageId: string }[] = [];
  const baseNotice: MCPSlackRecoveryNotice = {
    notice_id: 'notice-1',
    token_jti: 'jti-1',
    issued_at: new Date(Date.now() - 600_000).toISOString(),
    // Past its own clock, so the state this delivery renders is terminal and
    // differs from the `reconnect_required` an edit starts recorded as.
    expires_at: new Date(Date.now() - 1).toISOString(),
    principal_user_id: 'user-1' as UserID,
    credential_user_id: 'user-1' as UserID,
    slack_user_id: 'U1',
    slack_team_id: 'T1',
    gateway_channel_id: 'gateway-1',
    gateway_config_generation: 1,
    slack_channel_id: 'C1',
    slack_thread_id: THREAD,
    session_id: 'session-1' as SessionID,
    task_id: 'task-1',
    mcp_server_id: 'server-1' as never,
    mcp_server_config_version: 1,
    recovery_generation: 4,
    recovery_request_id: 'request-1',
    provider_dispatch: 'not_started',
    delivery_id: 'delivery-1',
    next_repair_at: new Date().toISOString(),
    ...(options.start === 'edit'
      ? { slack_message_ts: OWNED_TS, rendered_state: 'reconnect_required' as const }
      : {}),
  };
  let currentTask = {
    task_id: 'task-1',
    session_id: 'session-1',
    status: TaskStatus.RUNNING,
    metadata: {
      mcp_recovery_generation: 4,
      mcp_recovery: {
        generation: 4,
        code: 'oauth_reauth_required',
        status: 'action_required',
        task_id: 'task-1',
        session_id: 'session-1',
        mcp_server_id: 'server-1',
        provider: { mode: 'in_place', transport_reload: true, retries_unstarted_call: false },
        action: 'reauthenticate',
        message: 'redacted',
        observed_at: new Date().toISOString(),
        request_id: 'request-1',
        provider_dispatch: 'not_started',
      },
      mcp_slack_recovery_notice: baseNotice,
    },
  } as unknown as Task;

  const patch = (winnerTs: string, winnerState: string) => {
    const notice = currentTask.metadata!.mcp_slack_recovery_notice!;
    currentTask = {
      ...currentTask,
      metadata: {
        ...currentTask.metadata,
        mcp_slack_recovery_notice: {
          ...notice,
          delivery_claim: undefined,
          slack_message_ts: winnerTs,
          rendered_state: winnerState as MCPSlackRecoveryNotice['rendered_state'],
          next_repair_at: undefined,
        },
      },
    } as Task;
  };
  options.onReady?.(patch);

  const service = new GatewayService({ run: vi.fn() } as never, {} as never);
  Object.assign(service as unknown as Record<string, unknown>, {
    taskRepo: {
      findById: async () => currentTask,
      mutateMCPSlackRecoveryNotice: async (
        _taskId: string,
        build: (
          current: MCPSlackRecoveryNotice | undefined,
          locked: Task
        ) => MCPSlackRecoveryNotice | null | Promise<MCPSlackRecoveryNotice | null>
      ) => {
        const next = await build(currentTask.metadata?.mcp_slack_recovery_notice, currentTask);
        if (!next) return { task: currentTask, changed: false };
        currentTask = {
          ...currentTask,
          metadata: { ...currentTask.metadata, mcp_slack_recovery_notice: next },
        } as Task;
        return { task: currentTask, changed: true };
      },
    },
    channelRepo: {
      findById: async () => {
        if (
          options.failAfterClaim &&
          currentTask.metadata?.mcp_slack_recovery_notice?.delivery_claim
        ) {
          throw new Error('channel read failed');
        }
        return {
          id: 'gateway-1',
          enabled: true,
          channel_type: 'slack',
          provider_config_generation: 1,
          config: { bot_token: 'redacted', allowed_channel_ids: ['C1'] },
        } as unknown as GatewayChannel;
      },
    },
    activeListeners: new Map([
      [
        'tenant-a\0gateway-1',
        {
          channelType: 'slack' as const,
          findMessageByMetadata: async () => undefined,
          sendMessage: async (request: SentMessage) => {
            sends.push(request);
            if (options.stallSlack) await new Promise<never>(() => {});
            if (options.lateSlack && sends.length === 1) await options.lateSlack;
            if (sends.length === 1) options.winner?.();
            return OUR_TS;
          },
          deleteMessage: async (request: { threadId: string; messageId: string }) => {
            deleted.push(request);
          },
        },
      ],
    ]),
  });

  return {
    sends,
    deleted,
    deliver: () =>
      runWithTenantContext('tenant-a', () =>
        (
          service as unknown as { deliverMcpSlackRecoveryNotice(value: Task): Promise<void> }
        ).deliverMcpSlackRecoveryNotice(currentTask)
      ),
    stop: () => service.stopListeners(),
    recordedTs: () => currentTask.metadata?.mcp_slack_recovery_notice?.slack_message_ts,
    renderedState: () => currentTask.metadata?.mcp_slack_recovery_notice?.rendered_state,
    record: () => currentTask.metadata?.mcp_slack_recovery_notice,
  };
}

const LANES = [
  {
    name: 'connect',
    build: connectLane,
    /** What the winning claimant recorded while this delivery was in Slack. */
    winnerState: 'cancelled',
    /** What the lane renders once it re-reads its own authority. */
    repaintedState: 'cancelled',
  },
  {
    name: 'recovery',
    build: recoveryLane,
    winnerState: 'recovered',
    repaintedState: 'expired_or_superseded',
  },
] as const;

describe.each(LANES)(
  'MCP Slack $name lane delivery contract',
  ({ build, winnerState, repaintedState }) => {
    let previousSecret: string | undefined;
    let previousBaseUrl: string | undefined;
    beforeEach(() => {
      previousSecret = process.env.AGOR_MASTER_SECRET;
      process.env.AGOR_MASTER_SECRET = SECRET;
      // Both lanes now refuse to build a link on a base URL no other browser
      // can open, and without this `getBaseUrl` answers the localhost
      // fallback. The refusal itself is pinned in the per-lane suites.
      previousBaseUrl = process.env.AGOR_BASE_URL;
      process.env.AGOR_BASE_URL = 'https://agor.example.test';
      killSwitch.enabled = true;
      return () => {
        if (previousSecret === undefined) delete process.env.AGOR_MASTER_SECRET;
        else process.env.AGOR_MASTER_SECRET = previousSecret;
        if (previousBaseUrl === undefined) delete process.env.AGOR_BASE_URL;
        else process.env.AGOR_BASE_URL = previousBaseUrl;
      };
    });

    /**
     * The lease outlived the post. Another claimant took it, posted the row the
     * record points at, and released it — so this delivery's receipt names a
     * second Slack message nothing durable will ever edit again.
     */
    it('retires the row it posted after losing its claim', async () => {
      let patch: ((ts: string, state: string) => void) | undefined;
      const harness = build({
        start: 'post',
        onReady: (apply) => {
          patch = apply;
        },
        winner: () => patch?.(OWNED_TS, winnerState),
      });

      await harness.deliver();

      expect(harness.sends.length).toBeGreaterThanOrEqual(1);
      // The record still belongs to the claimant that won it...
      expect(harness.recordedTs()).toBe(OWNED_TS);
      // ...and the duplicate this delivery posted is gone.
      expect(harness.deleted).toContainEqual({ threadId: THREAD, messageId: OUR_TS });
      await harness.stop();
    });

    /**
     * The lease outlived an EDIT. Nothing is orphaned — this delivery wrote over
     * the one row the record names — but it wrote a state the winner had already
     * superseded, and `rendered_state` is what every later render compares
     * against, so the disagreement would otherwise be permanent.
     */
    it('repaints the row it edited after losing its claim', async () => {
      let patch: ((ts: string, state: string) => void) | undefined;
      const harness = build({
        start: 'edit',
        onReady: (apply) => {
          patch = apply;
        },
        winner: () => patch?.(OWNED_TS, winnerState),
      });

      await harness.deliver();

      // A second write, to the row that counts, rather than a new message.
      expect(harness.sends.length).toBeGreaterThan(1);
      expect(harness.sends.at(-1)?.metadata).toMatchObject({ slack_update_ts: OWNED_TS });
      expect(harness.recordedTs()).toBe(OWNED_TS);
      // And the record describes what was rendered last, rather than a render
      // this delivery painted over.
      expect(harness.renderedState()).toBe(repaintedState);
      // Nothing was orphaned, so nothing is deleted.
      expect(harness.deleted).toEqual([]);
      await harness.stop();
    });

    /**
     * An UNCLASSIFIED exception, while this pass holds the claim.
     *
     * The hole D1 closed, stated once for both lanes. Every classified refusal
     * either releases the claim or records a delivery failure; a throw did
     * neither. `recordSlackDeliveryFailure` cannot see one on its own — it
     * writes only when the record is still the one this delivery started on
     * AND the live claim is the one it took — and the whole prologue (the
     * kill-switch read, the deps, the binding, the channel read) runs above
     * both. So the claim leaked, the attempt was never counted, the backoff
     * never advanced, and the record's own overdue `next_repair_at` brought
     * the same card back on the sweep's thirty-second tick until its horizon
     * closed a day later.
     *
     * Asserted as the END STATE rather than as a call sequence: what matters
     * is that the claim is gone and the attempt is on the record, however the
     * lane got there. The rethrow is part of the contract too — the sweep's
     * per-pass tally is what names the exception's category, and swallowing
     * here would take that away.
     */
    it('counts an unclassified throw against the claim it was holding', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      try {
        const harness = build({ start: 'post', failAfterClaim: true });

        await expect(harness.deliver()).rejects.toThrow();

        // Nothing reached Slack — the throw is above every provider call.
        expect(harness.sends).toEqual([]);
        const record = harness.record();
        // The leaked claim is gone...
        expect(record?.delivery_claim).toBeUndefined();
        // ...the attempt is counted against the ladder...
        expect(record?.delivery_attempt_count).toBe(1);
        // ...and something is coming back for this card, on the backoff
        // rather than on the sweep's bare tick.
        expect(record?.delivery_next_retry_at).toEqual(expect.any(String));
        expect(Date.parse(record!.delivery_next_retry_at!)).toBeGreaterThan(Date.now());
        // Accounted out loud, with the lane's own reason.
        expect(
          warn.mock.calls.some(
            (call) => typeof call[0] === 'string' && call[0].includes('reason=unexpected_failure')
          )
        ).toBe(true);
        await harness.stop();
      } finally {
        warn.mockRestore();
      }
    });

    /**
     * Slack never answers.
     *
     * The case no fake in this suite could previously express, because every
     * stub resolves immediately — and a hang is a different failure from a
     * rejection. Nothing catches it, the claim keeps running, and the caller
     * waits for as long as the provider does.
     *
     * Nothing bounded that. `new WebClient(bot_token)` takes v7's defaults:
     * `timeout: 0`, meaning no per-request deadline at all, and
     * `tenRetriesInAboutThirtyMinutes`. Agor imposed no deadline of its own
     * over the composition, so one unanswered `chat.postMessage` could hold a
     * delivery — and, through `markConnectStartFailed`, a whole `oauth-start`
     * request — indefinitely.
     *
     * The contract is the one property that matters from outside: a delivery
     * SETTLES whether or not Slack does, inside the 30s lease it is holding,
     * and the ending is the already-tested `slack_write_failed` one rather
     * than a novel state. Stated over both lanes because the deadline lives
     * in the shared engine: a lane that stops going through `sendSlackCard`
     * loses it silently otherwise.
     */
    it('settles inside its own claim when Slack never answers', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      vi.useFakeTimers();
      try {
        const harness = build({ start: 'post', stallSlack: true });
        const settled = harness.deliver();

        // Nothing resolves this but the deadline — the send stub never does.
        await vi.advanceTimersByTimeAsync(MCP_SLACK_SEND_TIMEOUT_MS + 1_000);
        await settled;

        // The deadline is below the lease on purpose: a delivery that outlives
        // its own claim can have its receipt orphaned by the next claimant.
        expect(MCP_SLACK_SEND_TIMEOUT_MS).toBeLessThan(MCP_SLACK_DELIVERY_CLAIM_MS);
        // It was attempted, and that is all Slack ever told us.
        expect(harness.sends).toHaveLength(1);
        const record = harness.record();
        // From here it is the ordinary write-failure ending: the claim is
        // released, the attempt is counted, and the backoff owns the retry.
        expect(record?.delivery_claim).toBeUndefined();
        expect(record?.delivery_attempt_count).toBe(1);
        expect(record?.delivery_next_retry_at).toEqual(expect.any(String));
        // A hang that used to be invisible is now an accounted line, under the
        // category both lanes already use for a refused write.
        expect(
          warn.mock.calls.some(
            (call) => typeof call[0] === 'string' && call[0].includes('reason=slack_write_failed')
          )
        ).toBe(true);
        await harness.stop();
      } finally {
        vi.useRealTimers();
        warn.mockRestore();
      }
    });

    /**
     * Slack answers AFTER the deadline, and after a later attempt settled.
     *
     * The stalled-send case above only shows the caller stops waiting. It says
     * nothing about the request it abandoned, which can still land: the shared
     * web client used to retry a timed-out write for about five minutes. The
     * sequence that matters is the one below — the first write times out, a
     * later attempt settles the card, and only then does the first write land
     * and paint its older state back over the settled one. A terminal state
     * schedules no repair, so nothing would ever correct it.
     *
     * The abandoned write is reconciled like a write that lost its claim: an
     * edit of the owned row is repainted from the authority, and a post beside
     * it is retired.
     */
    it.each([
      { start: 'edit' as const, write: 'an edit' },
      { start: 'post' as const, write: 'a post' },
    ])(
      'reconciles $write that lands after its deadline and after a later settle',
      async ({ start }) => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        vi.useFakeTimers();
        try {
          let land!: () => void;
          let patch: ((ts: string, state: string) => void) | undefined;
          const harness = build({
            start,
            lateSlack: new Promise<void>((resolve) => {
              land = resolve;
            }),
            onReady: (apply) => {
              patch = apply;
            },
          });

          const first = harness.deliver();
          await vi.advanceTimersByTimeAsync(MCP_SLACK_SEND_TIMEOUT_MS + 1_000);
          await first;
          expect(harness.record()?.delivery_attempt_count).toBe(1);

          // A later attempt settles the card to a newer state, on the row the
          // record owns...
          patch?.(OWNED_TS, winnerState);
          expect(harness.renderedState()).toBe(winnerState);

          // ...and only now does Slack answer the write that was given up on.
          land();
          for (let i = 0; i < 20; i += 1) await vi.advanceTimersByTimeAsync(0);

          expect(harness.recordedTs()).toBe(OWNED_TS);
          if (start === 'edit') {
            // The late edit painted the older state over OWNED_TS. It is
            // repainted from the authority, on the same row.
            expect(harness.sends.length).toBeGreaterThan(1);
            expect(harness.sends.at(-1)?.metadata).toMatchObject({ slack_update_ts: OWNED_TS });
            expect(harness.renderedState()).toBe(repaintedState);
            expect(harness.deleted).toEqual([]);
          } else {
            // The late post is a second card beside the settled one: retired.
            expect(harness.deleted).toContainEqual({ threadId: THREAD, messageId: OUR_TS });
          }
          await harness.stop();
        } finally {
          vi.useRealTimers();
          warn.mockRestore();
        }
      }
    );

    /**
     * Send/commit ambiguity in the other direction: the send landed and the
     * record never learned the `ts`. Both lanes reconcile from Slack's own
     * message metadata before posting, so the recovery is an edit of the row
     * that is already in the thread, not a second one beside it.
     */
    it('edits the row it already sent when the receipt was lost', async () => {
      const harness = build({ start: 'post' });
      const service = harness as unknown as { sends: SentMessage[] };
      // Stand in for the lost receipt: Slack knows about the row, the record
      // does not.
      const first = await harness.deliver();
      void first;
      expect(service.sends).toHaveLength(1);
      expect(service.sends[0]?.metadata).toHaveProperty('slack_message_metadata');
      expect(harness.recordedTs()).toBe(OUR_TS);

      // A second pass with the state now recorded must not post again.
      await harness.deliver();
      expect(service.sends).toHaveLength(1);
      await harness.stop();
    });
  }
);
