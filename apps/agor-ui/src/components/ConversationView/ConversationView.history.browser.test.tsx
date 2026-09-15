import type { ReactiveSessionState } from '@agor-live/client';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { ConfigProvider } from 'antd';
import { Profiler } from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { largeSessionFixture } from '../../../../../test/fixtures/large-session';
import { ConversationView } from './ConversationView';

const feed = vi.hoisted(() => ({
  state: null as ReactiveSessionState | null,
  emit: (_state: ReactiveSessionState) => {},
}));
vi.mock('../../hooks/useSharedReactiveSession', async () => {
  const { useState } = await import('react');
  return {
    useSharedReactiveSession: () => {
      const [state, setState] = useState(feed.state);
      feed.emit = setState;
      return { state, handle: null };
    },
  };
});
afterEach(cleanup);

async function paint() {
  await act(async () => {
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  });
}

it('profiles a fictional large conversation with real task and Markdown renderers', async () => {
  const fixture = largeSessionFixture();
  const latest = fixture.tasks.at(-1)!;
  feed.state = {
    sessionId: fixture.sessionId,
    session: null,
    tasks: fixture.tasks,
    messagesByTask: new Map([
      [latest.task_id, fixture.messages.filter((m) => m.task_id === latest.task_id)],
    ]),
    queuedTasks: [],
    streamingMessages: new Map(),
    toolsByTask: new Map(),
    loadedTaskIds: new Set([latest.task_id]),
    connected: true,
    loading: false,
    error: null,
    terminal: false,
    lastSyncedAt: null,
  };
  const durations: number[] = [];
  const start = performance.now();
  const view = render(
    <ConfigProvider>
      <Profiler id="transcript" onRender={(_id, _phase, duration) => durations.push(duration)}>
        <div style={{ height: 600, display: 'flex', flexDirection: 'column' }}>
          <ConversationView client={null} sessionId={fixture.sessionId} />
        </div>
      </Profiler>
    </ConfigProvider>
  );
  await act(async () => {
    await expect
      .poll(() => view.container.querySelectorAll('[data-conversation-block]').length)
      .toBeGreaterThan(0);
  });
  await paint();
  const profile = {
    tasks: fixture.tasks.length,
    messages: fixture.messages.length,
    taskBytes: new TextEncoder().encode(JSON.stringify(fixture.tasks)).length,
    messageBytes: new TextEncoder().encode(JSON.stringify(fixture.messages)).length,
    mountedTasks: view.container.querySelectorAll('[data-task-block]').length,
    domNodes: view.container.querySelectorAll('*').length,
    commits: durations.length,
    reactMs: durations.reduce((a, b) => a + b, 0),
    contentMountedMs: performance.now() - start,
  };
  console.log('FICTIONAL_TRANSCRIPT_PROFILE', JSON.stringify(profile));
  expect(profile.mountedTasks, JSON.stringify(profile)).toBeLessThanOrEqual(30);
  expect(profile.domNodes).toBeLessThan(2500);

  const scroller = screen.getByTestId('conversation-scroll-container');
  await act(async () => {
    await expect
      .poll(() => Math.abs(scroller.scrollHeight - scroller.clientHeight - scroller.scrollTop))
      .toBeLessThan(2);
  });
  // Reading older headers must release the bottom lock before prepending.
  act(() => {
    scroller.scrollTop = 0;
  });
  await paint();
  const first = view.container.querySelector<HTMLElement>('[data-task-block]')!;
  const firstId = first.dataset.taskBlock;
  const top = first.getBoundingClientRect().top;
  fireEvent.click(screen.getByRole('button', { name: /Show older tasks/ }));
  await paint();
  expect(view.container.querySelectorAll('[data-task-block]')).toHaveLength(60);
  expect(first.dataset.taskBlock).toBe(firstId);
  expect(Math.abs(first.getBoundingClientRect().top - top)).toBeLessThan(2);

  // A realtime tail arrival cannot evict the reading anchor or repin it.
  const added = largeSessionFixture(501).tasks.at(-1)!;
  act(() => feed.emit({ ...feed.state!, tasks: [...fixture.tasks, added] }));
  await paint();
  expect(view.container.querySelectorAll('[data-task-block]')).toHaveLength(61);
  expect(Math.abs(first.getBoundingClientRect().top - top)).toBeLessThan(2);
  expect(view.container.querySelector(`[data-task-block="${added.task_id}"]`)).not.toBeNull();
});
