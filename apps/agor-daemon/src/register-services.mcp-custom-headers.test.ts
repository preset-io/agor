import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('register-services /mcp-servers/discover custom headers wiring', () => {
  const source = readFileSync(new URL('./register-services.ts', import.meta.url), 'utf8');
  const discoverStart = source.indexOf("app.use('/mcp-servers/discover'");
  const afterDiscover = source.slice(discoverStart + 1);
  const discoverBlock =
    discoverStart === -1
      ? ''
      : source.slice(
          discoverStart,
          discoverStart + 1 + afterDiscover.indexOf("app.service('mcp-servers/discover')")
        );

  it('accepts custom headers and resolves templates before probing', () => {
    expect(discoverBlock).toContain('headers?: Record<string, string>');
    expect(discoverBlock).toContain('headers: serverConfig.headers');
    expect(discoverBlock).toContain('serverConfig.headers = resolution.resolved.headers');
  });

  it('restores redacted edit-form auth/header values from the saved server before probing', () => {
    expect(discoverBlock).toContain('restoreRedactedMCPAuthSecrets');
    expect(discoverBlock).toContain('current: server.auth');
    expect(discoverBlock).toContain('next: data.auth');
    expect(discoverBlock).toContain('restoreRedactedMCPCustomHeaders');
    expect(discoverBlock).toContain('current: server.headers');
    expect(discoverBlock).toContain('next: data.headers');
  });

  it('passes merged custom/auth headers to Streamable HTTP transport', () => {
    expect(discoverBlock).toContain('mergeMCPRemoteHeaders');
    expect(discoverBlock).toContain('requestInit: { headers: connHeaders }');
    expect(discoverBlock).toContain('custom: serverConfig.headers');
    expect(discoverBlock).toContain('auth: authHeaders');
  });
});

describe('register-services /mcp-servers/oauth-auth-headers authorization', () => {
  const source = readFileSync(new URL('./register-services.ts', import.meta.url), 'utf8');
  const authHeadersStart = source.indexOf("app.use('/mcp-servers/oauth-auth-headers'");
  const afterAuthHeaders = source.slice(authHeadersStart + 1);
  const authHeadersBlock =
    authHeadersStart === -1
      ? ''
      : source.slice(
          authHeadersStart,
          authHeadersStart +
            1 +
            afterAuthHeaders.indexOf("app.service('mcp-servers/oauth-auth-headers')")
        );

  it('rejects normal provider users and checks session-token requests against attached servers', () => {
    expect(authHeadersBlock).toContain('trusted executor paths');
    expect(authHeadersBlock).toContain('shouldExposeMCPServerSecretsForSessionToken');
    expect(authHeadersBlock).toContain('SessionMCPServerRepository');
    expect(authHeadersBlock).toContain("scope: 'global'");
    expect(authHeadersBlock).toContain('allowedServerIds');
    expect(authHeadersBlock).toContain('server_not_in_session_scope');
  });
});
