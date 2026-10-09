import { describe, expect, it } from 'vitest';
import { validateTeamsConfig, withTeamsConfigDefaults } from './gateway';

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
