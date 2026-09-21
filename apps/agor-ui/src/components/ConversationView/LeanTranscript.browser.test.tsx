import { generateId } from '@agor/core/ids/browser';
import {
  type Message,
  MessageRole,
  type ReactiveSessionHandle,
  type ReactiveSessionState,
  type Task,
  TaskStatus,
} from '@agor-live/client';
import {
  act,
  cleanup,
  fireEvent,
  render as rtlRender,
  screen,
  waitFor,
} from '@testing-library/react';
import { App, ConfigProvider, theme } from 'antd';
import type { ReactElement } from 'react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { page, userEvent } from 'vitest/browser';
import { LeanTurnMetadata } from '../TaskBlock/LeanTurnMetadata';
import { ConversationView } from './ConversationView';

function TestSurface({ children }: { children: ReactElement }) {
  const { token } = theme.useToken();
  return (
    <App style={{ background: token.colorBgLayout, color: token.colorText, minHeight: '100dvh' }}>
      {children}
    </App>
  );
}

function render(element: ReactElement) {
  return rtlRender(
    <ConfigProvider theme={{ algorithm: theme.darkAlgorithm }}>
      <TestSurface>{element}</TestSurface>
    </ConfigProvider>
  );
}

vi.mock('../../hooks/useSharedReactiveSession', async () => {
  const { useSyncExternalStore } = await import('react');
  return {
    useSharedReactiveSession: () => ({
      handle,
      state: useSyncExternalStore(
        (listener) => {
          listeners.add(listener);
          return () => listeners.delete(listener);
        },
        () => state
      ),
    }),
  };
});
const sessionId = generateId();
const listeners = new Set<() => void>();
const tasks: Task[] = Array.from({ length: 20 }, (_, index) => ({
  task_id: generateId(),
  session_id: sessionId,
  full_prompt: `Prompt ${index}`,
  created_by: '',
  status: TaskStatus.COMPLETED,
  created_at: '2026-09-01T00:00:00.000Z',
  model: 'synthetic-model',
  tool_use_count: 0,
  git_state: { ref_at_start: 'main', sha_at_start: 'test' },
}));
const messages = new Map(
  tasks.map((task, index) => [
    task.task_id,
    [
      {
        message_id: generateId(),
        session_id: sessionId,
        task_id: task.task_id,
        index: index * 2,
        role: MessageRole.USER,
        type: 'user',
        content: task.full_prompt,
        content_preview: '',
        timestamp: task.created_at,
      },
      {
        message_id: generateId(),
        session_id: sessionId,
        task_id: task.task_id,
        index: index * 2 + 1,
        role: MessageRole.ASSISTANT,
        type: 'assistant',
        content: `Answer ${index}. ${'Synthetic text for testing pagination and readable history. '.repeat(8)}`,
        content_preview: '',
        timestamp: task.created_at,
      },
    ] as Message[],
  ])
);
let state: ReactiveSessionState;
function update(next: ReactiveSessionState) {
  state = next;
  for (const listener of listeners) listener();
}
const loadOlderTasks = vi.fn(async () => {
  await new Promise((resolve) => setTimeout(resolve, 40));
  update({ ...state, tasks, hasOlderTasks: false });
});
const loadTaskMessages = vi.fn(async () => []);
const handle = {
  loadOlderTasks,
  loadTaskMessages,
  unloadTaskMessages: () => {},
  resync: async () => {},
} as unknown as ReactiveSessionHandle;
beforeEach(() => {
  loadOlderTasks.mockClear();
  loadTaskMessages.mockClear();
  state = {
    sessionId,
    session: null,
    tasks: tasks.slice(10),
    messagesByTask: messages,
    loadedTaskIds: new Set(),
    streamingMessages: new Map(),
    toolsByTask: new Map(),
    queuedTasks: [],
    connected: true,
    loading: false,
    terminal: false,
    error: null,
    lastSyncedAt: null,
    hasOlderTasks: true,
  };
});
afterEach(cleanup);

it('renders continuous history without detail fetching and anchors an upward page at every viewport', async () => {
  render(
    <div style={{ height: 'calc(100dvh - 32px)', display: 'flex', flexDirection: 'column' }}>
      <ConversationView client={null} sessionId={sessionId} />
    </div>
  );
  const viewport = screen.getByTestId('conversation-scroll-container');
  await waitFor(() => expect(viewport.scrollTop).toBeGreaterThan(100));
  expect(loadTaskMessages).not.toHaveBeenCalled();
  expect(viewport.querySelector('.ant-collapse')).toBeNull();
  expect(screen.getByText('Prompt 10')).toBeInTheDocument();
  expect(screen.getByText(/Answer 10\./)).toBeInTheDocument();
  // Establish an upward reader scroll, then cross the older-page threshold.
  act(() => {
    viewport.scrollTop = 150;
    fireEvent.scroll(viewport);
  });
  let anchor: HTMLElement | undefined;
  let top = 0;
  act(() => {
    viewport.scrollTop = 60;
    anchor = Array.from(viewport.querySelectorAll<HTMLElement>('[data-task-block]')).find(
      (element) => element.getBoundingClientRect().bottom >= viewport.getBoundingClientRect().top
    );
    top = anchor!.getBoundingClientRect().top;
    fireEvent.scroll(viewport);
  });
  await waitFor(() => expect(screen.getByText('Prompt 0')).toBeInTheDocument());
  await waitFor(() => expect(Math.abs(anchor!.getBoundingClientRect().top - top)).toBeLessThan(3));
  expect(loadOlderTasks).toHaveBeenCalledTimes(1);
  expect(viewport.scrollWidth).toBeLessThanOrEqual(viewport.clientWidth + 1);
  await page.screenshot({ path: `./.vitest/lean-transcript-${window.innerWidth}.png` });
});

it('reveals metadata through keyboard focus, hover and touch-equivalent click', async () => {
  render(
    <LeanTurnMetadata task={tasks[0]} userById={new Map()}>
      <p>Prompt for metadata</p>
    </LeanTurnMetadata>
  );
  expect(screen.queryByText('synthetic-model')).not.toBeInTheDocument();
  await userEvent.tab();
  await waitFor(() => expect(screen.getByText('synthetic-model')).toBeVisible());
  cleanup();
  render(
    <LeanTurnMetadata task={tasks[0]} userById={new Map()}>
      <p>Prompt for metadata</p>
    </LeanTurnMetadata>
  );
  await userEvent.click(screen.getByRole('button', { name: 'Show turn metadata' }));
  await waitFor(() => expect(screen.getByText('synthetic-model')).toBeVisible());
  cleanup();
  render(
    <LeanTurnMetadata task={tasks[0]} userById={new Map()}>
      <p>Prompt for metadata</p>
    </LeanTurnMetadata>
  );
  await userEvent.hover(screen.getByText('Prompt for metadata'));
  await waitFor(() => expect(screen.getByText('synthetic-model')).toBeVisible());
});
