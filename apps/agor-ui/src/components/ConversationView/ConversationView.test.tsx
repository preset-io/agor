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

// use-stick-to-bottom owns the actual scroll physics (persistent
// ResizeObserver, spring animation). jsdom has no real layout, so we don't
// unit-test the library here — instead we mock it and assert OUR integration
// wiring: onScrollRef exposes the hook's scrollToBottom + a working
// scrollToTop, the open/session-switch effect calls scrollToBottom, and the
// new-task expand logic honors the hook's isAtBottom.
let mockIsAtBottom = true;
const mockScrollToBottom = vi.fn();
type CallbackRef = ((el: HTMLElement | null) => void) & { current: HTMLElement | null };

function makeCallbackRef(): CallbackRef {
  const ref = ((el: HTMLElement | null) => {
    ref.current = el;
  }) as CallbackRef;
  ref.current = null;
  return ref;
}

let mockScrollRef: CallbackRef;
let mockContentRef: CallbackRef;

vi.mock('use-stick-to-bottom', () => ({
  useStickToBottom: () => ({
    scrollRef: mockScrollRef,
    contentRef: mockContentRef,
    scrollToBottom: mockScrollToBottom,
    isAtBottom: mockIsAtBottom,
  }),
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

describe('ConversationView auto-scroll integration', () => {
  beforeEach(() => {
    mockIsAtBottom = true;
    mockScrollToBottom.mockClear();
    mockScrollRef = makeCallbackRef();
    mockContentRef = makeCallbackRef();
  });

  afterEach(() => {
    mockUseSharedReactiveSession.mockReset();
  });

  it('exposes a working scrollToBottom and scrollToTop via onScrollRef', () => {
    const tasks = [makeTask('task-1', 'first task'), makeTask('task-2', 'latest task')];
    const state = makeState({ loading: false, tasks });
    mockUseSharedReactiveSession.mockImplementation(() => ({ handle: null, state }));

    let exposedScrollToBottom: (() => void) | null = null;
    let exposedScrollToTop: (() => void) | null = null;
    const onScrollRef = (scrollToBottom: () => void, scrollToTop: () => void) => {
      exposedScrollToBottom = scrollToBottom;
      exposedScrollToTop = scrollToTop;
    };

    render(
      <ConversationView
        client={null}
        sessionId={'session-1' as any}
        sessionModel="loaded"
        onScrollRef={onScrollRef}
      />
    );

    expect(exposedScrollToBottom).toBeTypeOf('function');
    expect(exposedScrollToTop).toBeTypeOf('function');

    // The mount effect already engaged the bottom lock once; clear so we only
    // assert the explicit button-driven call below.
    mockScrollToBottom.mockClear();
    act(() => exposedScrollToBottom?.());
    expect(mockScrollToBottom).toHaveBeenCalledTimes(1);

    // scrollToTop drives the real scroll container to the top.
    const scroller = screen.getByTestId('conversation-scroll-container');
    scroller.scrollTop = 500;
    act(() => exposedScrollToTop?.());
    expect(scroller.scrollTop).toBe(0);
  });

  it('scrolls to the bottom on initial open (active + session present)', () => {
    const tasks = [makeTask('task-1', 'latest task')];
    const state = makeState({ loading: false, tasks });
    mockUseSharedReactiveSession.mockImplementation(() => ({ handle: null, state }));

    render(<ConversationView client={null} sessionId={'session-1' as any} sessionModel="loaded" />);

    expect(mockScrollToBottom).toHaveBeenCalledTimes(1);
  });

  it('re-engages the bottom lock when the session switches', () => {
    let state = makeState({
      sessionId: 'session-1',
      loading: false,
      tasks: [makeTask('task-1', 'a')],
    });
    mockUseSharedReactiveSession.mockImplementation(() => ({ handle: null, state }));

    const { rerender } = render(
      <ConversationView client={null} sessionId={'session-1' as any} sessionModel="one" />
    );
    expect(mockScrollToBottom).toHaveBeenCalledTimes(1);

    mockScrollToBottom.mockClear();
    state = makeState({ sessionId: 'session-2', loading: false, tasks: [makeTask('task-2', 'b')] });
    rerender(<ConversationView client={null} sessionId={'session-2' as any} sessionModel="two" />);

    expect(mockScrollToBottom).toHaveBeenCalledTimes(1);
  });

  it('does not scroll to the bottom while the view is inactive', () => {
    const state = makeState({ loading: false, tasks: [makeTask('task-1', 'a')] });
    mockUseSharedReactiveSession.mockImplementation(() => ({ handle: null, state }));

    render(
      <ConversationView
        client={null}
        sessionId={'session-1' as any}
        sessionModel="inactive"
        isActive={false}
      />
    );

    expect(mockScrollToBottom).not.toHaveBeenCalled();
  });

  it('collapses older tasks and focuses the new one when the user is at bottom', () => {
    mockIsAtBottom = true;
    let tasks = [makeTask('task-1', 'first task')];
    let state = makeState({ loading: false, tasks });
    mockUseSharedReactiveSession.mockImplementation(() => ({ handle: null, state }));

    const { rerender } = render(
      <ConversationView client={null} sessionId={'session-1' as any} sessionModel="one-task" />
    );
    expect(screen.getByTestId('task-task-1')).toHaveAttribute('data-expanded', 'true');

    tasks = [makeTask('task-1', 'first task'), makeTask('task-2', 'new task')];
    state = makeState({ loading: false, tasks });
    rerender(
      <ConversationView client={null} sessionId={'session-1' as any} sessionModel="two-tasks" />
    );

    // At bottom → only the latest task stays expanded.
    expect(screen.getByTestId('task-task-1')).toHaveAttribute('data-expanded', 'false');
    expect(screen.getByTestId('task-task-2')).toHaveAttribute('data-expanded', 'true');
  });

  it('keeps older tasks expanded when the user has scrolled away', () => {
    mockIsAtBottom = false;
    let tasks = [makeTask('task-1', 'first task')];
    let state = makeState({ loading: false, tasks });
    mockUseSharedReactiveSession.mockImplementation(() => ({ handle: null, state }));

    const { rerender } = render(
      <ConversationView client={null} sessionId={'session-1' as any} sessionModel="one-task" />
    );
    expect(screen.getByTestId('task-task-1')).toHaveAttribute('data-expanded', 'true');

    tasks = [makeTask('task-1', 'first task'), makeTask('task-2', 'new task')];
    state = makeState({ loading: false, tasks });
    rerender(
      <ConversationView client={null} sessionId={'session-1' as any} sessionModel="two-tasks" />
    );

    // Scrolled away → new task is expanded but the old one is preserved.
    expect(screen.getByTestId('task-task-1')).toHaveAttribute('data-expanded', 'true');
    expect(screen.getByTestId('task-task-2')).toHaveAttribute('data-expanded', 'true');
  });

  it('toggles task expansion on user click without forcing a scroll', () => {
    const tasks = [makeTask('task-1', 'first task'), makeTask('task-2', 'latest task')];
    const state = makeState({ loading: false, tasks, loadedTaskIds: new Set(['task-2']) });
    mockUseSharedReactiveSession.mockImplementation(() => ({ handle: null, state }));

    render(<ConversationView client={null} sessionId={'session-1' as any} sessionModel="loaded" />);

    expect(screen.getByTestId('task-task-1')).toHaveAttribute('data-expanded', 'false');
    mockScrollToBottom.mockClear();

    fireEvent.click(screen.getByRole('button', { name: 'toggle task-1' }));
    expect(screen.getByTestId('task-task-1')).toHaveAttribute('data-expanded', 'true');
    // Manual expand/collapse must not trigger an auto-scroll.
    expect(mockScrollToBottom).not.toHaveBeenCalled();
  });

  it('renders streaming task messages without throwing', () => {
    const tasks = [makeTask('task-1', 'latest task')];
    const state = makeState({
      loading: false,
      tasks,
      loadedTaskIds: new Set(['task-1']),
      streamingMessages: new Map([['stream-1', makeMessage('task-1')]]),
    });
    mockUseSharedReactiveSession.mockImplementation(() => ({ handle: null, state }));

    render(
      <ConversationView client={null} sessionId={'session-1' as any} sessionModel="streaming" />
    );

    expect(screen.getByTestId('task-task-1')).toBeInTheDocument();
  });
});
