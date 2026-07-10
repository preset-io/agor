import { act, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// ── Render counters ──────────────────────────────────────────────────────────
// MessageBlock is the per-message leaf of the transcript. Counting its renders
// per message_id (through the REAL TaskBlock + real streaming grouping hooks)
// pins the streaming-isolation contract: a chunk for task X must not touch
// message subtrees of other tasks — nor untouched messages of task X itself.
const messageRenders = new Map<string, number>();

vi.mock('../MessageBlock', async () => {
  const React = await import('react');
  return {
    __esModule: true,
    // Memoized like the real MessageBlock — the pin is that props (above all
    // `message`) keep their identity, which is exactly what lets the real,
    // markdown-heavy MessageBlock bail out during streaming.
    MessageBlock: React.memo(({ message }: { message: { message_id: string } }) => {
      messageRenders.set(message.message_id, (messageRenders.get(message.message_id) || 0) + 1);
      return <div data-testid={`msg-${message.message_id}`} />;
    }),
  };
});

// use-stick-to-bottom owns scroll physics that jsdom can't exercise; the
// existing ConversationView.test.tsx covers that wiring. Stub it here so the
// isolation test doesn't depend on layout behavior.
vi.mock('use-stick-to-bottom', () => ({
  useStickToBottom: () => ({
    scrollRef: () => {},
    contentRef: () => {},
    scrollToBottom: () => {},
    stopScroll: () => {},
    state: { escapedFromLock: false, isAtBottom: true },
  }),
}));

// Controlled reactive-session feed: `emitReactiveState` swaps the state object
// the way a real streaming notify does (fresh top-level object per event).
let emitReactiveState: (state: unknown) => void = () => {};
let initialReactiveState: unknown = null;

// Identity-stable like the real shared handle — a fresh handle per render
// would itself defeat the load/unload useCallbacks under test.
const mockReactiveHandle = {
  loadTaskMessages: async () => {},
  unloadTaskMessages: () => {},
  resync: async () => {},
};

vi.mock('../../hooks/useSharedReactiveSession', async () => {
  const React = await import('react');
  return {
    useSharedReactiveSession: () => {
      const [state, setState] = React.useState(initialReactiveState);
      emitReactiveState = setState;
      return { handle: mockReactiveHandle, state };
    },
  };
});

import { ConversationView } from './ConversationView';

const SESSION_ID = 'session-1';

function makeTask(id: string, status: string): any {
  return {
    task_id: id,
    session_id: SESSION_ID,
    full_prompt: `prompt ${id}`,
    status,
    created_at: '2026-07-01T00:00:00.000Z',
    updated_at: '2026-07-01T00:00:00.000Z',
    created_by: 'user-1',
    message_range: null,
    normalized_sdk_response: null,
    computed_context_window: 0,
    git_state: {},
  };
}

function makeMessage(id: string, taskId: string, index: number): any {
  return {
    message_id: id,
    session_id: SESSION_ID,
    task_id: taskId,
    role: 'assistant',
    content: `text of ${id}`,
    index,
    timestamp: '2026-07-01T00:00:01.000Z',
  };
}

function makeStreamingMessage(id: string, taskId: string, content: string): any {
  return {
    message_id: id,
    session_id: SESSION_ID,
    task_id: taskId,
    role: 'assistant',
    content,
    thinkingContent: '',
    timestamp: '2026-07-01T00:00:02.000Z',
    isStreaming: true,
    index: 99,
  };
}

function makeState(overrides: Record<string, unknown>): any {
  return {
    sessionId: SESSION_ID,
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

describe('ConversationView streaming re-render isolation', () => {
  const taskA = makeTask('task-a', 'completed');
  const taskB = makeTask('task-b', 'running');
  const tasks = [taskA, taskB];
  const msgA1 = makeMessage('msg-a1', 'task-a', 0);
  const msgA2 = makeMessage('msg-a2', 'task-a', 1);
  const msgB1 = makeMessage('msg-b1', 'task-b', 0);
  const messagesByTask = new Map([
    ['task-a', [msgA1, msgA2]],
    ['task-b', [msgB1]],
  ]);
  const loadedTaskIds = new Set(['task-a', 'task-b']);

  function baseState(streamingMessages: Map<string, unknown>) {
    return makeState({ tasks, messagesByTask, loadedTaskIds, streamingMessages });
  }

  beforeEach(() => {
    messageRenders.clear();
  });

  it('a streaming chunk for task B does not re-render task A message blocks (nor settled task B ones)', () => {
    const streamB = makeStreamingMessage('stream-b', 'task-b', 'partial');
    initialReactiveState = baseState(new Map([['stream-b', streamB]]));

    render(
      <ConversationView
        client={null}
        sessionId={SESSION_ID as any}
        sessionModel="model"
        forceExpandAll
      />
    );

    expect(screen.getByTestId('msg-stream-b')).toBeInTheDocument();
    const baseline = new Map(messageRenders);
    expect(baseline.get('msg-a1')).toBeGreaterThanOrEqual(1);

    // A chunk lands for task B: the reactive session replaces the state object
    // and the streamingMessages map, cloning ONLY the streamed entry — every
    // other message object keeps its identity (mirrors onStreamingChunk).
    act(() => {
      emitReactiveState(
        baseState(new Map([['stream-b', { ...streamB, content: 'partial plus more' }]]))
      );
    });

    // Only the streamed message re-rendered.
    expect(messageRenders.get('stream-b')).toBe((baseline.get('stream-b') || 0) + 1);
    // Task A's subtree — and task B's settled message — stayed quiet.
    expect(messageRenders.get('msg-a1')).toBe(baseline.get('msg-a1'));
    expect(messageRenders.get('msg-a2')).toBe(baseline.get('msg-a2'));
    expect(messageRenders.get('msg-b1')).toBe(baseline.get('msg-b1'));
  });

  it('a reactive notify with identical streaming content re-renders no message blocks', () => {
    const streamB = makeStreamingMessage('stream-b', 'task-b', 'partial');
    initialReactiveState = baseState(new Map([['stream-b', streamB]]));

    render(
      <ConversationView
        client={null}
        sessionId={SESSION_ID as any}
        sessionModel="model"
        forceExpandAll
      />
    );
    const baseline = new Map(messageRenders);

    // Same entries, fresh Map identity — e.g. an unrelated field changed on the
    // reactive state. The stable-ref grouping must absorb the Map churn.
    act(() => {
      emitReactiveState(baseState(new Map([['stream-b', streamB]])));
    });

    expect(messageRenders).toEqual(baseline);
  });
});
