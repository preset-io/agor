import { beforeAll, describe, expect, it } from 'vitest';
import {
  createTeamsAuthConfiguration,
  extractQuotedReplyText,
  normalizeTeamsActivity,
  parseThreadId,
  stripMention,
  TeamsConnector,
} from './teams';

describe('parseThreadId', () => {
  it('parses a valid thread ID', () => {
    const result = parseThreadId('19:abc123@thread.tacv2|1234567890');
    expect(result).toEqual({
      conversationId: '19:abc123@thread.tacv2',
      activityId: '1234567890',
    });
  });

  it('handles conversationId with special characters', () => {
    const result = parseThreadId('19:meeting_abc123@thread.v2|f:abc-def-123');
    expect(result).toEqual({
      conversationId: '19:meeting_abc123@thread.v2',
      activityId: 'f:abc-def-123',
    });
  });

  it('handles multiple pipes (splits on last pipe)', () => {
    const result = parseThreadId('a|b|c|d');
    expect(result).toEqual({
      conversationId: 'a|b|c',
      activityId: 'd',
    });
  });

  it('handles simple format', () => {
    const result = parseThreadId('conv123|act456');
    expect(result).toEqual({
      conversationId: 'conv123',
      activityId: 'act456',
    });
  });

  it('throws on missing pipe', () => {
    expect(() => parseThreadId('nopipehere')).toThrow('Invalid Teams thread ID format');
  });

  it('throws on empty conversationId', () => {
    expect(() => parseThreadId('|activityId')).toThrow('Invalid Teams thread ID format');
  });

  it('throws on empty activityId', () => {
    expect(() => parseThreadId('conversationId|')).toThrow('Invalid Teams thread ID format');
  });

  it('throws on empty string', () => {
    expect(() => parseThreadId('')).toThrow('Invalid Teams thread ID format');
  });
});

describe('stripMention', () => {
  it('strips mention at the beginning', () => {
    expect(stripMention('<at>TestBot</at> hello world', 'TestBot')).toBe('hello world');
  });

  it('strips mention in the middle', () => {
    expect(stripMention('hey <at>TestBot</at> do something', 'TestBot')).toBe('hey do something');
  });

  it('strips multiple mentions', () => {
    expect(stripMention('<at>TestBot</at> hello <at>TestBot</at> world', 'TestBot')).toBe(
      'hello world'
    );
  });

  it('is case-insensitive', () => {
    expect(stripMention('<at>testbot</at> hello', 'TestBot')).toBe('hello');
    expect(stripMention('<AT>TestBot</AT> hello', 'TestBot')).toBe('hello');
  });

  it('returns original text when no mention found', () => {
    expect(stripMention('hello world', 'TestBot')).toBe('hello world');
  });

  it('handles empty text', () => {
    expect(stripMention('', 'TestBot')).toBe('');
  });

  it('handles regex special characters in bot name', () => {
    expect(stripMention('<at>Bot (Test)</at> hello', 'Bot (Test)')).toBe('hello');
  });
});

describe('extractQuotedReplyText', () => {
  it('extracts user text from a quoted-reply attachment', () => {
    const attachments = [
      {
        contentType: 'text/html',
        content:
          '<blockquote itemscope itemtype="http://schema.skype.com/Reply" itemid="1777427261272">' +
          '<strong itemprop="mri" itemid="28:bot-id">Display Name</strong>' +
          '<span itemprop="time" itemid="1777427261272"></span>' +
          '<p itemprop="preview">Echo: hello</p>' +
          '</blockquote>\n<p>test reply</p>',
      },
    ];
    expect(extractQuotedReplyText(attachments)).toBe('test reply');
  });

  it('extracts multi-paragraph user text after blockquote', () => {
    // Teams separates the blockquote and user content with a newline
    const attachments = [
      {
        contentType: 'text/html',
        content:
          '<blockquote itemscope itemtype="http://schema.skype.com/Reply" itemid="123">' +
          '<p itemprop="preview">quoted text</p>' +
          '</blockquote>\n<p>line one</p>\n<p>line two</p>',
      },
    ];
    // Newlines between <p> tags are preserved after HTML stripping
    expect(extractQuotedReplyText(attachments)).toBe('line one\nline two');
  });

  it('returns null when no attachments', () => {
    expect(extractQuotedReplyText(undefined)).toBeNull();
  });

  it('returns null when attachments have no quoted reply', () => {
    const attachments = [
      {
        contentType: 'text/html',
        content: '<p>just a normal attachment</p>',
      },
    ];
    expect(extractQuotedReplyText(attachments)).toBeNull();
  });

  it('returns null for non-HTML attachment', () => {
    const attachments = [
      {
        contentType: 'application/json',
        content: '{"key": "value"}',
      },
    ];
    expect(extractQuotedReplyText(attachments)).toBeNull();
  });

  it('returns null when content after blockquote is empty', () => {
    const attachments = [
      {
        contentType: 'text/html',
        content:
          '<blockquote itemscope itemtype="http://schema.skype.com/Reply" itemid="123">' +
          '<p itemprop="preview">quoted</p>' +
          '</blockquote>',
      },
    ];
    expect(extractQuotedReplyText(attachments)).toBeNull();
  });
});

describe('TeamsConnector', () => {
  it('throws if app_id is missing', () => {
    expect(() => new TeamsConnector({ app_password: 'secret' })).toThrow(
      'Teams connector requires app_id in config'
    );
  });

  it('throws if app_password is missing', () => {
    expect(() => new TeamsConnector({ app_id: 'test-id' })).toThrow(
      'Teams connector requires app_password in config'
    );
  });

  it('creates connector with valid config', () => {
    const connector = new TeamsConnector({
      app_id: 'test-id',
      app_password: 'test-secret',
    });
    expect(connector.channelType).toBe('teams');
  });

  describe('formatMessage', () => {
    let connector: TeamsConnector;

    beforeAll(() => {
      connector = new TeamsConnector({
        app_id: 'test-id',
        app_password: 'test-secret',
      });
    });

    it('passes through standard markdown', () => {
      const input = '**bold** and _italic_ and `code`';
      expect(connector.formatMessage!(input)).toBe(input);
    });

    it('preserves code blocks', () => {
      const input = '```typescript\nconst x = 1;\n```';
      expect(connector.formatMessage!(input)).toBe(input);
    });

    it('collapses details/summary blocks', () => {
      const input =
        '<details>\n<summary>Click to expand</summary>\nHidden content here\n</details>';
      const output = connector.formatMessage!(input);
      expect(output).toContain('**Click to expand**');
      expect(output).toContain('Hidden content here');
      expect(output).not.toContain('<details>');
      expect(output).not.toContain('<summary>');
    });

    it('strips HTML tags', () => {
      const input = '<p>Hello</p> <b>World</b>';
      expect(connector.formatMessage!(input)).toBe('Hello World');
    });

    it('handles empty input', () => {
      expect(connector.formatMessage!('')).toBe('');
    });

    it('handles a realistic agent response', () => {
      const input = [
        '## Summary',
        '',
        'I made the following changes:',
        '',
        '- **Fixed** the login bug in `auth.ts`',
        '- Updated the documentation',
        '',
        '```typescript',
        'const user = await authenticate(token);',
        '```',
        '',
        '<details>',
        '<summary>Full diff</summary>',
        '+ added line',
        '- removed line',
        '</details>',
      ].join('\n');

      const output = connector.formatMessage!(input);

      // Markdown preserved
      expect(output).toContain('## Summary');
      expect(output).toContain('**Fixed**');
      expect(output).toContain('`auth.ts`');

      // Code block preserved
      expect(output).toContain('```typescript');

      // Details collapsed
      expect(output).toContain('**Full diff**');
      expect(output).not.toContain('<details>');
    });
  });
});

describe('createTeamsAuthConfiguration', () => {
  it('builds a channel-local Agents SDK connection registry for authorizeJWT', () => {
    const auth = createTeamsAuthConfiguration({
      app_id: 'app-123',
      app_password: 'secret',
      microsoft_tenant_id: 'tenant-1',
    });
    expect(auth.connections?.get('teams')).toMatchObject({
      clientId: 'app-123',
      tenantId: 'tenant-1',
      validateIssuer: true,
    });
    expect(auth.connectionsMap).toEqual([
      { serviceUrl: '*', audience: 'app-123', connection: 'teams' },
    ]);
  });
});

describe('normalizeTeamsActivity', () => {
  const config = { app_id: 'app-123' };

  function activity(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      id: 'activity-1',
      type: 'message',
      channelId: 'msteams',
      serviceUrl: 'https://smba.trafficmanager.net/teams/',
      timestamp: '2026-08-27T12:00:00.000Z',
      conversation: { id: '19:conversation@thread.v2', conversationType: 'personal' },
      from: { id: '29:user-1', name: 'Ada', aadObjectId: 'aad-1' },
      recipient: { id: '28:app-123', name: 'Agor' },
      channelData: { tenant: { id: 'tenant-1' }, channel: { type: 'standard' } },
      text: 'hello',
      ...overrides,
    };
  }

  it('maps personal and group chats to the whole conversation', () => {
    expect(normalizeTeamsActivity(activity(), config).threadId).toBe('19:conversation@thread.v2');
    expect(
      normalizeTeamsActivity(
        activity({
          id: 'activity-2',
          conversation: { id: '19:group@thread.v2', conversationType: 'groupChat' },
        }),
        config
      ).threadId
    ).toBe('19:group@thread.v2');
  });

  it('maps channel replies to the root reply chain and strips a structured mention', () => {
    const normalized = normalizeTeamsActivity(
      activity({
        conversation: {
          id: '19:channel@thread.tacv2;messageid=1700000000000',
          conversationType: 'channel',
        },
        replyToId: '1700000000000',
        text: '<at>Agor</at> please review',
        entities: [{ type: 'mention', text: '<at>Agor</at>', mentioned: { id: 'app-123' } }],
      }),
      config
    );
    expect(normalized.threadId).toBe('19:channel@thread.tacv2|1700000000000');
    expect(normalized.rootMessageId).toBe('1700000000000');
    expect(normalized.hasMention).toBe(true);
    expect(normalized.text).toBe('please review');
    expect(normalized.metadata.teams_channel_type).toBe('standard');
    expect(normalized.providerEventId).toBe('teams:activity:activity-1');
  });

  it('matches only the exact Teams app ID forms in structured mentions', () => {
    for (const mentionedId of ['app-123', '28:app-123']) {
      expect(
        normalizeTeamsActivity(
          activity({
            text: '<at>Agor</at> please review',
            entities: [{ type: 'mention', text: '<at>Agor</at>', mentioned: { id: mentionedId } }],
          }),
          config
        ).hasMention
      ).toBe(true);
    }
    expect(
      normalizeTeamsActivity(
        activity({
          text: '<at>Agor</at> please review',
          entities: [
            { type: 'mention', text: '<at>Someone</at>', mentioned: { id: 'prefix-app-123' } },
          ],
        }),
        config
      ).hasMention
    ).toBe(false);
  });

  it('does not treat a display-name at-tag as a structured app mention', () => {
    const normalized = normalizeTeamsActivity(
      activity({
        conversation: { id: '19:group@thread.v2', conversationType: 'groupChat' },
        text: '<at>Agor</at> please review',
      }),
      config
    );

    expect(normalized.hasMention).toBe(false);
    expect(normalized.text).toBe('Agor please review');
  });
});
