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

describe('polling', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    });

  it('follows every Shortcut search page before advancing the poll', async () => {
    const commentTime = new Date(Date.now() + 1_000).toISOString();
    let ackId = 900;
    const fetchMock = vi.fn(async (url: string | URL, init?: RequestInit) => {
      const value = String(url);
      if (value.endsWith('/member')) return json({ id: 'agent-1' });
      if (value.endsWith('/members/agent-1')) {
        return json({ id: 'agent-1', profile: { mention_name: 'agorithm' } });
      }
      if (value.includes('/search/stories')) {
        return value.includes('next=page-2')
          ? json({ data: [{ id: 2 }], next: null })
          : json({
              data: [{ id: 1 }],
              next: '/api/v3/search/stories?query=mentions&next=page-2',
            });
      }
      if (init?.method === 'POST' && /\/stories\/\d+\/comments$/.test(value)) {
        return json({ id: ackId++ }, 201);
      }
      const storyId = value.endsWith('/stories/1') ? 1 : 2;
      return json({
        id: storyId,
        comments: [
          {
            id: storyId * 10,
            author_id: `author-${storyId}`,
            text: '@agorithm help',
            member_mention_ids: ['agent-1'],
            created_at: commentTime,
          },
        ],
      });
    });
    vi.stubGlobal('fetch', fetchMock);

    const connector = new ShortcutConnector({ api_token: 'tok' });
    const callback = vi.fn();
    try {
      await connector.startListening(callback);
    } finally {
      await connector.stopListening();
    }

    expect(callback).toHaveBeenCalledTimes(2);
    expect(callback.mock.calls.map(([message]) => message.metadata.shortcut_story_id)).toEqual([
      1, 2,
    ]);
    const searchUrls = fetchMock.mock.calls
      .map(([url]) => String(url))
      .filter((url) => url.includes('/search/stories'));
    expect(searchUrls).toHaveLength(2);
    expect(searchUrls[1]).toBe(
      'https://api.app.shortcut.com/api/v3/search/stories?query=mentions&next=page-2'
    );
  });

  it('does not narrow discovery to mention text when mentions are optional', async () => {
    const commentTime = new Date(Date.now() + 1_000).toISOString();
    const fetchMock = vi.fn(async (url: string | URL, init?: RequestInit) => {
      const value = String(url);
      if (value.endsWith('/member')) return json({ id: 'agent-1' });
      if (value.endsWith('/members/agent-1')) {
        return json({ id: 'agent-1', profile: { mention_name: 'agorithm' } });
      }
      if (value.includes('/search/stories')) return json({ data: [{ id: 1 }], next: null });
      if (init?.method === 'POST') return json({ id: 900 }, 201);
      return json({
        id: 1,
        comments: [
          {
            id: 10,
            author_id: 'author-1',
            text: 'help without a mention',
            member_mention_ids: [],
            created_at: commentTime,
          },
        ],
      });
    });
    vi.stubGlobal('fetch', fetchMock);

    const connector = new ShortcutConnector({ api_token: 'tok', require_mention: false });
    const callback = vi.fn();
    try {
      await connector.startListening(callback);
    } finally {
      await connector.stopListening();
    }

    expect(callback).toHaveBeenCalledOnce();
    const searchUrl = String(
      fetchMock.mock.calls.find(([url]) => String(url).includes('/search/stories'))?.[0]
    );
    expect(decodeURIComponent(searchUrl)).not.toContain('comment:agorithm');
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
    expect(new Headers(init?.headers).get('Shortcut-Token')).toBe('tok');
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

describe('testConnection', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    });

  it('validates the token and resolves the @handle from the member profile', async () => {
    const fetchMock = vi.fn(async (url: string | URL, _init?: RequestInit) => {
      const u = String(url);
      if (u.endsWith('/member')) return json({ id: 'owner-1' });
      if (u.includes('/members/owner-1'))
        return json({ id: 'owner-1', profile: { mention_name: 'agorithm' } });
      return json({ message: 'not found' }, 404);
    });
    vi.stubGlobal('fetch', fetchMock);

    const connector = new ShortcutConnector({ api_token: 'tok' });
    const result = await connector.testConnection();

    expect(result.ok).toBe(true);
    expect(result.failures).toEqual([]);
    expect(result.bot).toEqual({ userId: 'owner-1', name: '@agorithm' });
    // GET /member sends the auth header.
    expect(new Headers(fetchMock.mock.calls[0][1]?.headers).get('Shortcut-Token')).toBe('tok');
  });

  it('fails with an api_token capability when GET /member is rejected', async () => {
    const fetchMock = vi.fn(async () => json({ message: 'Unauthorized' }, 401));
    vi.stubGlobal('fetch', fetchMock);

    const connector = new ShortcutConnector({ api_token: 'bad' });
    const result = await connector.testConnection();

    expect(result.ok).toBe(false);
    expect(result.failures.map((f) => f.capability)).toContain('api_token');
    // A rejected token short-circuits — no member lookup is attempted.
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('fails on an explicit agent_member_id that Shortcut cannot resolve', async () => {
    const fetchMock = vi.fn(async (url: string | URL, _init?: RequestInit) => {
      const u = String(url);
      if (u.endsWith('/member')) return json({ id: 'owner-1' });
      return json({ message: 'not found' }, 404); // /members/bad-id
    });
    vi.stubGlobal('fetch', fetchMock);

    const connector = new ShortcutConnector({ api_token: 'tok', agent_member_id: 'bad-id' });
    const result = await connector.testConnection();

    expect(result.ok).toBe(false);
    expect(result.failures.map((f) => f.capability)).toContain('agent_member_id');
    expect(result.bot?.userId).toBe('bad-id');
  });

  it('uses a configured mention_name without a second member lookup', async () => {
    const fetchMock = vi.fn(async (url: string | URL, _init?: RequestInit) => {
      const u = String(url);
      if (u.endsWith('/member')) return json({ id: 'owner-1' });
      return json({ message: 'not found' }, 404);
    });
    vi.stubGlobal('fetch', fetchMock);

    const connector = new ShortcutConnector({ api_token: 'tok', mention_name: 'custom' });
    const result = await connector.testConnection();

    expect(result.ok).toBe(true);
    expect(result.bot).toEqual({ userId: 'owner-1', name: '@custom' });
    // Handle came from config — only GET /member was called.
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe('sessionEnv', () => {
  it('exposes the API token + base so in-session skills (media-intake) can fetch attachments', () => {
    const connector = new ShortcutConnector({ api_token: 'tok' });
    const env = connector.sessionEnv();
    const byKey = Object.fromEntries(env.map((e) => [e.key, e.value]));
    expect(byKey.SHORTCUT_API_TOKEN).toBe('tok');
    expect(byKey.SHORTCUT_API_BASE).toBe('https://api.app.shortcut.com/api/v3');
    // Service defaults — always applied unless an operator env var overrides them.
    expect(env.every((e) => e.forceOverride)).toBe(true);
  });
});
