import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchTeamsSigningJwk, validateTeamsVerifiedIdentity } from './teams-gateway-ingress';

const config = {
  app_id: 'app-123',
  app_password: 'secret',
  microsoft_tenant_id: 'tenant-123',
};

const activity = {
  serviceUrl: 'https://smba.trafficmanager.net/teams/',
  channelData: { tenant: { id: 'tenant-123' } },
};

const claims = {
  iss: 'https://api.botframework.com',
  aud: 'app-123',
  tid: 'tenant-123',
  serviceurl: 'https://smba.trafficmanager.net/teams/',
};

const teamsSigningJwk = { kid: 'key-1', endorsements: ['msteams'] };

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('validateTeamsVerifiedIdentity', () => {
  it('accepts the SDK-verified Bot Framework identity binding', () => {
    expect(validateTeamsVerifiedIdentity(claims, config, activity, teamsSigningJwk)).toBeNull();
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
      'service URL whitespace',
      { serviceurl: ' https://smba.trafficmanager.net/teams/' },
      'invalid_service_url',
    ],
    [
      'service URL scheme',
      { serviceurl: 'http://smba.trafficmanager.net/teams' },
      'invalid_service_url',
    ],
    [
      'channel endorsement',
      { signingJwk: { kid: 'key-1', endorsements: ['slack'] } },
      'invalid_channel_endorsement',
    ],
    [
      'missing channel endorsement',
      { signingJwk: { kid: 'key-1' } },
      'invalid_channel_endorsement',
    ],
    ['issuer endorsement', { iss: 'https://issuer.example' }, 'invalid_botframework_issuer'],
  ])('rejects an invalid %s without an admission decision', (_name, changes, expected) => {
    const changeRecord = changes as Record<string, unknown>;
    const nextClaims = { ...claims };
    for (const [key, value] of Object.entries(changeRecord)) {
      if (key !== 'activity' && key !== 'signingJwk')
        (nextClaims as Record<string, unknown>)[key] = value;
    }
    const signingJwk = changeRecord.signingJwk as typeof teamsSigningJwk | undefined;
    const nextActivity =
      changes && 'activity' in changes
        ? (changes as { activity: typeof activity }).activity
        : activity;
    expect(
      validateTeamsVerifiedIdentity(nextClaims, config, nextActivity, signingJwk ?? teamsSigningJwk)
    ).toBe(expected);
  });
});

describe('fetchTeamsSigningJwk', () => {
  it('reads endorsements from the exact Bot Framework JWKS selected by the SDK-authorized token', async () => {
    const token = `${Buffer.from(JSON.stringify({ alg: 'RS256', kid: 'key-1' })).toString('base64url')}.payload.signature`;
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ keys: [teamsSigningJwk] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    );
    vi.stubGlobal('fetch', fetchMock);
    const request = {
      headers: { authorization: `Bearer ${token}` },
    } as unknown as Request;
    const result = await fetchTeamsSigningJwk(request, claims, config);
    expect(result.endorsements).toEqual(['msteams']);
    expect(fetchMock).toHaveBeenCalledWith(
      'https://login.botframework.com/v1/.well-known/keys',
      expect.objectContaining({ redirect: 'error' })
    );
  });
});
