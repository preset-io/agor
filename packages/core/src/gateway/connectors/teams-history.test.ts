import { afterEach, describe, expect, it, vi } from 'vitest';
import type { TeamsGatewayConfig } from '../../types/gateway';
import type { GatewayProviderHistoryRequest } from '../connector';
import { TeamsConnector } from './teams';
import {
  fetchTeamsProviderHistory,
  resetTeamsHistoryCaches,
  type TeamsProviderHistoryContext,
} from './teams-history';

// Real-format identifiers: Teams thread IDs for teams/channels, an M365 group GUID, epoch-ms message IDs.
const TEAM_THREAD_ID = '19:1c3bd6d47a4c4f3e8b2a9d2e7c1f0a11@thread.tacv2';
const CHANNEL_ID = '19:4a95f7d8db4c4e7fae857bcebe0623e6@thread.tacv2';
const GROUP_ID = 'fbe2bf47-16c8-47cf-b4a5-4b9b187c508b';
const ROOT_ID = '1616989510408';
const TRIGGER_ID = '1616990132035';
const SERVICE_URL = 'https://smba.trafficmanager.net/amer/';
const GRAPH_BASE = `https://graph.microsoft.com/v1.0/teams/${GROUP_ID}/channels/${encodeURIComponent(CHANNEL_ID)}/messages/${ROOT_ID}`;

const config: TeamsGatewayConfig = {
  app_id: '9f1c2a7e-0d6b-4c5e-8a3f-2b7d1e6c4a90',
  app_password: 'secret-1',
  microsoft_tenant_id: '72f988bf-86f1-41af-91ab-2d7cd011db47',
  catch_up: {
    mode: 'best_effort',
    max_messages: 50,
    max_prompt_bytes: 16_384,
    request_timeout_ms: 8_000,
  },
};

function graphMessage(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    replyToId: id === ROOT_ID ? null : ROOT_ID,
    etag: id,
    messageType: 'message',
    createdDateTime: new Date(Number(id)).toISOString(),
    lastModifiedDateTime: new Date(Number(id)).toISOString(),
    deletedDateTime: null,
    subject: null,
    importance: 'normal',
    locale: 'en-us',
    from: {
      application: null,
      device: null,
      user: {
        '@odata.type': '#microsoft.graph.teamworkUserIdentity',
        id: '8ea0e38b-efb3-4757-924a-5f94061cf8c2',
        displayName: 'Robin Kline',
        userIdentityType: 'aadUser',
        tenantId: config.microsoft_tenant_id,
      },
    },
    body: { contentType: 'html', content: `<p>message ${id}</p>` },
    channelIdentity: { teamId: GROUP_ID, channelId: CHANNEL_ID },
    attachments: [],
    mentions: [],
    reactions: [],
    ...overrides,
  };
}

function context(
  overrides: Partial<TeamsProviderHistoryContext> = {}
): TeamsProviderHistoryContext {
  return {
    teamId: TEAM_THREAD_ID,
    teamGroupId: GROUP_ID,
    serviceUrl: SERVICE_URL,
    triggerTimestamp: new Date(Number(TRIGGER_ID)).toISOString(),
    cacheScope: {
      agorTenantId: 'tenant-a',
      gatewayChannelId: 'channel-a',
      providerConfigGeneration: 3,
    },
    ...overrides,
  };
}

function request(
  overrides: Partial<GatewayProviderHistoryRequest> = {},
  providerContext: TeamsProviderHistoryContext = context()
): GatewayProviderHistoryRequest {
  return {
    threadId: `${CHANNEL_ID}|${ROOT_ID}`,
    throughProviderCursor: TRIGGER_ID,
    triggerProviderCursor: TRIGGER_ID,
    providerContext,
    ...overrides,
  };
}

function json(body: unknown, status = 200, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

type Route = (url: string, init?: RequestInit) => Response | undefined;

function fakeFetch(...routes: Route[]) {
  return vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (url.startsWith('https://login.microsoftonline.com/')) {
      const scope = new URLSearchParams(String(init?.body)).get('scope');
      return json({
        token_type: 'Bearer',
        expires_in: 3599,
        access_token: scope?.startsWith('https://graph') ? 'graph-token' : 'bot-token',
      });
    }
    for (const route of routes) {
      const response = route(url, init);
      if (response) return response;
    }
    throw new Error(`unexpected request ${url}`);
  });
}

function graphCalls(fetchImpl: ReturnType<typeof fakeFetch>) {
  return fetchImpl.mock.calls
    .map(([url]) => String(url))
    .filter((url) => url.startsWith('https://graph.microsoft.com/'));
}

function tokenCalls(fetchImpl: ReturnType<typeof fakeFetch>) {
  return fetchImpl.mock.calls.filter(([url]) => String(url).startsWith('https://login.'));
}

afterEach(() => {
  resetTeamsHistoryCaches();
  vi.unstubAllGlobals();
});

describe('Teams provider history', () => {
  it('reads the reply chain by M365 group GUID with an RSC token that carries no roles', async () => {
    const fetchImpl = fakeFetch((url, init) => {
      expect(new Headers(init?.headers).get('authorization')).toBe('Bearer graph-token');
      if (url === GRAPH_BASE) return json(graphMessage(ROOT_ID));
      if (url === `${GRAPH_BASE}/replies?$top=50`) {
        return json({ value: [graphMessage('1616990032035'), graphMessage(TRIGGER_ID)] });
      }
    });
    const result = await fetchTeamsProviderHistory(config, request(), { fetchImpl });
    expect(result.complete).toBe(true);
    expect(result.messages.map((message) => message.providerMessageId)).toEqual([
      ROOT_ID,
      '1616990032035',
      TRIGGER_ID,
    ]);
    expect(result.messages.at(-1)).toMatchObject({ isTrigger: true });
    expect(result.messages[1]).toMatchObject({
      actorLabel: 'Robin Kline',
      text: 'message 1616990032035',
    });
    expect(graphCalls(fetchImpl).every((url) => !url.includes('@thread.tacv2/channels'))).toBe(
      true
    );
  });

  it('resolves a missing aadGroupId through the Bot Connector once per tenant/channel/team', async () => {
    const teamDetails = vi.fn(() =>
      json({ id: TEAM_THREAD_ID, name: 'Contoso', aadGroupId: GROUP_ID, type: 'standard' })
    );
    const fetchImpl = fakeFetch((url, init) => {
      if (url === `${SERVICE_URL}v3/teams/${encodeURIComponent(TEAM_THREAD_ID)}`) {
        expect(new Headers(init?.headers).get('authorization')).toBe('Bearer bot-token');
        return teamDetails();
      }
      if (url === GRAPH_BASE) return json(graphMessage(ROOT_ID));
      if (url.startsWith(`${GRAPH_BASE}/replies`)) return json({ value: [] });
    });
    const withoutGroup = context({ teamGroupId: null });
    await fetchTeamsProviderHistory(config, request({}, withoutGroup), { fetchImpl });
    await fetchTeamsProviderHistory(config, request({}, withoutGroup), { fetchImpl });
    expect(teamDetails).toHaveBeenCalledTimes(1);

    const otherTenant = context({
      teamGroupId: null,
      cacheScope: {
        agorTenantId: 'tenant-b',
        gatewayChannelId: 'channel-a',
        providerConfigGeneration: 3,
      },
    });
    await fetchTeamsProviderHistory(config, request({}, otherTenant), { fetchImpl });
    expect(teamDetails).toHaveBeenCalledTimes(2);
  });

  it('refuses a non-Bot-Connector service URL before sending the bot token', async () => {
    const fetchImpl = fakeFetch(() => json({}));
    const foreign = context({ teamGroupId: null, serviceUrl: 'https://attacker.example/' });
    await expect(
      fetchTeamsProviderHistory(config, request({}, foreign), { fetchImpl })
    ).rejects.toThrow(/allowed Bot Connector origin/);
    expect(fetchImpl.mock.calls.map(([url]) => String(url))).not.toContain(
      `https://attacker.example/v3/teams/${encodeURIComponent(TEAM_THREAD_ID)}`
    );
  });

  it('treats Graph 403 as RSC not granted for this team and stops asking for a while', async () => {
    const fetchImpl = fakeFetch((url) => {
      if (url.startsWith(GRAPH_BASE)) return json({ error: { code: 'Forbidden' } }, 403);
    });
    const first = await fetchTeamsProviderHistory(config, request(), { fetchImpl });
    const second = await fetchTeamsProviderHistory(config, request(), { fetchImpl });
    expect(first.complete).toBe(false);
    expect(second.complete).toBe(false);
    expect(graphCalls(fetchImpl)).toHaveLength(1);
  });

  it('pages back to a deleted cursor and tolerates a trigger Graph cannot see yet', async () => {
    const cursor = '1616990000100';
    const firstPage = Array.from({ length: 50 }, (_, index) =>
      graphMessage(String(1616990100000 - index * 10))
    );
    const secondPage = [graphMessage('1616990000500'), graphMessage('1616990000050')];
    const fetchImpl = fakeFetch((url) => {
      if (url === `${GRAPH_BASE}/replies?$top=50`) {
        return json({
          value: [graphMessage('1616990200000'), ...firstPage],
          '@odata.nextLink': `${GRAPH_BASE}/replies?$top=50&$skiptoken=page2`,
        });
      }
      if (url === `${GRAPH_BASE}/replies?$top=50&$skiptoken=page2`) {
        return json({
          value: secondPage,
          '@odata.nextLink': `${GRAPH_BASE}/replies?$top=50&$skiptoken=page3`,
        });
      }
    });
    const result = await fetchTeamsProviderHistory(
      { ...config, catch_up: { ...config.catch_up!, max_messages: 100 } },
      request({ afterProviderCursor: cursor }),
      { fetchImpl }
    );
    expect(result.complete).toBe(true);
    const ids = result.messages.map((message) => message.providerMessageId);
    expect(ids).toHaveLength(52);
    expect(ids[0]).toBe('1616990000500');
    expect(ids.at(-1)).toBe(TRIGGER_ID);
    expect(ids).not.toContain('1616990200000');
    expect(ids).not.toContain('1616990000050');
    expect(graphCalls(fetchImpl)).not.toContain(GRAPH_BASE);
    expect(graphCalls(fetchImpl)).toHaveLength(2);
  });

  it('keeps the newest messages up to the cap when newest-first pages run past it', async () => {
    const trigger = BigInt(TRIGGER_ID);
    const page = (start: number) =>
      Array.from({ length: 50 }, (_, index) =>
        graphMessage(String(trigger - BigInt(start + index + 1)))
      );
    const fetchImpl = fakeFetch((url) => {
      if (!url.startsWith(`${GRAPH_BASE}/replies`)) return undefined;
      const offset = Number(new URL(url).searchParams.get('$skiptoken') ?? '0');
      return json({
        value: page(offset),
        '@odata.nextLink': `${GRAPH_BASE}/replies?$skiptoken=${offset + 50}`,
      });
    });
    const result = await fetchTeamsProviderHistory(
      config,
      request({ afterProviderCursor: '1616980000000' }),
      { fetchImpl }
    );
    expect(result).toMatchObject({ complete: true, earlierOmitted: true });
    const kept = result.messages.filter((message) => !message.isTrigger);
    expect(kept).toHaveLength(50);
    expect(kept.at(-1)?.providerMessageId).toBe(String(trigger - 1n));
    expect(kept[0]?.providerMessageId).toBe(String(trigger - 50n));
  });

  it('reports an interval it could not cover as incomplete', async () => {
    const fetchImpl = fakeFetch((url) => {
      if (url.startsWith(`${GRAPH_BASE}/replies`)) {
        return json({
          value: [graphMessage('1616990100000')],
          '@odata.nextLink': `${GRAPH_BASE}/replies?$skiptoken=${encodeURIComponent(url)}`,
        });
      }
    });
    const result = await fetchTeamsProviderHistory(
      config,
      request({ afterProviderCursor: '1616990000100' }),
      { fetchImpl }
    );
    expect(result.complete).toBe(false);
    expect(graphCalls(fetchImpl)).toHaveLength(2);
  });

  it('marks senders outside a configured allowlist and drops bot, system, and deleted messages', async () => {
    const fetchImpl = fakeFetch((url) => {
      if (url === GRAPH_BASE) return json(graphMessage(ROOT_ID));
      if (url.startsWith(`${GRAPH_BASE}/replies`)) {
        return json({
          value: [
            graphMessage('1616990000001', {
              from: {
                application: {
                  '@odata.type': '#microsoft.graph.teamworkApplicationIdentity',
                  id: config.app_id,
                  displayName: 'Agor',
                  applicationIdentityType: 'bot',
                },
                device: null,
                user: null,
              },
            }),
            graphMessage('1616990000002', { messageType: 'systemEventMessage' }),
            graphMessage('1616990000003', { deletedDateTime: '2021-03-29T04:00:00Z' }),
          ],
        });
      }
    });
    const result = await fetchTeamsProviderHistory(
      { ...config, allowed_user_aad_object_ids: ['someone-else'] },
      request(),
      { fetchImpl }
    );
    const [root, bot, system, deleted] = result.messages;
    expect(root).toMatchObject({ senderAllowlisted: false, isBot: false, isSystem: false });
    expect(bot).toMatchObject({ isBot: true });
    expect(system).toMatchObject({ isSystem: true });
    expect(deleted).toMatchObject({ isSystem: true });
  });

  it('refuses a pagination link outside Graph before sending the token anywhere', async () => {
    const fetchImpl = fakeFetch((url) => {
      if (url === GRAPH_BASE) return json(graphMessage(ROOT_ID));
      if (url.startsWith(`${GRAPH_BASE}/replies`)) {
        return json({ value: [], '@odata.nextLink': 'https://evil.example/replies?page=2' });
      }
    });
    await expect(fetchTeamsProviderHistory(config, request(), { fetchImpl })).rejects.toThrow(
      /pagination origin/
    );
    expect(fetchImpl.mock.calls.map(([url]) => String(url))).not.toContain(
      'https://evil.example/replies?page=2'
    );
  });

  it('caches tokens per tenant, channel, generation, and credential, and refreshes once on 401', async () => {
    let graph401 = false;
    const fetchImpl = fakeFetch((url) => {
      if (url.startsWith(GRAPH_BASE)) {
        if (graph401) {
          graph401 = false;
          return json({}, 401);
        }
        return json(url === GRAPH_BASE ? graphMessage(ROOT_ID) : { value: [] });
      }
    });
    await fetchTeamsProviderHistory(config, request(), { fetchImpl });
    await fetchTeamsProviderHistory(config, request(), { fetchImpl });
    expect(tokenCalls(fetchImpl)).toHaveLength(1);

    await fetchTeamsProviderHistory(
      config,
      request(
        {},
        context({
          cacheScope: {
            agorTenantId: 'tenant-b',
            gatewayChannelId: 'channel-a',
            providerConfigGeneration: 3,
          },
        })
      ),
      { fetchImpl }
    );
    expect(tokenCalls(fetchImpl)).toHaveLength(2);
    await fetchTeamsProviderHistory(
      config,
      request(
        {},
        context({
          cacheScope: {
            agorTenantId: 'tenant-a',
            gatewayChannelId: 'channel-a',
            providerConfigGeneration: 4,
          },
        })
      ),
      { fetchImpl }
    );
    expect(tokenCalls(fetchImpl)).toHaveLength(3);
    await fetchTeamsProviderHistory({ ...config, app_password: 'secret-2' }, request(), {
      fetchImpl,
    });
    expect(tokenCalls(fetchImpl)).toHaveLength(4);
    expect(
      new URLSearchParams(String(tokenCalls(fetchImpl)[3][1]?.body)).get('client_secret')
    ).toBe('secret-2');

    graph401 = true;
    const refreshed = await fetchTeamsProviderHistory(config, request(), { fetchImpl });
    expect(refreshed.complete).toBe(true);
    expect(tokenCalls(fetchImpl)).toHaveLength(5);
  });

  it('retries transient Graph failures twice within the deadline, honouring Retry-After', async () => {
    const statuses = [503, 429];
    const fetchImpl = fakeFetch((url) => {
      if (url === GRAPH_BASE) {
        const status = statuses.shift();
        if (status) return json({}, status, status === 429 ? { 'retry-after': '0' } : {});
        return json(graphMessage(ROOT_ID));
      }
      if (url.startsWith(`${GRAPH_BASE}/replies`)) return json({ value: [] });
    });
    const result = await fetchTeamsProviderHistory(config, request(), { fetchImpl });
    expect(result.complete).toBe(true);
    expect(graphCalls(fetchImpl).filter((url) => url === GRAPH_BASE)).toHaveLength(3);
  });

  it('aborts every provider call on the single caller deadline', async () => {
    const controller = new AbortController();
    const fetchImpl = vi.fn(
      (_url: string | URL | Request, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          if (init?.signal?.aborted) reject(init.signal.reason);
          init?.signal?.addEventListener('abort', () => reject(init.signal?.reason));
        })
    );
    const pending = fetchTeamsProviderHistory(config, request({ signal: controller.signal }), {
      fetchImpl,
    });
    await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalled());
    controller.abort(new DOMException('deadline', 'TimeoutError'));
    await expect(pending).rejects.toThrow(/deadline/);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('is the TeamsConnector provider-history implementation', async () => {
    const fetchImpl = fakeFetch((url) => {
      if (url === GRAPH_BASE) return json(graphMessage(ROOT_ID));
      if (url.startsWith(`${GRAPH_BASE}/replies`)) return json({ value: [] });
    });
    vi.stubGlobal('fetch', fetchImpl);
    const result = await new TeamsConnector(config as Record<string, unknown>).fetchProviderHistory(
      request()
    );
    expect(result.complete).toBe(true);
  });
});
