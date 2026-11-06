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
