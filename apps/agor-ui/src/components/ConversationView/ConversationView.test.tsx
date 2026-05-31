import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const TaskStatus = {
  COMPLETED: 'completed',
  QUEUED: 'queued',
} as const;

const MessageRole = {
  ASSISTANT: 'assistant',
} as const;

vi.mock('@agor-live/client', () => ({
  TaskStatus: {
    COMPLETED: 'completed',
    QUEUED: 'queued',
  },
  MessageRole: {
    ASSISTANT: 'assistant',
  },
  shortId: () => 'short-id',
}));

import { useSharedReactiveSession } from '../../hooks/useSharedReactiveSession';
import { ConversationView } from './ConversationView';

vi.mock('../../hooks/useSharedReactiveSession', () => ({
  useSharedReactiveSession: vi.fn(),
}));

vi.mock('../TaskBlock', () => ({
  TaskBlock: ({ task, isExpanded, onExpandChange, taskMessagesLoaded }: any) => (
    <section data-testid={`task-${task.task_id}`} data-expanded={String(isExpanded)}>
      <h2>{task.full_prompt}</h2>
      <button type="button" onClick={() => onExpandChange(task.task_id, !isExpanded)}>
        toggle {task.task_id}
      </button>
      {taskMessagesLoaded ? <div>messages loaded for {task.task_id}</div> : null}
    </section>
  ),
}));

const mockUseSharedReactiveSession = vi.mocked(useSharedReactiveSession);

interface RafEntry {
  id: number;
  callback: FrameRequestCallback;
}

let rafCallbacks: RafEntry[] = [];
let rafId = 0;
const originalRequestAnimationFrame = globalThis.requestAnimationFrame;
const originalCancelAnimationFrame = globalThis.cancelAnimationFrame;
const originalResizeObserver = globalThis.ResizeObserver;

function flushRaf() {
  const callbacks = rafCallbacks;
  rafCallbacks = [];
  act(() => {
    for (const { callback } of callbacks) {
      callback(performance.now());
    }
  });
}

function flushAllRaf(maxFrames = 20) {
  for (let frame = 0; frame < maxFrames && rafCallbacks.length > 0; frame += 1) {
    flushRaf();
  }
}

function setScrollMetrics(element: HTMLElement, scrollHeight: number, clientHeight: number) {
  Object.defineProperty(element, 'scrollHeight', {
    configurable: true,
    value: scrollHeight,
  });
  Object.defineProperty(element, 'clientHeight', {
    configurable: true,
    value: clientHeight,
  });
}

function makeTask(id: string, prompt: string): any {
  return {
    task_id: id,
    session_id: 'session-1',
    full_prompt: prompt,
    status: TaskStatus.COMPLETED,
    created_at: `2026-05-31T00:00:0${id.slice(-1)}.000Z`,
    updated_at: `2026-05-31T00:00:0${id.slice(-1)}.000Z`,
    created_by: 'user-1',
    message_range: null,
    normalized_sdk_response: null,
    computed_context_window: 0,
    git_state: {},
  } as any;
}

function makeMessage(taskId: string): any {
  return {
    message_id: `message-${taskId}`,
    session_id: 'session-1',
    task_id: taskId,
    role: MessageRole.ASSISTANT,
    content: 'done',
    index: 1,
    timestamp: '2026-05-31T00:00:00.000Z',
  } as any;
}

function makeState(overrides: Record<string, unknown>): any {
  return {
    sessionId: 'session-1',
    session: null,
    tasks: [],
    messagesByTask: new Map(),
    queuedTasks: [],
    streamingMessages: new Map(),
    toolsByTask: new Map(),
    loadedTaskIds: new Set(),
    connected: true,
    loading: false,
    error: null,
    terminal: false,
    lastSyncedAt: null,
    ...overrides,
  };
}

describe('ConversationView initial auto-scroll', () => {
  beforeEach(() => {
    rafCallbacks = [];
    rafId = 0;
    globalThis.requestAnimationFrame = vi.fn((callback: FrameRequestCallback) => {
      rafId += 1;
      rafCallbacks.push({ id: rafId, callback });
      return rafId;
    });
    globalThis.cancelAnimationFrame = vi.fn((id: number) => {
      rafCallbacks = rafCallbacks.filter((entry) => entry.id !== id);
    });
    globalThis.ResizeObserver = vi.fn(
      class {
        observe = vi.fn();
        unobserve = vi.fn();
        disconnect = vi.fn();
      }
    ) as any;
  });

  afterEach(() => {
    mockUseSharedReactiveSession.mockReset();
    globalThis.requestAnimationFrame = originalRequestAnimationFrame;
    globalThis.cancelAnimationFrame = originalCancelAnimationFrame;
    globalThis.ResizeObserver = originalResizeObserver;
  });

  it('scrolls to the bottom after the initial task list finishes loading', () => {
    const tasks = [makeTask('task-1', 'first task'), makeTask('task-2', 'latest task')];
    let state = makeState({ loading: true, tasks: [] });
    mockUseSharedReactiveSession.mockImplementation(() => ({ handle: null, state }));

    const { rerender } = render(
      <ConversationView client={null} sessionId={'session-1' as any} sessionModel="initial" />
    );

    state = makeState({ loading: false, tasks });
    rerender(
      <ConversationView client={null} sessionId={'session-1' as any} sessionModel="tasks-loaded" />
    );

    const scroller = screen.getByTestId('conversation-scroll-container');
    setScrollMetrics(scroller, 1200, 300);
    expect(scroller.scrollTop).toBe(0);

    flushAllRaf();

    expect(scroller.scrollTop).toBe(1200);
  });

  it('keeps initial task-load auto-scroll pinned while large layout grows after the first RAF', () => {
    const tasks = [makeTask('task-1', 'first task'), makeTask('task-2', 'latest task')];
    const state = makeState({ loading: false, tasks });
    mockUseSharedReactiveSession.mockImplementation(() => ({ handle: null, state }));

    render(
      <ConversationView client={null} sessionId={'session-1' as any} sessionModel="tasks-loaded" />
    );

    const scroller = screen.getByTestId('conversation-scroll-container');
    setScrollMetrics(scroller, 900, 300);

    flushRaf();
    expect(scroller.scrollTop).toBe(900);

    setScrollMetrics(scroller, 1800, 300);
    flushRaf();

    expect(scroller.scrollTop).toBe(1800);
  });

  it('scrolls again when the latest task messages finish loading', () => {
    const tasks = [makeTask('task-1', 'first task'), makeTask('task-2', 'latest task')];
    let state = makeState({ loading: false, tasks });
    mockUseSharedReactiveSession.mockImplementation(() => ({ handle: null, state }));

    const { rerender } = render(
      <ConversationView client={null} sessionId={'session-1' as any} sessionModel="tasks-loaded" />
    );
    const scroller = screen.getByTestId('conversation-scroll-container');
    setScrollMetrics(scroller, 900, 300);
    flushAllRaf();
    expect(scroller.scrollTop).toBe(900);

    state = makeState({
      loading: false,
      tasks,
      loadedTaskIds: new Set(['task-2']),
      messagesByTask: new Map([['task-2', [makeMessage('task-2')]]]),
    });
    rerender(
      <ConversationView
        client={null}
        sessionId={'session-1' as any}
        sessionModel="messages-loaded"
      />
    );
    setScrollMetrics(scroller, 1600, 300);

    flushAllRaf();

    expect(scroller.scrollTop).toBe(1600);
  });

  it('ignores stale reactive session state during a session switch', () => {
    const sessionOneTasks = [makeTask('task-1', 'session one task')];
    const sessionTwoTasks = [makeTask('task-2', 'session two latest')];
    let state = makeState({ sessionId: 'session-1', loading: false, tasks: sessionOneTasks });
    mockUseSharedReactiveSession.mockImplementation(() => ({ handle: null, state }));

    const { rerender } = render(
      <ConversationView client={null} sessionId={'session-1' as any} sessionModel="session-1" />
    );
    const firstScroller = screen.getByTestId('conversation-scroll-container');
    setScrollMetrics(firstScroller, 900, 300);
    flushAllRaf();
    expect(firstScroller.scrollTop).toBe(900);

    // The shared-session hook can return the previous session state for one
    // render after sessionId changes. That stale render must not mark the new
    // session's initial task-list scroll phase as complete.
    rerender(
      <ConversationView client={null} sessionId={'session-2' as any} sessionModel="stale-state" />
    );
    expect(screen.queryByTestId('conversation-scroll-container')).not.toBeInTheDocument();

    state = makeState({ sessionId: 'session-2', loading: false, tasks: sessionTwoTasks });
    rerender(
      <ConversationView client={null} sessionId={'session-2' as any} sessionModel="session-2" />
    );

    const secondScroller = screen.getByTestId('conversation-scroll-container');
    setScrollMetrics(secondScroller, 1400, 300);
    flushAllRaf();

    expect(secondScroller.scrollTop).toBe(1400);
  });

  it('lets a manual scroll before the new-task RAF win', () => {
    let tasks = [makeTask('task-1', 'first task')];
    let state = makeState({ loading: false, tasks });
    mockUseSharedReactiveSession.mockImplementation(() => ({ handle: null, state }));

    const { rerender } = render(
      <ConversationView client={null} sessionId={'session-1' as any} sessionModel="one-task" />
    );
    const scroller = screen.getByTestId('conversation-scroll-container');
    setScrollMetrics(scroller, 900, 300);
    flushAllRaf();
    expect(scroller.scrollTop).toBe(900);

    tasks = [makeTask('task-1', 'first task'), makeTask('task-2', 'new task')];
    state = makeState({ loading: false, tasks });
    rerender(
      <ConversationView client={null} sessionId={'session-1' as any} sessionModel="two-tasks" />
    );
    setScrollMetrics(scroller, 1400, 300);

    scroller.scrollTop = 100;
    fireEvent.wheel(scroller);
    fireEvent.scroll(scroller);
    flushAllRaf();

    expect(scroller.scrollTop).toBe(100);
  });

  it('treats explicit task expand/collapse as reading intent before a new task arrives', () => {
    let tasks = [makeTask('task-1', 'first task'), makeTask('task-2', 'latest task')];
    let state = makeState({ loading: false, tasks });
    mockUseSharedReactiveSession.mockImplementation(() => ({ handle: null, state }));

    const { rerender } = render(
      <ConversationView client={null} sessionId={'session-1' as any} sessionModel="two-tasks" />
    );
    const scroller = screen.getByTestId('conversation-scroll-container');
    setScrollMetrics(scroller, 900, 300);
    flushAllRaf();

    fireEvent.click(screen.getByRole('button', { name: 'toggle task-1' }));
    expect(screen.getByTestId('task-task-1')).toHaveAttribute('data-expanded', 'true');

    tasks = [
      makeTask('task-1', 'first task'),
      makeTask('task-2', 'previous latest task'),
      makeTask('task-3', 'new latest task'),
    ];
    state = makeState({ loading: false, tasks });
    rerender(
      <ConversationView client={null} sessionId={'session-1' as any} sessionModel="three-tasks" />
    );
    setScrollMetrics(scroller, 1500, 300);
    flushAllRaf();

    expect(scroller.scrollTop).toBe(900);
    expect(screen.getByTestId('task-task-1')).toHaveAttribute('data-expanded', 'true');
    expect(screen.getByTestId('task-task-3')).toHaveAttribute('data-expanded', 'true');
  });

  it('does not scroll when latest task messages load after the latest task was collapsed', () => {
    const tasks = [makeTask('task-1', 'first task'), makeTask('task-2', 'latest task')];
    let state = makeState({ loading: false, tasks });
    mockUseSharedReactiveSession.mockImplementation(() => ({ handle: null, state }));

    const { rerender } = render(
      <ConversationView client={null} sessionId={'session-1' as any} sessionModel="tasks-loaded" />
    );
    const scroller = screen.getByTestId('conversation-scroll-container');
    setScrollMetrics(scroller, 900, 300);
    flushAllRaf();
    expect(scroller.scrollTop).toBe(900);

    fireEvent.click(screen.getByRole('button', { name: 'toggle task-2' }));
    expect(screen.getByTestId('task-task-2')).toHaveAttribute('data-expanded', 'false');

    state = makeState({
      loading: false,
      tasks,
      loadedTaskIds: new Set(['task-2']),
      messagesByTask: new Map([['task-2', [makeMessage('task-2')]]]),
    });
    rerender(
      <ConversationView
        client={null}
        sessionId={'session-1' as any}
        sessionModel="messages-loaded"
      />
    );
    setScrollMetrics(scroller, 1600, 300);
    flushAllRaf();

    expect(scroller.scrollTop).toBe(900);
  });

  it('cancels pending initial auto-scroll when the view becomes inactive', () => {
    const tasks = [makeTask('task-1', 'first task'), makeTask('task-2', 'latest task')];
    const state = makeState({ loading: false, tasks });
    mockUseSharedReactiveSession.mockImplementation(() => ({ handle: null, state }));

    const { rerender } = render(
      <ConversationView client={null} sessionId={'session-1' as any} sessionModel="active" />
    );
    const scroller = screen.getByTestId('conversation-scroll-container');
    setScrollMetrics(scroller, 900, 300);

    rerender(
      <ConversationView
        client={null}
        sessionId={'session-1' as any}
        sessionModel="inactive"
        isActive={false}
      />
    );
    flushAllRaf();

    expect(scroller.scrollTop).toBe(0);
    expect(globalThis.cancelAnimationFrame).toHaveBeenCalled();
  });

  it('does not fight the user after they manually scroll away during initial loading', () => {
    const tasks = [makeTask('task-1', 'first task'), makeTask('task-2', 'latest task')];
    let state = makeState({ loading: false, tasks });
    mockUseSharedReactiveSession.mockImplementation(() => ({ handle: null, state }));

    const { rerender } = render(
      <ConversationView client={null} sessionId={'session-1' as any} sessionModel="tasks-loaded" />
    );
    const scroller = screen.getByTestId('conversation-scroll-container');
    setScrollMetrics(scroller, 900, 300);
    flushAllRaf();

    scroller.scrollTop = 100;
    fireEvent.wheel(scroller);
    fireEvent.scroll(scroller);

    state = makeState({
      loading: false,
      tasks,
      loadedTaskIds: new Set(['task-2']),
      messagesByTask: new Map([['task-2', [makeMessage('task-2')]]]),
    });
    rerender(
      <ConversationView
        client={null}
        sessionId={'session-1' as any}
        sessionModel="messages-loaded"
      />
    );
    setScrollMetrics(scroller, 1600, 300);
    flushAllRaf();

    expect(scroller.scrollTop).toBe(100);
  });

  it('keeps streaming locked to the bottom while the user is still at bottom', () => {
    const tasks = [makeTask('task-1', 'latest task')];
    let streamingMessages = new Map();
    let state = makeState({ loading: false, tasks, streamingMessages });
    mockUseSharedReactiveSession.mockImplementation(() => ({ handle: null, state }));

    const { rerender } = render(
      <ConversationView client={null} sessionId={'session-1' as any} sessionModel="initial" />
    );
    const scroller = screen.getByTestId('conversation-scroll-container');
    setScrollMetrics(scroller, 900, 300);
    flushAllRaf();
    expect(scroller.scrollTop).toBe(900);

    streamingMessages = new Map([['streaming-1', { task_id: 'task-1', content: 'chunk' }]]);
    state = makeState({ loading: false, tasks, streamingMessages });
    rerender(
      <ConversationView client={null} sessionId={'session-1' as any} sessionModel="streaming" />
    );

    setScrollMetrics(scroller, 1300, 300);
    flushAllRaf();

    expect(scroller.scrollTop).toBe(1300);
  });
});
