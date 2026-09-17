import type { AgorClient, Session, Task } from '@agor-live/client';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { App } from 'antd';
import { useEffect, useState } from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { page, userEvent } from 'vitest/browser';
import { AppActionsProvider } from '../../contexts/AppActionsContext';
import SessionPanel from './SessionPanel';
import { SessionPanelContent } from './SessionPanelContent';

// Keep the actual ConversationView scroll owner and split/queue UI. Only its
// data feed and expensive transcript rows are replaced with deterministic data.
vi.mock('../../hooks/useSharedReactiveSession', () => ({
  useSharedReactiveSession: () => ({
    handle: null,
    state: {
      sessionId: 'session-1',
      tasks: Array.from({ length: 20 }, (_, i) => ({
        task_id: `history-${i}`,
        status: 'completed',
      })),
      loading: false,
      messagesByTask: new Map(),
      loadedTaskIds: new Set(),
      streamingMessages: new Map(),
    },
  }),
}));
vi.mock('../TaskBlock', () => ({
  TaskBlock: ({ task }: { task: Task }) => <p style={{ height: 60 }}>Transcript {task.task_id}</p>,
}));
vi.mock('../ForkSpawnModal', () => ({ ForkSpawnModal: () => null }));
vi.mock('../AutocompleteTextarea', () => ({
  AutocompleteTextarea: () => <textarea aria-label="Prompt composer" />,
}));
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
const remove = vi.fn().mockResolvedValue(undefined);
const patch = vi.fn().mockResolvedValue(undefined);
const find = vi.fn();
const client = { service: () => ({ remove, patch, find }) } as unknown as AgorClient;

function tasks(count: number): Task[] {
  return Array.from(
    { length: count },
    (_, i) =>
      ({
        task_id: `queued-${i}`,
        session_id: session.session_id,
        full_prompt: `Prompt ${i + 1}: ${'long unbroken prompt '.repeat(20)}`,
        status: 'queued',
        queue_position: i,
      }) as Task
  );
}

function Harness({ count, failed = false }: { count: number; failed?: boolean }) {
  const [queue, setQueue] = useState(() => tasks(count));
  useEffect(() => setQueue(tasks(count)), [count]);
  return (
    <App>
      <AppActionsProvider value={{}}>
        <div
          data-testid="session-frame"
          style={{ height: 'calc(100dvh - 16px)', display: 'flex', flexDirection: 'column' }}
        >
          <header style={{ height: 48, flexShrink: 0 }}>Session header</header>
          <div
            data-testid="session-body"
            style={{ flex: 1, overflowY: 'auto', display: 'flex', flexDirection: 'column' }}
          >
            <div
              style={{
                flex: 1,
                minHeight: queue.length ? 'min(360px, 70dvh)' : 0,
                display: 'flex',
                flexDirection: 'column',
                overflow: 'hidden',
              }}
            >
              <SessionPanelContent
                client={client}
                session={failed ? { ...session, status: 'failed' } : session}
                queuedTasks={queue}
                setQueuedTasks={setQueue}
                scrollToBottom={null}
                scrollToTop={null}
                setScrollToBottom={noop}
                setScrollToTop={noop}
                spawnModalOpen={false}
                setSpawnModalOpen={noop}
                onSpawnModalConfirm={async () => {}}
                inputValueRef={{ current: '' }}
                isOpen
              />
            </div>
            <footer style={{ height: 96, flexShrink: 0 }}>
              <textarea aria-label="Prompt composer" />
              <button type="button">Send</button>
            </footer>
          </div>
        </div>
      </AppActionsProvider>
    </App>
  );
}

const conversation = () => screen.getByTestId('conversation-scroll-container');
const queueList = () => screen.getByRole('region', { name: 'Queued task list' });
const divider = () =>
  screen.getByRole('separator', { name: 'Resize conversation and queued tasks' });

async function expectBounded() {
  await waitFor(() => {
    const transcript = conversation().getBoundingClientRect();
    const queue = screen.getByRole('region', { name: 'Queued tasks' }).getBoundingClientRect();
    const available = transcript.height + queue.height;
    expect(transcript.height).toBeGreaterThanOrEqual(Math.min(240, available * 0.6) - 1);
    expect(queue.height).toBeLessThanOrEqual(available * 0.5 + 1);
    expect(queueList().clientHeight).toBeGreaterThan(15);
    expect(queue.bottom).toBeLessThanOrEqual(
      screen.getByRole('contentinfo').getBoundingClientRect().top + 1
    );
    const send = screen.getByRole('button', { name: 'Send' });
    send.scrollIntoView({ block: 'nearest' });
    expect(send.getBoundingClientRect().bottom).toBeLessThan(window.innerHeight);
    expect(screen.getByTestId('session-frame').scrollWidth).toBeLessThanOrEqual(window.innerWidth);
  });
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

it('bounds 30 queued tasks, independently scrolls to the last action, and keeps the header visible', async () => {
  render(<Harness count={30} />);
  await expectBounded();
  const headerTop = screen.getByText('Queued Tasks (30)').getBoundingClientRect().top;
  const transcript = conversation();
  await waitFor(() =>
    expect(
      Math.abs(transcript.scrollTop - (transcript.scrollHeight - transcript.clientHeight))
    ).toBeLessThanOrEqual(3)
  );
  const transcriptTop = transcript.scrollTop;
  const list = queueList();
  expect(list.scrollHeight).toBeGreaterThan(list.clientHeight * 3);
  act(() => list.focus());
  await userEvent.keyboard('{End}');
  await waitFor(() => {
    const last = screen
      .getByRole('button', { name: 'Remove queued task 30' })
      .getBoundingClientRect();
    expect(last.bottom).toBeLessThanOrEqual(list.getBoundingClientRect().bottom + 1);
    expect(last.top).toBeGreaterThanOrEqual(list.getBoundingClientRect().top);
  });
  expect(screen.getByText('Queued Tasks (30)').getBoundingClientRect().top).toBe(headerTop);
  expect(Math.abs(transcript.scrollTop - transcriptTop)).toBeLessThanOrEqual(3);
  await userEvent.click(screen.getByRole('button', { name: 'Copy queued task 30' }));
  expect(copyToClipboard).toHaveBeenCalledWith(tasks(30)[29].full_prompt);
  await userEvent.click(screen.getByRole('button', { name: 'Remove queued task 30' }));
  expect(remove).toHaveBeenCalledWith('queued-29');
  expect(screen.getByText('Queued Tasks (29)')).toBeVisible();
  await page.screenshot({
    path: `.vitest/attachments/session-queue-${window.innerWidth}x${window.innerHeight}.png`,
  });
});

it('supports keyboard and pointer resizing without sacrificing the conversation at either limit', async () => {
  render(<Harness count={25} />);
  await expectBounded();
  const handle = divider();
  expect(handle).toHaveAttribute('aria-orientation', 'horizontal');
  act(() => handle.focus());
  await userEvent.keyboard('{Home}');
  await expectBounded();
  const expandedQueue = queueList().clientHeight;
  await userEvent.keyboard('{End}');
  await expectBounded();
  expect(queueList().clientHeight).toBeLessThanOrEqual(expandedQueue);
  if (window.innerHeight > 500) expect(queueList().clientHeight).toBeLessThan(expandedQueue);
  await userEvent.dragAndDrop(handle, screen.getByRole('banner'));
  await expectBounded();
  if (window.innerHeight > 500) {
    await waitFor(() => expect(queueList().clientHeight).toBeGreaterThan(80));
  }
  // Container resize models panel/modal resize as well as changing viewport height.
  act(() => {
    screen.getByTestId('session-frame').style.height = '350px';
  });
  await expectBounded();
});

it('preserves the transcript across empty/small/large queue transitions and does not waste space on one row', async () => {
  const { rerender } = render(<Harness count={0} />);
  const transcript = conversation();
  expect(screen.queryByRole('region', { name: 'Queued tasks' })).toBeNull();
  rerender(<Harness count={1} />);
  await expectBounded();
  await waitFor(() =>
    expect(screen.getByRole('region', { name: 'Queued tasks' }).clientHeight).toBeLessThan(95)
  );
  rerender(<Harness count={30} />);
  await expectBounded();
  expect(conversation()).toBe(transcript);
  expect(screen.getAllByRole('button', { name: /^Copy queued task/ })).toHaveLength(30);
  rerender(<Harness count={2} />);
  await expectBounded();
  rerender(<Harness count={0} />);
  expect(
    screen.queryByRole('separator', { name: 'Resize conversation and queued tasks' })
  ).toBeNull();
  expect(conversation()).toBe(transcript);
  rerender(<Harness count={25} />);
  await expectBounded();
});

it('keeps failed-queue recovery and rollback actions reachable inside the bounded scroll area', async () => {
  render(<Harness count={25} failed />);
  await expectBounded();
  await userEvent.click(screen.getByRole('button', { name: 'Resume queue' }));
  expect(patch).toHaveBeenCalledWith(session.session_id, { ready_for_prompt: true });
  await userEvent.click(await screen.findByRole('button', { name: 'Run next' }));
  expect(patch).toHaveBeenCalledTimes(2);
  remove.mockRejectedValueOnce(new Error('Try again'));
  find.mockResolvedValueOnce({ data: tasks(25) });
  await userEvent.click(screen.getByRole('button', { name: 'Remove queued task 25' }));
  await waitFor(() => expect(find).toHaveBeenCalled());
  expect(screen.getByText('Queued Tasks (25)')).toBeVisible();
  expect(screen.getByRole('button', { name: 'Remove queued task 25' })).toBeInTheDocument();
});

it('keeps the real session body and composer reachable when chrome exhausts a short panel', async () => {
  const queueClient = {
    service: (path: string) => ({
      find: async () => ({ data: path.endsWith('/tasks/queue') ? tasks(30) : [] }),
      on: noop,
      off: noop,
      remove,
      patch,
    }),
  } as unknown as AgorClient;
  render(
    <App>
      <AppActionsProvider value={{}}>
        <div style={{ height: 350, maxWidth: 600 }}>
          <SessionPanel
            client={queueClient}
            session={{ ...session, status: 'failed' }}
            open
            onClose={noop}
          />
        </div>
      </AppActionsProvider>
    </App>
  );
  await screen.findByText('Queued Tasks (30)');
  await waitFor(() => {
    expect(conversation().clientHeight).toBeGreaterThan(100);
    expect(queueList().clientHeight).toBeGreaterThan(25);
  });
  const composer = screen.getByRole('textbox', { name: 'Prompt composer' });
  act(() => composer.focus());
  await waitFor(() => {
    const rect = composer.getBoundingClientRect();
    expect(rect.top).toBeGreaterThan(0);
    expect(rect.bottom).toBeLessThanOrEqual(350);
  });
  await userEvent.click(screen.getByRole('button', { name: 'Remove queued task 30' }));
  expect(remove).toHaveBeenCalledWith('queued-29');
  expect(screen.getByText('Queued Tasks (29)')).toBeVisible();
});
