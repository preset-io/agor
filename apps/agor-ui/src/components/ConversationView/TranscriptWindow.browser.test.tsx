import {
  type AgorClient,
  LEAN_TRANSCRIPT_TASK_WINDOW,
  type Message,
  type MessageID,
  MessageRole,
  releaseReactiveSession,
  retainReactiveSession,
  type SessionID,
  type Task,
  type TaskID,
  TaskStatus,
} from '@agor-live/client';
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react';
import { App, ConfigProvider, theme } from 'antd';
import { useState } from 'react';
import { afterEach, expect, it, vi } from 'vitest';
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

/** `long` answers collapse as history unless the turn arrived live or the reader expanded them. */
function messages(n: number, long = false): Message[] {
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
      content: long
        ? `Answer ${n}.\n${'A line of synthetic transcript text.\n'.repeat(20)}`
        : `Answer ${n}. ${'A line of synthetic transcript text. '.repeat(4)}`,
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
function transport(persisted: number, { long = false } = {}) {
  let turns = persisted;
  const tasks = Object.assign(events(), {
    find: async ({ query }: { query: Record<string, unknown> }) => {
      const range = query.task_id as { $lte?: string; $gt?: string; $in?: string[] } | undefined;
      let rows = Array.from({ length: turns }, (_, n) => task(n)).filter(
        (row) =>
          (!range?.$lte || row.task_id <= range.$lte) &&
          (!range?.$gt || row.task_id > range.$gt) &&
          (!range?.$in || range.$in.includes(row.task_id))
      );
      if ((query.$sort as { task_id?: number } | undefined)?.task_id === -1) rows = rows.reverse();
      return { data: rows.slice(0, Number(query.$limit)), total: rows.length };
    },
    get: async (id: string) => task(turnOf(id)),
  });
  const messageService = Object.assign(events(), {
    findAll: async ({ query }: { query: { task_id: string | { $in: string[] } } }) => {
      const ids = typeof query.task_id === 'string' ? [query.task_id] : query.task_id.$in;
      return ids.flatMap((id) => messages(turnOf(id), long));
    },
  });
  const session = () => ({
    session_id: SESSION_ID,
    tasks: Array.from({ length: turns }, (_, n) => taskId(n)),
  });
  const sessions = Object.assign(events(), { get: async () => session() });
  const services: Record<string, unknown> = {
    sessions,
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
      // Dispatch appends the turn to Session.tasks.
      sessions.emit('patched', session());
      for (const message of messages(n, long)) messageService.emit('created', message);
      tasks.emit('patched', task(n));
    });
    await new Promise((resolve) => requestAnimationFrame(() => setTimeout(resolve)));
  };
  /** A message event for an already-loaded turn (a widget request or its answer). */
  const emitMessage = async (event: 'created' | 'patched', message: Message) => {
    act(() => messageService.emit(event, message));
    await new Promise((resolve) => requestAnimationFrame(() => setTimeout(resolve)));
  };
  return { client, addTurn, emitMessage };
}

async function mount(
  client: AgorClient,
  onScrollRef?: (scrollToBottom: () => void, scrollToTop: () => void) => void
) {
  render(
    <ConfigProvider theme={{ algorithm: theme.darkAlgorithm }}>
      <App>
        <div style={{ height: 'calc(100dvh - 32px)', display: 'flex', flexDirection: 'column' }}>
          <ConversationView client={client} sessionId={SESSION_ID} onScrollRef={onScrollRef} />
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
/**
 * A programmatic scroll is a native scroll event, as the stick-to-bottom hook
 * sees a reader. Upward, it comes with the reader's wheel, which the hook
 * handles synchronously; it ignores a bare scroll under a trim's layout guard.
 */
async function scrollTo(viewport: HTMLElement, top: number) {
  if (top < viewport.scrollTop) {
    viewport.dispatchEvent(
      new WheelEvent('wheel', { deltaY: top - viewport.scrollTop, bubbles: true })
    );
  }
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

it('trims as soon as a reader wheels back to the latest turns, before another turn arrives', async () => {
  const { client, addTurn } = transport(10);
  const viewport = await mount(client);
  for (let i = 0; i < 25; i++) await addTurn();
  await waitFor(() => expect(mountedTurns(viewport)).toEqual(range(5, 34)));
  await scrollTo(viewport, Math.floor((viewport.scrollHeight - viewport.clientHeight) / 2));
  for (let i = 0; i < 15; i++) await addTurn();
  await screen.findByText(/Answer 49\./, undefined, { timeout: 5_000 });

  // Wheel back down a step at a time, stopping short of the hook's 70px
  // near-bottom zone: nothing is trimmed while still scrolled up.
  while (distanceFromBottom(viewport) > 150) {
    expect(mountedTurns(viewport)).toEqual(range(5, 49));
    const step = Math.min(100, distanceFromBottom(viewport) - 120);
    viewport.dispatchEvent(new WheelEvent('wheel', { deltaY: step, bubbles: true }));
    await scrollTo(viewport, viewport.scrollTop + step);
  }
  expect(mountedTurns(viewport)).toEqual(range(5, 49));
  // Into the hook's near-bottom zone, where its lock engages, but short of the
  // end: the reader may still be reading, so nothing is trimmed or moved.
  const nearBottom = viewport.scrollTop + distanceFromBottom(viewport) - 50;
  viewport.dispatchEvent(new WheelEvent('wheel', { deltaY: 70, bubbles: true }));
  await scrollTo(viewport, nearBottom);
  await new Promise((resolve) => setTimeout(resolve, 300));
  expect(mountedTurns(viewport)).toEqual(range(5, 49));
  expect(Math.abs(viewport.scrollTop - nearBottom)).toBeLessThan(1);
  const latest = screen.getByText(/Answer 49\./);
  const remaining = distanceFromBottom(viewport);
  const latestTop = latest.getBoundingClientRect().top;
  viewport.dispatchEvent(new WheelEvent('wheel', { deltaY: remaining, bubbles: true }));
  await scrollTo(viewport, viewport.scrollTop + remaining);

  // Back at the latest turn with no new one: trimmed above the viewport, and
  // the latest turn moved only by the reader's own scroll.
  await waitFor(() => expect(mountedTurns(viewport)).toEqual(range(20, 49)), { timeout: 5_000 });
  expect(Math.abs(latest.getBoundingClientRect().top - (latestTop - remaining))).toBeLessThan(2);
  expect(distanceFromBottom(viewport)).toBeLessThan(2);
});

/**
 * A reader at the latest turn, settled. Turns piling up behind a protected turn
 * can release the stick-to-bottom lock on a slow runner (see the PR's bottom
 * lock risk); returning to the bottom re-engages it, as a reader would.
 */
async function park(viewport: HTMLElement) {
  await scrollTo(viewport, viewport.scrollHeight);
  await waitFor(() => expect(distanceFromBottom(viewport)).toBeLessThan(2), { timeout: 5_000 });
  await new Promise((resolve) => requestAnimationFrame(() => setTimeout(resolve, 50)));
}

/** The shared lean handle the view reads, for a reader's pin; release it after. */
function sharedHandle(client: AgorClient) {
  const handle = retainReactiveSession(client, SESSION_ID, { taskHydration: 'lean' });
  return {
    handle,
    release: () => releaseReactiveSession(client, SESSION_ID, { taskHydration: 'lean' }),
  };
}

it('trims a parked reader once the last pin that held the window open is released', async () => {
  const { client, addTurn } = transport(10);
  const viewport = await mount(client);
  const shared = sharedHandle(client);
  try {
    // An expanded disclosure (or focus, selection, overlay) in turn 2.
    const unpin = shared.handle.retainTaskDetails(taskId(2));
    for (let i = 0; i < 40; i++) await addTurn();
    await screen.findByText(/Answer 49\./, undefined, { timeout: 5_000 });
    await waitFor(() => expect(mountedTurns(viewport)).toEqual(range(2, 49)), { timeout: 5_000 });
    // Released with the reader parked at the bottom, and no new turn.
    await park(viewport);
    act(() => unpin());
    await waitFor(() => expect(mountedTurns(viewport)).toEqual(range(20, 49)), { timeout: 5_000 });
    await waitFor(() => expect(distanceFromBottom(viewport)).toBeLessThan(2), { timeout: 5_000 });
  } finally {
    shared.release();
  }
});

it('drops a pending parked check when the conversation unmounts', async () => {
  const { client, addTurn } = transport(10);
  const viewport = await mount(client);
  const shared = sharedHandle(client);
  try {
    // A pin holds the window open, so the parked check stays armed.
    const unpin = shared.handle.retainTaskDetails(taskId(2));
    for (let i = 0; i < 25; i++) await addTurn();
    await waitFor(() => expect(mountedTurns(viewport)).toEqual(range(2, 34)), { timeout: 5_000 });
    await park(viewport);
    const trim = vi.spyOn(shared.handle, 'trimOlderTasks');
    // A scroll queues a check for once the hook settles; unmount before it runs.
    viewport.dispatchEvent(new Event('scroll'));
    cleanup();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(trim).not.toHaveBeenCalled();
    unpin();
  } finally {
    shared.release();
  }
});

it('trims a parked reader once the last pending widget that held the window open is answered', async () => {
  const { client, addTurn, emitMessage } = transport(10);
  const viewport = await mount(client);
  const widget = (status: 'pending' | 'submitted') =>
    ({
      message_id: `${taskId(2)}-widget` as MessageID,
      session_id: SESSION_ID,
      task_id: taskId(2),
      type: 'widget_request',
      role: MessageRole.SYSTEM,
      index: 5,
      timestamp: task(2).created_at,
      content: 'Please provide env vars',
      content_preview: 'Please provide env vars',
      metadata: {
        widget: {
          widget_id: 'widget-2',
          widget_type: 'env_vars',
          schema_version: 1,
          status,
          requested_at: task(2).created_at,
          auto_resume: true,
          params: { names: ['FIXTURE_KEY'], reason: 'Fixture' },
        },
      },
    }) as unknown as Message;
  await emitMessage('created', widget('pending'));
  for (let i = 0; i < 40; i++) await addTurn();
  await screen.findByText(/Answer 49\./, undefined, { timeout: 5_000 });
  await waitFor(() => expect(mountedTurns(viewport)).toEqual(range(2, 49)), { timeout: 5_000 });
  await park(viewport);
  await emitMessage('patched', widget('submitted'));
  await waitFor(() => expect(mountedTurns(viewport)).toEqual(range(20, 49)), { timeout: 5_000 });
  await waitFor(() => expect(distanceFromBottom(viewport)).toBeLessThan(2), { timeout: 5_000 });
});

it('trims again once the reader returns with the jump-to-bottom button', async () => {
  const { client, addTurn } = transport(10);
  // The button (SessionPanelContent) calls exactly what onScrollRef hands out.
  let jumpToBottom: (() => void) | undefined;
  const viewport = await mount(client, (toBottom) => {
    jumpToBottom = toBottom;
  });
  for (let i = 0; i < 25; i++) await addTurn();
  await waitFor(() => expect(mountedTurns(viewport)).toEqual(range(5, 34)));

  // Scrolled up while turns arrive: nothing is trimmed under the reader.
  await scrollTo(viewport, Math.floor((viewport.scrollHeight - viewport.clientHeight) / 2));
  for (let i = 0; i < 15; i++) await addTurn();
  await screen.findByText(/Answer 49\./, undefined, { timeout: 5_000 });
  expect(mountedTurns(viewport)).toEqual(range(5, 49));

  act(() => jumpToBottom!());
  await waitFor(() => expect(distanceFromBottom(viewport)).toBeLessThan(2), { timeout: 5_000 });
  for (let i = 0; i < 5; i++) await addTurn();
  await waitFor(() => expect(mountedTurns(viewport)).toEqual(range(25, 54)), { timeout: 5_000 });
  await waitFor(() => expect(distanceFromBottom(viewport)).toBeLessThan(2), { timeout: 5_000 });
});

it('keeps a reader who scrolls up right after jump-to-bottom where they went', async () => {
  const { client, addTurn } = transport(10);
  let jumpToBottom: (() => void) | undefined;
  const viewport = await mount(client, (toBottom) => {
    jumpToBottom = toBottom;
  });
  for (let i = 0; i < 25; i++) await addTurn();
  await waitFor(() => expect(mountedTurns(viewport)).toEqual(range(5, 34)));
  await scrollTo(viewport, Math.floor((viewport.scrollHeight - viewport.clientHeight) / 2));
  for (let i = 0; i < 15; i++) await addTurn();
  await screen.findByText(/Answer 49\./, undefined, { timeout: 5_000 });
  expect(mountedTurns(viewport)).toEqual(range(5, 49));

  // The jump and a 25px upward wheel land together: the upward input wins.
  act(() => {
    jumpToBottom!();
    viewport.dispatchEvent(new WheelEvent('wheel', { deltaY: -25, bubbles: true }));
    viewport.scrollTop -= 25;
  });
  await new Promise((resolve) => setTimeout(resolve, 300));
  expect(distanceFromBottom(viewport)).toBeGreaterThan(20);
  expect(mountedTurns(viewport)).toEqual(range(5, 49));
});

it('trims again once the panel is reactivated after the reader scrolled away', async () => {
  const { client, addTurn } = transport(10);
  let setActive!: (active: boolean) => void;
  function Panel() {
    const [active, set] = useState(true);
    setActive = set;
    return (
      <ConfigProvider theme={{ algorithm: theme.darkAlgorithm }}>
        <App>
          <div style={{ height: 'calc(100dvh - 32px)', display: 'flex', flexDirection: 'column' }}>
            <ConversationView client={client} sessionId={SESSION_ID} isActive={active} />
          </div>
        </App>
      </ConfigProvider>
    );
  }
  render(<Panel />);
  await screen.findByText(/Answer 9\./);
  const viewport = () => screen.getByTestId('conversation-scroll-container');
  for (let i = 0; i < 25; i++) await addTurn();
  await waitFor(() => expect(mountedTurns(viewport())).toEqual(range(5, 34)));
  await scrollTo(viewport(), Math.floor((viewport().scrollHeight - viewport().clientHeight) / 2));
  for (let i = 0; i < 15; i++) await addTurn();
  await screen.findByText(/Answer 49\./, undefined, { timeout: 5_000 });
  expect(mountedTurns(viewport())).toEqual(range(5, 49));

  // Switching away releases the session; back, it reopens at the latest turns
  // and the reader is parked again: turns beyond the window are trimmed.
  act(() => setActive(false));
  act(() => setActive(true));
  await screen.findByText(/Answer 49\./, undefined, { timeout: 5_000 });
  await waitFor(() => expect(distanceFromBottom(viewport())).toBeLessThan(2), { timeout: 5_000 });
  for (let i = 0; i < 30; i++) await addTurn();
  await waitFor(() => expect(mountedTurns(viewport())).toEqual(range(50, 79)), { timeout: 5_000 });
  await waitFor(() => expect(distanceFromBottom(viewport())).toBeLessThan(2), { timeout: 5_000 });
});

it('forgets the reading state of trimmed turns and keeps it for turns still loaded', async () => {
  const { client, addTurn } = transport(10, { long: true });
  const viewport = await mount(client);
  const toggle = (n: number) =>
    within(viewport.querySelector<HTMLElement>(`[data-task-block="${taskId(n)}"]`)!).getByRole(
      'button',
      { name: /^show (more|less)$/ }
    );
  // History arrives collapsed and the reader expands turn 5; turn 9 arrived
  // as the latest turn and stays expanded.
  expect(toggle(5)).toHaveAttribute('aria-expanded', 'false');
  act(() => toggle(5).click());
  expect(toggle(5)).toHaveAttribute('aria-expanded', 'true');
  expect(toggle(9)).toHaveAttribute('aria-expanded', 'true');

  // Trimmed up to turn 5: both turns are still loaded and keep their state.
  for (let i = 0; i < 25; i++) await addTurn();
  await waitFor(() => expect(mountedTurns(viewport)).toEqual(range(5, 34)), { timeout: 5_000 });
  expect(toggle(5)).toHaveAttribute('aria-expanded', 'true');
  expect(toggle(9)).toHaveAttribute('aria-expanded', 'true');

  // Many more trims drop them; paged back in, they are plain history again.
  for (let i = 0; i < 35; i++) await addTurn();
  await waitFor(() => expect(mountedTurns(viewport)).toEqual(range(40, 69)), { timeout: 5_000 });
  while (!mountedTurns(viewport).includes(5)) {
    const before = mountedTurns(viewport)[0];
    // Its fading loading icon can linger in the accessible name; match the label.
    const loadOlder = screen.getByText('Load older history').closest('button')!;
    act(() => loadOlder.click());
    await waitFor(() => expect(mountedTurns(viewport)[0]).toBeLessThan(before), { timeout: 5_000 });
  }
  await waitFor(() => expect(toggle(5)).toHaveAttribute('aria-expanded', 'false'));
  expect(toggle(9)).toHaveAttribute('aria-expanded', 'false');
});
