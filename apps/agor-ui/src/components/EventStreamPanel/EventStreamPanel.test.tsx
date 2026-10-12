/**
 * The event stream labels the sessions and branches its events name with the
 * store's session and branch maps empty (Step 3): it reads them by id,
 * debounced, each once.
 */
import type { Branch, Session } from '@agor-live/client';
import { render, waitFor } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import { AppActionsProvider } from '../../contexts/AppActionsContext';
import type { SocketEvent } from '../../hooks/useEventStream';
import { agorStore } from '../../store/agorStore';
import { fakeFeathersClient, withTestAuthority } from '../../test/harness';
import { EventStreamPanel } from './EventStreamPanel';

const session = { session_id: 's1', branch_id: 'b2', archived: false } as Session;
const branch = (id: string) => ({ branch_id: id, name: id, archived: false }) as Branch;
const event = (id: string, data: unknown): SocketEvent => ({
  id,
  timestamp: new Date(0),
  type: 'crud',
  eventName: 'sessions patched',
  data,
});

withTestAuthority('user-1:member:1');

it('reads the sessions and branches its events name, debounced and once', async () => {
  const { client } = fakeFeathersClient({
    sessions: { find: () => [session] },
    branches: { find: ({ query }) => (query.branch_id as { $in: string[] }).$in.map(branch) },
  });
  const panel = (events: SocketEvent[]) => (
    <AppActionsProvider value={{} as never}>
      <EventStreamPanel collapsed={false} events={events} onClear={vi.fn()} client={client} />
    </AppActionsProvider>
  );
  const first = [event('e1', { session_id: 's1' }), event('e2', { branch_id: 'b1' })];
  const { rerender } = render(panel(first));
  rerender(panel([event('e3', { session_id: 's1' }), ...first]));
  await waitFor(() => expect(agorStore.getState().sessionById.has('s1')).toBe(true), {
    timeout: 3000,
  });
  await waitFor(() => expect(agorStore.getState().branchById.has('b2')).toBe(true), {
    timeout: 3000,
  });
  expect(client.service('sessions').find).toHaveBeenCalledTimes(1);
  expect(agorStore.getState().branchById.has('b1')).toBe(true);
});
