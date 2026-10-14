import type { AgorClient, Session } from '@agor-live/client';
import { PAGINATION } from '@agor-live/client';
import { renderHook, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { agorStore } from '../store/agorStore';
import { makeSession, withTestAuthority } from '../test/harness';
import { useSessionGenealogyTargets } from './useSessionGenealogyTargets';

const row = (id: string, extra: Partial<Session> = {}) => makeSession(id, `br-${id}`, extra);

function makeClient(known: Session[]) {
  const find = vi.fn(async ({ query }: { query: { session_id: { $in: string[] } } }) =>
    known.filter((s) => query.session_id.$in.includes(s.session_id))
  );
  const client = { service: () => ({ find }) } as unknown as AgorClient;
  return { client, find };
}

describe('useSessionGenealogyTargets', () => {
  withTestAuthority('me:member:1');

  it('reads the parent, fork source, callback target and children the store lacks by id', async () => {
    const opened = row('open', {
      genealogy: {
        parent_session_id: 'parent',
        forked_from_session_id: 'fork',
        children: ['child-1', 'child-2'],
      },
      callback_config: { callback_session_id: 'callback' },
    } as Partial<Session>);
    agorStore.getState().applyMaps((maps) => ({
      ...maps,
      sessionById: new Map([
        ['open', opened],
        ['child-2', row('child-2')],
      ]),
    }));
    const { client, find } = makeClient([
      row('parent'),
      row('fork'),
      row('callback'),
      row('child-1'),
    ]);
    renderHook(() => useSessionGenealogyTargets(client, opened));
    await waitFor(() => expect(agorStore.getState().sessionById.has('parent')).toBe(true));
    for (const id of ['fork', 'callback', 'child-1']) {
      expect(agorStore.getState().sessionById.has(id)).toBe(true);
    }
    expect(find).toHaveBeenCalledTimes(1);
    expect(find.mock.calls[0][0].query).toMatchObject({
      session_id: { $in: ['callback', 'child-1', 'fork', 'parent'] },
      lean: true,
    });
    expect(agorStore.getState().coverage.size).toBe(0);
  });

  it('chunks the id list and does not re-read when the session is patched', async () => {
    const children = Array.from({ length: PAGINATION.MAX_ID_LIST + 1 }, (_, i) => `c-${i}`);
    const opened = row('open', { genealogy: { children } } as Partial<Session>);
    const { client, find } = makeClient([]);
    const { rerender } = renderHook(({ session }) => useSessionGenealogyTargets(client, session), {
      initialProps: { session: opened },
    });
    await waitFor(() => expect(find).toHaveBeenCalledTimes(2));
    rerender({ session: { ...opened, status: 'running' } as Session });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(find).toHaveBeenCalledTimes(2);
  });
});
