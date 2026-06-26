import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  buildThreadId,
  commentMentionsAgent,
  parseThreadId,
  ShortcutConnector,
  stripAgentMention,
} from './shortcut';

describe('parseThreadId', () => {
  it('parses storyId|rootCommentId', () => {
    expect(parseThreadId('12345|67890')).toEqual({ storyId: 12345, rootCommentId: 67890 });
  });

  it('throws on missing pipe', () => {
    expect(() => parseThreadId('12345')).toThrow('Invalid Shortcut thread ID format');
  });

  it('throws on non-numeric parts', () => {
    expect(() => parseThreadId('abc|def')).toThrow('Invalid Shortcut thread ID format');
  });

  it('throws on too many parts', () => {
    expect(() => parseThreadId('1|2|3')).toThrow('Invalid Shortcut thread ID format');
  });
});

describe('buildThreadId', () => {
  it('uses the comment id as the root for a top-level comment', () => {
    expect(buildThreadId(12345, { id: 67890 })).toBe('12345|67890');
    expect(buildThreadId(12345, { id: 67890, parent_id: null })).toBe('12345|67890');
  });

  it('uses the parent id as the root for a reply', () => {
    expect(buildThreadId(12345, { id: 99999, parent_id: 67890 })).toBe('12345|67890');
  });
});

describe('commentMentionsAgent', () => {
  const agentId = 'agent-uuid-1';

  it('matches via member_mention_ids', () => {
    expect(
      commentMentionsAgent({ id: 1, member_mention_ids: ['other', 'agent-uuid-1'] }, agentId)
    ).toBe(true);
  });

  it('matches via a shortcutapp link in the text', () => {
    expect(
      commentMentionsAgent(
        { id: 1, text: 'hey shortcutapp://members/agent-uuid-1 please' },
        agentId
      )
    ).toBe(true);
  });

  it('returns false when the agent is not mentioned', () => {
    expect(
      commentMentionsAgent({ id: 1, text: 'no mention', member_mention_ids: ['other'] }, agentId)
    ).toBe(false);
  });

  it('returns false with no mention fields', () => {
    expect(commentMentionsAgent({ id: 1 }, agentId)).toBe(false);
  });
});

describe('stripAgentMention', () => {
  const agentId = 'agent-uuid-1';

  it('strips a markdown-link mention', () => {
    expect(
      stripAgentMention(
        '[@Agorithm](shortcutapp://members/agent-uuid-1) build it',
        agentId,
        'agorithm'
      )
    ).toBe('build it');
  });

  it('strips a bare shortcutapp link', () => {
    expect(
      stripAgentMention('shortcutapp://members/agent-uuid-1 build it', agentId, 'agorithm')
    ).toBe('build it');
  });

  it('strips an @name handle (case-insensitive)', () => {
    expect(stripAgentMention('@Agorithm build it', agentId, 'agorithm')).toBe('build it');
  });

  it('returns the trimmed original when there is nothing to strip', () => {
    expect(stripAgentMention('  build it  ', agentId, 'agorithm')).toBe('build it');
  });
});

describe('ShortcutConnector', () => {
  it('throws if api_token is missing', () => {
    expect(() => new ShortcutConnector({ agent_member_id: 'm1' })).toThrow(
      'Shortcut connector requires api_token in config'
    );
  });

  it('does not require agent_member_id (auto-resolved from the token)', () => {
    const connector = new ShortcutConnector({ api_token: 'tok' });
    expect(connector.channelType).toBe('shortcut');
  });

  it('creates a connector with valid config', () => {
    const connector = new ShortcutConnector({ api_token: 'tok', agent_member_id: 'm1' });
    expect(connector.channelType).toBe('shortcut');
  });

  it('formatMessage passes markdown through unchanged', () => {
    const connector = new ShortcutConnector({ api_token: 'tok', agent_member_id: 'm1' });
    expect(connector.formatMessage('**bold** and `code`')).toBe('**bold** and `code`');
  });
});

describe('sendMessage', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('posts a threaded reply with parent_id = thread root and the auth header', async () => {
    const fetchMock = vi.fn(
      async (_url: string | URL, _init?: RequestInit) =>
        new Response(JSON.stringify({ id: 555 }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
    );
    vi.stubGlobal('fetch', fetchMock);

    const connector = new ShortcutConnector({ api_token: 'tok', agent_member_id: 'm1' });
    const id = await connector.sendMessage({ threadId: '12345|67890', text: 'hello' });

    expect(id).toBe('555');
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toBe('https://api.app.shortcut.com/api/v3/stories/12345/comments');
    expect(init?.method).toBe('POST');
    expect(JSON.parse(init?.body as string)).toEqual({ text: 'hello', parent_id: 67890 });
    expect((init?.headers as Record<string, string>)['Shortcut-Token']).toBe('tok');
  });

  it('edits the ack comment in place (PUT) when edit_comment_id is set', async () => {
    const fetchMock = vi.fn(
      async (_url: string | URL, _init?: RequestInit) =>
        new Response(JSON.stringify({ id: 999 }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
    );
    vi.stubGlobal('fetch', fetchMock);

    const connector = new ShortcutConnector({ api_token: 'tok', agent_member_id: 'm1' });
    const id = await connector.sendMessage({
      threadId: '12345|67890',
      text: 'final reply',
      metadata: { edit_comment_id: 999 },
    });

    expect(id).toBe('999');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toBe('https://api.app.shortcut.com/api/v3/stories/12345/comments/999');
    expect(init?.method).toBe('PUT');
    expect(JSON.parse(init?.body as string)).toEqual({ text: 'final reply' });
  });
});
