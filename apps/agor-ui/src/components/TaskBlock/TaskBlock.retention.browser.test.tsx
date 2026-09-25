import {
  type AgorClient,
  leanMessage,
  type Message,
  MessageRole,
  type Task,
} from '@agor/core/client';
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react';
import { useSyncExternalStore } from 'react';
import { afterEach, expect, it } from 'vitest';
import { userEvent } from 'vitest/browser';
import { ReactiveSessionHandle } from '../../../../../packages/client/src/reactive-session';
import { TaskBlock } from './TaskBlock';

afterEach(cleanup);

class Events {
  listeners = new Map<string, Set<(value: unknown) => void>>();
  connected = true;
  on(name: string, callback: (value: unknown) => void) {
    if (!this.listeners.has(name)) this.listeners.set(name, new Set());
    this.listeners.get(name)!.add(callback);
    return this;
  }
  removeListener(name: string, callback: (value: unknown) => void) {
    this.listeners.get(name)?.delete(callback);
    return this;
  }
  off(name: string, callback: (value: unknown) => void) {
    return this.removeListener(name, callback);
  }
  emit(name: string, value?: unknown) {
    for (const callback of [...(this.listeners.get(name) ?? [])]) callback(value);
  }
}

// Real ReactiveSessionHandle, deterministic service boundary (no provider or daemon).
function fixture() {
  const tasks: Task[] = [];
  const messages: Message[] = [];
  const io = new Events();
  type Query = {
    $limit?: number;
    $sort?: { task_id?: number };
    task_id?: string | { $in?: string[]; $gt?: string; $lte?: string };
    transcript?: string;
  };
  const taskService = Object.assign(new Events(), {
    find: async ({ query }: { query: Query }) => {
      const cursor = typeof query.task_id === 'object' ? query.task_id : undefined;
      let rows = tasks.filter(
        (t) =>
          (!cursor?.$gt || t.task_id > cursor.$gt) && (!cursor?.$lte || t.task_id <= cursor.$lte)
      );
      rows = rows.sort((a, b) => a.task_id.localeCompare(b.task_id) * (query.$sort?.task_id ?? 1));
      return { data: rows.slice(0, query.$limit), total: rows.length };
    },
    findAll: async () => tasks.filter((t) => t.status === 'running'),
  });
  const messageService = Object.assign(new Events(), {
    findAll: async ({ query }: { query: Query }) =>
      messages
        .filter((m) =>
          typeof query.task_id === 'string'
            ? m.task_id === query.task_id
            : query.task_id?.$in?.includes(m.task_id!)
        )
        .map((m) => (query.transcript === 'lean' ? leanMessage(m) : m)),
  });
  const services: Record<string, unknown> = {
    tasks: taskService,
    messages: messageService,
    sessions: Object.assign(new Events(), {
      get: async () => ({ session_id: 'session', tasks: tasks.map((t) => t.task_id) }),
    }),
    'session-streams': {
      create: async () => ({ session_id: 'session' }),
      remove: async () => ({}),
    },
    'sessions/:id/tasks/queue': Object.assign(new Events(), { find: async () => ({ data: [] }) }),
  };
  const client = { io, service: (name: string) => services[name] } as unknown as AgorClient;
  const handle = new ReactiveSessionHandle(client, 'session', { taskHydration: 'lean' });
  const addTurn = (i: number) => {
    const task = {
      task_id: `t${String(i).padStart(3, '0')}`,
      session_id: 'session',
      created_by: 'user',
      full_prompt: 'prompt',
      status: 'running',
      created_at: '2026-09-01T00:00:00Z',
      message_range: { start_index: i, end_index: i },
      git_state: {},
      recorded_tool_count: 1,
    } as unknown as Task;
    taskService.emit('created', task);
    const message: Message = {
      message_id: `m${i}` as Message['message_id'],
      task_id: task.task_id,
      session_id: 'session' as Message['session_id'],
      role: MessageRole.ASSISTANT,
      type: 'assistant',
      index: i,
      timestamp: task.created_at,
      content_preview: '',
      content: [
        { type: 'text', text: `Answer ${i}` },
        { type: 'thinking', text: `reasoning ${i}` },
        { type: 'tool_use', id: `read${i}`, name: 'Read', input: { file_path: '/fixture.txt' } },
        { type: 'tool_result', tool_use_id: `read${i}`, content: `output ${i}` },
      ],
    };
    messages.push(message);
    messageService.emit('created', message);
    const completed = { ...task, status: 'completed' } as Task;
    tasks.push(completed);
    taskService.emit('patched', completed);
  };
  return { handle, io, addTurn };
}

it.each(['tool', 'thinking', 'mixed'] as const)(
  'mixed %s consumers survive eviction/reconnect and release on collapse/unmount',
  async (kind) => {
    const { handle, io, addTurn } = fixture();
    await handle.ready();
    addTurn(0);
    function Reader({ name }: { name: string }) {
      const state = useSyncExternalStore(
        (callback) => handle.subscribe(callback),
        () => handle.state
      );
      return (
        <section aria-label={name}>
          <TaskBlock
            task={state.tasks.find((t) => t.task_id === 't000')!}
            taskMessages={state.messagesByTask.get('t000') ?? []}
            taskMessagesLoaded={state.loadedTaskIds.has('t000')}
            onLoadTaskMessages={(id) => {
              void handle.loadTaskMessages(id);
            }}
            // Deliberately new callbacks: effect replacement must not open an eviction gap.
            onRetainTaskDetails={(id) => handle.retainTaskDetails(id)}
          />
        </section>
      );
    }
    const first = render(<Reader name="first" />);
    const second = render(<Reader name="second" />);
    const label = kind !== 'thinking' ? /Read.*fixture/ : /Extended Thinking/;
    const text = kind !== 'thinking' ? 'output 0' : 'reasoning 0';
    const secondLabel = kind === 'mixed' ? /Extended Thinking/ : label;
    const secondText = kind === 'mixed' ? 'reasoning 0' : text;
    const reader = (name: string) => within(screen.getByRole('region', { name }));
    try {
      await act(async () => {
        await userEvent.click(reader('first').getByRole('button', { name: label }));
      });
      await act(async () => {
        await userEvent.click(reader('second').getByRole('button', { name: secondLabel }));
      });
      await act(async () => {
        for (let i = 1; i <= 10; i++) addTurn(i);
      });
      await waitFor(() => expect(reader('first').getByText(text)).toBeVisible());
      await waitFor(() => expect(reader('second').getByText(secondText)).toBeVisible());
      await act(async () => {
        io.emit('disconnect');
        io.emit('connect');
        await handle.resync();
      });
      await waitFor(() => expect(reader('second').getByText(secondText)).toBeVisible());
      await act(async () => {
        await userEvent.click(reader('first').getByRole('button', { name: label }));
      });
      await waitFor(() => expect(reader('second').getByText(secondText)).toBeVisible());
      second.unmount();
      await waitFor(() =>
        expect(JSON.stringify(handle.state.messagesByTask.get('t000'))).not.toContain('tool_result')
      );
      // Collapsed, still-mounted first reader is not a pin. Older details reload.
      await act(async () => {
        await handle.loadTaskMessages('t000');
      });
      await act(async () => {
        await userEvent.click(reader('first').getByRole('button', { name: label }));
      });
      await waitFor(() => expect(reader('first').getByText(text)).toBeVisible());
      // A late React effect/cleanup after disposal is harmless.
      handle.dispose();
    } finally {
      first.unmount();
      second.unmount();
      handle.dispose();
    }
  }
);
