import { generateId } from '@agor/core/ids/browser';
import { type Message, MessageRole, type Task, TaskStatus } from '@agor-live/client';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { TaskBlock } from './TaskBlock';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

it.each(['task-first', 'message-first', 'task-patch-before-message'])(
  'keeps one formatted prompt and its DOM through %s delivery',
  async (order) => {
    const task: Task = {
      task_id: generateId(),
      session_id: generateId(),
      created_by: '',
      full_prompt: '# Prompt\n\n**bold** and `code`\n\n- one\n- two',
      status: TaskStatus.DISPATCHING,
      created_at: '2026-09-24T00:00:00Z',
      message_range: { start_index: 0, end_index: 0, start_timestamp: '2026-09-24T00:00:00Z' },
      git_state: { ref_at_start: 'main', sha_at_start: 'synthetic' },
    };
    const message: Message = {
      message_id: generateId(),
      task_id: task.task_id,
      session_id: task.session_id,
      role: MessageRole.USER,
      type: 'user',
      content: task.full_prompt,
      content_preview: '',
      timestamp: task.created_at,
      index: 0,
    };
    const view = (messages: Message[], patched = false) => (
      <TaskBlock
        task={patched ? { ...task, status: TaskStatus.RUNNING } : task}
        taskMessages={messages}
        taskMessagesLoaded={false}
        onLoadTaskMessages={vi.fn()}
        isLatestTask
        compact={window.innerWidth <= 480}
      />
    );
    const { container, rerender } = render(view(order === 'message-first' ? [message] : []));
    const bubble = container.querySelector('.ant-bubble')!;
    const metadata = container.querySelector('[aria-label="User prompt and turn metadata"]')!;
    expect(bubble).not.toBeNull();
    expect(bubble.textContent).toContain('bold and code');
    expect(bubble.textContent).not.toContain('**bold**');
    const height = bubble.getBoundingClientRect().height;
    const sample = () => {
      expect(metadata.querySelectorAll('.ant-bubble')).toHaveLength(1);
      expect(container.querySelector('.ant-bubble')).toBe(bubble);
      expect(container.querySelector('[aria-label="User prompt and turn metadata"]')).toBe(
        metadata
      );
      expect(bubble.getBoundingClientRect().height).toBeCloseTo(height, 1);
    };
    // A confirmed status patch can arrive before the initial message.
    if (order === 'task-patch-before-message') {
      rerender(view([], true));
      sample();
    }
    rerender(view([message]));
    sample();
    await new Promise<void>((resolve) =>
      requestAnimationFrame(() => {
        sample();
        resolve();
      })
    );
    // Canonical content wins; other (even equal-text) user messages remain separate.
    const changed = { ...message, content: 'Canonical content' };
    const later = { ...message, message_id: generateId(), index: 2 };
    rerender(view([changed, later]));
    expect(container.querySelectorAll('.ant-bubble')).toHaveLength(2);
    expect(container.querySelector('.ant-bubble')).toBe(bubble);
    expect(bubble.textContent).toContain('Canonical content');
    const copy = vi.spyOn(navigator.clipboard, 'writeText').mockResolvedValue(undefined);
    fireEvent.mouseOver(screen.getByText('Canonical content'));
    fireEvent.click(bubble.querySelector('[aria-label="copy"]')!);
    expect(copy).toHaveBeenCalledWith('Canonical content');
    expect(
      Array.from(container.querySelectorAll('[data-conversation-block]'))
        .map((el) => el.textContent)
        .join('|')
    ).toMatch(/Canonical content[\s\S]*bold and code/);
  }
);
