import { beforeAll, describe, expect, it, vi } from 'vitest';
import {
  createTeamsAuthConfiguration,
  extractQuotedReplyText,
  fetchTeamsMemberIdentity,
  normalizeTeamsActivity,
  parseThreadId,
  probeTeamsCredentials,
  stripMention,
  TeamsConnector,
  TeamsMemberLookupError,
} from './teams';

function jwt(claims: Record<string, unknown>): string {
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
  return `${encode({ alg: 'none' })}.${encode(claims)}.signature`;
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

const probeConfig = {
  app_id: 'teams-app-id',
  app_password: 'client-secret-value',
  microsoft_tenant_id: 'tenant-guid',
};

describe('probeTeamsCredentials', () => {
  it('verifies the exact app and tenant with an uncached client-credentials request', async () => {
    const fetchImpl = vi.fn(async (_url: string, _init?: RequestInit) =>
      jsonResponse(200, {
        access_token: jwt({ appid: 'teams-app-id', tid: 'tenant-guid' }),
        expires_in: 3599,
      })
    );
    const result = await probeTeamsCredentials(probeConfig, { fetchImpl });
    expect(result).toMatchObject({
      ok: true,
      verifiedInstallationId: 'teams-app-id',
      failures: [],
      verification: { status: 'verified', warnings: [] },
    });
    expect(result.notVerifiable.length).toBeGreaterThan(0);
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe('https://login.microsoftonline.com/tenant-guid/oauth2/v2.0/token');
    const body = new URLSearchParams(String(init?.body));
    expect(body.get('grant_type')).toBe('client_credentials');
    expect(body.get('client_id')).toBe('teams-app-id');
    expect(body.get('scope')).toBe('https://api.botframework.com/.default');
    // The secret never appears in the result.
    expect(JSON.stringify(result)).not.toContain('client-secret-value');
  });

  it('fails closed with operator guidance for a bad secret, unknown app, or tenant', async () => {
    for (const [codes, reason] of [
      [[7000215], 'app password is invalid or expired'],
      [[700016], 'not registered in this Microsoft tenant'],
      [[90002], 'tenant ID was not found'],
    ] as const) {
      const result = await probeTeamsCredentials(probeConfig, {
        fetchImpl: async () =>
          jsonResponse(400, {
            error: 'invalid_client',
            error_codes: codes,
            error_description: 'x',
          }),
      });
      expect(result.ok).toBe(false);
      expect(result.verifiedInstallationId).toBeUndefined();
      expect(result.failures[0]?.reason).toContain(reason);
    }
  });

  it('rejects a token issued for another app or tenant, and unreachable identity endpoints', async () => {
    const mismatched = await probeTeamsCredentials(probeConfig, {
      fetchImpl: async () =>
        jsonResponse(200, { access_token: jwt({ appid: 'other-app', tid: 'tenant-guid' }) }),
    });
    expect(mismatched).toMatchObject({ ok: false, failures: [{ capability: 'app_id' }] });
    const offline = await probeTeamsCredentials(probeConfig, {
      fetchImpl: async () => {
        throw new TypeError('fetch failed');
      },
    });
    expect(offline).toMatchObject({ ok: false, failures: [{ capability: 'app_password' }] });
    const missing = await probeTeamsCredentials({ app_id: 'teams-app-id' });
    expect(missing).toMatchObject({ ok: false, failures: [{ capability: 'config' }] });
  });
});

describe('fetchTeamsMemberIdentity', () => {
  const request = {
    config: probeConfig,
    serviceUrl: 'https://smba.trafficmanager.net/amer/',
    conversationId: '19:team@thread.tacv2',
    userId: '29:user-1',
  };
  const getToken = async () => 'bot-token';

  it('reads the member email through the verified service URL with the bot token', async () => {
    const fetchImpl = vi.fn(async (_url: string, _init?: RequestInit) =>
      jsonResponse(200, {
        id: '29:user-1',
        aadObjectId: 'aad-1',
        email: 'ada@example.com',
        userPrincipalName: 'ada@contoso.onmicrosoft.com',
      })
    );
    await expect(fetchTeamsMemberIdentity(request, { fetchImpl, getToken })).resolves.toEqual({
      email: 'ada@example.com',
      userPrincipalName: 'ada@contoso.onmicrosoft.com',
      aadObjectId: 'aad-1',
    });
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe(
      'https://smba.trafficmanager.net/amer/v3/conversations/19%3Ateam%40thread.tacv2/members/29%3Auser-1'
    );
    expect(init?.headers).toMatchObject({ Authorization: 'Bearer bot-token' });
  });

  it('returns the UPN when Teams omits email, and null for an unknown member', async () => {
    const upnOnly = await fetchTeamsMemberIdentity(request, {
      getToken,
      fetchImpl: async () => jsonResponse(200, { userPrincipalName: 'guest#EXT#@contoso.com' }),
    });
    expect(upnOnly).toMatchObject({ email: null, userPrincipalName: 'guest#EXT#@contoso.com' });
    await expect(
      fetchTeamsMemberIdentity(request, {
        getToken,
        fetchImpl: async () => jsonResponse(404, { error: { code: 'MemberNotFound' } }),
      })
    ).resolves.toBeNull();
  });

  it('classifies transient failures as retryable and never sends the token to a non-HTTPS URL', async () => {
    for (const status of [429, 503]) {
      const error = await fetchTeamsMemberIdentity(request, {
        getToken,
        fetchImpl: async () => jsonResponse(status, {}),
      }).catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(TeamsMemberLookupError);
      expect((error as TeamsMemberLookupError).retryable).toBe(true);
    }
    const fetchImpl = vi.fn();
    const insecure = await fetchTeamsMemberIdentity(
      { ...request, serviceUrl: 'http://attacker.example/' },
      { getToken, fetchImpl }
    ).catch((caught: unknown) => caught);
    expect(insecure).toMatchObject({ code: 'teams_service_url_invalid', retryable: false });
    const foreign = await fetchTeamsMemberIdentity(
      { ...request, serviceUrl: 'https://attacker.example/' },
      { getToken, fetchImpl }
    ).catch((caught: unknown) => caught);
    expect(foreign).toMatchObject({ code: 'teams_service_url_invalid', retryable: false });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

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

    it('keeps fenced and inline code intact, including tags inside it', () => {
      const fenced =
        '```tsx\nconst items: Array<string> = [];\nreturn <Button onClick={go}>Go</Button>;\n```';
      const input = `Use \`Array<string>\` and <b>bold</b>.\n\n${fenced}\n\nDone <br/>`;
      expect(connector.formatMessage!(input)).toBe(
        `Use \`Array<string>\` and bold.\n\n${fenced}\n\nDone`
      );
    });

    it('keeps double-backtick spans and tilde fences intact', () => {
      const input = 'Use ``Array<T>`` and <i>x</i>\n\n~~~\n<App />\n~~~';
      expect(connector.formatMessage!(input)).toBe('Use ``Array<T>`` and x\n\n~~~\n<App />\n~~~');
    });

    it('keeps code inside a collapsed details block and an unclosed fence', () => {
      const input =
        '<details>\n<summary>Diff</summary>\n\n```diff\n+ <Foo />\n```\n</details>\n\n```\n<open>';
      expect(connector.formatMessage!(input)).toBe(
        '**Diff**\n```diff\n+ <Foo />\n```\n\n```\n<open>'
      );
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
    expect(normalized.providerEventId).toBe(
      'teams:activity:["19:channel@thread.tacv2","activity-1"]'
    );
  });

  it('captures the team M365 group GUID Graph needs alongside the Teams team thread ID', () => {
    const normalized = normalizeTeamsActivity(
      activity({
        id: '1616990132035',
        conversation: {
          id: '19:4a95f7d8db4c4e7fae857bcebe0623e6@thread.tacv2;messageid=1616989510408',
          conversationType: 'channel',
          tenantId: 'tenant-1',
        },
        replyToId: '1616989510408',
        text: '<at>Agor</at> summarize',
        entities: [{ type: 'mention', text: '<at>Agor</at>', mentioned: { id: '28:app-123' } }],
        channelData: {
          teamsChannelId: '19:4a95f7d8db4c4e7fae857bcebe0623e6@thread.tacv2',
          teamsTeamId: '19:1c3bd6d47a4c4f3e8b2a9d2e7c1f0a11@thread.tacv2',
          channel: { id: '19:4a95f7d8db4c4e7fae857bcebe0623e6@thread.tacv2' },
          team: {
            id: '19:1c3bd6d47a4c4f3e8b2a9d2e7c1f0a11@thread.tacv2',
            name: 'Contoso',
            aadGroupId: 'fbe2bf47-16c8-47cf-b4a5-4b9b187c508b',
          },
          tenant: { id: 'tenant-1' },
        },
      }),
      config
    );
    expect(normalized.conversationId).toBe('19:4a95f7d8db4c4e7fae857bcebe0623e6@thread.tacv2');
    expect(normalized.metadata.teams_team_id).toBe(
      '19:1c3bd6d47a4c4f3e8b2a9d2e7c1f0a11@thread.tacv2'
    );
    expect(normalized.metadata.teams_team_aad_group_id).toBe(
      'fbe2bf47-16c8-47cf-b4a5-4b9b187c508b'
    );
  });

  it('deduplicates by base conversation and activity, not activity alone or reply-chain suffix', () => {
    const eventId = (conversationId: string, id = 'same-activity') =>
      normalizeTeamsActivity(
        activity({
          id,
          conversation: { id: conversationId, conversationType: 'channel' },
          replyToId: 'root',
        }),
        config
      ).providerEventId;
    expect(eventId('first')).toBe(eventId('first'));
    expect(eventId('first')).not.toBe(eventId('second'));
    expect(eventId('first;messageid=root')).toBe(eventId('first'));
    expect(eventId('first', 'next-activity')).not.toBe(eventId('first'));
  });

  it('does not collide when opaque IDs contain delimiters or JSON characters', () => {
    const pairs = [
      ['a|b', 'c'],
      ['a', 'b|c'],
      ['a:b', 'c'],
      ['a', 'b:c'],
      ['a"', 'b\\c'],
    ];
    const eventIds = pairs.map(
      ([conversationId, id]) =>
        normalizeTeamsActivity(
          activity({ id, conversation: { id: conversationId, conversationType: 'personal' } }),
          config
        ).providerEventId
    );
    expect(new Set(eventIds).size).toBe(pairs.length);
    expect(eventIds.map((id) => JSON.parse(id.slice('teams:activity:'.length)))).toEqual(pairs);
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
