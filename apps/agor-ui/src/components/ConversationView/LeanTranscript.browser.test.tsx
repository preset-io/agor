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
import { App, ConfigProvider, Flex, theme } from 'antd';
import type { ReactElement } from 'react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { page, userEvent } from 'vitest/browser';
import { AgentChain } from '../AgentChain';
import { ContextWindowPill, ModelPill } from '../Pill';
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

it('reveals existing metadata pills without layout shift through focus, hover and touch', async () => {
  const metadata = (
    <Flex gap="small" style={{ width: 'max-content', flexShrink: 0 }}>
      <ModelPill model="synthetic-model" />
      <ContextWindowPill used={60000} limit={100000} />
      <ModelPill model="another-long-synthetic-model-name" />
    </Flex>
  );
  render(
    <LeanTurnMetadata metadata={metadata}>
      <p>Prompt for metadata</p>
    </LeanTurnMetadata>
  );
  expect(screen.getByText('synthetic-model')).not.toBeVisible();
  const prompt = screen.getByText('Prompt for metadata');
  const before = prompt.parentElement!.getBoundingClientRect();
  await userEvent.tab();
  await waitFor(() => expect(screen.getByText('synthetic-model')).toBeVisible());
  expect(prompt.parentElement!.getBoundingClientRect().height).toBe(before.height);
  expect(prompt.parentElement!.getBoundingClientRect().top).toBe(before.top);
  const row = screen.getByRole('region', { name: 'Turn metadata' });
  const overlay = row.parentElement!;
  expect(getComputedStyle(overlay).position).toBe('absolute');
  await waitFor(() =>
    expect(overlay.getBoundingClientRect().bottom).toBe(
      prompt.parentElement!.getBoundingClientRect().bottom
    )
  );
  expect(overlay.getBoundingClientRect().top).toBeGreaterThanOrEqual(
    prompt.getBoundingClientRect().bottom
  );
  expect(row.getBoundingClientRect().right).toBeLessThanOrEqual(window.innerWidth);
  if (window.innerWidth === 320) expect(row.scrollWidth).toBeGreaterThan(row.clientWidth);
  await page.screenshot({ path: `./.vitest/lean-metadata-${window.innerWidth}.png` });
  cleanup();
  render(
    <LeanTurnMetadata metadata={metadata}>
      <p>Prompt for metadata</p>
    </LeanTurnMetadata>
  );
  expect(screen.queryByRole('button', { name: 'Show turn metadata' })).toBeNull();
  const touchPrompt = screen.getByText('Prompt for metadata');
  fireEvent.pointerDown(touchPrompt, { pointerType: 'touch', clientX: 10, clientY: 10 });
  fireEvent.pointerUp(touchPrompt, { pointerType: 'touch', clientX: 10, clientY: 60 });
  expect(screen.getByText('synthetic-model')).not.toBeVisible();
  fireEvent.pointerDown(touchPrompt, { pointerType: 'touch', clientX: 10, clientY: 10 });
  fireEvent.pointerUp(touchPrompt, { pointerType: 'touch', clientX: 10, clientY: 10 });
  await waitFor(() => expect(screen.getByText('synthetic-model')).toBeVisible());
  fireEvent.keyDown(touchPrompt, { key: 'Escape' });
  await waitFor(() => expect(screen.getByText('synthetic-model')).not.toBeVisible());
  cleanup();
  render(
    <LeanTurnMetadata metadata={metadata}>
      <p>Prompt for metadata</p>
    </LeanTurnMetadata>
  );
  await userEvent.hover(screen.getByText('Prompt for metadata'));
  await waitFor(() => expect(screen.getByText('synthetic-model')).toBeVisible());
  await userEvent.unhover(screen.getByText('Prompt for metadata'));
  await waitFor(() => expect(screen.getByText('synthetic-model')).not.toBeVisible());
});

it('keeps familiar icon-led tool rows and results inside the quiet outer disclosure', async () => {
  const activity: Message = {
    message_id: generateId(),
    session_id: sessionId,
    type: 'assistant',
    role: MessageRole.ASSISTANT,
    index: 0,
    timestamp: '2026-09-01T00:00:00.000Z',
    content_preview: '',
    content: [
      { type: 'tool_use', id: 'read', name: 'Read', input: { file_path: 'synthetic.txt' } },
      { type: 'tool_result', tool_use_id: 'read', content: 'SYNTHETIC_TOOL_RESULT' },
    ],
  };
  render(<AgentChain messages={[activity]} leanTranscript />);
  const header = screen.getByRole('button', { name: '1 tool call · Show details' });
  expect(header).toHaveAttribute('aria-expanded', 'false');
  await userEvent.tab();
  await userEvent.keyboard('{Enter}');
  await waitFor(() => expect(header).toHaveAttribute('aria-expanded', 'true'));
  const tool = screen.getByRole('button', { name: /Read/ });
  expect(tool.querySelector('.anticon')).not.toBeNull();
  expect(tool).toHaveAttribute('aria-expanded', 'false');
  const label = screen.getByText('1 tool call · Hide details');
  const caret = header.querySelector('.anticon-up')!;
  expect(getComputedStyle(label).fontSize).toBe(
    getComputedStyle(tool.querySelector('strong')!).fontSize
  );
  const caretGap = caret.getBoundingClientRect().left - label.getBoundingClientRect().right;
  expect(caretGap).toBeGreaterThanOrEqual(0);
  expect(caretGap).toBeLessThanOrEqual(12);
  await userEvent.click(tool);
  await waitFor(() => expect(screen.getByText('SYNTHETIC_TOOL_RESULT')).toBeVisible());
  await page.screenshot({ path: `./.vitest/lean-tool-content-${window.innerWidth}.png` });
});

it('shows live tool events before persistence and preserves the group through completion', async () => {
  const task = { ...tasks[19], status: TaskStatus.RUNNING };
  state = { ...state, tasks: [task], hasOlderTasks: false };
  render(<ConversationView client={null} sessionId={sessionId} />);
  const latest = { toolUseId: 'live-tool', toolName: 'Read', status: 'executing' as const };
  act(() => {
    state = { ...state, toolsByTask: new Map([[task.task_id, [latest]]]) };
    for (const listener of listeners) listener();
  });
  expect(screen.getByRole('button', { name: 'Running: Read · Show details' })).toBeVisible();
  const tool: Message = {
    message_id: generateId(),
    session_id: sessionId,
    task_id: task.task_id,
    type: 'assistant',
    role: MessageRole.ASSISTANT,
    index: 99,
    timestamp: task.created_at,
    content_preview: '',
    content: [{ type: 'tool_use', id: 'live-tool', name: 'Read', input: {} }],
  };
  act(() => {
    state = {
      ...state,
      messagesByTask: new Map([[task.task_id, [...messages.get(task.task_id)!, tool]]]),
      toolsByTask: new Map([[task.task_id, [{ ...latest, status: 'complete' }]]]),
    };
    for (const listener of listeners) listener();
  });
  expect(screen.getAllByRole('button', { name: 'Latest: Read · Show details' })).toHaveLength(1);
  act(() => {
    state = {
      ...state,
      tasks: [{ ...task, status: TaskStatus.COMPLETED }],
      loadedTaskIds: new Set([task.task_id]),
    };
    for (const listener of listeners) listener();
  });
  expect(screen.getByRole('button', { name: '1 tool call · Show details' })).toHaveAttribute(
    'aria-expanded',
    'false'
  );
  expect(screen.queryByText(/No tool calls recorded/)).not.toBeInTheDocument();
  expect(loadTaskMessages).not.toHaveBeenCalled();
});
