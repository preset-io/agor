/** Graph fixtures shared by the Teams history test files. */

import { type Mock, vi } from 'vitest';

// Real-format identifiers: a Teams channel thread ID, an M365 group GUID, an epoch-ms message ID.
export const CHANNEL_ID = '19:4a95f7d8db4c4e7fae857bcebe0623e6@thread.tacv2';
export const GROUP_ID = 'fbe2bf47-16c8-47cf-b4a5-4b9b187c508b';
export const ROOT_ID = '1616989510408';

export function graphMessage(id: string, overrides: Record<string, unknown> = {}) {
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
        tenantId: '72f988bf-86f1-41af-91ab-2d7cd011db47',
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

export function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

type Route = (url: string, init?: RequestInit) => Response | undefined;
type FakeFetch = Mock<(input: string | URL | Request, init?: RequestInit) => Promise<Response>>;

/** Answers token requests (a Graph or Bot Framework token by scope), then the first matching route. */
export function fakeFetch(...routes: Route[]): FakeFetch {
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

export function graphCalls(fetchImpl: FakeFetch): string[] {
  return fetchImpl.mock.calls
    .map(([url]) => String(url))
    .filter((url) => url.startsWith('https://graph.microsoft.com/'));
}
