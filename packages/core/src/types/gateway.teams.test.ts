import { describe, expect, it } from 'vitest';
import {
  resolveTeamsAgentTools,
  teamsOutboundChannelTarget,
  validateTeamsConfig,
  withTeamsConfigDefaults,
} from './gateway';

const base = {
  app_id: 'teams-app',
  app_password: 'secret',
  microsoft_tenant_id: 'tenant-a',
  align_teams_users: true,
};

describe('Teams config defaults', () => {
  it('turns catch-up on for a new channel', () => {
    const config = withTeamsConfigDefaults(base);
    expect(config.catch_up).toMatchObject({ mode: 'best_effort' });
    expect(validateTeamsConfig(config).ok).toBe(true);
  });

  it('keeps the catch-up mode stored on an existing channel', () => {
    const stored = {
      ...base,
      catch_up: { mode: 'off', max_messages: 20, max_prompt_bytes: 4096, request_timeout_ms: 5000 },
    };
    expect(withTeamsConfigDefaults(stored).catch_up).toEqual(stored.catch_up);
  });

  it('no longer defaults the ignored mention keys but still accepts stored ones', () => {
    const fresh = withTeamsConfigDefaults(base);
    expect(fresh).not.toHaveProperty('require_mention');
    expect(fresh).not.toHaveProperty('allow_thread_replies_without_mention');
    const legacy = withTeamsConfigDefaults({
      ...base,
      require_mention: false,
      allow_thread_replies_without_mention: true,
    });
    expect(validateTeamsConfig(legacy)).toEqual({ ok: true, errors: [] });
  });
});

describe('Teams parity config', () => {
  const channelId = '19:4a95f7d8db4c4e7fae857bcebe0623e6@thread.tacv2';

  it('accepts files, agent tools, and a channel default target', () => {
    const config = withTeamsConfigDefaults({
      ...base,
      files: true,
      agent_tools: { channel_history: true },
      default_outbound_target: `channel:${channelId}`,
    });
    expect(validateTeamsConfig(config)).toEqual({ ok: true, errors: [] });
    expect(resolveTeamsAgentTools(config.agent_tools)).toEqual({ channel_history: true });
    expect(resolveTeamsAgentTools(undefined)).toEqual({ channel_history: false });
  });

  it('rejects unknown agent tools, non-boolean files, and malformed or unallowed targets', () => {
    const errors = (overrides: Record<string, unknown>) =>
      validateTeamsConfig(withTeamsConfigDefaults({ ...base, ...overrides })).errors;
    expect(errors({ agent_tools: { file_download: true } })).toEqual([
      'agent_tools.file_download is not a supported Teams agent tool',
    ]);
    expect(errors({ agent_tools: { channel_history: 'yes' } })).toEqual([
      'agent_tools.channel_history must be a boolean',
    ]);
    expect(errors({ files: 'true' })).toEqual(['files must be a boolean']);
    expect(errors({ default_outbound_target: 'user:someone' })).toEqual([
      'default_outbound_target must be channel:<19:…@thread.tacv2>',
    ]);
    expect(
      errors({
        default_outbound_target: `channel:${channelId}`,
        allowed_channel_ids: ['19:other@thread.tacv2'],
      })
    ).toEqual(['default_outbound_target must target an allowed channel']);
    expect(teamsOutboundChannelTarget(`channel:${channelId}`)).toBe(channelId);
    expect(teamsOutboundChannelTarget('channel:C123')).toBeNull();
  });
});
