import { generateId } from '@agor/core/ids/browser';
import { type Message, MessageRole, type Task, TaskStatus } from '@agor-live/client';
import { cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TaskBlock } from './TaskBlock';

afterEach(cleanup);

const task: Task = {
  task_id: generateId(),
  session_id: generateId(),
  created_by: '',
  full_prompt: 'Retained prompt',
  status: TaskStatus.COMPLETED,
  created_at: '2026-09-01T00:00:00.000Z',
  model: 'synthetic-model',
  git_state: { ref_at_start: 'main', sha_at_start: 'synthetic' },
};

const message = (index: number, role: MessageRole, content: string): Message => ({
  message_id: generateId(),
  task_id: task.task_id,
  session_id: task.session_id,
  index,
  role,
  type: role === MessageRole.USER ? 'user' : 'assistant',
  timestamp: task.created_at,
  content_preview: '',
  content,
});

const view = (taskMessages: Message[]) =>
  render(
    <TaskBlock
      task={task}
      taskMessages={taskMessages}
      taskMessagesLoaded
      onLoadTaskMessages={vi.fn()}
    />
  );

const counts = (container: HTMLElement) => ({
  avatars: container.querySelectorAll('.ant-bubble-avatar .ant-avatar').length,
  spacers: container.querySelectorAll('[data-testid="avatar-spacer"]').length,
});

/** A turn still running, so the footer and avatars are exercised mid-stream. */
const streaming = (props: Partial<React.ComponentProps<typeof TaskBlock>>) => (
  <TaskBlock
    task={{ ...task, status: TaskStatus.RUNNING }}
    taskMessages={[message(0, MessageRole.USER, 'Do the thing')]}
    taskMessagesLoaded
    onLoadTaskMessages={vi.fn()}
    {...props}
  />
);

describe('TaskBlock avatar grouping', () => {
  it('shows one avatar per run of consecutive same-speaker messages', () => {
    const { container } = view([
      message(0, MessageRole.USER, 'Do the thing'),
      message(1, MessageRole.ASSISTANT, 'Looking into it'),
      message(2, MessageRole.ASSISTANT, 'Still looking'),
      message(3, MessageRole.ASSISTANT, 'Done'),
    ]);

    // One avatar for the prompt, one for the agent run that follows it.
    expect(counts(container)).toEqual({ avatars: 2, spacers: 2 });
  });

  it('re-introduces a speaker when the run is broken by the other speaker', () => {
    const { container } = view([
      message(0, MessageRole.USER, 'Do the thing'),
      message(1, MessageRole.ASSISTANT, 'Looking into it'),
      message(2, MessageRole.USER, 'Actually, wait'),
      message(3, MessageRole.ASSISTANT, 'Stopped'),
    ]);

    expect(counts(container)).toEqual({ avatars: 4, spacers: 0 });
  });
});

describe('TaskBlock avatars while streaming', () => {
  it('keeps already-rendered avatars stable as more messages stream in', () => {
    const streamed = [
      message(0, MessageRole.USER, 'Do the thing'),
      message(1, MessageRole.ASSISTANT, 'First'),
    ];
    const { container, rerender } = render(streaming({ taskMessages: streamed }));
    // Absolute counts would also pick up the live typing indicator's avatar;
    // what matters is that streaming adds no avatar and moves none.
    const avatarNodes = () => [...container.querySelectorAll('.ant-bubble-avatar .ant-avatar')];
    const before = avatarNodes();
    expect(counts(container).spacers).toBe(0);

    for (const [index, extra] of ['Second', 'Third'].entries()) {
      streamed.push(message(2 + index, MessageRole.ASSISTANT, extra));
      rerender(streaming({ taskMessages: [...streamed] }));

      const now = avatarNodes();
      expect(now).toHaveLength(before.length);
      for (const [i, node] of before.entries()) expect(now[i]).toBe(node);
      // Each appended message extends the run with a spacer instead.
      expect(counts(container).spacers).toBe(index + 1);
    }
  });
});
