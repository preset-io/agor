import { generateId } from '@agor/core';
import type { SDKAssistantMessage, SDKPartialAssistantMessage } from '@agor/core/sdk';
import type { Message, MessageID, SessionID } from '@agor/core/types';
import { describe, expect, it, vi } from 'vitest';
import type { MessagesService } from '../base/index.js';
import { createAssistantMessage } from './message-builder.js';
import { SDKMessageProcessor } from './message-processor.js';

const sessionId = generateId() as SessionID;

// Only the envelope is abbreviated; the valid provider blocks below are checked
// against the SDK type. Other cases intentionally model partial/legacy payloads.
function assistant(content: unknown): SDKAssistantMessage {
  return {
    type: 'assistant',
    message: { content },
    parent_tool_use_id: null,
  } as SDKAssistantMessage;
}

describe('Claude reasoning normalization (#2810, #2809)', () => {
  it('preserves SDK thinking, signature and neighboring blocks through persistence', async () => {
    const processor = new SDKMessageProcessor({ sessionId });
    const content = [
      { type: 'text', text: 'Before', citations: null },
      { type: 'thinking', thinking: '  Synthetic reasoning\n', signature: 'synthetic-signature' },
      { type: 'tool_use', id: 'call-1', name: 'Read', input: { file_path: 'fixture.txt' } },
      { type: 'text', text: 'After', citations: null },
    ] satisfies SDKAssistantMessage['message']['content'];
    const events = await processor.process(assistant(content));
    const complete = events.find((event) => event.type === 'complete');
    expect(complete).toBeDefined();
    if (!complete) throw new Error('Missing complete event');
    const messagesService = {
      create: vi.fn(async (data: Partial<Message>) => JSON.parse(JSON.stringify(data)) as Message),
    } as unknown as MessagesService;
    const persisted = await createAssistantMessage(
      sessionId,
      generateId() as MessageID,
      complete.content,
      complete.toolUses,
      undefined,
      0,
      undefined,
      messagesService
    );
    expect(persisted.content).toEqual([
      { type: 'text', text: 'Before' },
      { type: 'thinking', text: '  Synthetic reasoning\n', signature: 'synthetic-signature' },
      content[2],
      { type: 'text', text: 'After' },
    ]);
    expect(persisted.session_id).toBe(sessionId);
    expect(persisted.tool_uses).toEqual([
      { id: 'call-1', name: 'Read', input: { file_path: 'fixture.txt' } },
    ]);
    expect(persisted.content_preview).toBe('BeforeAfter');
    expect(messagesService.create).toHaveBeenCalledOnce();
  });

  it.each([
    [{ thinking: 'Provider', text: 'Legacy' }, 'Provider'],
    [{ thinking: '', text: 'Legacy' }, ''],
    [{ thinking: ' \n' }, ' \n'],
    [{ text: 'Legacy normalized reasoning' }, 'Legacy normalized reasoning'],
    [{ thinking: null, text: 'Legacy' }, 'Legacy'],
    [{}, ''],
    [{ thinking: null }, ''],
    [{ thinking: 42, text: {} }, ''],
  ])('normalizes partial or legacy thinking fields %j', async (fields, expected) => {
    const events = await new SDKMessageProcessor({ sessionId }).process(
      assistant([{ type: 'thinking', ...fields, signature: 'synthetic-signature' }])
    );
    expect(events.find((event) => event.type === 'complete')?.content).toEqual([
      { type: 'thinking', text: expected, signature: 'synthetic-signature' },
    ]);
  });

  it('keeps streamed reasoning when the completed SDK block replaces the stream', async () => {
    const processor = new SDKMessageProcessor({ sessionId });
    const stream = (event: unknown) =>
      processor.process({ type: 'stream_event', event } as SDKPartialAssistantMessage);
    expect(
      await stream({
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'thinking', thinking: '' },
      })
    ).toEqual([]);
    const chunks = ['First ', 'second'];
    for (const thinking of chunks) {
      expect(
        await stream({
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'thinking_delta', thinking },
        })
      ).toEqual([{ type: 'thinking_partial', thinkingChunk: thinking, agentSessionId: undefined }]);
    }
    expect(await stream({ type: 'content_block_stop', index: 0 })).toEqual([
      { type: 'thinking_complete', agentSessionId: undefined },
    ]);
    const events = await processor.process(
      assistant([{ type: 'thinking', thinking: chunks.join(''), signature: 'synthetic-signature' }])
    );
    expect(events.find((event) => event.type === 'complete')?.content).toEqual([
      { type: 'thinking', text: chunks.join(''), signature: 'synthetic-signature' },
    ]);
  });
});
