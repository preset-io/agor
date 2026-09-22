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
    fireEvent.click(screen.getByRole('button', { name: 'Tool calls', expanded: false }));
    expect(
      await screen.findByRole('button', { name: 'Couldn’t load tool activity · Retry' })
    ).toBeVisible();
    expect(screen.getByText('Retained prompt')).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: 'Couldn’t load tool activity · Retry' }));
    await waitFor(() => expect(load).toHaveBeenCalledTimes(2));
    rerender(view({ taskMessagesLoaded: true, onLoadTaskMessages: load }));
    expect(screen.getByText('No tool calls')).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: 'Tool calls', expanded: true }));
    expect(screen.queryByText('No tool calls')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Tool calls', expanded: false }));
    expect(screen.getByText('No tool calls')).toBeVisible();
    expect(load).toHaveBeenCalledTimes(2);
    expect(screen.getByText('Visible answer')).toBeVisible();
  });

  it('implies success without a standalone icon and keeps failure visible without hover', () => {
    const { container, rerender } = render(view());
    expect(container.querySelector('[data-task-block] > .anticon-check-circle')).toBeNull();
    rerender(view({ task: { ...task, status: TaskStatus.FAILED } }));
    expect(screen.getByRole('alert')).toHaveTextContent('Turn failed');
    rerender(
      view({ task: { ...task, status: TaskStatus.FAILED, error_message: 'Request failed' } })
    );
    expect(screen.getByRole('alert')).toHaveTextContent('Request failed');
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
    expect(screen.getByRole('button', { name: 'Tool calls', expanded: false })).toBeVisible();
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
    const promptRegion = screen.getByRole('region', { name: 'User prompt and turn metadata' });
    expect(Number.parseFloat(promptRegion.style.paddingBottom)).toBeGreaterThan(0);
  });
});

it('opens only the first fetched group, retaining chronological messages and user collapse choice', async () => {
  const load = vi.fn(async () => {});
  const { rerender } = render(view({ onLoadTaskMessages: load }));
  fireEvent.click(screen.getByRole('button', { name: 'Tool calls', expanded: false }));
  await waitFor(() => expect(load).toHaveBeenCalledTimes(1));
  const activity = (index: number, name: string) =>
    message(index, MessageRole.ASSISTANT, [
      { type: 'tool_use', id: `call-${index}`, name, input: {} },
      { type: 'tool_result', tool_use_id: `call-${index}`, content: 'Result' },
    ]);
  const full = [
    messages[0],
    activity(1, 'Read'),
    message(2, MessageRole.ASSISTANT, 'Between groups'),
    activity(3, 'Bash'),
  ];
  rerender(view({ onLoadTaskMessages: load, taskMessages: full, taskMessagesLoaded: true }));
  expect(screen.getByRole('button', { name: '1 tool call', expanded: true })).toHaveAttribute(
    'aria-expanded',
    'true'
  );
  expect(screen.getByRole('button', { name: '1 tool call', expanded: false })).toHaveAttribute(
    'aria-expanded',
    'false'
  );
  expect(screen.getByText('Between groups')).toBeVisible();
  fireEvent.click(screen.getByRole('button', { name: '1 tool call', expanded: true }));
  rerender(view({ onLoadTaskMessages: load, taskMessages: [...full], taskMessagesLoaded: true }));
  expect(screen.getAllByRole('button', { name: '1 tool call', expanded: false })).toHaveLength(2);
  expect(load).toHaveBeenCalledTimes(1);
});

it('renders a real tool event before persistence and hands it to the recorded group without duplication', () => {
  const running = { ...task, status: TaskStatus.RUNNING };
  const latestActivity = { toolUseId: 'live', toolName: 'Read', status: 'executing' as const };
  const { rerender } = render(view({ task: running, latestActivity, isLatestTask: true }));
  expect(screen.getByRole('button', { name: 'Running: Read', expanded: false })).toBeVisible();
  const tool = message(2, MessageRole.ASSISTANT, [
    { type: 'tool_use', id: 'live', name: 'Read', input: {} },
  ]);
  rerender(
    view({ task: running, latestActivity, isLatestTask: true, taskMessages: [...messages, tool] })
  );
  expect(screen.getAllByRole('button', { name: 'Running: Read', expanded: false })).toHaveLength(1);
  rerender(
    view({
      task: running,
      latestActivity: { ...latestActivity, status: 'complete' },
      isLatestTask: true,
      taskMessages: [...messages, tool],
    })
  );
  expect(screen.getByRole('button', { name: 'Latest: Read', expanded: false })).toHaveAttribute(
    'aria-expanded',
    'false'
  );
});

it('removes the standalone live spinner while retaining startup, stopping and approval feedback', () => {
  const { container, rerender } = render(view({ task: { ...task, status: TaskStatus.RUNNING } }));
  expect(container.querySelector('[data-task-block] > .ant-spin')).toBeNull();
  // The response bubble still supplies progress before the first tool/text arrives.
  expect(container.querySelector('.ant-bubble')).not.toBeNull();
  rerender(view({ task: { ...task, status: TaskStatus.DISPATCHING } }));
  expect(screen.queryByText('Starting turn…')).toBeNull();
  rerender(view({ task: { ...task, status: TaskStatus.STOPPING } }));
  expect(screen.getByRole('status')).toHaveTextContent('Stopping');
  rerender(
    view({
      task: { ...task, status: TaskStatus.AWAITING_PERMISSION },
      latestActivity: { toolUseId: 'pending', toolName: 'Read', status: 'executing' },
    })
  );
  expect(container.querySelector('.ant-thought-chain-motion-blink')).toBeNull();
});
