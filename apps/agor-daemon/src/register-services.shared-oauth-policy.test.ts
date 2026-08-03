import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('shared OAuth lifecycle registration', () => {
  const source = readFileSync(new URL('./register-services.ts', import.meta.url), 'utf8');
  const flowStart = source.slice(
    source.indexOf('async function startTwoPhaseMCPOAuthFlowInternal'),
    source.indexOf('const tenantIdFromParams')
  );
  const completeStart = source.indexOf("app.use('/mcp-servers/oauth-complete'");
  const completeBlock = source.slice(
    completeStart,
    source.indexOf("app.service('mcp-servers/oauth-complete')", completeStart)
  );

  it('admin-gates every shared pending flow at the central start boundary', () => {
    expect(flowStart).toContain("if (opts.oauthMode === 'shared')");
    expect(flowStart).toContain("requireSharedOAuthAdministrator(opts.actorParams, 'start')");
    expect(flowStart.indexOf('requireSharedOAuthAdministrator')).toBeLessThan(
      flowStart.indexOf('startMCPOAuthFlow(')
    );
    expect(source.match(/actorParams: params/g)).toHaveLength(3);
  });

  it('rejects cross-tenant manual completion before token exchange or state consumption', () => {
    const tenantCheck = completeBlock.indexOf('isPostgresDatabase(db)');
    expect(tenantCheck).toBeGreaterThan(0);
    expect(tenantCheck).toBeLessThan(completeBlock.indexOf('completeMCPOAuthFlow('));
    expect(tenantCheck).toBeLessThan(completeBlock.indexOf('pendingOAuthFlows.delete(state)'));
  });
});
