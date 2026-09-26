import { generateId } from '@agor/core/ids/browser';
import {
  type Message,
  MessageRole,
  type ReactiveSessionState,
  type Task,
  TaskStatus,
} from '@agor-live/client';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ConversationView } from './ConversationView';

const scrollToBottom = vi.hoisted(() => vi.fn());
vi.mock('use-stick-to-bottom', () => ({
  useStickToBottom: () => ({
    scrollRef: () => {},
    contentRef: () => {},
    scrollToBottom,
    stopScroll: () => {},
    state: {},
  }),
}));
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
const copy = vi.hoisted(() => vi.fn());
vi.mock('../../utils/clipboard', () => ({ useCopyToClipboard: () => [false, copy] }));
const listeners = new Set<() => void>();
const handle = { loadTaskMessages: vi.fn(), loadOlderTasks: vi.fn(), resync: vi.fn() };
let state: ReactiveSessionState;
const sessionId = generateId();
const tasks: Task[] = Array.from({ length: 11 }, (_, index) => ({
  task_id: generateId(),
  session_id: sessionId,
  full_prompt: 'Synthetic prompt',
  created_by: '',
  status: TaskStatus.COMPLETED,
  message_range: {
    start_index: index * 3,
    end_index: index * 3 + 2,
    start_timestamp: '2026-09-01T00:00:00Z',
  },
  created_at: '2026-09-01T00:00:00Z',
  git_state: { ref_at_start: '', sha_at_start: '' },
}));
function message(
  task: Task,
  index: number,
  role: Message['role'] = MessageRole.ASSISTANT
): Message {
  return {
    message_id: generateId(),
    session_id: task.session_id,
    task_id: task.task_id,
    role,
    type: role,
    index,
    timestamp: task.created_at,
    content_preview: '',
    content: Array.from(
      { length: 20 },
      (_, line) => `Message ${index} line ${line}\n\n${'Synthetic paragraph text. '.repeat(6)}`
    ).join('\n\n'),
  };
}
const messages = new Map(
  tasks.map((task, i) => [
    task.task_id,
    [message(task, i * 3, MessageRole.USER), message(task, i * 3 + 1), message(task, i * 3 + 2)],
  ])
);
function update(patch: Partial<ReactiveSessionState>) {
  act(() => {
    state = { ...state, ...patch };
    for (const listener of listeners) listener();
  });
}
function tail(index: number) {
  return screen.queryByText(`Message ${index} line 19`);
}
beforeEach(() => {
  scrollToBottom.mockClear();
  state = {
    sessionId,
    session: null,
    tasks: tasks.slice(0, 10),
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

describe('conversation history text defaults', () => {
  it('collapses nine older turns but protects all three messages of the latest turn on first paint', () => {
    render(<ConversationView client={null} sessionId={sessionId} />);
    expect(scrollToBottom).toHaveBeenCalledWith({ animation: 'instant' });
    expect(screen.getAllByRole('button', { name: 'show more' })).toHaveLength(27);
    for (const index of [27, 28, 29]) expect(tail(index)).toBeInTheDocument();
    expect(tail(0)).not.toBeInTheDocument();
    fireEvent.mouseOver(screen.getByText('Message 0 line 0'));
    fireEvent.click(screen.getByRole('img', { name: 'copy' }));
    expect(copy).toHaveBeenCalledWith(messages.get(tasks[0].task_id)![0].content);
  });

  it('waits for initial ordered hydration, and collapses late older messages without changing current text', () => {
    state = { ...state, loading: true, tasks: [tasks[0]] };
    render(<ConversationView client={null} sessionId={sessionId} />);
    expect(screen.queryByText('Message 0 line 0')).not.toBeInTheDocument();
    // A realtime task/message event advances this timestamp before the ordered
    // snapshot commits. It must not make the partial history render-ready.
    update({ lastSyncedAt: '2026-09-01T00:00:01Z' });
    expect(screen.queryByText('Message 0 line 0')).not.toBeInTheDocument();
    update({
      loading: false,
      tasks: tasks.slice(0, 10),
      messagesByTask: new Map([[tasks[9].task_id, messages.get(tasks[9].task_id)!]]),
    });
    expect(tail(29)).toBeInTheDocument();
    update({ messagesByTask: messages });
    expect(tail(0)).not.toBeInTheDocument();
    expect(tail(29)).toBeInTheDocument();
  });

  it('preserves explicit choices across hydration/remount/reconnect and protects previous current turns on arrival', () => {
    render(<ConversationView client={null} sessionId={sessionId} />);
    fireEvent.click(screen.getAllByRole('button', { name: 'show more' })[0]);
    fireEvent.click(screen.getAllByRole('button', { name: 'show less' }).at(-1)!);
    expect(tail(0)).toBeInTheDocument();
    expect(tail(29)).not.toBeInTheDocument();
    update({ messagesByTask: new Map(), connected: false });
    update({
      messagesByTask: new Map(messages),
      connected: true,
      loadedTaskIds: new Set(tasks.map((t) => t.task_id)),
      tasks,
    });
    expect(tail(0)).toBeInTheDocument();
    expect(tail(27)).toBeInTheDocument();
    expect(tail(28)).toBeInTheDocument();
    expect(tail(29)).not.toBeInTheDocument();
    expect(tail(32)).toBeInTheDocument();
    expect(tail(3)).not.toBeInTheDocument();
  });

  it('protects long live output and its prompt, including streaming-to-persisted identity', () => {
    const live = { ...tasks[9], status: TaskStatus.RUNNING };
    state = { ...state, tasks: [...tasks.slice(0, 9), live] };
    render(<ConversationView client={null} sessionId={sessionId} />);
    const response = messages.get(live.task_id)![2];
    update({
      streamingMessages: new Map([
        [
          response.message_id,
          {
            message_id: response.message_id,
            role: MessageRole.ASSISTANT,
            task_id: live.task_id,
            session_id: sessionId,
            content: String(response.content),
            thinkingContent: '',
            isStreaming: true,
            timestamp: response.timestamp,
            index: response.index,
          },
        ],
      ]),
    });
    expect(tail(29)).toBeInTheDocument();
    expect(tail(27)).toBeInTheDocument();
    fireEvent.click(screen.getAllByRole('button', { name: 'show less' }).at(-1)!);
    update({ tasks, streamingMessages: new Map(), messagesByTask: new Map(messages) });
    expect(tail(29)).not.toBeInTheDocument();
    expect(tail(27)).toBeInTheDocument();
  });

  it('protects an active non-latest turn independently of tool-detail hydration', () => {
    state = {
      ...state,
      tasks: state.tasks.map((task, i) =>
        i === 0 ? { ...task, status: TaskStatus.AWAITING_PERMISSION } : task
      ),
    };
    render(<ConversationView client={null} sessionId={sessionId} />);
    expect(tail(0)).toBeInTheDocument();
    expect(tail(2)).toBeInTheDocument();
    expect(tail(3)).not.toBeInTheDocument();
    update({ tasks: tasks.slice(0, 10) });
    expect(tail(2)).toBeInTheDocument();
  });

  it('resets on session navigation, preserves short text and collapses long single-line prose', () => {
    const view = render(<ConversationView client={null} sessionId={sessionId} />);
    fireEvent.click(screen.getAllByRole('button', { name: 'show more' })[0]);
    const originalState = state;
    const otherId = generateId();
    view.rerender(<ConversationView client={null} sessionId={otherId} />);
    expect(tail(0)).not.toBeInTheDocument();
    const otherTasks = tasks.slice(0, 2).map((task) => ({
      ...task,
      task_id: generateId(),
      session_id: otherId,
    }));
    update({
      sessionId: otherId,
      tasks: otherTasks,
      messagesByTask: new Map(
        otherTasks.map((task, i) => [
          task.task_id,
          [message(task, 100 + i * 2, MessageRole.USER), message(task, 101 + i * 2)],
        ])
      ),
    });
    expect(screen.getByText('Message 100 line 0')).toBeInTheDocument();
    expect(tail(100)).not.toBeInTheDocument();
    expect(tail(102)).toBeInTheDocument();
    expect(tail(103)).toBeInTheDocument();
    fireEvent.click(screen.getAllByRole('button', { name: 'show more' })[0]);
    expect(tail(100)).toBeInTheDocument();
    view.rerender(<ConversationView client={null} sessionId={sessionId} />);
    expect(tail(100)).not.toBeInTheDocument();
    update(originalState);
    expect(tail(0)).not.toBeInTheDocument();
    expect(tail(29)).toBeInTheDocument();
    const short = { ...messages.get(tasks[0].task_id)![0], content: 'Short text' };
    const prose = { ...messages.get(tasks[0].task_id)![1], content: 'Long prose '.repeat(500) };
    update({ messagesByTask: new Map([[tasks[0].task_id, [short, prose]]]) });
    expect(screen.getByText('Short text')).toBeInTheDocument();
    expect(screen.queryByText(prose.content.trim())).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'show more' }));
    expect(screen.getByText(prose.content.trim())).toBeInTheDocument();
  });
});
