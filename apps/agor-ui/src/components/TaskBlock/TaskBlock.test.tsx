/**
 * TaskBlock — groupMessagesIntoBlocks unit tests.
 *
 * Focus: widget_request messages (e.g. the gateway token form) are stamped at
 * tool-call time (mid-turn), so by message index they sort ABOVE the agent's
 * closing text. For UX, the inline form should be the LAST thing the user sees,
 * so grouping stable-moves widget_request blocks to the END of the task's block
 * list — WITHOUT disturbing non-widget order, message indices, or identity.
 */

import { AUTHORIZATION_REVOKED_TERMINATION_MESSAGE } from '@agor/core/types';
import type { Message, Task } from '@agor-live/client';
import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import {
  type Block,
  groupMessagesIntoBlocks,
  isAuthorizationRevokedFailure,
  isVerifiedRuntimeInterruption,
  shouldRenderLiveTaskProgress,
  TaskBlock,
} from './TaskBlock';

function userMessage(index: number, id: string): Message {
  return {
    message_id: id,
    session_id: 'sess-1',
    type: 'message',
    role: 'user',
    index,
    timestamp: '2026-07-01T12:00:00.000Z',
    content: 'user text',
    content_preview: 'user text',
  } as unknown as Message;
}

function assistantText(index: number, id: string, text: string): Message {
  return {
    message_id: id,
    session_id: 'sess-1',
    type: 'message',
    role: 'assistant',
    index,
    timestamp: '2026-07-01T12:00:00.000Z',
    content: [{ type: 'text', text }],
    content_preview: text,
  } as unknown as Message;
}

function assistantActivity(
  index: number,
  id: string,
  content: Array<Record<string, unknown>>
): Message {
  return {
    message_id: id,
    session_id: 'sess-1',
    type: 'message',
    role: 'assistant',
    index,
    timestamp: '2026-07-01T12:00:00.000Z',
    content,
    content_preview: '',
  } as unknown as Message;
}

function widgetRequest(index: number, id: string): Message {
  return {
    message_id: id,
    session_id: 'sess-1',
    type: 'widget_request',
    role: 'system',
    index,
    timestamp: '2026-07-01T12:00:00.000Z',
    content: 'Please provide gateway tokens',
    content_preview: 'Please provide gateway tokens',
    metadata: { widget: { widget_id: id, widget_type: 'gateway_token' } },
  } as unknown as Message;
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

describe('groupMessagesIntoBlocks — assistant activity', () => {
  it('renders thinking plus user-facing text as a regular message', () => {
    const message = assistantActivity(0, 'a0', [
      { type: 'thinking', text: 'Internal reasoning' },
      { type: 'text', text: 'Working. What do you need?' },
    ]);

    expect(groupMessagesIntoBlocks([message])).toEqual([{ type: 'message', message }]);
  });

  it.each([
    { content: [{ type: 'thinking', text: 'Internal reasoning' }] },
    { content: [{ type: 'tool_use', id: 'tool-1', name: 'Read', input: {} }] },
  ])('keeps pure thinking or tool activity in the agent chain', ({ content }) => {
    const message = assistantActivity(0, 'a0', content);

    expect(groupMessagesIntoBlocks([message])).toEqual([
      { type: 'agent-chain', messages: [message] },
    ]);
  });
});

describe('verified runtime interruption projection', () => {
  const task = {
    status: 'failed',
    sdk_failure: { termination: 'verified' },
    termination_request: { cause: 'heartbeat_lost' },
  } as unknown as Task;

  it('offers outcome-based recovery only for the latest verified interruption', () => {
    expect(isVerifiedRuntimeInterruption(task, true)).toBe(true);
    expect(isVerifiedRuntimeInterruption(task, false)).toBe(false);
  });

  it('keeps non-resumable outcomes out of Resume UX', () => {
    expect(
      isVerifiedRuntimeInterruption(
        { ...task, sdk_failure: { ...task.sdk_failure!, termination: 'unverified' } } as Task,
        true
      )
    ).toBe(false);
    expect(
      isVerifiedRuntimeInterruption(
        { ...task, termination_request: { ...task.termination_request!, cause: 'user_stop' } },
        true
      )
    ).toBe(false);
    expect(
      isVerifiedRuntimeInterruption(
        {
          ...task,
          termination_request: {
            ...task.termination_request!,
            cause: 'authorization_revoked',
          },
        },
        true
      )
    ).toBe(false);
  });
});

describe('authorization-revoked failure projection', () => {
  it('shows durable revoked authority without synthesizing a transcript message', () => {
    expect(
      isAuthorizationRevokedFailure({
        status: 'failed',
        termination_request: { cause: 'authorization_revoked' },
      } as Task)
    ).toBe(true);
  });

  it('does not relabel an in-flight or unrelated failure', () => {
    expect(
      isAuthorizationRevokedFailure({
        status: 'stopping',
        termination_request: { cause: 'authorization_revoked' },
      } as Task)
    ).toBe(false);
    expect(
      isAuthorizationRevokedFailure({
        status: 'failed',
        termination_request: { cause: 'heartbeat_lost' },
      } as Task)
    ).toBe(false);
  });

  it('renders the durable sanitized reason inside the expanded Task', () => {
    render(
      <TaskBlock
        task={
          {
            task_id: 'task-revoked',
            session_id: 'session-1',
            status: 'failed',
            created_at: '2026-08-30T19:26:18.933Z',
            created_by: 'user-1',
            full_prompt: 'sleep 300',
            error_message: AUTHORIZATION_REVOKED_TERMINATION_MESSAGE,
            termination_request: { cause: 'authorization_revoked' },
            git_state: { ref_at_start: 'main', sha_at_start: 'unknown' },
            message_range: {
              start_index: 0,
              end_index: 0,
              start_timestamp: '2026-08-30T19:26:18.933Z',
            },
            tool_use_count: 0,
          } as Task
        }
        isExpanded
        onExpandChange={vi.fn()}
        taskMessages={[]}
        taskMessagesLoaded
        onLoadTaskMessages={vi.fn()}
        onUnloadTaskMessages={vi.fn()}
      />
    );

    expect(screen.getByText('Task access revoked')).toBeInTheDocument();
    expect(screen.getByText(AUTHORIZATION_REVOKED_TERMINATION_MESSAGE)).toBeInTheDocument();
  });
});

describe('live runtime projection', () => {
  it.each(['running', 'stopping'])('keeps progress visible while the Task is %s', (status) => {
    expect(shouldRenderLiveTaskProgress({ status } as Task)).toBe(true);
  });

  it.each(['stopped', 'completed', 'failed'])('settles progress after the Task is %s', (status) => {
    expect(shouldRenderLiveTaskProgress({ status } as Task)).toBe(false);
  });
});
