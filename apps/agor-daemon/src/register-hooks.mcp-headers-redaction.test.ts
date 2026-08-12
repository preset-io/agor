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
    // Ownership hooks may run ahead of these; redaction must still be last.
    expect(source).toMatch(
      /get:\s*\[[\s\S]*?injectPerUserOAuthTokens,\s*redactMCPServerSecretFields[\s\S]*?\]/
    );
  });

  it('keeps full MCP server replacements behind the write gate', () => {
    // PUT replaces the whole row, so it must clear the same gate as the other
    // writes rather than the `all` chain alone. That gate is no longer a role
    // check: `authorizeMcpServerWriteHook` decides on `mcp_member_policy` plus
    // ownership, which is what lets a member hold a server of their own at all.
    expect(source).toMatch(/update:\s*\[authorizeMcpServerWriteHook\]/);
  });

  it('redacts session MCP server route responses that bypass service hooks', () => {
    expect(routesSource).toContain("'/sessions/:id/mcp-servers'");
    expect(routesSource).toContain('redactMCPServerSecrets');
    expect(routesSource).toContain('servers.map(redactMCPServerSecrets)');
    expect(routesSource).toContain('authorizeAndLoadSessionForMcpConfig(id, params)');
    expect(routesSource).toContain('isMCPServerUsableInSession');
    expect(routesSource).toContain('includeGlobal');
    expect(routesSource).toContain("scope: 'global'");
    expect(routesSource).toContain('forUserId');
    expect(routesSource).toContain('sessionMCPServersService.setServers');
    expect(routesSource).toContain('update: { role: ROLES.MEMBER');
  });

  it('does not expose raw secrets to global session-token service reads', () => {
    expect(source).toContain('shouldExposeMCPServerSecrets(context.params)');
    expect(routesSource).toContain('shouldExposeMCPServerSecrets(params, {');
    expect(routesSource).toContain('allowSessionToken: true');
    expect(routesSource).toContain('sessionId: id');
    expect(utilSource).toContain('options.allowSessionToken === true');
  });
});
