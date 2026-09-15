import type { ReactiveSessionState, Session, Task } from '@agor-live/client';
import { TaskStatus } from '@agor-live/client';
import { act, fireEvent, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SessionLatestTaskPeek } from './SessionLatestTaskPeek';

const mock = vi.hoisted(() => ({ state: null as ReactiveSessionState | null }));
vi.mock('../../hooks/useSharedReactiveSession', () => ({
  useSharedReactiveSession: () => ({ handle: null, state: mock.state }),
}));
vi.mock('../../contexts/AppActionsContext', () => ({ useAppActions: () => ({}) }));
vi.mock('../../contexts/ConnectionContext', () => ({ useConnectionDisabled: () => false }));
vi.mock('../TaskBlock', () => ({ TaskBlock: () => <div>Task output</div> }));

const session = { session_id: 'session-1', status: 'idle' } as Session;
let frames: Map<number, FrameRequestCallback>;
let nextFrame: number;
let hidden = false;
function flushFrames() {
  act(() => {
    const pending = [...frames.values()];
    frames.clear();
    for (const callback of pending) callback(0);
  });
}
function visibility(value: boolean) {
  hidden = value;
  fireEvent(document, new Event('visibilitychange'));
}
function peek(enabled = true) {
  return (
    <SessionLatestTaskPeek client={null} session={session} userById={new Map()} enabled={enabled} />
  );
}
function streamUpdate() {
  if (!mock.state) throw new Error('missing state');
  mock.state = { ...mock.state, streamingMessages: new Map(mock.state.streamingMessages) };
}

beforeEach(() => {
  frames = new Map();
  nextFrame = 0;
  hidden = false;
  vi.spyOn(document, 'hidden', 'get').mockImplementation(() => hidden);
  vi.stubGlobal(
    'requestAnimationFrame',
    vi.fn((callback: FrameRequestCallback) => {
      frames.set(++nextFrame, callback);
      return nextFrame;
    })
  );
  vi.stubGlobal(
    'cancelAnimationFrame',
    vi.fn((id: number) => frames.delete(id))
  );
  mock.state = {
    sessionId: session.session_id,
    session,
    tasks: [{ task_id: 'task-1', status: TaskStatus.RUNNING } as Task],
    queuedTasks: [],
    messagesByTask: new Map(),
    streamingMessages: new Map(),
    toolsByTask: new Map(),
    loadedTaskIds: new Set(),
    connected: true,
    loading: false,
    error: null,
    terminal: false,
    lastSyncedAt: null,
  };
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('preview scroll scheduling', () => {
  it('coalesces updates, cancels on hide, and scrolls to latest on return', () => {
    const view = render(peek());
    const container = view.container.querySelector<HTMLDivElement>('.nowheel');
    if (!container) throw new Error('missing scroll container');
    Object.defineProperty(container, 'scrollHeight', { configurable: true, value: 900 });
    for (let i = 0; i < 20; i++) {
      streamUpdate();
      view.rerender(peek());
    }
    expect(frames.size).toBe(1);
    visibility(true);
    expect(frames.size).toBe(0);
    for (let i = 0; i < 400; i++) {
      streamUpdate();
      view.rerender(peek());
    }
    expect(frames.size).toBe(0);
    visibility(false);
    expect(frames.size).toBe(1);
    flushFrames();
    expect(container.scrollTop).toBe(900);
    streamUpdate();
    view.rerender(peek());
    view.unmount();
    expect(frames.size).toBe(0);
  });

  it('keeps initial hydration scrolling and respects user scroll intent on reappearance', () => {
    const view = render(peek());
    const container = view.container.querySelector<HTMLDivElement>('.nowheel');
    if (!container || !mock.state) throw new Error('missing fixture');
    Object.defineProperties(container, {
      scrollHeight: { configurable: true, value: 1000 },
      clientHeight: { configurable: true, value: 360 },
    });
    flushFrames();
    expect(container.scrollTop).toBe(1000);
    mock.state = { ...mock.state, loadedTaskIds: new Set(['task-1']) };
    container.scrollTop = 0;
    view.rerender(peek());
    flushFrames();
    expect(container.scrollTop).toBe(1000);
    fireEvent.wheel(container);
    container.scrollTop = 100;
    fireEvent.scroll(container);
    visibility(true);
    streamUpdate();
    view.rerender(peek());
    visibility(false);
    flushFrames();
    expect(container.scrollTop).toBe(100);
    view.unmount();
  });

  it('does not queue frames when initially hidden or disabled', () => {
    hidden = true;
    const view = render(peek());
    expect(frames.size).toBe(0);
    visibility(false);
    expect(frames.size).toBe(1);
    view.rerender(peek(false));
    expect(frames.size).toBe(0);
    visibility(true);
    visibility(false);
    expect(frames.size).toBe(0);
    view.rerender(peek());
    expect(frames.size).toBe(1);
    view.unmount();
  });
});
