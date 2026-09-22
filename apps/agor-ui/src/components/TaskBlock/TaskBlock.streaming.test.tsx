import { generateId } from '@agor/core/ids/browser';
import {
  type Message,
  MessageRole,
  type StreamingMessageState,
  type Task,
  TaskStatus,
  type ToolExecutionState,
} from '@agor-live/client';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { TaskBlock } from './TaskBlock';

afterEach(cleanup);
const task: Task = {
  task_id: generateId(),
  session_id: generateId(),
  created_by: '',
  full_prompt: 'Synthetic turn',
  status: TaskStatus.RUNNING,
  created_at: '2026-09-22T00:00:00.000Z',
  git_state: { ref_at_start: 'main', sha_at_start: 'synthetic' },
};
const call = (index: number, name = 'Read'): Message => ({
  message_id: generateId(),
  task_id: task.task_id,
  session_id: task.session_id,
  index,
  role: MessageRole.ASSISTANT,
  type: 'assistant',
  timestamp: task.created_at,
  content_preview: '',
  content: [{ type: 'tool_use', id: `call-${index}`, name, input: {} }],
});
const activity = (
  index: number,
  status: ToolExecutionState['status'] = 'executing'
): ToolExecutionState => ({
  toolUseId: `call-${index}`,
  toolName: index === 1 ? 'Read' : 'Bash',
  status,
});
function view(
  messages: Message[],
  latestActivity: ToolExecutionState,
  overrides: Partial<React.ComponentProps<typeof TaskBlock>> = {}
) {
  return (
    <TaskBlock
      task={task}
      taskMessages={messages}
      taskMessagesLoaded
      isLatestTask
      latestActivity={latestActivity}
      onLoadTaskMessages={vi.fn()}
      {...overrides}
    />
  );
}
const headers = () =>
  screen
    .getAllByRole('button')
    .filter((button) => /^(Running:|Latest:|\d+ tool|Reasoning)/.test(button.textContent ?? ''));

it.each([false, true])(
  'keeps one disclosure through staged consecutive calls and partial persistence (expanded=%s)',
  (expanded) => {
    const first = call(1);
    const second = call(2, 'Bash');
    const third = call(3, 'Bash');
    const { rerender } = render(view([first], activity(1)));
    const header = headers()[0];
    if (expanded) fireEvent.click(header);
    const assertSingle = () => {
      expect(headers()).toHaveLength(1);
      expect(headers()[0]).toBe(header);
      expect(header).toHaveAttribute('aria-expanded', String(expanded));
    };
    // tool:start arrives BEFORE the new call's message (the regression frame).
    rerender(view([first], activity(2)));
    assertSingle();
    expect(header).toHaveTextContent('Running: Bash');
    // Duplicate notification and completion before persistence.
    rerender(view([first], activity(2)));
    assertSingle();
    rerender(view([first], activity(2, 'complete')));
    assertSingle();
    expect(header).toHaveTextContent('Latest: Bash');
    const streaming = new Map<string, StreamingMessageState>([
      [
        second.message_id,
        {
          message_id: second.message_id,
          session_id: task.session_id,
          task_id: task.task_id,
          role: 'assistant',
          timestamp: task.created_at,
          content: '',
          thinkingContent: '',
          isStreaming: true,
        },
      ],
    ]);
    rerender(view([first], activity(2), { streamingMessages: streaming }));
    assertSingle();
    // The next event arrives before the second call's message is recorded.
    rerender(view([first], activity(3), { streamingMessages: streaming }));
    assertSingle();
    // messages.created removes the matching stream in the same client update.
    rerender(view([second, first], activity(3)));
    assertSingle();
    rerender(view([third, second, first], activity(3, 'complete')));
    assertSingle();
    rerender(
      view([third, second, first], activity(3, 'complete'), {
        task: { ...task, status: TaskStatus.COMPLETED },
      })
    );
    assertSingle();
    expect(header).toHaveTextContent('3 tool calls');
    if (!expanded) fireEvent.click(header);
    expect(screen.getAllByRole('button', { name: /Read$|Bash$/ })).toHaveLength(3);
  }
);

it('does not split a chain around an empty streamed text block', () => {
  const first = call(1);
  const second = { ...call(2), content: [{ type: 'text', text: '' }] };
  const { rerender } = render(view([first], activity(1)));
  const header = headers()[0];
  rerender(view([first, second], activity(2)));
  expect(headers()).toEqual([header]);
  rerender(
    view(
      [
        first,
        {
          ...second,
          content: [
            { type: 'text', text: '' },
            { type: 'tool_use', id: 'call-2', name: 'Bash', input: {} },
          ],
        },
      ],
      activity(2)
    )
  );
  expect(headers()).toEqual([header]);
});

it('preserves real assistant-text boundaries and does not reattach a delayed known event to the tail', () => {
  const first = call(1);
  const text = { ...call(2), content: 'Between groups' };
  const third = call(3, 'Bash');
  const { rerender } = render(view([first, text], activity(3)));
  expect(headers()).toHaveLength(2);
  expect(screen.getByText('Between groups')).toBeVisible();
  rerender(view([first, text, third], activity(3)));
  expect(headers()).toHaveLength(2);
  rerender(view([first, text, third], activity(1, 'complete')));
  expect(headers()).toHaveLength(2);
  expect(headers()[1]).toHaveTextContent('Running: Bash');
});

it('keeps event feedback visible through an empty first streamed message and its tool payload', () => {
  const first = { ...call(1), content: [{ type: 'text', text: '' }] };
  const { rerender } = render(view([first], activity(1)));
  const header = screen.getByRole('button', { name: 'Running: Read' });
  fireEvent.click(header);
  rerender(view([{ ...call(1), message_id: first.message_id }], activity(1)));
  expect(headers()).toEqual([header]);
  expect(header).toHaveAttribute('aria-expanded', 'true');
  expect(screen.getAllByRole('button', { name: /Read$/ })).toHaveLength(2);
});

it('reconciles result-chain ownership when its parent Task arrives later', () => {
  const delegation: Message = {
    ...call(1, 'Task'),
    tool_uses: [{ id: 'call-1', name: 'Task', input: {} }],
  };
  const result: Message = {
    ...call(2),
    role: MessageRole.USER,
    type: 'user',
    content: [{ type: 'tool_result', tool_use_id: 'call-1', content: 'Nested result' }],
  };
  const { rerender } = render(view([result], activity(3)));
  const header = screen.getByRole('button', { name: 'Running: Bash' });
  fireEvent.click(header);
  // The result reference and group key stay the same; only its ownership changes.
  rerender(view([delegation, result], activity(3)));
  expect(screen.getByRole('button', { name: 'Reasoning' })).toBe(header);
  expect(header).toHaveAttribute('aria-expanded', 'true');
  expect(screen.getByRole('button', { name: 'Running: Bash' })).toBeVisible();
});
