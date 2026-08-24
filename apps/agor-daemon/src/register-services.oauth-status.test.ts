import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('register-services durable OAuth status authority', () => {
  const source = readFileSync(join(__dirname, 'register-services.ts'), 'utf8');
  const start = source.indexOf("app.use('/mcp-servers/oauth-status'");
  const end = source.indexOf("app.use('/mcp-servers/oauth-attempt-status'", start);
  const statusBlock = start < 0 || end < 0 ? '' : source.slice(start, end);
  const refreshStart = source.indexOf("app.use('/mcp-servers/oauth-refresh'");
  const refreshEnd = source.indexOf('// Discover endpoint', refreshStart);
  const refreshBlock =
    refreshStart < 0 || refreshEnd < 0 ? '' : source.slice(refreshStart, refreshEnd);

  // What the endpoint may advertise — expiry, refresh-ambiguity, grant
  // binding, and which servers it will name to which caller — is decided by
  // `resolveAuthenticatedServerIds` and tested against its behaviour in
  // `services/mcp-oauth-status.test.ts`. All this file still owes is that the
  // route asks it rather than deciding for itself.
  it('resolves durable status through the one place that decides it', () => {
    expect(statusBlock).toContain('resolveAuthenticatedServerIds');
    expect(statusBlock).toContain('requireGrantBinding: true');
    expect(statusBlock).toContain('isMCPOAuthGrantAuthorizedForServer(');
  });

  it('gives the refresh owner and observer the same retryable known-failure response', () => {
    expect(refreshBlock).toMatch(
      /err instanceof FailedRefreshError[\s\S]{0,160}error: 'token_refresh_failed'/
    );
  });
});
