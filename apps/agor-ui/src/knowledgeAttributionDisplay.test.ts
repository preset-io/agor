import { describe, expect, it } from 'vitest';
import { knowledgeAttributionDisplay } from './knowledgeAttributionDisplay';

const users = new Map([['user-1', { name: 'Ada', email: 'ada@example.com' }]]);

describe('knowledgeAttributionDisplay', () => {
  it('uses the document-authorized server projection when the workspace user map is cold', () => {
    expect(
      knowledgeAttributionDisplay(
        {
          userId: 'user-1',
          user: { status: 'resolved', display_name: 'Ada' },
        },
        new Map()
      )
    ).toEqual({ userLabel: 'Ada', assistantLabel: null, editorLabel: 'Ada' });
  });

  it('shows only the human identity for a human edit', () => {
    expect(knowledgeAttributionDisplay({ userId: 'user-1' }, users)).toEqual({
      userLabel: 'Ada',
      assistantLabel: null,
      editorLabel: 'Ada',
    });
  });

  it('does not expose an email when a legacy user row has no display name', () => {
    const emailOnlyUsers = new Map([['user-2', { name: null, email: 'private@example.com' }]]);
    expect(knowledgeAttributionDisplay({ userId: 'user-2' }, emailOnlyUsers)).toEqual({
      userLabel: 'Unknown user',
      assistantLabel: null,
      editorLabel: 'Unknown user',
    });
  });

  it('combines the human and teammate names without exposing the Session ID', () => {
    expect(
      knowledgeAttributionDisplay(
        {
          userId: 'user-1',
          user: { status: 'resolved', display_name: 'Ada' },
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

  it('renders the explicit system/legacy label without a user lookup', () => {
    expect(
      knowledgeAttributionDisplay(
        {
          user: { status: 'unattributed', display_name: 'System or former user' },
        },
        new Map()
      )
    ).toEqual({
      userLabel: 'System or former user',
      assistantLabel: null,
      editorLabel: 'System or former user',
    });
  });
});
