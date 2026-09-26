import type { AgorClient, Session, Task } from '@agor-live/client';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { App } from 'antd';
import { afterEach, expect, it, vi } from 'vitest';
import { userEvent } from 'vitest/browser';
import { AppActionsProvider } from '../../contexts/AppActionsContext';
import SessionPanel from './SessionPanel';

// Exercise the real panel, shared hook, reactive projection and queue controls.
// Only transcript rows and unrelated dialogs are stubbed.
vi.mock('../TaskBlock', () => ({
  TaskBlock: ({ task }: { task: Task }) => <p>Transcript {task.task_id}</p>,
}));
vi.mock('../ForkSpawnModal', () => ({ ForkSpawnModal: () => null }));
vi.mock('../../utils/clipboard', () => ({
  copyToClipboard: vi.fn().mockResolvedValue(true),
  useCopyToClipboard: () => [false, vi.fn()],
}));

import { copyToClipboard } from '../../utils/clipboard';

const session = {
  session_id: 'session-1',
  agentic_tool: 'codex',
  status: 'running',
} as Session;
const noop = () => {};
const makeTask = (id: string, position: number): Task =>
  ({
    task_id: id,
    session_id: session.session_id,
    full_prompt: `Queue ${id.toUpperCase()}`,
    status: 'queued',
    queue_position: position,
  }) as Task;
const a = makeTask('a', 1);
const b = makeTask('b', 2);
const c = makeTask('c', 3);

function fixture(status: Session['status'] = 'running') {
  const active = { ...makeTask('active', 0), status, queue_position: undefined } as Task;
  let rows = [active, a, b];
  const listeners = new Map<string, Set<(payload: never) => void>>();
  const events = (service: string) => {
    const on = (event: string, listener: (payload: never) => void) => {
      const key = `${service}:${event}`;
      if (!listeners.has(key)) listeners.set(key, new Set());
      listeners.get(key)!.add(listener);
    };
    const off = (event: string, listener: (payload: never) => void) =>
      listeners.get(`${service}:${event}`)?.delete(listener);
    return { on, off, removeListener: off };
  };
  const patch = vi.fn().mockResolvedValue(undefined);
  const queueFind = vi.fn(async () => ({ data: rows.filter((task) => task.status === 'queued') }));
  const services = {
    sessions: {
      ...events('sessions'),
      get: async (id: string) => ({ ...session, session_id: id, status }),
      patch,
    },
    tasks: {
      ...events('tasks'),
      find: async () => ({ data: rows.filter((task) => task.status !== 'queued'), total: 0 }),
      get: async (id: string) => {
        const task = rows.find((task) => task.task_id === id);
        if (!task) throw Object.assign(new Error('Not found'), { code: 404 });
        return task;
      },
    },
    messages: { ...events('messages'), findAll: async () => [] },
    'session-streams': {
      create: async ({ session_id }: { session_id: string }) => ({ session_id, subscribed: true }),
      remove: async () => ({}),
    },
  };
  const client = {
    io: { ...events('io'), connected: true },
    service: (name: string) =>
      name.endsWith('/tasks/queue') ? { find: queueFind } : services[name as keyof typeof services],
  } as unknown as AgorClient;
  const emit = (event: string, task: Task) =>
    act(() => {
      listeners.get(`tasks:${event}`)?.forEach((listener) => {
        listener(task as never);
      });
    });
  const panel = (activeSession = { ...session, status }) => (
    <App>
      <AppActionsProvider value={{}}>
        <div style={{ height: 700 }}>
          <SessionPanel client={client} session={activeSession} open onClose={noop} />
        </div>
      </AppActionsProvider>
    </App>
  );
  return {
    client,
    patch,
    queueFind,
    emit,
    panel,
    listeners,
    setRows: (tasks: Task[]) => {
      rows = [active, ...tasks];
    },
    fireIo: (event: string) =>
      act(() => {
        listeners.get(`io:${event}`)?.forEach((listener) => {
          listener(undefined as never);
        });
      }),
  };
}
const order = () =>
  Array.from(
    screen.getByRole('region', { name: 'Queued task list' }).querySelectorAll('.ant-typography')
  ).map((label) => label.textContent);
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

it.each(['running', 'failed'] as const)(
  'updates the actual SessionPanel %s queue on reordered patches without releasing it',
  async (status) => {
    const f = fixture(status);
    const { unmount } = render(f.panel());
    await screen.findByText('Queued Tasks (2)');
    expect(order()).toEqual([
      expect.stringContaining('Queue A'),
      expect.stringContaining('Queue B'),
    ]);
    const reorderedB = { ...b, queue_position: 0 };
    const reorderedA = { ...a, queue_position: 1 };
    f.setRows([reorderedB, reorderedA]);
    f.emit('patched', reorderedB);
    f.emit('patched', reorderedA);
    await waitFor(() =>
      expect(order()).toEqual([
        expect.stringContaining('Queue B'),
        expect.stringContaining('Queue A'),
      ])
    );
    f.emit('patched', reorderedB);
    f.emit('queued', reorderedB);
    f.emit('patched', { ...a, session_id: 'foreign-session' as Task['session_id'] });
    f.emit('removed', { ...b, session_id: 'foreign-session' as Task['session_id'] });
    expect(order()).toHaveLength(2);
    expect(f.patch).not.toHaveBeenCalled();
    expect(screen.getByText('Transcript active')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Copy queued task 1' }));
    expect(copyToClipboard).toHaveBeenLastCalledWith('Queue B');
    if (status === 'failed') {
      const runNext = screen.getByRole('button', { name: 'Run next' });
      expect(runNext.parentElement?.parentElement?.parentElement).toHaveTextContent('Queue B');
      expect(screen.getByRole('button', { name: 'Resume queue' })).toBeVisible();
      await userEvent.click(runNext);
      expect(f.patch).toHaveBeenCalledExactlyOnceWith(session.session_id, {
        ready_for_prompt: true,
      });
    } else {
      expect(screen.queryByRole('button', { name: 'Run next' })).toBeNull();
    }
    f.setRows([reorderedB, reorderedA, c]);
    f.emit('queued', c);
    f.emit('queued', c);
    const reorderedC = { ...c, queue_position: -1 };
    f.setRows([reorderedC, reorderedB, reorderedA]);
    f.emit('updated', reorderedC);
    await waitFor(() => expect(order()[0]).toContain('Queue C'));
    f.setRows([reorderedC, { ...b, status: 'dispatching', queue_position: undefined }]);
    f.emit('patched', { ...b, status: 'dispatching', queue_position: undefined });
    f.emit('removed', a);
    f.emit('removed', a);
    await waitFor(() => expect(order()).toEqual([expect.stringContaining('Queue C')]));
    unmount();
    // The per-client room registry retains its socket listener, not task consumers.
    expect(
      [...f.listeners]
        .filter(([key]) => !key.startsWith('io:'))
        .every(([, handlers]) => handlers.size === 0)
    ).toBe(true);
  }
);

it('does not resurrect a removed task when an older reorder patch arrives', async () => {
  const f = fixture();
  render(f.panel());
  await screen.findByText('Queued Tasks (2)');
  f.setRows([a]);
  f.emit('removed', b);
  expect(order()).toEqual([expect.stringContaining('Queue A')]);
  await act(async () => f.emit('patched', { ...b, queue_position: 0 }));
  expect(order()).toEqual([expect.stringContaining('Queue A')]);
});

it('does not roll back a newer reorder when older patches arrive last', async () => {
  const f = fixture('failed');
  render(f.panel());
  await screen.findByText('Queued Tasks (2)');
  f.setRows([{ ...b, queue_position: 0 }, a]);
  await act(async () => f.emit('patched', { ...b, queue_position: 0 }));
  await waitFor(() => expect(order()[0]).toContain('Queue B'));
  await act(async () => f.emit('patched', b));
  expect(order()[0]).toContain('Queue B');
  expect(
    screen.getByRole('button', { name: 'Run next' }).parentElement?.parentElement?.parentElement
  ).toHaveTextContent('Queue B');
});

function deferredQueue() {
  let resolve!: (value: { data: Task[] }) => void;
  const promise = new Promise<{ data: Task[] }>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

it.each(['removed', 'patched'] as const)(
  'discards an in-flight snapshot invalidated by a newer %s event before refetching',
  async (event) => {
    const f = fixture();
    render(f.panel());
    await screen.findByText('Queued Tasks (2)');
    const old = deferredQueue();
    const fresh = deferredQueue();
    const before = f.queueFind.mock.calls.length;
    f.queueFind
      .mockImplementationOnce(() => old.promise)
      .mockImplementationOnce(() => fresh.promise);
    f.emit('patched', a);
    await waitFor(() => expect(f.queueFind).toHaveBeenCalledTimes(before + 1));
    f.setRows(event === 'removed' ? [a] : [b, { ...a, queue_position: 3 }]);
    f.emit(event, event === 'removed' ? b : { ...a, queue_position: 3 });
    await act(async () => old.resolve({ data: [c, b, a] }));
    await waitFor(() => expect(f.queueFind).toHaveBeenCalledTimes(before + 2));
    // The invalidated response is NEVER rendered, even before the reread settles.
    expect(screen.queryByText('Queue C')).toBeNull();
    expect(order()).toEqual(
      event === 'removed'
        ? [expect.stringContaining('Queue A')]
        : [expect.stringContaining('Queue A'), expect.stringContaining('Queue B')]
    );
    await act(async () =>
      fresh.resolve({
        data: event === 'removed' ? [a] : [b, { ...a, queue_position: 3 }],
      })
    );
    expect(order()).toEqual(
      event === 'removed'
        ? [expect.stringContaining('Queue A')]
        : [expect.stringContaining('Queue B'), expect.stringContaining('Queue A')]
    );
  }
);

it('never resurrects a started task from delayed admission or reorder events', async () => {
  const f = fixture();
  render(f.panel());
  await screen.findByText('Queued Tasks (2)');
  const running = { ...b, status: 'running' as const, queue_position: undefined };
  f.setRows([a, running]);
  f.emit('patched', running);
  for (const event of ['created', 'queued', 'patched', 'updated']) {
    await act(async () => f.emit(event, b));
    expect(order()).toEqual([expect.stringContaining('Queue A')]);
  }
  expect(screen.getByText('Transcript b')).toBeVisible();
});

it('fences session replacement and unmount while queue reads are pending', async () => {
  const f = fixture();
  const view = render(f.panel());
  await screen.findByText('Queued Tasks (2)');
  const old = deferredQueue();
  const before = f.queueFind.mock.calls.length;
  f.queueFind.mockImplementationOnce(() => old.promise);
  f.emit('patched', a);
  await waitFor(() => expect(f.queueFind).toHaveBeenCalledTimes(before + 1));
  const other = { ...c, session_id: 'session-2' as Task['session_id'] };
  f.setRows([other]);
  view.rerender(f.panel({ ...session, session_id: other.session_id }));
  await screen.findByText('Queue C');
  await act(async () => old.resolve({ data: [a, b] }));
  expect(order()).toEqual([expect.stringContaining('Queue C')]);
  // Foreign events must not even initiate a read for the new session.
  const currentReads = f.queueFind.mock.calls.length;
  f.emit('removed', a);
  f.emit('patched', b);
  expect(f.queueFind).toHaveBeenCalledTimes(currentReads);

  const unmounted = deferredQueue();
  f.queueFind.mockImplementationOnce(() => unmounted.promise);
  f.emit('patched', other);
  await waitFor(() => expect(f.queueFind).toHaveBeenCalledTimes(currentReads + 1));
  view.unmount();
  await act(async () => unmounted.resolve({ data: [a, b] }));
  expect(screen.queryByText(/Queue [ABC]/)).toBeNull();
  expect(
    [...f.listeners]
      .filter(([key]) => key.startsWith('tasks:'))
      .every(([, handlers]) => handlers.size === 0)
  ).toBe(true);
});

it('refreshes missed admission/removal/reorder on reconnect and fences the pre-disconnect read', async () => {
  const f = fixture();
  render(f.panel());
  await screen.findByText('Queued Tasks (2)');
  const old = deferredQueue();
  const before = f.queueFind.mock.calls.length;
  f.queueFind.mockImplementationOnce(() => old.promise);
  f.emit('patched', a);
  await waitFor(() => expect(f.queueFind).toHaveBeenCalledTimes(before + 1));
  f.fireIo('disconnect');
  f.setRows([c, { ...a, queue_position: 4 }]);
  f.fireIo('connect');
  await act(async () => old.resolve({ data: [b, a] }));
  await waitFor(() =>
    expect(order()).toEqual([
      expect.stringContaining('Queue C'),
      expect.stringContaining('Queue A'),
    ])
  );
});

it('keeps confirmed rows on a failed reconciliation and recovers on a later invalidation', async () => {
  const f = fixture();
  render(f.panel());
  await screen.findByText('Queued Tasks (2)');
  f.queueFind.mockRejectedValueOnce(new Error('temporary queue outage'));
  await act(async () => f.emit('patched', a));
  expect(order()).toEqual([expect.stringContaining('Queue A'), expect.stringContaining('Queue B')]);
  f.setRows([c]);
  await act(async () => f.emit('queued', c));
  await waitFor(() => expect(order()).toEqual([expect.stringContaining('Queue C')]));
});
