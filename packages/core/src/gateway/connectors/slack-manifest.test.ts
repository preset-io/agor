import { describe, expect, it } from 'vitest';
import { resolveSlackAgentTools } from '../../types/gateway';
import {
  buildSlackManifest,
  requiredBotEvents,
  requiredBotScopes,
  type SlackWizardOptions,
} from './slack-manifest';

/**
 * These assertions pin the scope/event matrix to itself — they guard against
 * accidental edits to the generator, NOT against drift between the generator
 * and the live Slack connector. Keeping the matrix aligned with the connector
 * is a manual review step.
 */
const baseOptions: SlackWizardOptions = {
  appName: 'Agor',
  publicChannels: false,
  privateChannels: false,
  groupDms: false,
  alignUsers: false,
  outbound: false,
  ingestFiles: false,
  agentTools: {},
};

function withOptions(overrides: Partial<SlackWizardOptions>): SlackWizardOptions {
  return { ...baseOptions, ...overrides };
}

describe('requiredBotScopes', () => {
  it('DM-only baseline', () => {
    expect(requiredBotScopes(baseOptions)).toEqual([
      'chat:write',
      'im:history',
      'im:read',
      'users:read',
    ]);
  });

  it('adds app_mentions + public channel read/history for public channels', () => {
    expect(requiredBotScopes(withOptions({ publicChannels: true }))).toEqual([
      'app_mentions:read',
      'channels:history',
      'channels:read',
      'chat:write',
      'im:history',
      'im:read',
      'users:read',
    ]);
  });

  it('adds outbound name-resolution + DM-by-email scopes', () => {
    expect(requiredBotScopes(withOptions({ outbound: true }))).toEqual([
      'channels:read',
      'chat:write',
      'chat:write.public',
      'groups:read',
      'im:history',
      'im:read',
      'im:write',
      'users:read',
      'users:read.email',
    ]);
  });

  it('adds users:read.email for user alignment', () => {
    expect(requiredBotScopes(withOptions({ alignUsers: true }))).toEqual([
      'chat:write',
      'im:history',
      'im:read',
      'users:read',
      'users:read.email',
    ]);
  });

  it('adds files:read for file ingestion and omits it otherwise', () => {
    expect(requiredBotScopes(withOptions({ ingestFiles: true }))).toEqual([
      'chat:write',
      'files:read',
      'im:history',
      'im:read',
      'users:read',
    ]);
    expect(requiredBotScopes(baseOptions)).not.toContain('files:read');
  });

  it('adds all history scopes for agent channel history and omits them otherwise', () => {
    expect(requiredBotScopes(withOptions({ agentTools: { channel_history: true } }))).toEqual([
      'channels:history',
      'chat:write',
      'groups:history',
      'im:history',
      'im:read',
      'mpim:history',
      'users:read',
    ]);
    const withoutChannelHistory = requiredBotScopes(baseOptions);
    expect(withoutChannelHistory).not.toContain('channels:history');
    expect(withoutChannelHistory).not.toContain('groups:history');
    expect(withoutChannelHistory).not.toContain('mpim:history');
    expect(
      requiredBotScopes(withOptions({ agentTools: { channel_history: false } }))
    ).not.toContain('channels:history');
  });

  it('agent thread history adds no scopes — thread reads are covered by surface scopes', () => {
    expect(requiredBotScopes(withOptions({ agentTools: { thread_history: true } }))).toEqual(
      requiredBotScopes(withOptions({ agentTools: { thread_history: false } }))
    );
  });

  it('adds reactions:write for the reactions capability and omits it otherwise', () => {
    expect(requiredBotScopes(withOptions({ agentTools: { reactions: true } }))).toEqual([
      'chat:write',
      'im:history',
      'im:read',
      'reactions:write',
      'users:read',
    ]);
    expect(requiredBotScopes(baseOptions)).not.toContain('reactions:write');
    expect(requiredBotScopes(withOptions({ agentTools: { reactions: false } }))).not.toContain(
      'reactions:write'
    );
  });

  it('adds files:write for the file_upload capability and omits it otherwise', () => {
    expect(requiredBotScopes(withOptions({ agentTools: { file_upload: true } }))).toEqual([
      'chat:write',
      'files:write',
      'im:history',
      'im:read',
      'users:read',
    ]);
    expect(requiredBotScopes(baseOptions)).not.toContain('files:write');
    expect(requiredBotScopes(withOptions({ agentTools: { file_upload: false } }))).not.toContain(
      'files:write'
    );
  });

  it('all capabilities on — de-duplicated and sorted', () => {
    const allOn = withOptions({
      publicChannels: true,
      privateChannels: true,
      groupDms: true,
      alignUsers: true,
      outbound: true,
      ingestFiles: true,
      agentTools: {
        thread_history: true,
        channel_history: true,
        reactions: true,
        file_upload: true,
      },
    });
    expect(requiredBotScopes(allOn)).toEqual([
      'app_mentions:read',
      'channels:history',
      'channels:read',
      'chat:write',
      'chat:write.public',
      'files:read',
      'files:write',
      'groups:history',
      'groups:read',
      'im:history',
      'im:read',
      'im:write',
      'mpim:history',
      'mpim:read',
      'reactions:write',
      'users:read',
      'users:read.email',
    ]);
  });

  it('private channels and group DMs each contribute their own read/history scopes', () => {
    expect(requiredBotScopes(withOptions({ privateChannels: true }))).toEqual([
      'app_mentions:read',
      'chat:write',
      'groups:history',
      'groups:read',
      'im:history',
      'im:read',
      'users:read',
    ]);
    expect(requiredBotScopes(withOptions({ groupDms: true }))).toEqual([
      'app_mentions:read',
      'chat:write',
      'im:history',
      'im:read',
      'mpim:history',
      'mpim:read',
      'users:read',
    ]);
  });
});

describe('resolveSlackAgentTools', () => {
  it('defaults thread_history ON and channel_history/reactions/file_upload OFF for absent config', () => {
    expect(resolveSlackAgentTools(undefined)).toEqual({
      thread_history: true,
      channel_history: false,
      reactions: false,
      file_upload: false,
    });
    expect(resolveSlackAgentTools({})).toEqual({
      thread_history: true,
      channel_history: false,
      reactions: false,
      file_upload: false,
    });
  });

  it('honors explicit values', () => {
    expect(
      resolveSlackAgentTools({
        thread_history: false,
        channel_history: true,
        reactions: true,
        file_upload: true,
      })
    ).toEqual({
      thread_history: false,
      channel_history: true,
      reactions: true,
      file_upload: true,
    });
  });

  it('falls back to defaults for malformed config', () => {
    expect(resolveSlackAgentTools('yes')).toEqual({
      thread_history: true,
      channel_history: false,
      reactions: false,
      file_upload: false,
    });
    expect(
      resolveSlackAgentTools({
        thread_history: 'yes',
        channel_history: 1,
        reactions: 'true',
        file_upload: 0,
      })
    ).toEqual({
      thread_history: true,
      channel_history: false,
      reactions: false,
      file_upload: false,
    });
    expect(resolveSlackAgentTools([true])).toEqual({
      thread_history: true,
      channel_history: false,
      reactions: false,
      file_upload: false,
    });
  });
});

describe('requiredBotEvents', () => {
  it('DM-only emits only message.im', () => {
    expect(requiredBotEvents(baseOptions)).toEqual(['message.im']);
  });

  it('any channel-like surface adds app_mention (and no message.channels/groups/mpim)', () => {
    expect(requiredBotEvents(withOptions({ publicChannels: true }))).toEqual([
      'app_mention',
      'message.im',
    ]);
    expect(requiredBotEvents(withOptions({ privateChannels: true }))).toEqual([
      'app_mention',
      'message.im',
    ]);
    expect(requiredBotEvents(withOptions({ groupDms: true }))).toEqual([
      'app_mention',
      'message.im',
    ]);
  });

  it('outbound and alignUsers do not add events', () => {
    expect(requiredBotEvents(withOptions({ outbound: true, alignUsers: true }))).toEqual([
      'message.im',
    ]);
  });
});

describe('buildSlackManifest', () => {
  it('uses appName as bot display name when botDisplayName is omitted', () => {
    expect(buildSlackManifest(baseOptions).features.bot_user.display_name).toBe('Agor');
  });

  it('honors an explicit botDisplayName', () => {
    const manifest = buildSlackManifest(withOptions({ botDisplayName: 'Agor Bot' }));
    expect(manifest.features.bot_user.display_name).toBe('Agor Bot');
  });

  it('matches the DM-only snapshot', () => {
    expect(buildSlackManifest(baseOptions)).toMatchInlineSnapshot(`
      {
        "display_information": {
          "name": "Agor",
        },
        "features": {
          "app_home": {
            "home_tab_enabled": false,
            "messages_tab_enabled": true,
            "messages_tab_read_only_enabled": false,
          },
          "bot_user": {
            "always_online": true,
            "display_name": "Agor",
          },
        },
        "oauth_config": {
          "scopes": {
            "bot": [
              "chat:write",
              "im:history",
              "im:read",
              "users:read",
            ],
          },
        },
        "settings": {
          "event_subscriptions": {
            "bot_events": [
              "message.im",
            ],
          },
          "interactivity": {
            "is_enabled": false,
          },
          "org_deploy_enabled": false,
          "socket_mode_enabled": true,
          "token_rotation_enabled": false,
        },
      }
    `);
  });

  it('matches the all-channels snapshot', () => {
    const allChannels = withOptions({
      publicChannels: true,
      privateChannels: true,
      groupDms: true,
    });
    expect(buildSlackManifest(allChannels)).toMatchInlineSnapshot(`
      {
        "display_information": {
          "name": "Agor",
        },
        "features": {
          "app_home": {
            "home_tab_enabled": false,
            "messages_tab_enabled": true,
            "messages_tab_read_only_enabled": false,
          },
          "bot_user": {
            "always_online": true,
            "display_name": "Agor",
          },
        },
        "oauth_config": {
          "scopes": {
            "bot": [
              "app_mentions:read",
              "channels:history",
              "channels:read",
              "chat:write",
              "groups:history",
              "groups:read",
              "im:history",
              "im:read",
              "mpim:history",
              "mpim:read",
              "users:read",
            ],
          },
        },
        "settings": {
          "event_subscriptions": {
            "bot_events": [
              "app_mention",
              "message.im",
            ],
          },
          "interactivity": {
            "is_enabled": false,
          },
          "org_deploy_enabled": false,
          "socket_mode_enabled": true,
          "token_rotation_enabled": false,
        },
      }
    `);
  });

  it('matches the restricted-public + outbound snapshot', () => {
    // "Restricted" (allowed_channel_ids) is runtime config and does not change
    // scopes, so this is public + outbound at the manifest level.
    const restrictedOutbound = withOptions({ publicChannels: true, outbound: true });
    expect(buildSlackManifest(restrictedOutbound)).toMatchInlineSnapshot(`
      {
        "display_information": {
          "name": "Agor",
        },
        "features": {
          "app_home": {
            "home_tab_enabled": false,
            "messages_tab_enabled": true,
            "messages_tab_read_only_enabled": false,
          },
          "bot_user": {
            "always_online": true,
            "display_name": "Agor",
          },
        },
        "oauth_config": {
          "scopes": {
            "bot": [
              "app_mentions:read",
              "channels:history",
              "channels:read",
              "chat:write",
              "chat:write.public",
              "groups:read",
              "im:history",
              "im:read",
              "im:write",
              "users:read",
              "users:read.email",
            ],
          },
        },
        "settings": {
          "event_subscriptions": {
            "bot_events": [
              "app_mention",
              "message.im",
            ],
          },
          "interactivity": {
            "is_enabled": false,
          },
          "org_deploy_enabled": false,
          "socket_mode_enabled": true,
          "token_rotation_enabled": false,
        },
      }
    `);
  });
});
