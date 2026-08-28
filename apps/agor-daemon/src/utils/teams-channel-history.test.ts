import type { GatewayChannel } from '@agor/core/types';
import jwt from 'jsonwebtoken';
import { describe, expect, it } from 'vitest';
import {
  createTeamsStandardChannelHistoryFetcher,
  TEAMS_GRAPH_CHANNEL_MESSAGE_PERMISSION,
} from './teams-channel-history';

const channel = {
  config: {
    app_id: 'teams-app',
    app_password: 'teams-secret',
    microsoft_tenant_id: 'tenant-1',
  },
} as GatewayChannel;

const request = {
  channel,
  activity: {
    activityId: 'current',
    conversationId: 'conversation',
    rootMessageId: 'root',
    threadId: 'conversation|root',
    text: 'Please review',
    userId: '29:ada',
    userAadObjectId: 'aad-1',
  },
  teamId: 'team-1',
  channelId: 'channel-1',
  afterActivityId: 'cursor',
  maxMessages: 50,
};

describe('Teams standard-channel Graph history', () => {
  it('uses a tenant-scoped app token and requires exact cursor/trigger correlation', async () => {
    const token = jwt.sign({ roles: [TEAMS_GRAPH_CHANNEL_MESSAGE_PERMISSION] }, 'test-only');
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const fetchImpl = async (url: string | URL, init?: RequestInit) => {
      calls.push({ url: String(url), init });
      if (String(url).includes('/oauth2/')) {
        return new Response(JSON.stringify({ access_token: token, expires_in: 300 }), {
          status: 200,
        });
      }
      if (String(url).endsWith('/messages/root')) {
        return new Response(
          JSON.stringify({
            id: 'root',
            createdDateTime: '2026-08-27T11:58:00.000Z',
            from: { user: { displayName: 'Ada' } },
            body: { content: '<p>Root context</p>' },
          }),
          { status: 200 }
        );
      }
      return new Response(
        JSON.stringify({
          value: [
            {
              id: 'cursor',
              createdDateTime: '2026-08-27T11:59:00.000Z',
              from: { user: { displayName: 'Ada' } },
              body: { content: '<p>Intervening human context</p>' },
            },
            {
              id: 'current',
              createdDateTime: '2026-08-27T12:00:00.000Z',
              from: { user: { displayName: 'Ada' } },
              body: { content: '<p>Please review</p>' },
              mentions: [{ mentioned: { id: 'teams-app' } }],
            },
          ],
        }),
        { status: 200 }
      );
    };

    const result = await createTeamsStandardChannelHistoryFetcher({ fetchImpl })({
      ...request,
      maxMessages: 100,
    });
    expect(result.complete).toBe(true);
    expect(result.afterActivityId).toBe('cursor');
    expect(result.triggerActivityId).toBe('current');
    expect(result.activities.map((row) => row.activityId)).toEqual(['current']);
    expect(calls[0]?.url).toContain('/tenant-1/oauth2/v2.0/token');
    expect(String(calls[0]?.init?.body)).toContain('https%3A%2F%2Fgraph.microsoft.com%2F.default');
    expect(calls[1]?.init?.headers).toMatchObject({ authorization: `Bearer ${token}` });
    expect(calls[2]?.url).toBe(
      'https://graph.microsoft.com/v1.0/teams/team-1/channels/channel-1/messages/root/replies?$top=50'
    );
    expect(calls[2]?.url).not.toContain('$orderby');
  });

  it('falls back when Graph reports incomplete reply coverage', async () => {
    const token = jwt.sign({ roles: [TEAMS_GRAPH_CHANNEL_MESSAGE_PERMISSION] }, 'test-only');
    const fetchImpl = async (url: string | URL) => {
      const value = String(url);
      if (value.includes('/oauth2/')) {
        return new Response(JSON.stringify({ access_token: token, expires_in: 300 }), {
          status: 200,
        });
      }
      if (value.endsWith('/messages/root')) {
        return new Response(
          JSON.stringify({ id: 'root', createdDateTime: '2026-08-27T11:58:00Z' }),
          { status: 200 }
        );
      }
      return new Response(
        JSON.stringify({
          value: [],
          '@odata.nextLink': 'https://graph.microsoft.com/v1.0/opaque-next-page',
        }),
        { status: 200 }
      );
    };

    const result = await createTeamsStandardChannelHistoryFetcher({ fetchImpl })(request);
    expect(result).toMatchObject({ complete: false, reason: 'truncated', activities: [] });
  });

  it('does not use an app token without the required RSC role', async () => {
    const token = jwt.sign({ roles: [] }, 'test-only');
    const fetchImpl = async () =>
      new Response(JSON.stringify({ access_token: token, expires_in: 300 }), { status: 200 });
    const result = await createTeamsStandardChannelHistoryFetcher({ fetchImpl })(request);
    expect(result.complete).toBe(false);
    expect(result.reason).toBe('unavailable');
  });
});
