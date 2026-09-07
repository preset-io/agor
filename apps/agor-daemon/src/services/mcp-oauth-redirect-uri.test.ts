import { describe, expect, it, vi } from 'vitest';
import { resolveMCPOAuthRedirectUri } from './mcp-oauth-redirect-uri.js';

describe('resolveMCPOAuthRedirectUri', () => {
  it('uses loopback for standalone flows without consulting public configuration or DNS', async () => {
    const resolvePublicBaseUrl = vi.fn(async () => 'https://unused.example.test');

    await expect(
      resolveMCPOAuthRedirectUri({
        daemonPort: 3030,
        usePublicHttps: false,
        resolvePublicBaseUrl,
      })
    ).resolves.toBe('http://127.0.0.1:3030/mcp-servers/oauth-callback');
    expect(resolvePublicBaseUrl).not.toHaveBeenCalled();
  });

  it('uses the configured public HTTPS origin when remote callback mode is explicit', async () => {
    await expect(
      resolveMCPOAuthRedirectUri({
        daemonPort: 3030,
        usePublicHttps: true,
        resolvePublicBaseUrl: async () => 'https://agor.example.test',
      })
    ).resolves.toBe('https://agor.example.test/mcp-servers/oauth-callback');
  });

  it('rejects a public HTTP callback in public mode', async () => {
    await expect(
      resolveMCPOAuthRedirectUri({
        daemonPort: 3030,
        usePublicHttps: true,
        resolvePublicBaseUrl: async () => 'http://agor.example.test',
      })
    ).rejects.toThrow('OAuth endpoints require HTTPS');
  });
});
