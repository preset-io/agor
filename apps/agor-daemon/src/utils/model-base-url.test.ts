import http from 'node:http';
import type { AddressInfo } from 'node:net';
import type { AgorConfig } from '@agor/core/config';
import { BadRequest } from '@agor/core/feathers';
import {
  type OutboundDnsLookup,
  safeOutboundFetch,
  UnsafeOutboundUrlError,
} from '@agor/core/utils/safe-outbound-fetch';
import { afterEach, describe, expect, it } from 'vitest';
import {
  assertSafeConnectionBaseUrls,
  assertSafeModelBaseUrl,
  createPinnedModelFetch,
} from './model-base-url';

// Multi-tenant → shared daemon → public-only, DNS-pinned egress enforced.
const enforced = { multi_tenancy: { mode: 'required_from_auth' } } as AgorConfig;
// HA (shared infra) and sandbox (isolation) also enforce, independent of tenancy.
const haSimple = {
  deployment: { mode: 'ha' },
  execution: { unix_user_mode: 'simple' },
} as AgorConfig;
const sandbox = { execution: { unix_user_mode: 'sandbox' } } as AgorConfig;
// Default (simple + static + standalone) → trusted-local → permissive.
const trustedLocal = {} as AgorConfig;

const resolvesTo =
  (address: string, family: 4 | 6 = 4): OutboundDnsLookup =>
  async () => [{ address, family }];

describe('assertSafeModelBaseUrl', () => {
  it('rejects a literal private or metadata base URL on an enforced deployment', async () => {
    await expect(
      assertSafeModelBaseUrl('https://169.254.169.254', 'ANTHROPIC_BASE_URL', enforced)
    ).rejects.toBeInstanceOf(BadRequest);
    await expect(
      assertSafeModelBaseUrl('https://10.0.0.5:8443/v1', 'OPENAI_BASE_URL', enforced)
    ).rejects.toBeInstanceOf(BadRequest);
  });

  it('rejects a non-HTTPS base URL on an enforced deployment', async () => {
    await expect(
      assertSafeModelBaseUrl('http://api.anthropic.com', 'ANTHROPIC_BASE_URL', enforced)
    ).rejects.toBeInstanceOf(BadRequest);
  });

  it('rejects a hostname that resolves to a private address (rebinding)', async () => {
    await expect(
      assertSafeModelBaseUrl('https://models.example.com', 'ANTHROPIC_BASE_URL', enforced, {
        resolveDns: resolvesTo('10.1.2.3'),
      })
    ).rejects.toBeInstanceOf(BadRequest);
  });

  it('accepts a public IP or hostname on an enforced deployment', async () => {
    await expect(
      assertSafeModelBaseUrl('https://93.184.216.34/v1', 'ANTHROPIC_BASE_URL', enforced)
    ).resolves.toBeUndefined();
    await expect(
      assertSafeModelBaseUrl('https://models.example.com', 'ANTHROPIC_BASE_URL', enforced, {
        resolveDns: resolvesTo('93.184.216.34'),
      })
    ).resolves.toBeUndefined();
  });

  it('enforces public-only under ha + simple and under sandbox, independent of tenancy', async () => {
    await expect(
      assertSafeModelBaseUrl('https://10.0.0.5', 'ANTHROPIC_BASE_URL', haSimple)
    ).rejects.toBeInstanceOf(BadRequest);
    await expect(
      assertSafeModelBaseUrl('https://10.0.0.5', 'ANTHROPIC_BASE_URL', sandbox)
    ).rejects.toBeInstanceOf(BadRequest);
  });

  it('allows a local or LAN endpoint on a trusted-local install, but not a non-http(s) scheme', async () => {
    await expect(
      assertSafeModelBaseUrl('http://localhost:1234', 'ANTHROPIC_BASE_URL', trustedLocal)
    ).resolves.toBeUndefined();
    await expect(
      assertSafeModelBaseUrl('http://192.168.1.50:8080/v1', 'OPENAI_BASE_URL', trustedLocal)
    ).resolves.toBeUndefined();
    await expect(
      assertSafeModelBaseUrl('file:///etc/passwd', 'ANTHROPIC_BASE_URL', trustedLocal)
    ).rejects.toBeInstanceOf(BadRequest);
  });
});

describe('assertSafeConnectionBaseUrls', () => {
  it('rejects a private base-URL field and ignores non-URL connections', async () => {
    await expect(
      assertSafeConnectionBaseUrls({ OPENAI_BASE_URL: 'https://10.0.0.5' }, enforced)
    ).rejects.toBeInstanceOf(BadRequest);
    await expect(
      assertSafeConnectionBaseUrls({ OPENAI_API_KEY: 'sk-test' }, enforced)
    ).resolves.toBeUndefined();
    await expect(assertSafeConnectionBaseUrls(undefined, enforced)).resolves.toBeUndefined();
  });
});

describe('createPinnedModelFetch', () => {
  it('returns undefined on a trusted-local install so the SDK keeps its default fetch', () => {
    expect(createPinnedModelFetch(trustedLocal)).toBeUndefined();
  });

  it('refuses a private SDK base URL on an enforced deployment', async () => {
    const pinned = createPinnedModelFetch(enforced);
    expect(pinned).toBeDefined();
    await expect(pinned?.('https://10.0.0.5/v1/models')).rejects.toBeInstanceOf(
      UnsafeOutboundUrlError
    );
  });

  it('refuses a base-URL hostname that resolves to a private address (rebinding)', async () => {
    const pinned = createPinnedModelFetch(enforced, { resolveDns: resolvesTo('169.254.169.254') });
    await expect(pinned?.('https://models.example.com/v1/models')).rejects.toBeInstanceOf(
      UnsafeOutboundUrlError
    );
  });
});

describe('pinned model egress does not follow redirects', () => {
  let server: http.Server;
  let origin: string;

  afterEach(() => {
    server?.close();
  });

  it('refuses a 302 to an internal target (the redirect mode the pinned fetch uses)', async () => {
    server = http.createServer((_req, res) => {
      res.writeHead(302, { location: 'http://169.254.169.254/latest/meta-data' });
      res.end();
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    // allowLocalhostHttp only lets the test reach the loopback server; the
    // assertion is that `redirect: 'error'` — the mode createPinnedModelFetch and
    // check-auth use — refuses the hop rather than chasing it to the metadata IP.
    await expect(
      safeOutboundFetch(`${origin}/v1/models`, { redirect: 'error', allowLocalhostHttp: true })
    ).rejects.toThrow(/redirect is not allowed/);
  });
});
