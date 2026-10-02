import {
  type AgorClient,
  LEAN_TRANSCRIPT_TASK_WINDOW,
  type Message,
  type MessageID,
  MessageRole,
  type SessionID,
  type Task,
  type TaskID,
  TaskStatus,
} from '@agor-live/client';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { App, ConfigProvider, theme } from 'antd';
import { afterEach, expect, it } from 'vitest';
import { ConversationView } from './ConversationView';

// The real lean ReactiveSessionHandle and shared-session hook over a fake
// transport, so the window is enforced by the code that ships.
const SESSION_ID = '0199b000-0000-7000-8000-000000000000' as SessionID;
const taskId = (n: number) => `0199b000-0000-7000-8000-${String(n).padStart(12, '0')}` as TaskID;
const turnOf = (id: string) => Number(id.slice(-12));

function task(n: number, status: Task['status'] = TaskStatus.COMPLETED): Task {
  const createdAt = new Date(Date.UTC(2026, 9, 1, 0, n)).toISOString();
  return {
    task_id: taskId(n),
    session_id: SESSION_ID,
    created_by: 'fixture-user',
    full_prompt: `Prompt ${n}`,
    status,
    created_at: createdAt,
    message_range: { start_index: n * 2, end_index: n * 2 + 1, start_timestamp: createdAt },
    git_state: { ref_at_start: 'main', sha_at_start: 'unknown' },
  } as Task;
}

function messages(n: number): Message[] {
  const base = {
    session_id: SESSION_ID,
    task_id: taskId(n),
    timestamp: task(n).created_at,
    content_preview: '',
  };
  return [
    {
      ...base,
      message_id: `${taskId(n)}-prompt` as MessageID,
      index: n * 2,
      role: MessageRole.USER,
      type: 'user',
      content: `Prompt ${n}`,
    },
    {
      ...base,
      message_id: `${taskId(n)}-answer` as MessageID,
      index: n * 2 + 1,
      role: MessageRole.ASSISTANT,
      type: 'assistant',
      content: `Answer ${n}. ${'A line of synthetic transcript text. '.repeat(4)}`,
    },
  ] as Message[];
}

type Handler = (payload?: unknown) => void;
function events() {
  const handlers = new Map<string, Set<Handler>>();
  return {
    on(event: string, handler: Handler) {
      if (!handlers.has(event)) handlers.set(event, new Set());
      handlers.get(event)!.add(handler);
    },
    off(event: string, handler: Handler) {
      handlers.get(event)?.delete(handler);
    },
    removeListener(event: string, handler: Handler) {
      handlers.get(event)?.delete(handler);
    },
    emit(event: string, payload?: unknown) {
      for (const handler of [...(handlers.get(event) ?? [])]) handler(payload);
    },
  };
}

/** A fresh client per test: shared handles are cached per client. */
function transport(persisted: number) {
  let turns = persisted;
  const tasks = Object.assign(events(), {
    find: async ({ query }: { query: Record<string, unknown> }) => {
      const range = query.task_id as { $lte?: string; $gt?: string } | undefined;
      let rows = Array.from({ length: turns }, (_, n) => task(n)).filter(
        (row) =>
          (!range?.$lte || row.task_id <= range.$lte) && (!range?.$gt || row.task_id > range.$gt)
      );
      if ((query.$sort as { task_id?: number }).task_id === -1) rows = rows.reverse();
      return { data: rows.slice(0, Number(query.$limit)), total: rows.length };
    },
    get: async (id: string) => task(turnOf(id)),
  });
  const messageService = Object.assign(events(), {
    findAll: async ({ query }: { query: { task_id: string | { $in: string[] } } }) => {
      const ids = typeof query.task_id === 'string' ? [query.task_id] : query.task_id.$in;
      return ids.flatMap((id) => messages(turnOf(id)));
    },
  });
  const services: Record<string, unknown> = {
    sessions: Object.assign(events(), {
      get: async () => ({
        session_id: SESSION_ID,
        tasks: Array.from({ length: turns }, (_, n) => taskId(n)),
      }),
    }),
    tasks,
    messages: messageService,
    'session-streams': {
      create: async () => ({ session_id: SESSION_ID }),
      remove: async () => ({ session_id: SESSION_ID }),
    },
  };
  const queue = { find: async () => ({ data: [] }) };
  const client = {
    io: Object.assign(events(), { connected: true }),
    service: (name: string) => (name.endsWith('/tasks/queue') ? queue : services[name]),
  } as unknown as AgorClient;
  /** One live turn as the daemon publishes it, then a commit and its effects. */
  const addTurn = async () => {
    const n = turns++;
    act(() => {
      tasks.emit('created', task(n, TaskStatus.RUNNING));
      for (const message of messages(n)) messageService.emit('created', message);
      tasks.emit('patched', task(n));
    });
    await new Promise((resolve) => requestAnimationFrame(() => setTimeout(resolve)));
  };
  return { client, addTurn };
}

async function mount(client: AgorClient) {
  render(
    <ConfigProvider theme={{ algorithm: theme.darkAlgorithm }}>
      <App>
        <div style={{ height: 'calc(100dvh - 32px)', display: 'flex', flexDirection: 'column' }}>
          <ConversationView client={client} sessionId={SESSION_ID} />
        </div>
      </App>
    </ConfigProvider>
  );
  await screen.findByText(/Answer 9\./);
  return screen.getByTestId('conversation-scroll-container');
}

const mountedTurns = (viewport: HTMLElement) =>
  Array.from(viewport.querySelectorAll<HTMLElement>('[data-task-block]')).map((element) =>
    turnOf(element.dataset.taskBlock!)
  );
const range = (from: number, to: number) =>
  Array.from({ length: to - from + 1 }, (_, i) => from + i);
const distanceFromBottom = (viewport: HTMLElement) =>
  viewport.scrollHeight - viewport.clientHeight - viewport.scrollTop;
/** A programmatic scroll is a native scroll event, as the stick-to-bottom hook sees a reader. */
async function scrollTo(viewport: HTMLElement, top: number) {
  viewport.scrollTop = top;
  await new Promise((resolve) => setTimeout(resolve, 50));
}

afterEach(cleanup);

it('keeps a bounded transcript for a reader parked at the latest turns and pages it back', async () => {
  const { client, addTurn } = transport(10);
  const viewport = await mount(client);
  for (let i = 0; i < 70; i++) await addTurn();
  await screen.findByText(/Answer 79\./);
  // Turns 0-49 left the handle and the DOM; the latest window stays mounted.
  await waitFor(() => expect(mountedTurns(viewport)).toEqual(range(50, 79)));
  expect(LEAN_TRANSCRIPT_TASK_WINDOW).toBe(30);
  await waitFor(() => expect(distanceFromBottom(viewport)).toBeLessThan(2));
  expect(screen.getByText(/Answer 79\./)).toBeVisible();

  // Trimmed turns return through the existing older-history path, in order:
  // scrolling up to the top pages in one older batch.
  expect(screen.getByRole('button', { name: 'Load older history' })).toBeInTheDocument();
  await scrollTo(viewport, 0);
  await waitFor(() => expect(mountedTurns(viewport)).toEqual(range(40, 79)));
  // The reader is reading history now: new turns do not trim it away.
  for (let i = 0; i < 3; i++) await addTurn();
  await waitFor(() => expect(mountedTurns(viewport)).toEqual(range(40, 82)));
});

it('never trims under a scrolled-up reader, keeps its place, and trims on return', async () => {
  const { client, addTurn } = transport(10);
  const viewport = await mount(client);
  for (let i = 0; i < 25; i++) await addTurn();
  await waitFor(() => expect(mountedTurns(viewport)).toEqual(range(5, 34)));

  // Read somewhere in the middle; mark the first visible turn.
  await scrollTo(viewport, Math.floor((viewport.scrollHeight - viewport.clientHeight) / 2));
  const top = viewport.getBoundingClientRect().top;
  const anchor = Array.from(viewport.querySelectorAll<HTMLElement>('[data-task-block]')).find(
    (element) => element.getBoundingClientRect().bottom >= top
  )!;
  const anchorTop = anchor.getBoundingClientRect().top;
  for (let i = 0; i < 15; i++) await addTurn();
  await screen.findByText(/Answer 49\./, undefined, { timeout: 5_000 });
  expect(mountedTurns(viewport)).toEqual(range(5, 49));
  expect(anchor.isConnected).toBe(true);
  expect(Math.abs(anchor.getBoundingClientRect().top - anchorTop)).toBeLessThan(2);

  // Back at the latest turns: trimmed above the viewport without leaving the bottom.
  await scrollTo(viewport, viewport.scrollHeight);
  await waitFor(() => expect(mountedTurns(viewport)).toEqual(range(20, 49)));
  await waitFor(() => expect(distanceFromBottom(viewport)).toBeLessThan(2));
  expect(screen.getByText(/Answer 49\./)).toBeVisible();
  await addTurn();
  await waitFor(() => expect(mountedTurns(viewport)).toEqual(range(21, 50)));
  await waitFor(() => expect(distanceFromBottom(viewport)).toBeLessThan(2));
});
