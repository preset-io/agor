import { generateKeyPairSync } from 'node:crypto';
import type { AgorConfig } from '@agor/core/config';
import { MCP_OAUTH_RELAY, type MCPOAuthRelayCallback } from '@agor/core/types';
import jwt from 'jsonwebtoken';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MCPOAuthRelay, relayBodyHash } from './mcp-oauth-relay';

const fetch = vi.hoisted(() => vi.fn());
vi.mock('@agor/core/utils/safe-outbound-fetch', () => ({ safeOutboundFetch: fetch }));
const cloud = generateKeyPairSync('rsa', { modulusLength: 2048 });
const cell = generateKeyPairSync('rsa', { modulusLength: 2048 });
const config: AgorConfig = {
  external_launch: {
    enabled: true,
    exchange_url: 'https://cloud.test/exchange',
    issuer: 'https://cloud.test',
    audience: 'normal-launch-audience',
    public_key: cloud.publicKey.export({ type: 'spki', format: 'pem' }).toString(),
  },
  mcp_oauth_relay: {
    callback_origin: 'https://cloud.test',
    cell_id: 'cell-a',
    credential_id: 'credential-a',
    private_key_env: 'TEST_CELL_KEY',
  },
};
const relay = () =>
  new MCPOAuthRelay(config, {
    TEST_CELL_KEY: cell.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
  });
function fixture() {
  const client = relay();
  const input: MCPOAuthRelayCallback = {
    workspace_id: 'tenant-a',
    cloud_user_id: 'cloud-alice',
    runtime_user_id: 'alice',
    server_id: 'server',
    attempt_id: 'attempt',
    state: 'a'.repeat(43),
    issuer: 'https://provider.test',
    redirect_uri: client.redirectUri('https://provider.test'),
    code: 'test-code',
    iss: 'https://provider.test',
  };
  const body = Buffer.from(JSON.stringify(input));
  const claims = {
    purpose: MCP_OAUTH_RELAY.callbackPurpose,
    cell_id: 'cell-a',
    workspace_id: 'tenant-a',
    tenant_id: 'tenant-a',
    body_sha256: relayBodyHash(body),
    sub: 'user:cloud-alice',
  };
  const sign = (overrides: Record<string, unknown> = {}, lifetime = 30) =>
    `Bearer ${jwt.sign({ ...claims, ...overrides }, cloud.privateKey, { algorithm: 'RS256', issuer: 'https://cloud.test', audience: 'agor-cell:cell-a:mcp-oauth-relay', expiresIn: lifetime, jwtid: 'delivery-id' })}`;
  return { client, input, body, sign };
}
describe('Cloud relay v1 trust boundary', () => {
  afterEach(() => vi.restoreAllMocks());
  beforeEach(() => {
    fetch.mockReset();
  });

  it.each([1, 29, 30, -1, -30, -59])(
    'accepts a short-lived assertion issued %ss relative to the runtime clock',
    async (offset) => {
      const now = 1_800_000_000;
      vi.spyOn(Date, 'now').mockReturnValue(now * 1000);
      const { client, body, input, sign } = fixture();
      await expect(client.verifyDelivery(body, sign({ iat: now + offset }))).resolves.toEqual(
        input
      );
      // Skew never relaxes body binding or the <=30-second signed lifetime.
      await expect(
        client.verifyDelivery(Buffer.from(`${body} `), sign({ iat: now + offset }))
      ).rejects.toThrow();
      await expect(client.verifyDelivery(body, sign({ iat: now + offset }, 31))).rejects.toThrow();
    }
  );
  it.each([31, 60, -60, -120])(
    'rejects issuance outside the bounded future/expiry allowance (%ss)',
    async (offset) => {
      const now = 1_800_000_000;
      vi.spyOn(Date, 'now').mockReturnValue(now * 1000);
      const { client, body, sign } = fixture();
      await expect(client.verifyDelivery(body, sign({ iat: now + offset }))).rejects.toThrow(
        'Invalid MCP callback delivery'
      );
    }
  );
  it.each([
    [-30_000, true],
    [1000, true],
    [30_000, true],
    [30_001, false],
    [-600_000, false],
  ])('bounds the prepared route expiry with Cloud clock offset %sms', async (offset, accepted) => {
    const now = 1_800_000_000_000;
    vi.spyOn(Date, 'now').mockReturnValue(now);
    const { client, input } = fixture();
    fetch.mockResolvedValue(
      Response.json(
        {
          start_url: 'https://cloud.test/start/opaque',
          redirect_uri: input.redirect_uri,
          expires_at: new Date(now + 600_000 + offset).toISOString(),
        },
        { status: 201 }
      )
    );
    const { code: _code, iss: _iss, ...prepare } = input;
    const result = client.prepare({
      ...prepare,
      authorization_url: 'https://provider.test/authorize',
    });
    if (accepted) await expect(result).resolves.toBe('https://cloud.test/start/opaque');
    else await expect(result).rejects.toThrow('no direct fallback');
  });
  it('uses existing Cell service claims and binds exact prepare bytes', async () => {
    const { client, input } = fixture();
    fetch.mockImplementation(async (url, init) => {
      expect(url).toBe(`https://cloud.test${MCP_OAUTH_RELAY.preparePath}`);
      expect(init.redirect).toBe('error');
      const claims = jwt.verify(init.headers.Authorization.slice(7), cell.publicKey, {
        algorithms: ['RS256'],
        issuer: 'agor-cell:cell-a',
        audience: MCP_OAUTH_RELAY.serviceAudience,
      }) as jwt.JwtPayload;
      expect(claims).toMatchObject({
        scope: 'mcp_oauth:relay',
        cell_id: 'cell-a',
        credential_id: 'credential-a',
        body_sha256: relayBodyHash(init.body),
      });
      expect(claims.exp! - claims.iat!).toBeLessThanOrEqual(120);
      return Response.json(
        {
          start_url: 'https://cloud.test/start/opaque',
          redirect_uri: input.redirect_uri,
          expires_at: new Date(Date.now() + 60_000).toISOString(),
        },
        { status: 201 }
      );
    });
    const { code: _code, iss: _iss, ...prepare } = input;
    await expect(
      client.prepare({
        ...prepare,
        authorization_url: `https://provider.test/authorize?state=${input.state}`,
      })
    ).resolves.toBe('https://cloud.test/start/opaque');
  });
  it('requires exact issuer bytes and rejects arbitrary preparation redirects', async () => {
    const { client, input } = fixture();
    expect(client.redirectUri('https://provider.test/')).not.toBe(input.redirect_uri);
    expect(() => client.redirectUri('http://provider.test')).toThrow();
    fetch.mockResolvedValue(
      Response.json(
        {
          start_url: 'https://attacker.test/start',
          redirect_uri: input.redirect_uri,
          expires_at: new Date(Date.now() + 60_000).toISOString(),
        },
        { status: 201 }
      )
    );
    const { code: _code, iss: _iss, ...prepare } = input;
    await expect(
      client.prepare({ ...prepare, authorization_url: 'https://provider.test/authorize' })
    ).rejects.toThrow('no direct fallback');
  });
  it('accepts only Cloud purpose/audience/body/tenant/user/cell-bound short-lived delivery', async () => {
    const { client, body, input, sign } = fixture();
    await expect(client.verifyDelivery(body, sign())).resolves.toEqual(input);
    for (const overrides of [
      { purpose: 'launch' },
      { cell_id: 'cell-b' },
      { workspace_id: 'tenant-b' },
      { tenant_id: 'tenant-b' },
      { sub: 'user:bob' },
      { body_sha256: '0'.repeat(64) },
      { iat: Math.floor(Date.now() / 1000) + 60 },
    ]) {
      await expect(client.verifyDelivery(body, sign(overrides))).rejects.toThrow(
        'Invalid MCP callback delivery'
      );
    }
    await expect(client.verifyDelivery(Buffer.from(`${body} `), sign())).rejects.toThrow();
    const launch = jwt.sign({ sub: 'user:cloud-alice' }, cloud.privateKey, {
      algorithm: 'RS256',
      issuer: 'https://cloud.test',
      audience: 'normal-launch-audience',
      expiresIn: 30,
    });
    await expect(client.verifyDelivery(body, `Bearer ${launch}`)).rejects.toThrow();
    const mixed = { ...input, iss: 'https://attacker.test' };
    const mixedBody = Buffer.from(JSON.stringify(mixed));
    await expect(
      client.verifyDelivery(mixedBody, sign({ body_sha256: relayBodyHash(mixedBody) }))
    ).rejects.toThrow();
  });
});
