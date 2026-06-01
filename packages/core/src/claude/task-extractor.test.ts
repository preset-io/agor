import { describe, expect, it } from 'vitest';
import type { Message, MessageID, SessionID } from '../types';
import { MessageRole } from '../types';
import { extractTasksFromMessages } from './task-extractor';

const SESSION_ID = 'session-1' as SessionID;

function makeUserMessage(index: number, model?: string): Message {
  return {
    message_id: `m-${index}` as MessageID,
    session_id: SESSION_ID,
    type: 'user',
    role: MessageRole.USER,
    index,
    timestamp: `2026-01-01T00:0${index}:00.000Z`,
    content_preview: 'hi',
    content: 'hi',
    ...(model ? { metadata: { model } } : {}),
  };
}

function makeAssistantMessage(index: number, model?: string): Message {
  return {
    message_id: `m-${index}` as MessageID,
    session_id: SESSION_ID,
    type: 'assistant',
    role: MessageRole.ASSISTANT,
    index,
    timestamp: `2026-01-01T00:0${index}:00.000Z`,
    content_preview: 'hello',
    content: 'hello',
    ...(model ? { metadata: { model } } : {}),
  };
}

describe('extractTasksFromMessages', () => {
  it('omits Task.model when no message in range carries a model', () => {
    const tasks = extractTasksFromMessages(
      [makeUserMessage(0), makeAssistantMessage(1)],
      SESSION_ID
    );
    expect(tasks).toHaveLength(1);
    expect(tasks[0]).not.toHaveProperty('model');
  });

  it('picks the model from an assistant message in range', () => {
    const tasks = extractTasksFromMessages(
      [makeUserMessage(0), makeAssistantMessage(1, 'claude-sonnet-4-6')],
      SESSION_ID
    );
    expect(tasks[0].model).toBe('claude-sonnet-4-6');
  });

  it('prefers the first model found when multiple messages carry one', () => {
    const tasks = extractTasksFromMessages(
      [makeUserMessage(0, 'claude-opus-4-7'), makeAssistantMessage(1, 'claude-sonnet-4-6')],
      SESSION_ID
    );
    expect(tasks[0].model).toBe('claude-opus-4-7');
  });

  it('scopes the model lookup to each task range', () => {
    // Two tasks; the second task's range has no model — it should not
    // borrow the model from the first task.
    const tasks = extractTasksFromMessages(
      [
        makeUserMessage(0),
        makeAssistantMessage(1, 'claude-opus-4-7'),
        makeUserMessage(2),
        makeAssistantMessage(3),
      ],
      SESSION_ID
    );
    expect(tasks).toHaveLength(2);
    expect(tasks[0].model).toBe('claude-opus-4-7');
    expect(tasks[1]).not.toHaveProperty('model');
  });
});
