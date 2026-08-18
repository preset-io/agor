import { describe, expect, it } from 'vitest';
import { knowledgeAttributionDisplay } from './knowledgeAttributionDisplay';

const users = new Map([['user-1', { name: 'Ada', email: 'ada@example.com' }]]);

describe('knowledgeAttributionDisplay', () => {
  it('shows only the human identity for a human edit', () => {
    expect(knowledgeAttributionDisplay({ userId: 'user-1' }, users)).toEqual({
      userLabel: 'Ada',
      assistantLabel: null,
      editorLabel: 'Ada',
    });
  });

  it('combines the human and teammate names without exposing the Session ID', () => {
    expect(
      knowledgeAttributionDisplay(
        {
          userId: 'user-1',
          sessionId: '01abcdef-1234-7890-abcd-ef1234567890',
          agenticTool: 'codex',
          teammateName: 'Scout',
        },
        users
      )
    ).toEqual({ userLabel: 'Ada', assistantLabel: 'Scout', editorLabel: 'Ada and Scout' });
  });

  it('falls back to the agentic tool when the Session is not a named teammate', () => {
    expect(
      knowledgeAttributionDisplay(
        { userId: 'user-1', sessionId: 'session-1', agenticTool: 'codex' },
        users
      )
    ).toEqual({ userLabel: 'Ada', assistantLabel: 'Codex', editorLabel: 'Ada and Codex' });
  });
});
