import type { AgorClient, User } from '@agor-live/client';
import { describe, expect, it, vi } from 'vitest';
import { readOnboardingSlackGateways, resolveOnboardingSlackIntent } from './onboardingSlack';
import { buildTeammateBootstrapPrompt } from './teammateBootstrapPrompt';

function setup(channels: unknown[] = [], capabilities = ['sessions.create'], role = 'admin') {
  const findAll = vi.fn(async () => channels);
  const find = vi.fn(async () => ({ capabilities }));
  const client = {
    service: (name: string) =>
      name === 'gateway-channels'
        ? { findAll }
        : name === 'users'
          ? { get: async () => ({ role }) }
          : { find },
  } as unknown as AgorClient;
  return { client, findAll, find };
}
const user = { user_id: 'alice', role: 'admin' } as User;
const gateway = {
  id: 'gateway-a',
  name: 'Existing bot',
  target_branch_id: 'branch-a',
  channel_type: 'slack',
  enabled: true,
  config: { bot_token: 'test-only-secret' },
  channel_key: 'private-inbound-key',
};

describe('Slack onboarding availability and consent', () => {
  it('prefers an existing permission-checked gateway and never returns its secrets', async () => {
    const { client, find } = setup([gateway]);
    expect(await resolveOnboardingSlackIntent(client, user, 'request-new')).toBe('prefer-existing');
    const rows = await readOnboardingSlackGateways(client);
    expect(rows).toEqual([{ id: 'gateway-a', name: 'Existing bot', target_branch_id: 'branch-a' }]);
    expect(JSON.stringify(rows)).not.toMatch(/secret|private-inbound-key|config|channel_key/);
    expect(find).toHaveBeenCalledWith({ route: { id: 'branch-a' } });
  });
  it('allows only an explicit, still-authorized new-gateway request with no existing target', async () => {
    const { client, findAll } = setup();
    expect(await resolveOnboardingSlackIntent(client, user, undefined)).toBeUndefined();
    expect(findAll).not.toHaveBeenCalled();
    expect(await resolveOnboardingSlackIntent(client, user, 'request-new')).toBe('request-new');
    expect(
      await resolveOnboardingSlackIntent(setup([], [], 'member').client, user, 'request-new')
    ).toBe('prefer-existing');
    expect(
      await resolveOnboardingSlackIntent(client, { ...user, role: 'member' }, 'request-new')
    ).toBe('prefer-existing');
  });
  it('does not expose a foreign or permission-denied branch as usable and fails closed on lookup failure', async () => {
    expect(await readOnboardingSlackGateways(setup([gateway], []).client)).toEqual([]);
    const api = setup([gateway]);
    api.find.mockRejectedValueOnce(new Error('Foreign tenant'));
    expect(await resolveOnboardingSlackIntent(api.client, user, 'request-new')).toBe(
      'prefer-existing'
    );
  });
  it('keeps setup intent separate from MCP and requires secure draft/widget setup', () => {
    const prompt = buildTeammateBootstrapPrompt({
      displayName: 'Scout',
      slackGatewayIntent: 'request-new',
    });
    expect(prompt).toContain('agor_gateway_slack_manifest_generate');
    expect(prompt).toContain('agor_widgets_request_gateway_token');
    expect(prompt).toContain('one disabled draft');
    expect(prompt).toContain('Recheck the current caller’s admin permission');
    expect(prompt).toContain('Never ask for tokens in chat');
    expect(
      buildTeammateBootstrapPrompt({ displayName: 'Scout', slackGatewayIntent: 'prefer-existing' })
    ).toContain('No new Slack gateway was requested');
  });
});
