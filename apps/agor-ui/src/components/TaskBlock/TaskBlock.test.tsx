/**
 * TaskBlock — groupMessagesIntoBlocks unit tests.
 *
 * Focus: widget_request messages (e.g. the gateway token form) are stamped at
 * tool-call time (mid-turn), so by message index they sort ABOVE the agent's
 * closing text. For UX, the inline form should be the LAST thing the user sees,
 * so grouping stable-moves widget_request blocks to the END of the task's block
 * list — WITHOUT disturbing non-widget order, message indices, or identity.
 */

import type { Message } from '@agor-live/client';
import { describe, expect, it } from 'vitest';

import { type Block, blocksHaveSameMessages, groupMessagesIntoBlocks } from './TaskBlock';

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

describe('TaskBlock block reconciliation', () => {
  it('detects in-place tool result patches on a previously grouped agent-chain block', () => {
    const toolMessage = {
      message_id: 'tool-msg-1',
      session_id: 'sess-1',
      type: 'message',
      role: 'assistant',
      index: 0,
      timestamp: '2026-07-01T12:00:00.000Z',
      content_preview: '',
      content: [
        {
          type: 'tool_use',
          id: 'tool-1',
          name: 'Bash',
          input: { command: 'echo hi' },
        },
      ],
      tool_uses: [{ id: 'tool-1', name: 'Bash', input: { command: 'echo hi' } }],
    } as unknown as Message;

    const previousBlock = groupMessagesIntoBlocks([toolMessage])[0];

    // Feathers can patch the same message object in place when a running tool
    // completes. Reconciliation must notice the content change even though the
    // Message object identity is unchanged.
    toolMessage.content = [
      ...(toolMessage.content as Array<Record<string, unknown>>),
      {
        type: 'tool_result',
        tool_use_id: 'tool-1',
        content: 'hi\n',
        is_error: false,
      },
    ] as unknown as Message['content'];
    toolMessage.content_preview = 'hi\n';

    const nextBlock = groupMessagesIntoBlocks([toolMessage])[0];

    expect(previousBlock.type).toBe('agent-chain');
    expect(nextBlock.type).toBe('agent-chain');
    expect((previousBlock as Extract<Block, { type: 'agent-chain' }>).messages[0]).toBe(
      (nextBlock as Extract<Block, { type: 'agent-chain' }>).messages[0]
    );
    expect(blocksHaveSameMessages(previousBlock, nextBlock)).toBe(false);
  });
});
