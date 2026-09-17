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

describe('WidgetResolutionStore.supersede', () => {
  it('retires a pending widget AND publishes the change', async () => {
    // The publish is the whole reason this lives on the store. Writing
    // `metadata.widget` through the repository persisted the same row but
    // skipped `publishChanged`, so every open browser kept rendering a live
    // Connect button until a reload — and then 403'd on the click.
    const state = createAtomicRepository();
    const published: Message[] = [];
    const store = new WidgetResolutionStore(state.repository, (message) => published.push(message));

    const result = await store.supersede('widget-1' as MessageID, '2026-08-06T00:00:02.000Z');

    expect(result.outcome).toBe('superseded');
    expect(state.message.metadata?.widget?.status).toBe('dismissed');
    expect(published).toHaveLength(1);
    expect(published[0].metadata?.widget?.status).toBe('dismissed');
  });

  it('never steals a widget another resolver has claimed', async () => {
    const state = createAtomicRepository();
    const store = new WidgetResolutionStore(state.repository);
    await store.claim('widget-1' as MessageID, {
      token: 'claim-1',
      action: 'oauth_callback',
      claimedAt: '2026-08-06T00:00:01.000Z',
      claimedBy: 'user-1' as UserID,
    });

    const result = await store.supersede('widget-1' as MessageID, '2026-08-06T00:00:02.000Z');

    expect(result.outcome).toBe('not_pending');
    expect(state.message.metadata?.widget?.status).toBe('resolving');
  });

  it('is idempotent on an already-terminal widget', async () => {
    const state = createAtomicRepository();
    const store = new WidgetResolutionStore(state.repository);
    await store.supersede('widget-1' as MessageID, '2026-08-06T00:00:02.000Z');

    const again = await store.supersede('widget-1' as MessageID, '2026-08-06T00:00:03.000Z');
    expect(again.outcome).toBe('not_pending');
    expect(state.message.metadata?.widget?.resolved_at).toBe('2026-08-06T00:00:02.000Z');
  });
});

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

/**
 * Taking over an abandoned claim — the store half of B1.
 *
 * The default is unchanged and stays unchanged: an abandoned `resolving`
 * claim is a diagnosis, because the store cannot know whether the handler
 * behind it wrote a secret before dying. A caller may pass a reclaim policy
 * naming one action and an age, and only the lane whose handler is replay-safe
 * does (`recovery: 'reclaimable'` on its registry entry).
 */
describe('WidgetResolutionStore.claim — abandoned claims', () => {
  const claimInput = (token: string, at: string) => ({
    token,
    action: 'oauth_callback' as const,
    claimedAt: at,
    claimedBy: 'user-1' as UserID,
  });

  async function withHeldClaim(claimedAt: string) {
    const state = createAtomicRepository();
    const published: Message[] = [];
    const store = new WidgetResolutionStore(state.repository, (message) => published.push(message));
    await store.claim('widget-1' as MessageID, claimInput('first', claimedAt));
    return { state, store, published };
  }

  it('refuses a second claim with no policy, however old the first is', async () => {
    const { state, store } = await withHeldClaim('2026-08-06T00:00:00.000Z');
    const result = await store.claim(
      'widget-1' as MessageID,
      claimInput('second', '2026-08-06T01:00:00.000Z')
    );
    expect(result.outcome).toBe('not_pending');
    expect(state.message.metadata?.widget?.resolution_claim?.token).toBe('first');
  });

  it('takes over a claim older than the policy and publishes the change', async () => {
    const { state, store, published } = await withHeldClaim('2026-08-06T00:00:00.000Z');
    const result = await store.claim(
      'widget-1' as MessageID,
      claimInput('second', '2026-08-06T00:05:00.000Z'),
      { action: 'oauth_callback', afterMs: 60_000 }
    );
    expect(result).toMatchObject({ outcome: 'claimed', reclaimed: true });
    expect(state.message.metadata?.widget?.resolution_claim?.token).toBe('second');
    expect(state.message.metadata?.widget?.status).toBe('resolving');
    expect(published).toHaveLength(2);
  });

  it('leaves a claim younger than the policy alone', async () => {
    const { state, store } = await withHeldClaim('2026-08-06T00:00:00.000Z');
    const result = await store.claim(
      'widget-1' as MessageID,
      claimInput('second', '2026-08-06T00:00:10.000Z'),
      { action: 'oauth_callback', afterMs: 60_000 }
    );
    expect(result.outcome).toBe('not_pending');
    expect(state.message.metadata?.widget?.resolution_claim?.token).toBe('first');
  });

  it('will not reclaim a claim taken by a different action', async () => {
    const { state, store } = await withHeldClaim('2026-08-06T00:00:00.000Z');
    const result = await store.claim(
      'widget-1' as MessageID,
      { ...claimInput('second', '2026-08-06T00:05:00.000Z'), action: 'submit' },
      { action: 'submit', afterMs: 60_000 }
    );
    expect(result.outcome).toBe('not_pending');
    expect(state.message.metadata?.widget?.resolution_claim?.token).toBe('first');
  });

  it('will not reclaim a terminal widget', async () => {
    const { store } = await withHeldClaim('2026-08-06T00:00:00.000Z');
    await store.complete('widget-1' as MessageID, 'first', {
      status: 'submitted',
      resolvedAt: '2026-08-06T00:00:01.000Z',
      submittedBy: 'user-1' as UserID,
    });
    const result = await store.claim(
      'widget-1' as MessageID,
      claimInput('second', '2026-08-06T00:05:00.000Z'),
      { action: 'oauth_callback', afterMs: 60_000 }
    );
    expect(result.outcome).toBe('not_pending');
  });

  it('does not reclaim when the claim carries no readable age', async () => {
    const state = createAtomicRepository();
    const store = new WidgetResolutionStore(state.repository);
    await store.claim('widget-1' as MessageID, claimInput('first', 'not-a-timestamp'));
    const result = await store.claim(
      'widget-1' as MessageID,
      claimInput('second', '2026-08-06T00:05:00.000Z'),
      { action: 'oauth_callback', afterMs: 60_000 }
    );
    expect(result.outcome).toBe('not_pending');
  });
});
