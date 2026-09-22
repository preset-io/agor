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
  let rows = [a, b];
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
      rows = tasks;
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
