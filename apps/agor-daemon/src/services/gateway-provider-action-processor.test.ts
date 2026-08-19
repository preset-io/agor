import type { GatewayProviderActionRepository } from '@agor/core/db';
import type { GatewayProviderAction } from '@agor/core/types';
import { describe, expect, it, vi } from 'vitest';
import { GatewayProviderActionProcessor } from './gateway-provider-action-processor.js';

const channelId = '01927f9d-0000-7000-8000-000000000001';
const messageId = '01927f9d-0000-7000-8000-000000000005';

function action(id: string, overrides: Partial<GatewayProviderAction> = {}): GatewayProviderAction {
  return {
    id: id as never,
    gateway_channel_id: channelId as never,
    channel_type: 'discord',
    provider_installation_id: 'discord:application:223456789012345678',
    provider_config_generation: 2,
    kind: 'deliver_message',
    idempotency_key: `deliver_message:${messageId}:create`,
    thread_session_map_id: '01927f9d-0000-7000-8000-000000000002' as never,
    session_id: '01927f9d-0000-7000-8000-000000000003' as never,
    task_id: '01927f9d-0000-7000-8000-000000000004' as never,
    message_id: messageId as never,
    gateway_inbound_event_id: null,
    params: { operation: 'create' },
    status: 'processing',
    attempts: 1,
    not_before: '2026-08-18T00:00:00.000Z',
    drop_after: null,
    claim_token: 'action-owner',
    claim_generation: 1,
    claim_expires_at: '2099-01-01T00:00:00.000Z',
    claim_listener_token: 'listener-a',
    claim_listener_generation: 1,
    claim_instance_id: 'daemon-a',
    claim_boot_id: 'boot-a',
    last_error_code: null,
    execution_metadata: null,
    result_metadata: null,
    created_at: '2026-08-18T00:00:00.000Z',
    updated_at: '2026-08-18T00:00:00.000Z',
    completed_at: null,
    dead_lettered_at: null,
    canceled_at: null,
    ...overrides,
  };
}

function repository(claims: GatewayProviderAction[][]) {
  return {
    claimForListener: vi.fn(async () => claims.shift() ?? []),
    complete: vi.fn(async () => true),
    retry: vi.fn(async () => true),
    deadLetter: vi.fn(async () => true),
    findById: vi.fn(async () => null),
    getBacklogMetrics: vi.fn(async () => ({
      activeCount: 0,
      oldestDueAt: null,
      oldestDueAgeMs: 0,
      deadLetterCount: 0,
      partialDeliveryCount: 0,
      nonceRecoveryIncompleteCount: 0,
      historyIncompleteCount: 0,
      formatterMismatchCount: 0,
      observedAt: '2026-08-18T00:00:00.000Z',
    })),
  } as unknown as GatewayProviderActionRepository & Record<string, ReturnType<typeof vi.fn>>;
}

const owner = {
  tenantId: 'tenant-a',
  channelId: channelId as never,
  listenerClaimToken: 'listener-a',
  listenerGeneration: 1,
};

describe('GatewayProviderActionProcessor', () => {
  it('executes serially and never claims the next action while REST is in flight', async () => {
    const first = action('01927f9d-0000-7000-8000-000000000011');
    const second = action('01927f9d-0000-7000-8000-000000000012');
    const repo = repository([[first], [second], []]);
    let finishFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => {
      finishFirst = resolve;
    });
    let concurrent = 0;
    let maximumConcurrent = 0;
    const execute = vi.fn(async (_owner, current: GatewayProviderAction) => {
      concurrent += 1;
      maximumConcurrent = Math.max(maximumConcurrent, concurrent);
      if (current.id === first.id) await firstGate;
      concurrent -= 1;
      return {
        outcome: 'complete' as const,
        result: {
          kind: 'deliver_message' as const,
          provider_message_id: '823456789012345678',
        },
      };
    });
    const processor = new GatewayProviderActionProcessor(
      repo,
      { instanceId: 'daemon-a', bootId: 'boot-a' },
      (_tenantId, work) => work(),
      execute,
      { pollIntervalMs: 60_000 }
    );

    processor.start(owner);
    await vi.waitFor(() => expect(execute).toHaveBeenCalledOnce());
    expect(repo.claimForListener).toHaveBeenCalledOnce();
    finishFirst();
    await vi.waitFor(() => expect(execute).toHaveBeenCalledTimes(2));
    expect(maximumConcurrent).toBe(1);
    expect(repo.complete).toHaveBeenCalledTimes(2);
    await processor.stop(owner.tenantId, owner.channelId);
  });

  it('honors retry classification, dead-letters permanent failures, and bounds attempts', async () => {
    const retry = action('01927f9d-0000-7000-8000-000000000021');
    const permanent = action('01927f9d-0000-7000-8000-000000000022');
    const exhausted = action('01927f9d-0000-7000-8000-000000000023', { attempts: 8 });
    const repo = repository([[retry], [permanent], [exhausted], []]);
    const execute = vi
      .fn()
      .mockResolvedValueOnce({
        outcome: 'retry',
        errorCode: 'discord_rate_limited',
        retryAfterMs: 2_500,
      })
      .mockResolvedValueOnce({
        outcome: 'dead_letter',
        errorCode: 'discord_permission_rejected',
      })
      .mockResolvedValueOnce({
        outcome: 'retry',
        errorCode: 'discord_transport_error',
        retryAfterMs: 5_000,
      });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const processor = new GatewayProviderActionProcessor(
      repo,
      { instanceId: 'daemon-a', bootId: 'boot-a' },
      (_tenantId, work) => work(),
      execute,
      { pollIntervalMs: 60_000 }
    );

    processor.start(owner);
    await vi.waitFor(() => expect(repo.deadLetter).toHaveBeenCalledTimes(2));
    expect(repo.retry).toHaveBeenCalledWith(
      expect.objectContaining({ errorCode: 'discord_rate_limited', retryAfterMs: 2_500 })
    );
    expect(repo.deadLetter).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ errorCode: 'discord_permission_rejected' })
    );
    expect(repo.deadLetter).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ errorCode: 'attempts_exhausted' })
    );
    expect(warn.mock.calls.flat().join(' ')).toContain(`action_id=${JSON.stringify(permanent.id)}`);
    expect(warn.mock.calls.flat().join(' ')).toContain('code="discord_permission_rejected"');
    expect(warn.mock.calls.flat().join(' ')).not.toContain('provider content');
    await processor.stop(owner.tenantId, owner.channelId);
    warn.mockRestore();
  });

  it('runs non-critical owner refresh after work without changing a completed action', async () => {
    const current = action('01927f9d-0000-7000-8000-000000000024');
    const repo = repository([[current], []]);
    const onPassComplete = vi.fn(async () => {
      throw new Error('presence refresh failed');
    });
    const processor = new GatewayProviderActionProcessor(
      repo,
      { instanceId: 'daemon-a', bootId: 'boot-a' },
      (_tenantId, work) => work(),
      async () => ({
        outcome: 'complete',
        result: { kind: 'deliver_message', provider_message_id: '823456789012345678' },
      }),
      { pollIntervalMs: 60_000, onPassComplete }
    );

    processor.start(owner);
    await vi.waitFor(() => expect(onPassComplete).toHaveBeenCalledOnce());
    expect(repo.complete).toHaveBeenCalledOnce();
    expect(repo.retry).not.toHaveBeenCalled();
    expect(repo.deadLetter).not.toHaveBeenCalled();
    await processor.stop(owner.tenantId, owner.channelId);
  });

  it('leaves an uncertain successful call claim for replay with the same canonical nonce seed', async () => {
    const first = action('01927f9d-0000-7000-8000-000000000031');
    const firstRepo = repository([[first], []]);
    firstRepo.complete = vi.fn(async () => false);
    const nonceSeeds: Array<string | null> = [];
    const execute = vi.fn(async (_owner, current: GatewayProviderAction) => {
      nonceSeeds.push(current.message_id);
      return {
        outcome: 'complete' as const,
        result: {
          kind: 'deliver_message' as const,
          provider_message_id: '823456789012345678',
        },
      };
    });
    const firstProcessor = new GatewayProviderActionProcessor(
      firstRepo,
      { instanceId: 'daemon-a', bootId: 'boot-a' },
      (_tenantId, work) => work(),
      execute,
      { pollIntervalMs: 60_000 }
    );
    firstProcessor.start(owner);
    await vi.waitFor(() => expect(firstRepo.complete).toHaveBeenCalledOnce());
    await firstProcessor.stop(owner.tenantId, owner.channelId);

    const replay = action(first.id, {
      claim_generation: 2,
      claim_listener_token: 'listener-b',
      claim_listener_generation: 2,
    });
    const takeoverRepo = repository([[replay], []]);
    const takeover = { ...owner, listenerClaimToken: 'listener-b', listenerGeneration: 2 };
    const secondProcessor = new GatewayProviderActionProcessor(
      takeoverRepo,
      { instanceId: 'daemon-b', bootId: 'boot-b' },
      (_tenantId, work) => work(),
      execute,
      { pollIntervalMs: 60_000 }
    );
    secondProcessor.start(takeover);
    await vi.waitFor(() => expect(takeoverRepo.complete).toHaveBeenCalledOnce());
    expect(nonceSeeds).toEqual([messageId, messageId]);
    await secondProcessor.stop(takeover.tenantId, takeover.channelId);
  });

  it('treats DB-time history expiry during staging completion as an audited no-op', async () => {
    const expired = action('01927f9d-0000-7000-8000-000000000039', {
      kind: 'discord_thread_history',
      task_id: null,
      message_id: null,
      idempotency_key: 'discord_thread_history:request',
      params: {
        request_id: '01927f9d-0000-7000-8000-000000000038',
        initial_message_id: '623456789012345678',
        through_message_id: '823456789012345678',
        limit: 50,
      },
      drop_after: '2026-08-18T00:01:00.000Z',
    });
    const repo = repository([[expired], []]);
    repo.complete = vi.fn(async () => false);
    repo.findById = vi.fn(async () => ({
      ...expired,
      status: 'canceled',
      last_error_code: 'discord_history_expired',
    }));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const processor = new GatewayProviderActionProcessor(
      repo,
      { instanceId: 'daemon-a', bootId: 'boot-a' },
      (_tenantId, work) => work(),
      async () => ({
        outcome: 'complete',
        result: {
          kind: 'discord_thread_history',
          upload_ref: 'upl_00000000-0000-4000-8000-000000000099',
          sha256: 'a'.repeat(64),
          byte_length: 10,
          message_count: 0,
          has_more: false,
        },
      }),
      { pollIntervalMs: 60_000 }
    );

    processor.start(owner);
    await vi.waitFor(() => expect(repo.complete).toHaveBeenCalledOnce());
    expect(warn).not.toHaveBeenCalledWith(expect.stringContaining('uncertain_completion'));
    await processor.stop(owner.tenantId, owner.channelId);
    warn.mockRestore();
  });

  it('stops claiming on owner loss and reports a bounded shutdown timeout', async () => {
    const lost = action('01927f9d-0000-7000-8000-000000000041');
    const ownerLost = vi.fn();
    const lostRepo = repository([[lost], [action('01927f9d-0000-7000-8000-000000000042')]]);
    const lostProcessor = new GatewayProviderActionProcessor(
      lostRepo,
      { instanceId: 'daemon-a', bootId: 'boot-a' },
      (_tenantId, work) => work(),
      async () => ({ outcome: 'owner_lost' }),
      { pollIntervalMs: 60_000, onOwnerLost: ownerLost }
    );
    lostProcessor.start(owner);
    await vi.waitFor(() => expect(ownerLost).toHaveBeenCalledOnce());
    expect(lostRepo.claimForListener).toHaveBeenCalledOnce();
    expect(lostRepo.complete).not.toHaveBeenCalled();
    await lostProcessor.stop(owner.tenantId, owner.channelId);

    let finish!: () => void;
    const gate = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const slowRepo = repository([[lost]]);
    const slowProcessor = new GatewayProviderActionProcessor(
      slowRepo,
      { instanceId: 'daemon-a', bootId: 'boot-a' },
      (_tenantId, work) => work(),
      async () => {
        await gate;
        return {
          outcome: 'complete',
          result: {
            kind: 'deliver_message',
            provider_message_id: '823456789012345678',
          },
        };
      },
      { pollIntervalMs: 60_000, shutdownTimeoutMs: 10 }
    );
    slowProcessor.start(owner);
    await vi.waitFor(() => expect(slowRepo.claimForListener).toHaveBeenCalledOnce());
    await expect(slowProcessor.stop(owner.tenantId, owner.channelId)).resolves.toBe(false);
    finish();
    await vi.waitFor(() => expect(slowRepo.complete).toHaveBeenCalledOnce());
  });

  it('emits content-free durable backlog diagnostics', async () => {
    const repo = repository([[]]);
    repo.getBacklogMetrics = vi.fn(async () => ({
      activeCount: 100,
      oldestDueAt: '2026-08-17T23:58:00.000Z',
      oldestDueAgeMs: 120_000,
      deadLetterCount: 2,
      partialDeliveryCount: 1,
      nonceRecoveryIncompleteCount: 1,
      historyIncompleteCount: 1,
      formatterMismatchCount: 0,
      observedAt: '2026-08-18T00:00:00.000Z',
    }));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const processor = new GatewayProviderActionProcessor(
      repo,
      { instanceId: 'daemon-a', bootId: 'boot-a' },
      (_tenantId, work) => work(),
      vi.fn(),
      { pollIntervalMs: 60_000 }
    );

    processor.start(owner);
    await vi.waitFor(() => expect(warn).toHaveBeenCalledOnce());
    expect(warn.mock.calls[0]?.[0]).toBe(
      `[gateway.provider_action] event=backlog_degraded channel_id=${JSON.stringify(channelId)} active_count=100 oldest_due_age_ms=120000 dead_letter_count=2 partial_delivery_count=1 nonce_recovery_incomplete_count=1 history_incomplete_count=1 formatter_mismatch_count=0`
    );
    expect(warn.mock.calls.flat().join(' ')).not.toContain('provider content');
    await processor.stop(owner.tenantId, owner.channelId);
    warn.mockRestore();
  });
});
