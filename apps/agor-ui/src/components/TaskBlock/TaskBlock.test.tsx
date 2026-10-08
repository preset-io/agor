/**
 * TaskBlock — groupMessagesIntoBlocks unit tests.
 *
 * Focus: widget_request messages (e.g. the gateway token form) are stamped at
 * tool-call time (mid-turn), so by message index they sort ABOVE the agent's
 * closing text. For UX, the inline form should be the LAST thing the user sees,
 * so grouping stable-moves widget_request blocks to the END of the task's block
 * list — WITHOUT disturbing non-widget order, message indices, or identity.
 */

import type { Message, Task, WidgetType } from '@agor-live/client';
import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { registerWidgetComponent } from '../MessageBlock/WidgetBlock';

import {
  type Block,
  canOfferRecoveryTurn,
  groupMessagesIntoBlocks,
  rejectedRateLimit,
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
  it('renders the widget after the answer, footer, and outcome', () => {
    registerWidgetComponent('review_widget' as WidgetType, () => (
      <button type="button">Complete widget</button>
    ));
    const task = {
      task_id: 'task-1',
      session_id: 'sess-1',
      created_by: '',
      full_prompt: '',
      status: 'completed',
      created_at: '2026-07-01T12:00:00.000Z',
      git_state: { ref_at_start: 'main', sha_at_start: 'synthetic' },
      computed_context_window: 22,
      normalized_sdk_response: {
        contextWindowLimit: 100,
        tokenUsage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
      },
    } as unknown as Task;
    const widgetRequestMessage = {
      ...widgetRequest(1, 'w1'),
      metadata: {
        widget: {
          widget_id: 'w1',
          widget_type: 'review_widget',
          schema_version: 1,
          params: {},
          status: 'pending',
          requested_at: task.created_at,
        },
      },
    } as unknown as Message;
    const { container } = render(
      <TaskBlock
        task={task}
        isLatestTask
        taskMessages={[
          userMessage(0, 'u0'),
          widgetRequestMessage,
          assistantText(2, 'a2', 'Closing text'),
        ]}
        taskMessagesLoaded
        onLoadTaskMessages={vi.fn()}
      />
    );
    const answer = screen.getByText('Closing text');
    const footer = screen.getByTestId('turn-usage-label');
    const widget = screen.getByRole('button', { name: 'Complete widget' });
    expect(answer.compareDocumentPosition(footer) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(footer.compareDocumentPosition(widget) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(container.lastElementChild?.lastElementChild).toContainElement(widget);
  });
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

describe('recovery turn eligibility', () => {
  const task = {
    status: 'failed',
    sdk_failure: { termination: 'verified' },
    termination_request: { cause: 'heartbeat_lost' },
  } as unknown as Task;

  it('offers outcome-based recovery only for the latest verified interruption', () => {
    expect(canOfferRecoveryTurn(task, true)).toBe(true);
    expect(canOfferRecoveryTurn(task, false)).toBe(false);
  });

  it('offers recovery after a settled failure or timeout, never mid-termination', () => {
    expect(canOfferRecoveryTurn({ status: 'failed' } as Task, true)).toBe(true);
    expect(canOfferRecoveryTurn({ status: 'timed_out' } as Task, true)).toBe(true);
    expect(canOfferRecoveryTurn({ status: 'stopped' } as Task, true)).toBe(false);
    expect(
      canOfferRecoveryTurn(
        { ...task, sdk_failure: { ...task.sdk_failure!, termination: 'requested' } } as Task,
        true
      )
    ).toBe(false);
  });

  it('keeps non-resumable outcomes out of Resume UX', () => {
    expect(
      canOfferRecoveryTurn(
        { ...task, sdk_failure: { ...task.sdk_failure!, termination: 'unverified' } } as Task,
        true
      )
    ).toBe(false);
    expect(
      canOfferRecoveryTurn(
        { ...task, termination_request: { ...task.termination_request!, cause: 'user_stop' } },
        true
      )
    ).toBe(false);
    expect(
      canOfferRecoveryTurn(
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

describe('usage-limit rejection that ended the turn', () => {
  const row = (index: number, role: string, content: Message['content']) =>
    ({ message_id: `m${index}`, index, role, content }) as Message;
  const rejected = (index: number) =>
    row(index, 'system', [{ type: 'rate_limit', status: 'rejected', resetsAt: 100 }]);

  // Shapes observed in real runs: Claude ends a limited run with its own text notice.
  const notice = (index: number) =>
    row(index, 'assistant', [
      { type: 'text', text: "You've hit your session limit · resets 10:40am (America/Sao_Paulo)" },
    ]);

  it("counts a rejection followed only by the agent's limit notice as the end of the run", () => {
    expect(rejectedRateLimit([row(0, 'user', 'Go'), rejected(1)])).toEqual({ resetsAt: 100 });
    expect(rejectedRateLimit([row(0, 'user', 'Go'), rejected(1), notice(2)])).toEqual({
      resetsAt: 100,
    });
    expect(rejectedRateLimit([rejected(1), row(2, 'system', 'Note')])).toEqual({ resetsAt: 100 });
    expect(rejectedRateLimit([row(0, 'assistant', 'Hi')])).toBeUndefined();
  });

  it('treats tool activity after the wait as a run that went on', () => {
    expect(
      rejectedRateLimit([
        rejected(1),
        row(2, 'user', [{ type: 'tool_result', tool_use_id: 't', content: 'ok' }]),
        row(3, 'assistant', 'Done.'),
      ])
    ).toBeUndefined();
    expect(
      rejectedRateLimit([
        rejected(1),
        row(2, 'assistant', [{ type: 'tool_use', id: 't', name: 'Read', input: {} }]),
      ])
    ).toBeUndefined();
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
