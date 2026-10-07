import type { AgorClient, MCPServer, Session, Task } from '@agor-live/client';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type {} from '@vitest/browser-playwright';
import { App } from 'antd';
import { useEffect, useState } from 'react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { page, userEvent } from 'vitest/browser';
import { AppActionsProvider } from '../../contexts/AppActionsContext';
import { ConnectionProvider } from '../../contexts/ConnectionContext';
import { agorStore } from '../../store/agorStore';
import { checkBrowserSanity } from '../../test/browserSanity';
import { CompactNotice } from '../CompactNotice';
import SessionPanel from './SessionPanel';
import { SessionPanelContent } from './SessionPanelContent';

// Keep the actual ConversationView scroll owner and split/queue UI. Only its
// data feed and expensive transcript rows are replaced with deterministic data.
const queueFeed = vi.hoisted(() => ({ tasks: [] as Task[], deepNotice: false }));
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
  TaskBlock: ({ task }: { task: Task }) => (
    <div style={{ minHeight: 60 }}>
      {queueFeed.deepNotice && task.task_id === 'history-0' && (
        <>
          <div style={{ height: 4400 }} />
          <CompactNotice
            data-testid="deep-notice"
            type="neutral"
            message="Retained tool notice"
            details={[{ label: 'Output', value: 'Expanded output\n'.repeat(90) }]}
          />
          <div style={{ height: 2257 }} />
        </>
      )}
      Transcript {task.task_id}
      <details>
        <summary>Expand {task.task_id}</summary>
        <div style={{ height: 1200 }}>Expanded tool output</div>
      </details>
    </div>
  ),
}));
vi.mock('../ForkSpawnModal', () => ({ ForkSpawnModal: () => null }));
vi.mock('../../utils/clipboard', () => ({
  copyToClipboard: vi.fn().mockResolvedValue(true),
  useCopyToClipboard: () => [false, vi.fn()],
}));

import { copyToClipboard } from '../../utils/clipboard';

const originalMcpServers = agorStore.getState().mcpServerById;
const originalViewport = { width: window.innerWidth, height: window.innerHeight };
beforeEach(async () => {
  localStorage.clear();
  if (originalViewport.width === 1000) await page.viewport(1280, 900);
});

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
  useEffect(() => {
    const onRemoved = (id: string) =>
      setQueue((prev) => prev.filter((task) => task.task_id !== id));
    removedListeners.add(onRemoved);
    return () => {
      removedListeners.delete(onRemoved);
    };
  }, []);
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
            style={{
              flex: 1,
              minHeight: 0,
              overflow: 'hidden',
              display: 'flex',
              flexDirection: 'column',
            }}
          >
            <div
              style={{
                flex: 1,
                minHeight: 0,
                display: 'flex',
                flexDirection: 'column',
                overflow: 'hidden',
              }}
            >
              <SessionPanelContent
                client={client}
                session={failed ? { ...session, status: 'failed' } : session}
                queuedTasks={queue}
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

afterEach(async () => {
  cleanup();
  agorStore.setState({ mcpServerById: originalMcpServers });
  await page.viewport(originalViewport.width, originalViewport.height);
  queueFeed.tasks = [];
  queueFeed.deepNotice = false;
  vi.clearAllMocks();
});

it('bounds 30 queued tasks, independently scrolls to the last action, and keeps the header visible', async () => {
  render(<Harness count={30} />);
  await expectBounded();
  const headerTop = screen.getByText('Queued tasks (30)').getBoundingClientRect().top;
  const transcript = conversation();
  await expectBottom();
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
  expect(screen.getByText('Queued tasks (30)').getBoundingClientRect().top).toBe(headerTop);
  expect(Math.abs(transcript.scrollTop - transcriptTop)).toBeLessThanOrEqual(3);
  await userEvent.click(screen.getByRole('button', { name: 'Copy queued task 30' }));
  expect(copyToClipboard).toHaveBeenCalledWith(tasks(30)[29].full_prompt);
  await userEvent.click(screen.getByRole('button', { name: 'Remove queued task 30' }));
  expect(remove).toHaveBeenCalledWith('queued-29');
  expect(screen.getByText('Queued tasks (29)')).toBeVisible();
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

// A restored percentage can produce the expected height before ResizeObserver
// has committed the new pixel-derived constraints. Do not send the next resize
// key until the separator exposes bounds for the current viewport.
const expectCurrentResizeBounds = () =>
  waitFor(() => {
    const available = conversation().clientHeight + queueHeight();
    expect(divider()).toHaveAttribute('aria-valuemax', String(Math.round(100 - 8000 / available)));
    expect(divider()).toHaveAttribute(
      'aria-valuemin',
      String(Math.round(Math.max(50, Math.min(240 / available, 0.6) * 100)))
    );
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
    await expectCurrentResizeBounds();
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
  await expectCurrentResizeBounds();
  await waitFor(() => {
    expect(divider().getAttribute('aria-valuemax')).not.toBe(oldMaximum);
    expect(divider()).toHaveAttribute('aria-valuenow', proportions);
  });
  expect(conversation()).toBe(transcript);
});

// Exercise each recovery entry point on a fresh failed queue. Resuming twice in
// one fixture races the shared loading icon's exit motion and accessible name.
it.each(['Resume queue', 'Run next'])(
  'keeps failed-queue recovery via %s and rollback actions reachable inside the bounded scroll area',
  async (recoveryAction) => {
    render(<Harness count={25} failed />);
    await expectBounded();
    await userEvent.click(screen.getByRole('button', { name: recoveryAction }));
    expect(patch).toHaveBeenCalledExactlyOnceWith(session.session_id, { ready_for_prompt: true });
    remove.mockRejectedValueOnce(new Error('Try again'));
    await userEvent.click(screen.getByRole('button', { name: 'Remove queued task 25' }));
    await screen.findByText('Failed to remove queued task: Try again');
    expect(find).not.toHaveBeenCalled();
    expect(screen.getByText('Queued tasks (25)')).toBeVisible();
    expect(screen.getByRole('button', { name: 'Remove queued task 25' })).toBeInTheDocument();
  }
);

// Exercise the real panel, conversation scroll owner, queue split, and autosizing
// composer. The old body scrollbar / 360px conversation floor failed this
// contract even when the composer itself fit in the viewport.
checkBrowserSanity();
it.each([0, 30])(
  'pins chrome with %i queued tasks through growth and completion',
  async (count) => {
    queueFeed.tasks = tasks(count);
    const queueClient = {
      io: { on: noop, off: noop },
      service: (path: string) => ({
        find: async () => ({ data: path.endsWith('/tasks/queue') ? tasks(count) : [] }),
        get: async () => session,
        on: noop,
        off: noop,
        remove,
        patch,
      }),
    } as unknown as AgorClient;
    const panel = (status: Session['status']) => (
      <App>
        <AppActionsProvider value={{}}>
          <div data-testid="real-panel" style={{ position: 'fixed', inset: 0, maxWidth: 600 }}>
            <SessionPanel
              client={queueClient}
              session={{ ...session, status }}
              open
              onClose={noop}
            />
          </div>
        </AppActionsProvider>
      </App>
    );
    const view = render(panel('running'));
    const transcript = await screen.findByTestId('conversation-scroll-container');
    const composer = screen.getByPlaceholderText('Queue here… @ for mentions, : for emoji');
    const root = screen.getByTestId('real-panel').firstElementChild as HTMLElement;
    const header = root.firstElementChild as HTMLElement;
    const body = header.nextElementSibling as HTMLElement;
    const send = screen.getByRole('button', { name: 'Send' });
    const assertLayout = () => {
      const bounds = root.getBoundingClientRect();
      const input = composer.getBoundingClientRect();
      const button = send.getBoundingClientRect();
      expect(header.getBoundingClientRect().top).toBe(bounds.top);
      expect(input.top).toBeGreaterThanOrEqual(header.getBoundingClientRect().bottom);
      expect(button.bottom).toBeLessThanOrEqual(bounds.bottom);
      expect(bounds.bottom - button.bottom).toBeLessThan(24);
      expect(transcript.clientHeight).toBeGreaterThan(0);
      expect(transcript.getBoundingClientRect().bottom).toBeLessThanOrEqual(input.top);
      for (const container of [body, root, document.documentElement]) {
        expect(container.scrollHeight - container.clientHeight).toBeLessThanOrEqual(1);
        container.scrollTop = 10000;
        expect(container.scrollTop).toBe(0);
      }
    };
    await waitFor(assertLayout);
    await expectBottom();
    const headerTop = header.getBoundingClientRect().top;
    const sendBottom = send.getBoundingClientRect().bottom;
    await userEvent.wheel(transcript, { delta: { y: -10000 } });
    await waitFor(() => expect(transcript.scrollTop).toBe(0));
    await userEvent.click(screen.getByText('Expand history-0'));
    await waitFor(assertLayout);
    await userEvent.wheel(transcript, { delta: { y: 10000 } });
    await waitFor(() => expect(transcript.scrollTop).toBeGreaterThan(0));
    expect(header.getBoundingClientRect().top).toBe(headerTop);
    expect(send.getBoundingClientRect().bottom).toBe(sendBottom);
    if (count) {
      await userEvent.wheel(queueList(), { delta: { y: 10000 } });
      await waitFor(() => expect(queueList().scrollTop).toBeGreaterThan(0));
      await waitFor(assertLayout);
    }
    const inputHeight = composer.clientHeight;
    await userEvent.fill(composer, 'First line\nSecond line\nThird line');
    await waitFor(() => expect(composer.clientHeight).toBeGreaterThan(inputHeight));
    await waitFor(assertLayout);
    // Hit the existing textarea row cap, then resize a desktop panel short.
    const longDraft = Array.from({ length: 20 }, (_, i) => `Draft line ${i + 1}`).join('\n');
    await userEvent.fill(composer, longDraft);
    await waitFor(assertLayout);
    if (window.innerWidth >= 1024) {
      await page.viewport(window.innerWidth, 390);
      await waitFor(assertLayout);
    }
    await userEvent.keyboard('{Shift>}{Tab}{/Shift}{Tab}');
    expect(composer).toHaveFocus();
    view.rerender(panel('completed'));
    await waitFor(assertLayout);
    expect(conversation()).toBe(transcript);
    expect(composer).toHaveValue(longDraft);
    expect(screen.queryByRole('button', { name: 'Stop' })).toBeNull();
    await page.screenshot({
      path: `.vitest/attachments/session-contained-${window.innerWidth}x${window.innerHeight}-${count}.png`,
    });
  }
);

it('keeps ten attachments and notices independently scrollable beside a multiline draft', async () => {
  const mcpServer = {
    mcp_server_id: 'disconnected-server',
    name: 'example-mcp',
    display_name: 'Example MCP',
    auth: { type: 'oauth' },
    transport: 'http',
    enabled: true,
    scope: 'session',
  } as MCPServer;
  agorStore.setState({ mcpServerById: new Map([[mcpServer.mcp_server_id, mcpServer]]) });
  const mcpIds = [mcpServer.mcp_server_id];
  const attachmentClient = {
    io: { on: noop, off: noop },
    service: () => ({
      find: async () => ({ data: [] }),
      get: async () => session,
      on: noop,
      off: noop,
    }),
  } as unknown as AgorClient;
  const panel = (status: Session['status']) => (
    <App>
      <ConnectionProvider
        value={{
          connected: true,
          connecting: false,
          authGeneration: 1,
          outOfSync: false,
          capturedSha: null,
          currentSha: null,
        }}
      >
        <AppActionsProvider value={{}}>
          <div
            data-testid="attachment-panel"
            style={{ position: 'fixed', inset: 0, maxWidth: 600 }}
          >
            <SessionPanel
              client={attachmentClient}
              session={{ ...session, status }}
              sessionMcpServerIds={mcpIds}
              open
              onClose={noop}
            />
          </div>
        </AppActionsProvider>
      </ConnectionProvider>
    </App>
  );
  const view = render(panel('running'));
  const root = screen.getByTestId('attachment-panel').firstElementChild as HTMLElement;
  const body = root.children[1] as HTMLElement;
  await screen.findByTestId('mcp-disconnected-notice');
  const composer = screen.getByPlaceholderText('Queue here… @ for mentions, : for emoji');
  const input = root.querySelector('input[type="file"]')!;
  const files = Array.from(
    { length: 10 },
    (_, i) => new File(['attachment'], `attachment-${i}.txt`, { type: 'text/plain' })
  );
  fireEvent.change(input, { target: { files } });
  await screen.findByRole('button', { name: 'Remove attachment-9.txt' });
  // The supported limit rejects an eleventh file, leaving ten pending tiles
  // and the real validation notice in place. No daemon upload is needed.
  fireEvent.change(input, { target: { files: [new File(['extra'], 'extra.txt')] } });
  await screen.findAllByText(/Composer supports up to 10 pending files/);
  const draft = Array.from({ length: 20 }, (_, i) => `Draft line ${i + 1}`).join('\n');
  await userEvent.fill(composer, draft);
  const assertControls = () => {
    const bounds = root.getBoundingClientRect();
    for (const control of [
      composer,
      screen.getByRole('button', {
        name: screen.queryByRole('button', { name: 'Stop' }) ? 'Queue' : 'Send',
      }),
      ...(screen.queryByRole('button', { name: 'Stop' })
        ? [screen.getByRole('button', { name: 'Stop' })]
        : []),
    ]) {
      const rect = control.getBoundingClientRect();
      expect(
        rect.bottom,
        `${control.getAttribute('aria-label') ?? 'textarea'} bottom`
      ).toBeLessThanOrEqual(bounds.bottom);
      expect(rect.left).toBeGreaterThanOrEqual(bounds.left);
      expect(rect.right).toBeLessThanOrEqual(bounds.right);
      expect(control).not.toBeDisabled();
      expect(rect.top).toBeGreaterThanOrEqual(
        (root.firstElementChild as HTMLElement).getBoundingClientRect().bottom
      );
      const hit = document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2);
      expect(hit && control.contains(hit), 'control can be hit without outer scrolling').toBe(true);
    }
    expect(conversation().clientHeight).toBeGreaterThan(0);
    for (const container of [root, body]) {
      expect(container.scrollHeight - container.clientHeight).toBeLessThanOrEqual(1);
      container.scrollTop = 10000;
      expect(container.scrollTop).toBe(0);
    }
  };
  await page.screenshot({
    path: `.vitest/attachments/oversized-composer-${window.innerWidth}x${window.innerHeight}.png`,
  });
  await waitFor(assertControls);
  expect(composer.scrollHeight).toBeGreaterThan(composer.clientHeight);
  const extras = screen.getByRole('region', { name: 'Composer attachments and notices' });
  if (window.innerWidth <= 320) expect(extras.scrollHeight).toBeGreaterThan(extras.clientHeight);
  const transcript = conversation();
  const headerTop = root.firstElementChild!.getBoundingClientRect().top;
  const pinnedBottom = composer.getBoundingClientRect().bottom;
  await userEvent.wheel(extras, { delta: { y: 10000 } });
  if (extras.scrollHeight > extras.clientHeight) {
    await waitFor(() => expect(extras.scrollTop).toBeGreaterThan(0));
  }
  const removeLast = screen.getByRole('button', { name: 'Remove attachment-9.txt' });
  removeLast.focus();
  await waitFor(() => {
    const rect = removeLast.getBoundingClientRect();
    const hit = document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2);
    expect(hit && removeLast.contains(hit)).toBe(true);
  });
  expect(composer.getBoundingClientRect().bottom).toBe(pinnedBottom);
  expect(root.firstElementChild!.getBoundingClientRect().top).toBe(headerTop);
  await waitFor(assertControls);
  await userEvent.wheel(extras, { delta: { y: -10000 } });
  await waitFor(() => expect(extras.scrollTop).toBe(0));
  expect(
    screen.getByTestId('mcp-disconnected-notice').getBoundingClientRect().top
  ).toBeGreaterThanOrEqual(extras.getBoundingClientRect().top);
  await page.viewport(window.innerWidth, 390);
  await waitFor(assertControls);
  // Resize the panel independently of the viewport (desktop action rows wrap).
  screen.getByTestId('attachment-panel').style.maxWidth = '280px';
  await waitFor(assertControls);
  await userEvent.click(removeLast);
  expect(screen.queryByRole('button', { name: 'Remove attachment-9.txt' })).toBeNull();
  expect(screen.getAllByRole('button', { name: /^Remove attachment-/ })).toHaveLength(9);
  await waitFor(assertControls);
  // Both the pinned input and the independently scrolled tray remain drop
  // targets after splitting their layout ownership.
  const replacementDrop = new DataTransfer();
  replacementDrop.items.add(new File(['replacement'], 'replacement.txt'));
  fireEvent(
    screen.getByLabelText('Composer attachment drop zone'),
    new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: replacementDrop })
  );
  await screen.findByRole('button', { name: 'Remove replacement.txt' });
  expect(screen.getAllByRole('button', { name: /^Remove (attachment-|replacement)/ })).toHaveLength(
    10
  );
  expect(screen.getByLabelText('Composer attachments and input drop zone')).toContainElement(
    composer
  );
  view.rerender(panel('completed'));
  await waitFor(assertControls);
  expect(conversation()).toBe(transcript);
  expect(screen.getByPlaceholderText('Prompt here… @ for mentions, : for emoji')).toBe(composer);
  expect(composer).toHaveValue(draft);
  expect(screen.queryByRole('button', { name: 'Stop' })).toBeNull();
});

// Exercise the real CompactNotice inside an already-scrolled ConversationView.
// The auto variant restores the old outer-scroll boundary in this isolated
// fixture, proving local containment fixes geometry rather than masking wheel.
it.each(['hidden', 'auto'] as const)(
  'contains a deep aria-live notice with outer overflow %s through scrolling and lifecycle',
  async (overflow) => {
    queueFeed.deepNotice = true;
    const noticeClient = {
      io: { on: noop, off: noop },
      service: () => ({
        find: async () => ({ data: [] }),
        get: async () => session,
        on: noop,
        off: noop,
      }),
    } as unknown as AgorClient;
    const panel = (open = true, status: Session['status'] = 'running') => (
      <App>
        <AppActionsProvider value={{}}>
          <div data-testid="notice-panel" style={{ position: 'fixed', inset: 0, maxWidth: 600 }}>
            <SessionPanel
              client={noticeClient}
              session={{ ...session, status }}
              open={open}
              onClose={noop}
            />
          </div>
        </AppActionsProvider>
      </App>
    );
    const view = render(panel());
    const root = screen.getByTestId('notice-panel').firstElementChild as HTMLElement;
    const body = root.children[1] as HTMLElement;
    body.style.overflowY = overflow;
    const transcript = await screen.findByTestId('conversation-scroll-container');
    const notice = screen.getByTestId('deep-notice');
    const live = notice.querySelector<HTMLElement>('span[aria-live="polite"]')!;
    const composer = screen.getByPlaceholderText('Queue here… @ for mentions, : for emoji');
    const assertLayout = () => {
      expect(body.scrollHeight, 'outer geometry, not merely hidden wheel').toBe(body.clientHeight);
      expect(root.scrollHeight).toBe(root.clientHeight);
      expect(body.scrollTop).toBe(0);
      expect(live.offsetParent).toBe(notice);
      expect(live).toHaveAttribute('aria-live', 'polite');
      expect(live).not.toHaveAttribute('aria-hidden');
      expect(getComputedStyle(live).display).not.toBe('none');
      expect(getComputedStyle(live).clipPath).toBe('inset(50%)');
      const bounds = root.getBoundingClientRect();
      expect(composer.getBoundingClientRect().bottom).toBeLessThanOrEqual(bounds.bottom);
      expect(
        screen.getByRole('button', { name: 'Send' }).getBoundingClientRect().bottom
      ).toBeLessThanOrEqual(bounds.bottom);
    };
    await expectBottom();
    expect(transcript.scrollTop).toBeGreaterThan(5000);
    expect(notice.getBoundingClientRect().bottom).toBeLessThan(
      transcript.getBoundingClientRect().top
    );
    await waitFor(assertLayout);
    const assertComposerWheel = async () => {
      const inputTop = composer.getBoundingClientRect().top;
      const transcriptTop = transcript.scrollTop;
      await userEvent.wheel(composer, { delta: { y: 600 } });
      // Wait for native wheel delivery, rather than asserting before paint.
      await new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
      );
      assertLayout();
      expect(composer.getBoundingClientRect().top).toBe(inputTop);
      expect(transcript.scrollTop).toBe(transcriptTop);
    };
    await assertComposerWheel();
    await userEvent.wheel(transcript, { delta: { y: -1200 } });
    await waitFor(() =>
      expect(transcript.scrollTop).toBeLessThan(
        transcript.scrollHeight - transcript.clientHeight - 100
      )
    );
    await waitFor(assertLayout);
    // Expand actual notice content without scrolling its toggle into view.
    fireEvent.click(notice.querySelector('button')!);
    await screen.findByRole('region', { name: 'Technical details' });
    await waitFor(assertLayout);
    await page.viewport(window.innerWidth, 390);
    await waitFor(assertLayout);
    await assertComposerWheel();
    await userEvent.fill(composer, 'Retained draft');
    view.rerender(panel(false));
    view.rerender(panel(true, 'completed'));
    await waitFor(assertLayout);
    expect(conversation()).toBe(transcript);
    expect(screen.getByPlaceholderText('Prompt here… @ for mentions, : for emoji')).toBe(composer);
    expect(composer).toHaveValue('Retained draft');
    expect(notice.querySelector('span[aria-live="polite"]')).toBe(live);
    await assertComposerWheel();
  }
);
