import { generateId } from '@agor/core/ids/browser';
import {
  type Message,
  MessageRole,
  type Task,
  TaskStatus,
  type ToolExecutionState,
} from '@agor-live/client';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { userEvent } from 'vitest/browser';
import { TaskBlock } from './TaskBlock';

afterEach(cleanup);

it('keeps the collapsed tail at one header and constant height in every staged handoff frame', async () => {
  const task: Task = {
    task_id: generateId(),
    session_id: generateId(),
    created_by: '',
    full_prompt: '',
    status: TaskStatus.RUNNING,
    created_at: '2026-09-22T00:00:00.000Z',
    git_state: { ref_at_start: 'main', sha_at_start: 'synthetic' },
  };
  const call = (index: number): Message => ({
    message_id: generateId(),
    task_id: task.task_id,
    session_id: task.session_id,
    role: MessageRole.ASSISTANT,
    type: 'assistant',
    index,
    timestamp: task.created_at,
    content_preview: '',
    content: [
      {
        type: 'tool_use',
        id: `call-${index}`,
        name: 'Read',
        input: { file_path: `file-${index}.txt` },
      },
      { type: 'tool_result', tool_use_id: `call-${index}`, content: `result-${index}` },
    ],
  });
  const calls = [call(1), call(2), call(3)];
  const view = (
    messages: Message[],
    index: number,
    status: ToolExecutionState['status'] = 'executing',
    complete = false
  ) => (
    <TaskBlock
      task={complete ? { ...task, status: TaskStatus.COMPLETED } : task}
      taskMessages={messages}
      taskMessagesLoaded
      onLoadTaskMessages={vi.fn()}
      isLatestTask
      compact={window.innerWidth <= 480}
      latestActivity={{ toolUseId: `call-${index}`, toolName: 'Read', status }}
    />
  );
  const { container, rerender } = render(view([calls[0]], 1));
  const header = screen.getByRole('button', { name: 'Running: Read' });
  const wrapper = header.closest('[data-conversation-block]')!;
  const height = container.getBoundingClientRect().height;
  const frames: Array<{ headers: number; height: number }> = [];
  // Every explicit rerender is a separately observable event/message state,
  // sampled synchronously AND at the next paint, not a settled-only snapshot.
  const sample = async () => {
    const capture = () => {
      const headers = container.querySelectorAll('button[aria-busy]');
      frames.push({ headers: headers.length, height: container.getBoundingClientRect().height });
      expect(headers).toHaveLength(1);
      expect(headers[0]).toBe(header);
      expect(header.closest('[data-conversation-block]')).toBe(wrapper);
      expect(header).toHaveAttribute('aria-expanded', 'false');
      expect(container.getBoundingClientRect().height).toBeCloseTo(height, 1);
      expect(container.scrollWidth).toBeLessThanOrEqual(window.innerWidth);
    };
    capture();
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    capture();
  };
  await sample();
  rerender(view([calls[0]], 2)); // Event before persistence: base renders two headers.
  await sample();
  rerender(view([calls[0]], 2)); // Duplicate event.
  await sample();
  rerender(view([calls[0]], 2, 'complete'));
  await sample();
  expect(header).toHaveTextContent('Latest: Read');
  rerender(view(calls.slice(0, 2), 3)); // Partial persistence while next call starts.
  await sample();
  rerender(view([...calls].reverse(), 3, 'complete')); // Reconciled, reordered input.
  await sample();
  expect(frames).toHaveLength(12);

  await userEvent.click(header);
  const firstTool = screen.getByRole('button', { name: /Read file-1.txt/ });
  await userEvent.click(firstTool);
  expect(screen.getAllByText('result-1')).toHaveLength(1);
  rerender(view([...calls], 3, 'complete', true));
  expect(screen.getByRole('button', { name: '3 tool calls' })).toBe(header);
  expect(header).toHaveAttribute('aria-expanded', 'true');
  expect(header).toHaveAttribute('aria-busy', 'false');
  expect(screen.getByRole('button', { name: /Read file-1.txt/ })).toBe(firstTool);
  expect(screen.getAllByText('result-1')).toHaveLength(1);
  expect(container.querySelector('.ant-thought-chain-motion-blink')).toBeNull();
});
