import { generateId } from '@agor/core/ids/browser';
import { leanMessage, type Message, MessageRole, type Task, TaskStatus } from '@agor-live/client';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, expect, it } from 'vitest';
import { TaskBlock } from './TaskBlock';

afterEach(cleanup);

const noop = () => {};
const retain = () => noop;

// Test-only React internals: inspect BOTH trees, not just visible DOM/cache data.
interface Fiber {
  return: Fiber | null;
  child: Fiber | null;
  sibling: Fiber | null;
  alternate: Fiber | null;
  stateNode: { current?: Fiber } | null;
  pendingProps: unknown;
  memoizedProps: unknown;
}

function retainedFiberProps(container: HTMLElement, target: object) {
  const element = container.firstElementChild!;
  const key = Object.keys(element).find((key) => key.startsWith('__reactFiber$'))!;
  let root = (element as unknown as Record<string, Fiber>)[key];
  while (root.return) root = root.return;
  root = root.stateNode!.current!;
  const current = new Set<Fiber>();
  const visitCurrent = (fiber: Fiber | null) => {
    if (!fiber || current.has(fiber)) return;
    current.add(fiber);
    visitCurrent(fiber.child);
    visitCurrent(fiber.sibling);
  };
  visitCurrent(root);
  const reaches = (value: unknown, seen = new Set<object>()): boolean => {
    if (value === target) return true;
    if (!value || typeof value !== 'object' || seen.has(value)) return false;
    seen.add(value);
    // React debug ownership is not a data prop. GC below checks ALL retainers.
    return Object.entries(value).some(
      ([key, child]) => !key.startsWith('_') && reaches(child, seen)
    );
  };
  const counts = { current: 0, alternate: 0 };
  const visited = new Set<Fiber>();
  const pending = [root];
  while (pending.length) {
    const fiber = pending.pop()!;
    if (visited.has(fiber)) continue;
    visited.add(fiber);
    if (reaches(fiber.pendingProps) || reaches(fiber.memoizedProps)) {
      counts[current.has(fiber) ? 'current' : 'alternate']++;
    }
    for (const next of [fiber.child, fiber.sibling, fiber.alternate]) {
      if (next) pending.push(next);
    }
  }
  return counts;
}

// Return only weak observations and scalar graph counts. Neither the test's async frame
// nor its render helpers may keep the original message/content alive.
function mountThenProject(kind: 'tool' | 'thinking') {
  const task: Task = {
    task_id: generateId(),
    session_id: generateId(),
    created_by: '',
    full_prompt: 'Retained prompt',
    status: TaskStatus.COMPLETED,
    created_at: '2026-09-25T00:00:00Z',
    message_range: { start_index: 0, end_index: 1, start_timestamp: '2026-09-25T00:00:00Z' },
    git_state: { ref_at_start: 'main', sha_at_start: 'synthetic' },
    recorded_tool_count: kind === 'tool' ? 1 : 0,
  };
  const message: Message = {
    message_id: generateId(),
    task_id: task.task_id,
    session_id: task.session_id,
    role: MessageRole.ASSISTANT,
    type: 'assistant',
    index: 1,
    timestamp: task.created_at,
    content_preview: '',
    content:
      kind === 'tool'
        ? [
            { type: 'tool_use', id: 'read', name: 'Read', input: { file_path: '/fixture' } },
            { type: 'tool_result', tool_use_id: 'read', content: 'private result'.repeat(1024) },
          ]
        : [
            { type: 'thinking', text: 'private reasoning'.repeat(1024) },
            { type: 'text', text: '' },
          ],
  };
  const weak = new WeakRef(message.content as object);
  const view = (messages: Message[], loaded: boolean) => (
    <TaskBlock
      task={task}
      taskMessages={messages}
      taskMessagesLoaded={loaded}
      onLoadTaskMessages={noop}
      onRetainTaskDetails={retain}
    />
  );
  // RTL's root wrapper itself closes over its initial JSX; keep that empty.
  const { container, rerender } = render(null);
  rerender(view([message], false));
  const lean = leanMessage(message);
  // Live eviction does not toggle loadedTaskIds. The component must retire
  // both Fiber buffers itself; the harness performs only this one lean update.
  rerender(view([lean], false));
  return { weak, retainedProps: retainedFiberProps(container, message.content as object) };
}

it.each(['tool', 'thinking'] as const)(
  'collects evicted %s content while the TaskBlock stays mounted',
  async (kind) => {
    const { weak, retainedProps } = mountThenProject(kind);
    expect(retainedProps).toEqual({ current: 0, alternate: 0 });
    const gc = (globalThis as typeof globalThis & { gc: () => void }).gc;
    expect(typeof gc).toBe('function');
    // WeakRef targets survive the current JS job. Yield before every GC and
    // never pass the dereferenced object to Vitest (assertion reports retain it).
    let collected = false;
    for (let attempt = 0; attempt < 10; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 50));
      gc();
      collected = weak.deref() === undefined;
      if (collected) break;
    }
    expect(screen.getByText('Retained prompt')).toBeVisible();
    expect(collected).toBe(true);
  }
);
