import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('register-hooks MCP custom header redaction', () => {
  const source = readFileSync(new URL('./register-hooks.ts', import.meta.url), 'utf8');
  const routesSource = readFileSync(new URL('./register-routes.ts', import.meta.url), 'utf8');
  const utilSource = readFileSync(
    new URL('./utils/mcp-header-secrets.ts', import.meta.url),
    'utf8'
  );

  it('redacts MCP custom header values in mcp-servers responses', () => {
    expect(source).toContain('redactMCPHeaderSecrets');
    expect(source).toContain('redactMCPServerHeaderSecrets');
    expect(utilSource).toContain('redactMCPCustomHeaders(server.headers)');
    expect(source).toMatch(/find:\s*\[injectPerUserOAuthTokens,\s*redactMCPHeaderSecrets\]/);
    expect(source).toMatch(/get:\s*\[injectPerUserOAuthTokens,\s*redactMCPHeaderSecrets\]/);
  });

  it('redacts session MCP server route responses that bypass service hooks', () => {
    expect(routesSource).toContain("'/sessions/:id/mcp-servers'");
    expect(routesSource).toContain('redactMCPServerHeaderSecrets');
    expect(routesSource).toContain('servers.map(redactMCPServerHeaderSecrets)');
  });

  it('keeps raw headers available to executor session-token calls', () => {
    expect(source).toContain('shouldExposeMCPHeaderSecrets(context.params)');
    expect(routesSource).toContain('shouldExposeMCPHeaderSecrets(params)');
    expect(utilSource).toContain("params.authentication?.strategy === 'session-token'");
  });
});
