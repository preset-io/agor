import { afterEach, describe, expect, it, vi } from 'vitest';
import { isAllowedTeamsServiceUrl } from '../teams-service-url';
import {
  classifyTeamsSendFailure,
  prepareTeamsSend,
  startTeamsChannelThread,
  TeamsSendError,
} from './teams-send';

const address = {
  activityId: 'activity-1',
  serviceUrl: 'https://smba.trafficmanager.net/amer/',
  channelId: 'msteams',
  conversation: { id: '19:channel@thread.tacv2;messageid=root-1', conversationType: 'channel' },
  agent: { id: '28:teams-app', name: 'Agor' },
  user: { id: '29:human', name: 'Ada' },
};

function jsonResponse(status: number, body: unknown, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

describe('isAllowedTeamsServiceUrl', () => {
  it('accepts Bot Connector hosts over https only', () => {
    expect(isAllowedTeamsServiceUrl('https://smba.trafficmanager.net/teams/')).toBe(true);
    expect(isAllowedTeamsServiceUrl('https://smba.infra.gov.teams.microsoft.us/')).toBe(true);
    expect(isAllowedTeamsServiceUrl('http://smba.trafficmanager.net/teams/')).toBe(false);
    expect(isAllowedTeamsServiceUrl('https://graph.microsoft.com/')).toBe(false);
    expect(isAllowedTeamsServiceUrl('https://smba.trafficmanager.net.evil.test/')).toBe(false);
    expect(isAllowedTeamsServiceUrl(undefined)).toBe(false);
  });
});

describe('prepareTeamsSend', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('refuses a non-allowlisted service URL before a token is requested', async () => {
    const getAccessToken = vi.fn(async () => 'token');
    const error = await prepareTeamsSend(
      { ...address, serviceUrl: 'https://attacker.example/' },
      { getAccessToken }
    ).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(TeamsSendError);
    expect(error).toMatchObject({ phase: 'prepare', reason: 'service_url_not_allowed' });
    expect(getAccessToken).not.toHaveBeenCalled();
    expect(classifyTeamsSendFailure(error)).toEqual({
      kind: 'terminal',
      code: 'conversation_service_url_not_allowed',
    });
  });

  it('reports a token failure as a retryable pre-effect failure', async () => {
    const error = await prepareTeamsSend(address, {
      getAccessToken: async () => {
        throw new Error('AADSTS7000215 secret prose');
      },
    }).catch((caught: unknown) => caught);
    expect(error).toMatchObject({ phase: 'prepare', reason: 'token_unavailable' });
    expect(String((error as Error).message)).not.toContain('AADSTS');
    expect(classifyTeamsSendFailure(error)).toEqual({ kind: 'retry', code: 'token_unavailable' });
  });

  it('replies into the thread with the bearer token and returns the activity id', async () => {
    const fetchMock = vi.fn(async () => jsonResponse(201, { id: 'reply-1' }));
    vi.stubGlobal('fetch', fetchMock);
    const scope = vi.fn(async (_scope: string) => 'bot-token');
    const prepared = await prepareTeamsSend(address, { getAccessToken: scope });
    await expect(prepared.send('hello **world**')).resolves.toBe('reply-1');
    expect(scope).toHaveBeenCalledWith('https://api.botframework.com');
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(
      'https://smba.trafficmanager.net/amer/v3/conversations/19:channel@thread.tacv2;messageid=root-1/activities/activity-1'
    );
    expect(new Headers(init.headers).get('authorization')).toBe('Bearer bot-token');
    expect(JSON.parse(String(init.body))).toMatchObject({
      type: 'message',
      text: 'hello **world**',
      textFormat: 'markdown',
      replyToId: 'activity-1',
      channelId: 'msteams',
    });
  });

  it('sends a bare typing activity to the same thread', async () => {
    const fetchMock = vi.fn(async () => jsonResponse(201, {}));
    vi.stubGlobal('fetch', fetchMock);
    const prepared = await prepareTeamsSend(address, { getAccessToken: async () => 'bot-token' });
    await prepared.sendTyping();
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(
      'https://smba.trafficmanager.net/amer/v3/conversations/19:channel@thread.tacv2;messageid=root-1/activities/activity-1'
    );
    const body = JSON.parse(String(init.body));
    expect(body).toMatchObject({ type: 'typing', replyToId: 'activity-1' });
    expect(body).not.toHaveProperty('text');
  });

  it('maps provider and network failures without keeping provider prose', async () => {
    const prepared = await prepareTeamsSend(address, { getAccessToken: async () => 'token' });
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        jsonResponse(
          429,
          { error: { code: 'Throttled', message: 'slow down' } },
          { 'retry-after': '3' }
        )
      )
    );
    const throttled = await prepared.send('x').catch((caught: unknown) => caught);
    expect(throttled).toMatchObject({ phase: 'send', status: 429, retryAfterMs: 3_000 });
    expect(String((throttled as Error).message)).not.toContain('slow down');

    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('fetch failed', { cause: { code: 'ECONNREFUSED' } });
      })
    );
    const refused = await prepared.send('x').catch((caught: unknown) => caught);
    expect(classifyTeamsSendFailure(refused)).toEqual({
      kind: 'retry',
      code: 'provider_unreachable',
    });

    await expect(prepared.send('x'.repeat(40_001))).rejects.toMatchObject({ status: 413 });
  });

  it('preserves Retry-After when a precondition response is classified for delivery', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse(412, {}, { 'retry-after': '7' }))
    );
    const prepared = await prepareTeamsSend(address, { getAccessToken: async () => 'token' });
    const error = await prepared.send('x').catch((caught: unknown) => caught);
    expect(error).toMatchObject({ phase: 'send', status: 412, retryAfterMs: 7_000 });
    expect(classifyTeamsSendFailure(error)).toEqual({
      kind: 'retry',
      code: 'provider_http_412',
      retryAfterMs: 7_000,
    });
  });
});

describe('classifyTeamsSendFailure', () => {
  const send = (status: number, providerCode?: string, extra: Record<string, unknown> = {}) =>
    classifyTeamsSendFailure(new TeamsSendError({ phase: 'send', status, providerCode, ...extra }));

  it('retries proven non-acceptance with Retry-After and refreshes tokens on 401', () => {
    expect(send(429, undefined, { retryAfterMs: 2_000 })).toEqual({
      kind: 'retry',
      code: 'provider_rate_limited',
      retryAfterMs: 2_000,
    });
    expect(send(412)).toEqual({ kind: 'retry', code: 'provider_http_412' });
    expect(send(401)).toEqual({ kind: 'retry', code: 'provider_http_401', refreshToken: true });
  });

  it('never resends a possibly accepted chunk', () => {
    for (const status of [502, 503, 504]) {
      expect(send(status)).toEqual({ kind: 'ambiguous', code: `provider_http_${status}` });
    }
    expect(
      classifyTeamsSendFailure(new TeamsSendError({ phase: 'send', networkCode: 'ECONNRESET' }))
    ).toEqual({ kind: 'ambiguous', code: 'provider_effect_unknown' });
    expect(classifyTeamsSendFailure(new Error('unexpected'))).toEqual({
      kind: 'ambiguous',
      code: 'provider_effect_unknown',
    });
  });

  it('classifies size, revocation, and definitive rejections', () => {
    expect(send(413)).toEqual({ kind: 'too_large', code: 'provider_http_413' });
    expect(send(403, 'BotNotInConversationRoster')).toMatchObject({
      kind: 'revoked',
      reason: 'bot_removed',
    });
    expect(send(403, 'ConversationBlockedByUser')).toMatchObject({
      kind: 'revoked',
      reason: 'conversation_blocked',
    });
    expect(send(403, 'MessageWritesBlocked')).toMatchObject({
      kind: 'revoked',
      reason: 'writes_blocked',
    });
    expect(send(404, 'ConversationNotFound')).toMatchObject({
      kind: 'revoked',
      reason: 'conversation_not_found',
    });
    expect(send(403, 'BotDisabledByAdmin')).toMatchObject({
      kind: 'revoked',
      reason: 'bot_disabled',
    });
    expect(send(500)).toEqual({ kind: 'terminal', code: 'provider_http_500' });
    expect(send(400)).toEqual({ kind: 'terminal', code: 'provider_http_400' });
    expect(send(403)).toEqual({ kind: 'terminal', code: 'provider_http_403' });
  });
});

describe('startTeamsChannelThread', () => {
  const CHANNEL = '19:4a95f7d8db4c4e7fae857bcebe0623e6@thread.tacv2';
  const input = { channelId: CHANNEL, tenantId: 'tenant-1', appId: 'teams-app' };

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('creates the channel post, reads the root, and replies with later chunks', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse(201, { id: `${CHANNEL};messageid=1616990000001`, activityId: '' })
      )
      .mockResolvedValueOnce(jsonResponse(201, { id: '1616990000002' }));
    vi.stubGlobal('fetch', fetchMock);
    const result = await startTeamsChannelThread(
      address,
      { getAccessToken: async () => 'bot-token' },
      { ...input, chunks: ['first', 'second'] }
    );
    expect(result).toEqual({ rootMessageId: '1616990000001', sentChunks: 2 });
    const [createUrl, createInit] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(createUrl).toBe('https://smba.trafficmanager.net/amer/v3/conversations');
    expect(JSON.parse(String(createInit.body))).toMatchObject({
      isGroup: true,
      bot: { id: '28:teams-app' },
      tenantId: 'tenant-1',
      channelData: { channel: { id: CHANNEL }, tenant: { id: 'tenant-1' } },
      activity: { type: 'message', text: 'first', textFormat: 'markdown' },
    });
    expect(fetchMock.mock.calls[1]?.[0]).toBe(
      `https://smba.trafficmanager.net/amer/v3/conversations/${CHANNEL};messageid=1616990000001/activities/1616990000001`
    );
  });

  it('prefers activityId for the root and reports a later-chunk failure as partial', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(201, { id: CHANNEL, activityId: '1616990000005' }))
      .mockResolvedValueOnce(jsonResponse(502, {}));
    vi.stubGlobal('fetch', fetchMock);
    const result = await startTeamsChannelThread(
      address,
      { getAccessToken: async () => 'bot-token' },
      { ...input, chunks: ['first', 'second'] }
    );
    expect(result).toMatchObject({ rootMessageId: '1616990000005', sentChunks: 1 });
    expect(classifyTeamsSendFailure(result.error)).toEqual({
      kind: 'ambiguous',
      code: 'provider_http_502',
    });
  });

  it('refuses a disallowed host before any token, and classifies first-chunk failures', async () => {
    const getAccessToken = vi.fn(async () => 'bot-token');
    await expect(
      startTeamsChannelThread(
        { ...address, serviceUrl: 'https://attacker.example/' },
        { getAccessToken },
        { ...input, chunks: ['x'] }
      )
    ).rejects.toMatchObject({ phase: 'prepare', reason: 'service_url_not_allowed' });
    expect(getAccessToken).not.toHaveBeenCalled();

    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse(429, {}, { 'retry-after': '1' }))
    );
    const limited = await startTeamsChannelThread(
      address,
      { getAccessToken },
      { ...input, chunks: ['x'] }
    ).catch((caught: unknown) => caught);
    expect(classifyTeamsSendFailure(limited)).toEqual({
      kind: 'retry',
      code: 'provider_rate_limited',
      retryAfterMs: 1000,
    });

    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse(201, { id: CHANNEL }))
    );
    const unaddressable = await startTeamsChannelThread(
      address,
      { getAccessToken },
      { ...input, chunks: ['x'] }
    ).catch((caught: unknown) => caught);
    expect(classifyTeamsSendFailure(unaddressable)).toMatchObject({ kind: 'ambiguous' });
  });
});
