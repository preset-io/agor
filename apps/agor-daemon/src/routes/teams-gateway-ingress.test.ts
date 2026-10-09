import type { Request } from 'express';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  fetchTeamsSigningJwk,
  resetTeamsSigningJwksCache,
  validateTeamsVerifiedIdentity,
} from './teams-gateway-ingress';

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
  resetTeamsSigningJwksCache();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('validateTeamsVerifiedIdentity', () => {
  it('accepts the SDK-verified Bot Framework identity binding', () => {
    expect(validateTeamsVerifiedIdentity(claims, config, activity, teamsSigningJwk)).toBeNull();
  });

  it.each([
    'http://example.test/',
    ' https://example.test/',
    'https://user:pass@example.test/',
    'not-a-url',
    'https://attacker.example/teams/',
  ])('rejects a signed but unsafe service URL %s', (serviceUrl) => {
    expect(
      validateTeamsVerifiedIdentity(
        { ...claims, serviceurl: serviceUrl },
        config,
        { ...activity, serviceUrl },
        teamsSigningJwk
      )
    ).toBe('invalid_service_url');
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

function signedRequest(kid: string): Request {
  const token = `${Buffer.from(JSON.stringify({ alg: 'RS256', kid })).toString('base64url')}.payload.signature`;
  return { headers: { authorization: `Bearer ${token}` } } as unknown as Request;
}

describe('fetchTeamsSigningJwk', () => {
  it('reads endorsements from one cached key document and refetches only for an unknown kid or after a day', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    let keys = [teamsSigningJwk, { kid: 'key-2', endorsements: ['msteams'] }];
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ keys }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    await fetchTeamsSigningJwk(signedRequest('key-1'), claims, config);
    await fetchTeamsSigningJwk(signedRequest('key-2'), claims, config);
    await fetchTeamsSigningJwk(signedRequest('key-1'), claims, config);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    keys = [...keys, { kid: 'key-3', endorsements: ['msteams'] }];
    vi.setSystemTime(Date.now() + 2 * 60_000);
    expect((await fetchTeamsSigningJwk(signedRequest('key-3'), claims, config)).kid).toBe('key-3');
    expect(fetchMock).toHaveBeenCalledTimes(2);

    vi.setSystemTime(Date.now() + 24 * 60 * 60_000);
    await fetchTeamsSigningJwk(signedRequest('key-1'), claims, config);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('shares one in-flight document fetch across concurrent requests', async () => {
    const fetchMock = vi.fn(
      async () => new Response(JSON.stringify({ keys: [teamsSigningJwk] }), { status: 200 })
    );
    vi.stubGlobal('fetch', fetchMock);
    await Promise.all(
      Array.from({ length: 5 }, () => fetchTeamsSigningJwk(signedRequest('key-1'), claims, config))
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('fails closed when even a refreshed document lacks the signing key', async () => {
    const fetchMock = vi.fn(
      async () => new Response(JSON.stringify({ keys: [teamsSigningJwk] }), { status: 200 })
    );
    vi.stubGlobal('fetch', fetchMock);
    await expect(fetchTeamsSigningJwk(signedRequest('unknown'), claims, config)).rejects.toThrow(
      /not found/
    );
  });

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

  it('accepts a Bot Framework JWKS the size of the live document', async () => {
    const token = `${Buffer.from(JSON.stringify({ alg: 'RS256', kid: 'key-1' })).toString('base64url')}.payload.signature`;
    // The live document holds ~250 keys (~870 KB); a 256 KB cap rejected every Teams POST.
    const filler = Array.from({ length: 250 }, (_, index) => ({
      ...teamsSigningJwk,
      kid: `filler-${index}`,
      x5c: ['A'.repeat(3_400)],
    }));
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue(
          new Response(JSON.stringify({ keys: [...filler, teamsSigningJwk] }), { status: 200 })
        )
    );
    const request = { headers: { authorization: `Bearer ${token}` } } as unknown as Request;
    await expect(fetchTeamsSigningJwk(request, claims, config)).resolves.toMatchObject({
      kid: 'key-1',
    });
  });
});
