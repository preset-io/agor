import { generateId } from '@agor/core/ids/browser';
import {
  type Message,
  MessageRole,
  PermissionStatus,
  type Task,
  TaskStatus,
} from '@agor-live/client';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { App } from 'antd';
import { useLayoutEffect, useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { HistoryTextChoices } from '../MessageBlock/HistoryMarkdown';
import { TaskBlock } from './TaskBlock';

afterEach(cleanup);
const ENOENT_SYSTEM_PROMPT =
  "ENOENT: no such file or directory, open '/usr/lib/node_modules/agor-live/dist/core/templates/agor-system-prompt.md'";
const outcome = () => document.querySelector<HTMLElement>('[data-turn-outcome]');
const task: Task = {
  task_id: generateId(),
  session_id: generateId(),
  created_by: '',
  full_prompt: 'Retained prompt',
  status: TaskStatus.COMPLETED,
  created_at: '2026-09-01T00:00:00.000Z',
  executor_connected_at: '2026-09-01T00:00:01.000Z',
  model: 'synthetic-model',
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
      onLoadTaskMessages={vi.fn()}
      {...overrides}
    />
  );
}

describe('lean task presentation', () => {
  it('keeps deferred reasoning reachable even with a verified zero tool count', async () => {
    const load = vi.fn().mockResolvedValue(undefined);
    const reasoning = { ...message(1, MessageRole.ASSISTANT, []), has_deferred_reasoning: true };
    const props = {
      task: { ...task, recorded_tool_count: 0 },
      taskMessages: [messages[0], reasoning],
      onLoadTaskMessages: load,
    };
    const { rerender } = render(view(props));
    expect(load).not.toHaveBeenCalled();
    expect(
      screen.getByRole('button', { name: 'Reasoning' }).querySelector('.ant-tag')
    ).toHaveTextContent(/^0$/);
    fireEvent.click(screen.getByRole('button', { name: 'Reasoning' }));
    await waitFor(() => expect(load).toHaveBeenCalledTimes(1));
    rerender(
      view({
        ...props,
        taskMessagesLoaded: true,
        taskMessages: [
          messages[0],
          { ...reasoning, content: [{ type: 'thinking', text: 'Saved reasoning' }] },
        ],
      })
    );
    expect(screen.queryByText('No tool calls')).toBeNull();
    expect(screen.getByText('Saved reasoning')).toBeVisible();
  });

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
    expect(outcome()).toHaveTextContent('The agent hit a problem.');
    expect(screen.getByRole('button', { name: 'Details' })).toBeVisible();
    rerender(
      view({ task: { ...task, status: TaskStatus.FAILED, error_message: ENOENT_SYSTEM_PROMPT } })
    );
    expect(screen.queryByText(ENOENT_SYSTEM_PROMPT)).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Details' }));
    expect(screen.getByText(ENOENT_SYSTEM_PROMPT)).toBeVisible();
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
    const failure = { ...task, status: TaskStatus.FAILED, error_message: ENOENT_SYSTEM_PROMPT };
    const result = render(view({ task: failure, taskMessages: [] }));
    expect(screen.getByText('Retained prompt')).toBeVisible();
    expect(outcome()).toHaveTextContent('The agent hit a problem.');
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
  expect(screen.getByRole('status')).toHaveTextContent('Stopping the agent…');
  expect(screen.getByRole('status')).toHaveAttribute('data-notice-type', 'info');
  rerender(
    view({
      task: { ...task, status: TaskStatus.AWAITING_PERMISSION },
      latestActivity: { toolUseId: 'pending', toolName: 'Read', status: 'executing' },
    })
  );
  expect(container.querySelector('.ant-thought-chain-motion-blink')).toBeNull();
});

it('uses only verified recorded counts, never legacy zero; streamed tools override snapshots', () => {
  const load = vi.fn();
  const { rerender } = render(view({ onLoadTaskMessages: load }));
  expect(screen.getByRole('button', { name: 'Tool calls' })).toBeVisible();
  rerender(view({ task: { ...task, recorded_tool_count: 0 }, onLoadTaskMessages: load }));
  expect(screen.queryByRole('button', { name: 'Tool calls' })).toBeNull();
  expect(screen.getByText('Retained prompt')).toBeVisible();
  expect(screen.getByText('Visible answer')).toBeVisible();
  expect(load).not.toHaveBeenCalled();
  rerender(view({ task: { ...task, recorded_tool_count: 2 }, onLoadTaskMessages: load }));
  fireEvent.click(screen.getByRole('button', { name: '2 tool calls' }));
  expect(load).toHaveBeenCalledTimes(1);
  rerender(
    view({
      task: { ...task, recorded_tool_count: 0, status: TaskStatus.RUNNING },
      taskMessages: [
        ...messages,
        message(2, MessageRole.ASSISTANT, [
          { type: 'tool_use', id: 'active', name: 'Read', input: {} },
        ]),
      ],
      taskMessagesLoaded: true,
    })
  );
  expect(screen.getByRole('button', { name: /Read/ })).toBeVisible();
});

it.each(Object.values(TaskStatus))(
  'places %s status deliberately, never in the old top icon slot',
  (status) => {
    const { container } = render(view({ task: { ...task, status } }));
    const root = container.querySelector('[data-task-block]')!;
    expect(root.querySelector(':scope > .anticon')).toBeNull();
    const outcome = root.querySelector('[data-turn-outcome]');
    if (
      new Set<TaskStatus>([
        TaskStatus.STOPPING,
        TaskStatus.STOPPED,
        TaskStatus.FAILED,
        TaskStatus.TIMED_OUT,
      ]).has(status)
    ) {
      expect(outcome).toBeVisible();
      expect(root.lastElementChild).toBe(outcome);
      expect(screen.getByText('Visible answer').compareDocumentPosition(outcome!)).toBe(
        Node.DOCUMENT_POSITION_FOLLOWING
      );
    } else {
      expect(outcome).toBeNull();
    }
  }
);

it('alerts on a live failure, offers Resume only when the session can start a turn, and stays last', () => {
  const client = {} as NonNullable<React.ComponentProps<typeof TaskBlock>['client']>;
  const interrupted = {
    ...task,
    status: TaskStatus.FAILED,
    error_message: 'Executor heartbeat lost; the executor may have crashed or disconnected.',
    sdk_failure: { termination: 'verified' },
    termination_request: { cause: 'heartbeat_lost' },
    executor_connected_at: task.created_at,
  } as Task;
  const live = { isLatestTask: true, sessionId: task.session_id, client };
  const { container, rerender } = render(
    view({ ...live, task: { ...task, status: TaskStatus.RUNNING } })
  );
  rerender(view({ ...live, task: interrupted }));
  expect(screen.getAllByRole('alert')).toHaveLength(1);
  expect(screen.getByRole('alert')).toHaveTextContent(
    'Lost connection to the agent. Any edits are kept.'
  );
  expect(screen.queryByRole('button', { name: 'Resume' })).toBeNull();
  rerender(view({ ...live, task: interrupted, canStartTurn: true }));
  expect(screen.getByRole('button', { name: 'Resume' })).toBeVisible();
  fireEvent.click(screen.getByRole('button', { name: 'Details' }));
  expect(screen.getByRole('alert')).toHaveTextContent('Executor heartbeat lost');
  expect(container.querySelector('[data-task-block]')!.lastElementChild).toBe(
    screen.getByRole('alert')
  );
  rerender(
    view({
      ...live,
      canStartTurn: true,
      task: {
        ...interrupted,
        termination_request: {
          ...interrupted.termination_request!,
          cause: 'authorization_revoked',
        },
      },
    })
  );
  expect(screen.queryByRole('alert')).toBeNull();
  expect(screen.getByRole('status')).toHaveTextContent(
    'Agor stopped the agent after an access change.'
  );
  expect(screen.queryByRole('button', { name: 'Resume' })).toBeNull();
});

it('uses a polite status for a failure that was already settled on load', () => {
  render(
    view({
      task: { ...task, status: TaskStatus.FAILED, error_message: ENOENT_SYSTEM_PROMPT },
      isLatestTask: true,
    })
  );
  expect(screen.queryByRole('alert')).toBeNull();
  expect(screen.getByRole('status')).toHaveTextContent('The agent hit a problem.');
});

it('retries the original prompt when startup proves nothing ran, as one new turn', async () => {
  const prompt = vi.fn().mockResolvedValue(undefined);
  render(
    view({
      task: {
        ...task,
        created_by: 'viewer',
        metadata: { source: 'agor' },
        status: TaskStatus.FAILED,
        recorded_tool_count: 0,
        error_message: 'Local executor did not connect before the startup deadline.',
        sdk_failure: { termination: 'verified' },
        termination_request: { cause: 'startup_timeout' },
      } as Task,
      currentUserId: 'viewer',
      isLatestTask: true,
      canStartTurn: true,
      sessionId: task.session_id,
      client: { sessions: { prompt } } as unknown as NonNullable<
        React.ComponentProps<typeof TaskBlock>['client']
      >,
    })
  );
  expect(outcome()).toHaveTextContent("The agent couldn't start. No files changed.");
  fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
  await waitFor(() => expect(prompt).toHaveBeenCalledWith(task.session_id, 'Retained prompt'));
  await waitFor(() => expect(screen.queryByRole('button', { name: 'Try again' })).toBeNull());
});

it('resumes instead of replaying a prompt the viewer did not type', async () => {
  const prompt = vi.fn().mockResolvedValue(undefined);
  render(
    view({
      task: {
        ...task,
        created_by: 'teammate',
        metadata: { source: 'agor' },
        status: TaskStatus.FAILED,
        recorded_tool_count: 0,
        sdk_failure: { termination: 'verified' },
        termination_request: { cause: 'startup_timeout' },
      } as Task,
      currentUserId: 'viewer',
      isLatestTask: true,
      canStartTurn: true,
      sessionId: task.session_id,
      client: { sessions: { prompt } } as unknown as NonNullable<
        React.ComponentProps<typeof TaskBlock>['client']
      >,
    })
  );
  expect(screen.queryByRole('button', { name: 'Try again' })).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Resume' }));
  await waitFor(() => expect(prompt).toHaveBeenCalledTimes(1));
  expect(prompt.mock.calls[0][1]).not.toBe('Retained prompt');
});

it('tells the user when Resume fails instead of failing silently', async () => {
  const prompt = vi.fn().mockRejectedValue(new Error('busy'));
  const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
  render(
    <App>
      {view({
        task: {
          ...task,
          status: TaskStatus.FAILED,
          sdk_failure: { termination: 'verified' },
          termination_request: { cause: 'heartbeat_lost' },
          executor_connected_at: task.created_at,
        } as Task,
        isLatestTask: true,
        canStartTurn: true,
        sessionId: task.session_id,
        client: { sessions: { prompt } } as unknown as NonNullable<
          React.ComponentProps<typeof TaskBlock>['client']
        >,
      })}
    </App>
  );
  fireEvent.click(screen.getByRole('button', { name: 'Resume' }));
  expect(await screen.findByText("Couldn't resume. Try again.")).toBeVisible();
  expect(screen.getByRole('button', { name: 'Resume' })).toBeVisible();
  consoleError.mockRestore();
});

it('opens the agent settings from a not-connected outcome with the existing handler', () => {
  const openSettings = vi.fn();
  render(
    view({
      task: {
        ...task,
        status: TaskStatus.FAILED,
        error_message: 'No scoped claude-code credential is configured for this workspace or user.',
      },
      agentic_tool: 'claude-code',
      onOpenAgenticToolSettings: openSettings,
    })
  );
  expect(screen.getByRole('status')).toHaveTextContent(
    "Claude Code isn't connected, so nothing ran."
  );
  fireEvent.click(screen.getByRole('button', { name: 'Open settings' }));
  expect(openSettings).toHaveBeenCalledWith('claude-code');
});

it('shows a failure once: the banner replaces a transcript row repeating its text', () => {
  const failure = 'Executor exited unexpectedly with code 1.';
  render(
    view({
      task: { ...task, status: TaskStatus.FAILED, error_message: failure },
      taskMessages: [
        ...messages,
        { ...message(2, MessageRole.SYSTEM, failure), type: 'system' },
        { ...message(3, MessageRole.SYSTEM, 'Unrelated system note'), type: 'system' },
      ],
    })
  );
  expect(screen.queryByText(failure)).toBeNull();
  expect(screen.getByText('Unrelated system note')).toBeVisible();
  fireEvent.click(screen.getByRole('button', { name: 'Details' }));
  expect(screen.getByText(failure)).toBeVisible();
});

it('keeps a user stop neutral, never failed, even with an explanatory reason', () => {
  render(
    view({ task: { ...task, status: TaskStatus.STOPPED, error_message: 'Stopped by request' } })
  );
  expect(screen.getByRole('status')).toHaveAttribute('data-notice-type', 'neutral');
  expect(screen.getByRole('status')).toHaveTextContent('The agent was stopped.');
  expect(screen.getByRole('button', { name: 'Details' })).toBeVisible();
});

it.each([undefined, 'Stopped by user.'])(
  'omits Details for a plain user stop (%s)',
  (error_message) => {
    render(view({ task: { ...task, status: TaskStatus.STOPPED, error_message } }));
    expect(screen.getByRole('status')).toHaveTextContent('The agent was stopped.');
    expect(screen.queryByRole('button', { name: 'Details' })).toBeNull();
  }
);

it('keeps tool-result errors inside activity details without masking a failed turn', () => {
  const failedCall = message(1, MessageRole.ASSISTANT, [
    { type: 'tool_use', id: 'failed-read', name: 'Read', input: { file_path: 'missing.txt' } },
    {
      type: 'tool_result',
      tool_use_id: 'failed-read',
      content: 'File does not exist',
      is_error: true,
    },
  ]);
  const props = {
    taskMessages: [messages[0], failedCall],
    taskMessagesLoaded: true,
    isLatestTask: true,
  };
  const { rerender } = render(view(props));
  const header = screen.getByRole('button', { name: '1 tool call', expanded: false });
  expect(screen.queryByText('File does not exist')).toBeNull();
  expect(screen.queryByRole('alert')).toBeNull();
  const running = { ...task, status: TaskStatus.RUNNING };
  rerender(view({ ...props, task: running }));
  expect(screen.getByRole('button', { name: 'Latest: Read' })).toBe(header);
  rerender(
    view({
      ...props,
      task: running,
      latestActivity: { toolUseId: 'retry', toolName: 'Bash', status: 'executing' },
    })
  );
  expect(screen.getByRole('button', { name: 'Running: Bash' })).toBe(header);
  rerender(
    view({
      ...props,
      task: running,
      latestActivity: { toolUseId: 'retry', toolName: 'Bash', status: 'complete' },
    })
  );
  expect(screen.getByRole('button', { name: 'Latest: Bash' })).toBe(header);
  fireEvent.click(header);
  expect(screen.getByRole('img', { name: 'close-circle' })).toBeVisible();
  fireEvent.click(screen.getByRole('button', { name: /Read missing.txt/ }));
  expect(screen.getByText('File does not exist')).toBeVisible();
  rerender(
    view({
      ...props,
      task: { ...task, status: TaskStatus.FAILED, error_message: ENOENT_SYSTEM_PROMPT },
    })
  );
  expect(screen.getByRole('button', { name: '1 tool call' })).toBe(header);
  expect(header).toHaveAttribute('aria-expanded', 'true');
  expect(outcome()).toHaveTextContent('The agent hit a problem.');
  expect(screen.getByText('File does not exist')).toBeVisible();
});

it.each([undefined, null, 12345])(
  'shows only known historical counts (%s) without fetching',
  (count) => {
    const load = vi.fn();
    render(view({ task: { ...task, recorded_tool_count: count }, onLoadTaskMessages: load }));
    const header = screen.getByRole('button', {
      name: count ? `${count} tool calls` : 'Tool calls',
    });
    if (count == null) expect(header.querySelector('.ant-tag')).toBeNull();
    else expect(header.querySelector('.ant-tag')).toHaveTextContent(String(count));
    expect(header).toHaveTextContent('Tool calls');
    expect(load).not.toHaveBeenCalled();
  }
);

it('uses each loaded group count instead of repeating the recorded turn total', () => {
  const call = (id: string) => ({ type: 'tool_use', id, name: 'Read', input: {} });
  render(
    view({
      task: { ...task, recorded_tool_count: 3 },
      taskMessagesLoaded: true,
      taskMessages: [
        messages[0],
        message(1, MessageRole.ASSISTANT, [call('a')]),
        message(2, MessageRole.ASSISTANT, 'Between groups'),
        message(3, MessageRole.ASSISTANT, [call('b'), call('c')]),
      ],
    })
  );
  expect(
    screen.getByRole('button', { name: '1 tool call' }).querySelector('.ant-tag')
  ).toHaveTextContent(/^1$/);
  expect(
    screen.getByRole('button', { name: '2 tool calls' }).querySelector('.ant-tag')
  ).toHaveTextContent(/^2$/);
  expect(screen.queryByRole('button', { name: '3 tool calls' })).toBeNull();
});

it('retains prompt disclosure and surrounding message order when history supplies the initial row', () => {
  const prompt = 'Long prompt text. '.repeat(100);
  const initial = message(1, MessageRole.USER, prompt);
  const before = message(0, MessageRole.ASSISTANT, 'Earlier event');
  const after = message(2, MessageRole.USER, 'Later user message');
  function Harness({ rows }: { rows: Message[] }) {
    const [choices, setChoices] = useState(() => new Map<string, boolean>());
    return (
      <HistoryTextChoices.Provider
        value={{
          choices,
          setChoice: (key, expanded) => setChoices(new Map(choices).set(key, expanded)),
        }}
      >
        {view({ task: { ...task, full_prompt: prompt }, taskMessages: rows })}
      </HistoryTextChoices.Provider>
    );
  }
  const { container, rerender } = render(<Harness rows={[before]} />);
  const turnSection = screen.getByRole('region', { name: 'Turn and its metadata' });
  fireEvent.click(screen.getByRole('button', { name: /show less/i }));
  expect(screen.getByRole('button', { name: /show more/i })).toBeInTheDocument();
  rerender(<Harness rows={[before, initial, after]} />);
  expect(screen.getByRole('region', { name: 'Turn and its metadata' })).toBe(turnSection);
  expect(screen.getByRole('button', { name: /show more/i })).toBeInTheDocument();
  const text = Array.from(container.querySelectorAll('[data-conversation-block]'))
    .map((el) => el.textContent)
    .join('|');
  expect(text).toMatch(/Earlier event[\s\S]*Long prompt text[\s\S]*Later user message/);
});

it('remounts message blocks once when cached detail is evicted, not on live updates or reload', async () => {
  const reasoningTask = { ...task, recorded_tool_count: 0 };
  const full = message(1, MessageRole.ASSISTANT, [
    { type: 'thinking', text: 'Saved reasoning' },
    { type: 'text', text: 'Visible answer' },
  ]);
  // What the session cache leaves after evicting this turn's detail.
  const evicted: Message = {
    ...full,
    content: [{ type: 'text', text: 'Visible answer' }],
    has_deferred_reasoning: true,
  };
  const render_ = (taskMessages: Message[], taskMessagesLoaded: boolean) =>
    view({ task: reasoningTask, taskMessages, taskMessagesLoaded });
  const { rerender } = render(render_([messages[0], full], true));
  const block = (text: string) => screen.getByText(text).closest('[data-conversation-block]');
  const prompt = block('Retained prompt');
  const answer = block('Visible answer');
  expect(screen.getByText('Extended Thinking')).toBeVisible();

  // A live update that still carries detail keeps the mounted block.
  rerender(render_([messages[0], { ...full }], true));
  expect(block('Visible answer')).toBe(answer);

  // Eviction discards the old fibers whole; the prompt (and its disclosure) stays.
  rerender(render_([messages[0], evicted], false));
  await waitFor(() => expect(block('Visible answer')).not.toBe(answer));
  expect(block('Retained prompt')).toBe(prompt);
  expect(screen.queryByText('Extended Thinking')).toBeNull();
  expect(screen.getByRole('button', { name: 'Reasoning' })).toBeVisible();
  const remounted = block('Visible answer');

  // Reloading persisted detail restores reasoning without another remount.
  rerender(render_([messages[0], full], true));
  expect(screen.getByText('Extended Thinking')).toBeVisible();
  expect(block('Visible answer')).toBe(remounted);
});

it('pins a turn from a reader’s detail load until its expanded activity holds its own pin', async () => {
  const events: string[] = [];
  let pins = 0;
  const retain = vi.fn(() => {
    const pin = ++pins;
    events.push(`retain ${pin}`);
    return () => events.push(`release ${pin}`);
  });
  let finishLoad = () => {};
  const load = vi.fn(() => new Promise<void>((resolve) => (finishLoad = resolve)));
  const props = { onLoadTaskMessages: load, onRetainTaskDetails: retain };
  const { rerender } = render(view(props));
  fireEvent.click(screen.getByRole('button', { name: 'Tool calls', expanded: false }));
  // Pinned before the read starts, so its commit cannot be evicted for size.
  expect(events).toEqual(['retain 1']);
  expect(load).toHaveBeenCalledTimes(1);
  const full = [
    messages[0],
    message(1, MessageRole.ASSISTANT, [
      { type: 'tool_use', id: 'call-1', name: 'Read', input: {} },
      { type: 'tool_result', tool_use_id: 'call-1', content: 'Result' },
    ]),
  ];
  // The cache commits the detail before the read settles.
  rerender(view({ ...props, taskMessages: full, taskMessagesLoaded: true }));
  expect(screen.getByRole('button', { name: '1 tool call', expanded: true })).toBeVisible();
  expect(events).toEqual(['retain 1', 'retain 2']);
  finishLoad();
  // The opened activity's pin takes over; only the load pin is released.
  await waitFor(() => expect(events).toEqual(['retain 1', 'retain 2', 'release 1']));
});

it('does not pin inline detail that arrives without a reader asking for it', () => {
  const retain = vi.fn(() => () => {});
  const full = {
    ...messages[1],
    content: [
      { type: 'thinking', text: 'INLINE_DETAIL' },
      { type: 'tool_use', id: 'read-1', name: 'Read', input: { file_path: '/a.txt' } },
      { type: 'tool_result', tool_use_id: 'read-1', content: 'TOOL_DETAIL' },
      { type: 'text', text: 'Visible answer' },
    ],
  } as Message;
  render(
    view({
      onRetainTaskDetails: retain,
      taskMessages: [messages[0], full],
      taskMessagesLoaded: true,
    })
  );
  expect(screen.getByText('Visible answer')).toBeVisible();
  expect(screen.queryByText('INLINE_DETAIL')).toBeNull();
  expect(screen.queryByText('TOOL_DETAIL')).toBeNull();
  expect(retain).not.toHaveBeenCalled();
});

it('keeps a load pin taken before the previous commit’s passive effect runs', async () => {
  const events: string[] = [];
  let pins = 0;
  const retain = vi.fn(() => {
    const pin = ++pins;
    events.push(`retain ${pin}`);
    return () => events.push(`release ${pin}`);
  });
  const load = vi.fn(() => new Promise<void>(() => {})); // the read stays pending
  let rerenderOutsideAct = () => {};
  /**
   * Re-renders TaskBlock (loading=false) in a non-act, default-priority commit,
   * whose passive effects run later. Its layout effect clicks the disclosure
   * header first, as a non-focusing early click would.
   */
  function Harness() {
    const [tick, setTick] = useState(0);
    rerenderOutsideAct = () => setTimeout(() => setTick(1));
    useLayoutEffect(() => {
      if (!tick) return;
      events.push('click');
      screen.getByRole('button', { name: '1 tool call' }).click();
    }, [tick]);
    return (
      <TaskBlock
        task={{ ...task, recorded_tool_count: 1 }}
        taskMessages={messages}
        taskMessagesLoaded={false}
        onLoadTaskMessages={load}
        onRetainTaskDetails={retain}
      />
    );
  }
  render(<Harness />);
  rerenderOutsideAct();
  await waitFor(() => expect(load).toHaveBeenCalledTimes(1));
  await new Promise((resolve) => setTimeout(resolve, 50));
  // The stale effect (from the render before the click) must not release it.
  expect(events).toEqual(['click', 'retain 1']);
});

it.each([
  ['the viewer', 'viewer', 'ui', 'You stopped the agent. Any edits are kept.'],
  ['a teammate', 'teammate', 'ui', 'Ada stopped the agent. Any edits are kept.'],
  [
    'a teammate over the CLI or API',
    'teammate',
    'api',
    'Ada stopped the agent. Any edits are kept.',
  ],
  ['an agent over MCP', 'viewer', 'mcp', 'The agent was stopped. Any edits are kept.'],
  ['Agor', undefined, 'agor', 'The agent was stopped. Any edits are kept.'],
] as const)('names %s as the one who stopped the agent', (_, requester, via, copy) => {
  render(
    view({
      task: {
        ...task,
        status: TaskStatus.STOPPED,
        termination_request: {
          cause: 'user_stop',
          requested_at: task.created_at,
          requested_by_user_id: requester,
          requested_via: via,
        },
      },
      currentUserId: 'viewer',
      userById: new Map([['teammate', { user_id: 'teammate', name: 'Ada Lovelace' } as never]]),
    })
  );
  expect(outcome()).toHaveTextContent(copy);
  expect(outcome()).toHaveAttribute('data-notice-type', 'neutral');
});

it('shows one restart surface: the banner replaces the restart notice and its Resume', () => {
  render(
    view({
      task: {
        ...task,
        status: TaskStatus.FAILED,
        executor_connected_at: task.created_at,
        sdk_failure: { termination: 'verified', reason: 'heartbeat_lost' },
        termination_request: { cause: 'heartbeat_lost' },
      } as Task,
      taskMessages: [
        ...messages,
        {
          ...message(
            2,
            MessageRole.SYSTEM,
            'The Agor daemon was restarted while this session was running.'
          ),
          type: 'daemon_restart',
        },
      ],
      taskMessagesLoaded: true,
      isLatestTask: true,
      canStartTurn: true,
      sessionId: task.session_id,
      client: {} as NonNullable<React.ComponentProps<typeof TaskBlock>['client']>,
    })
  );
  expect(outcome()).toHaveTextContent('Agor restarted during this run. Any edits are kept.');
  expect(screen.queryByText(/daemon was restarted/)).toBeNull();
  expect(screen.getAllByRole('button', { name: /Resume/ })).toHaveLength(1);
});

it('keeps the real cause when a restart notice lands on a turn that had already ended', () => {
  render(
    view({
      task: { ...task, status: TaskStatus.TIMED_OUT },
      taskMessages: [
        ...messages,
        {
          ...message(
            2,
            MessageRole.SYSTEM,
            'The Agor daemon was restarted while this session was running.'
          ),
          type: 'daemon_restart',
        },
      ],
      taskMessagesLoaded: true,
      isLatestTask: true,
      canStartTurn: true,
      sessionId: task.session_id,
      client: {} as NonNullable<React.ComponentProps<typeof TaskBlock>['client']>,
    })
  );
  expect(outcome()).toHaveTextContent('The agent stopped waiting for approval.');
  expect(screen.queryByText(/daemon was restarted/)).toBeNull();
  expect(screen.getAllByRole('button', { name: /Resume/ })).toHaveLength(1);
});

const rejectedLimit = (index: number) =>
  ({
    ...message(index, MessageRole.SYSTEM, [
      {
        type: 'rate_limit',
        status: 'rejected',
        rateLimitType: 'five_hour',
        resetsAt: Math.floor(Date.now() / 1000) + 3600,
        text: 'Rate limited (five_hour). Waiting for limit to reset...',
      },
    ]),
    type: 'system',
  }) as Message;

it("names the usage limit when the agent's own limit notice ended the run", () => {
  render(
    view({
      task: {
        ...task,
        status: TaskStatus.FAILED,
        error_message:
          'Agor could not confirm a successful response. Review any output and tool activity before retrying.',
      },
      agentic_tool: 'claude-code',
      taskMessages: [
        messages[0],
        rejectedLimit(1),
        message(2, MessageRole.ASSISTANT, [
          { type: 'text', text: "You've hit your session limit · resets 10:40am" },
        ]),
      ],
      taskMessagesLoaded: true,
    })
  );
  expect(outcome()).toHaveTextContent('Claude Code usage limit reached. Try again after');
});

it('names the real failure when the run went on using tools after a usage-limit wait', () => {
  render(
    view({
      task: { ...task, status: TaskStatus.FAILED, error_message: ENOENT_SYSTEM_PROMPT },
      agentic_tool: 'claude-code',
      taskMessages: [
        messages[0],
        rejectedLimit(1),
        message(2, MessageRole.ASSISTANT, [
          { type: 'tool_use', id: 'read-call', name: 'Read', input: { file_path: 'a.txt' } },
        ]),
        message(3, MessageRole.USER, [
          { type: 'tool_result', tool_use_id: 'read-call', content: 'contents' },
        ]),
      ],
      taskMessagesLoaded: true,
    })
  );
  expect(outcome()).toHaveTextContent('The agent hit a problem.');
  expect(screen.getByText('Rate limited (five_hour).')).toBeVisible();
});

it('lets the usage-limit banner own the reset time on a finished run', () => {
  const resetsAt = Math.floor(Date.now() / 1000) + 3600;
  render(
    view({
      task: {
        ...task,
        status: TaskStatus.FAILED,
        executor_connected_at: task.created_at,
        error_message:
          'Agor could not confirm a successful response. Review any output and tool activity before retrying.',
      },
      agentic_tool: 'claude-code',
      taskMessages: [
        ...messages,
        {
          ...message(2, MessageRole.SYSTEM, [
            {
              type: 'rate_limit',
              status: 'rejected',
              rateLimitType: 'five_hour',
              resetsAt,
              text: 'Rate limited (five_hour). Resets at 10/5/2026. Waiting for limit to reset...',
            },
          ]),
          type: 'system',
        },
      ],
      taskMessagesLoaded: true,
    })
  );
  expect(outcome()).toHaveTextContent('Claude Code usage limit reached. Try again after');
  expect(screen.queryByText(/Waiting for limit to reset/)).toBeNull();
  expect(screen.queryByText(/Resets:/)).toBeNull();
});

it('keeps the reset time on the rate-limit card when the banner does not show it', () => {
  const resetsAt = Math.floor(Date.now() / 1000) + 3600;
  const limitMessage = {
    ...message(2, MessageRole.SYSTEM, [
      {
        type: 'rate_limit',
        status: 'rejected',
        rateLimitType: 'five_hour',
        resetsAt,
        text: 'Rate limited (five_hour). Resets at 10/5/2026. Waiting for limit to reset...',
      },
    ]),
    type: 'system',
  } as Message;
  const { rerender } = render(
    view({
      task: { ...task, status: TaskStatus.FAILED, error_message: 'socket has been disconnected' },
      taskMessages: [...messages, limitMessage],
      taskMessagesLoaded: true,
    })
  );
  expect(outcome()).toHaveTextContent('Lost connection to the agent.');
  expect(screen.getByText('Rate limited (five_hour).')).toBeVisible();
  expect(screen.queryByText(/Waiting for limit to reset/)).toBeNull();
  expect(screen.getByText(/Resets:/)).toBeVisible();
  rerender(
    view({
      task: { ...task, status: TaskStatus.COMPLETED },
      taskMessages: [...messages, limitMessage],
      taskMessagesLoaded: true,
    })
  );
  expect(outcome()).toBeNull();
  expect(screen.getByText(/Resets:/)).toBeVisible();
});

it('opens technical details with the raw cause codes, agent, timing and task ID', () => {
  render(
    view({
      task: {
        ...task,
        status: TaskStatus.FAILED,
        model: 'gpt-6-astra',
        started_at: '2026-09-01T00:00:00.000Z',
        completed_at: '2026-09-01T00:03:29.000Z',
        executor_connected_at: '2026-09-01T00:00:01.000Z',
        recorded_tool_count: 4,
        error_message: 'Executor heartbeat lost; the executor may have crashed or disconnected.',
        sdk_failure: { reason: 'heartbeat_lost', termination: 'verified' },
        termination_request: { cause: 'heartbeat_lost', requested_at: '' },
      } as Task,
      agentic_tool: 'codex',
    })
  );
  fireEvent.click(screen.getByRole('button', { name: 'Details' }));
  const region = screen.getByRole('region', { name: 'Technical details' });
  for (const text of [
    'Executor heartbeat lost; the executor may have crashed or disconnected.',
    'heartbeat_lost',
    'verified',
    'codex · gpt-6-astra',
    '4',
    task.task_id,
  ]) {
    expect(region).toHaveTextContent(text);
  }
  expect(region).toHaveTextContent(/Timing.*3m 29s/);
});

it('gives a stop Details only when it has a cause code or a recorded requester', () => {
  const { rerender } = render(view({ task: { ...task, status: TaskStatus.STOPPED } }));
  expect(screen.queryByRole('button', { name: 'Details' })).toBeNull();
  rerender(
    view({
      task: {
        ...task,
        status: TaskStatus.STOPPED,
        termination_request: {
          cause: 'user_stop',
          requested_at: task.created_at,
          requested_by_user_id: 'teammate',
          requested_via: 'ui',
        },
      },
      userById: new Map([['teammate', { user_id: 'teammate', name: 'Ada Lovelace' } as never]]),
    })
  );
  fireEvent.click(screen.getByRole('button', { name: 'Details' }));
  const region = screen.getByRole('region', { name: 'Technical details' });
  expect(region).toHaveTextContent('user_stop');
  expect(region).toHaveTextContent('Ada Lovelace · ui');
});

it('keeps received output visible without a typing indicator after cleanup fails', () => {
  const { container } = render(
    view({
      task: {
        ...task,
        status: TaskStatus.STOPPING,
        sdk_failure: { termination: 'unverified' } as Task['sdk_failure'],
        termination_request: { cause: 'heartbeat_lost', requested_at: 'now' },
      },
    })
  );
  expect(screen.getByText('Visible answer')).toBeVisible();
  expect(screen.getByText('Retained prompt')).toBeVisible();
  expect(screen.getByRole('status')).toHaveTextContent('Cleanup needs attention');
  expect(container.querySelector('.ant-bubble-loading')).toBeNull();
});
