import { describe, expect, it } from 'vitest';
import { validateTeamsVerifiedIdentity } from './teams-gateway-ingress';

const config = {
  app_id: 'app-123',
  microsoft_tenant_id: 'tenant-123',
};

const activity = {
  serviceUrl: 'https://smba.trafficmanager.net/teams/',
  channelData: { tenant: { id: 'tenant-123' } },
};

const claims = {
  iss: 'https://api.botframework.com',
  aud: 'app-123',
  channelid: 'msteams',
  tid: 'tenant-123',
  serviceurl: 'https://smba.trafficmanager.net/teams',
};

describe('validateTeamsVerifiedIdentity', () => {
  it('accepts the SDK-verified Bot Framework identity binding', () => {
    expect(validateTeamsVerifiedIdentity(claims, config, activity)).toBeNull();
  });

  it.each([
    ['audience', { aud: 'other-app' }, 'invalid_audience'],
    ['tenant', { tid: 'other-tenant' }, 'invalid_tenant'],
    [
      'activity tenant',
      { activity: { channelData: { tenant: { id: 'other-tenant' } } } },
      'invalid_tenant',
    ],
    ['service URL', { serviceurl: 'https://evil.example/teams' }, 'invalid_service_url'],
    [
      'service URL scheme',
      { serviceurl: 'http://smba.trafficmanager.net/teams' },
      'invalid_service_url',
    ],
    ['channel endorsement', { channelid: 'not-teams' }, 'invalid_channel_endorsement'],
    ['issuer endorsement', { iss: 'https://issuer.example' }, 'invalid_botframework_issuer'],
  ])('rejects an invalid %s without an admission decision', (_name, changes, expected) => {
    const nextClaims = { ...claims, ...(changes as Record<string, unknown>) };
    const nextActivity =
      changes && 'activity' in changes
        ? (changes as { activity: typeof activity }).activity
        : activity;
    expect(validateTeamsVerifiedIdentity(nextClaims, config, nextActivity)).toBe(expected);
  });
});
