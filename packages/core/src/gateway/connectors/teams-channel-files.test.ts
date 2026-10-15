import { afterEach, describe, expect, it } from 'vitest';
import type { TeamsGatewayConfig } from '../../types/gateway';
import {
  fetchTeamsChannelMessageFiles,
  type TeamsChannelFilesRequest,
} from './teams-channel-files';
import { resetTeamsGraphCaches } from './teams-graph';
import {
  CHANNEL_ID,
  fakeFetch,
  GROUP_ID,
  graphCalls,
  graphMessage,
  json,
  ROOT_ID,
} from './teams-graph.test-support';

const REPLY_ID = '1616990132035';
const CHANNEL_URL = `https://graph.microsoft.com/v1.0/teams/${GROUP_ID}/channels/${encodeURIComponent(CHANNEL_ID)}`;
const REPLY_URL = `${CHANNEL_URL}/messages/${ROOT_ID}/replies/${REPLY_ID}`;
const FOLDER_URL = `${CHANNEL_URL}/filesFolder`;
const DRIVE_ID = 'b!channel-drive';
const FILE_URL = 'https://contoso.sharepoint.com/sites/Team/Shared%20Documents/General/image.png';
const SHARES_URL = `https://graph.microsoft.com/v1.0/shares/u!${Buffer.from(FILE_URL).toString('base64url')}/driveItem`;
const DOWNLOAD_URL =
  'https://contoso.sharepoint.com/sites/Team/_layouts/15/download.aspx?tempauth=t';

const config: TeamsGatewayConfig = {
  app_id: '9f1c2a7e-0d6b-4c5e-8a3f-2b7d1e6c4a90',
  app_password: 'secret-1',
  microsoft_tenant_id: '72f988bf-86f1-41af-91ab-2d7cd011db47',
};

function request(overrides: Partial<TeamsChannelFilesRequest> = {}): TeamsChannelFilesRequest {
  return {
    team: {
      teamId: null,
      teamGroupId: GROUP_ID,
      serviceUrl: 'https://smba.trafficmanager.net/amer/',
    },
    channelId: CHANNEL_ID,
    rootMessageId: ROOT_ID,
    messageId: REPLY_ID,
    filesEnabled: true,
    cacheScope: {
      agorTenantId: 'tenant-a',
      gatewayChannelId: 'channel-a',
      providerConfigGeneration: 1,
    },
    ...overrides,
  };
}

function reference(name: string, contentUrl = FILE_URL) {
  return { id: 'a1', contentType: 'reference', contentUrl, name, content: null };
}

const reply = (attachments: unknown[]) => json(graphMessage(REPLY_ID, { attachments }));
const folder = () =>
  json({
    id: 'folder',
    webUrl: 'https://contoso.sharepoint.com/sites/Team/Shared%20Documents/General',
    parentReference: { driveId: DRIVE_ID },
  });
const driveItem = (overrides: Record<string, unknown> = {}) =>
  json({
    id: 'item',
    size: 2048,
    file: { mimeType: 'image/png' },
    webUrl: FILE_URL,
    parentReference: { driveId: DRIVE_ID },
    '@microsoft.graph.downloadUrl': DOWNLOAD_URL,
    ...overrides,
  });

afterEach(() => resetTeamsGraphCaches());

describe('Teams channel message files', () => {
  it("returns a channel image as a pre-authenticated download from the channel's own drive", async () => {
    const fetchImpl = fakeFetch((url, init) => {
      expect(new Headers(init?.headers).get('authorization')).toBe('Bearer graph-token');
      if (url === REPLY_URL) return reply([reference('image.png')]);
      if (url === FOLDER_URL) return folder();
      if (url === SHARES_URL) return driveItem();
    });

    const result = await fetchTeamsChannelMessageFiles(config, request(), { fetchImpl });

    expect(result?.skipped).toEqual([]);
    expect(result?.files).toEqual([
      expect.objectContaining({
        name: 'image.png',
        mimetype: 'image/png',
        size: 2048,
        url_private_download: DOWNLOAD_URL,
      }),
    ]);
    expect(result?.files[0]).not.toHaveProperty('auth');
    expect(graphCalls(fetchImpl)).toEqual([REPLY_URL, FOLDER_URL, SHARES_URL]);
  });

  it('names files as unreadable when the tenant has not granted file access', async () => {
    const fetchImpl = fakeFetch((url) => {
      if (url === REPLY_URL) return reply([reference('image.png'), reference('notes.md')]);
      if (url === FOLDER_URL) return folder();
      if (url === SHARES_URL) return json({ error: { code: 'accessDenied' } }, 403);
    });

    const result = await fetchTeamsChannelMessageFiles(config, request(), { fetchImpl });

    expect(result?.files).toEqual([]);
    expect(result?.skipped).toEqual([
      { name: 'image.png', reason: 'channel_file' },
      { name: 'notes.md', reason: 'channel_file' },
    ]);
  });

  it("refuses a referenced file outside the channel's own folder", async () => {
    const otherChannel =
      'https://contoso.sharepoint.com/sites/Team/Shared%20Documents/Finance/image.png';
    for (const item of [
      { parentReference: { driveId: 'b!other-site' } },
      // Every channel of a team shares the team's library, so the same drive is not enough.
      { webUrl: otherChannel },
      {
        webUrl:
          'https://contoso.sharepoint.com/sites/Team/Shared%20Documents/General%2F..%2FFinance/image.png',
      },
      {
        webUrl:
          'https://contoso.sharepoint.com/sites/Team/Shared%20Documents/General-archive/image.png',
      },
    ]) {
      const fetchImpl = fakeFetch((url) => {
        if (url === REPLY_URL) return reply([reference('image.png')]);
        if (url === FOLDER_URL) return folder();
        if (url === SHARES_URL) return driveItem(item);
      });

      const result = await fetchTeamsChannelMessageFiles(config, request(), { fetchImpl });

      expect(result).toEqual({ files: [], skipped: [{ name: 'image.png', reason: 'invalid' }] });
    }
  });

  it('skips unreadable types and disabled files without reading SharePoint', async () => {
    const rootUrl = `${CHANNEL_URL}/messages/${ROOT_ID}`;
    const fetchImpl = fakeFetch((url) =>
      url === rootUrl
        ? json(graphMessage(ROOT_ID, { attachments: [reference('deck.pptx'), reference('a.png')] }))
        : undefined
    );

    const result = await fetchTeamsChannelMessageFiles(
      config,
      request({ messageId: ROOT_ID, filesEnabled: false }),
      { fetchImpl }
    );

    expect(result).toEqual({
      files: [],
      skipped: [
        { name: 'deck.pptx', reason: 'unsupported_type' },
        { name: 'a.png', reason: 'files_disabled' },
      ],
    });
    expect(graphCalls(fetchImpl)).toEqual([rootUrl]);
  });

  it('reads nothing while the team has not granted message access', async () => {
    const fetchImpl = fakeFetch((url) =>
      url === REPLY_URL ? json({ error: { code: 'Forbidden' } }, 403) : undefined
    );

    // Null, not empty: the activity's own file list must stand when the message is unreadable.
    await expect(
      fetchTeamsChannelMessageFiles(config, request(), { fetchImpl })
    ).resolves.toBeNull();
    await fetchTeamsChannelMessageFiles(config, request(), { fetchImpl });
    expect(graphCalls(fetchImpl)).toEqual([REPLY_URL]);
  });
});
