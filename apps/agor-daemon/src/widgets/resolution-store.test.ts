import type { Message, MessageID, UserID } from '@agor/core/types';
import { describe, expect, it } from 'vitest';
import { WidgetResolutionStore } from './resolution-store';

function createAtomicRepository() {
  let message: Message = {
    message_id: 'widget-1' as MessageID,
    session_id: 'session-1' as never,
    type: 'widget_request',
    role: 'system' as never,
    index: 0,
    timestamp: '2026-08-06T00:00:00.000Z',
    content_preview: 'Resolve',
    content: 'Resolve',
    metadata: {
      widget: {
        widget_id: 'widget-1' as MessageID,
        widget_type: 'test',
        schema_version: 1,
        params: {},
        status: 'pending',
        requested_at: '2026-08-06T00:00:00.000Z',
      },
    },
  };
  let tail = Promise.resolve();
  const repository = {
    mutateMetadataLocked(
      _id: MessageID,
      mutation: (metadata: Message['metadata'], current: Message) => Message['metadata'] | null
    ) {
      const result = tail.then(() => {
        const metadata = mutation(message.metadata, message);
        if (metadata === null) return { changed: false, message };
        message = { ...message, metadata };
        return { changed: true, message };
      });
      tail = result.then(() => undefined);
      return result;
    },
  };
  return {
    repository,
    get message() {
      return message;
    },
  };
}

describe('WidgetResolutionStore', () => {
  it('elects one resolver across daemon-local store instances and conflicting actions', async () => {
    const state = createAtomicRepository();
    const stores = Array.from({ length: 5 }, () => new WidgetResolutionStore(state.repository));
    const claims = await Promise.all(
      stores.map((store, index) =>
        store.claim('widget-1' as MessageID, {
          token: `claim-${index}`,
          action: index % 2 === 0 ? 'submit' : 'dismiss',
          claimedAt: '2026-08-06T00:00:01.000Z',
          claimedBy: `user-${index}` as UserID,
        })
      )
    );

    expect(claims.filter((claim) => claim.outcome === 'claimed')).toHaveLength(1);
    expect(state.message.metadata?.widget?.status).toBe('resolving');
  });

  it('only lets the opaque claim token complete the resolution', async () => {
    const state = createAtomicRepository();
    const store = new WidgetResolutionStore(state.repository);
    await store.claim('widget-1' as MessageID, {
      token: 'winner',
      action: 'submit',
      claimedAt: '2026-08-06T00:00:01.000Z',
      claimedBy: 'user-1' as UserID,
    });

    expect(
      await store.complete('widget-1' as MessageID, 'loser', {
        status: 'submitted',
        resolvedAt: '2026-08-06T00:00:02.000Z',
        submittedBy: 'user-2' as UserID,
      })
    ).toMatchObject({ outcome: 'claim_lost' });
    expect(
      await store.complete('widget-1' as MessageID, 'winner', {
        status: 'submitted',
        resolvedAt: '2026-08-06T00:00:02.000Z',
        submittedBy: 'user-1' as UserID,
        resultMeta: { names: ['TOKEN'] },
      })
    ).toMatchObject({ outcome: 'updated' });
    expect(state.message.metadata?.widget).toMatchObject({
      status: 'submitted',
      submitted_by: 'user-1',
      result_meta: { names: ['TOKEN'] },
    });
    expect(state.message.metadata?.widget?.resolution_claim).toBeUndefined();
  });

  it('durably diagnoses a reported failure and permits a deliberate retry', async () => {
    const state = createAtomicRepository();
    const store = new WidgetResolutionStore(state.repository);
    await store.claim('widget-1' as MessageID, {
      token: 'winner',
      action: 'submit',
      claimedAt: '2026-08-06T00:00:01.000Z',
      claimedBy: 'user-1' as UserID,
    });
    await store.fail('widget-1' as MessageID, 'winner', {
      failedAt: '2026-08-06T00:00:02.000Z',
      errorCode: 'external_failure',
    });

    expect(state.message.metadata?.widget).toMatchObject({
      status: 'pending',
      resolution_failure: { error_code: 'external_failure' },
    });
    expect(
      await new WidgetResolutionStore(state.repository).claim('widget-1' as MessageID, {
        token: 'retry',
        action: 'submit',
        claimedAt: '2026-08-06T00:00:03.000Z',
        claimedBy: 'user-1' as UserID,
      })
    ).toMatchObject({ outcome: 'claimed' });
  });
});
