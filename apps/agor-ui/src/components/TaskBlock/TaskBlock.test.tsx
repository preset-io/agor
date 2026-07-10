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

import { type Block, groupMessagesIntoBlocks } from './TaskBlock';

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
