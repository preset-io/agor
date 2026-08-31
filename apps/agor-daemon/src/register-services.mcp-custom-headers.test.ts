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

  it('uses saved auth/header values rather than a transient edit-form snapshot', () => {
    expect(discoverBlock).toContain('auth: server.auth');
    expect(discoverBlock).toContain('headers: server.headers');
    expect(discoverBlock).not.toContain('restoreRedactedMCPAuthSecrets');
    expect(discoverBlock).not.toContain('restoreRedactedMCPCustomHeaders');
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
    expect(authHeadersBlock).toContain('usableByUserId: userId');
    expect(authHeadersBlock).toContain('allowedServerIds');
    expect(authHeadersBlock).toContain('server_not_in_session_scope');
  });

  it('scopes the global set to what the session may use', () => {
    expect(authHeadersBlock).toContain('usableByUserId: userId');
  });
});

/**
 * Every endpoint that takes an `mcp_server_id` straight from the request and
 * then reads that server's OAuth configuration, or writes a token or token
 * endpoint onto it, has to ask whether the caller may touch that row — a
 * private server belongs to one user. The helper is unit-tested elsewhere;
 * what is easy to lose in a refactor is the call itself, at one of four sites.
 */
describe('register-services OAuth endpoints authorize the server they are given', () => {
  const source = readFileSync(new URL('./register-services.ts', import.meta.url), 'utf8');

  const blockFor = (mountPath: string): string => {
    const start = source.indexOf(`app.use('${mountPath}'`);
    expect(start, `${mountPath} is not mounted`).toBeGreaterThan(-1);
    const next = source.indexOf('app.use(', start + 1);
    return source.slice(start, next === -1 ? undefined : next);
  };

  it.each([
    '/mcp-servers/test-oauth',
    '/mcp-servers/oauth-start',
    '/mcp-servers/oauth-disconnect',
    '/mcp-servers/oauth-refresh',
  ])('%s resolves its server through loadMcpServerForCaller', (mountPath) => {
    expect(blockFor(mountPath)).toContain('loadMcpServerForCaller');
  });

  it('discovery decides on ownership rather than on scope', () => {
    const block = blockFor('/mcp-servers/discover');
    expect(block).toContain('denyDiscoverOfAnotherUsersServer');
    expect(block).not.toContain("server.scope === 'global'");
    expect(block).not.toContain("server.scope === 'session'");
  });
});

describe('register-services /session-mcp-servers visibility', () => {
  const source = readFileSync(new URL('./register-services.ts', import.meta.url), 'utf8');
  const attachmentStart = source.indexOf("app.use('/session-mcp-servers'");
  const attachmentEnd = source.indexOf('// Users service', attachmentStart);
  const attachmentBlock =
    attachmentStart === -1
      ? ''
      : source.slice(attachmentStart, attachmentEnd === -1 ? undefined : attachmentEnd);

  it('joins saved ownership before returning attachment IDs', () => {
    expect(attachmentBlock).toContain('let query = select(db, {');
    expect(attachmentBlock).toContain('.innerJoin(mcpServers');
    expect(attachmentBlock).toContain('.innerJoin(sessions');
    expect(attachmentBlock).toContain('isSessionMcpServerLinkVisibleToCaller');
  });
});
