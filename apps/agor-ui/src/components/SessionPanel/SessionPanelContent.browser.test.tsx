import type { AgorClient, Session, Task } from '@agor-live/client';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import type {} from '@vitest/browser-playwright';
import { App } from 'antd';
import { useEffect, useState } from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { cdp, page, userEvent } from 'vitest/browser';
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

function Harness({
  count,
  failed = false,
  height = 'calc(100dvh - 16px)',
}: {
  count: number;
  failed?: boolean;
  height?: number | string;
}) {
  const [queue, setQueue] = useState(() => tasks(count));
  useEffect(() => setQueue(tasks(count)), [count]);
  return (
    <App>
      <AppActionsProvider value={{}}>
        <div
          data-testid="session-frame"
          style={{ height, display: 'flex', flexDirection: 'column' }}
        >
          <header style={{ height: 48, flexShrink: 0 }}>Session header</header>
          <div
            data-testid="session-body"
            style={{ flex: 1, overflowY: 'auto', display: 'flex', flexDirection: 'column' }}
          >
            <div
              style={{
                flex: 1,
                minHeight: queue.length ? 360 : 0,
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
  expect(handle.getBoundingClientRect().height).toBe(4);
  act(() => handle.focus());
  await userEvent.keyboard('{Home}');
  expect(handle).toHaveFocus();
  expect(getComputedStyle(handle).outlineStyle).not.toBe('none');
  expect(parseFloat(getComputedStyle(handle).outlineWidth)).toBeGreaterThan(0);
  await expectBounded();
  const expandedQueue = queueList().clientHeight;
  await userEvent.keyboard('{End}');
  await expectBounded();
  expect(queueList().clientHeight).toBeLessThanOrEqual(expandedQueue);
  if (window.innerHeight > 500) expect(queueList().clientHeight).toBeLessThan(expandedQueue);
  // Start outside the visible 4px divider, inside the library's fine-pointer margin.
  await userEvent.dragAndDrop(handle, screen.getByRole('banner'), {
    sourcePosition: { x: handle.clientWidth / 2, y: -6 },
    force: true,
  });
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

const queueHeight = () => screen.getByRole('region', { name: 'Queued tasks' }).clientHeight;
const expectBottom = () =>
  waitFor(() => {
    const transcript = conversation();
    expect(
      Math.abs(transcript.scrollHeight - transcript.clientHeight - transcript.scrollTop)
    ).toBeLessThanOrEqual(3);
  });

it.each(['keyboard', 'pointer'])(
  'restores %s resize intent after 25 → 1 → 25, empty/refill, and viewport clamps',
  async (input) => {
    const { rerender } = render(<Harness count={25} height={700} />);
    await expectBottom();
    const transcript = conversation();
    if (input === 'keyboard') {
      act(() => divider().focus());
      await act(() => userEvent.keyboard('{Home}{ArrowDown}'));
    } else {
      await act(() => userEvent.dragAndDrop(divider(), screen.getByRole('banner')));
    }
    const desired = queueHeight();
    expect(desired).toBeGreaterThan(190);
    for (const count of [1, 25, 0, 25]) {
      rerender(<Harness count={count} height={700} />);
      await waitFor(() => {
        if (count === 1) expect(queueHeight()).toBeLessThan(95);
        if (count === 25) expect(Math.abs(queueHeight() - desired)).toBeLessThanOrEqual(1);
        if (count === 0) expect(screen.queryByRole('region', { name: 'Queued tasks' })).toBeNull();
      });
      expect(conversation()).toBe(transcript);
      await expectBottom();
    }
    rerender(<Harness count={25} height={350} />);
    await waitFor(() => expect(queueHeight()).toBeLessThan(desired - 30));
    await expectBottom();
    rerender(<Harness count={25} height={700} />);
    await waitFor(() => expect(Math.abs(queueHeight() - desired)).toBeLessThanOrEqual(1));
    await expectBottom();
    // A subsequent intentional resize replaces the remembered expansion.
    act(() => divider().focus());
    await act(() => userEvent.keyboard('{End}'));
    await waitFor(() => expect(queueHeight()).toBe(80));
    rerender(<Harness count={1} height={700} />);
    await waitFor(() => expect(queueHeight()).toBeLessThan(80));
    rerender(<Harness count={25} height={700} />);
    await waitFor(() => expect(queueHeight()).toBe(80));
    await expectBottom();
  }
);

it('grows one row to two without clipping and preserves a scrolled-up reader through queue transitions', async () => {
  const { rerender } = render(<Harness count={1} height={700} />);
  await waitFor(() => expect(queueHeight()).toBeLessThan(95));
  await expectBottom();
  const transcript = conversation();
  await userEvent.wheel(transcript, { delta: { y: -500 } });
  await waitFor(() => expect(transcript.scrollTop).toBeLessThan(700));
  // Let native wheel scrolling settle before capturing the reader's position.
  await new Promise((resolve) => setTimeout(resolve, 200));
  const readerTop = transcript.scrollTop;
  for (const count of [2, 25, 1, 0, 25]) {
    rerender(<Harness count={count} height={700} />);
    await waitFor(() => {
      if (count)
        expect(screen.getAllByRole('button', { name: /^Copy queued task/ })).toHaveLength(count);
      else expect(screen.queryByRole('region', { name: 'Queued tasks' })).toBeNull();
    });
    if (count === 2) {
      await waitFor(() =>
        expect(queueList().scrollHeight - queueList().clientHeight).toBeLessThanOrEqual(1)
      );
    }
    // Wait beyond ResizeObserver / stick-to-bottom's animation frames, not just React's commit.
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(conversation()).toBe(transcript);
    expect(Math.abs(transcript.scrollTop - readerTop)).toBeLessThanOrEqual(3);
  }
});

it('refreshes separator bounds on a constraint-only resize without remounting the transcript', async () => {
  const { rerender } = render(<Harness count={25} height={700} />);
  await expectBottom();
  const transcript = conversation();
  const oldMaximum = divider().getAttribute('aria-valuemax');
  const proportions = divider().getAttribute('aria-valuenow');
  rerender(<Harness count={25} height={500} />);
  await waitFor(() => {
    const available = transcript.clientHeight + queueHeight();
    expect(divider()).toHaveAttribute('aria-valuemax', String(Math.round(100 - 8000 / available)));
    expect(divider()).toHaveAttribute(
      'aria-valuemin',
      String(Math.round(Math.max(50, Math.min(240 / available, 0.6) * 100)))
    );
    expect(divider().getAttribute('aria-valuemax')).not.toBe(oldMaximum);
    expect(divider()).toHaveAttribute('aria-valuenow', proportions);
  });
  expect(conversation()).toBe(transcript);
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

it.each([390, 220])(
  'keeps the real multiline composer reachable by wheel and keyboard in a %ipx panel',
  async (height) => {
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
          <div style={{ position: 'fixed', top: 0, left: 0, height, width: '100%', maxWidth: 600 }}>
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
    const composer = screen.getByPlaceholderText('Prompt here… @ for mentions, : for emoji');
    // Position the pointer once. userEvent.wheel() re-hovers before every input,
    // scrolling the queue back into view and potentially undoing outer scrolling.
    // Keep native wheel input at that point while observing asynchronous scrolling;
    // never focus or scrollIntoView the composer to satisfy reachability.
    const wheelToComposer = async () => {
      await userEvent.hover(queueList());
      const rect = queueList().getBoundingClientRect();
      const frame = window.frameElement?.getBoundingClientRect();
      const x = (frame?.left ?? 0) + rect.left + rect.width / 2;
      const y = (frame?.top ?? 0) + rect.top + rect.height / 2;
      await waitFor(
        async () => {
          await act(() =>
            cdp().send('Input.dispatchMouseEvent', {
              type: 'mouseWheel',
              x,
              y,
              deltaX: 0,
              deltaY: 5000,
            })
          );
          await waitFor(
            () => {
              const rect = composer.getBoundingClientRect();
              expect(rect.top).toBeGreaterThan(0);
              expect(rect.bottom).toBeLessThanOrEqual(height);
            },
            { timeout: 200 }
          );
        },
        { interval: 200, timeout: 3000 }
      );
    };
    await act(() => userEvent.wheel(queueList(), { delta: { y: 5000 } }));
    await waitFor(() =>
      expect(
        queueList().scrollHeight - queueList().clientHeight - queueList().scrollTop
      ).toBeLessThanOrEqual(1)
    );
    await wheelToComposer();
    await userEvent.fill(composer, 'First line\nSecond line\nThird line');
    await waitFor(() => expect(composer.clientHeight).toBeGreaterThan(60));
    await userEvent.keyboard('{Shift>}{Tab}{/Shift}{Tab}');
    expect(composer).toHaveFocus();
    expect(composer).toHaveValue('First line\nSecond line\nThird line');
    await waitFor(() => {
      const rect = composer.getBoundingClientRect();
      expect(rect.top).toBeGreaterThan(0);
      expect(rect.bottom).toBeLessThanOrEqual(height);
    });
    // Repeat outer wheel reachability with the expanded draft, without focus
    // helping the browser bring the textarea back into view.
    act(() => composer.blur());
    await wheelToComposer();
    expect(composer).toHaveValue('First line\nSecond line\nThird line');
    expect(conversation().clientHeight).toBeGreaterThan(100);
    expect(queueList().clientHeight).toBeGreaterThan(60);
    await page.screenshot({
      path: `.vitest/attachments/session-composer-${window.innerWidth}x${window.innerHeight}-${height}.png`,
    });
  }
);
