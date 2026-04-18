/**
 * StickyTodoRenderer Storybook Stories
 *
 * Exercises the parent-task-status → display-status override matrix:
 *   - RUNNING        → in_progress items keep spinner (no override)
 *   - STOPPED        → in_progress items render as 'stopped'
 *   - COMPLETED      → in_progress items render as 'unknown' (agent forgot to update)
 *   - FAILED         → in_progress items render as 'unknown'
 *   - TIMED_OUT      → in_progress items render as 'unknown'
 *   - AWAITING_INPUT → in_progress items keep spinner (task is paused, not stopped)
 */

import type { Message } from '@agor-live/client';
import { TaskStatus } from '@agor-live/client';
import type { Meta, StoryObj } from '@storybook/react';
import { StickyTodoRenderer } from './StickyTodoRenderer';

/**
 * Build a minimal Message[] containing a single TodoWrite tool_use block.
 * The renderer scans for the latest TodoWrite, so anything else is irrelevant.
 */
function buildMessages(
  todos: Array<{ content: string; activeForm: string; status: string }>
): Message[] {
  return [
    {
      message_id: 'msg-1',
      session_id: 'session-1',
      type: 'assistant',
      role: 'assistant',
      index: 0,
      timestamp: '2026-04-18T00:00:00Z',
      content_preview: 'TodoWrite',
      content: [
        {
          type: 'tool_use',
          id: 'tool-use-1',
          name: 'TodoWrite',
          input: { todos },
        },
      ],
    } as unknown as Message,
  ];
}

const SAMPLE_TODOS = [
  {
    content: 'Read existing TodoListRenderer implementation',
    activeForm: 'Reading TodoListRenderer implementation',
    status: 'completed',
  },
  {
    content: 'Wire taskStatus through StickyTodoRenderer',
    activeForm: 'Wiring taskStatus through',
    status: 'in_progress',
  },
  {
    content: 'Add stopped/unknown display states',
    activeForm: 'Adding display states',
    status: 'pending',
  },
];

const meta = {
  title: 'Components/StickyTodoRenderer',
  component: StickyTodoRenderer,
  parameters: { layout: 'padded' },
  tags: ['autodocs'],
} satisfies Meta<typeof StickyTodoRenderer>;

export default meta;
type Story = StoryObj<typeof meta>;

/**
 * Task is running — in_progress items show the live spinner (no override).
 */
export const Running: Story = {
  args: {
    messages: buildMessages(SAMPLE_TODOS),
    taskStatus: TaskStatus.RUNNING,
  },
};

/**
 * User halted the task — in_progress items render as 'stopped' (StopOutlined, muted).
 */
export const Stopped: Story = {
  args: {
    messages: buildMessages(SAMPLE_TODOS),
    taskStatus: TaskStatus.STOPPED,
  },
};

/**
 * Stop requested but SDK hasn't halted yet — same treatment as STOPPED.
 */
export const Stopping: Story = {
  args: {
    messages: buildMessages(SAMPLE_TODOS),
    taskStatus: TaskStatus.STOPPING,
  },
};

/**
 * Task completed but agent never marked this item done — render as 'unknown'.
 */
export const CompletedWithUnmarkedItem: Story = {
  args: {
    messages: buildMessages(SAMPLE_TODOS),
    taskStatus: TaskStatus.COMPLETED,
  },
};

/**
 * Task failed mid-run — leftover in_progress items render as 'unknown'.
 */
export const Failed: Story = {
  args: {
    messages: buildMessages(SAMPLE_TODOS),
    taskStatus: TaskStatus.FAILED,
  },
};

/**
 * Task timed out — leftover in_progress items render as 'unknown'.
 */
export const TimedOut: Story = {
  args: {
    messages: buildMessages(SAMPLE_TODOS),
    taskStatus: TaskStatus.TIMED_OUT,
  },
};

/**
 * Task is waiting for user input — items remain in_progress (task can resume).
 */
export const AwaitingInput: Story = {
  args: {
    messages: buildMessages(SAMPLE_TODOS),
    taskStatus: TaskStatus.AWAITING_INPUT,
  },
};

/**
 * No TodoWrite in the message stream — renders nothing.
 */
export const NoTodos: Story = {
  args: {
    messages: [],
    taskStatus: TaskStatus.RUNNING,
  },
};
