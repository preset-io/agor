import { MessageRole } from '@agor/core/types';
import { eq } from 'drizzle-orm';
import { describe, expect } from 'vitest';
import type { Database } from '../client';
import { update } from '../database-wrapper';
import { teamsMessageDeliveries } from '../schema';
import { ownedDbTest } from '../test-helpers';
import {
  assistantMessage,
  seedTeamsGateway,
  teamsDeliveryWriters,
} from './teams-gateway-ha.test-support';
import {
  TeamsChunkPlanChangedError,
  TeamsMessageDeliveryClaimLostError,
} from './teams-message-deliveries';

async function seed(db: Database) {
  return { ...(await seedTeamsGateway(db)), ...teamsDeliveryWriters(db) };
}

async function claimedDelivery(db: Database) {
  const fixture = await seed(db);
  const message = await fixture.messages.create(assistantMessage(fixture.session.session_id));
  const delivery = await fixture.deliveries.findByMessageId(message.message_id);
  if (!delivery) throw new Error('missing Teams delivery');
  const now = new Date(delivery.next_attempt_at);
  const claim = await fixture.deliveries.claim(delivery.delivery_id, 'worker-a', 30_000, now);
  if (!claim) throw new Error('missing Teams claim');
  const ref = {
    deliveryId: claim.delivery_id,
    claimToken: claim.claim_token,
    claimGeneration: claim.claim_generation,
    now,
  };
  return { ...fixture, claim, ref, now };
}

describe('TeamsMessageDeliveryRepository', () => {
  ownedDbTest('does not enqueue "Thinking..." placeholders or user messages', async ({ db }) => {
    const { session, messages, deliveries } = await seed(db);
    const thinking = await messages.create(
      assistantMessage(session.session_id, 0, {
        content: 'Thinking...',
        content_preview: 'Thinking...',
      })
    );
    const user = await messages.create(
      assistantMessage(session.session_id, 1, { role: MessageRole.USER, type: 'user' })
    );
    expect(await deliveries.findByMessageId(thinking.message_id)).toBeNull();
    expect(await deliveries.findByMessageId(user.message_id)).toBeNull();
  });

  ownedDbTest('resumes after a crash at the first chunk without a receipt', async ({ db }) => {
    const { deliveries, ref, now } = await claimedDelivery(db);
    await deliveries.recordChunkPlan({ ...ref, digest: '40000:plan' });
    for (const chunkIndex of [0, 1]) {
      await deliveries.markEffectStarted({ ...ref, chunkIndex });
      await deliveries.checkpointChunk({
        ...ref,
        receipt: { chunk_index: chunkIndex, provider_message_id: `activity-${chunkIndex}` },
      });
    }
    // The worker dies here; its lease lapses with no chunk marker outstanding.
    const later = new Date(now.getTime() + 30_001);
    const reclaimed = await deliveries.claim(ref.deliveryId, 'worker-b', 30_000, later);
    expect(reclaimed?.delivery).toMatchObject({
      status: 'processing',
      ambiguous_chunk_index: null,
      chunk_plan_digest: '40000:plan',
      provider_message_id: 'activity-0',
    });
    expect(reclaimed?.delivery.chunk_receipts.map((receipt) => receipt.chunk_index)).toEqual([
      0, 1,
    ]);
  });

  ownedDbTest(
    'turns a lapsed lease after the chunk-2 marker into ambiguous with that chunk',
    async ({ db }) => {
      const { deliveries, ref, now } = await claimedDelivery(db);
      for (const chunkIndex of [0, 1]) {
        await deliveries.markEffectStarted({ ...ref, chunkIndex });
        await deliveries.checkpointChunk({
          ...ref,
          receipt: { chunk_index: chunkIndex, provider_message_id: `activity-${chunkIndex}` },
        });
      }
      await deliveries.markEffectStarted({ ...ref, chunkIndex: 2 });
      const later = new Date(now.getTime() + 30_001);
      expect(await deliveries.claim(ref.deliveryId, 'worker-b', 30_000, later)).toBeNull();
      expect(await deliveries.findById(ref.deliveryId)).toMatchObject({
        status: 'ambiguous',
        ambiguous_chunk_index: 2,
        last_error_code: 'provider_effect_unknown',
      });
    }
  );

  ownedDbTest('keeps a chunk marker across a retry and refuses a new plan', async ({ db }) => {
    const { deliveries, ref, now } = await claimedDelivery(db);
    await deliveries.recordChunkPlan({ ...ref, digest: '40000:first' });
    await deliveries.recordChunkPlan({ ...ref, digest: '20000:replanned' });
    await deliveries.markEffectStarted({ ...ref, chunkIndex: 0 });
    await expect(deliveries.recordChunkPlan({ ...ref, digest: '10000:other' })).rejects.toThrow(
      TeamsChunkPlanChangedError
    );
    await deliveries.fail({ ...ref, status: 'pending', errorCode: 'transient' });
    const retried = await deliveries.claim(ref.deliveryId, 'worker-b', 30_000, now);
    expect(retried?.delivery).toMatchObject({
      ambiguous_chunk_index: 0,
      chunk_plan_digest: '20000:replanned',
    });
  });

  ownedDbTest('renews only the current claim', async ({ db }) => {
    const { deliveries, ref, now } = await claimedDelivery(db);
    const renewed = await deliveries.renewClaim({
      ...ref,
      leaseDurationMs: 60_000,
      now: new Date(now.getTime() + 20_000),
    });
    expect(new Date(renewed!.lease_expires_at).getTime()).toBe(now.getTime() + 80_000);
    expect(
      await deliveries.renewClaim({ ...ref, claimToken: 'stale', leaseDurationMs: 60_000 })
    ).toBeNull();
    await expect(
      deliveries.complete({ ...ref, claimToken: 'stale', now: new Date(now.getTime() + 1) })
    ).rejects.toThrow(TeamsMessageDeliveryClaimLostError);
  });

  ownedDbTest('purges terminal rows past retention and keeps recent failures', async ({ db }) => {
    const { session, messages, deliveries } = await seed(db);
    const ids: string[] = [];
    for (let index = 0; index < 3; index += 1) {
      const message = await messages.create(assistantMessage(session.session_id, index));
      ids.push((await deliveries.findByMessageId(message.message_id))!.delivery_id);
    }
    const now = new Date();
    const days = (count: number) => new Date(now.getTime() - count * 24 * 60 * 60 * 1000);
    const age = async (id: string, status: string, updatedAt: Date) =>
      update(db, teamsMessageDeliveries)
        .set({ status, updated_at: updatedAt })
        .where(eq(teamsMessageDeliveries.delivery_id, id))
        .run();
    await age(ids[0], 'completed', days(8));
    await age(ids[1], 'ambiguous', days(8));
    await age(ids[2], 'ambiguous', days(31));

    const due = await deliveries.findDueRefs(db, { now });
    expect(due.map((ref) => ref.delivery_id).sort()).toEqual([ids[0], ids[2]].sort());
    expect(await deliveries.purgeExpired(now)).toBe(2);
    expect(await deliveries.findById(ids[1] as never)).toMatchObject({ status: 'ambiguous' });
    expect(await deliveries.findById(ids[0] as never)).toBeNull();
  });
});
