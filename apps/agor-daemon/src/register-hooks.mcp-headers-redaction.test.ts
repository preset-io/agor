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
    expect(source).toMatch(
      /find:\s*\[presentMcpOAuthPolicies,\s*redactMCPServerSecretFieldsForGatewayMode\]/
    );
    // Ownership hooks may run ahead of these; redaction must still be last.
    expect(source).toMatch(/get:\s*\[[\s\S]*?redactMCPServerSecretFieldsForGatewayMode[\s\S]*?\]/);
  });

  it('keeps ordinary MCP server reads free of OAuth grant lookups', () => {
    const block = source.slice(source.indexOf("safeService('mcp-servers')?.hooks({"));
    const readHooks = block.slice(0, block.indexOf("safeService('mcp-catalog')"));
    expect(readHooks).not.toContain('UserMCPOAuthTokenRepository');
    expect(readHooks).not.toContain('injectPerUserOAuthTokens');
  });

  it('redacts every mcp-servers method that returns a row, remove included', () => {
    // `remove` is the easy one to forget: it is a write, but the adapter
    // returns the deleted row and that object is also the `removed`
    // broadcast. Behaviour is covered in
    // `services/mcp-servers.env-redaction.test.ts`; this pins the wiring.
    const block = source.slice(source.indexOf("safeService('mcp-servers')?.hooks({"));
    const afterBlock = block.slice(block.indexOf('after:'), block.indexOf('safeService', 1));
    for (const method of ['find', 'get', 'create', 'patch', 'update', 'remove']) {
      expect(afterBlock, `${method} is missing redaction`).toMatch(
        new RegExp(`${method}:\\s*\\[[^\\]]*redactMCPServerSecretFields`)
      );
    }
  });

  it('keeps full MCP server replacements behind the write gate', () => {
    // PUT replaces the whole row, so it must clear the same gate as the other
    // writes rather than the `all` chain alone. That gate is no longer a role
    // check: `authorizeMcpServerWriteHook` decides on `mcp_member_policy` plus
    // ownership, which is what lets a member hold a server of their own at all.
    expect(source).toMatch(
      /update:\s*\[\s*authorizeMcpServerWriteHook,[\s\S]*?validateMcpServerOAuthCompatibility,?\s*\]/
    );
  });

  it('redacts session MCP server route responses that bypass service hooks', () => {
    expect(routesSource).toContain("'/sessions/:id/mcp-servers'");
    expect(routesSource).toContain('redactMCPServerSecrets');
    expect(routesSource).toContain('servers.map(redactMCPServerSecrets)');
    expect(routesSource).toContain('authorizeAndLoadSessionForMcpConfig(id, params)');
    expect(routesSource).toContain('isMCPServerUsableBy');
    expect(routesSource).toContain('const credentialUserId = userId ?? session.created_by');
    expect(routesSource).toContain('usableByUserId: credentialUserId');
    expect(routesSource).toContain('includeGlobal');
    expect(routesSource).toContain("scope: 'global'");
    expect(routesSource).toContain('forUserId');
    expect(routesSource).toContain('sessionMCPServersService.setServers');
    expect(routesSource).toContain('update: { role: ROLES.MEMBER');
  });

  it('publishes marketplace connect results to nobody', () => {
    // The daemon's global publisher has no path allowlist: any service that
    // emits `created` fans out to the whole tenant's authenticated channel
    // unless it says otherwise. A connect result carries the installed
    // `mcp_server`, which for an API-key entry holds the caller's credential in
    // `auth.token` — and the `mcp-servers` redaction hook does not cover it,
    // because this is a different service forwarding the object.
    //
    // It is redacted today only because connect obtained that object from
    // `mcp-servers` with the caller's own params. That is a fact about where
    // the object came from, not about where it is going, so the broadcast is
    // suppressed outright rather than left depending on it. Nothing is lost:
    // `mcp-servers` and `sessions` announce the rows through their own hooks.
    expect(routesSource).toContain("app.service('mcp-catalog/connect').publish(() => []);");
  });

  it('does not expose raw secrets to global session-token service reads', () => {
    expect(source).toContain('shouldExposeMCPServerSecrets(context.params)');
    expect(routesSource).toContain('shouldExposeMCPServerSecrets(params, {');
    expect(routesSource).toContain('allowSessionToken: true');
    expect(routesSource).toContain('sessionId: id');
    expect(utilSource).toContain('options.allowSessionToken === true');
  });
});
