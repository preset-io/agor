/**
 * Tests for `hasAgentOutput` — the predicate that decides whether the stop
 * route enters edit-on-cancel (drop the orphan task) or the regular STOPPED
 * path. Single-sourced here so any drift between Agor and Claude Code CLI's
 * "single-Esc while still internal" carve-out is caught fast.
 */

import type { Message, MessageID, SessionID, TaskID, UUID } from '@agor/core/types';
import { MessageRole } from '@agor/core/types';
import { describe, expect, it } from 'vitest';
import { hasAgentOutput } from './session-tasks';

const SESSION_ID = '01999999-9999-7999-8999-999999999999' as SessionID;
const TASK_ID = '01888888-8888-7888-8888-888888888888' as TaskID;

let messageCounter = 0;
function makeMessage(overrides: Partial<Message>): Message {
  messageCounter += 1;
  return {
    message_id: `01777777-7777-7777-7777-${String(messageCounter).padStart(12, '0')}` as MessageID,
    session_id: SESSION_ID as UUID,
    task_id: TASK_ID as UUID,
    type: 'user',
    role: MessageRole.USER,
    index: messageCounter - 1,
    timestamp: new Date('2026-01-01T00:00:00Z').toISOString(),
    content_preview: '',
    content: '',
    ...overrides,
  };
}

describe('hasAgentOutput', () => {
  it('returns false for an empty message list', () => {
    expect(hasAgentOutput([])).toBe(false);
  });

  it('ignores USER and SYSTEM messages no matter their content', () => {
    expect(
      hasAgentOutput([
        makeMessage({ role: MessageRole.USER, type: 'user', content: 'the original prompt' }),
        makeMessage({
          role: MessageRole.SYSTEM,
          type: 'system',
          content: [{ type: 'system_status', text: 'Brewed for 2s' }],
        }),
      ])
    ).toBe(false);
  });

  it('returns false for an ASSISTANT message containing only thinking blocks', () => {
    expect(
      hasAgentOutput([
        makeMessage({
          role: MessageRole.ASSISTANT,
          type: 'assistant',
          content: [{ type: 'thinking', thinking: 'planning...' }],
        }),
      ])
    ).toBe(false);
  });

  it('returns true for an ASSISTANT message with a text block', () => {
    expect(
      hasAgentOutput([
        makeMessage({
          role: MessageRole.ASSISTANT,
          type: 'assistant',
          content: [
            { type: 'thinking', thinking: 'planning...' },
            { type: 'text', text: 'Here is the answer.' },
          ],
        }),
      ])
    ).toBe(true);
  });

  it('returns true for an ASSISTANT message with a tool_use block', () => {
    expect(
      hasAgentOutput([
        makeMessage({
          role: MessageRole.ASSISTANT,
          type: 'assistant',
          content: [{ type: 'tool_use', id: 't1', name: 'Read', input: {} }],
        }),
      ])
    ).toBe(true);
  });

  it('returns true for an ASSISTANT message with non-empty string content', () => {
    expect(
      hasAgentOutput([
        makeMessage({
          role: MessageRole.ASSISTANT,
          type: 'assistant',
          content: 'Plain text reply',
        }),
      ])
    ).toBe(true);
  });

  it('returns false for an ASSISTANT message with whitespace-only string content', () => {
    expect(
      hasAgentOutput([
        makeMessage({
          role: MessageRole.ASSISTANT,
          type: 'assistant',
          content: '   \n\t',
        }),
      ])
    ).toBe(false);
  });

  it('returns true as soon as any one ASSISTANT message qualifies', () => {
    expect(
      hasAgentOutput([
        makeMessage({ role: MessageRole.USER, type: 'user', content: 'prompt' }),
        makeMessage({
          role: MessageRole.ASSISTANT,
          type: 'assistant',
          content: [{ type: 'thinking', thinking: '...' }],
        }),
        makeMessage({
          role: MessageRole.ASSISTANT,
          type: 'assistant',
          content: [{ type: 'text', text: 'reply' }],
        }),
      ])
    ).toBe(true);
  });
});
