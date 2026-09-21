import { generateId } from '@agor/core/ids/browser';
import {
  type Message,
  MessageRole,
  PermissionStatus,
  type Task,
  TaskStatus,
} from '@agor-live/client';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
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
  tool_use_count: 0,
  git_state: { ref_at_start: 'main', sha_at_start: 'synthetic' },
};
const message = (index: number, role: MessageRole, content: Message['content']): Message => ({
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
const messages = [
  message(0, MessageRole.USER, 'Retained prompt'),
  message(1, MessageRole.ASSISTANT, 'Visible answer'),
];
function view(overrides: Partial<React.ComponentProps<typeof TaskBlock>> = {}) {
  return (
    <TaskBlock
      task={task}
      taskMessages={messages}
      taskMessagesLoaded={false}
      isExpanded={false}
      onExpandChange={vi.fn()}
      onLoadTaskMessages={vi.fn()}
      onUnloadTaskMessages={vi.fn()}
      leanTranscript
      {...overrides}
    />
  );
}

describe('lean task presentation', () => {
  it('shows both roles without a task accordion or automatic detail fetch; retains prompt through retry', async () => {
    const load = vi.fn().mockRejectedValueOnce(new Error('offline')).mockResolvedValue(undefined);
    const { container, rerender } = render(view({ onLoadTaskMessages: load }));
    expect(container.querySelector('.ant-collapse')).toBeNull();
    expect(screen.getByText('Retained prompt')).toBeVisible();
    expect(screen.getByText('Visible answer')).toBeVisible();
    expect(load).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Load tool activity' }));
    expect(await screen.findByText('Could not load tool activity. Try again.')).toBeVisible();
    expect(screen.getByText('Retained prompt')).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: 'Load tool activity' }));
    await waitFor(() => expect(load).toHaveBeenCalledTimes(2));
    rerender(view({ taskMessagesLoaded: true, onLoadTaskMessages: load }));
    expect(screen.getByText('No tool activity')).toBeVisible();
    expect(screen.getByText('Visible answer')).toBeVisible();
  });

  it('interleaves expanded activity between messages with tools initially collapsed', () => {
    const call = message(1, MessageRole.ASSISTANT, [
      { type: 'text', text: 'Before activity' },
      { type: 'tool_use', id: 'read-call', name: 'Read', input: { file_path: 'synthetic.txt' } },
      { type: 'tool_result', tool_use_id: 'read-call', content: 'RESULT_CANARY' },
      { type: 'text', text: 'After activity' },
    ]);
    render(view({ taskMessages: [messages[0], call], taskMessagesLoaded: true }));
    const tool = screen.getByRole('button', { name: /Read/ });
    expect(tool).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByText('RESULT_CANARY')).not.toBeInTheDocument();
    expect(
      screen.getByText('Before activity').compareDocumentPosition(tool) &
        Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy();
    expect(
      tool.compareDocumentPosition(screen.getByText('After activity')) &
        Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy();
    fireEvent.click(tool);
    expect(screen.getByText('RESULT_CANARY')).toBeVisible();
  });

  it('does not blank failed or assistant-only tasks, and leaves pending approvals visible', () => {
    const failure = { ...task, status: TaskStatus.FAILED, error_message: 'Synthetic failure' };
    const result = render(view({ task: failure, taskMessages: [] }));
    expect(screen.getByText('Retained prompt')).toBeVisible();
    expect(screen.getByText('Synthetic failure')).toBeVisible();
    result.rerender(view({ task: { ...task, full_prompt: '' }, taskMessages: [messages[1]] }));
    expect(screen.getByText('Visible answer')).toBeVisible();
    expect(screen.getByRole('button', { name: 'Load tool activity' })).toBeVisible();
    result.rerender(
      view({
        task: { ...task, status: TaskStatus.AWAITING_PERMISSION },
        sessionId: task.session_id,
        onPermissionDecision: vi.fn(),
        taskMessages: [
          ...messages,
          {
            ...message(2, MessageRole.SYSTEM, {
              request_id: 'approval',
              tool_name: 'Bash',
              tool_input: { command: 'echo synthetic' },
              status: PermissionStatus.PENDING,
            }),
            type: 'permission_request',
          },
        ],
      })
    );
    expect(screen.getByRole('button', { name: /Approve/ })).toBeVisible();
    expect(screen.getByRole('button', { name: /Deny/ })).toBeVisible();
  });
});
