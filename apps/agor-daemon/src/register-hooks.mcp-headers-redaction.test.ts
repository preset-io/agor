import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('register-hooks MCP server secret redaction', () => {
  const source = readFileSync(new URL('./register-hooks.ts', import.meta.url), 'utf8');
  const routesSource = readFileSync(new URL('./register-routes.ts', import.meta.url), 'utf8');
  const utilSource = readFileSync(
    new URL('./utils/mcp-header-secrets.ts', import.meta.url),
    'utf8'
  );

  it('redacts MCP custom header values in mcp-servers responses', () => {
    expect(source).toContain('redactMCPServerSecretFields');
    expect(source).toContain('redactMCPServerSecrets');
    expect(utilSource).toContain('redactMCPAuthSecrets(server.auth)');
    expect(source).toMatch(/find:\s*\[injectPerUserOAuthTokens,\s*redactMCPServerSecretFields\]/);
    expect(source).toMatch(/get:\s*\[injectPerUserOAuthTokens,\s*redactMCPServerSecretFields\]/);
  });

  it('redacts session MCP server route responses that bypass service hooks', () => {
    expect(routesSource).toContain("'/sessions/:id/mcp-servers'");
    expect(routesSource).toContain('redactMCPServerSecrets');
    expect(routesSource).toContain('servers.map(redactMCPServerSecrets)');
    expect(routesSource).toContain('await requireSessionScopedConfigOwnerOrAdmin(id, params)');
    expect(routesSource).toContain('includeGlobal');
    expect(routesSource).toContain("scope: 'global'");
    expect(routesSource).toContain('forUserId');
  });

  it('does not expose raw secrets to global session-token service reads', () => {
    expect(source).toContain('shouldExposeMCPServerSecrets(context.params)');
    expect(routesSource).toContain('shouldExposeMCPServerSecrets(params, {');
    expect(routesSource).toContain('allowSessionToken: true');
    expect(routesSource).toContain('sessionId: id');
    expect(utilSource).toContain('options.allowSessionToken === true');
  });
});
