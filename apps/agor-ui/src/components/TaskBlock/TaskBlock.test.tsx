/**
 * TaskBlock behavior tests.
 *
 * Widget focus: widget_request messages (e.g. the gateway token form) are stamped at
 * tool-call time (mid-turn), so by message index they sort ABOVE the agent's
 * closing text. For UX, the inline form should be the LAST thing the user sees,
 * so grouping stable-moves widget_request blocks to the END of the task's block
 * list — WITHOUT disturbing non-widget order, message indices, or identity.
 */

import {
  type Message,
  type MessageID,
  MessageRole,
  type SessionID,
  type Task,
  type TaskID,
  TaskStatus,
  type UserID,
} from '@agor-live/client';
import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { type Block, groupMessagesIntoBlocks, TaskBlock } from './TaskBlock';

const RUNNING_STATUS_NAME = 'Agent is working';

const observedSdkFailure = {
  reason: 'no_first_progress',
  detected_at: '2026-07-23T20:03:00.000Z',
  tool: 'codex',
  watchdog_action: 'would_fire',
  termination: 'not_requested',
} satisfies NonNullable<Task['sdk_failure']>;

function makeTask(overrides: Partial<Task> = {}) {
  return {
    task_id: 'task-1' as TaskID,
    session_id: 'sess-1' as SessionID,
    created_by: 'user-1' as UserID,
    full_prompt: 'Investigate the branch',
    status: TaskStatus.RUNNING,
    created_at: '2026-07-23T20:00:00.000Z',
    message_range: {
      start_index: 0,
      end_index: 0,
      start_timestamp: '2026-07-23T20:00:00.000Z',
    },
    tool_use_count: 0,
    git_state: {
      ref_at_start: 'main',
      sha_at_start: 'unknown',
    },
    ...overrides,
  } satisfies Task;
}

function renderTaskBlock(task: Task, isExpanded = false, taskMessages: Message[] = []) {
  return render(
    <TaskBlock
      task={task}
      isExpanded={isExpanded}
      onExpandChange={vi.fn()}
      taskMessages={taskMessages}
      taskMessagesLoaded
      onLoadTaskMessages={vi.fn()}
      onUnloadTaskMessages={vi.fn()}
      isLatestTask
    />
  );
}

function expectRunningPresentation(visible: boolean) {
  const status = screen.queryByRole('status', { name: RUNNING_STATUS_NAME });
  if (visible) {
    expect(status).toBeInTheDocument();
  } else {
    expect(status).not.toBeInTheDocument();
  }
}

function pendingToolMessage(): Message {
  return {
    message_id: 'message-1' as MessageID,
    session_id: 'sess-1' as SessionID,
    task_id: 'task-1' as TaskID,
    type: 'message',
    role: MessageRole.ASSISTANT,
    index: 0,
    timestamp: '2026-07-23T20:02:00.000Z',
    content: [
      {
        type: 'tool_use',
        id: 'tool-1',
        name: 'Bash',
        input: { command: 'pwd' },
      },
    ],
    content_preview: 'Run pwd',
  } satisfies Message;
}

function streamingAssistantMessage() {
  return {
    ...assistantText(1, 'streaming-message', 'Streaming response'),
    task_id: 'task-1' as TaskID,
    isStreaming: true,
    isThinking: true,
    thinkingContent: 'Inspecting executor activity',
  } satisfies Message & {
    isStreaming: boolean;
    isThinking: boolean;
    thinkingContent: string;
  };
}

function compactionMessage(complete = false): Message {
  return {
    message_id: (complete ? 'compaction-complete' : 'compaction-start') as MessageID,
    session_id: 'sess-1' as SessionID,
    task_id: 'task-1' as TaskID,
    type: 'system',
    role: MessageRole.SYSTEM,
    index: complete ? 2 : 1,
    timestamp: complete ? '2026-07-23T20:02:01.000Z' : '2026-07-23T20:02:00.000Z',
    content: complete
      ? [{ type: 'system_complete', systemType: 'compaction' }]
      : [{ type: 'system_status', status: 'compacting' }],
    content_preview: complete ? 'Compaction complete' : 'Compacting',
  } satisfies Message;
}

function todoMessage(): Message {
  return {
    message_id: 'todo-message' as MessageID,
    session_id: 'sess-1' as SessionID,
    task_id: 'task-1' as TaskID,
    type: 'message',
    role: MessageRole.ASSISTANT,
    index: 1,
    timestamp: '2026-07-23T20:02:00.000Z',
    content: [
      {
        type: 'tool_use',
        id: 'todo-tool',
        name: 'TodoWrite',
        input: {
          todos: [
            {
              content: 'Inspect executor activity',
              activeForm: 'Inspecting executor activity',
              status: 'in_progress',
            },
          ],
        },
      },
    ],
    content_preview: 'Update tasks',
  } satisfies Message;
}

function userMessage(index: number, id: string): Message {
  return {
    message_id: id as MessageID,
    session_id: 'sess-1' as SessionID,
    type: 'message',
    role: MessageRole.USER,
    index,
    timestamp: '2026-07-01T12:00:00.000Z',
    content: 'user text',
    content_preview: 'user text',
  } satisfies Message;
}

function assistantText(index: number, id: string, text: string): Message {
  return {
    message_id: id as MessageID,
    session_id: 'sess-1' as SessionID,
    type: 'message',
    role: MessageRole.ASSISTANT,
    index,
    timestamp: '2026-07-01T12:00:00.000Z',
    content: [{ type: 'text', text }],
    content_preview: text,
  } satisfies Message;
}

function widgetRequest(index: number, id: string): Message {
  return {
    message_id: id as MessageID,
    session_id: 'sess-1' as SessionID,
    type: 'widget_request',
    role: MessageRole.SYSTEM,
    index,
    timestamp: '2026-07-01T12:00:00.000Z',
    content: 'Please provide gateway tokens',
    content_preview: 'Please provide gateway tokens',
    metadata: { widget: { widget_id: id, widget_type: 'gateway_token' } },
  } satisfies Message;
}

/** Message id of a block, for order assertions. */
function blockId(block: Block): string {
  return block.type === 'message' ? block.message.message_id : block.messages[0].message_id;
}

describe('groupMessagesIntoBlocks — widget_request ordering', () => {
  it('moves a widget_request block to the end even when its index sorts mid-turn', () => {
    // Widget (index 1) fired BEFORE the agent's closing text (index 2).
    const messages = [
      userMessage(0, 'u0'),
      widgetRequest(1, 'w1'),
      assistantText(2, 'a2', 'Here are the setup steps.'),
    ];

    const blocks = groupMessagesIntoBlocks(messages);

    // Widget renders LAST, after the agent's closing text.
    expect(blocks.map(blockId)).toEqual(['u0', 'a2', 'w1']);
    expect(blockId(blocks[blocks.length - 1])).toBe('w1');
  });

  it('appends multiple widget_request blocks in their original relative order', () => {
    const messages = [
      widgetRequest(0, 'w0'),
      assistantText(1, 'a1', 'closing text'),
      widgetRequest(2, 'w2'),
    ];

    const blocks = groupMessagesIntoBlocks(messages);

    expect(blocks.map(blockId)).toEqual(['a1', 'w0', 'w2']);
  });

  it('does not disturb ordering when there are no widget_request messages', () => {
    const messages = [
      userMessage(0, 'u0'),
      assistantText(1, 'a1', 'first'),
      assistantText(2, 'a2', 'second'),
    ];

    const blocks = groupMessagesIntoBlocks(messages);

    expect(blocks.map(blockId)).toEqual(['u0', 'a1', 'a2']);
  });

  it('does not mutate the source messages array or message indices', () => {
    const messages = [
      userMessage(0, 'u0'),
      widgetRequest(1, 'w1'),
      assistantText(2, 'a2', 'closing'),
    ];
    const originalOrder = messages.map((m) => m.message_id);
    const originalIndices = messages.map((m) => m.index);

    groupMessagesIntoBlocks(messages);

    expect(messages.map((m) => m.message_id)).toEqual(originalOrder);
    expect(messages.map((m) => m.index)).toEqual(originalIndices);
  });
});

describe('TaskBlock SDK failure presentation', () => {
  it('shows an active observe-only diagnosis without a running spinner in the collapsed header', () => {
    const { container } = renderTaskBlock(
      makeTask({
        sdk_failure: observedSdkFailure,
      })
    );

    expect(screen.getByText('Agent progress stalled')).toBeInTheDocument();
    expect(container.querySelector('[aria-busy="true"]')).not.toBeInTheDocument();
  });

  it('explains an active observe-only diagnosis without showing work in progress', () => {
    const { container } = renderTaskBlock(
      makeTask({
        sdk_failure: observedSdkFailure,
      }),
      true,
      [pendingToolMessage()]
    );

    expect(screen.getByText(/Monitoring only/)).toBeInTheDocument();
    expectRunningPresentation(false);
    expect(
      container.querySelector('[data-conversation-block] [aria-busy="true"]')
    ).not.toBeInTheDocument();
  });

  it('does not spin an incomplete compaction while progress is stalled', () => {
    renderTaskBlock(
      makeTask({
        sdk_failure: observedSdkFailure,
      }),
      true,
      [compactionMessage()]
    );

    const compaction = screen
      .getByText('Context compaction stalled')
      .closest('[data-conversation-block]');
    expect(compaction).not.toBeNull();
    expect(compaction?.querySelector('[aria-busy="true"]')).not.toBeInTheDocument();
  });

  it('keeps completed compaction visible while progress is stalled', () => {
    renderTaskBlock(
      makeTask({
        sdk_failure: observedSdkFailure,
      }),
      true,
      [compactionMessage(), compactionMessage(true)]
    );

    expect(screen.getByText('Context compacted successfully')).toBeInTheDocument();
  });

  it('shows a stalled in-progress TODO with neutral unknown state', () => {
    renderTaskBlock(
      makeTask({
        sdk_failure: observedSdkFailure,
      }),
      true,
      [todoMessage()]
    );

    expect(screen.getByLabelText('Unknown task state')).toBeInTheDocument();
  });

  it('stops streaming presentation for a progress-stalled assistant message', () => {
    const message = streamingAssistantMessage();

    renderTaskBlock(
      makeTask({
        sdk_failure: {
          ...observedSdkFailure,
          reason: 'progress_stalled',
        },
      }),
      true,
      [message]
    );

    expectRunningPresentation(false);
    expect(screen.getByText('Streaming response')).toBeInTheDocument();
    expect(screen.getByText('Extended Thinking')).toBeInTheDocument();
    expect(screen.queryByText('Extended Thinking (streaming...)')).not.toBeInTheDocument();
    expect(message.isStreaming).toBe(true);
    expect(message.isThinking).toBe(true);
  });

  it('returns to ordinary running presentation after strictly later progress', () => {
    renderTaskBlock(
      makeTask({
        sdk_failure: observedSdkFailure,
        latest_executor_pulse: {
          sequence: 2,
          kind: 'progress',
          observed_at: '2026-07-23T20:03:01.000Z',
        },
      }),
      true,
      [pendingToolMessage()]
    );

    expect(screen.queryByText('Agent progress stalled')).not.toBeInTheDocument();
    expectRunningPresentation(true);
  });

  it('keeps unknown activity in ordinary running presentation', () => {
    renderTaskBlock(
      makeTask({
        sdk_failure: {
          ...observedSdkFailure,
          reason: 'unknown_activity',
        },
      }),
      true,
      [pendingToolMessage()]
    );

    expect(screen.queryByText('Agent progress stalled')).not.toBeInTheDocument();
    expectRunningPresentation(true);
  });

  it.each([
    ['equal progress timestamp', 'progress', '2026-07-23T20:03:00.000Z'],
    ['invalid progress timestamp', 'progress', 'not-a-date'],
    ['later wait pulse', 'waiting', '2026-07-23T20:03:01.000Z'],
  ] as const)('keeps the diagnosis active for %s', (_case, kind, observedAt) => {
    renderTaskBlock(
      makeTask({
        sdk_failure: observedSdkFailure,
        latest_executor_pulse: {
          sequence: 2,
          kind,
          observed_at: observedAt,
        },
      })
    );

    expect(screen.getByText('Agent progress stalled')).toBeInTheDocument();
  });

  it('shows enforced containment as pending while the task is stopping', () => {
    renderTaskBlock(
      makeTask({
        status: TaskStatus.STOPPING,
        sdk_failure: {
          ...observedSdkFailure,
          watchdog_action: 'enforced',
          termination: 'unverified',
        },
      }),
      true
    );

    expect(screen.getByText(/Stopping executor/)).toBeInTheDocument();
    expect(screen.getByText(/until process absence is verified/)).toBeInTheDocument();
  });

  it('keeps ordinary running presentation when there is no SDK failure', () => {
    renderTaskBlock(makeTask(), true, [pendingToolMessage()]);

    expect(screen.queryByText('Agent progress stalled')).not.toBeInTheDocument();
    expectRunningPresentation(true);
  });
});
