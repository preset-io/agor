import { afterEach, describe, expect, it, vi } from 'vitest';
import { isAllowedTeamsServiceUrl } from '../teams-service-url';
import { classifyTeamsSendFailure, prepareTeamsSend, TeamsSendError } from './teams-send';

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
