import { scanForSecrets } from '@agor/core/agor-pack';
import { describe, expect, it } from 'vitest';
import { sanitizeMcpArgs, sanitizeMcpAuth, sanitizeMcpUrl } from './agor-pack-export';

describe('MCP credential sanitizing for .agor', () => {
  it('drops userinfo and credential-named query values, keeping env references', () => {
    expect(
      sanitizeMcpUrl('https://user:pw@example.test/mcp?api_key=plain&region=eu&design=x')
    ).toEqual({
      url: 'https://example.test/mcp?api_key=[redacted]&region=eu&design=x',
      changed: true,
    });
    expect(sanitizeMcpUrl('https://example.test/mcp?token={{ user.env.TOKEN }}')).toEqual({
      url: 'https://example.test/mcp?token={{ user.env.TOKEN }}',
      changed: false,
    });
    expect(sanitizeMcpUrl('https://example.test/mcp?author=me').changed).toBe(false);
  });

  it('drops credential flag values in both argument forms', () => {
    expect(
      sanitizeMcpArgs(['--api-key', 'plain', '--token=abc', '--port', '8080', '-y', 'pkg'])
    ).toEqual({
      args: ['--api-key', '[redacted]', '--token=[redacted]', '--port', '8080', '-y', 'pkg'],
      changed: true,
    });
    expect(sanitizeMcpArgs(['--api-key', '{{ user.env.KEY }}']).changed).toBe(false);
  });
});

describe('MCP auth in a pack', () => {
  it('keeps the auth shape and variable references, drops literal secrets and OAuth state', () => {
    expect(
      sanitizeMcpAuth({
        type: 'bearer',
        token: '{{ user.env.ACME_TRACKER_TOKEN }}',
        token_header: 'X-Api-Key',
        token_prefix: '',
      })
    ).toEqual({
      auth: {
        type: 'bearer',
        token: '{{ user.env.ACME_TRACKER_TOKEN }}',
        token_header: 'X-Api-Key',
        token_prefix: '',
      },
      removed: [],
    });
    expect(
      sanitizeMcpAuth({
        type: 'oauth',
        oauth_client_id: 'client-1',
        oauth_client_secret: 'shh-literal',
        oauth_access_token: 'live-token',
        oauth_refresh_token: 'refresh',
        oauth_token_expires_at: 123,
      })
    ).toEqual({
      auth: { type: 'oauth', oauth_client_id: 'client-1' },
      removed: ['oauth_client_secret'],
    });
    expect(
      sanitizeMcpAuth({ type: 'bearer', token: 'Bearer {{ user.env.X }} and literal' }).removed
    ).toEqual(['token']);
  });
});

describe('MCP auth URL fields in a pack', () => {
  it.each(['api_url', 'oauth_token_url', 'oauth_authorization_url'])(
    'strips credentials embedded in %s and keeps env references',
    (field) => {
      const leaky = sanitizeMcpAuth({
        type: 'jwt',
        [field]: 'https://user:hunter22@auth.example.test/token?api_key=plainsecret123&region=eu',
      });
      expect(leaky.auth?.[field]).toBe(
        'https://auth.example.test/token?api_key=[redacted]&region=eu'
      );
      expect(leaky.removed).toEqual([`${field} credentials`]);
      expect(scanForSecrets(JSON.stringify(leaky.auth))).toEqual([]);

      const templated = sanitizeMcpAuth({
        type: 'jwt',
        [field]: 'https://auth.example.test/token?api_key={{ user.env.ACME_KEY }}',
      });
      expect(templated.auth?.[field]).toBe(
        'https://auth.example.test/token?api_key={{ user.env.ACME_KEY }}'
      );
      expect(templated.removed).toEqual([]);
    }
  );
});

describe('mixed literal and reference credentials', () => {
  it.each([
    [
      'https://{{ user.env.USER }}:literal-password@example.test/auth',
      'https://{{ user.env.USER }}@example.test/auth',
    ],
    ['https://alice:{{ user.env.PASS }}@example.test/auth', 'https://example.test/auth'],
    [
      'https://{{ user.env.USER }}:{{ user.env.PASS }}@example.test/auth',
      'https://{{ user.env.USER }}:{{ user.env.PASS }}@example.test/auth',
    ],
    [
      'https://example.test/mcp?api_key={{ user.env.KEY }}plainsecret&region=eu',
      'https://example.test/mcp?api_key=[redacted]&region=eu',
    ],
    [
      'https://example.test/mcp?token=Bearer%20{{ user.env.TOKEN }}',
      'https://example.test/mcp?token=[redacted]',
    ],
    // Names are classified decoded and case-insensitively.
    [
      'https://example.test/mcp?%74oken=literal-secret',
      'https://example.test/mcp?%74oken=[redacted]',
    ],
    [
      'https://example.test/mcp?API%5FKey=plainsecret123&region=eu',
      'https://example.test/mcp?API%5FKey=[redacted]&region=eu',
    ],
    ['https://example.test/mcp?ToKeN=literal-secret', 'https://example.test/mcp?ToKeN=[redacted]'],
  ])('%s → %s', (input, expected) => {
    const { url } = sanitizeMcpUrl(input);
    expect(url).toBe(expected);
    expect(scanForSecrets(url)).toEqual([]);
  });

  it('applies the same rule to arguments and auth secrets', () => {
    expect(sanitizeMcpArgs(['--api-key={{ user.env.KEY }}x']).args).toEqual([
      '--api-key=[redacted]',
    ]);
    expect(sanitizeMcpArgs(['--token', '{{ user.env.TOKEN }}']).args).toEqual([
      '--token',
      '{{ user.env.TOKEN }}',
    ]);
    expect(
      sanitizeMcpAuth({ type: 'bearer', token: '{{ user.env.A }}{{ user.env.B }}' }).removed
    ).toEqual(['token']);
  });
});
