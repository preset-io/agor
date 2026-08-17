import { describe, expect, it } from 'vitest';
import { knowledgeAttributionDisplay } from './knowledgeAttributionDisplay';

const users = new Map([['user-1', { name: 'Ada', email: 'ada@example.com' }]]);

describe('knowledgeAttributionDisplay', () => {
  it('shows only the human identity for a human edit', () => {
    expect(knowledgeAttributionDisplay({ userId: 'user-1' }, users)).toEqual({
      userLabel: 'Ada',
      assistantLabel: null,
    });
  });

  it('shows the trusted assistant and Session attribution for an agent edit', () => {
    expect(
      knowledgeAttributionDisplay(
        {
          userId: 'user-1',
          sessionId: '01abcdef-1234-7890-abcd-ef1234567890',
          agenticTool: 'codex',
        },
        users
      )
    ).toEqual({ userLabel: 'Ada', assistantLabel: 'Codex · session 01abcdef12347890abcdef12' });
  });
});
