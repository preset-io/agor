import type { AgorClient, Session, Task } from '@agor-live/client';
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react';
import type {} from '@vitest/browser-playwright';
import { App } from 'antd';
import { useEffect, useState } from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { cdp, page, userEvent } from 'vitest/browser';
import { AppActionsProvider } from '../../contexts/AppActionsContext';
import { isMobileViewport } from '../../utils/deviceDetection';
import SessionPanel from './SessionPanel';

// Keep the actual SessionPanel layout: the ConversationView scroll owner above,
// and the queue folded above the composer card. Only the reactive data feed and
// expensive transcript rows are replaced with deterministic data.
const queueFeed = vi.hoisted(() => ({ tasks: [] as Task[] }));
vi.mock('../../hooks/useSharedReactiveSession', () => ({
  useSharedReactiveSession: () => ({
    handle: null,
    state: {
      sessionId: 'session-1',
      queuedTasks: queueFeed.tasks,
      tasks: Array.from({ length: 20 }, (_, i) => ({
        task_id: `history-${i}`,
        status: 'completed',
      })),
      loading: false,
      messagesByTask: new Map(),
      loadedTaskIds: new Set(),
      streamingMessages: new Map(),
      toolsByTask: new Map(),
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
const removedListeners = new Set<(id: string) => void>();
const remove = vi.fn(async (id: string) => {
  for (const listener of removedListeners) listener(id);
});
const patch = vi.fn().mockResolvedValue(undefined);
const client = {
  io: { on: noop, off: noop },
  service: (path: string) => ({
    find: async () => ({ data: path.endsWith('/tasks/queue') ? queueFeed.tasks : [] }),
    get: async () => session,
    on: noop,
    off: noop,
    remove,
    patch,
  }),
} as unknown as AgorClient;

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
  useEffect(() => {
    const onRemoved = (id: string) =>
      setQueue((prev) => prev.filter((task) => task.task_id !== id));
    removedListeners.add(onRemoved);
    return () => {
      removedListeners.delete(onRemoved);
    };
  }, []);
  // The mocked reactive session reads the feed on each panel render.
  queueFeed.tasks = queue;
  const status = failed ? 'failed' : session.status;
  return (
    <App>
      <AppActionsProvider value={{}}>
        <div data-testid="session-frame" style={{ height, display: 'flex' }}>
          {/* A fresh session object re-renders the memoized panel with the new feed. */}
          <SessionPanel client={client} session={{ ...session, status }} open onClose={noop} />
        </div>
      </AppActionsProvider>
    </App>
  );
}

const conversation = () => screen.getByTestId('conversation-scroll-container');
const queueSection = () => screen.getByRole('region', { name: 'Queued messages' });
const queueList = () => within(queueSection()).getByRole('list');
const queueHeader = (count: number) =>
  screen.getByRole('button', { name: new RegExp(`^${count} queued\\b`) });
const card = () => screen.getByTestId('composer-card');

/** Unfolds the "{n} queued" header above the composer. */
async function expandQueue(count: number) {
  const header = await screen.findByRole('button', {
    name: new RegExp(`^${count} queued\\b`),
  });
  if (header.getAttribute('aria-expanded') !== 'true') await userEvent.click(header);
  await waitFor(() => expect(header).toHaveAttribute('aria-expanded', 'true'));
  return header;
}

// Opening a conversation also requests a spring scroll, which takes nearly 1s
// to settle even without CI frame delays. Keep the pixel tolerance strict, but
// allow the real animation to finish rather than racing waitFor's 1s default.
const expectBottom = () =>
  waitFor(
    () => {
      const transcript = conversation();
      expect(
        Math.abs(transcript.scrollHeight - transcript.clientHeight - transcript.scrollTop)
      ).toBeLessThanOrEqual(3);
    },
    { timeout: 5000 }
  );

// The expanded list is capped at 40vh, or 25dvh on phones so the composer stays in view.
const queueCap = () => window.innerHeight * (isMobileViewport() ? 0.25 : 0.4);

// The expanded queue scrolls inside its own bounded list, sits above the
// composer card, and never pushes the composer out of reach or the panel wider.
async function expectBounded() {
  await waitFor(() => {
    const list = queueList();
    expect(list.clientHeight).toBeGreaterThan(15);
    expect(list.clientHeight).toBeLessThanOrEqual(queueCap() + 1);
    expect(queueSection().getBoundingClientRect().bottom).toBeLessThanOrEqual(
      card().getBoundingClientRect().top + 1
    );
    expect(conversation().clientHeight).toBeGreaterThan(100);
    const circle = screen.getByTestId('composer-circle');
    circle.scrollIntoView({ block: 'nearest' });
    expect(circle.getBoundingClientRect().bottom).toBeLessThan(window.innerHeight);
    expect(screen.getByTestId('session-frame').scrollWidth).toBeLessThanOrEqual(window.innerWidth);
  });
}

afterEach(() => {
  cleanup();
  queueFeed.tasks = [];
  vi.clearAllMocks();
});

it('bounds 30 queued tasks, independently scrolls to the last action, and keeps the header visible', async () => {
  render(<Harness count={30} />);
  const header = await expandQueue(30);
  await expectBounded();
  const headerTop = header.getBoundingClientRect().top;
  const transcript = conversation();
  await expectBottom();
  const transcriptTop = transcript.scrollTop;
  const list = queueList();
  expect(list.scrollHeight).toBeGreaterThan(list.clientHeight * 3);
  await userEvent.wheel(list, { delta: { y: 20_000 } });
  await waitFor(() => {
    const last = screen
      .getByRole('button', { name: 'Remove from queue, message 30' })
      .getBoundingClientRect();
    expect(last.bottom).toBeLessThanOrEqual(list.getBoundingClientRect().bottom + 1);
    expect(last.top).toBeGreaterThanOrEqual(list.getBoundingClientRect().top);
  });
  expect(header.getBoundingClientRect().top).toBe(headerTop);
  expect(Math.abs(transcript.scrollTop - transcriptTop)).toBeLessThanOrEqual(3);
  await userEvent.click(screen.getByRole('button', { name: 'More actions, message 30' }));
  await userEvent.click(
    within(await screen.findByRole('dialog', { name: 'Message 30' })).getByRole('button', {
      name: 'Copy, message 30',
    })
  );
  expect(copyToClipboard).toHaveBeenCalledWith(tasks(30)[29].full_prompt);
  await userEvent.click(screen.getByRole('button', { name: 'Remove from queue, message 30' }));
  expect(remove).toHaveBeenCalledWith('queued-29');
  await waitFor(() => expect(queueHeader(29)).toBeVisible());
  await page.screenshot({
    path: `.vitest/attachments/session-queue-${window.innerWidth}x${window.innerHeight}.png`,
  });
});

it('grows one row to two without clipping and preserves a scrolled-up reader through queue transitions', async () => {
  const { rerender } = render(<Harness count={1} height={700} />);
  await expandQueue(1);
  await waitFor(() =>
    expect(queueList().scrollHeight - queueList().clientHeight).toBeLessThanOrEqual(1)
  );
  await expectBottom();
  const transcript = conversation();
  await userEvent.wheel(transcript, { delta: { y: -500 } });
  await waitFor(() =>
    expect(transcript.scrollTop).toBeLessThan(
      transcript.scrollHeight - transcript.clientHeight - 100
    )
  );
  // Let native wheel scrolling settle before capturing the reader's position.
  await new Promise((resolve) => setTimeout(resolve, 200));
  const readerTop = transcript.scrollTop;
  for (const count of [2, 25, 1, 0, 25]) {
    rerender(<Harness count={count} height={700} />);
    await waitFor(() => {
      if (count) {
        expect(screen.getAllByRole('button', { name: /^Remove from queue, message/ })).toHaveLength(
          count
        );
      } else {
        expect(screen.queryByRole('region', { name: 'Queued messages' })).toBeNull();
      }
    });
    if (count === 2) {
      // Two rows fit without an inner scrollbar unless they reach the list cap,
      // as two wrapped phone rows do on short screens.
      await waitFor(() => {
        const list = queueList();
        if (list.clientHeight < Math.floor(queueCap()) - 1) {
          expect(list.scrollHeight - list.clientHeight).toBeLessThanOrEqual(1);
        }
      });
    }
    // Wait beyond ResizeObserver / stick-to-bottom's animation frames, not just React's commit.
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(conversation()).toBe(transcript);
    expect(Math.abs(transcript.scrollTop - readerTop)).toBeLessThanOrEqual(3);
  }
});

// Exercise each recovery entry point on a fresh failed queue. Resuming twice in
// one fixture races the shared loading icon's exit motion and accessible name.
it.each(['Resume queue', 'Run next'])(
  'keeps failed-queue recovery via %s and rollback actions reachable inside the bounded scroll area',
  async (recoveryAction) => {
    render(<Harness count={25} failed />);
    await expandQueue(25);
    expect(screen.getByText('Queue paused by failed session')).toBeVisible();
    await expectBounded();
    const recovery = screen.getByRole('button', { name: recoveryAction });
    // Run next sits on the queue head, the next prompt to run.
    if (recoveryAction === 'Run next')
      expect(recovery.closest('li')).toHaveTextContent('Prompt 1:');
    await userEvent.click(recovery);
    expect(patch).toHaveBeenCalledExactlyOnceWith(session.session_id, { ready_for_prompt: true });
    remove.mockRejectedValueOnce(new Error('Try again'));
    await userEvent.click(screen.getByRole('button', { name: 'Remove from queue, message 25' }));
    await screen.findByText("Couldn't remove the queued message. (Try again)");
    expect(queueHeader(25)).toBeVisible();
    expect(
      screen.getByRole('button', { name: 'Remove from queue, message 25' })
    ).toBeInTheDocument();
  }
);

it.each([390, 220])(
  'keeps the real multiline composer reachable by wheel and keyboard in a %ipx panel',
  async (height) => {
    queueFeed.tasks = tasks(30);
    render(
      <App>
        <AppActionsProvider value={{}}>
          <div style={{ position: 'fixed', top: 0, left: 0, height, width: '100%', maxWidth: 600 }}>
            <SessionPanel
              client={client}
              session={{ ...session, status: 'failed' }}
              open
              onClose={noop}
            />
          </div>
        </AppActionsProvider>
      </App>
    );
    await expandQueue(30);
    await waitFor(() => {
      expect(conversation().clientHeight).toBeGreaterThan(100);
      expect(queueList().clientHeight).toBeGreaterThan(25);
    });
    const composer = screen.getByPlaceholderText(/^Prompt here…/);
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
              // The whole card, and the status row above it, fit in the panel too.
              const card = screen.getByTestId('composer-card').getBoundingClientRect();
              const row = screen.getByTestId('composer-status-row').getBoundingClientRect();
              expect(row.top).toBeGreaterThanOrEqual(0);
              expect(row.bottom).toBeLessThanOrEqual(card.top);
              expect(card.bottom).toBeLessThanOrEqual(height);
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
    // Keyboard: after the queue's last control come the status row's controls
    // (Stop and the info), then the composer, in visual order.
    // (Phones fold the queue while the text field has focus, so it unfolds
    // again once focus leaves the composer.)
    act(() => composer.blur());
    const lastRemove = await screen.findByRole('button', {
      name: 'Remove from queue, message 30',
    });
    const statusRow = screen.getByTestId('composer-status-row');
    act(() => lastRemove.focus());
    for (let stop = 0; stop < 10 && document.activeElement !== composer; stop++) {
      await userEvent.keyboard('{Tab}');
      if (document.activeElement !== composer) {
        expect(statusRow).toContainElement(document.activeElement as HTMLElement);
      }
    }
    expect(composer).toHaveFocus();
    expect(composer).toHaveValue('First line\nSecond line\nThird line');
    await waitFor(() => {
      const rect = composer.getBoundingClientRect();
      expect(rect.top).toBeGreaterThan(0);
      expect(rect.bottom).toBeLessThanOrEqual(height);
    });
    // Repeat outer wheel reachability with the expanded draft, without focus
    // helping the browser bring the textarea back into view. Phones fold the
    // queue while the composer has focus, so wait for it to unfold again.
    act(() => composer.blur());
    await waitFor(() => expect(queueList().clientHeight).toBeGreaterThan(25));
    await wheelToComposer();
    expect(composer).toHaveValue('First line\nSecond line\nThird line');
    expect(conversation().clientHeight).toBeGreaterThan(100);
    expect(queueList().clientHeight).toBeGreaterThan(60);
    await page.screenshot({
      path: `.vitest/attachments/session-composer-${window.innerWidth}x${window.innerHeight}-${height}.png`,
    });
  }
);
