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
import { MessageBlock } from '../MessageBlock';
import { ContextWindowPill, ModelPill } from '../Pill';
import { LeanTurnMetadata } from '../TaskBlock/LeanTurnMetadata';
import { TaskBlock } from '../TaskBlock/TaskBlock';
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
      handle: currentHandle,
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
  const start = tasks.findIndex((task) => task.task_id === state.tasks[0]?.task_id);
  const next = Math.max(0, start - 10);
  update({ ...state, tasks: tasks.slice(next), hasOlderTasks: next > 0 });
});
const loadTaskMessages = vi.fn(async () => []);
const handle = {
  loadOlderTasks,
  loadTaskMessages,
  unloadTaskMessages: () => {},
  resync: async () => {},
} as unknown as ReactiveSessionHandle;
let currentHandle = handle;
beforeEach(() => {
  currentHandle = handle;
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
  expect(screen.getByText('Prompt 15')).toBeInTheDocument();
  expect(screen.getByText(/Answer 15\./)).toBeInTheDocument();
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

it('fences an old page request when navigating to another session', async () => {
  let finishOld!: () => void;
  let finishNew!: () => void;
  const oldLoad = vi.fn(
    () =>
      new Promise<void>((resolve) => {
        finishOld = resolve;
      })
  );
  const newLoad = vi.fn(
    () =>
      new Promise<void>((resolve) => {
        finishNew = resolve;
      })
  );
  currentHandle = { ...handle, loadOlderTasks: oldLoad } as ReactiveSessionHandle;
  const view = (id: typeof sessionId) => (
    <div style={{ height: 'calc(100dvh - 32px)', display: 'flex', flexDirection: 'column' }}>
      <ConversationView client={null} sessionId={id} />
    </div>
  );
  const { rerender } = render(view(sessionId));
  fireEvent.click(screen.getByRole('button', { name: /Load older history/ }));
  expect(oldLoad).toHaveBeenCalledTimes(1);
  const nextId = generateId();
  currentHandle = { ...handle, loadOlderTasks: newLoad } as ReactiveSessionHandle;
  state = { ...state, sessionId: nextId };
  rerender(view(nextId));
  fireEvent.click(screen.getByRole('button', { name: /Load older history/ }));
  expect(newLoad).toHaveBeenCalledTimes(1);
  await act(async () => {
    finishOld();
  });
  // The old finally must not unlock or clear the new request.
  fireEvent.click(screen.getByRole('button', { name: /Load older history/ }));
  expect(newLoad).toHaveBeenCalledTimes(1);
  await act(async () => {
    finishNew();
  });
  fireEvent.click(screen.getByRole('button', { name: /Load older history/ }));
  expect(newLoad).toHaveBeenCalledTimes(2);
  await act(async () => {
    finishNew();
  });
});

it('keeps a long user prompt and its full-size avatar within the transcript width', () => {
  const prompt: Message = {
    ...messages.get(tasks[19].task_id)![0],
    content: 'Synthetic long user prompt. '.repeat(80),
  };
  const { container } = render(
    <div style={{ maxWidth: 586 }}>
      <MessageBlock message={prompt} />
    </div>
  );
  const root = container.querySelector('.ant-bubble')!;
  const avatar = root.querySelector('.ant-avatar')!;
  expect(avatar.getBoundingClientRect().width).toBe(40);
  expect(avatar.getBoundingClientRect().right).toBeLessThanOrEqual(
    root.getBoundingClientRect().right + 1
  );
  expect(root.scrollWidth).toBeLessThanOrEqual(root.clientWidth + 1);
});

it('keeps the tool disclosure after an empty load and reopens without another request', async () => {
  const task = tasks[19];
  state = { ...state, tasks: [task], hasOlderTasks: false };
  loadTaskMessages.mockImplementationOnce(async () => {
    update({ ...state, loadedTaskIds: new Set([task.task_id]) });
    return [];
  });
  render(<ConversationView client={null} sessionId={sessionId} />);
  await userEvent.click(screen.getByRole('button', { name: 'Tool calls', expanded: false }));
  const empty = await screen.findByText('No tool calls');
  const header = screen.getByRole('button', { name: 'Tool calls', expanded: true });
  expect(header).toHaveAttribute('aria-expanded', 'true');
  expect(getComputedStyle(empty).fontSize).toBe(getComputedStyle(header).fontSize);
  expect(getComputedStyle(empty).color).toBe(getComputedStyle(header).color);
  await userEvent.click(header);
  expect(screen.queryByText('No tool calls')).toBeNull();
  await userEvent.click(screen.getByRole('button', { name: 'Tool calls', expanded: false }));
  expect(screen.getByText('No tool calls')).toBeVisible();
  expect(loadTaskMessages).toHaveBeenCalledTimes(1);
  expect(screen.getByText('Prompt 19')).toBeVisible();
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
  expect(getComputedStyle(prompt.parentElement!).paddingBottom).toBe('0px');
  expect(prompt.parentElement!.getBoundingClientRect().height).toBe(before.height);
  expect(prompt.parentElement!.getBoundingClientRect().top).toBe(before.top);
  const row = screen.getByRole('region', { name: 'Turn metadata' });
  const overlay = row.parentElement!;
  expect(getComputedStyle(overlay).position).toBe('absolute');
  await waitFor(() =>
    expect(overlay.getBoundingClientRect().top).toBe(
      prompt.parentElement!.getBoundingClientRect().bottom
    )
  );
  expect(overlay.getBoundingClientRect().top).toBeGreaterThanOrEqual(
    prompt.getBoundingClientRect().bottom
  );
  expect(row.getBoundingClientRect().right).toBeLessThanOrEqual(window.innerWidth);
  const pills = row.firstElementChild!;
  if (row.scrollWidth > row.clientWidth) {
    // Leftmost pills remain reachable rather than being clipped by end alignment.
    expect(pills.getBoundingClientRect().left).toBe(row.getBoundingClientRect().left);
  } else {
    expect(pills.getBoundingClientRect().right).toBe(row.getBoundingClientRect().right);
  }
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
  const fadingOverlay = screen.getByRole('region', { name: 'Turn metadata' }).parentElement!;
  expect(getComputedStyle(fadingOverlay).transitionProperty).toContain('visibility');
  await userEvent.unhover(screen.getByText('Prompt for metadata'));
  expect(fadingOverlay.style.pointerEvents).toBe('none');
  expect(getComputedStyle(fadingOverlay).transitionDelay.split(',').at(-1)?.trim()).not.toBe('0s');
  await waitFor(() => expect(screen.getByText('synthetic-model')).not.toBeVisible());
});

it('floats metadata over the following row, but reserves space for approval controls', async () => {
  const view = (reserveSpace: boolean) => (
    <div>
      <LeanTurnMetadata reserveSpace={reserveSpace} metadata={<span>Metadata pills</span>}>
        <div>Prompt</div>
      </LeanTurnMetadata>
      <button type="button" style={{ display: 'block' }}>
        Following controls
      </button>
    </div>
  );
  const { rerender } = render(view(false));
  await userEvent.hover(screen.getByText('Prompt'));
  const overlay = screen.getByRole('region', { name: 'Turn metadata' }).parentElement!;
  await waitFor(() =>
    expect(overlay.getBoundingClientRect().top).toBe(
      screen.getByRole('button', { name: 'Following controls' }).getBoundingClientRect().top
    )
  );
  await userEvent.hover(screen.getByText('Metadata pills'));
  expect(screen.getByText('Metadata pills')).toBeVisible();
  rerender(view(true));
  expect(overlay.getBoundingClientRect().bottom).toBeLessThanOrEqual(
    screen.getByRole('button', { name: 'Following controls' }).getBoundingClientRect().top
  );
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
  render(<AgentChain messages={[activity]} />);
  const header = screen.getByRole('button', { name: '1 tool call', expanded: false });
  expect(header).toHaveAttribute('aria-expanded', 'false');
  await userEvent.tab();
  await userEvent.keyboard('{Enter}');
  await waitFor(() => expect(header).toHaveAttribute('aria-expanded', 'true'));
  const tool = screen.getByRole('button', { name: /Read/ });
  expect(tool.querySelector('.anticon')).not.toBeNull();
  expect(tool).toHaveAttribute('aria-expanded', 'false');
  const label = screen.getByText('Tool calls');
  expect(header.querySelector('.ant-tag')).toHaveTextContent(/^1$/);
  const caret = header.querySelector('.anticon-up')!;
  expect(getComputedStyle(label).fontSize).toBe(
    getComputedStyle(tool.querySelector('strong')!).fontSize
  );
  expect(Number.parseFloat(getComputedStyle(caret).fontSize)).toBeLessThan(
    Number.parseFloat(getComputedStyle(label).fontSize)
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
  const activeHeader = screen.getByRole('button', { name: 'Running: Read', expanded: false });
  expect(activeHeader).toBeVisible();
  expect(activeHeader).toHaveAttribute('aria-busy', 'true');
  const shimmer = activeHeader.querySelector('.ant-thought-chain-motion-blink')!;
  expect(getComputedStyle(shimmer).animationName).not.toBe('none');
  expect(document.querySelector('[data-task-block] > .ant-spin')).toBeNull();
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
  expect(screen.getAllByRole('button', { name: 'Latest: Read', expanded: false })).toHaveLength(1);
  expect(screen.getByRole('button', { name: 'Latest: Read' })).toHaveAttribute('aria-busy', 'true');
  expect(screen.queryByRole('button', { name: 'Tool calls' })).toBeNull();
  act(() => {
    state = {
      ...state,
      messagesByTask: new Map([
        [
          task.task_id,
          [
            ...state.messagesByTask.get(task.task_id)!,
            {
              ...tool,
              message_id: generateId(),
              index: 100,
              content: 'Following assistant response',
            },
          ],
        ],
      ]),
    };
    for (const listener of listeners) listener();
  });
  expect(screen.getByRole('button', { name: 'Latest: Read' })).toHaveAttribute(
    'aria-busy',
    'false'
  );
  act(() => {
    state = {
      ...state,
      tasks: [{ ...task, status: TaskStatus.COMPLETED }],
      loadedTaskIds: new Set(),
    };
    for (const listener of listeners) listener();
  });
  expect(screen.getByRole('button', { name: '1 tool call', expanded: false })).toHaveAttribute(
    'aria-expanded',
    'false'
  );
  expect(screen.queryByText(/No tool calls/)).not.toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Tool calls' })).toBeNull();
  expect(screen.getByRole('button', { name: '1 tool call' })).toHaveAttribute('aria-busy', 'false');
  expect(loadTaskMessages).not.toHaveBeenCalled();
});

it('shows edit diffs on the first outer expansion without changing other tool defaults', async () => {
  const patch = [
    {
      oldStart: 1,
      oldLines: 1,
      newStart: 1,
      newLines: 1,
      lines: ['-before_restore', '+after_restore'],
    },
  ];
  const activity: Message = {
    ...messages.get(tasks[19].task_id)![1],
    content: [
      {
        type: 'tool_use',
        id: 'edit',
        name: 'edit_files',
        input: {
          changes: [{ path: 'synthetic.ts', kind: 'update' }],
        },
      },
      {
        type: 'tool_result',
        tool_use_id: 'edit',
        content: '[completed]',
        diff: {
          structuredPatch: patch,
          files: [{ path: 'synthetic.ts', kind: 'update', structuredPatch: patch }],
        },
      },
    ],
  };
  render(<AgentChain messages={[activity]} />);
  expect(screen.queryByText('after_restore')).toBeNull();
  await userEvent.click(screen.getByRole('button', { name: '1 tool call', expanded: false }));
  await waitFor(() => expect(screen.getByText('after_restore')).toBeVisible());
  expect(screen.getByText('before_restore')).toBeVisible();
});

it('keeps the full Bash command and ellipsizes only at the tool row boundary', async () => {
  const command = 'echo ' + 'synthetic-command-content-'.repeat(15) + 'END_OF_COMMAND';
  const activity: Message = {
    ...messages.get(tasks[19].task_id)![1],
    content: [
      { type: 'tool_use', id: 'bash-width', name: 'Bash', input: { command } },
      { type: 'tool_result', tool_use_id: 'bash-width', content: 'ok' },
    ],
  };
  render(<AgentChain messages={[activity]} />);
  await userEvent.click(screen.getByRole('button', { name: '1 tool call' }));
  const text = screen.getByText(command);
  const tool = screen.getByRole('button', { name: /Bash/ });
  expect(text.textContent).toBe(command);
  expect(text.getBoundingClientRect().right).toBeLessThanOrEqual(
    tool.getBoundingClientRect().right + 1
  );
  // A long command should use the available row, not stop at a character cap.
  expect(tool.getBoundingClientRect().right - text.getBoundingClientRect().right).toBeLessThan(16);
});

it('pages upward in ten-turn batches to the beginning without flooding or detail fetches', async () => {
  render(
    <div style={{ height: 'calc(100dvh - 32px)', display: 'flex', flexDirection: 'column' }}>
      <ConversationView client={null} sessionId={sessionId} />
    </div>
  );
  expect(document.querySelectorAll('[data-task-block]')).toHaveLength(10);
  const viewport = screen.getByTestId('conversation-scroll-container');
  for (const count of [20]) {
    act(() => {
      viewport.scrollTop = 0;
      for (let i = 0; i < 5; i++) fireEvent.wheel(viewport, { deltaY: -40 });
    });
    await waitFor(() => expect(document.querySelectorAll('[data-task-block]')).toHaveLength(count));
    expect(loadOlderTasks).toHaveBeenCalledTimes(count / 10 - 1);
  }
  expect(screen.queryByRole('button', { name: /Load older history/ })).toBeNull();
  expect(screen.queryByText(/Older history loads above/)).toBeNull();
  fireEvent.wheel(viewport, { deltaY: -40 });
  expect(loadOlderTasks).toHaveBeenCalledTimes(1);
  expect(loadTaskMessages).not.toHaveBeenCalled();
});

it('loads an older page on upward wheel intent when short history cannot scroll', async () => {
  state = { ...state, tasks: [tasks[19]], messagesByTask: new Map([[tasks[19].task_id, []]]) };
  render(
    <div style={{ height: 900, display: 'flex', flexDirection: 'column' }}>
      <ConversationView client={null} sessionId={sessionId} />
    </div>
  );
  const viewport = screen.getByTestId('conversation-scroll-container');
  expect(viewport.scrollHeight).toBeLessThanOrEqual(viewport.clientHeight);
  expect(loadOlderTasks).not.toHaveBeenCalled();
  fireEvent.wheel(viewport, { deltaY: -40 });
  await waitFor(() => expect(screen.getByText('Prompt 14')).toBeInTheDocument());
  expect(loadOlderTasks).toHaveBeenCalledTimes(1);
});

it('hides only verified empty history and lazily opens known counts while legacy turns stay reachable', async () => {
  state = {
    ...state,
    tasks: state.tasks.map((task, index) => ({
      ...task,
      recorded_tool_count: index === 0 ? 0 : index === 1 ? 2 : undefined,
    })),
  };
  render(<ConversationView client={null} sessionId={sessionId} />);
  expect(screen.getByText('Prompt 15')).toBeVisible();
  expect(screen.getByText(/Answer 15\./)).toBeVisible();
  expect(screen.getAllByRole('button', { name: 'Tool calls' })).toHaveLength(8);
  expect(loadTaskMessages).not.toHaveBeenCalled();
  await userEvent.click(screen.getByRole('button', { name: '2 tool calls' }));
  await waitFor(() => expect(loadTaskMessages).toHaveBeenCalledExactlyOnceWith(tasks[11].task_id));
});

it('shows exceptional outcomes beneath their turn without floating top icons or narrow-screen overflow', async () => {
  state = { ...state, tasks: [{ ...tasks[19], status: TaskStatus.STOPPED }], hasOlderTasks: false };
  const { container } = render(<ConversationView client={null} sessionId={sessionId} />);
  const root = container.querySelector('[data-task-block]')!;
  const stopped = screen.getByText('Turn stopped');
  expect(stopped).toBeVisible();
  const outcome = root.querySelector<HTMLElement>('[data-turn-outcome]')!;
  expect(outcome).toHaveClass('ant-alert-warning');
  expect(
    Math.abs(outcome.getBoundingClientRect().left - root.getBoundingClientRect().left)
  ).toBeLessThan(1);
  expect(getComputedStyle(outcome).fontSize).toBe('14px');
  expect(root.querySelector(':scope > .anticon')).toBeNull();
  expect(stopped.getBoundingClientRect().top).toBeGreaterThan(
    screen.getByText(/Answer 19\./).getBoundingClientRect().bottom
  );
  act(() =>
    update({
      ...state,
      tasks: [
        {
          ...state.tasks[0],
          status: TaskStatus.FAILED,
          error_message: 'Synthetic failure: ' + 'long-diagnostic-'.repeat(50),
        },
      ],
    })
  );
  expect(screen.getByRole('alert')).toHaveTextContent('Turn failed');
  expect(screen.getByRole('alert')).toHaveClass('ant-alert-error');
  expect(root.scrollWidth).toBeLessThanOrEqual(root.clientWidth + 1);
  await page.screenshot({ path: `./.vitest/lean-outcome-${window.innerWidth}.png` });
});

it('retains the recorded count through lazy loading and retry without double count text', async () => {
  const load = vi.fn().mockRejectedValue(new Error('offline'));
  render(
    <TaskBlock
      task={{ ...tasks[0], recorded_tool_count: 42 }}
      taskMessages={[]}
      taskMessagesLoaded={false}
      onLoadTaskMessages={load}
    />
  );
  fireEvent.click(screen.getByRole('button', { name: '42 tool calls' }));
  const loading = screen.getByRole('button', { name: 'Loading tool activity…' });
  expect(loading.querySelector('.ant-tag')).toHaveTextContent(/^42$/);
  expect(loading).toBeDisabled();
  const retry = await screen.findByRole('button', { name: 'Couldn’t load tool activity · Retry' });
  expect(retry.querySelector('.ant-tag')).toHaveTextContent(/^42$/);
  expect(retry.textContent?.match(/42/g)).toHaveLength(1);
  expect(load).toHaveBeenCalledTimes(1);
});
