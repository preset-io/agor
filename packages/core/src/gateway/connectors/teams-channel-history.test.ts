import { afterEach, describe, expect, it, vi } from 'vitest';
import type { TeamsGatewayConfig } from '../../types/gateway';
import {
  fetchTeamsThreadHistory,
  listTeamsChannelPosts,
  TeamsChannelHistoryError,
} from './teams-channel-history';
import { resetTeamsGraphCaches } from './teams-graph';

const CHANNEL_ID = '19:4a95f7d8db4c4e7fae857bcebe0623e6@thread.tacv2';
const GROUP_ID = 'fbe2bf47-16c8-47cf-b4a5-4b9b187c508b';
const ROOT_ID = '1616989510408';
const CHANNEL_BASE = `https://graph.microsoft.com/v1.0/teams/${GROUP_ID}/channels/${encodeURIComponent(CHANNEL_ID)}/messages`;

const config: TeamsGatewayConfig = {
  app_id: '9f1c2a7e-0d6b-4c5e-8a3f-2b7d1e6c4a90',
  app_password: 'secret-1',
  microsoft_tenant_id: '72f988bf-86f1-41af-91ab-2d7cd011db47',
};

const team = {
  teamId: '19:team@thread.tacv2',
  teamGroupId: GROUP_ID,
  serviceUrl: 'https://smba.trafficmanager.net/amer/',
};
const cacheScope = {
  agorTenantId: 'tenant-a',
  gatewayChannelId: 'channel-a',
  providerConfigGeneration: 1,
};

function graphMessage(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    messageType: 'message',
    createdDateTime: new Date(Number(id)).toISOString(),
    lastModifiedDateTime: new Date(Number(id)).toISOString(),
    deletedDateTime: null,
    subject: null,
    from: { user: { id: 'aad-robin', displayName: 'Robin Kline' }, application: null },
    body: { contentType: 'html', content: `<p>message ${id}</p>` },
    attachments: [],
    mentions: [],
    ...overrides,
  };
}

function json(body: unknown, status = 200, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

function fakeFetch(route: (url: string) => Response | undefined) {
  return vi.fn(async (input: string | URL | Request) => {
    const url = String(input);
    if (url.startsWith('https://login.microsoftonline.com/')) {
      return json({ token_type: 'Bearer', expires_in: 3599, access_token: 'graph-token' });
    }
    const response = route(url);
    if (response) return response;
    throw new Error(`unexpected request ${url}`);
  });
}

function graphUrls(fetchImpl: ReturnType<typeof fakeFetch>): string[] {
  return fetchImpl.mock.calls
    .map(([url]) => String(url))
    .filter((url) => url.startsWith('https://graph.microsoft.com/'));
}

afterEach(() => {
  resetTeamsGraphCaches();
  vi.useRealTimers();
});

describe('Teams thread history', () => {
  it('returns the root and one reply page in order, with a page token and no URLs', async () => {
    const nextLink = `${CHANNEL_BASE}/${ROOT_ID}/replies?$top=2&$skiptoken=page-2`;
    const fetchImpl = fakeFetch((url) => {
      if (url === `${CHANNEL_BASE}/${ROOT_ID}`) return json(graphMessage(ROOT_ID));
      if (url === `${CHANNEL_BASE}/${ROOT_ID}/replies?%24top=2`) {
        return json({
          value: [
            graphMessage('1616990000002', {
              attachments: [
                {
                  contentType: 'reference',
                  contentUrl: 'https://contoso.sharepoint.com/secret.docx',
                  name: 'plan.docx',
                },
              ],
            }),
            graphMessage('1616990000001', {
              from: { application: { id: config.app_id, displayName: 'Agor' } },
            }),
          ],
          '@odata.nextLink': nextLink,
        });
      }
      return undefined;
    });
    const result = await fetchTeamsThreadHistory(
      config,
      { team, channelId: CHANNEL_ID, rootMessageId: ROOT_ID, limit: 2, cacheScope },
      { fetchImpl }
    );
    expect(result.messages.map((message) => message.id)).toEqual([ROOT_ID, '1616990000002']);
    expect(result.messages[1].attachments).toEqual([
      { name: 'plan.docx', content_type: 'reference' },
    ]);
    expect(result).toMatchObject({ has_more: true, next_cursor: 'page-2' });
    expect(JSON.stringify(result)).not.toMatch(/https?:/);

    const second = await fetchTeamsThreadHistory(
      config,
      {
        team,
        channelId: CHANNEL_ID,
        rootMessageId: ROOT_ID,
        limit: 2,
        cursor: 'page-2',
        cacheScope,
      },
      {
        fetchImpl: fakeFetch((url) =>
          url === `${CHANNEL_BASE}/${ROOT_ID}/replies?%24top=2&%24skiptoken=page-2`
            ? json({ value: [graphMessage('1616989900000')] })
            : undefined
        ),
      }
    );
    expect(second).toMatchObject({ has_more: false, next_cursor: null });
    expect(second.messages.map((message) => message.id)).toEqual(['1616989900000']);
  });

  it('keeps a hostile cursor on the Graph origin and refuses a foreign pagination link', async () => {
    const fetchImpl = fakeFetch(() =>
      json({ value: [], '@odata.nextLink': 'https://evil.example/replies?$skiptoken=x' })
    );
    await expect(
      fetchTeamsThreadHistory(
        config,
        {
          team,
          channelId: CHANNEL_ID,
          rootMessageId: ROOT_ID,
          cursor: 'x&$filter=1#https://evil.example/',
          cacheScope,
        },
        { fetchImpl }
      )
    ).rejects.toMatchObject({ code: 'provider' });
    const [url] = graphUrls(fetchImpl);
    expect(new URL(url).origin).toBe('https://graph.microsoft.com');
    expect(new URL(url).searchParams.get('$skiptoken')).toBe('x&$filter=1#https://evil.example/');
  });

  it('cuts text to one byte budget without dropping messages', async () => {
    const big = 'x'.repeat(40 * 1024);
    const fetchImpl = fakeFetch((url) =>
      url.includes('/replies')
        ? json({
            value: [
              graphMessage('1616990000001', { body: { contentType: 'text', content: big } }),
              graphMessage('1616990000002', { body: { contentType: 'text', content: big } }),
            ],
          })
        : json(graphMessage(ROOT_ID))
    );
    const result = await fetchTeamsThreadHistory(
      config,
      { team, channelId: CHANNEL_ID, rootMessageId: ROOT_ID, cacheScope },
      { fetchImpl }
    );
    expect(result.messages).toHaveLength(3);
    expect(result.messages[2]).toMatchObject({ text_truncated: true });
    expect(result.messages[1].text_truncated).toBeUndefined();
  });

  it('reports a Graph 403 as RSC not granted and stops asking for that team', async () => {
    const fetchImpl = fakeFetch(() => json({ error: { code: 'Forbidden' } }, 403));
    const read = () =>
      fetchTeamsThreadHistory(
        config,
        { team, channelId: CHANNEL_ID, rootMessageId: ROOT_ID, cacheScope },
        { fetchImpl }
      );
    await expect(read()).rejects.toMatchObject({ code: 'rsc_not_granted' });
    await expect(read()).rejects.toMatchObject({ code: 'rsc_not_granted' });
    expect(graphUrls(fetchImpl)).toHaveLength(1);
  });

  it('waits out a short Retry-After but fails as rate limited past the budget', async () => {
    let calls = 0;
    const shortWait = fakeFetch((url) => {
      if (!url.includes('/replies')) return json(graphMessage(ROOT_ID));
      calls += 1;
      return calls === 1 ? json({}, 429, { 'retry-after': '0' }) : json({ value: [] });
    });
    await expect(
      fetchTeamsThreadHistory(
        config,
        { team, channelId: CHANNEL_ID, rootMessageId: ROOT_ID, cacheScope },
        { fetchImpl: shortWait }
      )
    ).resolves.toMatchObject({ has_more: false });
    const longWait = fakeFetch(() => json({}, 429, { 'retry-after': '30' }));
    const error = await fetchTeamsThreadHistory(
      config,
      { team, channelId: CHANNEL_ID, rootMessageId: ROOT_ID, cacheScope },
      { fetchImpl: longWait }
    ).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(TeamsChannelHistoryError);
    expect(error).toMatchObject({ code: 'rate_limited' });
    expect(String((error as Error).message)).not.toContain('graph.microsoft.com');
  });

  it('refuses malformed identifiers before any request', async () => {
    const fetchImpl = fakeFetch(() => undefined);
    await expect(
      fetchTeamsThreadHistory(
        config,
        { team, channelId: 'https://evil.example', rootMessageId: ROOT_ID },
        { fetchImpl }
      )
    ).rejects.toMatchObject({ code: 'invalid_request' });
    await expect(
      fetchTeamsThreadHistory(
        config,
        { team, channelId: CHANNEL_ID, rootMessageId: '../me', limit: 2 },
        { fetchImpl }
      )
    ).rejects.toMatchObject({ code: 'invalid_request' });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe('Teams channel posts', () => {
  it('lists post previews with subjects and drops system messages', async () => {
    const fetchImpl = fakeFetch((url) =>
      url === `${CHANNEL_BASE}?%24top=20`
        ? json({
            value: [
              graphMessage('1616990000005', { subject: 'Release plan' }),
              graphMessage('1616990000004', { messageType: 'systemEventMessage' }),
            ],
          })
        : undefined
    );
    const result = await listTeamsChannelPosts(
      config,
      { team, channelId: CHANNEL_ID, cacheScope },
      { fetchImpl }
    );
    expect(result.posts).toEqual([
      expect.objectContaining({
        id: '1616990000005',
        subject: 'Release plan',
        text_preview: 'message 1616990000005',
        is_bot: false,
      }),
    ]);
    expect(result).toMatchObject({ has_more: false, next_cursor: null });
  });
});
