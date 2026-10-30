import { describe, expect, it } from 'vitest';
import { generateId } from '../lib/ids';
import { renderPromptProvenanceBlock } from '../templates/prompt-provenance';
import { leanMessage, type Message, MessageRole } from './message';
import type { TaskMetadata } from './task';

describe('lean transcript provenance', () => {
  it('keeps the admitted stamp and original prompt without unrelated metadata', () => {
    const block = renderPromptProvenanceBlock({
      userLabel: 'sender@example.invalid',
      authenticatedBy: 'personal_api_key',
      tool: 'agor_sessions_create',
    });
    const provenance: NonNullable<TaskMetadata['prompt_provenance']> = {
      version: 1,
      authenticated_by: 'personal_api_key',
      origin_user_id: generateId(),
      tool: 'agor_sessions_create',
      stamped_at: '2026-10-21T00:00:00.000Z',
      rendered_block: block,
      placement: 'prefix',
    };
    const message: Message = {
      message_id: generateId(),
      session_id: generateId(),
      role: MessageRole.USER,
      type: 'user',
      index: 0,
      timestamp: provenance.stamped_at,
      content_preview: '',
      content: `${block}\n\nhello`,
      metadata: { prompt_provenance: provenance, internal_only: 'omitted' },
    };
    const lean = leanMessage(message);
    expect(lean.metadata).toEqual({ prompt_provenance: provenance });
    expect(lean.content).toBe(message.content);
    expect(message.metadata?.internal_only).toBe('omitted');
  });
});
